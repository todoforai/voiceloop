# speaker-verify — owner-voice verification lab (web prototype)

Goal: only the enrolled owner's voice reaches the AI. Client-side, voiceprint never leaves the browser.

Run: `node speaker-verify/server.mjs` → http://localhost:7788 (COOP/COEP for threaded WASM; models auto-download to `.cache/`).

1. Pick models → **Benchmark** (3-speaker sherpa-onnx WAVs, latency at 0.5–3 s windows).
2. **Enroll** 6–12 s of your voice → **Live** (sliding window, per-model score + latency) → record labelled 3 s test clips (self / other / TV).

Results (Chrome 156, 16 threads, ms per window):

| Model | MB | 0.5s | 1.5s | 3s | margin full | margin 1.2s |
|---|---|---|---|---|---|---|
| MFCC+pitch (DSP) | 0 | 2 | 3 | 5 | +0.08 | +0.02 |
| WeSpeaker CAM++ | 28 | 14 | 27 | 59 | +0.31 | +0.21 |
| 3D-Speaker CAM++ 200k | 27 | 14 | 30 | 53 | +0.29 | +0.23 |
| WeSpeaker ResNet34 | 25 | 26 | 74 | 145 | +0.37 | +0.27 |
| NeMo SpeakerNet | 22 | 7 | 16 | 25 | +0.13 | +0.02 |

INT8 ResNet34 dropped: ORT-web WASM lacks `ConvInteger`. Eval set is 3 (Chinese) speakers only — validate on real Hungarian mic audio before choosing a threshold.

Integration point: `VoiceAgent._feed` (src/voice-agent.js) — score each utterance in parallel with Soniox, drop the transcript at turn end if below threshold.
