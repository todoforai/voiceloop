// ── ElevenLabs TTS (cloud, human-grade voices) ─────────────────────────────────────────────────
// A StreamingTTS provider: only `_synth(text, signal) → audio Blob` — sentence chunking, playback,
// barge-in, seek and speculative presynth all come from the base class, so switching Piper ↔
// ElevenLabs changes the VOICE, not the behavior. decodeAudioData handles the returned mp3.
//
// Auth, two modes (mirrors the STT providers' "key stays server-side" stance):
//   • ttsUrl  — YOUR backend proxy: POST { text, voice_id, model_id } → audio bytes. The proxy adds
//               the xi-api-key and forwards to ElevenLabs. Recommended for production. Pass
//               `headers` to authenticate to YOUR proxy (e.g. { 'X-API-Key': ... }) — they ride on
//               every proxy request (synth + voices), never on a direct ElevenLabs call.
//   • apiKey  — direct browser→ElevenLabs (dev/bench only: the key is visible in the page).
//
// Transport, two paths (both end in the same Blob, so playback can't tell them apart):
//   • WebSocket (fast path) — one persistent browser↔ElevenLabs multi-context socket, one context
//     per sentence. Measured from Budapest: ~195 ms to a full clip vs ~330 ms through an HTTP proxy
//     hop (every sentence pays TLS+proxy RTT over HTTP; the socket pays it once). Opt in with
//     `getWsToken: () => Promise<{ token }>` — a backend minter of ElevenLabs' `tts_websocket`
//     single-use token (sutkn_…, POST /v1/single-use-token/tts_websocket with the xi-api-key), the
//     same shape as the STT token flow. The key never reaches the page. Direct `apiKey` mode uses
//     the socket too (xi_api_key in the first frame).
//   • HTTP (fallback) — the proxy/direct POST above. Used when no WS auth is configured, when the
//     socket can't be opened/minted, and for ANY clip whose socket turn fails or stalls
//     (TUNING-free constant below): the clip falls back transparently and the socket is reopened
//     on the next sentence. Speed never costs reliability.
//
// Billing on the socket path: the backend can't meter a direct browser↔ElevenLabs socket, so the
// client reports what it synthesized — `usageUrl` gets POST { chars, voice_id, model_id } per clip
// (trust-but-verify, same stance as STT seconds). HTTP-proxy clips are metered by the proxy itself.
//
// Latency: eleven_flash_v2_5 is EL's low-latency model (~75ms model time); the rest of a clip's
// cost is network TTFB + transfer, which presynth (during the end-of-turn debounce) and the base
// class's ahead-of-playback synth queue hide for all but the first clip of a cold turn.
import { StreamingTTS } from './voice-agent.js';

const EL_API = 'https://api.elevenlabs.io/v1/text-to-speech';
const EL_WS = 'wss://api.elevenlabs.io/v1/text-to-speech';
// A socket turn that hasn't produced its final frame by then is abandoned for the HTTP path — a
// stalled socket must not cost more than one HTTP round-trip's worth of silence.
const WS_CLIP_TIMEOUT_MS = 2500;
// Server-side inactivity limit is 20 s by default, 180 s max: ask for the max and ping under it so
// a socket opened at session start is still warm when the user finally speaks.
const WS_INACTIVITY_S = 180;
const WS_PING_MS = 60_000;
// After a socket failure (open, auth, stall) HTTP serves every clip for this long before the
// socket is tried again — one failure must not turn into a reconnect per sentence.
const WS_BACKOFF_MS = 30_000;
// Token mint + handshake together; past this the clip (and warm()) gives up on the socket.
const WS_OPEN_TIMEOUT_MS = 4000;

