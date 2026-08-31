# pooled: vl-webspeech-piper / smalltalk — 5 runs, 30 turns

| metric | pooled median (p95, range, n) |
|---|---|
| voice→voice | 2126 (p95 6379, 1817–10810, n=30) |
| first content word | 2126 (p95 6379, 1817–10810, n=29) |
| EOT delay | 1565 (p95 1668, 1445–1671, n=30) |
| TTS first audio | 1665 (p95 5731, 1353–10166, n=30) |
| STT first partial | 591 (p95 796, 397–807, n=30) |
| barge-in stop | 976 (p95 1549, 457–1549, n=10) |
| per-run v→v medians | 1920, 2206, 2275, 2202, 2126 |
| stalls / false barge-ins (total) | 28 / 0 |
| agent-stalled-by-noise (total) | 0 |
| echo words / self-interruptions / echo drops (total) | 0 / 0 / 0 |
| user-interrupted (total) | 0 |