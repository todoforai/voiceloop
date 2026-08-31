# voiceloop benchmark results

Black-box measurements: a scripted "person" (pre-generated ElevenLabs speech, byte-identical
every run) talks into a virtual mic; we record the agent's speaker output and derive every
number from **audio alone** — the same way a human would hear it. Internal milestones
(instrumented runs) only *explain* the audio-truth numbers, never replace them.

Method details: [`bench/README.md`](../README.md) · harness: [`bench/blackbox/`](../blackbox/)

**Single runs lie** (±300ms network/WASM jitter — we watched it flip conclusions), so every
configuration is 5 conversations × 6 turns, pooled (n=30 turns; barge-in n=10).

## The whole benchmark in one table

Three scenarios: **clean** (smalltalk), **hesitating user** (mid-sentence pauses), **echo**
(agent's own voice fed back into the mic, no AEC). Latency = voice→voice median; misbehavior =
talked over the user (hesitation) / cut its own reply (echo), out of 30 turns.

| system | clean | hesitation | overlap → talked through | echo | cut itself |
|---|---|---|---|---|---|
| OpenAI Realtime * | 870ms | 1290ms | 12/30 → **0** (yields in 130ms) | 790ms | **17/30** |
| **voiceloop** · deepgram + EL flash | 980ms | 1400ms | 2/30 → **0** (420ms) | 930ms | **0** |
| **voiceloop** · deepgram + Piper (free TTS, local) | 970ms | 1400ms | 0/30 → **0** | — | — |
| **voiceloop** · webspeech + Piper (zero-key, browser STT) | 2110ms | — | — | — | — |
| Pipecat 1.8.1 · same providers | 1050ms | 1290ms | 12/30 → **2** (200ms) | 1320ms | **20/30** |
| ElevenLabs ConvAI | 1450ms | 1810ms | 2/30 → **0** (490ms) | 1410ms | 0 |

**Overlapping the user is not a failure** — people do it constantly, and an agent that jumps in
during a pause and backs off the moment you keep talking is behaving correctly. So we score the
recovery, not the entry: *overlap* = turns the agent started speaking while the user still had
the floor, *talked through* = it kept going anyway, and the yield time is how fast it stopped
once the user resumed. Realtime enters early on 12 of 30 turns and yields every single time in
130ms — eager, but polite. Pipecat enters as often and rides over the user on 2 turns.

Speed rankings barely move across scenarios — **what changes is who recovers**. The remaining
hard failure is echo: two of the fast stacks hear their own voice as the user and cut their own
replies. Fast is table stakes; yielding when the user keeps talking — and not interrupting
yourself — is the actual test. Full per-scenario tables below.

\* speech-to-speech, its own LLM — every cascade system shares the fixed mock LLM; Realtime
is the disclosed exception (see caveats).

## Scenario: smalltalk (6 turns, 2 barge-ins, fixed mock LLM)

Every cascade system gets the **same brain**: a mock LLM with fixed responses, 300ms TTFT,
300 chars/s — so the numbers measure the voice pipeline, not the language model. OpenAI
Realtime is the disclosed exception (speech-to-speech, its own model).

| configuration | voice→voice median | p95 | barge-in stop | stalls |
|---|---|---|---|---|
| OpenAI Realtime (gpt-realtime, speech-to-speech) * | 866ms | 1644 | 429ms | 20 |
| **voiceloop** · deepgram + ElevenLabs flash TTS | **984ms** | 1169 | 1019ms | 15 |
| **voiceloop** · deepgram + Piper (free, local) | **974ms** | 1287 | 1463ms | 19 |
| Pipecat 1.8.1 · deepgram + EL flash TTS | 1046ms | 3573 | 542ms | 14 |
| ElevenLabs ConvAI (their full agent stack) | 1454ms | 1632 | 1042ms | 8 |
| **voiceloop** · EL Scribe + EL flash TTS | 1562ms | 1855 | 1566ms | 12 |
| **voiceloop** · Speechmatics + EL flash TTS | 1706ms | 2069 | 1046ms | 17 |
| **voiceloop** · webspeech + Piper (zero-key browser STT — the demo default) | 2113ms | 2607 | 1257ms | 30 |
| _TODOforAI shared-voice (our shipped Jarvis; internal)_ · deepgram + EL flash TTS | _1006ms_ | _1206_ | _1060ms_ | _16_ |
| _TODOforAI shared-voice (our shipped Jarvis; internal)_ · deepgram + Piper | _1246ms_ | _1839_ | _1226ms_ | _25_ |
| _TODOforAI shared-voice (our shipped Jarvis; internal)_ · webspeech + EL flash TTS | _1749ms_ | _2022_ | _716ms_ | _18_ |
| _TODOforAI shared-voice (our shipped Jarvis; internal)_ · webspeech + Piper (shipped default) | _1945ms_ | _2459_ | _700ms_ | _28_ |

voice→voice = end of the person's speech → first audible agent audio (from the recording).
barge-in stop = person starts interrupting → agent audio actually stops.

\* **own LLM — brain not identical**: Realtime is speech-to-speech and cannot call our fixed
mock LLM, so its row is not fully apples-to-apples (see caveats below).

### Where the milliseconds go (voiceloop, deepgram + EL flash)

| stage | deepgram + EL flash | webspeech + Piper (zero-key) |
|---|---|---|
| STT first partial (person start → first transcript) | 714ms | 591ms |
| end-of-turn delay (person end → turn committed) | 366ms | **1565ms** |
| TTS first audio (first LLM token → audible) | 418ms | 1656ms † |

The headline gap is **accounted for by one stage**: end-of-turn (1565 vs 366 ≈ 1.2s, and the
voice→voice gap is ~1.15s). Browser STT was *faster* to a first partial in these runs (591 vs
714ms) — it just takes far longer to close the turn.

† Not a Piper-vs-Piper comparison, for two reasons. This metric is measured from the *last* LLM
first-token to first audio, and on this path the LLM prefetch fires at ~469ms while the turn
doesn't commit until ~1570ms — so most of the 1656ms is the pipeline *waiting for end-of-turn*,
counted again. Measured from turn commit → first audio, the same warm turns are **556ms** (vs
1009ms on the deepgram row).

### Notes per configuration

- **Post-echo-fix regression check** — after the echo-filter fixes in src/ (32a2e34, c5a3bca)
  the clean smalltalk run was repeated on HEAD: 925ms pooled median (p95 1227, n=30, per-run
  medians 925–1033), 0 echo drops / 0 self-interruptions on the silent rig. The fixes cost
  nothing on the clean path; the table keeps the original 984ms as the conservative headline
  (both are within run-to-run jitter).
- **deepgram + EL flash** — best overall: human voice, lowest stall count of the fast configs,
  fastest barge-in of ours (mp3 clips need no un-cancellable local inference to drain).
- **deepgram + Piper** — same latency, zero TTS cost, fully offline voice. Piper's WASM synth
  runs in a worker (`ort.env.wasm.proxy`); first-word clip ~185ms on a 32-core box.
- **webspeech + Piper — the zero-key path, and what `examples/demo.html` runs by default.**
  2126ms is **2.2× the deepgram + Piper row** (974ms, same synthesizer), and the gap is
  end-of-turn: **EOT 1565ms vs 366**.
  What the traces show, per turn (n=30, browser event log): Chrome is still emitting interim
  frames at the moment the turn commits — on **30 of 30 turns** the last frame before commit
  still carried a non-empty interim tail. The last frame that added *new words* lands ~178ms
  **before** the person actually stops speaking; after that Chrome keeps re-emitting frames for
  a further ~591ms median, and the turn then commits ~1177ms after the very last frame. In other
  words the adapter still held an outstanding `interimTail` throughout the silence, and
  voiceloop's `flush()` defers the close for exactly that reason (`TAIL_MAX_DEFERS` ×
  `WEBSPEECH_EOT_MS`) — which is what turns a nominal 500ms debounce into ~1.5s.
  Two fixes were attempted and **neither improved the benchmark — both reverted, not shipped**:
  a short tail-poll instead of a full EOT window (2167ms — indistinguishable from baseline at
  this run's ±300ms jitter), and ignoring unchanged interim frames when re-arming the clock
  (2436ms *and* incorrect — 9 of 30 turns lost, 6 self-interruptions, 2 echo words).
  Tellingly, **EOT stayed ~1570ms in every variant** (1560 / 1588 / 1582), including the one
  that ignored repeats — so the cost is not the re-arming itself.
  A caveat for whoever picks this up: the harness records `stt_final` at *voiceloop's* turn
  close, not at Chrome's raw `isFinal`, so these traces cannot see when the engine actually
  promoted the tail. Instrumenting that boundary is the prerequisite for the next attempt —
  both failed fixes were tuning against a signal the bench can't observe.
  The honest price of the zero-key path: **no API key, no token endpoint, ~1.15s slower to
  answer.** Choose deepgram when latency matters; webspeech when setup cost does.
  **Turn-0 cold start (fixed).** Measuring this config surfaced a real bug: `start()` returns
  early for a selfCapture STT (it builds no mic pipeline) and that early return skipped the
  deferred `tts.warm()`, which lived only in the pipeline branch. So the zero-key path — the one
  path where nothing else is downloading — never pre-warmed Piper, and the *first* reply paid the
  full model download + WASM compile. First-audio on turn 0 went **5422/5526/5712/5731/10166ms →
  1037/1224/1362/1685/2609ms**, turn-0 voice→voice **6099 → 1930ms**, and the pooled p95 **6379 →
  2607ms**. Warm turns are unchanged (1641 → 1656ms), which is what confirms it was cold start and
  not a general shift. The headline median barely moves (2126 → 2113ms) because it was never a
  turn-0 number — but the worst thing a user experienced was the very first thing they heard.
- **EL Scribe / Speechmatics STT** — both gate the turn on late partials (~1.2–1.5s EOT):
  accurate transcripts, but not tuned for conversational end-of-turn. Deepgram flux's
  turn-events win this scenario.
- **OpenAI Realtime** — WebRTC via their standard browser flow (`/v1/realtime/calls`, ephemeral
  client secret minted server-side), default `server_vad` turn detection (threshold 0.5,
  silence 200ms — their stock config, untuned). To approximate the shared brain, the session
  instructions pin every turn to the scenario script; it complied **verbatim on all checked
  turns**. Latency is impressive but noisy: per-run v→v medians spanned 628–1368ms (>2×),
  the widest spread of any SUT. Barge-in stop of 429ms is the fastest measured — its VAD-based
  `interrupt_response` cuts audio quickly, the flip side being that any noise could do it
  (word-based SUTs like voiceloop can't be noise-interrupted; here 0 false barge-ins only
  because the rig is silent between lines). The short "Yes." turn was often not detected as a
  separate reply (n=26 of 30 turns).
- **Pipecat** — `bench/blackbox/sut-pipecat.py`: the official local-audio example
  (PipelineWorker/WorkerRunner) with the same provider vendors as our winning config — Deepgram
  STT, the same ElevenLabs flash voice, the shared mock LLM on localhost. Same vendors ≠ same
  config, though: Pipecat's stock integration is nova-3 STT + SileroVAD start +
  `LocalSmartTurnAnalyzerV3` end-of-turn, where voiceloop uses Deepgram **Flux** with its native
  turn events — so the row compares each framework's out-of-the-box turn-taking stack, not
  orchestration overhead alone. Per-run v→v medians were among the tightest measured
  (1035–1105ms). Two faces: the fastest barge-in of the cascade systems (542ms median; only
  speech-to-speech Realtime is quicker) — its VAD-triggered interruption cuts output
  immediately, no transcription gate — but two failure modes fatten the tail. (1) The
  smart-turn model judges "Stop stop, just tell me one word, yes or no." INCOMPLETE and holds
  the turn ~2.8s past end of speech (~3.5s v→v on that turn in every run; all other turns
  0.6–1.5s). (2) **Self-interruption**: when nova-3 splits an utterance into two finals
  ("Hey there." + "can you hear me properly?"), smart-turn commits on the first and the late
  second final triggers `TranscriptionUserTurnStartStrategy` — the framework interrupts its own
  nascent reply, the recovery stop fires no inference, and the orphaned reply flushes after the
  NEXT turn (2/5 runs lost turn 0 this way → v→v n=28, and the flushed audio adds stalls). VAD
  barge-in also means loud non-speech noise can cut the agent's output; voiceloop's word-based
  gate needs transcribed words (both showed 0 false barge-ins here — the scripted audio is
  clean speech).
- **TODOforAI shared-voice** — NOT a competitor: our own product's shipped voice agent
  (`todoforai/packages/shared-voice`), benchmarked via a thin SUT page + `/llm` wire shim
  (`packages/shared-voice/bench/`). It no longer carries a fork of this library: it consumes
  published voiceloop 0.1.8 and adds only the JARVIS persona, LLM adapter and todo tools, so
  these rows now measure *integration overhead*, not a second implementation.

  **All four rows re-measured on 0.1.6.** The previous 2241/1801ms pair was taken on 0.1.5,
  before the TTS pre-warm fix, and is superseded — quoting it against today's stack overstates
  our latency by ~500ms. On 0.1.6 the shipped webspeech+Piper default is **1945ms** and
  deepgram+Piper is **1246ms** (was 1801). The pre-warm fix is the whole difference:
  commit→first-audio on deepgram+Piper drops to 801ms.

  **STT and TTS fix different halves of the turn, and only both together reach ~1s:**

  | | EOT | commit→audio | v→v |
  |---|---|---|---|
  | webspeech + Piper (shipped) | 1558 | 455 | 1945 |
  | webspeech + EL flash | 1561 | 179 | 1749 |
  | deepgram + Piper | 416 | 801 | 1246 |
  | deepgram + EL flash | 346 | 693 | 1006 |
  | deepgram + EL flash, 0.1.7 | 408 | 431 | **840** |

  Deepgram buys the EOT (~1.2s: Chrome's endpointer, not our code — voiceloop measures the
  same 1565ms on the same browser STT). EL flash buys the synthesis. Only both together reach
  ~1s (**1006ms**), which lands on voiceloop·deepgram's own 984ms. With ±300ms run-to-run
  jitter that 22ms difference is not a measurement: the honest claim is **no integration
  overhead detectable at this rig's resolution**, and what separates our shipped default from
  the top of the table is provider choice rather than a gap in our code.

  **The last row is a library fix these rows found.** Chasing the remaining commit→audio time
  showed the LLM's first token arriving *after* the commit on 21/30 deepgram turns — the
  speculative prefetch was never being adopted. It was never being *started*: the speculation
  waits for the interim to go stable for 200ms, which assumes a trailing-silence debounce to
  wait inside. Flux ends turns semantically, a median **21ms** behind its own last interim
  (webspeech leaves ~1.2s), so the timer never fired and every flux turn paid full LLM TTFT.
  Providers now declare their own `prefetchMs` (flux: 0). Prefetch adoption goes 9/12 → 30/30
  and deepgram + EL flash drops **1006 → ~820ms** (four runs: 827/814/861/808), now *below*
  voiceloop's own 984ms because the fix ships in 0.1.8 and lifts that row too when re-measured.
  Webspeech is unchanged (1808ms, within jitter of 1945) — it keeps the 200ms wait, since
  speculating on its every interim tick would burn requests for no gain.

  Speculating on the interim tick costs requests, so we counted them at the bench server rather
  than reasoning about it: **7.7 LLM requests per turn, against 7.25 before the change** (2 runs,
  12 turns). Flux revises its interim often and each revision already replaced the running
  speculation; removing the wait adds ~6%, not a new order of magnitude. Only one request is ever
  live (each revision aborts its predecessor), but they are billed for the prompt they sent, so a
  metered LLM pays roughly turn-count × revisions in input tokens either way.

  Caveat on the per-stage column: the `TTS first audio` metric is measured from the LLM's
  first token, so it absorbs LLM streaming time and reads high (1294ms) for webspeech+EL even
  though presynth hit on 25/30 turns there. Measured from turn commit — what the user actually
  waits — the same config is **179ms**. Use commit→audio when comparing TTS engines; it is the
  pooled median of `voiceToVoiceMs - eotMs` over all 30 turns (equivalently, commit→next
  `clip_start` scanned from the raw events — both give the same figures above).

  Barge-in is word-based like voiceloop (0 false barge-ins) at 700–1226ms across configs, but
  with n=10 and overlapping ranges those differences are not separable from noise.

  Not deployable as-is: **production has no TTS proxy route** (the backend serves STT tokens
  only), so the EL flash rows measure a route that would have to be built, and EL TTS is
  metered where Piper is free.

  **`crossOriginIsolated` is not the Piper fix it looks like.** This rig runs isolated
  (COOP+COEP, multi-threaded ONNX) and the SUT doesn't, which is the obvious suspect for the
  Piper gap — so it was measured directly, A/B on the same SUT (`COI=1 node bench/serve.js`):

  | | v→v median | p90 | max | TTS p90 |
  |---|---|---|---|---|
  | not isolated (production today) | **1374** | 2314 | 2768 | 1794 |
  | isolated | **1446** | **1867** | **1973** | **1199** |

  **No median improvement was detected** — the 72ms shift is well inside run-to-run jitter (and
  EOT, which isolation cannot affect, moved 504→329ms in the same pair, showing how much of this
  is noise). What does reproduce is a tighter tail. An isolated ONNX microbench shows the
  mechanism and its ceiling: 1 thread 2644ms → 4 threads 1935ms (−27%), then flat (8: 2058,
  32: 1999) — threading caps out around 4 and never touches the typical synth. So isolating the
  origin buys tail behaviour at best, while switching TTS engine moves the median by 240–500ms;
  the EL flash row above is the better lever.
- **ConvAI** — measured through their standard `@elevenlabs/client` SDK with a default-config
  agent (scribe_realtime ASR, `turn_v3`/normal eagerness, `optimize_streaming_latency: 3`; we
  even upgraded its TTS from the default turbo_v2 to the faster flash_v2). Per-run medians were
  tight (1438–1501ms) and match ElevenLabs' own published ~1.5s ConvAI latency — this is the
  product's real number, not a rig artifact. Barge-in is competitive (1042ms; energy-VAD vs our
  word-based barge-in — we require real transcribed words, so background noise never falsely
  stops the agent: 0 false barge-ins in every config).

