# Architecture and simplicity review — 2026-09-08

Reviewed active commit 2198faf, not the rejected 512-sample candidate. Read-only runtime review;
no deployment, packet-size change, endpoint change or refactor. Two local fake-synthesis probes
were run without browser, audio, keys or network.

## Verdict

Keep the architecture: small provider adapters, one turn serializer, speculative preparation,
serial synthesis and abortable playback. Do not replace it with a framework, event bus or generic
workflow engine. The implementation is not yet the simplest expression of that architecture:
provider endpoints, application turn acceptance, spoken text and actions need clearer boundaries.
A 2100-line voice-agent.js includes orchestration, text transforms, audio helpers, StreamingTTS
and Piper; its line count includes substantial comments. File size alone is not a correctness bug.

## Prioritized findings

### 1. Plain reply text can become an action — high-priority design risk

`src/voice-agent.js:103–171, 980–985, 997` parses model-generated `[TOOL CALL …]` ledger mimicry
into executable tool chunks. There are consequently two action channels: structured adapter
calls and ordinary model text. This increases parser/dedup complexity and makes quoting or
explaining the ledger syntax potentially action-bearing. No adversarial reproduction was run.

Prefer structured tool chunks as the sole executable channel; plain reply text should remain
non-executable. If legacy integrations genuinely require textual tools, keep that conversion in
an explicit opt-in adapter, not the default speech path. Preserve already executed outcomes and
provider call IDs. This is a behavior change: existing mimicry tests intentionally expect execution,
so removal requires a documented compatibility decision rather than deleting the parser blindly.

### 2. Native provider final is also application turn commitment — observed limitation

`src/stt.js:555–565` reduces Flux TurnInfo to text + elapsed ms, dropping turn_index, confidence and
audio-span metadata. `src/voice-agent.js:333–361` accepts nonempty, non-echo finals into a reply.
`_endOfSpeech():1136–1145` deliberately bypasses local VAD/detector commitment for nativeEOT.

This is a reasonable minimal default, but it leaves no central acceptance boundary with enough
provenance to reason about a provider's premature endpoint. The ablation exposed that limitation.
The existing toolGate protects uncommitted speculation; after acceptance, it is not independent
user authorization and cannot undo an irreversible tool action.

Smallest direction: preserve optional provider-final metadata through the callback; route speech
final acceptance through one named method, initially retaining today's behavior. Only introduce a
provisional/merge policy when packetization experiments justify it. Do not add a universal delay,
consult VAD alone, or maintain both old and new competing commitment paths.

### 3. Speculative cache is bounded; speculative WORK is not — confirmed

`src/voice-agent.js:1643–1656`: presynth replaces `_preClip`, but its `_enqueueSynth` call has no
abort signal or cache-generation check. Repeated changes to the predicted opening text can leave
obsolete jobs ahead of the useful job in the same serialized queue.

Local controlled probe: hold synthesis of “first”; enqueue “second”, then “third”; release first.
The cache points only to “third”, but synth executes **first, second, third**. Single-slot storage
therefore does not imply single-job work. This is not proof that it caused the observed Flux splits.
The main reply's producer also drains the stream ahead of synthesis; it has no explicit queue
budget (`voice-agent.js:1780–1824`). Default maxTokens limits normal replies, not arbitrary custom
streams. History is also host-managed without a built-in context cap.

Smallest fix candidate: invalidate not-yet-started speculative jobs by generation/signal. Keep any
already-running non-abortable ONNX inference serialized until it finishes; never release the synth
queue early. Do not add a full queue manager or pause LLM tool/result draining as the first fix.
General reply backpressure/history policy is a separate product contract, not a quick speculative fix.

### 4. Voice changes do not invalidate speculative audio — confirmed correctness bug

`src/voice-agent.js:1652–1659`: cache reuse is keyed only by text; `setVoice()` only updates voiceId.
Local fake-synth probe:

