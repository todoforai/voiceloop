// voice-agent.js — VAD → STT → LLM → TTS, interruptible. One small module.
//
//   const agent = new VoiceAgent({ llm, tts });
//   agent.start();
//
// The whole loop is `_onUserTurn` below:
//   text = vad+stt  →  history.push(user:text)  →  llm STREAMS the answer
//   →  tts.speak(stream)   (barge-in — on transcribed words, not VAD energy — stops tts + aborts llm,
//                            and records what was heard so the UI can show where TTS got)
//
// First-sentence latency: `tts.speak` takes an async iterator of text deltas. It synthesizes
// the FIRST sentence as soon as its boundary arrives and starts playing, then streams the rest
// sentence-by-sentence — synthesizing ONE sentence ahead while the current plays, so there's no
// growing gap on long answers, and never two clips at once (see StreamingTTS.speak).
//
// `llm`, `tts` and `stt` are pluggable; knobs (maxTokens, vadOptions, …) are constructor options.
// Defaults: stt → browser Web Speech (free, no key), tts → Piper (free local WASM),
// llm → makeOpenAILLM (any OpenAI-compatible /chat/completions endpoint).

import { STT_PROVIDERS, resolveSttProvider } from './stt.js';
import { TUNING } from './tuning.js';
import { makeOpenAILLM } from './llm-openai.js';

// Default persona: a minimal voice-first system prompt. Hosts replace it via `persona`
// (who the agent is) and append live context via `sysmsg` / setSysmsg().
export const VOICE_SYSMSG =
  'You are a helpful voice assistant. Your words are read aloud by TTS and the user\'s words arrive ' +
  'via STT — expect mis-hearings and interpret them charitably. Reply in one or two short sentences: ' +
  'plain words for the ear, no lists, no markdown, no emojis. Lead with the answer; skip preamble. ' +
  'When a tool fits the request, call it right away instead of describing what you would do.';

const CDN = 'https://cdn.jsdelivr.net/npm/';

// AudioWorklet processor: accumulate the audio-thread's 128-sample render quanta into ~256ms chunks
// (4096 samples @16kHz — the cadence the pipeline's bootstrap-VAD/preroll math assumes) and post each
// to the main thread. Kept as a source string → Blob URL so no separate asset/bundler config is needed.
const CAPTURE_WORKLET_SRC = `
registerProcessor('capture-processor', class extends AudioWorkletProcessor {
  constructor() { super(); this._buf = new Float32Array(4096); this._n = 0; }
  process(inputs) {
    const ch = inputs[0]?.[0];
    if (ch) for (let i = 0; i < ch.length; i++) {
      this._buf[this._n++] = ch[i];
      if (this._n === this._buf.length) { this.port.postMessage(this._buf.slice()); this._n = 0; }
    }
    return true;
  }
});`;
const CAPTURE_WORKLET_URL = typeof URL !== 'undefined' && URL.createObjectURL
  ? URL.createObjectURL(new Blob([CAPTURE_WORKLET_SRC], { type: 'text/javascript' }))
  : '';

// Compose the full system prompt: a persona (base voice persona by default, or a host-supplied one)
// + the host's conversation context (if any).
// The LLM otherwise guesses reply language from the (often short/garbled) transcript and drifts to
// English under the English persona — so state the selected STT language explicitly.
const LANG_NAMES = { en: 'English', hu: 'Hungarian', de: 'German', fr: 'French', es: 'Spanish', it: 'Italian', pt: 'Portuguese', nl: 'Dutch', pl: 'Polish', ja: 'Japanese', ko: 'Korean', zh: 'Chinese' };
const langRule = (lang) => {
  const name = LANG_NAMES[String(lang || '').split(/[-_]/)[0].toLowerCase()];
  return name ? `ALWAYS reply in ${name} — including tool-call acknowledgements.` : '';
};
// A tool call's arguments, key-sorted — so the SAME act always renders/compares identically no matter
// what order a provider streamed the keys in (used both for dedup and for the [TOOL CALL] ledger).
// Identity: the provider call id when present (two calls with identical args are DISTINCT acts,
// e.g. a legit retry after an error result); name+args otherwise (an id-less identical repeat is a
// provider re-emitting its buffered call).
const callArgs = (c) => JSON.stringify(c.args ?? {}, Object.keys(c.args ?? {}).sort());
const callKey = (c) => c.id ? `id:${c.id}` : `${c.tool} ${callArgs(c)}`;
// Render a host tool's return value as model-facing text (used in the history ledger, and by LLM
// adapters when feeding tool results back to the model). Never throws: the side effect already RAN,
// so an unserializable result must not retro-fail the call and invite a retry.
export const toolResultText = (result) => {
  if (result === undefined) return 'ok';
  if (typeof result === 'string') return result;
  if (result && typeof result.text === 'string' && typeof result.ok === 'boolean')
    return result.ok ? result.text : `[failed] ${result.text}`;
  try { return JSON.stringify(result) ?? 'ok'; } catch { return String(result); }
};
// Ledger suffix for a call whose outcome is attached to the chunk: keeps the RESULT in the
// plain-text history so the NEXT turn still knows what the tool said. Bounded — history is
// spoken-conversation-sized, not a log. Calls without an outcome field contribute nothing.
const LEDGER_RESULT_MAX = 4000;
const ledgerOutcome = (c) => {
  if (c.error) return ` → error: ${String(c.error).slice(0, LEDGER_RESULT_MAX)}`;
  if (!('result' in c)) return '';
  let text = toolResultText(c.result);
  if (text.length > LEDGER_RESULT_MAX) text = `${text.slice(0, LEDGER_RESULT_MAX)}… (${text.length} chars)`;
  return ` → ${text}`;
};

// ── [TOOL CALL] mimicry filter ──────────────────────────────────────────────────────────────────
// The model sees `[TOOL CALL name] {...}` ledger lines in its own history turns, and sometimes
// IMITATES the format instead of calling the tool natively: it types the line as reply text.
// Untreated, the raw markup leaks into the spoken/visible reply and the tool never runs. This
// transform strips such lines from the text stream: a bare call (no → outcome) is what the model
// MEANT to do → re-emitted as a real { tool, args } chunk (the turn's dedup collapses it if the
// native call also arrived); a line WITH an → outcome is a hallucinated memory of a past call →
// dropped. Text before/after the line streams through untouched, held back only while a possible
// marker/line is still forming so TTS latency is unaffected on normal replies.
const MIMIC_MARK = '[TOOL CALL ';
const parseMimicLine = (line) => {
  const m = /^\[TOOL CALL ([\w.-]+)\]\s*(.*)$/.exec(line.trim());
  if (!m) return null;                                   // not the format after all — caller emits it as text
  const [, tool, rest] = m;
  if (!rest) return { tool, args: {} };
  if (!rest.startsWith('{')) return { drop: true };      // `→ outcome` (or junk) with no args — a remembered call
  // Balanced-brace scan (string-aware): the args JSON may be followed by a ` → outcome` tail.
  let depth = 0, inStr = false, escaped = false, end = -1;
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i];
    if (escaped) { escaped = false; continue; }
    if (inStr) { if (ch === '\\') escaped = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) { end = i + 1; break; }
  }
  if (end < 0) return { drop: true };                    // truncated JSON — can't run it faithfully
  if (rest.slice(end).trim()) return { drop: true };     // has an → outcome: a memory, not a new call
  try { return { tool, args: JSON.parse(rest.slice(0, end)) }; } catch { return { drop: true }; }
};
async function* stripToolCallMimicry(src) {
  let carry = '';
  // Longest tail of `carry` that could still grow into the marker — held back; the rest is safe to emit.
  const heldLen = () => {
    for (let n = Math.min(carry.length, MIMIC_MARK.length - 1); n > 0; n--)
      if (MIMIC_MARK.startsWith(carry.slice(-n))) return n;
    return 0;
  };
  function* pump(final) {
    for (;;) {
      const at = carry.indexOf(MIMIC_MARK);
      if (at < 0) {
        const hold = final ? 0 : heldLen();
        const out = carry.slice(0, carry.length - hold);
        carry = carry.slice(carry.length - hold);
        if (out) yield { text: out };
        return;
      }
      const nl = carry.indexOf('\n', at);
      if (nl < 0 && !final) {                            // the line is still streaming — hold from the marker on
        if (at > 0) { yield { text: carry.slice(0, at) }; carry = carry.slice(at); }
        return;
      }
      const end = nl < 0 ? carry.length : nl;
      const before = carry.slice(0, at), line = carry.slice(at, end);
      carry = nl < 0 ? '' : carry.slice(nl + 1);         // the line (and its newline) leave the text stream
      if (before) yield { text: before };
      const parsed = parseMimicLine(line);
      if (!parsed) yield { text: nl < 0 ? line : `${line}\n` };   // false alarm — pass it through untouched (newline included)
      else if (parsed.tool) yield { tool: parsed.tool, args: parsed.args };
    }
  }
  for await (const item of src) {
    if (item.tool) { yield item; continue; }
    carry += item.text ?? '';
    yield* pump(false);
  }
  yield* pump(true);
}

// Persona (who the agent is) + language rule + the host's live context block (`sysmsg`, delimited
// so the model never mistakes injected context for its own conversation).
const composeSysmsg = (sysmsg, persona = VOICE_SYSMSG, lang = '') => {
  const base = [persona, langRule(lang)].filter(Boolean).join('\n\n');
  return sysmsg
    ? `${base}\n\n=== CONTEXT (not your conversation) ===\n${sysmsg}\n=== END CONTEXT ===`
    : base;
};

// Asset paths for the Silero VAD — MUST match the ones `_startVad` passes to MicVAD.new() so the
// pre-warm fetches/compiles the SAME artifacts the real session then reuses (HTTP-cached model +
// already-compiled ONNX-WASM runtime).
const VAD_ASSET_PATH = `${CDN}@ricky0123/vad-web@0.0.29/dist/`;
const VAD_WASM_PATH = `${CDN}onnxruntime-web@1.22.0/dist/`;

// Pre-build the Silero v5 ONNX session WITHOUT opening the mic, so the costly parts of the cold start
// — compiling the onnxruntime-web WASM (ort.env.wasm.wasmPaths) and fetching/instantiating the v5
// model — happen while the panel sits idle, NOT after the user clicks. We run the SAME MicVAD.new()
// the real session uses, but with `startOnLoad: false` so it never calls getStream (no getUserMedia,
// no mic indicator) — it only loads the model + builds the FrameProcessor. The real MicVAD.new() in
// _startVad() then reuses the HTTP-cached v5 model and the already-compiled WASM runtime, so it
// reaches 'listening' far sooner. NonRealTimeVAD is NOT used here: it ignores `model`/`onnxWASMBasePath`
// and always loads the LEGACY model, so it would warm the wrong session. Needs `window.vad` (the
// vad-web UMD bundle) already loaded; call AFTER the deps are injected. Memoized + best-effort: a
// failure just means start() pays the normal cold cost.
let warmVadPromise = null;
export function warmVad() {
  return (warmVadPromise ??= (async () => {
    const d = window.vad;
    if (!d?.MicVAD) return;
    await d.MicVAD.new({ model: 'v5', startOnLoad: false, onnxWASMBasePath: VAD_WASM_PATH, baseAssetPath: VAD_ASSET_PATH });
  })().catch((e) => { warmVadPromise = null; throw e; }));   // drop the memo on failure so a later start() can retry
}

