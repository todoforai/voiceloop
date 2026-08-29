# voiceloop bench

Measures the REALTIME quality of a voice agent implementation — not the models inside it.
STT/TTS models have their own rigorous benchmarks (LibriSpeech, TTS Arena…); the WER/fidelity
columns here only check that the *implementation* feeds the models properly (no truncated turns,
no echo in transcripts, no clipped replies). Latency numbers are **median + p95** (ms), never mean-only.

Two modes, one scorecard (`metrics.js`):

- **Instrumented** (voiceloop only): `node bench/server.js` + `bench/run.html` — internal splits (EOT / TTFT / TTS-first-audio).
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
