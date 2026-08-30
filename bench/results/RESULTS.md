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
| ElevenLabs ConvAI (their full agent stack) | 1454ms | 1632 | 1042ms | 8 |
| **voiceloop** · EL Scribe + EL flash TTS | 1562ms | 1855 | 1566ms | 12 |
| **voiceloop** · Speechmatics + EL flash TTS | 1706ms | 2069 | 1046ms | 17 |

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
- **OpenAI Realtime does not use the shared mock LLM at all** — it is speech-to-speech, so its
  "brain" is gpt-realtime itself. Every other row pays the mock's simulated 300ms TTFT +
  300 chars/s streaming; Realtime pays whatever its internal model latency is instead. We
  pinned its outputs to the same script via instructions (and verified verbatim compliance),
  but the row measures a different architecture, not the same pipeline with a different voice
  layer. Directionally: no external LLM hop helps it; producing tokens with a real model
  instead of a 300ms mock hurts it. Treat its numbers as "the product as shipped", not as a
  pipeline comparison.

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
```

Raw per-run artifacts (`bb-*.json`, `*.agent.raw` recordings) are not tracked — every pooled
summary in this directory was produced by `run-n.js` from 5 fresh runs.

Want your agent in this table? See [`bench/ADDING_A_SUT.md`](../ADDING_A_SUT.md) for the SUT
contract, fairness rules and PR checklist.