### Fairness caveats (both directions)

- **ConvAI pays a network toll we don't**: its custom-LLM calls travel EL cloud → Cloudflare
  tunnel → our mock, while voiceloop hits it on localhost. Measured tunnel overhead from here is
  ~170–240ms TTFB. Even crediting ConvAI the full ~240ms (→ ~1210ms), voiceloop at 984ms is
  still ~230ms ahead — and in production voiceloop's LLM is a real network hop too.
- **AEC is disabled for every SUT** (including ConvAI): virtual devices have no acoustic echo,
  and Chrome AEC with nothing to cancel suppresses the person's barge-ins. This helps, not
  hurts, each system.
- ConvAI is a closed box, so its EOT/STT sub-metrics come from SDK callback timing and are not
  comparable to our instrumented splits; only the audio-truth columns (voice→voice, barge-in,
  stalls) are apples-to-apples.
- **Pipecat mock-LLM contract**: our mock picks the scripted response by counting user messages;
  Pipecat's aggregator sometimes emits one utterance as two user messages (split STT finals), so
  the SUT merges consecutive user messages before each request — request normalization only, no
  timing change. This removed the off-script fallback replies of an earlier run (all heard
  speech is now script text, whisper-checked), but it cannot repair the self-interruption case:
  when a reply is swallowed, the next request has two genuine turns with no assistant message
  between them, the merge collapses them, and the script stays shifted by one for parts of those
  runs (2/5) — shifted reply text can move sentence boundaries, so read the stall count with
  that in mind. The self-interruption itself is Pipecat default-config behavior, kept in the
  numbers. Pipecat runs as a
  native process (`run-proc.js` restarts it per run), audio via pyaudio→pulse on the same
  bench_mic/bench_spk pair; its mock-LLM calls are localhost, same as voiceloop's.
