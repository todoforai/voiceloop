# Scoring v2.0: echo / candidate — 5 runs

| Metric | Value |
|---|---|
| Delivery transcriber | {"engine":"faster-whisper","model":"small.en","device":"cpu","compute_type":"int8","cpu_threads":4,"beam_size":5,"language":"en","condition_on_previous_text":false,"word_timestamps":true,"vad_filter":false,"faster_whisper_version":"1.2.1","ctranslate2_version":"4.8.2","cache_schema":1} |
| Voice→voice | 812ms (p95 1773, n=30) |
| Sustained barge-in stop | 1733ms (p95 2534, n=10) |
| Barge-in failures / no overlap | 0 / 0 |
| Missing person turns / no audio replies | 0 / 0 |
| Conversation STT WER (all finals, no attribution) | 13.9% |
| STT WER (non-oracle attribution) | 11.8% (24 scored) |
| STT observed / missing / ambiguous / unknown | 24 / 0 / 6 / 0 |
| Unassigned finals | 3 |
| Missing voice→voice timing | 0 |
| Reply word coverage, uninterrupted | 100.0% (20/20 observed) |
| Reply WER, uninterrupted | 0.0% |
| Incomplete replies (<80% words) | 0 / 20 |
| Stalls | 21 |
| Overlap / talked through | 0 / 0 |
| Yield | unknown |
| Echo words / filtered finals (lexical proxies) | 15 / 32 |
| Noise stops / stalls / bursts (heuristic) | 0 / 0 / 0 |
