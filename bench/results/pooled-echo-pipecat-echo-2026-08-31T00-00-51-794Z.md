# pooled: pipecat-echo / echo — 5 runs, 30 turns

| metric | pooled median (p95, range, n) |
|---|---|
| voice→voice | 1317 (p95 1893, 205–4105, n=28) |
| first content word | 1366 (p95 1902, 205–1902, n=18) |
| EOT delay | — |
| TTS first audio | — |
| STT first partial | — |
| barge-in stop | 767 (p95 1555, 598–1555, n=10) |
| per-run v→v medians | 1422, 1323, 1539, 833, 1492 |
| stalls / false barge-ins (total) | 18 / 0 |
| agent-stalled-by-noise (total) | 0 |
| user-interrupted (total) | 3 |
| echo words / self-interruptions / echo drops (total) | 0 / 20 / 0 |