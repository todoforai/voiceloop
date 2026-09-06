# Candidate rejected by the accuracy gate

This is the 512-sample transport + fragmented presynthesis experiment measured on 2026-09-05.
It is **not enabled in the runtime**. The reviewed cancellation fix is still in the runtime.

`candidate.patch` applies to the pre-optimization worktree (git HEAD b6c9d27 plus the reviewed
cancellation patch). It includes source changes and nine regression tests. Do not apply blindly
to a changed worktree. `latency.test.js.txt` is retained for convenient inspection; it is not active.

The candidate improved clean voice→voice 833→614ms but failed hesitation quality: premature
turn fragmentation in 2/5 conversations shifted the mock response index, causing 4/30 off-script
or incomplete replies. Baseline: 0/30. Input word recognition itself was unchanged.

See `bench/results/QUALITY_V2_2026-09-05.md` and `bench/results/quality-v2-2026-09-05/`.

Next attempt should isolate transport vs prefetch (factorial ablation) and protect resumed turns
without reference-script matching or disabling the quality metric. Do not solve it by changing the
mock only for voiceloop. A script counter is imperfect, but premature turn splitting is real and
can cause premature tool actions in production; that failure needs explicit tests and handling.
