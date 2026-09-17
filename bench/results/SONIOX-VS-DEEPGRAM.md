# Soniox stt-rt-v5 vs Deepgram Flux in voiceloop — 2026-09-16

Same rig, same day, same ElevenLabs Flash TTS and fixed mock LLM; 5 runs × 6 turns per cell,
scoring v2 (`bench/blackbox/analyze-v2.js`). voice→voice = person stops → first agent audio.
Turn 0 excluded from the smalltalk steady-state column (it carries the STT cold-connect; in the
app the token is pre-minted and the socket opened before the mic click).

## Headline

| scenario | Soniox (level 2 + hold) | Deepgram Flux | winner |
|---|---|---|---|
| smalltalk v→v, turns 1–5 | **768ms** (p95 973) | 857ms (p95 1045) | Soniox −89ms |
| smalltalk WER | 0% | 0% | tie |
| hesitation v→v | **1014ms** (p95 1661) | 1446ms (p95 1951) | Soniox −432ms |
| hesitation overlap → talked through | 15 → **7** / 30 | 2 → **0** / 30 | Flux |
| hesitation yield | 660ms | 620ms | ~tie |
| echo v→v | 1147ms (p95 2838) | **874ms** (p95 1881) | Flux −273ms |
| echo self-interruptions | 0 | 0 | tie |
| echo barge-in failures | 2 / 8 | 0 / 10 | Flux |
| echo STT WER (echo words leaking into the user transcript) | **4.6%** | 19.3% | Soniox |
| price | **$0.12/hr** | $0.39/hr | Soniox |
| languages | **60+ (incl. hu, pl)** | 10 (Flux multi) | Soniox |

## Soniox endpoint tuning (smalltalk, before the hold fix)

| `endpoint_latency_adjustment_level` | steady-state v→v | mid-sentence splits |
|---|---|---|
| 0 (API default) | 1042ms | 0/30 |
| **2 (voiceloop default)** | **768ms** | 0/30 |
| 3 | 726ms | 10/30 ("Hey there." / "Great." became their own turns) |

`endpoint_sensitivity` (−1…1) and `max_endpoint_delay_ms` made no measurable difference on the
hesitation audio: `<end>` still fires ~250ms into every pause. Its cue for "not done" is the
em-dash it appends to a cut-off phrase.

## Why Soniox talks over hesitations, and what the hold fix does

Soniox's `<end>` is acoustic-leaning — on "Hi, I need some help with … umm … with a dinner
reservation." it closes three turns; Flux's semantic model keeps it as one. voiceloop
(`makeSonioxSTT`) now holds a turn that ends on a continuation cue (trailing em-dash, or a bare
filler like "Um.") for up to 1.5s and merges it with the next segment. That took hesitation from
22/30 talked-through and 1499ms to 7/30 and 1014ms. The remaining 7 are pauses after a
*complete* sentence ("Let's do Thursday at 7. … Actually, make that Friday.") — no STT signal
distinguishes those from a finished turn; only a semantic turn model does.

## Decision

TodoforAI PRO voice defaults to Soniox: faster, 3× cheaper, and it covers every language the
app offers (Hungarian included, which had been falling back to the browser engine). Deepgram
Flux stays selectable for users who'd rather have zero interruptions on pauses than the speed.
