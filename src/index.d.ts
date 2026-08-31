// Public types for voiceloop — VAD → STT → LLM → TTS with real barge-in.
// Hand-written (the source is plain JS); see README.md for the prose version of every option.

// Events the agent emits on `onEvent` — discriminated on `type` so a switch narrows the rest.
export type VoiceAgentEvent =
  | { type: 'state'; state: 'idle' | 'listening' | 'thinking' | 'speaking' }
  | { type: 'stt'; turnComplete: boolean; text: string; ms: number; committed?: string }  // text=live tail; committed=locked segments (Speechmatics AddTranscript); turnComplete=user turn ended → send to LLM
  | { type: 'assistant'; text: string; final: boolean; full?: string }   // text=spoken-so-far (solid, advances live as TTS plays); full=complete answer → tail full.slice(text.length) not-yet-spoken (dim)
  | { type: 'vad'; active: boolean }                                      // VAD hears speech?
  // Mic loudness, 0..1 on a perceptual curve, ~every 256ms while capturing. Cosmetic only (meters,
  // a reacting orb) — nothing in the pipeline reads it. Never emitted for a selfCapture STT
  // (webspeech owns its own mic, so there are no frames to measure).
  | { type: 'level'; level: number }
  // running:true = loop call announced, executing now (display-only spinner; no result yet).
  // The outcome event follows with the same `id` and replaces it in place.
  | { type: 'tool'; name: string; args: Record<string, unknown>; result?: unknown; id?: string; running?: true }
  | { type: 'echo'; text: string }                                        // dropped self-echo (the agent's own TTS leaked into the mic) — diagnostics only
  | { type: 'diag'; diag: 'aec-fallback'; message: string }               // once/session: AEC loopback failed → TTS plays un-cancelled (self-echo only text-filtered)
  | { type: 'diag'; diag: 'presynth'; text: string }                      // a reply's first clip was synthesized speculatively (latency diagnostics)
  // Did that speculation pay off? hit = the real reply opened with the presynthesized text (clip
  // reused, latency saved); miss = it didn't (clip discarded). `pre` is what we had guessed.
  | { type: 'diag'; diag: 'presynth-hit' | 'presynth-miss'; text: string; pre: string }
  | { type: 'error'; error: string };

export interface VoiceTool {
  description?: string;
  params?: Record<string, unknown>;   // JSON-schema `properties` for the arguments
  /** Which `params` the model MUST supply. Defaults to ALL of them — set this to make some
   *  optional, otherwise the model is forced to invent a value for every field. */
  required?: string[];
  /** A tool with no `run` is dropped, never advertised: the model would call it, nothing would
   *  happen, and the transcript would still show it as having run — a silent lie. */
  run?: (args: Record<string, unknown>) => unknown;
}

// One LLM delta: either spoken text, or a single tool call (args already parsed). Agent-loop tool
// chunks additionally carry the provider call `id` (two same-args calls, e.g. a retry, stay distinct
// acts) and the outcome (`result`/`error`) — the loop already executed the tool, so the agent
// reports it instead of running it again.
export type LLMChunk =
  | { text: string }
  | { tool: string; id?: string; args: Record<string, unknown>; result?: unknown; error?: string; running?: true };
// Pluggable LLM: lazy async generator over the chat history (fetch fires on first pull).
// The default (makeOpenAILLM) yields bare tool chunks that the AGENT executes; the results are not
// fed back into it mid-turn, so such calls are terminal for the turn. That is the low-level seam.
// An agent LOOP that runs tools inside its own generator declares the two flags below.
export interface LLM {
  (
    history: Array<{ role: string; content: string }>,
    system: string,
    signal: AbortSignal,
    options?: { toolGate?: Promise<unknown> },
  ): AsyncIterable<LLMChunk>;
  /** This generator ran the tool itself: chunks carry `result`/`error` and the agent REPORTS them
   *  instead of executing again. Without it, an outcome-bearing chunk is re-run. */
  executesTools?: boolean;
  /** This generator awaits `options.toolGate` before ANY tool executes. Required to keep
   *  speculative prefetch on: prefetch starts from an uncommitted interim, and the gate is what
   *  stops a speculation from firing a real side effect. `executesTools` without this silently
   *  disables prefetch (see voice-agent.js:793). */
  acceptsToolGate?: boolean;
}

