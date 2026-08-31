// stt.js — pluggable STT providers for the VoiceAgent. One small contract, many backends.
//
// A provider is a factory `(opts) => STT` where STT is:
//   open()      [optional] pre-open the socket (token fetch + WS handshake) before any audio, so the
//               first utterance isn't stalled by a cold connect; idempotent, and feed() still opens lazily
//   feed(i16)   push a 16kHz mono Int16Array chunk (provider opens its socket lazily on first feed)
//   commit()    VAD speech-end → finalize the current utterance (no-op if nothing was fed since)
//   close()     teardown the socket and drop buffered audio
// It reports back through callbacks passed in `opts`:
//   onPartial(text, ms, committed='')  live interim TAIL (called many times/utterance); `committed`
//                                       is the word-level locked prefix to render solid (Speechmatics)
//   onFinal(text)          one finalized utterance → becomes a user turn
//   onError(msg)           recoverable error, surfaced to the host (session stays alive)
//   onFatal(msg)           unrecoverable (auth/config) — host should stop() the agent
//   onClose()              socket closed (used for usage flushing)
//   isClosed()             agent stopped — don't reopen / don't emit
// A provider may also expose capability flags the agent adapts to:
//   continuous: true   feed the FULL mic stream (no VAD gating/preroll) — the provider's own model
//                      needs to hear the silences (e.g. Deepgram Flux end-of-turn detection)
//   nativeEOT:  true   the provider closes turns itself (unsolicited onFinal) — the agent skips its
//                      VAD-driven commit() and just handles onFinal when it arrives
//   selfCapture: true  the provider OWNS the whole audio path: its own mic + its own end-of-turn
//                      (e.g. the browser Web Speech API). The agent builds NO mic/AudioWorklet/VAD
//                      pipeline for it — start() just opens the provider. Implies nativeEOT (the
//                      provider closes its own turns via unsolicited onFinal). It exposes open()/
//                      close() + setEnabled() (mute), and drives barge-in the normal way via onPartial.
//
// Adding a provider = write a factory + register it in STT_PROVIDERS below. The VoiceAgent owns
// the mic + VAD and just forwards feed/commit/close, so providers never touch audio capture.

import { TUNING } from './tuning.js';

const USAGE_FLUSH_SECONDS = 30;   // report streamed seconds to the backend at least this often

// Cloud STT is a browser WebSocket. Resolved through globalThis at call time, not as a bare
// identifier: this module is imported under SSR and under node (tests, node <22), where bare
// `WebSocket` is a ReferenceError instead of undefined. A missing WS is a clear provider error —
// not a stack trace from inside open().
const newSocket = (url, protocols) => {
  const WS = globalThis.WebSocket;
  if (!WS) throw new Error('cloud STT needs WebSocket (unavailable here — browser or node >=22)');
  return protocols ? new WS(url, protocols) : new WS(url);
};

// Common opts shape (provided by the VoiceAgent):
//   { apiKey, sttUrl, sttModel, sttLang, keyterms, sttTokenUrl, getToken, sttUsageUrl,
//     onPartial, onFinal, onError, onClose, isClosed }
//
// AUTH (cloud providers): the raw provider key must stay server-side. Either
//   • `sttTokenUrl` — your backend route that mints a short-TTL token: POST, optional X-API-Key
//     (`apiKey`), responds { token, expires_in? }; or
//   • `getToken` — an async (provider) => ({ token, expires_in? }) callback, when your auth doesn't
//     fit that one route shape. Takes precedence over sttTokenUrl. VoiceAgent calls it with the
//     provider actually RUNNING (post-downgrade), so a host whose credential differs per provider
//     writes one function instead of mirroring the downgrade rule.

// ── Shared socket-lifecycle helpers ─────────────────────────────────────────
// The three providers below have genuinely different turn machines (Speechmatics' straggler cursor,
// Deepgram's cumulative-turn + token cache, ElevenLabs' simple commit) — those stay separate on
// purpose. But token-fetch-with-timeout and usage-reporting are byte-for-byte the same shape in all
// three; duplicating THOSE is a pure bug magnet (a timeout fix would need applying 3x), so they're
// factored out here.

// Mint a short-TTL token — via the host's `getToken` callback when given, else a POST to
// `sttTokenUrl`. Bounded by tokenFetchTimeoutMs so a hung/unreachable backend can't stall
// voice-mode startup forever. Calls onFatal itself on any failure (network, timeout, non-2xx,
// missing token) and returns null — the caller just checks for null and bails (what buffered
// state to clear on failure differs per provider, so that stays with the caller).
async function mintSttToken(url, apiKey, onFatal, getToken) {
  if (getToken) {
    // HOST code on the critical path: bound it exactly like the built-in fetch below, or a minter
    // that never settles stalls voice start forever with no error. We can't cancel the host's
    // promise — we just stop waiting on it (it may still resolve into the void, which is fine:
    // a token is idempotent to mint).
    let timer;
    try {
      const body = await Promise.race([
        getToken(),
        new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timed out')), TUNING.STT.tokenFetchTimeoutMs); }),
      ]);
      if (!body?.token) throw new Error('getToken returned no token');
      return body;
    } catch (e) { onFatal(`STT token: ${e.message}`); return null; }
    finally { clearTimeout(timer); }   // a fast mint must not hold the timer (and Node's loop) open
  }
  if (!url) { onFatal('STT token: no sttTokenUrl/getToken configured — cloud STT needs a token route (see README)'); return null; }
  let res;
  try {
    res = await fetch(url, { method: 'POST', headers: apiKey ? { 'X-API-Key': apiKey } : {}, signal: AbortSignal.timeout(TUNING.STT.tokenFetchTimeoutMs) });
  } catch (e) {
    onFatal(`STT token: ${e.name === 'TimeoutError' ? 'timed out' : e.message}`);
    return null;
  }
  const body = await res.json().catch(() => ({}));
  // `message` first: a token route's error body usually puts the reason there and the bare status
  // name in `error` ({ error: 'Unauthorized', message: 'API key not found' }) — the reason is what
  // tells the developer their key is wrong rather than their URL.
  if (!res.ok || !body.token) { onFatal(`STT token: ${body.message || body.error || res.statusText}`); return null; }
  return body;
}

// Accumulate streamed samples and flush them to /stt/usage — inline once USAGE_FLUSH_SECONDS is
// crossed, and again whenever the caller flushes on close (billing is trust-but-verify: the client
// reports what it streamed since the backend can't meter a direct browser↔provider socket).
function makeUsageReporter(sttUsageUrl, apiKey, provider, extra = {}) {
  let samples = 0;
  const flush = () => {
    const seconds = samples / 16000; samples = 0;
    if (seconds <= 0 || !sttUsageUrl) return;
    fetch(sttUsageUrl, {
      method: 'POST', keepalive: true,
      headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
      body: JSON.stringify({ seconds, provider, ...extra }),
    }).catch(() => {});
  };
  return { add: (n) => { samples += n; if (samples >= 16000 * USAGE_FLUSH_SECONDS) flush(); }, flush };
}

