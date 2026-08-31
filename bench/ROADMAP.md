# bench roadmap — closing the gameable gaps

The current scorecard measures speed and turn discipline. Several strategies can buy a better
score with a cost the rig cannot yet see. Policy: **none of these are banned — they are
options, and the bench's job is to make their tradeoff visible as a number.** An agent should
be free to answer fast and eagerly; the table should simply also show what that eagerness costs.

## Known gameable levers (allowed, to be made visible)

| lever | what it buys | hidden cost today | metric that will expose it |
|---|---|---|---|
| Aggressive endpointing (EOT window ↓) | v→v ↓ hundreds of ms | answers the user's half-sentence mid-hesitation | *user-interrupted count* on the hesitation scenario |
| Filler-word head start ("Hmm," at EOT) | v→v ↓ to ~400ms | audio is instant, content isn't | *time-to-first-content-word* next to time-to-first-audio |
| Energy-VAD barge-in | stop time ↓ (~430–540ms measured) | any noise cuts the agent off | *false barge-ins* on the noise scenario (today the rig is silent between lines — every 0 in that column is untested) |
| TTS speedup (e.g. 1.3×) | more info per second | none — and **no latency advantage either**: every latency column keys on audio *onsets* (first sample, stop instant), never playback duration; if anything faster playback risks more stalls (less presynth cover). Listed here only because voice *quality* is unmeasured, so a worse/faster voice costs nothing | *words-per-second* makes the rate visible; quality itself stays human-judged (committed voice samples per SUT) |
| No echo handling | simpler pipeline | self-hearing on real speaker/mic setups | echo scenario: transcript echo-words + self-interruptions |

## Next scenarios (priority order)

1. ~~**hesitation**~~ — DONE (`scenarios/hesitation.json`, results in RESULTS.md). Person lines
   with 450–900ms mid-utterance pauses and false-completion phrasings, rendered as per-segment
   TTS + exact silence (gaps verified ±30ms). Metrics landed: **user-interrupted** (agent audio
   starting inside a still-open person turn) + **time-to-first-content-word** (whisper word
   timestamps vs the scripted response). The bill got paid as predicted: Pipecat smart-turn 16/30
   and Realtime server_vad 12/30 premature entries vs 0–2/30 for flux/turn_v3 — while the eager
   two hold the fastest v→v. Both numbers now sit side by side in the table.
2. **noise** — SHELVED after a 5-run voiceloop probe (assets kept: `scenarios/noise.json`,
   `gen-noise.js`, driver mixing, burst metrics). The probe showed the scenario as cut doesn't
   measure what it targets: the café bed is *intelligible* English at 15dB SNR, so STT
   transcribes it as competing dialogue and the agent almost never gets an endpoint to reply on
   (6/30 replied turns) — a cocktail-party/speaker-separation test, not a false-barge-in test,
   and the bursts never fired because there was no agent speech to fire into. Every stack with a
   plain STT stream fails the same way, so a competitor matrix would burn rig time to show one
   shape. Revival path if wanted: re-cut the bed as unintelligible babble (4–6 overlapped
   tracks, ~25dB SNR), keep the cough/door bursts, re-probe voiceloop 5× before any matrix.
3. ~~**echo loopback**~~ — DONE (`scenarios/echo.json`, results in RESULTS.md). bench_spk mixed
   into bench_mic at −15dB/30ms (driver-side software tap — deterministic, no pulse modules).
   Metrics landed: echo words in the user transcript + self-interruptions (audio truth).
   The product check paid off: voiceloop's echo filter failed under real coupling (a
   self-interruption per run that shifted the script) and was fixed in src/ — 0 self-interruptions
   in 30 turns now; Pipecat default (20/30 turns) and OpenAI Realtime without client AEC (17
   self-interruptions) audibly break; ConvAI survives.

## New metrics

- ~~**time-to-first-content-word**~~ — DONE (analyze.js word timestamps → `content_word` events;
  per-turn `cw` column + pooled row).
- **words-per-second (agent)** — makes TTS speed a visible, legitimate dimension.
- ~~**user-interrupted count**~~ — DONE (`userInterruptions` per turn, scripted interrupts
  excluded; pooled total).
- **cold/warm split** — report turn-0 separately instead of letting model download / first-synth
  pollute p95 (e.g. shared-voice's 4.8s turn-0 outlier; ConvAI/Realtime have no cold cost —
  that difference deserves its own column, not a footnote).

## Later

- **Degraded network** — `tc netem` (150ms / 1% loss) on cloud SUT egress: quantifies the
  local-vs-cloud tradeoff instead of asserting it.
- **Scenario variants** — 2–3 voice/take renders per script, randomly chosen per run, so
  fingerprinting the byte-identical person audio never pays.
- **Endurance** — 40–60 turn runs: latency drift, memory/worker-heap growth.
- **Real-LLM row** — one config on a live API LLM so the mock-vs-reality delta is shown once,
  explicitly.