// Pluggable TTS contract. `speak` resolves with the text actually HEARD (full on completion,
// a prefix on barge-in). The optional members back the voice picker / switching.
/** (spokenSoFar, scope) — see VoiceTTS.setOnProgress. */
export type TtsProgress = (spokenText: string, scope: string) => void;

export interface VoiceTTS {
  speak(input: AsyncIterable<string> | string, signal?: AbortSignal, fromNw?: number): Promise<string>;
  stop?(): void;
  /** Eagerly prepare the synth engine (load models, JIT) so the first utterance has no cold start. */
  warm?(): Promise<void>;
  voices?(): Promise<Array<{ id: string; name: string; language: string }>>;
  setVoice?(voiceId: string): void;
  setSpeed?(speed: number): void;
  /** Register a callback fired while a clip plays with the chars spoken SO FAR across the whole
   *  reply — drives the host's live spoken cursor. Pass null to clear.
   *  `scope` is that prefix PLUS the whole clip now playing: the cursor lags real audio, so echo
   *  suppression judges against this upper bound rather than the spoken text. */
  setOnProgress?(fn: TtsProgress | null): void;
}

export interface VoiceAgentOptions {
  sysmsg?: string;
  /** Persona/system prompt prepended to the conversation context. Defaults to the built-in
   *  voice persona (VOICE_SYSMSG); pass your own agent's system message to override it. */
  persona?: string;
  /** LLM model id sent to the backend `/llm` route; empty → the backend's VOICE_MODEL default. */
  model?: string;
  llm?: LLM;
  /** Transport seam for the built-in LLM adapter; defaults to global fetch. For tests and hosts
   *  that must wrap every request (auth refresh, tracing). Unused when you pass your own `llm`. */
  fetchFn?: typeof fetch;
  apiKey?: string;
  /** Full endpoint URLs, not a base: voiceloop composes no routes, so a host can point the LLM and
   *  the STT token at unrelated origins (a backend proxy for one, a direct provider for the other).
   *  Deriving `${baseUrl}/llm` + `${baseUrl}/stt/<provider>-token` is the HOST's job — and each STT
   *  provider mints its own token type, so one shared token URL cannot serve all of them. */
  llmUrl?: string;
  maxTokens?: number;
  tts?: VoiceTTS;
  /** Speaking speed for the default Piper TTS (1.2 → 20% faster). Ignored if `tts` is passed. */
  speed?: number;
  sttLang?: string;
  micDeviceId?: string;
  /** STT backend: 'webspeech' (default — the browser's own on-device SpeechRecognition; free, no
   *  token, no socket, captures its own mic) | 'speechmatics' | 'elevenlabs' (Scribe) | 'deepgram'
   *  (Flux — native model-based end-of-turn detection; the agent feeds it the full mic stream and
   *  lets it close turns itself). The cloud ones connect the browser DIRECTLY to the provider with a
   *  short-TTL token the backend mints (raw key stays server-side).
   *  'webspeech' auto-downgrades to a cloud provider in browsers with no SpeechRecognition (Firefox,
   *  the Linux WebKitGTK desktop webview) — read `agent.sttProvider` for what's actually running. */
  sttProvider?: SttProvider;
  /** ONE endpoint that mints the token. When each provider needs a different route or credential,
   *  use `getSttToken` instead — it is handed the resolved provider, so the downgrade rule above
   *  stays in this library instead of being mirrored by every host. */
  sttTokenUrl?: string;
  /** Mint a short-TTL STT token yourself, for auth that doesn't fit one POST route. Called with the
   *  provider actually RUNNING (post-downgrade), never the requested one. Wins over sttTokenUrl. */
  getSttToken?: (provider: SttProvider) => Promise<SttToken>;
  /** POST route that receives metered STT seconds: `{ seconds, provider, ... }`, batched and
   *  fire-and-forget (failures are swallowed — billing telemetry never breaks the pipeline).
   *  Omit it and nothing is reported. Cloud providers only; the browser's own STT is free. */
  sttUsageUrl?: string;
  /** Override the provider's realtime WS endpoint (self-hosted/regional gateways). Default: the
   *  provider's public URL. */
  sttUrl?: string;
  /** Provider STT model id (e.g. Deepgram's flux variants); empty → the provider's default.
   *  Dropped when the provider downgrades, since a model id is meaningless across providers. */
  sttModel?: string;
  /** Deepgram Flux end-of-turn confidence (0.5–0.9) — its model closes the turn itself once its
   *  confidence the user is done exceeds this threshold. Lower = snappier turn ends, higher = more
   *  patient across mid-thought pauses. Deepgram-only; default from tuning.js (0.7). */
  sttEotThreshold?: number;
  /** Every tool the model may call. voiceloop ships NO built-in tools — a voice library has no
   *  business knowing what a "todo" is — so product tools (and their `run`) are supplied here. */
  tools?: Record<string, VoiceTool>;
  /** Domain words to bias cloud STT towards ("Kubernetes", product names) — the fix for jargon
   *  transcribed phonetically. Silently trimmed to 50 terms of ≤20 chars. Cloud providers only. */
  keyterms?: string[];
  /** Audio chunks retained BEFORE the VAD fires, prepended to the utterance so the first syllable
   *  isn't clipped (VAD confirms speech a beat after it starts). Default TUNING.PREROLL_CHUNKS. */
  preroll?: number;
  /** Passed through to Silero VAD (thresholds, frame sizes) — see tuning.js for the defaults. */
  vadOptions?: Record<string, unknown>;
  /** Semantic end-of-turn hook run when VAD hears end-of-speech: return false to KEEP listening (the
   *  user only paused mid-thought), true (default, when omitted) to close the turn. Lets you swap the
   *  "is the turn over?" decision (silence-only | SLM | smart-turn) without touching the STT pipeline. */
  turnDetector?: (text: string) => boolean | Promise<boolean>;
  /** Hard cap (ms) a turnDetector may keep a turn open across a pause before it's force-committed, so a
   *  user who stops mid-sentence can't hang the turn forever. Default 4000. Ignored without a detector. */
  maxPauseMs?: number;
  /** Min transcribed chars of the user's interim (heard WHILE the agent is speaking) needed to count as a
   *  real barge-in and cut the reply. Higher = short backchannels ("mhm","yeah") don't interrupt; 0 =
   *  any transcribed char interrupts. Default 3 (see tuning.js TUNING.BARGE_IN_MIN_CHARS). */
  bargeInMinChars?: number;
  onEvent?: (event: VoiceAgentEvent) => void;
}