// ── ElevenLabs Scribe realtime ──────────────────────────────────────────────
// Browser↔ElevenLabs direct WS. Auth via a single-use token minted by the backend (/stt/token);
// the key stays server-side. Billing is trust-but-verify: the client reports streamed seconds to
// /stt/usage (the backend can't meter a direct browser↔ElevenLabs socket).
export function makeElevenLabsSTT(opts) {
  // `||` fallbacks, not destructuring defaults: VoiceAgent passes '' for unset knobs, which a
  // `= default` would NOT replace — an empty model_id makes ElevenLabs hard-close the socket (1006).
  const { apiKey, sttLang, keyterms = [], sttTokenUrl, getToken, sttUsageUrl,
          onPartial, onFinal, onError, onFatal, onClose, isClosed } = opts;
  const sttUrl = opts.sttUrl || 'wss://api.elevenlabs.io/v1/speech-to-text/realtime';
  const sttModel = opts.sttModel || 'scribe_v2_realtime';
  let ws = null, opening = false, outbox = [], sentSinceCommit = false, sttStart = 0;
  const usage = makeUsageReporter(sttUsageUrl, apiKey, 'elevenlabs');

  const sendAudio = (i16) => {
    if (!ws || ws.readyState !== 1) { outbox.push(i16); return; }
    let bin = ''; const b = new Uint8Array(i16.buffer); for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]);
    ws.send(JSON.stringify({ message_type: 'input_audio_chunk', audio_base_64: btoa(bin) }));
    usage.add(i16.length);
  };
  const sendCommit = () => ws.send(JSON.stringify({ message_type: 'input_audio_chunk', audio_base_64: '', commit: true }));

  const open = async () => {
    if (opening) return;          // re-entry guard: the async token fetch could otherwise open two sockets
    opening = true;
    try {
      const body = await mintSttToken(sttTokenUrl, apiKey, onFatal, getToken);
      if (!body) {
        // Auth/config failure won't fix itself — drop buffered audio (don't replay stale speech on
        // a later recovery); mintSttToken already called onFatal so the host stops instead of
        // re-firing on every utterance.
        outbox = []; sentSinceCommit = false;
        return;
      }
      if (isClosed()) return;
      const p = new URLSearchParams({ model_id: sttModel, commit_strategy: 'manual', audio_format: 'pcm_16000', token: body.token });
      if (sttLang) p.set('language_code', sttLang);
      for (const k of keyterms) p.append('keyterms', k);
      sttStart = performance.now();
      ws = newSocket(`${sttUrl}?${p}`);
      ws.onopen = () => { const q = outbox; outbox = []; for (const it of q) it === 'commit' ? sendCommit() : sendAudio(it); };
      ws.onerror = ev => { if (!isClosed()) { onError('STT socket error'); console.error('STT ws error', ev); } };
      ws.onclose = ev => { usage.flush(); onClose?.(); if (!isClosed() && ev.code !== 1000) { onError(`STT closed ${ev.code}: ${ev.reason || 'no reason'}`); console.error('STT ws closed', ev.code, ev.reason); } };
      ws.onmessage = ev => {
        const m = JSON.parse(ev.data);
        const ms = Math.round(performance.now() - sttStart);
        if (m.message_type?.endsWith('_error')) { onError(`${m.message_type}: ${m.error || m.reason || m.message || ''}`); console.error('STT error msg', m); return; }
        if (m.message_type === 'partial_transcript') onPartial(m.text || '', ms);
        else if (m.message_type?.startsWith('committed') && m.text) onFinal(m.text, ms);
      };
    } catch (e) {
      // open() is called fire-and-forget (pre-open, and lazily from feed()), so anything thrown here
      // would surface as an unhandled rejection and kill the process under node. A socket that can't
      // be built is unrecoverable for this provider — report it as fatal and let the host stop.
      if (!isClosed()) onFatal(`STT open failed: ${e?.message || e}`);
    } finally {
      opening = false;
    }
  };

  return {
    // Pre-open the socket (token fetch + WS handshake) before any audio so the first utterance isn't
    // stalled by cold connect. Idempotent (open() has a re-entry guard); feed() still opens lazily.
    open() { if (!isClosed() && (!ws || ws.readyState >= 2)) open(); },
    feed(i16) {
      if (!isClosed() && (!ws || ws.readyState >= 2)) open();
      sendAudio(i16); sentSinceCommit = true;
    },
    commit() {
      // No audio since the last commit (VAD can fire several times per utterance, or only the AI's own
      // echo was heard): don't ask ElevenLabs to finalize (that would dup/empty-turn), but still emit an
      // empty close. The agent sets _turnClosing before calling commit() and clears it on onFinal — so
      // without this an empty VAD end would leave _turnClosing stuck (mirrors the Speechmatics contract).
      if (!sentSinceCommit) { onFinal('', Math.round(performance.now() - sttStart)); return; }
      sentSinceCommit = false;
      if (ws?.readyState === 1) sendCommit(); else outbox.push('commit');
    },
    close() { outbox = []; sentSinceCommit = false; usage.flush(); ws?.close(); ws = null; },
  };
}

