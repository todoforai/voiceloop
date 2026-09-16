# Soniox stt-rt-v5 vs Deepgram Flux — smalltalk, 5 runs each (2026-09-16)

voice→voice = person stops speaking → first agent audio (ms, from the black-box audio truth).
Turn 0 excluded from steady-state: it includes STT cold-connect (bench starts speaking immediately).

| Config | steady-state median | p95 | turn-0 median | WER | mid-sentence splits |
|---|---|---|---|---|---|
| Deepgram Flux (default) | 857 | 1045 | 652 | 0% | 0/30 |
| Soniox, endpoint level 0 (API default) | 1042 | 1171 | 2659 | 0% | 0/30 |
| **Soniox, endpoint level 2 (voiceloop default)** | **768** | 973 | 2676 | 0% | 0/30 |
| Soniox, endpoint level 3 | 726 | 1105 | 632 | 0% | 10/30 ("Hey there." / "Great." cut off) |

- Both providers: 0 barge-in failures, 0 missed turns.
- Soniox turn-0 cost is token mint + WS open (~2 s); in the app the socket is opened at start(), so
  this only matters if the user speaks within ~2 s of pressing the mic.
- Reply-quality metrics (offline transcriber) unavailable — OpenAI 429 during scoring.
- Price: Soniox $0.12/h vs Deepgram Flux ~$0.39/h. Soniox has Hungarian; Flux is English-only.