/** Call from a user-gesture handler (e.g. the mic button click) to bless the shared TTS audio
 *  element on mobile — without this, iOS rejects the async play() of synthesized speech. */
export function unlockAudio(): void;
/** Pre-build the Silero v5 VAD ONNX session (no mic) so the first start() reaches 'listening'
 *  much faster. Best-effort + memoized; requires the vad-web UMD bundle already loaded. */
export function warmVad(): Promise<void>;
/** Pre-mint + cache the short-TTL Deepgram STT token off the critical path (e.g. at mic-button
 *  mount), so a voice start only pays the WS handshake. Best-effort + deduped; no-op while a
 *  fresh cached token remains.
 *  `sttTokenUrl` is the EXACT endpoint that mints a Deepgram token (e.g. `/api/v1/stt/deepgram-token`),
 *  the same value passed as the `sttTokenUrl` option — NOT an API base. A host that mints tokens
 *  itself passes its `getSttToken` as `getToken` and can skip the URL entirely (warm for the
 *  provider it will actually run: `() => getSttToken('deepgram')`). Warming with the wrong URL
 *  silently no-ops the optimization: the real session just mints again on click. */
export function warmDeepgramToken(sttTokenUrl?: string, apiKey?: string, getToken?: () => Promise<SttToken>): Promise<void>;
/** The built-in default voice persona (system prompt): terse, speakable answers. Exported so a
 *  host can reuse or extend it instead of restating the "you are being spoken aloud" rules. */