// ── Speechmatics realtime ────────────────────────────────────────────────────
// Browser↔Speechmatics direct WS. Like ElevenLabs: the backend mints a short-TTL JWT (the raw key
// stays server-side), the browser connects with ?jwt=. Differs in wire shape — a JSON config
// message (StartRecognition) then BINARY audio frames (not base64), and JSON transcript messages
// (AddPartialTranscript / AddTranscript / EndOfUtterance). Billing is trust-but-verify: we report
// streamed seconds to /stt/usage tagged provider:'speechmatics'.
//
// TURN MODEL — LOCKED WORDS ARE THE ONLY SOURCE OF TRUTH:
//   AddTranscript        = permanently locked words → append to `committed`.
//   AddPartialTranscript = the flickering not-yet-locked tail → shown live, NEVER written to history.
//   EndOfUtterance       = the turn boundary (follows our ForceEndOfUtterance, or the silence trigger).
//                          It always trails the flushing AddTranscript, so on arrival `committed` holds
//                          every locked word → onFinal(committed), no tail folding (the old mergeTail
//                          path was the source of the "four, five, four five" duplication). Only the
//                          SAFETY-TIMER close (EndOfUtterance never arrived) folds the interim tail in
//                          — see flushFinal's `withTail`.
// commit() = ForceEndOfUtterance; we wait for EndOfUtterance (bounded safety fallback if the socket
// never answers). NB: requires conversation_config.end_of_utterance_silence_trigger in StartRecognition.
//
// ORDERING: end_times are absolute seconds from StartRecognition (never reset per turn). `cursor` =
// end_time of the last accepted word; anything ending at/before it is an out-of-order straggler from
// a closed turn → dropped. The cursor only advances and survives reset() (close() zeroes it).
const SM_URL = 'wss://eu.rt.speechmatics.com/v2';
export function makeSpeechmaticsSTT(opts) {
  const { apiKey, sttModel, sttLang = 'en', sttTokenUrl, getToken, sttUsageUrl,
          onPartial, onFinal, onError, onFatal, onClose, isClosed } = opts;
  const tokenUrl = sttTokenUrl;
  let ws = null, opening = false, started = false, outbox = [], sentSinceCommit = false, sttStart = 0;
  // committed = locked words (the turn's text; the partial tail is display-only). cursor = monotonic
  // end_time (s) of the last accepted word — the straggler gate (see header). turnOpen = words landed
  // since the last close. awaitingFinal = ForceEndOfUtterance in flight, waiting on EndOfUtterance.
  // sentSamples = stream position (total samples fed this socket, outbox included); commit() snapshots
  // it as commitBoundary — if the safety timer closes a turn WITHOUT the EndOfUtterance handshake, the
  // cursor advances to that boundary, gating the old turn's late flush (audio fed before the commit)
  // while the next turn's words (fed after) flow immediately.
  let committed = '', cursor = 0, turnOpen = false, awaitingFinal = false, safetyTimer = null, pendingForceEnd = false;
  let sentSamples = 0, commitBoundary = 0;
  // lastTail = the most recent interim tail (AddPartialTranscript). Normally display-only, but on a
  // SAFETY-TIMER close (the flushing AddTranscript never arrived) it's the only copy of the user's
  // last words — fold it into that final instead of stripping it. Cleared whenever words lock.
  let lastTail = '';
  // keepalive: audio is VAD-gated, so quiet listening sends NOTHING — Speechmatics closes an idle
  // socket after ~3min of no audio. Trickle 0.1s of silence when idle so the session survives long
  // silences instead of dying + reconnecting (which loses the first words to the token/handshake).
  let keepalive = null, lastSendMs = 0;
  // Send ForceEndOfUtterance now if the socket is live, else defer it until RecognitionStarted (a VAD
  // commit can land before the socket finishes opening; without this the force-end is silently dropped).
  const sendForceEnd = () => {
    if (ws?.readyState === 1 && started) { ws.send(JSON.stringify({ message: 'ForceEndOfUtterance' })); pendingForceEnd = false; }
    else pendingForceEnd = true;
  };
  // Close the turn: emit the LOCKED words (committed) as the final — never the tail. By the time
  // EndOfUtterance lands, Speechmatics has already flushed the turn's words as AddTranscript, so
  // `committed` is complete. Called on EndOfUtterance, or by the safety timer if it never arrives.
  // `withTail`: closing WITHOUT the EndOfUtterance handshake (safety timer) — the flushing
  // AddTranscript never landed, so the last interim tail is the only copy of the user's final words.
  // Fold it in rather than strip it; the cursor advance (armSafety) gates the late flush so the same
  // words can't ALSO land as a locked duplicate afterwards. The normal EOU path stays locked-words-only.
  const flushFinal = (withTail = false) => {
    clearTimeout(safetyTimer); safetyTimer = null;
    awaitingFinal = false; turnOpen = false; sentSinceCommit = false;   // turn closed → nothing left to finalize
    const t = (withTail && lastTail ? `${committed} ${lastTail}` : committed).trim();
    committed = ''; lastTail = '';   // keep cursor: monotonic gate survives the turn
    // Always notify — even empty — so the agent clears its "closing" state and never wedges waiting.
    onFinal(t, Math.round(performance.now() - sttStart));
  };
  const armSafety = (ms) => { clearTimeout(safetyTimer); safetyTimer = setTimeout(() => {
    // Closing WITHOUT the EndOfUtterance handshake: the old turn's late flush may hold words the
    // cursor never saw locked. Advance it to the commit-time stream boundary — the old turn's words
    // (fed before the commit) end at/before it and are gated; the next turn's flow immediately.
    cursor = Math.max(cursor, commitBoundary);
    flushFinal(true);
  }, ms); };

  const usage = makeUsageReporter(sttUsageUrl, apiKey, 'speechmatics', { model: sttModel || 'standard' });

  const sendAudio = (i16) => {
    if (!ws || ws.readyState !== 1 || !started) { outbox.push(i16); return; }
    ws.send(i16.buffer);   // raw binary AddAudio (pcm_s16le @16k, declared in StartRecognition)
    lastSendMs = performance.now();
    usage.add(i16.length);
  };

  const open = async () => {
    if (opening) return;
    opening = true;
    // NEW SOCKET = NEW STREAM CLOCK: end_times restart at 0 (they're relative to the new socket's
    // StartRecognition), so per-socket state must reset. Without this, a silent reconnect (e.g.
    // Speechmatics' idle timeout closed the old socket, feed() reopened) leaves the old
    // cursor/sentSamples in place — every word of the new stream ends "behind" the stale cursor and
    // is dropped as a straggler → the session goes PERMANENTLY DEAF. Stale `started` similarly made
    // feed() send audio before the new RecognitionStarted handshake. Reset SYNCHRONOUSLY, before the
    // awaited token fetch: feed() calls open() first and increments sentSamples after, so audio
    // queued while the socket opens is counted into THIS socket's clock (the commitBoundary safety
    // gate stays correct). `committed` survives: words locked before a mid-turn drop still belong to
    // the open turn's final.
    cursor = 0; sentSamples = 0; commitBoundary = 0; started = false;
    try {
      const body = await mintSttToken(tokenUrl, apiKey, onFatal, getToken);
      if (!body) { outbox = []; sentSinceCommit = false; return; }
      if (isClosed()) return;
      sttStart = performance.now();
      ws = newSocket(`${SM_URL}?jwt=${encodeURIComponent(body.token)}`);
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => {
        // Declare the audio format + transcription config, then flush buffered audio once started.
        ws.send(JSON.stringify({
          message: 'StartRecognition',
          audio_format: { type: 'raw', encoding: 'pcm_s16le', sample_rate: 16000 },
          // max_delay = seconds Speechmatics waits before LOCKING words into a final (AddTranscript); the
          // 4s default leaves a long flickering PARTIAL tail (6-7 words) before words move to `committed`.
          // We tie it to the model's accuracy headroom: 'enhanced' (their demo's combo) tolerates max_delay:1
          // for a snappy 1-4 word tail; 'standard' lacks that headroom, so 2s (Speechmatics' documented
          // "optimal balance", ~1% loss vs ~<5% at 1s) buys back the context it needs. max_delay_mode stays
          // default ('flexible') so entities (numbers/dates) still finalize whole. (Range 0.7–4.)
          // conversation_config.end_of_utterance_silence_trigger is REQUIRED for ForceEndOfUtterance /
          // EndOfUtterance to work at all — without it commit() is silently ignored and the turn only
          // ever closes via the safety timer. Keep it < max_delay. The AGENT owns the boundary (VAD +
          // turnDetector → commit → ForceEndOfUtterance); a silence-triggered EndOfUtterance can also
          // close a turn, but since the agent feeds VAD-GATED audio (little post-speech silence reaches
          // Speechmatics), commit() is the boundary that matters in practice.
          transcription_config: { language: (sttLang || 'en').slice(0, 2), operating_point: sttModel || 'standard', enable_partials: true, max_delay: sttModel === 'enhanced' ? TUNING.STT.maxDelayEnhanced : TUNING.STT.maxDelayStandard, conversation_config: { end_of_utterance_silence_trigger: TUNING.STT.eouSilenceTrigger } },
        }));
      };
      const sock = ws;   // this handler's own socket — feed() may reopen while it's still CLOSING
      ws.onerror = ev => { if (sock === ws && !isClosed()) { onError('STT socket error'); console.error('SM ws error', ev); } };
      // Guard on sock === ws: a superseded socket's late onclose must not kill the NEW socket's
      // keepalive (feed() reopens on readyState>=2, i.e. while the old one is still CLOSING).
      ws.onclose = ev => { if (sock === ws) { clearInterval(keepalive); keepalive = null; } usage.flush(); onClose?.(); if (!isClosed() && sock === ws && ev.code !== 1000) { onError(`STT closed ${ev.code}: ${ev.reason || 'no reason'}`); } };
      ws.onmessage = ev => {
        if (sock !== ws) return;   // stale message from a superseded socket (its clock is dead)
        const m = JSON.parse(ev.data);
        const ms = Math.round(performance.now() - sttStart);
        switch (m.message) {
          case 'RecognitionStarted': {
            started = true; const q = outbox; outbox = []; for (const c of q) sendAudio(c); if (pendingForceEnd) sendForceEnd();
            // Idle keepalive (see declaration): 0.1s of silence whenever nothing was sent for 20s
            // AND no turn is open/closing — injected silence must never trip the provider's
            // end-of-utterance silence trigger on a live turn. Cost is negligible (~0.5% stream time).
            // Counts into `sentSamples` like any other sent audio: it genuinely advances Speechmatics'
            // stream clock (end_times are relative to ALL audio sent), so the commitBoundary safety
            // gate must stay in sync or a late straggler could slip past cursor after an idle period.
            clearInterval(keepalive);
            keepalive = setInterval(() => {
              if (ws?.readyState === 1 && started && !turnOpen && !awaitingFinal && !sentSinceCommit
                  && performance.now() - lastSendMs > 20000) {
                const silence = new Int16Array(1600);
                sentSamples += silence.length;
                sendAudio(silence);
              }
            }, 5000);
            keepalive.unref?.();   // Node (tests): don't hold the event loop open; no-op in browsers
            break;
          }
          // Live tail — display-only replacement, never committed to history. During an OPEN turn
          // Speechmatics restates the tail around the just-locked boundary, so a partial's end_time can
          // legitimately land at/behind the last locked word's cursor — gating those there silently
          // drops live updates and the visible tail blanks/freezes for ~max_delay after each lock
          // ("cuts every few seconds" during continuous speech). Only drop behind-cursor partials once
          // the turn is CLOSED/closing (!turnOpen || awaitingFinal), so a stale old-turn partial can't
          // leak a ghost transcript / false barge-in (onPartial also feeds the barge-in check).
          case 'AddPartialTranscript': {
            const end = m.metadata?.end_time ?? 0;
            if (cursor > 0 && end > 0 && end <= cursor && (!turnOpen || awaitingFinal)) break;
            turnOpen = true;
            lastTail = (m.metadata?.transcript || '').trim();
            onPartial(lastTail, ms, committed);
            break;
          }
          // Words permanently locked → append to `committed`, advance the cursor. Never closes the
          // turn — EndOfUtterance does (below).
          case 'AddTranscript': {
            const end = m.metadata?.end_time ?? 0;
            if (cursor > 0 && end > 0 && end <= cursor) break;   // straggler for a closed turn → drop
            const frag = (m.metadata?.transcript || '').trim();
            if (frag) { committed = committed ? `${committed} ${frag}` : frag; turnOpen = true; }
            cursor = Math.max(cursor, end);
            // The lock usually consumes the whole tail; a PREFIX lock (frag = the tail's first words)
            // leaves the remainder as the only copy of the newest words — keep it for a safety close.
            // A diverging lock (revised words) clears the tail so the fold can't duplicate.
            lastTail = frag && lastTail.startsWith(frag) ? lastTail.slice(frag.length).trim() : '';
            onPartial('', ms, committed);   // tail consumed, committed grew → re-render solid
            break;
          }
          // Speechmatics' turn boundary (after our ForceEndOfUtterance, or its own silence trigger).
          // The flushing AddTranscript has already landed, so `committed` is complete → close on it.
          case 'EndOfUtterance': {
            if (!awaitingFinal && !turnOpen) break;   // nothing open to close (stray/duplicate)
            flushFinal();
            break;
          }
          case 'Error': onError(`${m.type || 'error'}: ${m.reason || ''}`); break;
        }
      };
    } catch (e) {
      // open() is called fire-and-forget (pre-open, and lazily from feed()), so anything thrown here
      // would surface as an unhandled rejection and kill the process under node. A socket that can't
      // be built is unrecoverable for this provider — report it as fatal and let the host stop.
      if (!isClosed()) onFatal(`STT open failed: ${e?.message || e}`);
    } finally {
      opening = false;
    }
  };

  return {
    // Pre-open the socket (token fetch + WS handshake) before any audio so the first utterance isn't
    // stalled by cold connect. Idempotent (open() has a re-entry guard); feed() still opens lazily.
    open() { if (!isClosed() && (!ws || ws.readyState >= 2)) open(); },
    feed(i16) {
      if (!isClosed() && (!ws || ws.readyState >= 2)) open();
      sentSamples += i16.length;   // stream position (counts outbox-queued audio too — sent in order)
      sendAudio(i16); sentSinceCommit = true;
    },
    // Start a fresh utterance: drop leftover committed words so a prior turn can't bleed into this
    // one. Called on a fresh VAD speech-start when the previous turn actually CLOSED — a turn the
    // detector kept open is intentionally NOT reset. `cursor` survives (the straggler gate; end_times
    // don't reset per turn); pending force-end state is cleared.
    reset() { clearTimeout(safetyTimer); safetyTimer = null; awaitingFinal = false; pendingForceEnd = false; committed = ''; lastTail = ''; turnOpen = false; },
    // VAD speech-end = the utterance boundary. Ask Speechmatics to finalize NOW (ForceEndOfUtterance →
    // it flushes the turn's words as AddTranscript, then emits EndOfUtterance); awaitingFinal makes that
    // EndOfUtterance close the turn. A short safety timer closes it anyway if the socket never answers.
    commit() {
      if (awaitingFinal) return;                 // already closing — its flushFinal will notify
      // Nothing to finalize (stray VAD end, e.g. only the AI's own echo): the agent waits on onFinal
      // to clear its closing latch, so emit an empty close.
      if (!turnOpen && !sentSinceCommit) { onFinal('', Math.round(performance.now() - sttStart)); return; }
      if (!sentSinceCommit) { flushFinal(); return; }   // no new audio this turn: close on the words we have
      commitBoundary = sentSamples / 16000;      // this turn's audio all ends at/before here (safety gate)
      sentSinceCommit = false;
      awaitingFinal = true;
      sendForceEnd();                            // sends now, or defers to RecognitionStarted if still opening
      armSafety(TUNING.STT.forceEndSafetyMs);    // fallback if EndOfUtterance never arrives (tuning.js)
    },
    close() { clearTimeout(safetyTimer); safetyTimer = null; clearInterval(keepalive); keepalive = null; outbox = []; committed = ''; lastTail = ''; cursor = 0; sentSamples = 0; commitBoundary = 0; turnOpen = false; awaitingFinal = false; sentSinceCommit = false; started = false; pendingForceEnd = false; usage.flush(); ws?.close(); ws = null; },
  };
}

