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
| TTS speedup (e.g. 1.3×) | more info per second | none, if intelligible — this is a *legitimate* option | *words-per-second* + content-word timing; speedup that delivers info sooner scores better, as it should |
| No echo handling | simpler pipeline | self-hearing on real speaker/mic setups | echo scenario: transcript echo-words + self-interruptions |

## Next scenarios (priority order)

1. **hesitation** — person lines with 400–900ms mid-utterance pauses and false-completion
   phrasings ("I'd like to book… umm… a table for four"). New metric: **user-interrupted**
   (agent audio starting inside a person's still-open turn — the inverse of barge-in).
   This is where aggressive endpointing pays its bill.
2. **noise** — café/TV speech bed mixed into bench_mic at realistic SNR + a non-speech burst
   (cough/door slam) during agent speech. This is where energy-VAD barge-in pays its bill,
   and where word-based barge-in should visibly win.
3. ~~**echo loopback**~~ — DONE (`scenarios/echo.json`, results in RESULTS.md). bench_spk mixed
   into bench_mic at −15dB/30ms (driver-side software tap — deterministic, no pulse modules).
   Metrics landed: echo words in the user transcript + self-interruptions (audio truth).
   The product check paid off: voiceloop's echo filter failed under real coupling (a
   self-interruption per run that shifted the script) and was fixed in src/ — 0 self-interruptions
   in 30 turns now; Pipecat default (20/30 turns) and OpenAI Realtime without client AEC (17
   self-interruptions) audibly break; ConvAI survives.

## New metrics

- **time-to-first-content-word** — first agent word matching the scripted response (we already
  record + transcribe agent audio for WER; add word-level timestamps). Reported *next to*
  time-to-first-audio: filler-led strategies then read as "fast audio, slower content"
  instead of silently winning v→v.
- **words-per-second (agent)** — makes TTS speed a visible, legitimate dimension.
- **user-interrupted count** — agent speech starting during an open person turn.
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
