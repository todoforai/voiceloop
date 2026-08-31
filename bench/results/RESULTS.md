# voiceloop benchmark results

Black-box measurements: a scripted "person" (pre-generated ElevenLabs speech, byte-identical
every run) talks into a virtual mic; we record the agent's speaker output and derive every
number from **audio alone** — the same way a human would hear it. Internal milestones
(instrumented runs) only *explain* the audio-truth numbers, never replace them.

Method details: [`bench/README.md`](../README.md) · harness: [`bench/blackbox/`](../blackbox/)

**Single runs lie** (±300ms network/WASM jitter — we watched it flip conclusions), so every
configuration is 5 conversations × 6 turns, pooled (n=30 turns; barge-in n=10).

## Scenario: smalltalk (6 turns, 2 barge-ins, fixed mock LLM)

All systems get the **same brain**: a mock LLM with fixed responses, 300ms TTFT, 300 chars/s —
so the numbers measure the voice pipeline, not the language model.

| configuration | voice→voice median | p95 | barge-in stop | stalls |
|---|---|---|---|---|
| OpenAI Realtime (gpt-realtime, speech-to-speech) * | 866ms | 1644 | 429ms | 20 |
| **voiceloop** · deepgram + ElevenLabs flash TTS | **984ms** | 1169 | 1019ms | 15 |
| **voiceloop** · deepgram + Piper (free, local) | **981–1101ms** | 1306 | 1452ms | 23 |
| Pipecat 1.8.1 · deepgram + EL flash TTS | 1046ms | 3573 | 542ms | 14 |
| ElevenLabs ConvAI (their full agent stack) | 1454ms | 1632 | 1042ms | 8 |
| **voiceloop** · EL Scribe + EL flash TTS | 1562ms | 1855 | 1566ms | 12 |
| **voiceloop** · Speechmatics + EL flash TTS | 1706ms | 2069 | 1046ms | 17 |
| _TODOforAI shared-voice (our shipped Jarvis; internal)_ · webspeech + Piper | _2414ms_ | _4771_ | _1406ms_ | _32_ |

voice→voice = end of the person's speech → first audible agent audio (from the recording).
barge-in stop = person starts interrupting → agent audio actually stops.

\* **own LLM — brain not identical**: Realtime is speech-to-speech and cannot call our fixed
mock LLM, so its row is not fully apples-to-apples (see caveats below).

### Where the milliseconds go (voiceloop, deepgram + EL flash)

| stage | median |
|---|---|
| STT first partial (person start → first transcript) | 714ms |
| end-of-turn delay (person end → turn committed) | 366ms |
| TTS first audio (first LLM token → audible) | 418ms |

### Notes per configuration

- **deepgram + EL flash** — best overall: human voice, lowest stall count of the fast configs,
  fastest barge-in of ours (mp3 clips need no un-cancellable local inference to drain).
- **deepgram + Piper** — same latency, zero TTS cost, fully offline voice. Piper's WASM synth
  runs in a worker (`ort.env.wasm.proxy`); first-word clip ~185ms on a 32-core box.
- **EL Scribe / Speechmatics STT** — both gate the turn on late partials (~1.2–1.5s EOT):
  accurate transcripts, but not tuned for conversational end-of-turn. Deepgram flux's
  turn-events win this scenario.
- **OpenAI Realtime** — WebRTC via their standard browser flow (`/v1/realtime/calls`, ephemeral
  client secret minted server-side), default `server_vad` turn detection (threshold 0.5,
  silence 200ms — their stock config, untuned). To approximate the shared brain, the session
  instructions pin every turn to the scenario script; it complied **verbatim on all checked
  turns**. Latency is impressive but noisy: per-run v→v medians spanned 628–1368ms (>2×),
  the widest spread of any SUT. Barge-in stop of 429ms is the fastest measured — its VAD-based
  `interrupt_response` cuts audio quickly, the flip side being that any noise could do it
  (word-based SUTs like voiceloop can't be noise-interrupted; here 0 false barge-ins only
  because the rig is silent between lines). The short "Yes." turn was often not detected as a
  separate reply (n=26 of 30 turns).