export const VOICE_SYSMSG: string;
/** Language codes the agent can instruct the LLM to reply in, code → English name. The `sttLang`
 *  values that actually steer the reply language — exported so a host builds its language picker
 *  from this instead of hand-listing a subset that silently rots as the map grows. */
export const LANG_NAMES: Record<string, string>;


export class VoiceAgent {
  constructor(options?: VoiceAgentOptions);
  /** The live conversation the LLM sees. A mutable reference the host may read and push into —
   *  carrying it over is how a hot-restart (e.g. a language switch) keeps the conversation. */
  history: Array<{ role: string; content: string }>;
  start(deviceId?: string): Promise<void>;
  /** Pause: stop replying/listening but KEEP the mic stream + audio graph + VAD model warm, so a later
   *  start() of this same agent resumes instantly (no mic prompt, no VAD cold start). Use destroy() to
   *  fully release the mic when ending the session. */
  stop(): void;
  /** End for real: pause + release the mic, audio graph and VAD model (turns off the OS mic indicator).
   *  Call this when dropping the agent reference so a paused-but-discarded agent never leaks the mic. */
  destroy(): void;
  listVoices(): Promise<Array<{ id: string; name: string; language: string }>>;
  setVoice(voiceId: string): void;
  setSpeed(speed: number): void;
  /** Update the host context (e.g. a re-opened chat); applies from the next turn — no restart. */
  setSysmsg(sysmsg?: string): void;
  /** Mute/unmute the mic (disables the stream's audio tracks → silence to VAD+STT); keeps the pipeline live. */
  setMuted(muted: boolean): void;
  /** Mute/unmute the AI's spoken output (TTS): the reply still streams as text but is never voiced. */
  setTtsMuted(muted: boolean): void;
  /** Move the playhead to a position in the current reply (non-whitespace char count) and play forward
   *  from there. Hits any already-streamed sentence (backward replay is cached, forward skips ahead);
   *  beyond streamed text is a no-op. Returns true on a hit, false otherwise. */
  seek(nwIndex: number): boolean;
  /** Re-speak a FINISHED reply from `fromNw` (a non-whitespace offset — the tapped word), interruptibly.
   *  Pure TTS (no LLM, no history change). `onProgress(spokenSoFar, done)` is driven by the host so it can
   *  update the exact transcript message it tapped: spokenSoFar is the spoken prefix, done flips true when
   *  the replay ends (played out, barged-in, or superseded) with spokenSoFar = the whole reply. */
  replay(text: string, fromNw?: number, onProgress?: (spokenSoFar: string, done: boolean) => void): Promise<void>;
  /** Cut off the current in-flight turn (abort the LLM, stop TTS) without stopping the agent —
   *  the mic keeps listening. No-op when not thinking/speaking. A host-callable barge-in. */
  interrupt(): void;
  /** Hold: keep listening/transcribing into history but DON'T reply. Entering hold silences the
   *  current reply (kept as the full streamed answer so far); releasing flushes all accumulated
   *  turns through the LLM in one go. */
  setHeld(held: boolean): void;
  /** Inject an out-of-band turn (e.g. a background TODO finished): speaks a reply. No-op once stopped. */
  notify(text: string): Promise<void>;
  /** Send a typed user turn (renders as a user bubble, then the agent replies in the background).
   *  Needs no mic — accepts even while paused/stopped (revives the reply loop; start() re-arms audio
   *  separately). Returns true when accepted (sent or queued while held), false for blank text or
   *  once destroy()ed (terminal). */
  sendUserText(text: string): boolean;
  /** Diagnostic tap: the last ~30s of the exact audio handed to STT as a 16kHz mono WAV, plus any
   *  detected delivery stalls (wall-clock gaps between capture chunks; offsets relative to the WAV).
   *  Play it back after a bad transcription run: gaps/corrupt audio → capture layer; clean audio →
   *  provider-side. */
  dumpAudio(): { wav: Blob; gaps: Array<{ atSample: number; atSec: number; gapMs: number }>; seconds: number };
  state: 'idle' | 'listening' | 'thinking' | 'speaking';
  /** The STT provider actually in use — differs from the requested one when 'webspeech' was
   *  downgraded to a cloud provider (browser without SpeechRecognition). */
  readonly sttProvider: 'webspeech' | 'speechmatics' | 'elevenlabs' | 'deepgram';
  /** True once the pipeline has been torn down (stop() or a fatal STT error self-stopped it). */
  readonly closed: boolean;
}