export class VoiceAgent {
  // Core options:
  //   `llm` — async generator (history, system, signal) → { text } | { tool, args } chunks. Bring
  //     your own, or omit it and pass `llmUrl` (+ `apiKey`, `model`) to talk to any OpenAI-compatible
  //     /chat/completions endpoint via the built-in makeOpenAILLM (see llm-openai.js). NEVER put a
  //     provider secret key in a public page — point llmUrl at your own proxy route in production.
  //   `tts` — a StreamingTTS subclass; default PiperTTS (free, local WASM).
  //   `sttProvider` — 'webspeech' (default; free, browser-native) | 'elevenlabs' | 'speechmatics' |
  //     'deepgram'. Cloud providers authenticate via a short-TTL token minted by YOUR backend
  //     (`sttTokenUrl`) so the raw key stays server-side. Providers may set `continuous`/`nativeEOT`
  //     flags the agent adapts to. 'webspeech' downgrades to `webspeechFallback` where the browser
  //     has no SpeechRecognition — `agent.sttProvider` is the one actually running.
  //   `sysmsg` — live host context appended to the persona (updatable via setSysmsg()).
  //   `persona` — who the agent is (replaces the default VOICE_SYSMSG persona).
  //   `tools`: { name: { description, params, run(args) } } — exposed to the LLM; `params` is the
  //     JSON-schema `properties` for the arguments. Calls fire during streaming, in parallel with TTS.
  //   `sttLang` — STT language code ('en'); also pins the reply language.
  //   `keyterms` — domain words to bias STT towards (cloud providers; max 50, ≤20 chars each).
  //   `sttUrl`/`sttModel`/`sttTokenUrl`/`sttUsageUrl`/`sttEotThreshold` — STT provider knobs (stt.js).
  //   `maxTokens`, `preroll` (chunks kept before VAD fires), `vadOptions` (Silero overrides).
  //   `turnDetector(text)` — async/sync predicate run when VAD hears end-of-speech: return false to
  //     KEEP listening (the user only paused mid-thought), true (default) to close the turn.
  //   `maxPauseMs` — hard cap (default 4000) a turnDetector may hold a turn open before force-commit.
  //   `bargeInMinChars` — min transcribed NOVEL chars heard while speaking to count as a real
  //     barge-in; higher ignores short backchannels ("mhm","yeah"). Defaults live in tuning.js.
  //   `onEvent(e)` — the event tap: { type: 'state'|'stt'|'assistant'|'tool'|'vad'|'echo'|'error'|'diag', … }.
  constructor({ sysmsg = '', persona, model = '', llm, fetchFn, apiKey = '', llmUrl = '', maxTokens = TUNING.MAX_TOKENS,
                tts, speed, sttLang = 'en', micDeviceId = '', sttProvider = 'webspeech', sttEotThreshold,
                sttTokenUrl = '', getSttToken, sttUsageUrl = '', sttUrl = '', sttModel = '',
                tools = {}, keyterms = [], preroll = TUNING.PREROLL_CHUNKS, vadOptions = {}, turnDetector = null,
                maxPauseMs = TUNING.MAX_PAUSE_MS, bargeInMinChars, onEvent = () => {} } = {}) {
    // Each agent gets its own PiperTTS (it owns an AudioContext + playing node) — a shared
    // module-level default would make two agents fight over one audio output. `speed` scales
    // playback rate (1.2 → 20% faster) on the default TTS; ignored if a custom `tts` is passed.
    this.sysmsg = composeSysmsg(sysmsg, persona, sttLang);   // persona (base or host-supplied) + language rule + host context
    this._persona = persona;   // remembered so setSysmsg() re-composes with the same persona
    this.tts = tts ?? new PiperTTS(undefined, speed); this.sttLang = sttLang; this.onEvent = onEvent;
    this.tts.onEvent = onEvent;   // diagnostics channel (e.g. aec-fallback warning from StreamingTTS._playBuf)
    this.apiKey = apiKey;
    this.micDeviceId = micDeviceId; this.prerollMax = preroll; this.vadOptions = vadOptions;
    this.turnDetector = turnDetector; this._turnText = ''; this._turnClosing = false; this.maxPauseMs = maxPauseMs; this._bargeInMinChars = bargeInMinChars; this._maxPause = null;   // _bargeInMinChars undefined → live-read tuning.js (see getter)   // semantic end-of-turn hook + latest interim it judges + closing latch + hard max-pause failsafe
    this._prefetch = null; this._prefetchTimer = null;   // speculative LLM prefetch (see _startPrefetch)
    // STT is a pluggable provider (like tts/llm). The agent owns the mic+VAD and forwards
    // feed/commit/close; the provider opens its own socket and reports transcripts via callbacks.
    // 'webspeech' downgrades to a cloud provider where the browser has no SpeechRecognition (Firefox,
    // the Linux WebKitGTK desktop shell) — otherwise voice mode could only fatal there. The model id
    // belongs to the CHOSEN provider, so a downgrade drops it back to the fallback's own default.
    this.sttProvider = resolveSttProvider(sttProvider);
    const makeStt = STT_PROVIDERS[this.sttProvider] ?? STT_PROVIDERS.webspeech;
    this.stt = makeStt({
      apiKey, sttUrl, sttModel: this.sttProvider === sttProvider ? sttModel : '', sttLang, micDeviceId, keyterms: keyterms.filter(k => k && k.length <= 20).slice(0, 50),
      sttTokenUrl, getToken: getSttToken, sttUsageUrl, eotThreshold: sttEotThreshold,
      onPartial: (text, ms, committed = '') => {
        const interim = `${committed} ${text}`.trim();
        this._turnText = interim;   // latest interim (committed prefix + live tail) for the turn detector
        this.onEvent({ type: 'stt', turnComplete: false, text, ms, committed });
        // BARGE-IN ON WORDS, not VAD energy: while we're speaking, the user is only "interrupting"
        // once STT actually transcribes words (not a cough or keyboard noise — those produce VAD
        // activity but no text). Full-duplex: the uplink STT keeps transcribing throughout the
        // reply, so this fires the instant words land instead of waiting for a turn boundary.
        // SELF-ECHO GUARD: on speakers the browser's AEC often fails to cancel our own Web-Audio
        // TTS playout, so the STT transcribes the agent's own voice — real words that would pass the
        // char threshold and make it interrupt ITSELF. We track the AUDIBLE prefix of the reply
        // (_replyText, fed by the TTS progress hook — not the generated-ahead answer): a live tail
        // whose recent words are mostly words of that prefix is echo → latch _echoRef (the prefix
        // it echoed, so its final is judged against the right reply) and don't barge in. Notes:
        //   • classified on the LIVE tail only — a committed real-user prefix must not tip a mixed
        //     turn into "echo", and a fresh real tail after echoed words clears the latch (cuts in);
        //   • an EMPTY tail neither reclassifies nor clears — providers emit empty-tail callbacks
        //     when words lock into `committed` (same words, just moved), which must not turn a
        //     latched echo into a barge-in;
        //   • latching runs while speaking AND for a short grace after playback ends (_replyDoneAt):
        //     STT latency means echo can land just after the reply finished (while 'listening'),
        //     and it must still be latched or its final becomes a user turn the agent then answers.
        //     Bounded so the user quoting the reply a while later can never be judged echo.
        const inEchoWindow = this.state === 'speaking' || Date.now() - this._replyDoneAt < ECHO_GRACE_MS;
        if (text.trim() && inEchoWindow) this._echoRef = isSelfEcho(text, this._replyText) ? this._replyText : '';
        // Barge-in on NOVEL characters only (not raw interim length): words fuzzily attributable to
        // the audible reply count as echo (misheard echo words land NEAR the reply's words — see
        // fuzzyHas) and contribute nothing, so echo that slipped past the ratio latch above still
        // can't cut the reply; real interruptions are novel words and fire exactly as before.
        if (this.state === 'speaking' && !this._echoRef && novelChars(interim, this._replyText) >= this.bargeInMinChars) this._onBargeIn();
        // SPECULATIVE PREFETCH: the turn's end-of-turn debounce is dead time — the LLM request only
        // fires after it elapses, so its TTFT lands ON TOP. Instead, once the interim has been
        // stable for PREFETCH_MS (no new words), start generating NOW with the probable final text;
        // if the turn closes with that exact text the reply streams instantly (see _takePrefetch),
        // if the user kept talking the stale request is aborted (cost: a few prompt tokens).
        clearTimeout(this._prefetchTimer); this._prefetchTimer = null;
        if (this._prefetch && interim && this._prefetch.text !== interim) this._dropPrefetch();   // transcript moved on → the running speculation is stale, stop paying for it
        if (interim && this.state === 'listening' && !this._held && !this._echoRef)
          this._prefetchTimer = setTimeout(() => this._startPrefetch(interim), TUNING.PREFETCH_MS ?? 200);
      },
      onFinal:   (text, ms) => {
        clearTimeout(this._prefetchTimer); this._prefetchTimer = null;   // the turn is closing — no new speculation may start behind it
        this._turnText = ''; this._turnClosing = false;   // turn fully finalized: clear interim + the closing latch
        // Take + clear the echo latch UNCONDITIONALLY (even for the empty finals below) — a
        // leftover latch must never leak into the next STT turn and swallow a real utterance.
        const echoRef = this._echoRef;
        this._echoRef = '';
        // Empty finalization (the STT closed the turn but transcribed nothing — e.g. only the AI's
        // own echo or noise was force-ended): it still clears the closing latch above (so we never
        // wedge waiting on a non-empty onFinal), but it's not a user turn — don't emit/reply.
        if (!text.trim()) { this._dropPrefetch(); return; }   // empty close (noise/echo force-end) — the speculation has no turn to serve
        // A turn latched as self-echo (see onPartial): drop it ONLY if the WHOLE final is a strong
        // match (all words, ≥3 hits) against the reply it echoed — a mixed turn (real user words +
        // echo tail) or a short quote of the reply is kept as a user turn. Surfaced as an 'echo'
        // event for diagnostics.
        if (echoRef && isSelfEcho(text, echoRef, { window: Infinity, minHits: 3 })) {
          this._dropPrefetch();   // the speculation was fed by our own echo — never answer it
          this.onEvent({ type: 'echo', text }); return;
        }
        this.onEvent({ type: 'stt', turnComplete: true, text, ms });
        // Held: stack the utterance into history but DON'T reply — _flush() runs them all on release.
        // Wait on the hold barrier first so the turn aborted on hold-entry records its assistant text
        // BEFORE these user turns, keeping history ordered (…, assistant-so-far, user, user, …).
        if (this._held) { this._pushHeld(text); return; }   // prefetch already dropped by setHeld(true)
        this._onUserTurn(text, { speech: true });   // only a SPOKEN final may adopt the prefetch it seeded
      },
      onError:   (error) => this.onEvent({ type: 'error', error }),
      onFatal:   (error) => { this.stop(); this.onEvent({ type: 'error', error }); },   // auth/config — won't self-heal; stop FIRST so the error event sees `closed` (host reconciles `running`)
      onClose:   () => {},
      isClosed:  () => this._closed,
    });
    // A tool with no runnable `run` is DROPPED, never advertised: the LLM would call it, nothing
    // would happen, and the transcript would still show it as "ran" — a silent lie.
    this.tools = {};
    for (const [name, t] of Object.entries(tools)) {
      if (typeof t.run === 'function') this.tools[name] = t;
      else console.warn(`VoiceAgent: tool "${name}" has no run() — dropped`);
    }
    // Default LLM: any OpenAI-compatible /chat/completions endpoint (llm-openai.js). A custom `llm`
    // generator replaces it entirely.
    this.llm = llm || makeOpenAILLM({ llmUrl, apiKey, model, maxTokens, tools: this.tools, fetchFn });
    this.history = [];
    this.state = 'idle';           // idle | listening | thinking | speaking
    this._abort = null;            // aborts the in-flight LLM
    this._replySeq = 0;            // bumped per reply-generating turn; a queued turn drops itself if a newer one exists
    this._preroll = []; this._wasSpeaking = false; this._closed = false; this._destroyed = false;
    // Diagnostic tap: last ~30s of the exact i16 frames handed to STT + delivery-stall gaps, for
    // dumpAudio() (replay any "it misheard me" run and prove capture clean-or-not).
    this._tap = []; this._tapSamples = 0; this._tapTotal = 0; this._tapLastMs = 0; this._tapGaps = [];
    this._stream = null; this._ctx = null; this._node = null; this._vad = null; this._streamDeviceId = undefined;   // pipeline kept warm across stop()/start() for instant resume
    this._muted = false;           // mic disabled → browser feeds silence to VAD+STT (nothing reaches the agent)
    this._ttsMuted = false;        // AI voice OUTPUT off → skip speaking, still stream the reply as text
    this._held = false;            // HOLD: keep transcribing into history, but don't run the LLM until released
    this._replyText = '';          // AUDIBLE prefix of the reply being (or last) voiced — the self-echo reference (see onPartial)
    this._echoRef = '';            // echo latch: the _replyText the current STT turn was judged an echo OF ('' = not echo)
    this._replyDoneAt = 0;         // when playback last ended — bounds the post-playout echo grace window
    this._holdBarrier = null;      // resolves once the turn aborted on hold-entry has finalized; held STT orders after it
    this._heldPushes = new Set();  // in-flight held-utterance append promises; release waits for all before flushing
    // Bootstrap VAD (see _bootstrapVadTick): a zero-load RMS-energy gate that stands in for Silero
    // (this._vad, which needs a CDN fetch + WASM compile + model load) while it's still cold-starting
    // — so the mic is gated (and speech detected) from frame 1 instead of losing/chopping the user's
    // opening words in the size-capped preroll buffer. Swapped to Silero at the next utterance
    // boundary once it's ready (never mid-speech — see _endOfSpeech / onSpeechStart).
    this._useBootstrap = false; this._sileroPending = false; this._bsSpeechFrames = 0; this._bsSilenceFrames = 0;
    // Bumped on every cold start()/_teardownPipeline() — guards the fire-and-forget _startVad() below:
    // a rapid re-click or device switch during the cold-load window can call start() again before the
    // FIRST _startVad() resolves; its late resolution must not stomp the SECOND session's _vad/bootstrap
    // state, so the continuation checks the generation is still current before touching either.
    this._pipelineGen = 0;
  }