- **Pipecat** — `bench/blackbox/sut-pipecat.py`: the official local-audio example
  (PipelineWorker/WorkerRunner) with the same provider vendors as our winning config — Deepgram
  STT, the same ElevenLabs flash voice, the shared mock LLM on localhost. Same vendors ≠ same
  config, though: Pipecat's stock integration is nova-3 STT + SileroVAD start +
  `LocalSmartTurnAnalyzerV3` end-of-turn, where voiceloop uses Deepgram **Flux** with its native
  turn events — so the row compares each framework's out-of-the-box turn-taking stack, not
  orchestration overhead alone. Per-run v→v medians were among the tightest measured
  (1035–1105ms). Two faces: the fastest barge-in of the cascade systems (542ms median; only
  speech-to-speech Realtime is quicker) — its VAD-triggered interruption cuts output
  immediately, no transcription gate — but two failure modes fatten the tail. (1) The
  smart-turn model judges "Stop stop, just tell me one word, yes or no." INCOMPLETE and holds
  the turn ~2.8s past end of speech (~3.5s v→v on that turn in every run; all other turns
  0.6–1.5s). (2) **Self-interruption**: when nova-3 splits an utterance into two finals
  ("Hey there." + "can you hear me properly?"), smart-turn commits on the first and the late
  second final triggers `TranscriptionUserTurnStartStrategy` — the framework interrupts its own
  nascent reply, the recovery stop fires no inference, and the orphaned reply flushes after the
  NEXT turn (2/5 runs lost turn 0 this way → v→v n=28, and the flushed audio adds stalls). VAD
  barge-in also means loud non-speech noise can cut the agent's output; voiceloop's word-based
  gate needs transcribed words (both showed 0 false barge-ins here — the scripted audio is
  clean speech).
- **TODOforAI shared-voice** — NOT a competitor: our own product's shipped voice agent
  (`todoforai/packages/shared-voice`, an earlier cousin of voiceloop), benchmarked in its
  production default config (browser Web Speech STT + Piper 1.2×) via a thin SUT page +
  `/llm` wire shim (`packages/shared-voice/bench/`). Per-run medians very tight (2393–2468ms).
  The 1430ms gap to voiceloop·piper splits cleanly: **EOT delay 1570ms** vs 366 (Chrome
  Web Speech endpointing + 500ms debounce + tail-defer waits, vs Deepgram flux native
  turn events) and **TTS first audio 1930ms** vs 418 (its Piper path lacks voiceloop's
  phonemizer reuse, `ort.env.wasm.proxy` worker inference, presynth, and runs without
  crossOriginIsolated — single-threaded ONNX, like the production site). The p95 outlier
  (~4.8s) is turn-0 Piper cold start. Barge-in is word-based like voiceloop (0 false
  barge-ins) but slower to drain (1406ms). This row exists to track our shipped product
  against the state of this repo — the deltas above are its upgrade backlog.
- **ConvAI** — measured through their standard `@elevenlabs/client` SDK with a default-config
  agent (scribe_realtime ASR, `turn_v3`/normal eagerness, `optimize_streaming_latency: 3`; we
  even upgraded its TTS from the default turbo_v2 to the faster flash_v2). Per-run medians were
  tight (1438–1501ms) and match ElevenLabs' own published ~1.5s ConvAI latency — this is the
  product's real number, not a rig artifact. Barge-in is competitive (1042ms; energy-VAD vs our
  word-based barge-in — we require real transcribed words, so background noise never falsely
  stops the agent: 0 false barge-ins in every config).

### Fairness caveats (both directions)

- **ConvAI pays a network toll we don't**: its custom-LLM calls travel EL cloud → Cloudflare
  tunnel → our mock, while voiceloop hits it on localhost. Measured tunnel overhead from here is
  ~170–240ms TTFB. Even crediting ConvAI the full ~240ms (→ ~1210ms), voiceloop at 984ms is
  still ~230ms ahead — and in production voiceloop's LLM is a real network hop too.
- **AEC is disabled for every SUT** (including ConvAI): virtual devices have no acoustic echo,
  and Chrome AEC with nothing to cancel suppresses the person's barge-ins. This helps, not
  hurts, each system.