export class ElevenLabsTTS extends StreamingTTS {
  constructor({ ttsUrl, apiKey, voiceId = 'JBFqnCBsd6RMkjVDRZzb' /* George */,
                modelId = 'eleven_flash_v2_5', format = 'mp3_44100_64', headers = {}, languageCode = '',
                getWsToken, usageUrl = '' } = {}) {
    super(voiceId);
    if (!ttsUrl && !apiKey) throw new Error('ElevenLabsTTS needs ttsUrl (backend proxy) or apiKey (direct, dev only)');
    this.ttsUrl = ttsUrl; this.apiKey = apiKey; this.modelId = modelId; this.format = format;
    // ISO 639-1 ('hu'). Without it Flash auto-detects per SENTENCE — short clips get misread as
    // English and spoken with English phonetics. Base code only; '' = let the model guess.
    this.languageCode = String(languageCode || '').split(/[-_]/)[0].toLowerCase();
    this.headers = headers;   // proxy-path auth (X-API-Key etc.) — never sent to ElevenLabs directly
    this.getWsToken = getWsToken; this.usageUrl = usageUrl;
    this._conn = null; this._opening = null; this._ctxN = 0; this._gen = 0; this._closed = false;
    this._wsDisabledUntil = 0;   // after a socket failure HTTP serves until then (see WS_BACKOFF_MS)
  }

  get _wsEnabled() { return !!(this.getWsToken || (this.apiKey && !this.ttsUrl)); }
  get _wsReady() { return this._wsEnabled && !this._closed && Date.now() >= this._wsDisabledUntil; }

  // Listing voices needs the key, so on the proxy path it has to come from YOUR backend: a GET on
  // the same ttsUrl returns [{ id, name }] (see examples/token-worker). Direct mode asks ElevenLabs
  // with the key it already has. Either way a failure is non-fatal — an empty list just means the
  // host keeps whatever voiceId it was constructed with, and synthesis is unaffected.
  async voices() {
    const [url, headers] = this.ttsUrl
      ? [this.ttsUrl, this.headers]
      : ['https://api.elevenlabs.io/v2/voices?page_size=100', { 'xi-api-key': this.apiKey }];
    try {
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
      if (!r.ok) return [];
      const body = await r.json();
      return (body.voices ?? []).map((v) => ({ id: v.voice_id ?? v.id, name: v.name }));
    } catch { return []; }
  }

  // The socket is bound to voice + model + language: changing the voice retires it (an in-flight
  // open too, via the generation bump) and the next sentence opens a fresh one.
  setVoice(voiceId) { if (voiceId !== this.voiceId) { this._gen++; this._retire(this._conn, false); } super.setVoice(voiceId); }