- **OpenAI Realtime does not use the shared mock LLM at all** — it is speech-to-speech, so its
  "brain" is gpt-realtime itself. Every other row pays the mock's simulated 300ms TTFT +
  300 chars/s streaming; Realtime pays whatever its internal model latency is instead. We
  pinned its outputs to the same script via instructions (and verified verbatim compliance),
  but the row measures a different architecture, not the same pipeline with a different voice
  layer. Directionally: no external LLM hop helps it; producing tokens with a real model
  instead of a 300ms mock hurts it. Treat its numbers as "the product as shipped", not as a
  pipeline comparison.

## Scenario: hesitation (6 turns, 400–900ms mid-utterance pauses, fixed mock LLM)

The scenario where **aggressive endpointing pays its bill**. Every person line contains
scripted mid-utterance pauses (450–900ms, rendered as exact silence between separately
synthesized segments — gap durations verified against the script within ±30ms) and
false-completion phrasings that *sound* finished but aren't: "I'd like to book … umm … a table
for four", "Send the confirmation to my email. … Actually, make that a text message."

Eagerness is *allowed*: entering a pause is a legitimate strategy, and humans overlap each
other constantly. What separates a natural overlap from steamrolling is whether the agent
**yields once the user keeps talking**. Three columns make that visible:

