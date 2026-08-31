# pooled: openai-realtime-echo / echo — 5 runs, 30 turns

| metric | pooled median (p95, range, n) |
|---|---|
| voice→voice | 793 (p95 1429, 610–1444, n=27) |
| first content word | 826 (p95 1444, 610–2187, n=26) |
| EOT delay | — |
| TTS first audio | — |
| STT first partial | — |
| barge-in stop | — |
| per-run v→v medians | 757, 830, 714, 729, 1079 |
| stalls / false barge-ins (total) | 199 / 0 |
| agent-stalled-by-noise (total) | 0 |
| echo words / self-interruptions / echo drops (total) | 0 / 0 / 0 |
| user-interrupted (total) | 0 |