  // `deviceId` pins the mic to listen on — enumerate inputs host-side via
  // navigator.mediaDevices.enumerateDevices() and pass the chosen audioinput's deviceId; omit
  // for the browser default. Start-time choice — switching means stop() + start(id).
  async start(deviceId = this.micDeviceId) {
    this._closed = false;
    // A self-capturing STT (browser Web Speech API) OWNS the whole audio path: its own mic + its own
    // end-of-turn. It needs NO agent pipeline — no getUserMedia, AudioWorklet, preroll or Silero VAD.
    // Just open it (synchronously, inside the click gesture Safari requires for SpeechRecognition.start)
    // and flip to listening. Barge-in still works (word-based, via the provider's onPartial). Mute is
    // handled by setMuted() → stt.setEnabled(). No warm-resume machinery: open() is idempotent + cheap.
    // open() can fail synchronously (Web Speech unsupported → onFatal → stop() sets _closed + idle).
    // Guard the listening flip so a fatal isn't overwritten with a fake 'listening' state.
    if (this.stt.selfCapture) { this.stt.open?.(); if (!this._closed) this._set('listening'); return; }
    // WARM RESUME: stop() pauses (not tears down) the pipeline, so a resume of the SAME agent finds the
    // mic stream + audio graph + VAD model still alive — just re-arm them. This skips the getUserMedia
    // permission round-trip AND the MicVAD.new() Silero/ONNX cold start (the bulk of "open→listening"
    // latency), so reopening a paused voice session feels instant. A device switch (different deviceId)
    // can't reuse the captured stream, so fall through to a fresh build. The VAD's getStream callback
    // captured this._stream at MicVAD.new() time, so we MUST keep the same stream to reuse the model.
    if (this._vad && this._stream?.active && deviceId === this._streamDeviceId) {
      this._ctx?.resume?.();                                                  // a paused-tab AudioContext can be suspended
      this._stream.getAudioTracks().forEach(t => t.enabled = !this._muted);   // honor a mute toggled while paused
      // stop() is always a safe boundary (nothing is mid-utterance once stopped) — so if Silero
      // finished loading while paused, resume goes straight to it instead of restarting bootstrap.
      if (this._useBootstrap) { this._useBootstrap = false; this._bsSpeechFrames = 0; this._bsSilenceFrames = 0; }
      this._vad.start();
      this.stt.open?.();   // re-open the STT socket (stop() closed it) so the first utterance doesn't pay a cold connect
      this.tts.warm?.().catch(() => {});
      this._set('listening');
      return;
    }
    // Cold build: a different mic (or first start / post-destroy) — drop any half-built warm pipeline first.
    this._teardownPipeline();
    const gen = ++this._pipelineGen;
    this._streamDeviceId = deviceId;
    // Flip to 'listening' NOW, then open the mic in the background: getUserMedia (mic permission +
    // device open, esp. with the DSP chain below) is the dominant click→listening latency, and it's
    // the only real blocker here. Once the mic actually opens, the bootstrap energy-VAD + preroll ring
    // buffer protect the opening words (audio spoken during the brief permission/device-open window
    // before the graph is wired can't be captured — an accepted tradeoff for an instant-feeling UI).
    // gen (+ _closed) guard the async build: a rapid re-click / device switch bumps _pipelineGen and a
    // stop/destroy sets _closed, so a slow getUserMedia that resolves into a superseded/stopped session
    // tears its own stream down instead of wiring a stale mic into a dead pipeline.
    this._set('listening');
    (async () => {
      let stream;
      try {
        // Dictation-tuned: drop autoGainControl — AGC pumps between words, corrupting what the
        // recognizer sees. Keep echoCancellation (needed for barge-in while TTS is audible) AND
        // noiseSuppression: without NS speaker playout leaks into the mic much stronger, so the STT
        // transcribes the agent's own reply (self-echo) — worse than NS occasionally gating quiet speech.
        const audio = { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: false, ...(deviceId ? { deviceId: { exact: deviceId } } : {}) };
        try {
          stream = await navigator.mediaDevices.getUserMedia({ audio });
        } catch (e) {
          // The saved mic id no longer exists on this machine (unplugged / different device / stale
          // cross-profile localStorage) — `exact` throws OverconstrainedError instead of falling back.
          // Retry once on the system default so a stale preference doesn't brick the whole session.
          if (deviceId && e.name === 'OverconstrainedError') stream = await navigator.mediaDevices.getUserMedia({ audio: { ...audio, deviceId: undefined } });
          else throw e;
        }
      } catch (e) {
        // Mic open failed (permission denied / no device / constraints). We already optimistically
        // flipped to 'listening', so self-stop like a fatal STT error does — stop() sets _closed + goes
        // idle — so the host reconciles `running` against a.closed and the next press restarts cleanly
        // (instead of a fake "listening" session with no mic). Guard on gen: a superseding start already
        // owns the pipeline, so don't stop it out from under it.
        if (gen === this._pipelineGen) { this.stop(); this.onEvent({ type: 'error', error: e.message || e.name || 'Microphone access failed' }); }
        return;
      }
      // Superseded (re-click / device switch bumps gen) OR stopped/destroyed while opening (stop() sets
      // _closed but keeps gen — it means to pause a mic that isn't wired yet) → drop the stream, don't
      // wire a live mic into a dead session (would leave the OS mic indicator on).
      if (gen !== this._pipelineGen || this._closed) { stream.getTracks().forEach(t => t.stop()); return; }
      this._stream = stream;
      this._stream.getAudioTracks().forEach(t => t.enabled = !this._muted);   // honor a mute toggled while paused
      // Capture on an AudioWorklet, NOT a ScriptProcessor: ScriptProcessor's onaudioprocess runs on
      // the MAIN thread, so any stall (React renders, ONNX inference, Piper download/compile, SSE
      // parsing) silently DROPS buffers — the recognizer then sees spliced audio and drops the missing
      // span + loops on a token ("eleven eleven eleven"). The worklet captures on the audio rendering
      // thread, so a busy UI can never drop capture; ~256ms chunks match the old cadence.
      // Build on LOCALS and publish to this._ctx/_node only at the end: a supersede/stop during the
      // awaited addModule() may have torn down (and a new session rebuilt) the instance fields — a
      // stale continuation must clean up its own objects only.
      let ctx;
      try {
        ctx = new AudioContext({ sampleRate: 16000 });
        const src = ctx.createMediaStreamSource(stream);
        await ctx.audioWorklet.addModule(CAPTURE_WORKLET_URL);
        if (gen !== this._pipelineGen || this._closed) { stream.getTracks().forEach(t => t.stop()); ctx.close(); return; }   // superseded/stopped while loading
        const node = new AudioWorkletNode(ctx, 'capture-processor');
        node.port.onmessage = e => this._feed(e.data);   // Float32Array chunk from the audio thread
        // The processor writes no output — this connection only keeps the node pulled by the graph.
        src.connect(node); node.connect(ctx.destination);
        this._ctx = ctx; this._node = node;
      } catch (e) {
        // Graph build failed (worklet unsupported, CSP-blocked blob:, 16kHz context refused): self-stop
        // like a mic-open failure — never leave a fake 'listening' session holding an open mic.
        stream.getTracks().forEach(t => t.stop()); ctx?.close();
        if (gen === this._pipelineGen) { this.stop(); this.onEvent({ type: 'error', error: `audio capture: ${e.message}` }); }
        return;
      }
      // Pre-open the STT socket NOW (token fetch + WS handshake) so it overlaps the MicVAD cold start
      // below — then the FIRST utterance streams immediately instead of paying a cold connect mid-speech.
      this.stt.open?.();
      // Gate on the bootstrap energy-VAD from THIS frame — mic audio can arrive (worklet port above)
      // well before Silero (_startVad, awaited below) resolves, and without a gate that audio would
      // only be protected by the small preroll ring buffer (silently drops the opening words on a slow
      // cold start). _startVad() runs in the background (not awaited) and swaps in Silero the moment
      // it's ready — see _swapToSileroWhenReady.
      this._useBootstrap = true; this._sileroPending = true;
      this._startVad(gen).then(() => { if (gen === this._pipelineGen && !this._closed) this._swapToSileroWhenReady(); })
        .catch(() => { if (gen === this._pipelineGen) this._sileroPending = false; });
      // Warm the TTS engine (Piper: download+compile the ONNX voice model, JIT the WASM path) so the
      // first reply isn't stalled by cold start mid-turn — but DEFERRED off the STT connect window:
      // Piper's ~60MB HuggingFace download saturates bandwidth and was measured stretching the
      // Deepgram WS handshake from ~0.5s to ~3s when fired concurrently. TTS isn't needed until the
      // first REPLY (user utterance + LLM roundtrip away), so a short delay costs nothing.
      setTimeout(() => { if (gen === this._pipelineGen && !this._closed) this.tts.warm?.().catch(() => {}); }, 2500);
    })();
  }

  // True once the pipeline has been torn down (stop() / a fatal STT error). The host reconciles its
  // own "running" flag against this after an error so a self-stopped agent isn't treated as live.
  get closed() { return this._closed; }

  stop() {
    this._closed = true; this._abort?.abort(); this.tts.stop?.(); this._dropPrefetch();
    clearTimeout(this._maxPause); this._turnText = ''; this._turnClosing = false; this._echoRef = '';
    // Clear the echo grace window: a resume within ECHO_GRACE_MS of the last reply must not judge
    // the user's fresh opening words against a reply that stopped playing before the pause.
    this._replyDoneAt = 0;
    // Drop buffered-but-unsent audio: flushing it into the next session's socket on resume
    // would re-transcribe old speech (duplicate user turns).
    this._preroll = []; this._wasSpeaking = false; this._speaking = false;
    // PAUSE, don't tear down: keep the mic stream + audio graph + VAD model alive so a resume of THIS
    // agent (start() again) is instant — no getUserMedia prompt, no MicVAD.new() cold start. The STT
    // socket DOES close (it's cheap to reopen lazily on the next utterance, and a stale socket would
    // re-transcribe old audio). The host releases the mic by calling destroy() when it ends the session.
    this._vad?.pause(); this.stt.close();
    this._bsSpeechFrames = 0; this._bsSilenceFrames = 0;
    this._tapLastMs = 0;   // the pause gap isn't a capture dropout — don't flag it on resume
    this._set('idle');
  }

  // Full teardown: release the mic, audio graph and VAD model. Called by destroy() (host ends the
  // session) and before a cold rebuild (mic device switch). After this, start() pays the full cold
  // cost again. Split out so stop() can pause cheaply without duplicating this.
  _teardownPipeline() {
    this._vad?.destroy?.(); this._vad = null;
    this._node?.disconnect(); this._node = null;
    this._ctx?.close(); this._ctx = null;
    this._stream?.getTracks().forEach(t => t.stop()); this._stream = null;
    this._streamDeviceId = undefined;
    this._tap = []; this._tapSamples = 0; this._tapTotal = 0; this._tapLastMs = 0; this._tapGaps = [];   // fresh diagnostics per pipeline
  }

  // End the session for real: pause logic + release the mic/VAD (turns off the OS mic indicator). The
  // host calls this when it drops the agent (end/close/reset/new-chat) so a paused-but-discarded agent
  // never leaks the microphone.
  destroy() { this._destroyed = true; this.stop(); this.stt.close(); this._teardownPipeline(); }

  // Host-triggered barge-in: cut off the current in-flight turn (abort the LLM, stop TTS) WITHOUT
  // tearing down the pipeline — the mic keeps listening. Mirrors `_onBargeIn` but callable from a
  // UI "stop" control. No-op when nothing is in flight (already idle/listening).
  interrupt() {
    if (this._closed || (this.state !== 'thinking' && this.state !== 'speaking')) return;
    this._onBargeIn();
  }

  // Re-speak a FINISHED reply from `fromNw` (a non-whitespace offset — the word the user tapped),
  // interruptibly. Pure TTS: no LLM, no history change (re-listening isn't a new turn). `onProgress`
  // is driven by the host with (spokenSoFarText, done) so it can update the EXACT transcript message
  // it tapped (identity stays host-side — no reliance on draft-matching). Supersedes any in-flight
  // turn/replay (shares _turn/_abort), barge-in cuts it like a live reply, and it returns to listening.
  replay(text, fromNw = 0, onProgress = () => {}) {
    if (this._closed || !text?.trim()) return Promise.resolve();
    const prev = this._turn;
    this._abort?.abort();                 // supersede the in-flight reply/replay
    this.tts.stop?.();
    return (this._turn = (async () => {
      await prev?.catch(() => {});
      if (this._closed) return;
      this._replyText = '';                 // stale previous reply must not classify pre-audio speech as echo
      this._set('speaking');
      const signal = (this._abort = new AbortController()).signal;
      // TTS reports normalized spoken-so-far; map back to a raw prefix of `text` by non-whitespace count
      // so the host's cursor lands exactly (text keeps the model's original spacing). The audible
      // prefix doubles as the self-echo reference (see onPartial) — a replay leaks into the mic too.
      this.tts.setOnProgress?.((spoken) => {
        if (signal.aborted) return;
        this._replyText = sliceNw(text, nw(spoken));
        onProgress(this._replyText, false);
      });
      try {
        await this.tts.speak((async function* () { yield text; })(), signal, fromNw);
      } catch (e) {
        if (e.name !== 'AbortError') this.onEvent({ type: 'error', error: e.message });   // barge-in/supersede surfaces as AbortError → ignore
      } finally {
        this.tts.setOnProgress?.(null);
        this._replyDoneAt = Date.now();    // start the post-playout echo grace window
        onProgress(text, true);            // solidify the message back to its whole text (played out, barged-in, or superseded)
        if (!this._closed && this.state !== 'idle' && !signal.aborted) this._set('listening');
      }
    })());
  }

  // Live barge-in threshold: when the host didn't pass an explicit bargeInMinChars, re-read tuning.js
  // each utterance so editing it (with HMR) applies to the in-flight session; an explicit value is fixed.
  get bargeInMinChars() { return this._bargeInMinChars ?? TUNING.BARGE_IN_MIN_CHARS; }

  _set(s) { this.state = s; this.onEvent({ type: 'state', state: s }); }

  // List the TTS voices for a picker (if the active TTS supports it): [{ id, name, language }].
  listVoices() { return this.tts.voices ? this.tts.voices() : Promise.resolve([]); }
  // Switch TTS voice (takes effect on the next utterance).
  setVoice(voiceId) { this.tts.setVoice?.(voiceId); }
  // Speaking speed (no-op under Web Audio playback — kept for API compatibility).
  setSpeed(speed) { this.tts.setSpeed?.(speed); }

  // Update the host context (e.g. a re-opened chat with fresh conversation); applies from the next
  // turn on. Keeps the running session/history alive — no restart needed.
  setSysmsg(sysmsg) { this.sysmsg = composeSysmsg(sysmsg, this._persona, this.sttLang); this._dropPrefetch(); }   // a running speculation was built with the OLD sysmsg

  // Mute/unmute the mic by disabling the stream's audio tracks: the browser then feeds silence to
  // VAD and STT, so nothing the user says reaches the agent — without dropping the mic permission
  // or tearing down the pipeline. Stored so a mute toggled while paused applies on the next start().
  setMuted(muted) {
    this._muted = muted; this._stream?.getAudioTracks().forEach(t => t.enabled = !muted);
    if (muted) this._dropPrefetch();   // the utterance that seeded it just got cut off — no final will claim it
    // A self-capturing STT (Web Speech) has no agent stream to gate — it listens on its OWN mic, so
    // stop it explicitly via setEnabled or a "muted" agent keeps transcribing.
    if (this.stt.selfCapture) this.stt.setEnabled?.(!muted);
  }

  // Mute/unmute the AI's spoken OUTPUT (TTS). When muted, the reply still streams into the
  // transcript but is never voiced; an utterance already playing is stopped. Stored so it carries
  // across pauses and applies to the next turn.
  setTtsMuted(muted) { this._ttsMuted = muted; if (muted) this.tts.stop?.(); }

  // Move the playhead to a position in the current reply (non-whitespace char count) and play forward
  // from there — the transcript UI's tap-to-seek. Hits any sentence already streamed (backward replays
  // the cached clip, forward skips ahead); a tap beyond streamed text is a no-op. Returns true on a hit.
  seek(nwIndex) { return this.tts.seek?.(nwIndex) ?? false; }