- **overlap** = turns where agent audio started while the person still had the floor (a
  mid-utterance pause is still their floor). Not a failure by itself.
- **talked through** = of those, the turns where the agent kept speaking over the resuming
  user instead of backing off. This is the failure.
- **yield** = person resumes → agent audio stops. How fast it takes the hint.
- **first content word** = first agent word matching the scripted response (whisper word
  timestamps on the recorded audio), so a filler head start reads as "fast audio, slower
  content" instead of silently winning voice→voice.

| configuration | voice→voice | first content word | overlap | talked through | yield | vs smalltalk v→v |
|---|---|---|---|---|---|---|
| OpenAI Realtime (gpt-realtime) * | 1285ms (p95 1686) | 1325ms | 12 / 30 | **0** | 130ms | +419ms |
| Pipecat 1.8.1 · deepgram + EL flash | 1288ms (p95 1860) | 1815ms | 12 / 30 | **2** | 200ms | +242ms |
| **voiceloop** · deepgram + EL flash | 1396ms (p95 1709) | 1457ms | 2 / 30 | **0** | 420ms | +412ms |
| **voiceloop** · deepgram + Piper | 1400ms (p95 2006) | 1400ms | 0 / 30 | **0** | — | +~350ms |
| ElevenLabs ConvAI | 1807ms (p95 2069) | 1838ms | 2 / 30 | **0** | 490ms | +353ms |