// ── Deepgram Flux realtime ───────────────────────────────────────────────────
// Browser↔Deepgram direct WS, same token pattern as the others: the backend mints a short-TTL
// access token (POST /v1/auth/grant, key stays server-side) and the browser authenticates via the
// WebSocket subprotocol ['bearer', token] (browsers can't set an Authorization header). Audio is
// raw binary pcm16 @16k like Speechmatics.
//
// Flux differs from Speechmatics/ElevenLabs in WHO owns the turn boundary: its model does native
// end-of-turn detection (semantic + acoustic) and emits TurnInfo events — `Update` while the turn
// is in progress (transcript = the WHOLE turn so far, not a fragment) and `EndOfTurn` when it
// decides the user is done. For that to work it must hear the real silences, so this provider sets
//   continuous: true  → the agent feeds the FULL mic stream (no VAD gating / preroll)
//   nativeEOT:  true  → the agent does NOT commit() on VAD speech-end; onFinal arrives unsolicited
//                       from EndOfTurn and the agent's onFinal path closes the turn.
// commit()/reset() are still implemented (VAD-gated fallback contract) so a host that ignores the
// flags gets working — if slower — turn handling: commit() waits briefly for a native EndOfTurn and
// otherwise flushes the latest turn transcript.
const DG_URL = 'wss://api.deepgram.com/v2/listen';
// Deepgram's auth endpoints are US-hosted — a token mint costs ~0.6-1s from EU, and it sits on the
// CRITICAL PATH of every socket open (the token rides in the WS handshake, so nothing can connect
// until it arrives). The backend mints with a 300s TTL; cache it module-wide (shared across agent
// instances/reopens) and reuse until shortly before expiry, so a stop()/start() resume — which
// closes and reopens the socket — only pays the ~0.4s handshake instead of the full mint chain.
let dgToken = null, dgTokenExp = 0;
// Pre-mint + cache the Deepgram token OFF the critical path (call at prewarm time, e.g. mic-button
// mount): during a cold voice start the mint races Piper/ONNX downloads for bandwidth and main
// thread (measured 2.7s in-session vs 0.6s standalone), so paying it early means the click only owes
// the ~0.4s WS handshake. Best-effort + deduped; makeDeepgramSTT reads the same cache.
let dgMintPromise = null;
export function warmDeepgramToken(sttTokenUrl, apiKey, getToken) {
  if (dgToken && performance.now() < dgTokenExp - 30000) return Promise.resolve();
  return (dgMintPromise ??= (async () => {
    const body = await mintSttToken(sttTokenUrl, apiKey, () => {}, getToken);   // best-effort: failure just means open() re-mints
    if (body) { dgToken = body.token; dgTokenExp = performance.now() + (body.expires_in ?? 300) * 1000; }
  })().finally(() => { dgMintPromise = null; }));
}
export function makeDeepgramSTT(opts) {
  const { apiKey, sttModel, sttLang = 'en', keyterms = [], sttTokenUrl, getToken, sttUsageUrl,
          eotThreshold = TUNING.STT.fluxEotThreshold, onPartial, onFinal, onError, onFatal, onClose, isClosed } = opts;
  const tokenUrl = sttTokenUrl;
  const model = sttModel || 'flux-general-en';
  let ws = null, opening = false, outbox = [], sttStart = 0;
  // TurnInfo.transcript is cumulative for the CURRENT turn (Flux restarts it on each new turn_index),
  // so `turnText` is simply the latest transcript — no committed/tail split needed.
  let turnText = '', audioSinceFinal = false, awaitingFinal = false, safetyTimer = null;
  const usage = makeUsageReporter(sttUsageUrl, apiKey, 'deepgram', { model });

  // Pre-open buffer is a bounded PREROLL (~1s), not a backlog: Flux is a real-time model — burst-
  // sending seconds of buffered audio after a slow token fetch/handshake makes its whole timeline lag
  // real time (garbled starts, late EndOfTurns). Keep only the newest ~1s so the user's first words
  // survive the connect without shifting Flux's clock.
  const OUTBOX_MAX_SAMPLES = 32000;   // ~2s: enough to cover the WS handshake so opening words survive
  let outboxSamples = 0;
  const sendAudio = (i16) => {
    if (!ws || ws.readyState !== 1) {
      outbox.push(i16); outboxSamples += i16.length;
      while (outboxSamples > OUTBOX_MAX_SAMPLES && outbox.length > 1) outboxSamples -= outbox.shift().length;
      return;
    }
    ws.send(i16.buffer);   // raw binary linear16 @16k (declared in the URL query)
    usage.add(i16.length);
  };

  // Close the turn from OUR side (host-called commit() fallback only — the agent never calls this in
  // native mode). NB: because Flux transcripts are cumulative per turn, flushing a still-open turn
  // emits a prefix Flux will restate — only useful for hosts that ignore the nativeEOT flag.
  const flushFinal = () => {
    clearTimeout(safetyTimer); safetyTimer = null; awaitingFinal = false;
    const t = turnText; turnText = ''; audioSinceFinal = false;
    onFinal(t, Math.round(performance.now() - sttStart));
  };
  const armSafety = () => { clearTimeout(safetyTimer); safetyTimer = setTimeout(flushFinal, TUNING.STT.forceEndSafetyMs); };

  const open = async () => {
    if (opening) return;
    opening = true;
    try {
      // Cached token still fresh? Skip the mint round trip entirely (see dgToken above). 15s slack:
      // the token only needs to be valid at handshake time, but leave margin for a slow connect.
      let token = (dgToken && performance.now() < dgTokenExp - 15000) ? dgToken : null;
      if (!token) {
        const body = await mintSttToken(tokenUrl, apiKey, onFatal, getToken);
        if (!body) { outbox = []; outboxSamples = 0; return; }
        token = dgToken = body.token;
        dgTokenExp = performance.now() + (body.expires_in ?? 300) * 1000;
      }
      if (isClosed()) return;
      const p = new URLSearchParams({ model, encoding: 'linear16', sample_rate: '16000', eot_threshold: String(eotThreshold) });
      if (model.endsWith('multi') && sttLang) p.append('language_hint', sttLang.slice(0, 2));
      for (const k of keyterms) p.append('keyterm', k);
      sttStart = performance.now();
      // Browser WS auth: Sec-WebSocket-Protocol "bearer, <token>" (short-TTL access token from
      // /v1/auth/grant). The token only needs to be valid at handshake time; the socket persists.
      ws = newSocket(`${DG_URL}?${p}`, ['bearer', token]);
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => { const q = outbox; outbox = []; outboxSamples = 0; for (const c of q) sendAudio(c); };
      ws.onerror = ev => { if (!isClosed()) { onError('STT socket error'); console.error('DG ws error', ev); } };
      ws.onclose = ev => {
        usage.flush(); onClose?.();
        // Handshake rejected (auth) — likely a stale cached token (clock drift / revocation): drop the
        // cache so the next open() re-mints instead of failing forever within the cached window.
        if (ev.code === 1008 || ev.code === 4001 || ev.code === 1002) { dgToken = null; dgTokenExp = 0; }
        if (!isClosed() && ev.code !== 1000) { onError(`STT closed ${ev.code}: ${ev.reason || 'no reason'}`); }
      };
      ws.onmessage = ev => {
        if (typeof ev.data !== 'string') return;
        const m = JSON.parse(ev.data);
        const ms = Math.round(performance.now() - sttStart);
        if (m.type === 'TurnInfo') {
          const t = (m.transcript || '').trim();
          if (m.event === 'EndOfTurn') {
            // Native turn boundary: Flux decided the user is done. Emit the whole turn as final —
            // unsolicited from the agent's point of view (its onFinal path closes the turn cleanly).
            clearTimeout(safetyTimer); safetyTimer = null; awaitingFinal = false;
            turnText = ''; audioSinceFinal = false;
            onFinal(t, ms);
          } else {   // Update / StartOfTurn (EagerEndOfTurn/TurnResumed only occur with eager_eot_threshold set)
            turnText = t;
            onPartial(t, ms);
          }
        } else if (m.type === 'Error') { onError(`${m.code || 'error'}: ${m.description || ''}`); console.error('DG error msg', m); }
      };
    } catch (e) {
      // open() is called fire-and-forget (pre-open, and lazily from feed()), so anything thrown here
      // would surface as an unhandled rejection and kill the process under node. A socket that can't
      // be built is unrecoverable for this provider — report it as fatal and let the host stop.
      if (!isClosed()) onFatal(`STT open failed: ${e?.message || e}`);
    } finally {
      opening = false;
    }
  };

  return {
    continuous: true,   // agent feeds the full mic stream (Flux needs real silences for its EOT model)
    nativeEOT: true,    // agent skips VAD-commit; EndOfTurn → unsolicited onFinal closes the turn
    // Flux ends turns SEMANTICALLY, right behind its own last interim (21ms median, measured) —
    // there is no trailing-silence debounce to hide a stability wait in, so the default 200ms timer
    // never fires and every turn pays full LLM TTFT. Speculate on the interim tick instead.
    prefetchMs: 0,
    open() { if (!isClosed() && (!ws || ws.readyState >= 2)) open(); },
    feed(i16) {
      if (!isClosed() && (!ws || ws.readyState >= 2)) open();
      sendAudio(i16); audioSinceFinal = true;
    },
    reset() { turnText = ''; clearTimeout(safetyTimer); safetyTimer = null; awaitingFinal = false; },
    // VAD-gated fallback: give the native EndOfTurn a short window to land (it usually beats this —
    // the trailing VAD-redemption silence is in the stream), then flush what we have. If no audio was
    // fed since the last final there's no turn — emit an empty close so the host's closing latch clears.
    commit() {
      if (awaitingFinal) return;
      if (!audioSinceFinal) { onFinal('', Math.round(performance.now() - sttStart)); return; }
      awaitingFinal = true;
      armSafety();
    },
    close() {
      clearTimeout(safetyTimer); safetyTimer = null; outbox = []; outboxSamples = 0; turnText = ''; audioSinceFinal = false; awaitingFinal = false;
      usage.flush();
      if (ws?.readyState === 1) { try { ws.send(JSON.stringify({ type: 'CloseStream' })); } catch { /* closing anyway */ } }
      ws?.close(); ws = null;
    },
  };
}