- ConvAI is a closed box, so its EOT/STT sub-metrics come from SDK callback timing and are not
  comparable to our instrumented splits; only the audio-truth columns (voice→voice, barge-in,
  stalls) are apples-to-apples.
- **Pipecat mock-LLM contract**: our mock picks the scripted response by counting user messages;
  Pipecat's aggregator sometimes emits one utterance as two user messages (split STT finals), so
  the SUT merges consecutive user messages before each request — request normalization only, no
  timing change. This removed the off-script fallback replies of an earlier run (all heard
  speech is now script text, whisper-checked), but it cannot repair the self-interruption case:
  when a reply is swallowed, the next request has two genuine turns with no assistant message
  between them, the merge collapses them, and the script stays shifted by one for parts of those
  runs (2/5) — shifted reply text can move sentence boundaries, so read the stall count with
  that in mind. The self-interruption itself is Pipecat default-config behavior, kept in the
  numbers. Pipecat runs as a
  native process (`run-proc.js` restarts it per run), audio via pyaudio→pulse on the same
  bench_mic/bench_spk pair; its mock-LLM calls are localhost, same as voiceloop's.
- **OpenAI Realtime does not use the shared mock LLM at all** — it is speech-to-speech, so its
  "brain" is gpt-realtime itself. Every other row pays the mock's simulated 300ms TTFT +
  300 chars/s streaming; Realtime pays whatever its internal model latency is instead. We
  pinned its outputs to the same script via instructions (and verified verbatim compliance),
  but the row measures a different architecture, not the same pipeline with a different voice
  layer. Directionally: no external LLM hop helps it; producing tokens with a real model
  instead of a 300ms mock hurts it. Treat its numbers as "the product as shipped", not as a
  pipeline comparison.

## Scenario: echo (smalltalk + speaker→mic coupling, −15dB / 30ms)

The driver mixes the agent's own speaker output back into the mic (software tap on
`bench_spk.monitor`, attenuated −15dB, delayed 30ms) — a laptop speaker/mic without working AEC.
Chrome AEC stays **off for every SUT** so the coupling hits everyone equally; surviving it is up
to each stack's own echo strategy. Same smalltalk turns; brain comparability as in smalltalk
(voiceloop/Pipecat/ConvAI share the mock LLM, Realtime is its own model).

| configuration | voice→voice | self-interruptions | echo words in transcript | barge-in stop |
|---|---|---|---|---|
| **voiceloop** · deepgram + EL flash | **931ms** (p95 2035) | **0** / 30 turns | 14 | 1460ms |
| Pipecat 1.8.1 · deepgram + EL flash | 1317ms (p95 1893) | **20** / 30 turns | n/a (no transcript events) | 767ms |
| OpenAI Realtime (gpt-realtime) * | 793ms (p95 1429) | **17** / 30 turns | 289 | 347ms |
| ElevenLabs ConvAI | 1408ms (p95 1636) | **0** / 30 turns | 0 | 568ms |

self-interruptions = the agent cut its own reply with nobody talking (audio truth: reply
delivered <80% outside scripted interrupts, or an explicit cut outside every person-speech
window). echo words = response-script words appearing in the SUT's *user* transcript.

- **voiceloop** — the run that motivated this scenario: the word-based self-echo filter
  (STT text fuzzy-matched against the audible reply prefix) had never faced real coupling.
  It initially failed in three ways, all fixed in `src/voice-agent.js` (see notes below):
  final result **0 self-interruptions, 0 false barge-ins, v→v at parity with clean smalltalk**
  (931 vs 984ms — echo handling costs no latency once the filter classifies correctly). The 14
  residual echo words are *dropped* turns correctly classified as echo (30 echo drops), not
  answered.
- **Pipecat** — default config self-interrupts on 20 of 30 turns: its energy-VAD
  `interrupt_response` hears the agent's own voice as the user and cuts the reply; with the
  reply swallowed the script shifts and parts of runs derail. No echo filtering in the default
  pipeline.
- **OpenAI Realtime** — server VAD hears its own echo as user speech constantly: 289
  response-script words landed in its user transcript and it truncated its own answers 30–68
  times per 6-turn run (17 audible self-interruptions; its fast regenerate often re-covers the
  script, which keeps v→v looking good while the conversation audibly stutters and repeats —
  199 stalls). Their docs assume client-side AEC (`echoCancellation: true`); with it off, the
  stack has no defense. Its fast barge-in stop (347ms) is the same reflex that self-triggers.
