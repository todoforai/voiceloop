# Scoring v2.0 — accuracy and sustained yielding

Effective for new `run-n.js` / `run-proc.js` runs. Every v2 report is labeled and saved separately
(`*.v2.report.json`, `*.v2.md`, `pooled-v2-*`). Existing v1 recordings/reports and RESULTS.md tables
are historical; never compare a v2 stop score directly to a competitor's v1 stop score.

Select `BENCH_SCORING=2` (default) or `BENCH_SCORING=1` (legacy). Other values fail before running.
The selected version is printed before collection. Direct `analyze.js` remains the legacy analyzer;
`analyze-v2.js` is the explicit new analyzer.

## Definitions

### Voice→voice

Unchanged headline definition: first recorded audio segment **starting after person_end** minus
person_end, before the next person turn. Upper median and nearest-rank p95, with valid observation
count. A continuous early reply has no post-end onset and hence no latency observation; it is not
silently interpreted as zero latency. Missing timing and missing audio are separate counts.

### Sustained barge-in stop

From person_start to the end of the **last** agent audio segment overlapping that person's speaking
interval. An intermediate sentence gap cannot receive stop credit if the agent resumes while the
person is still speaking. The last segment must finish at least **200ms before person_end**;
otherwise the turn is an interruption failure (null latency, counted explicitly). No overlapping
agent speech is `no_overlap`, not a successful zero-ms stop. The normal answer beginning after
person_end is excluded from the stop window. All segment boundaries use the existing audio energy
analyzer (20ms frames, 250ms segment hang time), unchanged across builds.

This is observed sustained silence over the rest of the user's floor, not proof the stop was
caused by the user. Very short interruptions (<200ms) cannot satisfy the criterion; report them
separately if such scenarios are added. The 200ms rule is fixed for both builds, not tuned to results.

### Hesitation recovery

For an agent entry during a scripted pause, evaluate from the next person_resume. For an entry
while the person is talking, evaluate from that entry. Apply the same sustained-stop rule through
person_end. **Any failed recovery makes the turn talked-through**; one earlier successful stop
cannot excuse a later failure. An entry ending before the person resumes needs no yielding action.

### Input transcription (WER)

No reference-text search. Prefer a valid explicit ground-truth turn ID emitted by an adapter. For
untagged callback-based transcripts, consider possible owners whose speech has begun and whose
person_end is less than 5s before the callback. A single possible owner gets the final; multiple
possible owners make the involved turns **ambiguous**, not perfect matches. Join all assigned split
finals in arrival order so extra/echo words incur insertion errors. Never reuse a final across turns.

This is conservative callback attribution, not proof of acoustic causality. Missing finals on an
observable STT surface incur WER=1. Unobservable or ambiguous turns have null WER and explicit
counts. Report observed, missing, ambiguous, unknown, scored, and unassigned counts. A lower WER
with less attribution coverage is not an accuracy gain.

Also report **whole-conversation WER**: concatenate ALL scripted person lines in order and compare
against ALL observed STT finals in arrival order. No turn attribution or answer matching is needed;
missing, duplicated, or echoed words cannot disappear as ambiguous. Pool using total word edits /
total reference words. This is the primary input-accuracy gate when per-turn attribution is ambiguous.

### Spoken delivery and fidelity

Ignore SUT `reply_done`/UI/history counts for quality. Derive reply windows from recorded audio,
clamped to person_end and the next person's start. A continuous early reply may be clipped at
person_end; the omitted early prefix is a documented conservative limitation. For an interrupting
turn, output whose segment started before person_end cannot masquerade as the new answer.

- No attributable audio: **silent**, word coverage 0, response WER 1.
- Audio but no successful transcription: **unknown**, not success and not failure.
- Audio with transcript: ordered exact-word coverage (LCS/reference words) and ordinary response WER.
- Replies intentionally interrupted by the next scripted turn are excluded from complete-delivery
  aggregation. They remain in onset and interruption measures.
- An uninterrupted reply with <80% word coverage is `incomplete`; this does **not** identify echo
  as the cause. Removed the misleading claim that every omission is a self-interruption.

Word coverage is a transcription-based omission estimate. Extra/repeated speech may retain full
coverage but is penalized by response WER. Neither metric validates semantics, intonation, or ASR
correctness. Record the transcription model, keep identical settings across arms, and spot-check
outliers. No reference prompt is sent to the transcriber.

Supported transcription paths:
1. `OPENAI_API_KEY=… node bench/blackbox/analyze-v2.js <run.json>` uses whisper-1, with audio-hash
   and window-bound cached results. HTTP/network errors leave delivery unknown.
2. Generate v2 reports without a key, then run `transcribe-v2.py <run.json>…` using faster-whisper
   (default `small.en`, CPU int8, 4 threads, beam 5, English, no context conditioning), then run
   analyze-v2 again to consume those caches. Install faster-whisper in an isolated environment.

New local quality experiments use path 2 because both available OpenAI keys returned HTTP 429.
Do not mix transcription engines within a reported comparison. CPU transcription is run after
voice collection, not during it, to avoid contention affecting latency.

### Echo and noise

Echo words remain a lexical pollution proxy: response-only vocabulary in user finals. Filtered
finals are diagnostic counts, not a quality failure themselves. Acoustic incomplete replies are
reported separately; v2 does not invent an echo-causation score.

Noise bursts and the existing audio-derived noise-stop heuristic are retained as stops, stalls,
and exposure counts. They cannot establish causation from timing alone. Unsupported generic
“false barge-in” counts are not presented as proven zero. The current quality A/B does not run
the noise scenario; clean silence is not a noise-robustness test.

## Accuracy gate for the 32ms capture / fragmented presynthesis experiment

Compare against the **pre-optimization worktree including the reviewed cancellation fix**, not a
historical provider run. Five complete conversations per arm in each of clean, hesitation, echo;
identical scenarios, providers, thresholds, fixtures, scorer and transcriber. Deterministic
interleaved order BP PB BP PB BP (expanded B P P B B P P B B P).

Do not promote the runtime candidate automatically. Reject or investigate if it adds missing
replies, reported synthesis errors, interruption failures, talked-through turns, incomplete replies,
or loses STT attribution/transcription coverage. Require complete evidence for each metric being
claimed. Flag >1 percentage point worse input WER or >1 point worse uninterrupted word coverage
for investigation; a small sample is not a non-inferiority guarantee. Inspect echo leakage and
response-WER outliers rather than trading them away for speed. Report per-run medians and sample
counts: 30 turns are clustered into only five conversations, not 30 independent experiments.

No endpointing confidence, echo ratio, novel-character interruption threshold, system prompt, or
model is loosened for the candidate. The capture change preserves legacy RMS windows and preroll
sample duration. The pre-synthesis change is bounded to 32 deltas / 256 accumulated characters
before a first-word boundary, and never authorizes speculative tools.

## Rescore archived runs

```sh
# Timing, conservative input-WER and failure counts without paid transcription:
env -u OPENAI_API_KEY node bench/blackbox/analyze-v2.js bench/results/bb-EXAMPLE.json
# Optional local delivery check (same transcriber for all compared arms):
/path/to/venv/bin/python bench/blackbox/transcribe-v2.py bench/results/bb-EXAMPLE.json
env -u OPENAI_API_KEY node bench/blackbox/analyze-v2.js bench/results/bb-EXAMPLE.json
```

Do not fabricate missing transcript evidence from old `spokenRatio`. Recompute all compared rows
with v2 before publishing a v2 leaderboard; otherwise clearly mark old rows as historical v1.