The eager stacks buy their ~110ms speed edge by entering the user's pauses on 40% of turns —
and mostly get away with it, because they yield fast (Realtime in 130ms, every single time).
Only Pipecat actually rides over the user, on 2 of 30 turns. The honest reading is not "fast =
rude": it's that eager endpointing is only safe if the recovery reflex is intact, and the two
columns must be read together. voiceloop trades ~110ms for rarely needing the reflex at all;
Realtime keeps the speed and leans on the reflex. Both are defensible designs.

### Notes per configuration

- **voiceloop (both TTS)** — Deepgram flux's turn model holds through the pauses: 2 and 0
  premature entries in 30 turns each. The price is honest and visible: EOT delay grows from
  366ms (smalltalk) to ~1210ms — flux waits out the hesitation before committing. First
  content word ≈ voice→voice (no filler strategy in play).
- **Pipecat** — `LocalSmartTurnAnalyzerV3` commits mid-pause on 12 of 30 turns; it yields in
  200ms when the person resumes, but on 2 turns it talked through them. The typical shape is:
  agent enters the pause, user resumes, VAD cuts the nascent reply, the reply re-fires after
  the real end of turn. v→v 1288ms looks fast, but first content word is 1815ms — the early
  entries mostly delivered audio that then got cut, not content.
