# Scoring v2.0: smalltalk / candidate — 5 runs

| Metric | Value |
|---|---|
| Delivery transcriber | {"engine":"faster-whisper","model":"small.en","device":"cpu","compute_type":"int8","cpu_threads":4,"beam_size":5,"language":"en","condition_on_previous_text":false,"word_timestamps":true,"vad_filter":false,"faster_whisper_version":"1.2.1","ctranslate2_version":"4.8.2","cache_schema":1} |
| Voice→voice | 614ms (p95 958, n=30) |
| Sustained barge-in stop | 1333ms (p95 1474, n=10) |
| Barge-in failures / no overlap | 0 / 0 |
| Missing person turns / no audio replies | 0 / 0 |
| Conversation STT WER (all finals, no attribution) | 0.0% |
| STT WER (non-oracle attribution) | 0.0% (14 scored) |
| STT observed / missing / ambiguous / unknown | 14 / 0 / 16 / 0 |
| Unassigned finals | 8 |
| Missing voice→voice timing | 0 |
| Reply word coverage, uninterrupted | 100.0% (20/20 observed) |
| Reply WER, uninterrupted | 0.0% |
| Incomplete replies (<80% words) | 0 / 20 |
| Stalls | 17 |
| Overlap / talked through | 0 / 0 |
| Yield | unknown |
| Echo words / filtered finals (lexical proxies) | 0 / 0 |
| Noise stops / stalls / bursts (heuristic) | 0 / 0 / 0 |
