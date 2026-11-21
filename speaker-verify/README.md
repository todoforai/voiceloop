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

## Hungarian dialogue test (ElevenLabs eleven_v4)

`./gen-hu-dialogue.sh` → 14 s owner enrollment (Attila) + 44 s 10-turn dialogue (Erik ♂, Sarah ♀, 1–2-word commands, overlap). UI section **2b**. Per-utterance verdicts + 1.5 s sliding-window streaming accuracy (WASM 1 thread):

| Model | turns ok | margin (≥1.5 s / all) | streaming 1.5 s | 
|---|---|---|---|
| MFCC DSP | 5/9 | +0.03 / −0.23 | 52% |
| WeSpeaker CAM++ | 7/9 | +0.64 / +0.11 | 86% |
| **3D-Speaker CAM++ 200k** | **9/9** | +0.59 / **+0.31** | **92%** |
| ResNet34 | 7/9 | +0.70 / +0.27 | 86% |
| NeMo SpeakerNet | 7/9 | +0.47 / +0.03 | 79% |

Failures are all 1–2-word owner commands (<1.2 s) under default thresholds. Overlap (owner + other) is passed by every model — needs separate handling. Caveat: synthetic TTS voices, not real mics.

## Overlap + distant-voice stress test (`python3 eval_scenarios.py`)

Synthetic mixes of the Hungarian clips (16 owner×intruder pairs; distant = synthetic RIR RT60 0.5 s + lowpass + attenuation). % = correct verdict at default threshold.

| Scenario | CAM++ 200k | WeSpeaker CAM++ | ResNet34 |
|---|---|---|---|
| owner + intruder, equal loudness, whole time | 50% | 44% | 56% |
| owner + intruder −6 dB or quieter | 100% | 100% | 100% |
| intruder + owner in background, equal loudness (should reject) | 69% | 81% | 75% |
| intruder + owner −6 dB or quieter | 100% | 100% | 100% |
| distant intruder alone, −6…−20 dB | 100% | 100% | 100% |
| distant owner alone, −6/−12 dB | 100% | 100% | 100% |
| owner close + distant intruder in background | 100% | 100% | 100% |
| owner, intruder interrupts halfway (0 dB) | passes (0.79) — intruder's words leak through | | |

Findings: embeddings are loudness-invariant (CMVN), so a quiet/distant voice is judged by timbre, not volume — distant intruders are rejected, distant owner accepted. Only equal-loudness overlap is a coin flip. Mid-utterance interruption passes whole-utterance scoring; 1 s sub-window scoring catches it (owner windows 0.6–0.8, intruder 0.0–0.1) → gate per sub-window / word-timestamp, not per utterance.

## Soniox realtime + gate (`soniox-stream.mjs` → `gate-eval.py`)

HU dialogue streamed at real-time pace to Soniox `stt-rt-v6` (EU, diarization on); final words gated by CAM++ 200k owner score.

| Strategy | owner words kept | intruder words dropped |
|---|---|---|
| 1. whole utterance score | 92% | 100% |
| 2. sliding window per word | 92% | 100% |
| 3. Soniox speaker label → pooled-audio score | 100% | 95% (Soniox labelled Erik's "Küldd el" as owner) |
| **4. 3 + window veto (<0.30)** | **100%** | **100%** |

Notes: Soniox transcribed only the owner in the overlap turn (Erik −3 dB ignored). Gate decision is ready well before Soniox finalises words (median 2.7 s after word end here, default endpoint settings) → no added latency. Single synthetic dialogue; strategy 4's 0.30 veto is tuned on it — validate on real mic audio.

## Shipped gate, causal replay (`gate-replay.mjs`)
`src/speaker-gate.js` (the code the app runs) replayed on the recorded Soniox stream: audio at real-time
pace, each token admitted when it originally arrived, so labels only know their past audio.
`NODE_PATH=<dir with onnxruntime-web>/node_modules node gate-replay.mjs`

| | owner words kept | intruder words dropped |
|---|---|---|
| causal, label + window veto (+ window-only before a label is scored) | 37/37 | 40/40 |

Label scores at the end: S1 (owner) 0.72, S2 −0.08, S3 0.26. Still ONE synthetic dialogue — real-mic
validation pending. Diarization costs nothing extra (bundled in Soniox's hourly rate).

## Later (agreed design, not built)

- **Multi-person lock:** `SpeakerGate` takes several voiceprints, score = max over them (matching is µs; the
  embedding is the cost, once per window). `setVoiceprints()` swaps the allowed set live (re-score labels, no
  reconnect). Frontend: per-person records `{ name, enabled, prints per mic }`, falling back to another mic's
  print when this mic has none; a checklist UI. Do it after the single-owner gate is tried on a real mic.
- **`tfa-assistant` CLI:** lets agents change the browser-local `VoiceSettings` over the existing `ui_call`
  bridge (bash can't read localStorage). Allowed: `sttLang`, `speed`, voice, `voiceLock` and allowed names,
  `notifyScope`, `todStyle` presets, `listenInBackground`, mascot look. Denied: `todInstructions` (goes into the
  prompt, so it's an injection risk), `todModel`/`voiceMode` (billing). Never expose voiceprint vectors.