- **OpenAI Realtime** — default `server_vad` (200ms silence) treats most scripted pauses as end
  of turn: it entered early on 12 of 30 turns, and **yielded on all 12, median 130ms** — the
  fastest recovery in the field (same reflex as its fast barge-in stop). Eager but polite; the
  cost is that the premature audio gets cut and re-started, so content word p95 is 3352ms.
- **ConvAI** — `turn_v3` (normal eagerness) behaves like voiceloop: 2 premature entries,
  pauses absorbed. It pays with the highest v→v (1807ms; +353 vs its smalltalk 1454). One
  quirk required a rig fix, disclosed below.

### Caveats

- **Mock-LLM phantom-turn guard (affects ConvAI only)**: ConvAI's `turn_timeout` (7s default)
  can commit an *empty* user turn (`"…"`) during pre-conversation silence; counting it shifted
  the script by one for the whole run (the agent then answers turn k with response k+1 — and
  turn-final "I have nothing scripted"). The mock LLM now ignores empty/`...` user messages
  when selecting the scripted response (`bench/server.js`), a request-normalization change
  identical in spirit to the Pipecat merge fix; no timing behavior changed. The other SUTs
  never produce phantom turns, so their rows are unaffected.
- Sub-metric columns (EOT, STT partial, TTS first audio) exist only for voiceloop
  (instrumented); ConvAI/Realtime/Pipecat rows are audio-truth only, as in smalltalk.