  // Pre-establish the connection (DNS + TLS + any proxy hop) so the first real clip only pays TTFB.
  // Socket path: open (and keep) the socket now. HTTP path: a HEAD is enough to open the socket;
  // failures are non-fatal.
  async warm() {
    if (this._wsEnabled) {
      if (!this._wsReady) return;
      // Open the socket AND run a throwaway clip through it: a fresh multi-stream socket's first
      // clip costs ~450 ms (model/voice warm-up per connection), every later one ~130 ms. Paying
      // that during the warm (user not yet speaking) keeps the first real sentence fast.
      await this._synthWs('Ok.', undefined, true).catch(() => {});
      return;
    }
    const url = this.ttsUrl ?? EL_API;
    try { await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(3000) }); } catch {}
  }

  async _synth(text, signal) {
    text = text?.trim();
    if (signal?.aborted || !text) return null;
    if (this._wsReady) {
      const blob = await this._synthWs(text, signal).catch((e) => { this.onEvent?.({ type: 'diag', diag: 'tts_ws_fallback', error: String(e?.message ?? e) }); return undefined; });
      if (blob !== undefined) return blob;   // null = aborted, Blob = done; undefined = fall back
      if (signal?.aborted || this._closed) return null;
    }
    return this._synthHttp(text, signal);
  }

  async _synthHttp(text, signal) {
    const direct = !this.ttsUrl;
    const url = direct ? `${EL_API}/${this.voiceId}?output_format=${this.format}` : this.ttsUrl;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(direct ? { 'xi-api-key': this.apiKey } : this.headers) },
      // The proxy form carries voice/model/format in the body so one backend route serves any voice.
      body: JSON.stringify({
        text, model_id: this.modelId,
        ...(this.languageCode ? { language_code: this.languageCode } : {}),
        ...(direct ? {} : { voice_id: this.voiceId, output_format: this.format }),
      }),
      signal,
    });
    if (!res.ok) throw new Error(`ElevenLabs TTS ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
    const blob = await res.blob();
    return signal?.aborted ? null : blob;
  }

  // ── WebSocket path ─────────────────────────────────────────────────────────────────────────
  // One multi-context socket; each sentence is its own context (text+flush, then close_context),
  // audio frames arrive base64 in JSON and are concatenated into one mp3 Blob on is_final. All
  // per-socket state (pending contexts, ping timer) lives on a `conn` record so a stale socket's
  // late close/error can only ever touch ITS OWN contexts, never a replacement's.
  async _synthWs(text, signal, isWarm = false) {
    const conn = await this._connect(signal);
    if (signal?.aborted) return null;
    const { ws } = conn;
    const id = `c${++this._ctxN}`;
    const chunks = [];
    const blob = await new Promise((resolve, reject) => {
      let settled = false;
      const settle = (fn, v) => { if (settled) return; settled = true; clearTimeout(timer); conn.pending.delete(id); signal?.removeEventListener('abort', onAbort); fn(v); };
      const timer = setTimeout(() => fail(new Error('ws clip timeout')), WS_CLIP_TIMEOUT_MS);
      // A failed clip retires the socket with backoff (HTTP serves meanwhile); an abort just drops
      // the context — the socket is healthy.
      const fail = (e) => { settle(reject, e); this._retire(conn, true); };
      const onAbort = () => { try { ws.send(JSON.stringify({ context_id: id, close_context: true })); } catch {} settle(resolve, null); };
      signal?.addEventListener('abort', onAbort, { once: true });
      conn.pending.set(id, {
        audio: (b64) => chunks.push(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))),
        // A final with no audio for real text is a provider failure, not an abort: fall back.
        final: () => chunks.length ? settle(resolve, new Blob(chunks, { type: 'audio/mpeg' })) : fail(new Error('ws clip empty')),
        error: fail,
      });
      try {
        ws.send(JSON.stringify({ context_id: id, text: text + ' ', flush: true }));
        ws.send(JSON.stringify({ context_id: id, close_context: true }));
      } catch (e) { fail(e); }
    });
    if (blob && this.usageUrl && !isWarm) this._reportUsage(text.length);
    return blob;
  }

  // The live connection, or a shared in-flight open. The whole open (token mint + handshake) is
  // bounded by WS_OPEN_TIMEOUT_MS; a caller's own abort releases just that caller.
  _connect(signal) {
    if (this._conn?.ws.readyState === 1) return Promise.resolve(this._conn);
    if (!this._opening) {
      this._opening = this._open().finally(() => { this._opening = null; });
      this._opening.catch(() => {});
    }
    if (!signal) return this._opening;
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(new Error('aborted'));
      signal.addEventListener('abort', onAbort, { once: true });
      this._opening.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
    });
  }

  async _open() {
    if (this._closed) throw new Error('closed');
    const gen = ++this._gen;
    const WS = globalThis.WebSocket;
    const conn = { ws: null, pending: new Map(), pingTimer: null, retired: false };
    let deadlineTimer;
    const deadline = new Promise((_, rej) => { deadlineTimer = setTimeout(() => rej(new Error('ws open timeout')), WS_OPEN_TIMEOUT_MS); });
    try {
      if (!WS) throw new Error('WebSocket unavailable');
      const q = new URLSearchParams({ model_id: this.modelId, output_format: this.format, inactivity_timeout: String(WS_INACTIVITY_S) });
      if (this.languageCode) q.set('language_code', this.languageCode);
      if (this.getWsToken) {
        const { token } = await Promise.race([this.getWsToken(), deadline]);
        if (!token) throw new Error('no tts ws token');
        q.set('single_use_token', token);
      }
      if (this._closed || gen !== this._gen) throw new Error('superseded');
      const ws = conn.ws = new WS(`${EL_WS}/${this.voiceId}/multi-stream-input?${q}`);
      await Promise.race([deadline, new Promise((resolve, reject) => {
        ws.onopen = resolve;
        ws.onerror = () => reject(new Error('ws open failed'));
        ws.onclose = (e) => reject(new Error(`ws closed ${e.code}`));
      })]);
      if (this._closed || gen !== this._gen) throw new Error('superseded');
      if (this.apiKey && !this.getWsToken) ws.send(JSON.stringify({ context_id: 'auth', text: ' ', xi_api_key: this.apiKey }));
    } catch (e) {
      // Every open failure (mint, handshake, timeout, closed meanwhile) backs off the socket path.
      this._retire(conn, true);
      throw e;
    } finally { clearTimeout(deadlineTimer); }
    const { ws } = conn;
    ws.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      const ctx = m.contextId ?? m.context_id;
      const p = conn.pending.get(ctx);
      if (m.error) {
        this.onEvent?.({ type: 'diag', diag: 'tts_ws_error', error: m.message ?? m.error });
        // Context-scoped error → that clip only (an already-aborted context's error is noise);
        // connection-scoped (no context) → every pending clip, and the socket is retired.
        if (ctx) p?.error(new Error(m.message ?? m.error)); else this._retire(conn, true, new Error(m.message ?? m.error));
        return;
      }
      if (!p) return;
      if (m.audio) p.audio(m.audio);
      if (m.isFinal || m.is_final) p.final();
    };
    ws.onclose = () => this._retire(conn, true, new Error('ws closed'));
    ws.onerror = () => {};
    // keep_context_alive resets the server's inactivity timer without synthesizing anything.
    conn.pingTimer = setInterval(() => { try { ws.send(JSON.stringify({ context_id: 'ka', keep_context_alive: true })); } catch {} }, WS_PING_MS);
    conn.pingTimer.unref?.();   // never keeps a Node process alive (tests, SSR)
    this._conn = conn;
    return conn;
  }

  // The one teardown path. `failed` = back off (HTTP serves WS_BACKOFF_MS); intentional closes
  // (setVoice, close()) don't. Pending contexts of THIS conn are failed with `err`, which sends
  // them to the HTTP fallback via _synth's catch. Idempotent; a stale conn can't touch a newer one.
  _retire(conn, failed, err = new Error('ws retired')) {
    if (!conn || conn.retired) return;
    conn.retired = true;
    clearInterval(conn.pingTimer);
    if (this._conn === conn) this._conn = null;
    if (failed) this._wsDisabledUntil = Date.now() + WS_BACKOFF_MS;
    const { ws } = conn;
    if (ws && ws.readyState <= 1) { try { ws.send(JSON.stringify({ close_socket: true })); } catch {} try { ws.close(); } catch {} }
    for (const p of [...conn.pending.values()]) p.error(err);
  }

  _reportUsage(chars) {
    fetch(this.usageUrl, {
      method: 'POST', keepalive: true,
      headers: { 'Content-Type': 'application/json', ...this.headers },
      body: JSON.stringify({ chars, voice_id: this.voiceId, model_id: this.modelId }),
    }).catch(() => {});
  }

  // Release the socket; the host calls this when the agent is destroyed (VoiceAgent.destroy →
  // tts.close?.()). An in-flight open is superseded by the generation bump and retires itself.
  close() { this._closed = true; this._gen++; this._retire(this._conn, false); }
}
