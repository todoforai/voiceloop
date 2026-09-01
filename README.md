# voiceloop

**The fastest voice agent loop in the browser**

### ▶︎ [Try the live demo](https://todoforai.github.io/voiceloop/) — no keys, no install, runs in your tab

## Why

I just couldn't find a solution that actually creates the fluid JARVIS feel in the browser (and it's crazy that it's 2026, not 2010, and there's still no really good one).

Everybody should have the best voice loop. That's why we created this, and we'll keep pushing the limits here — observations and contributions welcome, let's push the boundaries together!

## Features

A zero-dependency JavaScript library that runs the full voice loop — **VAD → STT → LLM → TTS** — with the hard parts already solved:

- **Real barge-in** — triggers on transcribed *novel words*, not mic energy, so the agent's own voice never cuts it off.
- **Self-echo filtering** — 0 self-interruptions with AEC off (Pipecat cut itself 20/30, OpenAI Realtime 17/30 [bench](bench/results/RESULTS.md#scenario-echo-smalltalk--speakermic-coupling-15db--30ms)).
- **First audio <1s** — TTS speaks sentence 1 while the LLM writes sentence 2, and the LLM call starts speculatively during your end-of-turn pause.
- **Serialized turns** — rapid-fire turns, tool results, holds and replays can never talk over each other. Locked in by 178 tests.
- **Local-first** — Silero VAD and Piper TTS run as WASM in the tab: free, no cloud round-trip (CDN, then cache).

Extra
- **Tap-to-seek** — click anywhere in the transcript to jump the voice there, backward or forward.

Key: in browser voice agent that just works properly. 

Everything is pluggable: any OpenAI-compatible LLM (or a custom async generator), STT (Web Speech, ElevenLabs Scribe, Deepgram Flux, Speechmatics), swappable TTS.

## Quick start

```sh
npm i @todoforai/voiceloop
```

```js
import { VoiceAgent, unlockAudio, prewarmVoice } from '@todoforai/voiceloop';

prewarmVoice(); // optional but recommended: preload VAD/WASM while your UI sits idle

const agent = new VoiceAgent({
  // Any OpenAI-compatible /chat/completions endpoint. In production point this at
  // YOUR proxy route — never ship a provider secret key to the page.
  llmUrl: '/api/chat/completions',
  model: 'claude-haiku-4-5',   // voice wants first-token speed — use the fastest model your endpoint serves

  persona: 'You are a friendly cooking assistant.',
  sysmsg: 'The user is on the recipes page.',   // live context, update via setSysmsg()

  onEvent: (e) => {
    // stt: e.committed = locked prefix, e.text = live tail (on turnComplete, e.text is the whole turn)
    if (e.type === 'stt')       render.user(e.turnComplete ? e.text : `${e.committed ?? ''} ${e.text}`.trim(), e.turnComplete);
    if (e.type === 'assistant') render.agent(e.text, e.full);   // e.text = spoken so far, e.full = whole answer
    if (e.type === 'state')     render.state(e.state);          // idle|listening|thinking|speaking
    if (e.type === 'error')     console.error(e.error);
  },
});

// From a click handler (browsers require a gesture for audio + mic):
button.onclick = async () => {
  unlockAudio();
  await agent.start();
};
```

That's it. Speak, get spoken answers, interrupt at will.

## The demo

**[todoforai.github.io/voiceloop](https://todoforai.github.io/voiceloop/)** starts in echo mode —
browser Web Speech STT, local Piper TTS, a stand-in "LLM" that repeats you — so it costs nothing
and needs no backend. THIS is not the BEST configuration (deepgram STT + elevenlabs flash TTS). the best goes from 2100ms -> 900ms, that's where it start to be LIVE! 

It shows the two numbers that decide whether an agent feels alive (**first token**, **first sound**), and click-to-interrupt strikes through the words you cut off.
Open *settings* to switch to a pipeline STT provider (Web Speech bypasses voiceloop's VAD→STT
path) and point it at any OpenAI-compatible endpoint (Ollama, your proxy).

Run it locally against your own LLM:

```sh
npx serve .                                    # from a clone
npx serve node_modules/@todoforai/voiceloop    # from npm — then open index.html
```

`file://` won't work — mic and module imports need `http://localhost` or https.
Start reading at [`examples/simple-browser.html`](examples/simple-browser.html): the same loop, no UI, ~100 lines.

## How the latency adds up

```
you stop speaking ──┐
                    │  end-of-turn debounce (500ms configured; ~1.5s in practice
                    │  on browser STT — see the webspeech note below)
   LLM prefetch ────┤  ← already streaming since your interim transcript stabilized
                    │
first LLM tokens ───┤  first sentence boundary (~8+ chars)
                    │  Piper synthesizes sentence 1 while sentence 2 streams in
first audio ────────┘  next sentences pre-synthesized during playback → zero gaps
```

**Measured, not claimed**: [voice-agent-bench](https://github.com/todoforai/voice-agent-bench)
(developed here at `bench/`, split to its own repo) is a black-box rig — audio in → audio out, zero
integration — that scores voiceloop and competing stacks on the same scripted conversations
and the same fixed mock LLM. Reply latency (voice→voice median), and how often the system
misbehaves — talks over a hesitating user, or cuts its own reply when its voice echoes back
into the mic (no AEC):

| system | latency (clean) | talked through user | cut itself under echo |
|---|---|---|---|
| OpenAI Realtime (own LLM)* | 870ms | **0/30** | **17/30** |
| **voiceloop** (deepgram + ElevenLabs flash) | **980ms** | **0/30** | **0/30** |
| **voiceloop** (deepgram + Piper, free local TTS) | **970ms** | **0/30** | — |
| **voiceloop** (webspeech + Piper, zero-key default) | 2110ms | — | — |
| Pipecat 1.8.1 (same providers) | 1050ms | 2/30 | **20/30** |
| ElevenLabs ConvAI | 1450ms | **0/30** | 0/30 |

The separating failure is echo: with no AEC, the other fast stacks hear their own voice as the
user and cut their own replies. voiceloop's word-level echo filter runs echo-coupled turns at
full speed (930ms — parity with clean).

\* Realtime is speech-to-speech, so it can't use the bench's fixed mock LLM — not fully apples-to-apples.

Full tables, method, reproduction: [`results/RESULTS.md`](https://github.com/todoforai/voice-agent-bench/blob/master/results/RESULTS.md).

## STT providers

```js
new VoiceAgent({ sttProvider: 'webspeech' })     // default: zero-key, browser-native (Chrome/Safari) — but ~1.2s slower to close a turn; see the table below
new VoiceAgent({ sttProvider: 'elevenlabs',  sttTokenUrl: '/api/stt/token' })
new VoiceAgent({ sttProvider: 'deepgram',    sttTokenUrl: '/api/stt/token' })
new VoiceAgent({ sttProvider: 'speechmatics', sttTokenUrl: '/api/stt/token' })
```

Cloud providers authenticate with a **short-TTL token minted by your backend** so the raw API key never reaches the page. Either:

- `sttTokenUrl` — a POST route on your server that returns `{ token }` (mint it against the provider's temp-token API with your secret key — a complete single-file Cloudflare Worker doing exactly this for Deepgram, plus ElevenLabs TTS and LLM proxies with rate limits, is in [`examples/token-worker/`](examples/token-worker/)), or
- `getSttToken` — an async callback `(provider) => ({ token })` when your auth doesn't fit a bare POST, or when each provider mints a different credential. It is handed the provider actually running (after the fallback below), so you pick the route without re-deriving that rule:

```js
const ROUTE = { elevenlabs: '/api/stt/token', deepgram: '/api/stt/deepgram-token' };
new VoiceAgent({ sttProvider, getSttToken: p => fetch(ROUTE[p], { method: 'POST' }).then(r => r.json()) })
```

On browsers without SpeechRecognition (Firefox, WebKitGTK) `webspeech` falls back to `elevenlabs` — which needs a token route configured, so pass `sttTokenUrl`/`getSttToken` if you want the fallback to work.

**On iOS, prefer a cloud STT provider.** Safari has shipped `webkitSpeechRecognition` since 14.5, but the
implementation is unreliable for a continuous agent loop: recognition often goes silent after the first
utterance without firing `onend` or `onerror`, playing audio in the same page can kill it the same way, and
iOS ducks the speakers while the recognizer holds the mic — which is exactly what a talking agent needs.
`webspeech` is a fine zero-key default on desktop Chrome; on phones, point `sttProvider` at `elevenlabs`,
`deepgram` or `speechmatics` so voiceloop owns the mic and its own VAD/echo path.

| Provider | End-of-turn | Notes |
|---|---|---|
| `webspeech` | Native (browser-managed) | Zero-key (no token endpoint), Chrome/Safari only. **~2.1s voice→voice** — ~1.2s slower to close a turn than cloud STT ([measured](bench/results/RESULTS.md)); it also owns the mic, so voiceloop's VAD/echo pipeline is bypassed. Recognition is handled by the browser, which may use a vendor cloud service — it is not guaranteed on-device |
| `elevenlabs` | VAD-gated | Scribe v2 realtime, great accuracy |
| `deepgram` | **Native** (Flux) | Provider's own turn model hears the full stream |
| `speechmatics` | VAD-gated | Cheapest per second, locked-words-only finals |

## Bring your own LLM

The default adapter speaks OpenAI's streaming wire format (OpenAI, Groq, Cerebras, OpenRouter, Ollama, vLLM, LiteLLM, ...). For anything else, pass an async generator:

```js
const agent = new VoiceAgent({
  // TS: annotate as `LLM` (exported) and every parameter is inferred.
  llm: async function* (history, system, signal, { toolGate } = {}) {
    // history: [{ role: 'user'|'assistant', content }], system: composed persona+context
    // toolGate: only for adapters that run tools themselves — see below; ignore it otherwise
    for await (const delta of myProvider.stream({ history, system, signal })) {
      yield { text: delta };                        // speech text → streamed into TTS
      // yield { tool: 'name', args: {...} };       // tool call → fired during playback
    }
  },
});
```

## Tools

```js
const agent = new VoiceAgent({
  tools: {
    get_weather: {
      description: 'Current weather for a city',
      params: { city: { type: 'string' } },        // JSON-schema properties
      required: ['city'],                          // optional; defaults to all params
      run: async ({ city }) => fetchWeather(city), // fires DURING speech, in parallel
    },
  },
});
```

Tool calls execute while the agent is still talking. Results are recorded in a per-turn ledger so the model never re-fires the same call, and `agent.notify('[TOOL RESULT get_weather] 22°C sunny')` relays an async outcome back for a spoken follow-up — bursts of results collapse into one reply instead of three interrupting monologues.

Tools are **dispatched, not awaited**: the turn completes when the agent stops speaking, whatever the tool is still doing. A slow or hung tool can never stall the conversation, and a tool is free to `await agent.notify(...)` with its own result. Long work belongs in a tool that returns promptly ("checking that now") and delivers the outcome later via `notify()`.

### Adapters that run tools themselves

Some adapters (agent loops) execute tools **inside** the generator, feeding results back to the model so it keeps talking with the answer in hand — all within one turn. Declare two flags so voiceloop adapts:

```js
async function* myAgentLoop(history, system, signal, { toolGate } = {}) {
  for await (const ev of loop({ history, system, signal, beforeToolCall: () => toolGate })) {
    if (ev.type === 'text')       yield { text: ev.delta };
    if (ev.type === 'tool_start') yield { tool: ev.name, id: ev.id, args: ev.args, running: true };
    if (ev.type === 'tool_end')   yield { tool: ev.name, id: ev.id, args: ev.args, result: ev.result };
  }
}
myAgentLoop.executesTools  = true;   // chunks carry the outcome — voiceloop reports, never re-runs
myAgentLoop.acceptsToolGate = true;  // the loop awaits `toolGate` before ANY tool executes
```

- **`executesTools`** — a tool chunk carrying `result` (or `error`) is *reported*, not executed again. Emitting a `running: true` chunk first opens a live spinner chip that the outcome chunk replaces in place (matched by `id`); if the turn dies before the outcome arrives, voiceloop resolves the chip as `interrupted — did not finish` so a spinner is never left stuck.
- **`acceptsToolGate`** — required to keep [speculative prefetch](#how-the-latency-adds-up) enabled. Prefetch starts the LLM on a *stable interim*, before the user has finished the sentence — so a tool firing there could send an email the user was still amending, and abort cannot undo it. The gate is a promise voiceloop resolves only when the turn **commits**: text streams speculatively, tools wait at the door, and a discarded speculation **rejects** the gate instead — it always settles, so a loop awaiting it unwinds rather than hanging. Without the flag, voiceloop refuses to speculate on that adapter at all (correct, but slower).

## API surface

```js
await agent.start(deviceId?)   // acquire mic, begin listening (needs a user gesture)
agent.stop()                   // pause — pipeline stays warm for instant resume
agent.destroy()                // full teardown
agent.sendUserText(text)       // typed input, same turn pipeline as speech
agent.notify(text)             // soft turn: reply only if nothing newer is queued
agent.setHeld(bool)            // hold: queue utterances, reply over all of them on release
agent.setMuted(bool)           // mic mute
agent.setTtsMuted(bool)        // silent mode: transcript + tools still run
agent.setSysmsg(text)          // update live context mid-session
agent.interrupt()              // programmatic barge-in: stop the current reply
agent.setVoice(id) / agent.setSpeed(x) / agent.listVoices()   // voice controls (engine-dependent)
agent.seek(nwIndex)            // tap-to-seek within the current reply (nwIndex = count of
                               // NON-WHITESPACE chars before the tap — whitespace doesn't count)
agent.replay(text, fromNw?, onProgress?)   // re-voice a past reply; onProgress(spokenText, done)
agent.dumpAudio()              // last 30s of mic audio as WAV + stall report (debugging)
```

### Constructor options

Full types (with per-option notes) in [`src/index.d.ts`](src/index.d.ts).

| | |
|---|---|
| `persona`, `sysmsg` | identity (static) and live context (`setSysmsg()` mid-session) |
| `llmUrl`, `model`, `apiKey`, `maxTokens` | built-in OpenAI-compatible adapter |
| `llm` | your own adapter — replaces all of the above |
| `tools` | what the model may call ([Tools](#tools)) |
| `tts`, `speed` | TTS engine (default Piper) and Piper's speaking rate |
| `sttProvider`, `sttLang`, `sttModel`, `sttUrl` | which recognizer, which language |
| `sttTokenUrl` / `getSttToken`, `sttUsageUrl` | token minting ([STT providers](#stt-providers)); usage metering |
| `keyterms` | domain words to bias STT towards (max 50, ≤20 chars) |
| `micDeviceId` | input device; also `start(deviceId)` |
| `turnDetector`, `maxPauseMs`, `sttEotThreshold` | when a user's turn is over |
| `bargeInMinChars`, `vadOptions`, `preroll` | interruption sensitivity and mic gating |
| `fetchFn` | transport seam for the built-in adapter (tests, request wrapping) |
| `onEvent` | every event below |

Events via `onEvent(e)`: `state`, `stt`, `assistant`, `tool`, `vad`, `level`, `echo`, `error`, `diag`.
A `tool` event carries `{ name, id, args }` plus either `result` (settled) or `running: true` (an [adapter-announced](#adapters-that-run-tools-themselves) call still executing) — render the pair as one chip keyed by `id`.

Two of them exist purely so a UI can look alive, and both cost you nothing to ignore:

- **`level`** — `{ level }`, mic loudness 0..1 on a perceptual curve, ~every 256ms while capturing.
  Measured off the frames the pipeline already has (no second mic tap, no `AnalyserNode`). Drive a
  meter or a reacting orb with it; decay it over *elapsed time* rather than per frame, or it
  flickers out between samples. Not emitted for a `selfCapture` provider (webspeech owns its mic).
- **interruption** — there is no "cut short" event: the final `assistant` event carries both what
  was heard (`text`) and what was written (`full`), so a non-empty `full.slice(text.length)` means
  the reply was cut before that remainder was ever spoken. Render it struck through and the
  transcript shows exactly where playback stopped (see `index.html`). It does not say *why*:
  a voice barge-in, `interrupt()`, a superseding turn and `setTtsMuted(true)` all end a reply the
  same way.

## Tuning

Every latency/sensitivity knob lives in [`src/tuning.js`](src/tuning.js) — VAD thresholds, barge-in minimum characters, sentence-break aggressiveness, prefetch stability window, echo-match threshold. Constructor options (`bargeInMinChars`, `vadOptions`, `turnDetector`, `maxPauseMs`) override per-agent.

Liveness: the turn loop is strictly serialized, so host code it awaits could stall it. Tools are dispatched and never joined (a hung tool costs its own result, nothing more), an aborted LLM stream is detached rather than drained (a generator that ignores its `AbortSignal` can't wedge the next turn), and `maxPauseMs` is a single wall-clock deadline bounding how long a `turnDetector` holds a turn open — including one that never returns. Synthesis is the exception: a custom `_synth()` that never settles does block the reply that needs it, since there's nothing to speak without it.

## TTS

Default is **Piper** (local WASM, free, many languages and voices):

```js
import { PiperTTS } from '@todoforai/voiceloop';
new VoiceAgent({ tts: new PiperTTS('en_US-amy-medium') });
```

**ElevenLabs** for human-grade voices (cloud; key stays server-side behind your proxy route):

```js
import { ElevenLabsTTS } from '@todoforai/voiceloop';
new VoiceAgent({ tts: new ElevenLabsTTS({ ttsUrl: '/api/tts' }) });   // your backend adds xi-api-key
// dev only: new ElevenLabsTTS({ apiKey: 'xi-…' }) — direct browser→ElevenLabs
```

Same behavior (sentence streaming, barge-in, seek, speculative presynth) either way — only the voice
and the cost change: Piper is free and offline, ElevenLabs is paid and sounds human.

Custom engines subclass `StreamingTTS` and implement one method:

```js
class MyTTS extends StreamingTTS {
  async _synth(text, signal) { return wavBlob; }   // sentence in, audio Blob out (null if aborted)
}
```

Sentence chunking, the playback tape, tap-to-seek, barge-in and progress reporting all come from the base class.

## Testing

```
npm test        # no browser needed
```

The suite locks in turn serialization, hold/release semantics, tool dedup, self-echo classification, prefetch adoption rules, tape seeking, and each STT provider's turn-boundary state machine.

## License

MIT

"voiceloop" is a trademark of TODOforAI. You are free to use, modify and redistribute the code under the MIT license, but not to present a fork or derivative as the official voiceloop project or publish it under the voiceloop name.