- **ElevenLabs ConvAI** — clean: 0 self-interruptions, 0 echo words. Their server-side stack
  evidently does its own echo suppression regardless of browser AEC. Latency unchanged vs
  clean smalltalk (1454→1408ms).

Takeaway: word-level echo filtering (voiceloop) and server-side suppression (ConvAI) both
survive raw coupling; energy-VAD interruption without echo defense (Pipecat default, Realtime
without client AEC) audibly breaks. voiceloop is the only one of the survivors that also keeps
sub-1.2s v→v with the shared mock brain.

\* Realtime caveats as in smalltalk (own brain). Its echo numbers come from remapping its
`input_audio_transcription.completed`/`output_audio_buffer.cleared` events to the bench's
canonical `stt_final`/`barge_stop`.

### voiceloop fixes the echo scenario forced (src/voice-agent.js)

1. **Cross-turn echo scope** — a new turn cleared the echo reference while the previous
   reply's echo tail was still in flight (acoustic delay + STT latency); those words looked
   novel and barged in on the new reply, cascading. The previous reply's audible text is now
   parked and included in echo classification within the 2s post-playout grace window.
2. **Cursor lag** — the proportional time→text spoken cursor lags real audio, so echo partials
   contained words just *ahead* of it and un-latched the filter. Echo is now judged against
   prefix + the whole clip playing (a safe upper bound — echo can't be ahead of the audio), while
   the UI keeps the precise cursor.
3. **Short echo finals** — fast-endpointing STT closes echo as short finals ("Yes.") that could
   never reach the fixed 3-hit drop threshold and became user turns the agent answered; the
   threshold now scales with the final's own length.

The clip-bounded reference is clamped back to the actually-heard prefix the moment playback
stops (finish or barge-in), so a user quoting the reply's *unspoken* remainder can never be
swallowed as echo.

Before the fixes (pooled smoke/diag/fix1 runs, 6 turns each): 1 self-interruption *per run*
with 6–11 echo words leaking, v→v 1518–1849ms — every run corrupted by turn-0's cascade
shifting the script. After: 0 self-interruptions in 30 turns, v→v 931ms.

## Environment

- AMD Threadripper 1950X (32 threads), Linux, Chrome 138, Node 24
- PulseAudio virtual devices (`bench_mic` / `bench_spk`), AEC off (no acoustic coupling to cancel)
- Network: real cloud round-trips to Deepgram / ElevenLabs / Speechmatics EU-adjacent from Europe

## Reproduce

```sh
bench/blackbox/audio-setup.sh up
node bench/blackbox/gen-audio.js smalltalk        # once (needs ELEVENLABS_API_KEY, or espeak fallback)
DEEPGRAM_API_KEY=… ELEVENLABS_API_KEY=… node bench/server.js smalltalk &
PULSE_SOURCE=bench_mic PULSE_SINK=bench_spk google-chrome --user-data-dir=/tmp/sut \
  --remote-debugging-port=9223 --use-fake-ui-for-media-stream \
  --autoplay-policy=no-user-gesture-required \
  'http://localhost:7777/bench/blackbox/agent.html?stt=deepgram&tts=elevenlabs'
node bench/blackbox/run-n.js smalltalk mylabel 5 9223

# process SUTs (e.g. Pipecat) use the process runner instead of a Chrome page:
PULSE_SOURCE=bench_mic PULSE_SINK=bench_spk DEEPGRAM_API_KEY=… ELEVENLABS_API_KEY=… \
  node bench/blackbox/run-proc.js smalltalk pipecat 5 -- \
  /tmp/pipecat-venv/bin/python bench/blackbox/sut-pipecat.py
```

Raw per-run artifacts (`bb-*.json`, `*.agent.raw` recordings) are not tracked — every pooled
summary in this directory was produced by `run-n.js` (or `run-proc.js` for process SUTs) from
5 fresh runs.

Want your agent in this table? See [`bench/ADDING_A_SUT.md`](../ADDING_A_SUT.md) for the SUT
contract, fairness rules and PR checklist.