export class PiperTTS implements VoiceTTS {
  constructor(voiceId?: string, speed?: number);
  voices(): Promise<Array<{ id: string; name: string; language: string }>>;
  setVoice(voiceId: string): void;
  setSpeed(speed: number): void;
  speak(input: AsyncIterable<string> | string, signal?: AbortSignal, fromNw?: number): Promise<string>;
  stop(): void;
  /** Eagerly download+compile the ONNX model and JIT the WASM path so the first reply has no cold start. */
  warm(): Promise<void>;
}

// ── STT providers ────────────────────────────────────────────────────────────────────────────
// A provider is a factory: it receives the callbacks below plus its own credentials/tuning, and
// returns a live session. VoiceAgent wires these itself — call them directly only when embedding
// STT without the agent.
export interface STTCallbacks {
  onPartial?: (text: string, ms: number, committed?: string) => void;
  onFinal?: (text: string, ms: number) => void;
  onError?: (error: unknown) => void;
  onFatal?: (error: unknown) => void;
  onClose?: () => void;
  isClosed?: () => boolean;
}
/** A live STT session. The capability flags tell the agent how much of the audio path the provider
 *  owns, so it builds only the missing half — a provider with its own mic and its own end-of-turn
 *  (WebSpeech) needs no VAD/capture pipeline at all. */
export interface STTSession {
  /** Provider owns the mic → the agent builds no capture pipeline. Implies nativeEOT. */
  selfCapture?: boolean;
  /** Provider closes turns itself (unsolicited onFinal) → the agent runs no VAD-commit. */
  nativeEOT?: boolean;
  /** Provider wants the full mic stream, including silence (its EOT model needs real pauses). */
  continuous?: boolean;
  /** Pre-open the socket (token + handshake) so the first utterance isn't stalled. Idempotent. */
  open?(): void;
  /** Push PCM. Opens the socket lazily if `open()` was never called. */
  feed?(pcm: Int16Array): void;
  /** End of utterance: ask the provider to finalize. No-op providers with nativeEOT. */
  commit?(): void;
  /** Mute/unmute without tearing the session down (selfCapture providers). */
  setEnabled?(enabled: boolean): void;
  close(): void;
}
export type STTFactory = (opts: STTCallbacks & Record<string, unknown>) => STTSession;

/** The built-in STT provider ids — the keys of STT_PROVIDERS. */
export type SttProvider = 'webspeech' | 'speechmatics' | 'elevenlabs' | 'deepgram';
/** What a token minter returns: the short-TTL credential, plus its lifetime in seconds when the
 *  provider reports one (used to cache and pre-mint just before expiry). */
export interface SttToken { token: string; expires_in?: number }

export const STT_PROVIDERS: Record<SttProvider, STTFactory>;
/** Does this provider own the mic and its own end-of-turn? Then the agent builds NO capture pipeline
 *  and runs no VAD for it — so it emits no `vad` events, and prewarming the VAD/ONNX model is a
 *  wasted download. Answerable without constructing a session, so a host can decide both up front. */
