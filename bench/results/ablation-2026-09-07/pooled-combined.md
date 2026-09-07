# Scoring v2.0: hesitation / combined, 5 runs

| Metric | Value |
|---|---|
| Delivery evidence | complete for eligible replies |
| Delivery transcriber | {"engine":"faster-whisper","model":"small.en","device":"cpu","compute_type":"int8","cpu_threads":4,"beam_size":5,"language":"en","condition_on_previous_text":false,"word_timestamps":true,"vad_filter":false,"faster_whisper_version":"1.2.1","ctranslate2_version":"4.8.2","cache_schema":1} |
| Voice→voice | 1257ms (p95 1688, n=30) |
| Sustained barge-in stop | unknown |
| Barge-in failures / no overlap | 0 / 0 |
| Missing person turns / no audio replies | 0 / 0 |
| Conversation STT WER (all finals, no attribution) | 4.7% |
| STT WER (non-oracle attribution) | 4.6% (30 scored) |
| STT observed / missing / ambiguous / unknown | 30 / 0 / 0 / 0 |
| Unassigned finals | 0 |
| Missing voice→voice timing | 0 |
| Reply word coverage, uninterrupted | 66.7% (30/30 observed) |
| Reply WER, uninterrupted | 34.4% |
| Incomplete replies (<80% words) | 10 / 30 |
| Stalls | 29 |
| Overlap / talked through | 5 / 0 |
| Yield | 460ms (p95 600, n=5) |
| Echo words / filtered finals (lexical proxies) | 0 / 0 |
| Noise stops / stalls / bursts (heuristic) | 0 / 0 / 0 |
