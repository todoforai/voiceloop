# pooled: jarvis-deepgram-016 / smalltalk — 5 runs, 30 turns

| metric | pooled median (p95, range, n) |
|---|---|
| voice→voice | 1246 (p95 1839, 657–1879, n=30) |
| first content word | 1269 (p95 1839, 657–1879, n=28) |
| EOT delay | 416 (p95 928, -24–1147, n=30) |
| TTS first audio | 667 (p95 1186, 222–1207, n=30) |
| STT first partial | 757 (p95 946, 554–1804, n=30) |
| barge-in stop | 1226 (p95 1605, 497–1605, n=10) |
| per-run v→v medians | 1334, 1269, 1358, 1205, 1181 |
| stalls / false barge-ins (total) | 25 / 0 |
| agent-stalled-by-noise (total) | 0 |
| echo words / self-interruptions / echo drops (total) | 0 / 0 / 0 |
| user-interrupted (total) | 0 |