- Realtime brain caveat as in smalltalk (own model, script pinned via instructions). On this
  scenario it stayed on script; its premature entries usually restart with the correct
  scripted line after the person finishes.
- No scripted barge-ins in this scenario, so the barge-in stop column doesn't apply.

## Scenario: echo (smalltalk + speaker→mic coupling, −15dB / 30ms)

The driver mixes the agent's own speaker output back into the mic (software tap on
`bench_spk.monitor`, attenuated −15dB, delayed 30ms) — a laptop speaker/mic without working AEC.
Chrome AEC stays **off for every SUT** so the coupling hits everyone equally; surviving it is up
to each stack's own echo strategy. Same smalltalk turns; brain comparability as in smalltalk
(voiceloop/Pipecat/ConvAI share the mock LLM, Realtime is its own model).

| configuration | voice→voice | self-interruptions | echo words in transcript | barge-in stop |
|---|---|---|---|---|
| **voiceloop** · deepgram + EL flash | **931ms** (p95 2035) | **0** / 30 turns | 14 | 1460ms |
| Pipecat 1.8.1 · deepgram + EL flash | 1317ms (p95 1893) | **20** / 30 turns | n/a (no transcript events) | 767ms |
| OpenAI Realtime (gpt-realtime) * | 793ms (p95 1429) | **17** / 30 turns | 289 | 347ms |
| ElevenLabs ConvAI | 1408ms (p95 1636) | **0** / 30 turns | 0 | 568ms |

self-interruptions = the agent cut its own reply with nobody talking (audio truth: reply
delivered <80% outside scripted interrupts, or an explicit cut outside every person-speech
window). echo words = response-script words appearing in the SUT's *user* transcript.

- **voiceloop** — the run that motivated this scenario: the word-based self-echo filter
  (STT text fuzzy-matched against the audible reply prefix) had never faced real coupling.
  It initially failed in three ways, all fixed in `src/voice-agent.js` (see notes below):
  final result **0 self-interruptions, 0 false barge-ins, v→v at parity with clean smalltalk**
  (931 vs 984ms — echo handling costs no latency once the filter classifies correctly). The
  filter's 30 echo drops caught the echoed replies; 14 stray reply words still reached
  committed user-side transcripts (~3 per run) without consequence — no false turn, no
  self-interruption resulted.
- **Pipecat** — default config self-interrupts on 20 of 30 turns: its energy-VAD
  `interrupt_response` hears the agent's own voice as the user and cuts the reply; with the
  reply swallowed the script shifts and parts of runs derail. No echo filtering in the default
  pipeline.
- **OpenAI Realtime** — server VAD hears its own echo as user speech constantly: 289
  response-script words landed in its user transcript and it truncated its own answers 30–68
  times per 6-turn run (17 audible self-interruptions; its fast regenerate often re-covers the
  script, which keeps v→v looking good while the conversation audibly stutters and repeats —
  199 stalls). Their docs assume client-side AEC (`echoCancellation: true`); with it off, the
  stack has no defense. Its fast barge-in stop (347ms) is the same reflex that self-triggers.