1. Pre-synthesize “Hello” with voice `old`, await synthesis.
2. Set voice to `new` and request “Hello” again.
3. Only one synthesis has run; `_preClip` still contains voice `old` while voiceId is `new`.

The next matching first clip can use the old voice. Fix by invalidating speculative cache/work on
voice changes and testing both completed-cache and queued-work cases. Other mutable render settings
need the same contract if they are intended to affect cached audio; do not speculate a universal
cache-key abstraction before identifying supported settings.

### 5. Public contracts lag implementation — concrete API/documentation mismatches

`src/index.d.ts`:
- `VoiceAgentEvent` omits emitted `prefetch-hit` / `prefetch-miss` diagnostics.
- `STTSession` omits the runtime-consumed `prefetchMs` and `reset` capabilities.
- `VoiceTTS` omits optional `presynth`, used by custom TTS integration.
- `turnDetector` docs (150–156) do not state that nativeEOT bypasses it and maxPauseMs.

`src/index.test.js` checks exported *names*, not member signatures or event variants, so it cannot
catch these mismatches. Align types/docs and add a small TypeScript usage fixture rather than more
capability flags or a new validation framework. These are different from an algorithm defect.

### 6. Ownership is harder to follow than necessary — maintainability issue

`voice-agent.js:377–407` puts capture lifecycle, bootstrap VAD, turn state, speculative state,
hold barriers and echo state on one object. `_speakTurn():922–1091` also owns text filtering, tool
reporting/dedup, history and cursor events. Multiple counters are not inherently wrong: pipeline
lifetime, response identity and VAD utterance generation really are different lifetimes.

First mechanical extraction worth considering: move StreamingTTS + its audio/text helpers and
Piper implementation out of voice-agent.js, preserving existing exports. ElevenLabs currently
imports StreamingTTS from the orchestration module. This would clarify dependency direction
without changing behavior. Do not split every helper or collapse distinct generations into one
flag just to reduce lines. An extraction is not an endpoint fix and should not share its experiment.

## What should remain

- One serialized turn executor preserving heard-history order.
- One serialized synthesis queue for non-concurrent ONNX sessions.
- Abort stops waiting/playback without pretending that in-flight computation has been cancelled.
- Speculation never directly authorizes tools; toolGate rejection on drop is intentional.
- Provider adapters normalize wire formats; they should not implement unrelated product policy.
- TTS handles synthesis/playback, not dialogue completion.
- Host retains product permissions and irreversible-action confirmation responsibilities.
- Benchmark scorer judges recorded output independently of UI success claims.

## Target conceptual structure (not six mandatory classes)

    Capture → STT adapter → turn acceptance → serialized reply executor
                  │                │                    │
                  └─ partials → speculative prep        ├─ structured tool calls → host execution
                                                       └─ text → TTS queue → playback

Turn acceptance owns “we are answering this user turn.” Speculative prep owns discardable work.
The tool execution boundary owns side-effect permission; playback owns interruption and heard text.
These responsibilities can remain a few functions/modules. Defaults should stay simple; metadata
and explicit ownership do not require a generic state-machine framework.

## Recommended work order

1. Small tested fixes: stale voice cache, stale speculative jobs, public contract alignment.
2. Decide whether to retire default text-to-tool mimicry; keep migration separate from latency work.
3. Continue the promised STT-only 512/4096 real-time replay with packet phase and provider metadata.
4. Change endpoint policy only after that evidence; compare legitimate-answer delay and fidelity.
5. Evaluate fragmented presynthesis with fragmented first-word fixtures, not the existing easy mock.
6. Mechanical TTS extraction when touching that area, in a behavior-neutral separate change.

No need for a rewrite. No claim that these newly found issues caused the ablation failure. The
confirmed defects and architectural limitations should not be averaged into a blanket “all safe”
or “bad architecture” verdict. This review itself does not modify active source or run paid tests.
