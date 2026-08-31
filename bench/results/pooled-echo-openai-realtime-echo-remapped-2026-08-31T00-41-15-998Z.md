# pooled: openai-realtime-echo / echo — 5 runs, 30 turns (re-analyzed with stt_final/barge_stop mapping)

| metric | pooled median (p95, range, n) |
|---|---|
| voice→voice | 793 (p95 1429, 610–1444, n=27) |
| first content word | 826 (p95 1444, 610–2187, n=26) |
| barge-in stop | 347 (p95 4605, 298–4605, n=8) |
| per-run v→v medians | 757, 830, 714, 729, 1079 |
| stalls / false barge-ins (total) | 199 / 204 |
| echo words / self-interruptions / echo drops (total) | 289 / 17 / 0 |
| user-interrupted (total) | 0 |