# X post draft — new best in the voiceloop bench

## Main post

We swapped the STT in voiceloop and got a new best on our black-box voice-agent bench:

voice→voice, clean speech (5 runs × 6 turns, audio truth, same TTS + LLM):

Soniox stt-rt-v5      768 ms  ← new
Deepgram Flux         857 ms
OpenAI Realtime       870 ms
Pipecat (same stack) 1050 ms
ElevenLabs ConvAI    1450 ms

Hesitating user (mid-sentence pauses): 1014 ms vs 1446 ms on Flux.
0% WER on both. $0.12/hr vs $0.39/hr. 60+ languages incl. Hungarian.

The catch, measured honestly: Soniox's endpointing is acoustic. It enters a mid-sentence pause on
15/30 hesitation turns and talks through 7. Flux: 0. We fixed the obvious half (it marks a cut-off
phrase with an em-dash — we hold those and merge) and took 22/30 → 7/30. The rest needs a
semantic turn model.

So: Soniox is the new default in TODOforAI voice. Flux stays one click away if "never interrupt me"
matters more than 100–400 ms.

Bench + every raw run is in the repo. Rerun it, break it, tell us.
github.com/todoforai/voiceloop

## Reply 1 (thread)

How we got there:
- Soniox `endpoint_latency_adjustment_level`: 0 → 1042 ms, 2 → 768 ms, 3 → 726 ms but splits
  "Hey there." | "Can you hear me?" into two turns every run. Shipped 2.
- `endpoint_sensitivity` and `max_endpoint_delay_ms`: no measurable effect on hesitations.
- Turn 0 pays ~2 s cold (temp-key mint + WS open) → we now pre-mint on mic hover like Deepgram.

## Reply 2

Echo scenario (agent's own voice fed back into the mic, no AEC):
Soniox 1147 ms, 0 self-interruptions, 4.6% WER
Flux    874 ms, 0 self-interruptions, 19.3% WER (its transcript picks up the echoed reply words)
Our word-level echo filter holds either way.

## Media

Table screenshot of bench/results/SONIOX-VS-DEEPGRAM.md headline table.