  // HOLD: stop responding but keep listening. Entering hold silences the current reply NOW (kept
  // in history as the full streamed answer so far) and from then on every utterance is stacked
  // into history without a reply. Releasing flushes — one turn processes everything accumulated.
  setHeld(held) {
    if (held === this._held) return;
    this._held = held;
    if (held) {
      this._dropPrefetch();   // held turns queue for later — a running speculation would outlive its transcript
      // If a reply is in flight, silence it now and tag ITS signal to record the FULL streamed text
      // (per-turn, so a quick Resume can't flip it back). The barrier resolves once that turn has
      // finalized — held utterances order strictly after the assistant text it kept.
      const inFlight = this.state === 'thinking' || this.state === 'speaking';
      if (inFlight && this._abort) {
        this._abort.signal.keepFull = true;
        this._holdBarrier = (this._turn ?? Promise.resolve()).catch(() => {});
        this._abort.abort();
        this.tts.stop?.();
        this._set('listening');
      } else {
        this._holdBarrier = Promise.resolve();   // nothing in flight — held STT can push immediately
      }
    } else {
      this._flush().catch((e) => this.onEvent({ type: 'error', error: e.message }));
    }
  }

  // Queue a held user utterance: append it AFTER the hold-entry turn has finalized (the barrier), so
  // history stays ordered (…, assistant-so-far, user, user). Held pushes NEVER start an LLM turn —
  // release (_flush) owns starting the single turn, and waits for all of these to settle first.
  _pushHeld(text) {
    const p = (async () => { await this._holdBarrier; this.history.push({ role: 'user', content: text }); })();
    this._heldPushes.add(p);
    p.finally(() => this._heldPushes.delete(p));
  }

  // Release a hold: after the hold-entry turn AND every queued held push have settled, run ONE turn
  // over the accumulated history. No-op when nothing is queued (last entry isn't a user turn). The
  // held pushes already appended their user messages, so the turn's prep is empty — _runTurn just
  // serializes and replies over the accumulated history.
  async _flush() {
    if (this._closed || this._held) return;
    await this._holdBarrier;
    if (this._closed || this._held) return;                  // stopped / re-held while waiting -> abandon
    await Promise.allSettled([...this._heldPushes]);
    if (this._closed || this._held) return;
    const last = this.history[this.history.length - 1];
    if (!last || last.role !== 'user') return;
    await this._runTurn('');   // '' = no new utterance; reply over the accumulated held history (revalidated in _runTurn)
  }

  // Inject an out-of-band turn: feed `text` to the LLM as if the user had said it, then speak the
  // reply. Used by the host to surface external events (a tool result, a background job finishing)
  // — only meaningful while the agent is running, so it's a no-op once stopped.
  //
  // SOFT turn (supersede: false): unlike a user utterance this must NOT cut the reply in flight.
  // A tool result arrives WHILE the turn that called the tool is still streaming/speaking, so
  // aborting here would kill that turn mid-answer and re-run the LLM over a history whose last
  // entry is the request again — the model then re-calls the same tool (duplicate-action spam).
  // Instead it queues behind the running turn, which by then has recorded both its answer and the
  // [TOOL CALL] it made, so the model sees the work is already done.
  async notify(text) { if (!this._closed) await this._runTurn(text, { supersede: false }); }

  // Send a TYPED user turn: like speaking, but the text comes from the host's input instead of STT.
  // Emits the same turn-complete `stt` event a spoken turn would (so it renders as a finished user
  // bubble in the transcript), then runs it through the normal turn loop.
  // Returns true the moment the turn is ACCEPTED into the conversation (emitted/queued), false only
  // for blank text — the host clears the typed draft on true and keeps it on false. The reply runs in
  // the BACKGROUND (not awaited), exactly like a spoken turn finalized in onFinal: the user shouldn't
  // wait for the whole answer before the box clears.
  sendUserText(text) {
    if (this._destroyed || !text.trim()) return false;   // destroy() is terminal — never resurrect
    // Typed turns need no mic: revive a paused/stopped (_closed) agent's reply loop — stop() only
    // parks the AUDIO pipeline, and the LLM/tools/history don't need it. Also un-wedges a session
    // whose mic was denied or whose STT fataled: voice is dead, typing still works. start() re-arms
    // the audio pipeline separately (it sets _closed = false itself).
    this._closed = false;
    this.onEvent({ type: 'stt', turnComplete: true, text, ms: 0 });
    // Held: stack the typed turn into history but DON'T reply — same as a spoken turn (see onFinal).
    // Releasing the hold (Resume) runs everything accumulated. Typing must NOT silently un-hold.
    if (this._held) { this._pushHeld(text); return true; }
    this._onUserTurn(text);
    return true;
  }

  // ── the loop ──────────────────────────────────────────────────────────
  // State drives everything the UI needs: listening = VAD/STT, thinking = LLM,
  // speaking = TTS. No separate 'stage'/'user' events — derive the pipeline from state.
  //
  // Fire-and-forget a user turn (spoken onFinal AND typed sendUserText both land here): record the
  // message, then reply — serialized via _runTurn so rapid turns can't overlap. Never rejects to the
  // caller (errors surface via onEvent), so it's safe to call without awaiting/catching.
  _onUserTurn(text, { speech = false } = {}) {
    if (!text.trim()) return Promise.resolve();
    return this._runTurn(text, { speech });
  }

  // ── Speculative LLM prefetch ──────────────────────────────────────────────────────────────────
  // Start generating a reply for `text` BEFORE the turn officially closes, overlapping the LLM's
  // TTFT with the end-of-turn debounce. The generator is created against history + the probable
  // user turn and its first chunk is PULLED immediately (this.llm is lazy — the fetch only fires on
  // the first .next()), so by the time the turn closes the first tokens are usually already here.
  // Never speaks, never touches this.history — _speakTurn consumes it via _takePrefetch() only when
  // the closed turn's text matches exactly; any mismatch/staleness just aborts it.
  _startPrefetch(text) {
    // NEVER speculate when the LLM executes tools INSIDE its generator (llm.executesTools): pulling
    // the first chunk of a speculation could fire real side effects on a transcript the user is
    // still speaking and may yet change — and aborting the stream cannot undo them. The default
    // chunks are inert (tools run later, in _speakTurn), which is what makes this safe at all.
    if (this.llm.executesTools) return;
    // The 200ms timer raced real events — revalidate EVERYTHING now, not at scheduling time: the
    // agent must still be listening to this exact live transcript (a final/typed turn/replay/hold
    // in the gap cleared or changed _turnText; speculating past that would answer a stale turn).
    if (this._closed || this._held || this._echoRef || this.state !== 'listening' || this._turnText !== text) return;
    if (this._prefetch?.text === text) return;         // same speculation already in flight
    this._dropPrefetch();
    const ctl = new AbortController();
    const gen = this.llm([...this.history, { role: 'user', content: text }], this.sysmsg, ctl.signal);
    const p = { text, ctl, gen, first: gen.next(), histLen: this.history.length };   // pull NOW → fetch fires during the debounce; histLen pins the base the speculation saw
    p.first.catch(() => {});                           // aborted/failed speculation must not be an unhandled rejection
    this._prefetch = p;
  }
  _dropPrefetch() {
    clearTimeout(this._prefetchTimer); this._prefetchTimer = null;
    const p = this._prefetch; this._prefetch = null;
    if (p) { try { p.ctl.abort(); } catch {} p.first.then(() => p.gen.return?.()).catch(() => {}); }   // abort the fetch AND close the iterator (custom llm impls may clean up in finally)
  }
  // Claim the prefetch for a closing SPOKEN turn: exact text match AND unchanged history base (the
  // request was built on [...history, user]; if a raced turn appended anything since — e.g. the
  // barged-in reply's assistant prefix committed while we awaited prev — the speculation is missing
  // that context and must be regenerated). Hand over the already-streaming generator (re-stitched so
  // the pre-pulled first chunk isn't lost) + its own AbortController, so barge-in aborts the right fetch.
  _takePrefetch(text) {
    const p = this._prefetch;
    // histLen is checked BEFORE _runTurn pushes this turn's own user message (see call site).
    if (!p || p.text !== text || p.ctl.signal.aborted || p.histLen !== this.history.length) { this._dropPrefetch(); return null; }
    this._prefetch = null;   // timer already cleared: successful adoption is only reached from a spoken onFinal
    return { ctl: p.ctl, gen: (async function* () { const f = await p.first; if (!f.done) { yield f.value; yield* p.gen; } })() };
  }

  // The ONE serialized turn runner. Every reply (typed, spoken, held-release, notify) goes through
  // here, so turns can NEVER overlap regardless of how fast callers fire. It chains onto the prior
  // turn and reassigns `this._turn` SYNCHRONOUSLY before awaiting anything — so a second caller that
  // arrives in the same tick chains onto THIS turn, not the one it's superseding.
  //
  // `text` (the new user utterance, or '' for a held-release that replies over already-queued history)
  // is appended AFTER the predecessor settles — so its heard prefix lands first, keeping history
  // chronological (…, assistant-heard-so-far, user-new). If a hold was entered while we waited, the
  // utterance is routed into the held queue instead of dropped (acceptance must never be lost). The
  // reply only runs when the latest history entry is a user turn. Never throws (errors -> onEvent).
  //
  // `supersede: false` = a SOFT turn (notify: tool results, board events): record it and reply only
  // if nothing newer has queued behind it, and never cut the reply in flight. Anything newer already
  // sees this message in history and answers over the fuller picture — so a burst of tool results
  // collapses into ONE reply instead of one interrupting monologue per result.
  _runTurn(text, { supersede = true, speech = false } = {}) {
    const prev = this._turn;
    if (supersede) {
      this._abort?.abort();   // cut the in-flight reply NOW (barge-in / superseded)
      this.tts.stop?.();
    }
    // Reply-generating turns only. `this._turn` can't stand in for this: replay() chains onto it too,
    // and a replay is pure TTS — it never answers pending history, so treating it as "someone newer
    // owns the reply" would strand the turn (a held release or a tool result would go unanswered).
    const seq = ++this._replySeq;
    return (this._turn = (async () => {
      await prev?.catch(() => {});                  // let the predecessor settle (records its heard prefix)
      if (this._closed) return;                     // stopped while we waited -> abandon (stop() dropped the prefetch)
      // Held while we waited: don't drop an accepted utterance — queue it for the next release.
      // (setHeld(true) already dropped any speculation.)
      if (this._held) { if (text) this._pushHeld(text); return; }
      // Superseded while we waited: the newer turn now owns the reply and sees our message in
      // history — generating here too would talk over it (and re-run the same tools). Decided BEFORE
      // claiming the prefetch, so we never adopt a stream just to abort it.
      if (this._replySeq !== seq) { this._dropPrefetch(); if (text) this.history.push({ role: 'user', content: text }); return; }
      // Prefetch handover — decided BEFORE pushing our user message so _takePrefetch can verify the
      // history base is exactly what the speculation was built on (a raced turn that appended its
      // assistant message while we awaited prev fails the histLen check → regenerate with context).
      // Only a SPOKEN final may adopt (it seeded the speculation); typed/notify/held turns drop it.
      const pf = speech && text ? this._takePrefetch(text) : (this._dropPrefetch(), null);
      if (text) this.history.push({ role: 'user', content: text });
      // Reply only if the conversation now ends on a user turn (a raced turn may have already
      // replied). pf is always null here: if we pushed a user turn it IS the last entry.
      if (this.history[this.history.length - 1]?.role !== 'user') return;
      this._set('thinking');                        // LLM stage
      this._abort = pf?.ctl ?? new AbortController();   // adopted prefetch keeps ITS controller so barge-in aborts the right fetch
      await this._speakTurn(this._abort.signal, pf?.gen);   // _speakTurn never throws — errors surface via onEvent
    })());
  }