// ── Browser Web Speech API (browser-managed, no token) ───────────────────────
// "Browser-native" is not "on-device": Chrome may route recognition through a vendor speech
// service. The win here is zero setup (no key, no token endpoint), not guaranteed privacy.
// The browser's own SpeechRecognition engine (Chrome/Safari `webkitSpeechRecognition`). It OWNS the
// whole audio path — its own mic capture AND its own silence-based end-of-turn — so the agent builds
// NO getUserMedia / AudioWorklet / Silero-VAD pipeline for it (`selfCapture: true`, which the agent
// reads as "just open() me"). It's `nativeEOT: true`: the provider closes turns itself, so there's no
// VAD-commit — a short silence-debounce after the engine's own isFinal fires onFinal as ONE turn.
//   interim results → onPartial(tail)   live draft + word-based barge-in while the agent is speaking
//   final results   → accumulate + (re)arm the end-of-turn timer; if the user keeps talking within
//                     the debounce window the fragments merge, else the timer flushes the turn
// No backend token, no /stt/usage reporting (free, zero-setup), no socket. Only where the API exists
// (else open() reports a fatal so the host can fall back / surface it).
// Browser Web Speech API STT. The agent hands it nothing (selfCapture) — it owns its mic and its own
// end-of-turn (nativeEOT). It reports transcripts via onPartial (live draft, drives the user bubble +
// word-based barge-in) and onFinal (one committed user turn).
//
// THE HARD PART — Chrome fragments ONE logical listening session into MANY short-lived recognizer
// instances. A `SpeechRecognition` auto-`onend`s after a brief internal silence (even mid-sentence);
// we recreate it in onend to keep listening. A single user utterance therefore spans several
// recognizers, and TWO artefacts of that churn must be neutralised so the agent sees one clean turn:
//
//   1. LIVENESS RACE — the restart gap (onend → new onstart) is NOT a user pause, just a technicality.
//      The turn boundary is decided SOLELY by a silence debounce measured from the last time real TEXT
//      arrived (`lastActivity`), completely independent of recognizer lifecycle. A restart never arms,
//      fires, or cancels that clock. So whether or not a recognizer happens to be alive when the timer
//      elapses is irrelevant — no race. (The old bug: the debounce fired DURING a restart, emitting the
//      opening as its own turn; the fresh recognizer then re-finalized the same buffered audio → the
//      opening was duplicated into a second turn, which barged in and killed the reply.)
//
//   2. SEAM DUPLICATION — when Chrome auto-ends mid-word it re-delivers the tail it was still buffering
//      as the NEXT recognizer's first final (and can even restate a tail within one recognizer's own
//      result window). Blindly appending would double words ("hello there" + "there how" → "there there").
//      Every final is de-overlapped against the turn-so-far before it's appended.
export function makeWebSpeechSTT(opts) {
  const { sttLang = 'en', micDeviceId = '', onPartial, onFinal, onError, onFatal, onClose, isClosed } = opts;
  const Rec = typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition);
  const EOT_MS = TUNING.WEBSPEECH_EOT_MS ?? 900;
  const TAIL_MAX_DEFERS = TUNING.WEBSPEECH_TAIL_MAX_DEFERS ?? 3;
  const MAX_ERROR_RESTARTS = TUNING.WEBSPEECH_MAX_ERROR_RESTARTS ?? 5;
  const ERROR_BACKOFF_MS = TUNING.WEBSPEECH_ERROR_BACKOFF_MS ?? 300;
  let rec = null;          // the live SpeechRecognition instance (null between restarts / when stopped)
  let sttStart = 0;        // performance.now() at the current turn's first activity (for onPartial/onFinal ms)
  let turn = '';           // committed (isFinal) text of the CURRENT turn, merged across recognizer restarts
  let interimTail = '';    // last live (not-yet-final) tail — KEPT across recognizer restarts so the draft never blanks
  let eotTimer = null;     // silence debounce: closes the turn EOT_MS after the last real text activity
  let justClosed = '';     // tail of the turn we JUST flushed — a late re-finalized seam is deduped against it
  let justClosedTimer = null;   // clears justClosed after a short guard window (a genuine next turn isn't a seam)
  let tailDefers = 0;      // consecutive closes deferred waiting on an un-promoted tail (bounded, reset on new text)
  let want = false;        // intent to listen — onend auto-restarts while true
  let muted = false;       // mic off — stop the recognizer and don't restart
  let lastError = '';      // error of the recognizer currently ending (drives the backoff/give-up path)
  let errorRestarts = 0;   // consecutive failed launches with no recognized text between them
  let restartTimer = null; // pending backed-off relaunch
  // AEC'D CAPTURE (SpeechRecognition.start(audioTrack), spec'd + shipped in recent Chromium): by
  // default the engine opens its OWN mic, bypassing every protection the agent's pipeline has — the
  // browser AEC referenced against the WebRTC TTS loopback (voice-agent initAecLoopback) and noise
  // suppression. So on speakers the recognizer hears the agent's own reply. Handing it OUR
  // getUserMedia track (echoCancellation+noiseSuppression on) routes the SAME protected audio the
  // cloud providers get. Older engines throw on start(track) — one throw disables it for the
  // session and we fall back to the engine's own capture (old behavior, text-filter guarded).
  let micStream = null;    // AEC'd capture the recognizer runs on — null → engine's own mic
  let micTrack = null;
  let trackArg = true;     // start(track) supported? optimistic; first throw turns it off
  let recHasTrack = false; // whether the CURRENT recognizer was started on micTrack (for the upgrade restart)
  let micGen = 0;          // bumped by dropMic — a getUserMedia resolving from an older generation is stopped, not published (mute/close during acquisition can't leak an OS mic)
  let lastLoggedMode = null;   // capture-mode console.info dedup — log only on change, not per restart
  let micPending = null;   // the single in-flight acquisition — concurrent ensureTrack calls share it
  const acquireMic = () => {
    if (micPending) return micPending;
    // globalThis.navigator, not bare `navigator`: this module is imported under SSR and under node
    // (tests), where the bare identifier is a ReferenceError rather than undefined — and this path
    // is already written to degrade to the recognizer's own capture when there's no getUserMedia.
    if (micTrack?.readyState === 'live' || !trackArg || !globalThis.navigator?.mediaDevices?.getUserMedia) return Promise.resolve();
    const gen = micGen;
    micPending = globalThis.navigator.mediaDevices.getUserMedia({ audio: {
      echoCancellation: true, noiseSuppression: true, autoGainControl: true,
      ...(micDeviceId ? { deviceId: { exact: micDeviceId } } : {}),
    } }).then((s) => {
      // Stale (muted/closed/dropped while pending) → stop immediately; publishing it would leak the mic.
      if (gen !== micGen || muted || !want || isClosed()) { s.getTracks().forEach((t) => t.stop()); return; }
      micStream?.getTracks().forEach((t) => t.stop());   // never hold two captures
      micStream = s; micTrack = s.getAudioTracks()[0] ?? null;
      // Device unplugged mid-session: forget the dead track so the next boundary re-acquires (or the
      // recognizer falls back to its own capture) instead of silently keeping a corpse around.
      if (micTrack) micTrack.addEventListener('ended', () => { if (micStream === s) { s.getTracks().forEach((t) => t.stop()); micStream = null; micTrack = null; } });
    }).catch(() => { /* denied/no device → engine's own capture */ })
      .finally(() => { micPending = null; });
    return micPending;
  };
  const dropMic = () => { micGen++; micStream?.getTracks().forEach((t) => t.stop()); micStream = null; micTrack = null; };
  // Acquire (or re-acquire) the track, then upgrade a recognizer that started track-less: abort it
  // and let onend relaunch via start(), which now has micTrack. Only at a turn boundary — an abort
  // mid-utterance would drop buffered speech. If acquisition lands mid-utterance, flush() re-runs
  // this at the turn boundary, so the upgrade isn't lost.
  const ensureTrack = () => acquireMic().then(() => {
    if (trackArg && micTrack?.readyState === 'live' && rec && !recHasTrack && !turn && !interimTail) { try { rec.abort(); } catch { /* onend relaunches anyway */ } }
  });
  // SpeechRecognition wants a BCP-47 tag (en-US, hu-HU); our sttLang is often a bare code (en, hu).
  const langTag = (l) => ({ en: 'en-US', hu: 'hu-HU', de: 'de-DE' }[String(l || '').slice(0, 2).toLowerCase()] || l || 'en-US');

  // Chars of `next` to drop so a re-finalized tail isn't appended twice: the longest suffix of `prev`
  // that is also a prefix of `next`, aligned to word boundaries (so "there"⊄"therefore"). Returns the
  // overlap length in `next`. Case-insensitive compare; the caller slices the ORIGINAL-cased `next`.
  const seamOverlap = (prev, next) => {
    const a = prev.toLowerCase(), b = next.toLowerCase();
    const max = Math.min(a.length, b.length);
    for (let n = max; n > 0; n--) {
      const boundary = b.length === n || b[n] === ' ';   // the overlap ends on a word edge in `next`
      const aligned = a.length === n || a[a.length - n - 1] === ' ';   // ...and on one in `prev`
      if (boundary && aligned && a.slice(a.length - n) === b.slice(0, n)) return n;
    }
    return 0;
  };

  // Append a newly-finalized fragment to the turn, de-overlapping the restart/restate seam first.
  // seamOverlap is word-boundary aligned, so it drops a re-finalized tail (whole or partial) without
  // eating a legitimate suffix that merely shares letters ("goodbye" then "bye" keeps "bye").
  const commitFinal = (frag) => {
    frag = frag.trim();
    if (!frag) return;
    // If a turn just flushed (Chrome auto-restarted right as the silence clock closed the turn), the
    // fresh recognizer often re-finalizes that turn's tail as this turn's FIRST final — a duplicate.
    // De-overlap it against the just-closed tail so the repeat is dropped instead of becoming a bogus
    // new turn (the barge-in-killing dup). Only applies while `turn` is still empty (start of a turn).
    if (!turn && justClosed) { const ov = seamOverlap(justClosed, frag); frag = ov ? frag.slice(ov).trimStart() : frag; if (!frag) return; }
    if (turn) { const ov = seamOverlap(turn, frag); frag = ov ? frag.slice(ov).trimStart() : frag; }
    if (frag) turn = turn ? `${turn} ${frag}` : frag;
  };

  const flush = () => {   // the silence debounce elapsed: the turn-so-far is one complete user turn
    clearTimeout(eotTimer); eotTimer = null;
    // NOT QUIESCENT YET: a live recognizer still holding an un-promoted tail means the utterance is
    // by definition unfinished — Chrome's endpointer can take longer than EOT_MS to promote trailing
    // words to isFinal. Closing here would emit a TRUNCATED turn and let the late final open a bogus
    // second one — and since the two texts are DISJOINT ("book a meeting" / "for tomorrow at five"),
    // the justClosed seam-guard has no overlap to dedup and can't catch it. So wait for the engine
    // instead of guessing with a clock. The wait is bounded twice over: onend clears the tail (the
    // engine gave up on it), and TAIL_MAX_DEFERS caps a tail that never resolves. The cap only bounds
    // the WAIT — it does not make that path safe: closing there emits the same truncated turn, just
    // ≥TAIL_MAX_DEFERS windows later. It's a liveness backstop for an engine that never resolves nor
    // ends, not a second correctness guarantee (the real fix is waiting for quiescence at all).
    if (rec && interimTail && tailDefers++ < TAIL_MAX_DEFERS) { armEot(); return; }
    interimTail = ''; tailDefers = 0;
    // Only FINALIZED words become a turn. A tail that survived to end-of-turn WITHOUT ever finalizing
    // is noise (throat-clears, background speech) — Chrome finalizes real speech, so a never-final
    // interim is dropped, not committed. `turn` already holds every finalized word (incl. tails folded
    // in on restart by onend, which the fresh recognizer's re-finalization would have confirmed).
    const text = turn.trim(); turn = '';
    if (!text) return;   // blank silence → not a turn
    // Guard the seam: if Chrome auto-restarted exactly as this turn closed, the fresh recognizer may
    // re-finalize this turn's tail as the NEXT turn's opening. Remember it briefly so commitFinal drops
    // that late duplicate instead of emitting a bogus turn (the barge-in-killer). One-debounce window —
    // a genuine next turn arriving later is NOT a seam.
    justClosed = text; clearTimeout(justClosedTimer); justClosedTimer = setTimeout(() => { justClosed = ''; }, EOT_MS);
    onPartial('', 0, '');   // clear the live draft the just-committed turn was still showing
    onFinal(text, Math.round(performance.now() - sttStart));
    // Turn boundary = the safe seam for the AEC'd-track upgrade (and for re-acquiring a track that
    // died mid-turn) — if the track landed while the user was speaking, this is where it takes effect.
    if (want && !muted && !isClosed()) ensureTrack();
  };
  // A SILENCE clock, not a recognizer clock: (re)armed on ANY real text (final OR live interim) so a
  // mid-thought pause keeps one turn together, and closed only after EOT_MS with no new text at all —
  // recognizer restarts in between neither arm nor fire it. That's what makes the turn boundary immune
  // to Chrome's internal churn.
  const armEot = () => { clearTimeout(eotTimer); eotTimer = setTimeout(flush, EOT_MS); };

  const start = () => {
    if (!Rec || rec || muted || isClosed()) return;
    const r = new Rec();
    r.continuous = true; r.interimResults = true; r.lang = langTag(sttLang);
    r.onstart = () => { if (!turn && !interimTail) sttStart = performance.now(); };   // anchor ms at the turn's first activity (final OR live interim), not each restart
    r.onresult = (event) => {
      if (r !== rec) return;   // stale recognizer (superseded by a restart) — ignore its late events
      let final = '', interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const t = event.results[i][0].transcript;
        if (event.results[i].isFinal) final += t; else interim += t;
      }
      final = final.trim(); interim = interim.trim();
      if (!turn && !interimTail && (final || interim)) sttStart = performance.now();   // first activity of a fresh turn
      if (final || interim) errorRestarts = 0;   // the engine is demonstrably working — forget past failures
      commitFinal(final);   // de-overlaps the seam, then locks the newly-final words into the turn
      // Keep the live tail as its own state so a recognizer restart (which drops interim) can replay it
      // instead of blanking the draft. A frame that only finalized words (interim === '') clears it —
      // those words moved into `turn`, so the tail is genuinely empty now, not lost.
      interimTail = interim;
      if (final || interim) { tailDefers = 0; armEot(); }   // any real text (re)arms the silence debounce (and is fresh progress, so the tail-deferral budget resets) — see armEot
      // Live draft = committed turn-so-far + the still-forming interim tail. Drives the user bubble and
      // word-based barge-in (the agent cuts its reply the instant real words land).
      onPartial(interimTail, Math.round(performance.now() - sttStart), turn);
    };
    r.onerror = (event) => {
      if (r !== rec) return;
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') { want = false; onFatal?.(`Speech recognition: ${event.error}`); return; }
      // 'no-speech' / 'aborted' are the engine's normal idle churn — onend just relaunches, silently.
      // Anything else ('network', 'audio-capture', …) is a FAILED launch: remembered here so onend
      // backs off instead of hot-looping, and gives up out loud once the engine looks dead.
      if (event.error !== 'no-speech' && event.error !== 'aborted') lastError = event.error;
    };
    r.onend = () => {
      if (r !== rec) return;   // superseded instance's late onend — ignore
      rec = null;
      // The engine dropped its buffered tail, so it no longer represents PENDING words — a close
      // deferred on it (see flush) must not keep waiting. The draft still shows the committed `turn`,
      // and the fresh recognizer re-finalizes real speech, so clearing it here costs no flicker.
      interimTail = '';
      // Chrome drops any not-yet-final interim on auto-end. DON'T commit it here — only finalized words
      // count (a never-final tail is noise). If the tail was real speech, the fresh recognizer will
      // re-finalize it (commitFinal then locks it in, deduping the seam).
      // Keep the SAME logical session alive by relaunching. The turn and its silence timer are
      // untouched — if this really was end-of-turn, that timer fires on its own EOT_MS after the last
      // word (recognizer alive or not); if the user is still talking, the new recognizer's text
      // re-arms it. No flush decision belongs here — that's what makes the boundary restart-immune.
      const err = lastError; lastError = '';
      if (!(want && !muted && !isClosed())) { onClose?.(); return; }
      if (!err) { errorRestarts = 0; start(); return; }
      // A launch that only produced an error and no text: the engine may be permanently unable to run
      // here (speech service unreachable, unreadable capture device). Retry with backoff, then stop —
      // an endless silent restart loop is indistinguishable from "listening" and never recovers.
      if (++errorRestarts > MAX_ERROR_RESTARTS) {
        want = false;
        onFatal?.(`Speech recognition: ${err} (${MAX_ERROR_RESTARTS} restarts failed — the browser's speech service is unreachable)`);
        return;
      }
      onError?.(`Speech recognition: ${err} — retrying (${errorRestarts}/${MAX_ERROR_RESTARTS})`);
      restartTimer = setTimeout(() => { restartTimer = null; if (want && !muted && !isClosed()) start(); }, Math.min(ERROR_BACKOFF_MS * 2 ** (errorRestarts - 1), 4000));
    };
    rec = r;
    let ok = false;
    if (trackArg && micTrack?.readyState === 'live') {
      try { r.start(micTrack); ok = true; recHasTrack = true; }
      catch (e) { trackArg = false; dropMic(); console.info('[webspeech] start(track) rejected — engine\'s own mic (no AEC):', e?.message || e); }   // engine predates start(track) — release the now-useless capture (don't hold two mics)
    }
    if (!ok) { recHasTrack = false; try { r.start(); } catch { rec = null; } }   // start() throws if already running — treat as no-op
    if (rec && recHasTrack !== lastLoggedMode) { lastLoggedMode = recHasTrack; console.info(`[webspeech] capture: ${recHasTrack ? "AEC'd track (start(track))" : "engine's own mic (unprotected)"}`); }
  };

  // Stop the current recognizer and drop all in-progress state (mute/close). The stopped recognizer's
  // late onend is stale (rec nulled → r !== rec), so it can't auto-restart.
  const teardown = () => { clearTimeout(eotTimer); eotTimer = null; clearTimeout(justClosedTimer); justClosedTimer = null; clearTimeout(restartTimer); restartTimer = null; justClosed = ''; turn = ''; interimTail = ''; tailDefers = 0; lastError = ''; if (rec) { const r = rec; rec = null; try { r.stop(); } catch { /* already stopped */ } } };

  return {
    selfCapture: true,   // owns its mic → the agent builds no capture pipeline
    nativeEOT: true,     // owns its end-of-turn → the agent runs no VAD-commit
    open() {
      if (!Rec) { onFatal?.('Speech recognition not supported in this browser'); return; }
      // start() first, synchronously — Safari requires SpeechRecognition.start inside the click
      // gesture. The AEC'd track lands async right after and upgrades the recognizer at the seam.
      want = true; errorRestarts = 0; start();
      ensureTrack();
    },
    // Mute: Web Speech captures its OWN mic (independent of the agent), so mute must actually stop it.
    // `rec` is nulled by teardown() so the stopped recognizer's late onend is stale (r !== rec) and
    // can't auto-restart; unmute relaunches.
    setEnabled(on) {
      muted = !on;
      if (muted) { teardown(); dropMic(); onPartial('', 0, ''); }   // drop the draft AND the mic (privacy light off)
      else if (want && !rec) { errorRestarts = 0; start(); ensureTrack(); }
    },
    close() { want = false; teardown(); dropMic(); },
  };
}

