# voiceloop

**The fastest way to put a real, interruptible voice agent in the browser.**

A zero-dependency JavaScript library that runs the full voice loop — **VAD → STT → LLM → TTS** — with the hard parts already solved:

- **Real barge-in** — interrupt the agent mid-sentence. Triggers on *transcribed novel words*, not raw mic energy, so the agent's own voice leaking into the mic never cuts it off.
- **Self-echo filtering** — a word-match filter compares what the mic hears against what the agent is currently saying. Benchmarked under real speaker→mic coupling with echo cancellation fully off: 0 self-interruptions in 30 turns, at full speed — while Pipecat (default config) cut its own reply on 20/30 turns and OpenAI Realtime on 17/30 ([echo results](bench/results/RESULTS.md#scenario-echo-smalltalk--speakermic-coupling-15db--30ms)).
- **First-sentence streaming TTS** — the LLM streams text, TTS synthesizes the first sentence *while the rest is still generating*, then stays one sentence ahead. First audio in well under a second.
- **Speculative prefetch** — the LLM call starts while you're still finishing your sentence, overlapping model latency with the end-of-turn pause. Replies feel instant.
- **Tap-to-seek** — playback keeps a tape of synthesized clips; tap anywhere in the transcript to jump the voice there, backward or forward.
- **Turn serialization** — rapid-fire turns, tool results, holds and replays can never overlap or talk over each other. Locked in by a 100-test regression suite.
- **Local-first defaults** — Silero VAD (WASM) and Piper TTS (WASM) run in the browser. Free, no cloud round-trip for voice output (assets load from CDN, then cache).

Everything is pluggable: bring your own LLM (any OpenAI-compatible endpoint or a custom async generator), pick an STT provider (Web Speech, ElevenLabs Scribe, Deepgram Flux, Speechmatics), swap the TTS.

## Quick start

```js
import { VoiceAgent, unlockAudio, prewarmVoice } from 'voiceloop';

prewarmVoice(); // optional but recommended: preload VAD/WASM while your UI sits idle

const agent = new VoiceAgent({
  // Any OpenAI-compatible /chat/completions endpoint. In production point this at
  // YOUR proxy route — never ship a provider secret key to the page.
  llmUrl: '/api/chat/completions',
  model: 'gpt-4o-mini',

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

## How the latency adds up

```
you stop speaking ──┐
                    │  end-of-turn debounce (~600ms)
   LLM prefetch ────┤  ← already streaming since your interim transcript stabilized
                    │
first LLM tokens ───┤  first sentence boundary (~8+ chars)
                    │  Piper synthesizes sentence 1 while sentence 2 streams in
first audio ────────┘  next sentences pre-synthesized during playback → zero gaps
```

**Measured, not claimed**: [voice-agent-bench](https://github.com/todoforai/voice-agent-bench)
(developed here at [`bench/`](bench/)) is a black-box rig — audio in → audio out, zero
integration — that scores voiceloop and competing stacks on the same scripted conversations
and the same fixed mock LLM. Reply latency (voice→voice median), and how often the system
misbehaves — talks over a hesitating user, or cuts its own reply when its voice echoes back
into the mic (no AEC):

| system | latency (clean) | talked through user | cut itself under echo |
|---|---|---|---|
| OpenAI Realtime (own LLM)* | 870ms | **0/30** | **17/30** |
| **voiceloop** (deepgram + ElevenLabs flash) | **980ms** | **0/30** | **0/30** |
| **voiceloop** (deepgram + Piper, free local TTS) | **970ms** | **0/30** | — |
| Pipecat 1.8.1 (same providers) | 1050ms | 2/30 | **20/30** |
| ElevenLabs ConvAI | 1450ms | **0/30** | 0/30 |

Overlapping a hesitating user is fine — people do it, and every stack here except Pipecat backs
off the moment the user keeps talking (voiceloop yields in 420ms, and only enters 2 of 30 turns
at all). The failure that still separates them is echo: fed its own voice through the mic with
no AEC, the other fast stacks hear themselves as the user and cut their own replies.
voiceloop's word-level echo filter runs echo-coupled turns at full speed (930ms, parity with
clean).

\* Realtime is speech-to-speech — it can't use the bench's fixed mock LLM, so its row isn't
fully apples-to-apples.

Full tables, method and reproduction steps: [`bench/results/RESULTS.md`](bench/results/RESULTS.md).

## STT providers

```js
new VoiceAgent({ sttProvider: 'webspeech' })     // default: free, browser-native (Chrome/Safari)
new VoiceAgent({ sttProvider: 'elevenlabs',  sttTokenUrl: '/api/stt/token' })
new VoiceAgent({ sttProvider: 'deepgram',    sttTokenUrl: '/api/stt/token' })
new VoiceAgent({ sttProvider: 'speechmatics', sttTokenUrl: '/api/stt/token' })
```

Cloud providers authenticate with a **short-TTL token minted by your backend** so the raw API key never reaches the page. Either:

- `sttTokenUrl` — a POST route on your server that returns `{ token }` (mint it against the provider's temp-token API with your secret key), or
- `getSttToken` — an async callback `() => ({ token })` when your auth doesn't fit a bare POST.

On browsers without SpeechRecognition (Firefox, WebKitGTK) `webspeech` falls back to `elevenlabs` — which needs a token route configured, so pass `sttTokenUrl`/`getSttToken` if you want the fallback to work.

| Provider | End-of-turn | Notes |
|---|---|---|
| `webspeech` | Native (browser-managed) | Free, on-device, Chrome/Safari only |
| `elevenlabs` | VAD-gated | Scribe v2 realtime, great accuracy |
| `deepgram` | **Native** (Flux) | Provider's own turn model hears the full stream |
| `speechmatics` | VAD-gated | Cheapest per second, locked-words-only finals |

## Bring your own LLM

The default adapter speaks OpenAI's streaming wire format (OpenAI, Groq, Cerebras, OpenRouter, Ollama, vLLM, LiteLLM, ...). For anything else, pass an async generator:

```js
const agent = new VoiceAgent({
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
- **`acceptsToolGate`** — required to keep [speculative prefetch](#how-the-latency-adds-up) enabled. Prefetch starts the LLM on a *stable interim*, before the user has finished the sentence — so a tool firing there could send an email the user was still amending, and abort cannot undo it. The gate is a promise voiceloop resolves only when the turn **commits**: text streams speculatively, tools wait at the door, and a discarded speculation aborts instead. Without the flag, voiceloop refuses to speculate on that adapter at all (correct, but slower).

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
agent.seek(nwIndex)            // tap-to-seek within the current reply (nwIndex = count of
                               // NON-WHITESPACE chars before the tap — whitespace doesn't count)
agent.replay(text, fromNw?, onProgress?)   // re-voice a past reply; onProgress(spokenText, done)
agent.dumpAudio()              // last 30s of mic audio as WAV + stall report (debugging)
```

Events via `onEvent(e)`: `state`, `stt`, `assistant`, `tool`, `vad`, `echo`, `error`, `diag`.
A `tool` event carries `{ name, id, args }` plus either `result` (settled) or `running: true` (an [adapter-announced](#adapters-that-run-tools-themselves) call still executing) — render the pair as one chip keyed by `id`.

## Tuning

Every latency/sensitivity knob lives in [`src/tuning.js`](src/tuning.js) — VAD thresholds, barge-in minimum characters, sentence-break aggressiveness, prefetch stability window, echo-match threshold. Constructor options (`bargeInMinChars`, `vadOptions`, `turnDetector`, `maxPauseMs`) override per-agent.

Liveness: the turn loop is strictly serialized, so host code it awaits could stall it. Tools are dispatched and never joined (a hung tool costs its own result, nothing more), an aborted LLM stream is detached rather than drained (a generator that ignores its `AbortSignal` can't wedge the next turn), and `maxPauseMs` is a single wall-clock deadline bounding how long a `turnDetector` holds a turn open — including one that never returns. Synthesis is the exception: a custom `_synth()` that never settles does block the reply that needs it, since there's nothing to speak without it.

## TTS

Default is **Piper** (local WASM, free, many languages and voices):

```js
import { PiperTTS } from 'voiceloop';
new VoiceAgent({ tts: new PiperTTS('en_US-amy-medium') });
```

**ElevenLabs** for human-grade voices (cloud; key stays server-side behind your proxy route):

```js
import { ElevenLabsTTS } from 'voiceloop';
new VoiceAgent({ tts: new ElevenLabsTTS({ ttsUrl: '/api/tts' }) });   // your backend adds xi-api-key
// dev only: new ElevenLabsTTS({ apiKey: 'xi-…' }) — direct browser→ElevenLabs
```

Same behavior (sentence streaming, barge-in, seek, speculative presynth) either way — only the voice
and the cost change: Piper is free and offline, ElevenLabs is paid and sounds human.

Custom engines subclass `StreamingTTS` and implement one method:

```js
class MyTTS extends StreamingTTS {
  async _synth(text) { return wavBlob; }   // sentence in, audio Blob out
}
```

Sentence chunking, the playback tape, tap-to-seek, barge-in and progress reporting all come from the base class.

## Testing

```
npm test        # 101 tests, no browser needed
```

The suite locks in turn serialization, hold/release semantics, tool dedup, self-echo classification, prefetch adoption rules, tape seeking, and each STT provider's turn-boundary state machine.

## License

MIT