  // One assistant turn: stream the LLM → TTS, then record what was actually HEARD (the barge-in
  // prefix, not the full generated answer) and run any tools it chose. Stored as `this._turn` so the
  // next user turn can await it. Never throws (errors surface via onEvent) so the await is safe.
  async _speakTurn(signal, prefetched = null) {
    // Fresh turn → drop the previous reply's audible text so user speech heard before THIS turn's
    // first audio plays can't be misjudged as echo of the OLD reply. The TTS progress hook below
    // repopulates it with the audible prefix as playback advances.
    this._replyText = '';
    // Tap the LLM stream once: yield speech text to TTS, set aside the tool calls for after we
    // finish speaking. First delta flips us to 'speaking'; accumulate the full answer for the
    // heard-vs-unheard report. `this.llm(...)` is a lazy generator — its fetch fires only when
    // tts.speak first pulls, by which point any prior turn is aborted; keeps LLM streams serial.
    let answer = '', calls = [];
    // The tools this turn dispatched, as a ledger line recorded INTO its assistant message. The
    // runtime's tool calls are fire-and-forget (no tool_use/tool_result pair on the wire, and history
    // is provider-neutral {role, content} text), so without this the history reads as if it never
    // called anything and the next turn happily calls it AGAIN — duplicate tool-call spam. Relayed
    // calls: the outcome arrives separately as the host's `[TOOL RESULT <name>]` notify() turn.
    // Custom LLMs that execute tools inside their own generator (llm.executesTools) attach the
    // outcome directly, so the ledger line carries it — bounded — or the next turn would see the call with no result and lose what
    // the model learned (a barge-in cuts the spoken follow-up but not the fact). Read late (the
    // stream may still be appending) and on EVERY exit path, including a failed reply.
    const toolNote = () => calls.map((c) => `[TOOL CALL ${c.tool}] ${callArgs(c)}${ledgerOutcome(c)}`).join('\n');
    const tapped = (async function* (self, src) {
      for await (const item of src) {
        // tool_use → fire NOW, in parallel with TTS. Identical repeats within one turn are the SAME
        // act (a provider re-emitting its buffered call, or the model asking twice) — run it once.
        if (item.tool) {
          // Same key = same act (provider re-emit / model asking twice). A MIMIC chunk carries no id,
          // so also match by name+args across the id boundary — a typed echo of an id-carrying native
          // call (llm.executesTools mode) must collapse too, or it would execute the tool a second time.
          const dup = calls.some((c) => callKey(c) === callKey(item) ||
            ((!c.id || !item.id) && c.tool === item.tool && callArgs(c) === callArgs(item)));
          if (!dup) { calls.push(item); self._runTool(item); }
          continue;
        }
        if (self.state === 'thinking') self._set('speaking');  // first token → TTS stage
        answer += item.text;
        // While audio plays, the TTS progress hook owns the draft (text = spoken-so-far, full = answer,
        // read live each tick), so streaming the whole answer here would yank the cursor to the end.
        // Once the cursor is live we only grow `answer` (the hook reads it); until then (muted, or the
        // first sentence is still synthesizing) we stream the full answer so the bubble isn't empty.
        if (!self._cursorLive) self.onEvent({ type: 'assistant', text: answer, final: false });
        yield item.text;
      }
    })(this, stripToolCallMimicry(prefetched ?? this.llm(this.history, this.sysmsg, signal)));   // prefetched stream already carries this turn's user text (see _startPrefetch)

    let spoken = '';
    // Live spoken cursor: while a clip plays the TTS reports chars heard so far, which we mirror as a
    // streaming assistant draft — `text` = spoken-so-far, `full` = whole answer, so the host renders the
    // not-yet-spoken remainder dimmed and the cursor follows the voice. Cleared (finally) after the turn.
    // The TTS reports spoken text as normalized sentence chunks (trimmed, space-joined), which is NOT a
    // raw prefix of `answer` (the LLM text keeps newlines/double spaces). Map it back by non-whitespace
    // count: walk `answer` until it has the same number of non-whitespace chars as what's been spoken,
    // so `text` is always an exact prefix of `full` → the UI's full.slice(text.length) tail is correct.
    const rawPrefix = (spoken) => {
      let need = 0; for (const c of spoken) if (!/\s/.test(c)) need++;
      if (!need) return '';
      let seen = 0, i = 0;
      for (; i < answer.length; i++) { if (!/\s/.test(answer[i])) { if (++seen === need) { i++; break; } } }
      return answer.slice(0, i);
    };
    this._cursorLive = false;
    this.tts.setOnProgress?.((spokenSoFar) => {
      if (signal.aborted) return;
      this._cursorLive = true;          // hook now drives the draft → LLM stream stops emitting full text
      const heard = rawPrefix(spokenSoFar);
      this._replyText = heard;          // AUDIBLE prefix — the self-echo reference (echo can only be of what played)
      this.onEvent({ type: 'assistant', text: heard, full: answer, final: false });
    });
    try {
      // TTS muted: drain the same stream so the transcript + tool calls still run, but never voice
      // it. The whole reply counts as "heard" (history) since there's no barge-in without audio.
      if (this._ttsMuted) {
        for await (const _ of tapped) { /* consume: drives answer + assistant events */ }
        spoken = answer;
      } else {
        spoken = await this.tts.speak(tapped, signal);   // resolves with text actually heard (prefix on barge-in)
      }
    } catch (e) {
      if (e.name !== 'AbortError') {                   // real failure (not barge-in) → surface it
        this.tts.setOnProgress?.(null); this._cursorLive = false;
        this.onEvent({ type: 'error', error: e.message });
        // Tools fire DURING streaming, so a reply that dies here may already have dispatched one.
        // Record + join them anyway: the ledger is about what was DONE, not about what got spoken —
        // dropping it would let the next turn call the same tool again.
        if (toolNote()) this.history.push({ role: 'assistant', content: toolNote() });
        await Promise.all(calls.map((c) => this._runTool(c)));
        if (this.state !== 'idle') this._set('listening');
        return;
      }
      // barge-in surfaced as AbortError → fall through and record whatever was heard
    } finally {
      this.tts.setOnProgress?.(null); this._cursorLive = false;       // drop the cursor hook — next turn re-registers
      this._replyDoneAt = Date.now();                                 // start the post-playout echo grace window
    }


    // Normally we record only the HEARD prefix (barge-in: the user reacted to what they heard). But a
    // turn aborted on hold-entry was tagged signal.keepFull, so we keep the whole streamed answer —
    // on release the LLM sees everything it had formed. Per-turn tag → a quick Resume can't flip it.
    const kept = signal.keepFull ? answer : spoken;
    if (kept || toolNote()) {
      this.history.push({ role: 'assistant', content: [kept, toolNote()].filter(Boolean).join('\n') });
    }
    if (kept) {
      // History keeps the normalized `kept`; the EVENT emits a raw prefix of `answer` so the host's
      // full.slice(text.length) tail aligns. keepFull/normal-finish → whole answer (no tail); a barge-in
      // → the heard prefix solid + the unspoken remainder dimmed, showing exactly where TTS got.
      const shown = signal.keepFull ? answer : rawPrefix(spoken);
      this.onEvent({ type: 'assistant', text: shown, full: answer, final: true });
    } else if (answer) {
      // Interrupted before anything was heard (nothing voiced yet): drop the streamed draft so the
      // transcript doesn't keep a dangling unfinished bubble. Empty text → host clears the draft.
      this.onEvent({ type: 'assistant', text: '', final: false });
    }
    await Promise.all(calls.map((c) => this._runTool(c)));             // ensure they finished (already fired during streaming)
    if (!signal.aborted && this.state !== 'idle') this._set('listening');   // superseded turns don't touch state
  }

  // Run one chosen tool call and report it. Fired as soon as its tool_use arrives in the stream
  // (parallel with TTS) and awaited again at turn end — memoizing the promise on `call`
  // makes the second await join the same run instead of double-executing. Never rejects (errors
  // surface via onEvent): the streaming-time fire is unawaited, so a rejection there would be unhandled.
  _runTool(call) {
    if (!call) return;
    return (call.ran ??= (async () => {
      try {
        // Pre-executed call (agent loop ran it inside the reply): report the attached outcome,
        // never execute a second time. An in-loop failure was already fed back to the model as an
        // is_error tool_result and the model narrates it — here it surfaces as ONE failed tool
        // event (the transcript's failed chip). No extra 'error' event: that channel is for
        // runtime/transport failures, not a handled domain-level tool miss.
        if ('result' in call || 'error' in call) {
          const result = call.error ? { text: call.error, ok: false } : call.result;
          this.onEvent({ type: 'tool', name: call.tool, args: call.args, result });
          return;
        }
        const result = await this.tools[call.tool]?.run?.(call.args);
        this.onEvent({ type: 'tool', name: call.tool, args: call.args, result });
      } catch (e) {
        this.onEvent({ type: 'error', error: `tool ${call.tool}: ${e.message}` });
      }
    })());
  }

  _onBargeIn() {                       // user spoke while we were talking
    this._abort?.abort();              // stop LLM
    this.tts.stop?.();                 // stop TTS (tts.speak resolves with the heard prefix)
    this._set('listening');
  }

  // VAD heard end-of-speech. The detector decides if the turn is truly OVER (commit) or the user just
  // paused mid-thought (keep listening). Without a detector this is plain VAD endpointing: always commit.
  // Guarded by a generation token so a late async verdict from a superseded pause can't commit a turn
  // the user already continued (a new onSpeechStart bumps the token).
  async _endOfSpeech() {
    clearTimeout(this._maxPause);
    // Native end-of-turn provider (e.g. Deepgram Flux): the STT's own model decides when the turn is
    // over and emits an unsolicited onFinal — VAD end-of-speech is NOT a boundary here (the provider
    // must hear the silence to judge it), so don't commit and don't run the turnDetector. No agent-side
    // failsafe either: Flux transcripts are CUMULATIVE per turn, so force-flushing a still-open turn
    // emits its prefix, which the next flush then repeats ("it is it is …"). Turn-hang protection is
    // the provider's own eot_timeout_ms (server force-ends the turn after ~5s of silence).
    if (this.stt.nativeEOT) return;
    // _close: mark the turn as CLOSING (commit() starts ForceEndOfUtterance) but DON'T clear _turnText —
    // onFinal clears it when the final actually lands. This keeps a "closing" turn distinct from a fresh
    // idle state, so a fast next onSpeechStart won't reset() the STT mid-finalization (lost/merged turn).
    const close = () => { this._turnClosing = true; this.stt.commit(); };
    if (!this.turnDetector || !this._turnText) { close(); return; }
    const gen = this._turnGen;                   // snapshot; a new onSpeechStart bumps it → our verdict goes stale
    let done = true;
    try { done = await this.turnDetector(this._turnText); }
    catch (e) { this.onEvent({ type: 'error', error: `turnDetector: ${e.message}` }); }
    if (gen !== this._turnGen) return;          // user resumed speaking while we judged → verdict is stale
    if (this._speaking) return;                 // already talking again → let the next end-of-speech decide
    if (done) { close(); return; }
    // Keep listening: the pause was mid-thought. Failsafe so a turn the detector never closes (user
    // walked away mid-sentence) can't hang forever — commit anyway after a hard max-pause.
    this._maxPause = setTimeout(() => { if (gen === this._turnGen && !this._speaking && this._turnText) close(); }, this.maxPauseMs);
  }

  // ── VAD ───────────────────────────────────────────────────────────────
  // Shared speech-start/end handling: called by BOTH the bootstrap energy-VAD (_bootstrapVadTick)
  // and Silero (onSpeechStart/onSpeechEnd below) — a detector swap never changes turn semantics.
  _onSpeechStart() {
    this._speaking = true; this._turnGen = (this._turnGen || 0) + 1; clearTimeout(this._maxPause);
    if (!this._turnText && !this._turnClosing) this.stt.reset?.();
    this.onEvent({ type: 'vad', active: true });
  }
  _onSpeechEnd() { this._speaking = false; this.onEvent({ type: 'vad', active: false }); this._endOfSpeech(); }

  async _startVad(gen) {
    // Self-serve the UMD deps (onnxruntime + vad-web) if the host never called prewarmVoice() —
    // prewarming is an optimization, not a setup requirement.
    if (!window.vad) { const { loadVoiceDeps } = await import('./deps.js'); await loadVoiceDeps(); }
    const d = window.vad;
    const vad = await d.MicVAD.new({
      model: 'v5',
      // MicVAD.new() auto-starts listening itself when startOnLoad (default true) — we need it INERT
      // until we explicitly .start() it below (either right away, or later at a safe utterance
      // boundary via _swapToSileroWhenReady/_bootstrapVadTick) so it never runs concurrently with the
      // bootstrap energy-VAD.
      startOnLoad: false,
      // Listen on the SAME stream we opened in start() (the chosen mic) — not a second
      // default-mic getUserMedia. Keeps VAD and STT on one input, and one permission prompt.
      getStream: async () => this._stream,
      // Same asset paths warmVad() pre-fetched/compiled, so this reuses the cached v5 model + WASM.
      onnxWASMBasePath: VAD_WASM_PATH,
      baseAssetPath:    VAD_ASSET_PATH,
      ...TUNING.VAD,   // speech-detection sensitivity (positive/negativeSpeechThreshold, minSpeechFrames, redemptionFrames, preSpeechPadFrames) — see tuning.js
      ...this.vadOptions,                                       // host tuning overrides the defaults above
      // NB: barge-in is NOT triggered here anymore — VAD energy alone (the AI's own echo, noise) must not
      // cut a reply; the first TRANSCRIBED word does, in onPartial. The uplink STT runs through the reply.
      onSpeechStart: () => this._onSpeechStart(),
      onSpeechEnd:   () => this._onSpeechEnd(),
    });
    // A stale build (the pipeline was superseded/torn down while MicVAD.new() resolved) must not
    // stomp the current session's _vad — destroy its own instance and bail (the caller's .then()
    // gen-guard skips the swap too; this guard covers the assignment itself).
    if (gen !== undefined && (gen !== this._pipelineGen || this._closed)) { vad.destroy?.(); throw new Error('superseded'); }
    this._vad = vad;
    // Only actually start listening on Silero right away if the bootstrap VAD has already been
    // swapped out (or never engaged) — otherwise _swapToSileroWhenReady (called after this resolves)
    // arms it at the next safe utterance boundary instead of running both detectors at once.
    if (!this._useBootstrap) this._vad.start();
  }

  // Silero finished loading (this._vad is ready) while the bootstrap energy-VAD was standing in.
  // Swap over ONLY at a safe boundary — never mid-utterance, so we don't yank the detector while the
  // user is mid-sentence (which could double-fire or miss the true end-of-speech). If speech is in
  // progress right now, defer: _onSpeechEnd() (bootstrap path) checks _sileroPending and swaps once
  // the current utterance closes.
  _swapToSileroWhenReady() {
    this._sileroPending = false;
    if (this._speaking) return;   // mid-utterance — _bootstrapVadTick's speech-end path swaps after
    this._useBootstrap = false; this._bsSpeechFrames = 0; this._bsSilenceFrames = 0;
    this._vad?.start();
  }

  // Zero-load RMS-energy stand-in for Silero, active only during `this._useBootstrap` (cold-start
  // window before Silero has loaded). Deliberately crude — it only needs to survive the first
  // second(s) of a session without losing/chopping the user's opening words; see tuning.js
  // BOOTSTRAP_VAD for the thresholds. Ticks once per ~256ms worklet capture chunk (_feed below).
  _bootstrapVadTick(f32) {
    const cfg = TUNING.BOOTSTRAP_VAD;
    let sum = 0; for (let i = 0; i < f32.length; i++) sum += f32[i] * f32[i];
    const rms = Math.sqrt(sum / f32.length);
    if (rms >= cfg.energyThreshold) {
      this._bsSilenceFrames = 0;
      if (!this._speaking && ++this._bsSpeechFrames >= cfg.minSpeechFrames) this._onSpeechStart();
    } else {
      this._bsSpeechFrames = 0;
      if (this._speaking && ++this._bsSilenceFrames >= cfg.redemptionFrames) {
        this._bsSilenceFrames = 0;
        this._onSpeechEnd();
        // The utterance that was masking the swap (see _swapToSileroWhenReady) just closed — hand
        // off to Silero now, before the NEXT one starts, instead of waiting for another tick.
        if (!this._sileroPending && this._vad) { this._useBootstrap = false; this._vad.start(); }
      }
    }
  }