// Registry: provider id → factory. Add a backend here and it's selectable everywhere.
export const STT_PROVIDERS = {
  webspeech: makeWebSpeechSTT,
  speechmatics: makeSpeechmaticsSTT,
  elevenlabs: makeElevenLabsSTT,
  deepgram: makeDeepgramSTT,
};

// Self-capturing providers own the mic AND their end-of-turn, so the agent builds no capture
// pipeline and runs no VAD for them. Readable WITHOUT constructing a session, so a host can decide
// up front whether prewarming the VAD/ONNX model is worth the download (it isn't, for these) and
// whether to expect 'vad' events at all. Kept on the factory so it can't drift from the session's
// own selfCapture flag.
makeWebSpeechSTT.selfCapture = true;
export const sttSelfCaptures = (provider) => !!STT_PROVIDERS[provider]?.selfCapture;

// Web Speech only exists in Chromium/Safari — Firefox and Linux WebKitGTK webviews ship no
// SpeechRecognition at all. There the default 'webspeech' provider can only fatal ("Speech
// recognition not supported in this browser") and voice mode is simply dead, so resolve it to a
// cloud provider instead (needs a token route configured — see the auth notes at the top).
export const WEBSPEECH_FALLBACK = 'elevenlabs';
export const webSpeechSupported = () =>
  typeof window !== 'undefined' && !!(window.SpeechRecognition || window.webkitSpeechRecognition);
/** Provider id actually used for `id` here — 'webspeech' downgrades to the cloud fallback in a real
 *  browser that lacks SpeechRecognition. Hosts can call it to label/inform ("using cloud recognition").
 *  Outside a browser (SSR/tests) nothing is downgraded: there's no mic there either, so the honest
 *  "not supported" fatal is the right answer. */
export const resolveSttProvider = (id) =>
  (id === 'webspeech' && typeof window !== 'undefined' && !webSpeechSupported() ? WEBSPEECH_FALLBACK : id);