- **ElevenLabs ConvAI** — clean: 0 self-interruptions, 0 echo words. Their server-side stack
  evidently does its own echo suppression regardless of browser AEC. Latency unchanged vs
  clean smalltalk (1454→1408ms).

Takeaway: word-level echo filtering (voiceloop) and server-side suppression (ConvAI) both
survive raw coupling; energy-VAD interruption without echo defense (Pipecat default, Realtime
without client AEC) audibly breaks. voiceloop is the only one of the survivors that also keeps
sub-1.2s v→v with the shared mock brain.

\* Realtime caveats as in smalltalk (own brain). Its echo numbers come from remapping its
`input_audio_transcription.completed`/`output_audio_buffer.cleared` events to the bench's
canonical `stt_final`/`barge_stop`.

### voiceloop fixes the echo scenario forced (src/voice-agent.js)

1. **Cross-turn echo scope** — a new turn cleared the echo reference while the previous
   reply's echo tail was still in flight (acoustic delay + STT latency); those words looked
   novel and barged in on the new reply, cascading. The previous reply's audible text is now
   parked and included in echo classification within the 2s post-playout grace window.
2. **Cursor lag** — the proportional time→text spoken cursor lags real audio, so echo partials
   contained words just *ahead* of it and un-latched the filter. Echo is now judged against
   prefix + the whole clip playing (a safe upper bound — echo can't be ahead of the audio), while
   the UI keeps the precise cursor.
3. **Short echo finals** — fast-endpointing STT closes echo as short finals ("Yes.") that could
   never reach the fixed 3-hit drop threshold and became user turns the agent answered; the
   threshold now scales with the final's own length.

The clip-bounded reference is clamped back to the actually-heard prefix the moment playback
stops (finish or barge-in), so a user quoting the reply's *unspoken* remainder can never be
swallowed as echo.

Before the fixes (pooled smoke/diag/fix1 runs, 6 turns each): 1 self-interruption *per run*
with 6–11 echo words leaking, v→v 1518–1849ms — every run corrupted by turn-0's cascade
shifting the script. After: 0 self-interruptions in 30 turns, v→v 931ms.

## Environment

- AMD Threadripper 1950X (32 threads), Linux, Chrome 138, Node 24
- PulseAudio virtual devices (`bench_mic` / `bench_spk`), AEC off (no acoustic coupling to cancel)
- Network: real cloud round-trips to Deepgram / ElevenLabs / Speechmatics EU-adjacent from Europe

## Reproduce

```sh
bench/blackbox/audio-setup.sh up
node bench/blackbox/gen-audio.js smalltalk        # once (needs ELEVENLABS_API_KEY, or espeak fallback)
DEEPGRAM_API_KEY=… ELEVENLABS_API_KEY=… node bench/server.js smalltalk &
PULSE_SOURCE=bench_mic PULSE_SINK=bench_spk google-chrome --user-data-dir=/tmp/sut \
  --remote-debugging-port=9223 --use-fake-ui-for-media-stream \
  --autoplay-policy=no-user-gesture-required \
  'http://localhost:7777/bench/blackbox/agent.html?stt=deepgram&tts=elevenlabs'
node bench/blackbox/run-n.js smalltalk mylabel 5 9223

# process SUTs (e.g. Pipecat) use the process runner instead of a Chrome page:
PULSE_SOURCE=bench_mic PULSE_SINK=bench_spk DEEPGRAM_API_KEY=… ELEVENLABS_API_KEY=… \
  node bench/blackbox/run-proc.js smalltalk pipecat 5 -- \
  /tmp/pipecat-venv/bin/python bench/blackbox/sut-pipecat.py
```

Raw per-run artifacts (`bb-*.json`, `*.agent.raw` recordings) are not tracked — every pooled
summary in this directory was produced by `run-n.js` (or `run-proc.js` for process SUTs) from
5 fresh runs.

Want your agent in this table? See [`bench/ADDING_A_SUT.md`](../ADDING_A_SUT.md) for the SUT
contract, fairness rules and PR checklist.
