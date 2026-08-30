# voice-agent-bench

A black-box latency benchmark for **any** voice agent: a scripted "person" (pre-generated
speech, byte-identical every run) talks into a virtual mic, the agent's speaker output is
recorded, and every score is derived from **audio alone** — voice→voice latency, barge-in stop
time, stalls, false barge-ins, echo leakage. If it makes sound, it can be benchmarked: zero
integration required.

It measures the REALTIME quality of a voice agent *implementation* — not the models inside it.
STT/TTS models have their own rigorous benchmarks (LibriSpeech, TTS Arena…); the WER/fidelity
columns here only check that the implementation feeds the models properly (no truncated turns,
no echo in transcripts, no clipped replies). Latency numbers are **median + p95** (ms), never
mean-only, and single runs are never reported: `blackbox/run-n.js` pools N conversations
(±300ms network/WASM jitter has flipped single-run conclusions).

Fairness rules: every system under test gets the **same fixed mock LLM** (scripted responses,
fixed TTFT and token rate — the numbers measure the voice pipeline, not the language model),
the same audio devices, and the same scenario script. Results so far: [`results/RESULTS.md`](results/RESULTS.md).

Developed alongside [voiceloop](https://github.com/todoforai/voiceloop) (it lives at `bench/`
there and is split to this repo), but the rig is agent-agnostic — SUT pages exist for voiceloop
and ElevenLabs ConvAI, and adding one for Pipecat/Vapi/LiveKit/etc. is a page or script that
talks to the virtual devices. PRs with new SUTs or scenarios welcome.

**Add your agent:** the full contract (interface, fairness rules, cloud tunneling, PR
checklist) is in [`ADDING_A_SUT.md`](ADDING_A_SUT.md) — integration is just "listen on
`bench_mic`, speak on `bench_spk`".

Two modes, one scorecard (`metrics.js`):

- **Instrumented** (agents that emit milestone events): internal splits (EOT / TTFT / TTS-first-audio) merged into the audio timeline via epoch clock.
- **Black-box** (any agent): audio in, audio out — zero integration. See `blackbox/`.

Black-box quickstart:
```sh
bench/blackbox/audio-setup.sh up                 # virtual mic/speaker pair
node bench/blackbox/gen-audio.js smalltalk       # once: ElevenLabs "person" voice
# point the agent's audio at the devices, e.g. voiceloop itself:
DEEPGRAM_API_KEY=… node bench/server.js smalltalk &
PULSE_SOURCE=bench_mic PULSE_SINK=bench_spk google-chrome --user-data-dir=/tmp/sut \
  --use-fake-ui-for-media-stream --autoplay-policy=no-user-gesture-required \
  http://localhost:7777/bench/blackbox/agent.html
node bench/blackbox/driver.js smalltalk mylabel  # the virtual person talks
node bench/blackbox/analyze.js bench/results/bb-…json   # → markdown report
```