  // ── STT (VAD-gated) — capture mic, gate on VAD, forward to the active provider ──────────
  // The provider (this.stt, chosen by `sttProvider`) owns its socket + wire protocol and reports
  // transcripts via the callbacks wired in the constructor. Here we only convert float→int16,
  // keep a small preroll so word-starts aren't clipped, and feed/commit on VAD boundaries.
  _feed(f32) {
    if (this._useBootstrap) this._bootstrapVadTick(f32);
    const i16 = new Int16Array(f32.length);
    for (let i = 0; i < f32.length; i++) i16[i] = Math.max(-1, Math.min(1, f32[i])) * 32767;
    this._tapPush(i16);   // diagnostic ring buffer of the exact frames handed to STT (see dumpAudio)
    // Continuous provider (e.g. Deepgram Flux): its end-of-turn model needs to hear the real
    // silences, so feed the FULL stream — no VAD gating, no preroll replay. VAD still runs above
    // (state events + speech-start reset + the nativeEOT failsafe), it just doesn't gate the audio.
    if (this.stt.continuous) { this.stt.feed(i16); return; }
    if (!this._speaking) { this._preroll.push(i16); if (this._preroll.length > this.prerollMax) this._preroll.shift(); this._wasSpeaking = false; return; }
    if (!this._wasSpeaking) {
      for (const c of this._preroll) this.stt.feed(c); this._preroll = []; this._wasSpeaking = true;
    }
    this.stt.feed(i16);
  }

  // ── diagnostic tap ─────────────────────────────────────────────────────
  // Ring-buffer the frame + detect delivery stalls: a wall-clock gap between _feed() calls beyond
  // ~1.5 chunks. With the worklet capturing off-thread that's usually DELAYED delivery rather than
  // lost samples, but it timestamps exactly where a corrupted run got starved. atSample is an
  // ABSOLUTE stream offset (samples since pipeline build), so gaps stay addressable after trimming.
  _tapPush(i16) {
    const now = (globalThis.performance ?? Date).now();
    const chunkMs = (i16.length / 16000) * 1000;
    if (this._tapLastMs && now - this._tapLastMs > chunkMs * 1.5) {
      this._tapGaps.push({ atSample: this._tapTotal, gapMs: Math.round(now - this._tapLastMs) });
    }
    this._tapLastMs = now;
    this._tap.push(i16); this._tapSamples += i16.length; this._tapTotal += i16.length;
    const max = 16000 * 30;
    while (this._tapSamples - this._tap[0].length >= max) this._tapSamples -= this._tap.shift().length;
    // Keep only gaps still inside (or near) the retained window so the list can't grow unbounded.
    const windowStart = this._tapTotal - this._tapSamples;
    if (this._tapGaps.length && this._tapGaps[0].atSample < windowStart) this._tapGaps = this._tapGaps.filter(g => g.atSample >= windowStart);
  }

  // Dump the tap as a 16kHz mono WAV Blob + detected stall gaps: { wav, gaps, seconds }. Play it back
  // after a failed run — gapped/corrupt audio → capture layer; clean audio → provider-side.
  dumpAudio() {
    const total = this._tapSamples;
    const windowStart = this._tapTotal - total;   // absolute offset of the WAV's first sample
    const pcm = new Int16Array(total);
    let off = 0; for (const c of this._tap) { pcm.set(c, off); off += c.length; }
    const bytes = pcm.length * 2, buf = new ArrayBuffer(44 + bytes), dv = new DataView(buf);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); dv.setUint32(4, 36 + bytes, true); str(8, 'WAVE'); str(12, 'fmt ');
    dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
    dv.setUint32(24, 16000, true); dv.setUint32(28, 16000 * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
    str(36, 'data'); dv.setUint32(40, bytes, true);
    for (let i = 0; i < pcm.length; i++) dv.setInt16(44 + i * 2, pcm[i], true);
    // Gaps re-based to WAV-relative sample offsets (atSec for quick seeking during playback).
    const gaps = this._tapGaps.filter(g => g.atSample >= windowStart)
      .map(g => ({ atSample: g.atSample - windowStart, atSec: (g.atSample - windowStart) / 16000, gapMs: g.gapMs }));
    return { wav: new Blob([buf], { type: 'audio/wav' }), gaps, seconds: total / 16000 };
  }
}


// Strip markdown to plain prose for the EAR: the persona prompt already forbids markdown, so this is
// a safety net — if formatting ever slips into a reply, the synthesizer must not voice the syntax
// ("star star", "hash", "backtick"). We only feed this to _synth; the tape/cursor keep the RAW text
// so tap-to-seek alignment is untouched. Drops fences/inline-code, image/link syntax (keeping link
// text), heading/quote/list markers, and emphasis/strikethrough runs.
const stripMd = s => s
  .replace(/```[^\n]*\n?([\s\S]*?)```/g, '$1')      // fenced code -> its contents
  .replace(/`([^`]+)`/g, '$1')                       // inline code
  .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')          // images -> alt text
  .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')           // links -> link text
  .replace(/^\s{0,3}#{1,6}\s+/gm, '')                // ATX headings
  .replace(/^\s{0,3}>\s?/gm, '')                     // blockquotes
  .replace(/^\s*([-*+]|\d+[.)])\s+/gm, '')           // list markers
  .replace(/(\*\*\*|___)(.+?)\1/g, '$2')             // bold+italic
  .replace(/(\*\*|__)(.+?)\1/g, '$2')                // bold
  .replace(/(\*|_)(.+?)\1/g, '$2')                   // italic
  .replace(/~~(.+?)~~/g, '$1')                        // strikethrough
  // Streaming splits a reply into word/clause chunks BEFORE stripMd runs, so an emphasis span can
  // straddle two chunks, leaving one chunk with an UNPAIRED marker the paired rules above can't match.
  // Sweep any stray emphasis/code markers so the synth never voices "star"/"backtick".
  .replace(/[*_~`]/g, '')
  .trim();

// ── Self-echo detection ─────────────────────────────────────────────────────────────────────────
// Is `heard` (transcribed while the agent speaks) just its own voice leaking speakers → mic? We know
// the audible reply prefix, so word-match `heard`'s RECENT tail (last `window` words — old echo
// followed by a fresh real interruption must still cut in) against the reply's word set: mostly
// reply words → echo. Word-set based (unordered, unicode-aware for accented text): tolerant of
// STT dropping/reordering echoed words, NOT of substituting them — a badly misheard echo can slip
// through (acceptable; it just means the old behavior for that turn). `minHits` = minimum matched
// words required (the barge-in suppression check is lenient at 1; the final-drop check demands 3,
// so a user briefly QUOTING the reply — "pricing?" — is never swallowed as echo).
// Threshold TUNING.ECHO_WORD_MATCH; > 1 disables the filter.
// ECHO_GRACE_MS: STT lags the audio, so the tail of the echo can be transcribed just AFTER playback
// ended — keep classifying against the finished reply for this long past _replyDoneAt.
const ECHO_GRACE_MS = 2000;
const wordsOf = (s) => (s.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? []);
// Bounded Levenshtein — true if editDistance(a,b) ≤ max. Early-exits a row whose minimum already
// exceeds max, so the cost stays tiny on the short words we compare.
const editLe = (a, b, max) => {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > max) return false;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]; let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j] < best) best = cur[j];
    }
    if (best > max) return false;
    prev = cur;
  }
  return prev[b.length] <= max;
};
// FUZZY word hit: STT frequently MIS-hears the synthetic TTS voice ("sure i will create" heard as
// "shure i wil kreate"), and an exact word-set match then scores the echo as novel speech — the
// filter's main failure mode. A heard word counts as a reply word if it matches exactly OR within an
// edit distance scaled by the LONGER of the pair (≥4 chars → 1 edit, ≥8 → 2) — so "wil" still
// matches "will", while tiny words ("no" vs "now": longer side 3) must match exactly, or real
// interruptions would get swallowed.
const fuzzyHas = (replyWords, w) => {
  for (const r of replyWords) {
    if (r === w) return true;
    const len = Math.max(w.length, r.length);
    const max = len >= 8 ? 2 : len >= 4 ? 1 : 0;
    if (max && editLe(w, r, max)) return true;
  }
  return false;
};
export function isSelfEcho(heard, reply, { threshold = TUNING.ECHO_WORD_MATCH, window = 8, minHits = 1 } = {}) {
  if (!(threshold <= 1) || !reply) return false;
  const hw = window === Infinity ? wordsOf(heard) : wordsOf(heard).slice(-window);
  if (!hw.length) return false;
  const rw = wordsOf(reply);
  let hit = 0; for (const w of hw) if (fuzzyHas(rw, w)) hit++;
  return hit >= minHits && hit / hw.length >= threshold;
}
// Chars of `heard` NOT attributable (fuzzily) to `reply` — the barge-in evidence. While the agent
// speaks, only these count toward the barge-in threshold: echo words (even misheard ones, via the
// fuzzy match) contribute ZERO, so a leaked echo that dodged the ratio-based latch still can't
// accumulate enough "user speech" to cut the reply. Real interruptions are made of words the reply
// doesn't contain, so they hit the threshold as fast as before. No reply text → everything is novel.
export function novelChars(heard, reply) {
  const rw = wordsOf(reply ?? '');
  let n = 0;
  for (const w of wordsOf(heard)) if (!rw.length || !fuzzyHas(rw, w)) n += w.length;
  return n;
}

// Count non-whitespace chars — the whitespace-invariant position key shared by the cursor and seek().
const nw = s => { let n = 0; for (const c of s) if (!/\s/.test(c)) n++; return n; };
// Prefix of `s` holding exactly `n` non-whitespace chars (keeps the original whitespace) — the inverse
// of nw(), used to turn a non-whitespace cursor position back into a real text slice.
const sliceNw = (s, n) => { if (n <= 0) return ''; let seen = 0, i = 0; for (; i < s.length; i++) { if (!/\s/.test(s[i])) { if (++seen === n) { i++; break; } } } return s.slice(0, i); };

// Earliest break to end the FIRST spoken chunk — minimizing first-audio latency (we don't wait for a
// whole sentence to start talking; voice replies are often ONE sentence, so a sentence-only break would
// stall TTS until generation finishes). Priority:
//   1. a real sentence ender (. ! ? …) or a dash/colon clause break → break immediately;
//   2. else, once we have >= firstChunkMinChars, the first comma/semicolon clause pause → break there;
//   3. else, if the opener runs past firstChunkMaxChars with no punctuation, break at the last word
//      boundary anyway so a long unpunctuated start still begins playing.
// The VERY first audible unit: break on the first complete word so playback starts the instant the
// LLM has emitted one word (Piper synthesizes a whole chunk at once, so a one-word chunk is the
// smallest possible first-audio latency). Requires a trailing space — a word still being typed
// ("Hel") doesn't break; "Hello " does, returning the index after "Hello". -1 until a word completes.
// On free local Piper a slightly choppy opener is worth the instant start; the next chunks below get
// whole-clause/sentence prosody, and one-ahead synthesis hides their cost.
function firstWordEnd(s) {
  // Extend across words until the chunk holds >= firstWordMinChars non-space chars, so a tiny opener
  // ("I", "Hi", "A ...") glues to the next word instead of becoming a choppy 1-2 char micro-clip.
  const re = /\S\s/g;
  let m, end = -1, chars = 0;
  while ((m = re.exec(s))) {
    end = m.index + 1;
    chars = nw(s.slice(0, end));
    if (chars >= TUNING.TTS.firstWordMinChars) return end;   // long enough → break here
  }
  return -1;   // no completed word yet, or all completed words still under the floor (wait for more)
}

// All require a trailing space/end so we don't split inside "3.14", "pl.", or "1,000".
function firstSentenceEnd(s) {
  const hard = /[.!?…]+(?=\s|$)|\s[–—-](?=\s)|:(?=\s)/.exec(s);
  if (hard) return hard.index + hard[0].trimEnd().length;
  if (s.length >= TUNING.TTS.firstChunkMinChars) {
    const soft = /[,;](?=\s)/.exec(s);
    if (soft && soft.index + 1 >= TUNING.TTS.firstChunkMinChars) return soft.index + 1;
  }
  if (s.length >= TUNING.TTS.firstChunkMaxChars) {
    const sp = s.lastIndexOf(' ', TUNING.TTS.firstChunkMaxChars);
    if (sp > 0) return sp;
  }
  return -1;
}

// First sentence ender (. ! ? …, or a trailing-space colon) in `s`, or -1 — used for every
// sentence after the first, where we prefer whole sentences (fewer cuts, better prosody) over
// the earliest break. A colon ends a clause often enough to be a good, natural TTS break.
// Capped: a long run with no ender (lists, dashed prose) breaks at the last word boundary by
// sentenceMaxChars so audio keeps flowing instead of stalling on one monster chunk.
function sentenceEnd(s) {
  const m = /[.!?…]+(?=\s|$)|:(?=\s)/.exec(s);
  if (m) return m.index + m[0].trimEnd().length;
  if (s.length >= TUNING.TTS.sentenceMaxChars) {
    const sp = s.lastIndexOf(' ', TUNING.TTS.sentenceMaxChars);
    if (sp > 0) return sp;
  }
  return -1;
}

