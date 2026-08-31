# pooled: jarvis-deepgram / smalltalk — 5 runs, 30 turns

| metric | pooled median (p95, range, n) |
|---|---|
| voice→voice | 1801 (p95 2556, 783–3086, n=30) |
| first content word | 1872 (p95 2556, 783–3086, n=29) |
| EOT delay | 401 (p95 910, -164–1593, n=30) |
| TTS first audio | 1271 (p95 1974, 239–2492, n=30) |
| STT first partial | 752 (p95 960, 451–970, n=30) |
| barge-in stop | 1379 (p95 1894, 465–1894, n=10) |
| per-run v→v medians | 2030, 1823, 2171, 1570, 1872 |
| stalls / false barge-ins (total) | 25 / 0 |
| agent-stalled-by-noise (total) | 0 |
| echo words / self-interruptions / echo drops (total) | 0 / 0 / 0 |
| user-interrupted (total) | 0 |