export function sttSelfCaptures(provider: string): boolean;
export function makeDeepgramSTT(opts: STTCallbacks & Record<string, unknown>): STTSession;
export function makeElevenLabsSTT(opts: STTCallbacks & Record<string, unknown>): STTSession;
export function makeSpeechmaticsSTT(opts: STTCallbacks & Record<string, unknown>): STTSession;
export function makeWebSpeechSTT(opts: STTCallbacks & Record<string, unknown>): STTSession;
/** Web Speech exists only in Chromium/Safari; elsewhere 'webspeech' resolves to this cloud provider. */
export const WEBSPEECH_FALLBACK: 'elevenlabs';
export function webSpeechSupported(): boolean;
/** The provider id actually used: 'webspeech' downgrades to WEBSPEECH_FALLBACK in a browser
 *  without SpeechRecognition. Call it to label the UI ("using cloud recognition") — but NOT to pick
 *  a token route: `getSttToken` is already handed the resolved id. */
export function resolveSttProvider(id: string): SttProvider;

// ── TTS ──────────────────────────────────────────────────────────────────────────────────────
/** Base class for streaming TTS engines: sentence-splits the incoming token stream, synthesizes
 *  the next clip while the current one plays, and reports the spoken cursor via setOnProgress.
 *  Subclass and implement `_synth` to add an engine. */
export class StreamingTTS implements VoiceTTS {
  constructor(voiceId?: string, speed?: number);
  /** THE subclass contract: synthesize one sentence → audio Blob (null when aborted/empty).
   *  Honour `signal` — a barge-in aborts mid-clip and the base class won't wait for you. */
  protected _synth(text: string, signal?: AbortSignal): Promise<Blob | null>;
  speak(input: AsyncIterable<string> | string, signal?: AbortSignal, fromNw?: number): Promise<string>;
  stop(): void;
  setOnProgress(fn: TtsProgress | null): void;
  /** Jump playback to a position in the current reply (non-whitespace char count, as everywhere
   *  else). Returns false when the seek can't be honoured (nothing playing, or past the text
   *  streamed so far) — check it before moving a cursor. */
  seek(nwIndex: number): boolean;
}
/** Human-grade cloud voices. Pass `ttsUrl` (your backend proxy, key stays server-side); `apiKey`
 *  talks to ElevenLabs directly and is dev-only. */
export class ElevenLabsTTS extends StreamingTTS {
  constructor(options?: { ttsUrl?: string; apiKey?: string; voiceId?: string; modelId?: string; format?: string });
  warm(): Promise<void>;
}

// ── LLM ──────────────────────────────────────────────────────────────────────────────────────
/** Any OpenAI-compatible /chat/completions endpoint as an LLM adapter, with tool-calling wired
 *  to the `tools` map. `ttsUrl`-style proxying applies: prefer a backend route over apiKey. */
export function makeOpenAILLM(options?: {
  llmUrl?: string; apiKey?: string; model?: string; maxTokens?: number;
  tools?: Record<string, VoiceTool>; fetchFn?: typeof fetch; extraBody?: Record<string, unknown>;
}): LLM;

// ── Warmup & helpers ─────────────────────────────────────────────────────────────────────────
/** Load the VAD/ONNX runtime bundles (memoized). `prewarmVoice` additionally compiles the VAD
 *  session — call it while your UI is idle so the first start() is instant. */
export function loadVoiceDeps(): Promise<unknown>;
export function prewarmVoice(): void;
/** Every latency/sensitivity constant (VAD thresholds, barge-in chars, prefetch window, echo
 *  match threshold). Mutate before constructing an agent to retune globally. */
export const TUNING: Record<string, any>;
/** Echo filtering internals, exported for tests and custom mic gating: `isSelfEcho` decides
 *  whether heard text is the agent's own voice, `novelChars` counts what is genuinely new. */
export function isSelfEcho(heard: string, reply: string, options?: { threshold?: number; window?: number; minHits?: number }): boolean;
export function novelChars(heard: string, reply: string): number;
/** Render a tool result the way the agent reports it to the model (and to `tool` events). */
export function toolResultText(result: unknown): string;