// ── streaming TTS base: sentence pipeline + Web Audio playback. Providers (Piper, …)
//    extend it and implement only `_synth(text, signal) → audio Blob` (and
//    optionally `voices()`); `speak` below does the rest:
//    Takes an async iterator of text deltas. Streams sentence-by-sentence for low latency
//    AND small inter-sentence gaps on long answers:
//      • re-chunk the deltas into sentences (sentence 1 on the earliest natural break for
//        fast first audio; later ones on whole-sentence enders for better prosody).
//      • synth ONE sentence ahead while the current one plays, so the next clip is ready (or
//        nearly) the moment the current finishes — no growing gap as the answer gets longer.
//      • play STRICTLY in order, one clip at a time (never two voices at once).
//    Whole clips (no char timings) → on barge-in the heard prefix is estimated proportionally
//    within the playing sentence.
// ── Web Audio playback ───────────────────────────────────────────────────────
// We play TTS via the Web Audio API (AudioContext + AudioBufferSourceNode), NOT an <audio> element:
// a buffer source starts the instant its data is decoded — no blob-URL assignment, no
// loadedmetadata round-trip — shaving per-clip start latency off EVERY sentence. The tradeoff is no
// pitch-preserving rate change, so playback runs at native 1.0x (see StreamingTTS default speed).
//
// iOS Safari starts the AudioContext "suspended" and only lets it resume() inside a user gesture.
// TTS audio arrives async (after STT→LLM), far outside any gesture, so we create + resume ONE shared
// context from the host's mic-button click (unlockAudio) and reuse it for all later playback.
let sharedCtx = null;
const audioCtx = () => (sharedCtx ??= new (window.AudioContext || window.webkitAudioContext)());

// ── AEC loopback sink ────────────────────────────────────────────────────────
// THE self-interruption root cause: the browser's echo canceller (getUserMedia
// echoCancellation:true) does NOT use raw Web-Audio output (node.connect(ctx.destination)) as its
// cancellation reference — Chrome only cancels audio that plays out via a WebRTC remote track (or a
// media element fed by one). So on speakers the mic captures our own TTS verbatim, STT transcribes
// it (often MIS-hears the synthetic voice, which defeats the word-match echo filter), and the agent
// barge-ins on itself. Fix: route ALL TTS playback through a MediaStreamAudioDestinationNode, pipe
// that stream through a loopback RTCPeerConnection pair (pc1→pc2, same page), and play the REMOTE
// track in a hidden <audio> element. To the browser that playout is now "WebRTC remote audio", so
// the mic-side AEC subtracts it — the echo never reaches VAD/STT at all. Costs a few tens of ms of
// playout latency (jitter buffer), which the spoken-word cursor tolerates.
// Setup is kicked from unlockAudio() (the mic-button gesture: <audio>.play() needs the same
// transient activation the AudioContext resume does). On ANY failure (no RTCPeerConnection —
// WebKitGTK builds, negotiation error, autoplay-blocked play()) we fall back to direct
// ctx.destination playback — old behavior, still guarded by the isSelfEcho text filter — and allow
// a retry on the next unlockAudio() call.
let ttsSink = null;        // MediaStreamAudioDestinationNode all clips connect to (null → ctx.destination)
let sinkAudioEl = null;    // keeps the playout element referenced (GC would silence the loopback)
let sinkPcs = null;        // keeps the loopback peer connections referenced (a GC'd pc closes → silence)
let sinkStarting = false;
let sinkBuild = null;      // resolves when the in-flight loopback build settles — _playBuf awaits it (bounded) so the FIRST clip doesn't race the build and play direct/un-cancelled
async function initAecLoopback(ctx) {
  if (ttsSink || sinkStarting || typeof RTCPeerConnection === 'undefined') return;
  sinkStarting = true;
  let settle; sinkBuild = new Promise((r) => (settle = r));
  const pc1 = new RTCPeerConnection(), pc2 = new RTCPeerConnection();
  try {
    const dest = ctx.createMediaStreamDestination();
    pc1.onicecandidate = (e) => { if (e.candidate) pc2.addIceCandidate(e.candidate).catch(() => {}); };
    pc2.onicecandidate = (e) => { if (e.candidate) pc1.addIceCandidate(e.candidate).catch(() => {}); };
    const played = new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('loopback timeout')), 3000);
      pc2.ontrack = (e) => {
        const el = new Audio();
        el.srcObject = e.streams[0] ?? new MediaStream([e.track]);
        el.play().then(() => { clearTimeout(t); res(el); }, (err) => { clearTimeout(t); rej(err); });
      };
    });
    dest.stream.getTracks().forEach((t) => pc1.addTrack(t, dest.stream));
    const offer = await pc1.createOffer();
    await pc1.setLocalDescription(offer);
    await pc2.setRemoteDescription(offer);
    const answer = await pc2.createAnswer();
    await pc2.setLocalDescription(answer);
    await pc1.setRemoteDescription(answer);
    sinkAudioEl = await played;
    sinkPcs = [pc1, pc2];
    // If the loopback ever dies mid-session (pc failed/closed), clips routed into the dead sink
    // would play SILENCE — unpublish it so playback falls back to direct output (and a later
    // unlockAudio() gesture can rebuild it).
    const onDead = () => {
      if (pc1.connectionState === 'failed' || pc2.connectionState === 'failed' ||
          pc1.connectionState === 'closed' || pc2.connectionState === 'closed') {
        ttsSink = null; sinkAudioEl = null; sinkPcs = null;
        try { pc1.close(); pc2.close(); } catch {}
      }
    };
    pc1.onconnectionstatechange = pc2.onconnectionstatechange = onDead;
    ttsSink = dest;          // publish only once playout is confirmed — clips route through it from now on
  } catch {
    try { pc1.close(); pc2.close(); } catch {}
    sinkAudioEl = null;      // failed (no WebRTC / autoplay-blocked) → direct playback; retry on next gesture
  } finally {
    sinkStarting = false;
    settle(); sinkBuild = null;
  }
}
export function unlockAudio() {
  try { const ctx = audioCtx(); ctx.resume(); initAecLoopback(ctx); } catch {}   // gesture context → blesses/resumes the shared AudioContext + builds the AEC sink
}

// A pre-decoded clip playing through a single AudioBufferSourceNode, exposing the small slice of the
// HTMLAudioElement surface that _playBuf / stop() / seek() rely on: paused, currentTime, duration,
// pause(), and the onended/onpause callbacks. currentTime is computed from the context clock and the
// offset the clip started at, so the live cursor and tap-to-seek math are unchanged. A buffer source
// can't be restarted, so a seek/replay just creates a new one (seek() already re-plays clips anyway).
class WebAudioClip {
  constructor(ctx, buffer, offsetSec = 0) {
    this.ctx = ctx; this.buffer = buffer; this.duration = buffer.duration;
    this.paused = false; this.ended = false; this.onended = null; this.onpause = null;
    this._fired = false; this._stopped = false;
    this._startCtxTime = ctx.currentTime; this._offset = offsetSec;
    this._node = ctx.createBufferSource();
    this._node.buffer = buffer;
    this._node.connect(ttsSink ?? ctx.destination);   // via the AEC loopback sink when available (see initAecLoopback)
    // The native onended fires once — on natural end AND on our stop(). Classify with _stopped, but
    // treat a stop() at/near the buffer's end as a natural end (a pause() racing the final samples
    // shouldn't be reported as a barge-in). _fired guards the single-shot callback (not `ended`, which
    // stays false for a stop()).
    this._node.onended = () => {
      if (this._fired) return; this._fired = true;
      const natural = !this._stopped || this.currentTime >= this.duration - 0.02;
      this.ended = natural; this.paused = true;
      try { this._node.disconnect(); } catch {}
      (natural ? this.onended : this.onpause)?.();
    };
    this._node.start(0, offsetSec);
  }
  get currentTime() { return Math.min(this._offset + (this.ctx.currentTime - this._startCtxTime), this.duration); }
  pause() { if (this.paused || this._fired) return; this._stopped = true; this.paused = true; try { this._node.stop(); } catch {} }
}

// rAF with a setTimeout fallback (non-browser/SSR/test runtimes lack requestAnimationFrame).
const raf = globalThis.requestAnimationFrame?.bind(globalThis) ?? (fn => setTimeout(() => fn(Date.now()), 16));
const caf = globalThis.cancelAnimationFrame?.bind(globalThis) ?? clearTimeout;

export class StreamingTTS {
  // `speed` is retained for API compatibility but NO LONGER applied: Web Audio playback runs at the
  // synthesized native rate (1.0) — a buffer source can't change rate without altering pitch. Tune
  // delivery speed in the synth engine instead if needed.
  // `onProgress(spokenText)` (set via setOnProgress) fires while a clip plays with the chars heard
  // SO FAR across the whole reply — drives the host's live "spoken cursor".
  constructor(voiceId, speed = 1.0) { this.voiceId = voiceId; this.speed = speed; this._audio = null; this._onProgress = null;
    this._tape = null; this._speaking = false; this._seekTarget = null; this._seekPending = false; this._curIdx = -1; }
  setSpeed(speed) { this.speed = speed; }
  setVoice(voiceId) { this.voiceId = voiceId; }
  setOnProgress(fn) { this._onProgress = fn; }
  // Eagerly prepare the synth engine (load models, JIT the inference path) so the FIRST utterance
  // doesn't pay cold-start latency mid-reply. No-op by default; providers with a heavy warm-up
  // (e.g. Piper's ONNX model download + WASM compile) override it. Safe to call repeatedly.
  async warm() {}

  // Play a pre-synthesized clip via Web Audio (decode → AudioBufferSourceNode); resolve with the chars
  // of `text` actually heard. A buffer source starts the instant the blob is decoded (no <audio> src
  // assignment / loadedmetadata wait), cutting per-clip start latency on every sentence — at the cost
  // of a pitch-preserving rate change, so playback is native 1.0x (StreamingTTS default speed).
  // `prefix` is everything already spoken in earlier sentences of this reply; we emit `prefix + heard`
  // on a rAF tick so the host gets the live spoken-so-far text for its cursor.
  // Resolves with { reason, heard }: reason is why the clip stopped — 'ended' (natural finish),
  // 'abort' (signal/barge-in), or 'seek' (a tap repositioned the playhead, see seek()); `heard` is the
  // spoken-so-far text (prefix + this clip's heard part). `startNw` starts the clip mid-sentence (a
  // forward/backward tap inside it), as a non-whitespace offset into `text`. abort always dominates seek.
  async _playBuf(wav, text, signal, prefix = '', startNw = 0) {
    if (signal?.aborted || !wav) return { reason: 'abort', heard: prefix };
    const ctx = audioCtx();
    // Decode first (works while suspended) so we don't block synthesis on resume.
    let buffer;
    try { buffer = await ctx.decodeAudioData(await wav.arrayBuffer()); }
    catch (e) { throw new Error(`Audio decode: ${e?.message || e}`); }
    // A tap or barge-in during decode has no clip to act on yet — honor it now, before we start audio.
    if (signal?.aborted) return { reason: 'abort', heard: prefix + sliceNw(text, startNw) };
    if (this._seekPending) return { reason: 'seek', heard: prefix + sliceNw(text, startNw) };
    // Now ensure the context can actually run; resume() must happen in/after a gesture (unlockAudio).
    // Bound it so a policy-blocked resume can't hang the turn forever — if it won't run, surface it.
    if (ctx.state !== 'running') {
      try { await Promise.race([ctx.resume(), new Promise((_, rej) => setTimeout(() => rej(new Error('resume timeout')), 1500))]); } catch {}
      if (ctx.state !== 'running') throw new Error('AudioContext is not running (needs a user gesture)');
    }
    // The AEC loopback build (kicked from unlockAudio) races the first reply: if the sink isn't
    // published yet, this clip would wire to ctx.destination and play UN-cancelled — the mic hears
    // it and the agent can self-interrupt on its opening sentence. Wait (bounded) for the in-flight
    // build; on timeout/failure fall through to direct playback exactly as before.
    if (!ttsSink && sinkBuild) { await Promise.race([sinkBuild, new Promise((r) => setTimeout(r, 1500))]); }
    // NO silent fallback: if this clip is about to play direct (un-cancelled — the mic will hear
    // it), tell the host once per session so the user sees WHY self-echo may happen.
    if (!ttsSink && !this._aecWarned) {
      this._aecWarned = true;
      this.onEvent?.({ type: 'diag', diag: 'aec-fallback', message: 'AEC loopback unavailable — TTS plays un-cancelled; echo is only text-filtered' });
    }
    if (signal?.aborted) return { reason: 'abort', heard: prefix + sliceNw(text, startNw) };
    const dur = buffer.duration;
    const offsetSec = startNw > 0 ? (startNw / (nw(text) || 1)) * dur : 0;   // tap-into-clip → start offset
    const clip = new WebAudioClip(ctx, buffer, offsetSec);
    this._audio = clip;
    return new Promise((resolve) => {
      // Proportional position in NON-WHITESPACE space (the same domain seek() uses) → slice `text` to that
      // many non-whitespace chars, so a seek to nw-index N lands the cursor exactly on N.
      const heard = () => sliceNw(text, Math.round(nw(text) * clip.currentTime / (dur || 1)));
      let settled = false, frame = 0;
      const tick = () => { if (settled) return; this._onProgress?.(prefix + heard()); frame = raf(tick); };
      const cleanup = () => { if (frame) caf(frame); signal?.removeEventListener('abort', onAbort); clip.onpause = clip.onended = null; };
      const finish = (reason) => { if (settled) return; settled = true; cleanup(); resolve({ reason, heard: prefix + heard() }); };
      const onAbort = () => { clip.pause(); finish('abort'); };           // barge-in wins over a pending seek
      // Natural end → onended; stop()/seek() pause() → onpause. A pending seek flag distinguishes a
      // reposition from a real interruption; abort got there first if it fired.
      clip.onpause = () => finish((this._seekPending && !signal?.aborted) ? 'seek' : 'abort');   // a barge-in (signal) that races a pending seek must still win → 'abort'
      clip.onended = () => finish('ended');
      signal?.addEventListener('abort', onAbort);
      if (signal?.aborted) return onAbort();                              // aborted between start() and listener
      if (this._onProgress) frame = raf(tick);
      // Emit the spoken-so-far prefix the moment this clip starts, so the host's cursor takes over at
      // playback start — no window where the whole answer shows solid.
      this._onProgress?.(prefix + sliceNw(text, startNw));
    });
  }

  // subclass contract — synthesize one sentence → audio Blob (null when aborted/empty)
  async _synth(_text, _signal) { throw new Error('not implemented'); }

  // Re-chunk an async iterable of text deltas into sentences. The FIRST sentence breaks on
  // the earliest natural boundary (fast first audio); the rest on whole-sentence enders
  // (better prosody). Flushes whatever's left when the stream ends.
  async *_sentences(src, signal) {
    const it = src[Symbol.asyncIterator]();
    const next = async () => { try { return await it.next(); } catch (e) { if (e.name === 'AbortError') return { done: true }; throw e; } };
    // Three-stage break progression for minimum first-audio latency on local (whole-chunk) TTS:
    //   stage 0 → first complete WORD (start talking the instant one word exists);
    //   stage 1 → rest of the first clause/sentence (earliest natural break);
    //   stage 2+ → whole sentences (best prosody; one-ahead synth hides their cost).
    const breakers = [firstWordEnd, firstSentenceEnd, sentenceEnd];
    let acc = '', stage = 0;
    for (let r = await next(); !r.done; r = await next()) {
      if (signal?.aborted) return;
      acc += r.value;
      let end;
      while ((end = breakers[Math.min(stage, breakers.length - 1)](acc)) >= 0) {
        const s = acc.slice(0, end).trim();
        acc = acc.slice(end).trimStart();
        if (s) { yield s; stage++; }
      }
    }
    const tail = acc.trim();
    if (tail) yield tail;
  }

  // `input` is an async iterable of text deltas (or a plain string).
  // Builds a TAPE — one entry per sentence ({ text, blobP, nwStart }) appended at playback pace —
  // and walks it by a playhead index. Forward play is the same low-latency, one-sentence-ahead
  // pipeline as before (synth the next clip while the current plays, one voice at a time). The tape
  // adds tap-to-seek (see seek()): a tap repositions the playhead to any sentence ALREADY on the
  // tape and plays forward from there — backward replays the cached clip (no re-synth), forward
  // skips ahead. Resolves with the heard text (high-water in non-whitespace space → history): a full
  // play returns the whole reply, a barge-in returns the prefix heard before the user cut in.
  // `fromNw` (non-whitespace offset) begins playback partway through — used to REPLAY a finished reply
  // from a tapped word. The whole reply still tapes (we synth the skipped prefix too, lazily), so a
  // backward tap within the replay hits cached clips; replies are short so the extra synth is cheap.
  async speak(input, signal, fromNw = 0) {
    if (signal?.aborted) return '';
    const src = typeof input === 'string' ? (async function* () { yield input; })() : input;
    const it = this._sentences(src, signal)[Symbol.asyncIterator]();

    const tape = this._tape = [];     // { text, blobP, nwStart } — nwStart = non-whitespace chars before it
    let nwTotal = 0, streamErr = null, streamDone = false, wake = null;
    // Single waiter slot; woken when the tape grows, the stream ends, OR we abort — so a consumer
    // parked in awaitEntry() never hangs past an abort/barge-in even if the LLM stream is slow to react.
    const bump = () => { const w = wake; wake = null; w?.(); };
    this._ttsWake = bump;             // let seek() wake a consumer parked in a stream gap (see seek())
    // Synth is serial: ONE ONNX session can't run concurrent predict()s. We chain each _synth behind
    // the previous (synthChain) so audio is produced one-at-a-time, in order — but the TEXT stream
    // (it.next(), which drives the LLM) is drained as fast as tokens arrive, decoupled from both synth
    // pace AND playback pace. That's the whole fix: generation no longer stalls sentence-by-sentence.
    let synthChain = Promise.resolve();
    const pull = async () => {
      const r = await it.next();
      if (r.done) return null;
      const prev = synthChain;
      // Each clip's synth is chained AFTER the previous one → serial synthesis (one ONNX predict at a
      // time). blobP always RESOLVES — to the wav, or to null carrying the error on the entry — so an
      // ahead-of-playback synth failure never raises unhandledrejection; the chain keeps going for the
      // rest of the reply, and the consumer re-throws entry.err only if it actually reaches this clip.
      synthChain = prev.then(() => this._synth(stripMd(r.value) || r.value, signal), () => null);   // raw text drives the cursor/seek; only the audio gets markdown stripped (|| r.value: a pure-syntax chunk strips to empty — voice the raw rather than abort the turn)
      const entry = { text: r.value, nwStart: nwTotal };
      entry.blobP = synthChain.catch((e) => { entry.err = e; return null; });
      tape.push(entry);
      nwTotal += nw(r.value);
      return entry;
    };
    // Background PRODUCER: keep draining the LLM stream independent of playback so token generation
    // never stalls sentence-by-sentence behind audio. It runs ahead, synth queues serially behind it.
    const produce = (async () => {
      try { while (!signal?.aborted) { if (!(await pull())) break; bump(); } }
      catch (e) { if (e?.name !== 'AbortError') streamErr = e; }   // LLM/iterator failure → surface via awaitEntry, not a silent truncation
      finally { streamDone = true; bump(); }
    })();
    if (signal) signal.addEventListener('abort', bump, { once: true });   // wake a parked consumer the instant we abort
    // Wait until the tape has an entry at `i` — or the stream ends, we abort, or a seek arrives (a
    // backward tap while we're parked waiting for a FUTURE clip must be honored now, not after the
    // stream advances). Producer runs ahead, so this usually returns immediately; it only blocks when
    // playback has caught up to generation.
    const awaitEntry = async (i) => {
      while (i >= tape.length && !streamDone && !signal?.aborted && !this._seekPending) await new Promise((r) => { wake = r; });
      if (streamErr) throw streamErr;
    };

    let idx = 0, startNw = 0, heardMax = 0;
    // A tap that lands while we're awaiting (synthesis or the LLM stream) has no clip to pause, so it
    // only sets _seekTarget — honor it at the next safe point. Returns true if it moved the playhead.
    const takePending = () => {
      if (!this._seekPending || !this._seekTarget || signal?.aborted) return false;
      idx = this._seekTarget.idx; startNw = this._seekTarget.startNw;
      this._seekPending = false; this._seekTarget = null;
      return true;
    };
    try {
      this._speaking = true;
      // Replay-from-word: tape forward until fromNw falls inside a sentence, then start playing there
      // (startNw = the offset within that sentence). heardMax seeds to fromNw so the replayed prefix
      // already counts as heard (a forward replay never un-hears earlier text).
      if (fromNw > 0) {
        while (!signal?.aborted) {
          const last = tape[tape.length - 1];
          if (last && fromNw < last.nwStart + nw(last.text)) break;
          if (streamDone) break;          // streamed everything and fromNw is past the end → play from the last
          await awaitEntry(tape.length);  // let the producer append the next sentence
        }
        const i = tape.findIndex(e => fromNw < e.nwStart + nw(e.text));
        if (i >= 0) { idx = i; startNw = Math.max(0, fromNw - tape[i].nwStart); heardMax = fromNw; }
      }
      while (true) {
        if (idx >= tape.length) { await awaitEntry(idx); if (takePending()) continue; if (idx >= tape.length) break; }   // wait for the producer to reach this sentence (stream end → done)
        const e = tape[idx];
        const buf = await e.blobP;
        if (e.err) throw e.err;                                 // this clip's synth failed → surface it (only when we actually reach it)
        if (takePending()) continue;                            // a tap during synth/stream gap → reposition
        this._curIdx = idx;
        const prefix = tape.slice(0, idx).map(x => x.text).join(' ') + (idx ? ' ' : '');
        this._seekPending = false; this._seekTarget = null;     // the clip about to play owns the seek channel
        const playP = this._playBuf(buf, e.text, signal, prefix, startNw);   // start (don't await yet)
        const { reason, heard } = await playP;                  // producer keeps synthesizing ahead while this clip plays
        heardMax = Math.max(heardMax, nw(heard));               // monotonic: a backward replay never un-hears
        if (reason === 'abort' || signal?.aborted) break;        // real barge-in → stop, record heard
        if (reason === 'seek') { idx = this._seekTarget.idx; startNw = this._seekTarget.startNw; this._seekPending = false; this._seekTarget = null; continue; }
        idx++; startNw = 0;                                      // natural end → next sentence
      }
    } finally {
      signal?.removeEventListener('abort', bump);
      // Wait out any synth still in flight (an ahead-of-playback clip mid-predict when we abort). Piper's
      // predict() isn't cancellable and a single ONNX session can't run two at once, so we must not
      // return while one is running — the next turn would start a second predict() on the same session.
      // Await the producer first (it may queue one last synth after the abort check), then the tail.
      await produce.catch(() => {});
      await synthChain.catch(() => {});
      this._ttsWake = null;
      this._speaking = false; this._tape = null; this._seekTarget = null; this._seekPending = false; this._curIdx = -1;
    }
    return sliceNw(tape.map(x => x.text).join(' '), heardMax);   // heard prefix in non-whitespace space
  }
  stop() { this._seekPending = false; this._seekTarget = null; try { this._audio?.pause(); } catch {} }

  // Move the playhead to a position in the whole reply (a non-whitespace char count — the same
  // whitespace-invariant key the host's cursor uses, so the rendered answer and the clips agree
  // regardless of the model's spacing) and play forward from there. Any tap (even inside the clip now
  // playing) interrupts the current clip (reason 'seek') so speak() repositions and re-plays from the
  // tapped offset — a Web Audio buffer source can't seek in place. Backward hits the
  // cached blob, forward skips ahead. Returns false when the target isn't on the tape yet
  // (not-yet-streamed/partial text) — the host leaves playback as-is.
  seek(nwIndex) {
    const tape = this._tape;
    if (!this._speaking || !tape || !tape.length || nwIndex < 0) return false;
    const i = tape.findIndex(e => nwIndex < e.nwStart + nw(e.text));
    if (i < 0) return false;                                     // beyond streamed text
    const e = tape[i], localNw = Math.max(0, nwIndex - e.nwStart);
    const a = this._audio;
    // Every seek (even within the clip now playing) interrupts + repositions: a Web Audio buffer
    // source can't be re-positioned in place, so we re-play the target clip from the tapped offset
    // (startNw). speak() catches the 'seek' reason, sets idx/startNw, and _playBuf starts at that offset.
    this._seekTarget = { idx: i, startNw: localNw };
    this._seekPending = true;
    try { a?.pause(); } catch {}                                 // → onpause resolves current clip as 'seek'
    this._ttsWake?.();                                           // a tap during a stream gap (no clip playing) → wake the parked consumer to honor it
    return true;
  }
}

// ── Piper TTS (local WASM, free, has Hungarian) via @mintplex-labs/piper-tts-web.
//    Default voice: en_US-joe-medium.
const CDN_PIPER = `${CDN}@mintplex-labs/piper-tts-web@1.0.4/dist/piper-tts-web.js`;
export class PiperTTS extends StreamingTTS {
  constructor(voiceId = 'en_US-joe-medium', speed = 1.0) { super(voiceId, speed); }
  // webpackIgnore is honored by webpack AND Turbopack (vite needs its own marker) — without it
  // bundlers rewrite this into their runtime require, which can't load a URL
  // ("turbopack_context.x is not a function").
  async _tts() {
    return this._lib ??= (async () => {
      // Piper imports a bare "onnxruntime-web" specifier resolved via the importmap that
      // loadVoiceDeps() installs — ensure it exists before the module loads.
      if (typeof document !== 'undefined' && !document.getElementById('vl-importmap')) {
        const { loadVoiceDeps } = await import('./deps.js'); await loadVoiceDeps();
      }
      return import(/* webpackIgnore: true */ /* @vite-ignore */ CDN_PIPER);
    })();
  }

  // List installable Piper voices: [{ id, name, language }]. `id` is what you pass as
  // `voiceId` (lib calls it `key`). Lets the UI build a voice picker; switch with setVoice.
  async voices() {
    const list = await (await this._tts()).voices();              // [{ key, name, language: { code, … }, … }]
    return list.map(v => ({ id: v.key, name: v.name || v.key, language: v.language?.code || v.language || '' }));
  }

  // A TtsSession for the current voice. The lib's `predict()` reuses a module-level singleton
  // (`TtsSession._instance`) and on a voice change only overwrites its `.voiceId` WITHOUT
  // re-running init() — so the old ONNX model keeps speaking. Build (and cache) our own session,
  // null-ing that singleton first so a changed voice truly reloads its model.
  async _session() {
    const lib = await this._tts();
    if (this._sess && this._sessVoice === this.voiceId) return this._sess;
    lib.TtsSession._instance = null;
    this._sessVoice = this.voiceId;
    // Override the lib's DEFAULT_WASM_PATHS: its baked-in onnxWasm points at cdnjs onnxruntime-web
    // 1.18.0, but our importmap resolves `onnxruntime-web` to 1.22.0 — whose loader fetches
    // ort-wasm-simd-threaded.jsep.mjs, a file the 1.18.0 cdnjs folder doesn't have (404 →
    // "no available backend found"). Point the WASM path at the SAME version/CDN as the import.
    // wasmPaths replaces the whole object (no merge), so restate the piper phonemize paths too.
    return this._sess = await lib.TtsSession.create({ voiceId: this.voiceId, wasmPaths: {
      onnxWasm: `${CDN}onnxruntime-web@1.22.0/dist/`,
      piperData: `${CDN}@diffusionstudio/piper-wasm@1.0.0/build/piper_phonemize.data`,
      piperWasm: `${CDN}@diffusionstudio/piper-wasm@1.0.0/build/piper_phonemize.wasm`,
    } });
  }

  // Eagerly download+compile the ONNX model and JIT the WASM inference path, so the first real reply
  // isn't stalled by Piper's cold start (model fetch + compile + first-inference warm-up) AFTER the LLM
  // has already produced text. Called when the agent starts listening — the model loads while the user
  // is still speaking. A throwaway predict primes the inference path; failures are non-fatal (the first
  // real _synth retries). Idempotent: _session() caches, so a second warm() is cheap.
  async warm() {
    try { await (await this._session()).predict('.'); } catch {}
  }

  // Synthesize text → WAV Blob (the slow part; run it ahead of playback).
  async _synth(text, signal) {
    if (signal?.aborted || !text) return null;
    const wav = await (await this._session()).predict(text);   // Blob
    return signal?.aborted ? null : wav;
  }
}
