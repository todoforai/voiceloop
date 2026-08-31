// tuning.js — ONE place to fine-tune the voice agent's speech behaviour. Edit the numbers here;
// they're the defaults the VoiceAgent reads at construction, so a change applies to the next
// session you start (press the mic again — no rebuild needed in dev, the module is re-imported).
//
// Anything here can still be overridden per-instance via the VoiceAgent constructor options of the
// same name (constructor wins). This file is just the single, documented source of the defaults so
// you don't have to hunt through voice-agent.js / stt.js to dial things in.
//
// Quick guide to the symptoms ↔ knobs:
//   • The agent interrupts itself / cuts off on noise → raise VAD.positiveSpeechThreshold,
//     VAD.minSpeechFrames, or BARGE_IN_MIN_CHARS.
//   • The agent transcribes ITS OWN voice (speakers, weak AEC) and self-interrupts → lower
//     ECHO_WORD_MATCH (stricter echo filter); headphones remove the problem entirely.
//   • "mhm"/"yeah" backchannels cut the agent off       → raise BARGE_IN_MIN_CHARS.
//   • Turn closes too eagerly mid-sentence            → raise VAD.redemptionFrames or MAX_PAUSE_MS.
//   • Turn feels sluggish to respond                  → lower VAD.redemptionFrames / STT max_delay.
//   • Word-starts clipped ("…ello" instead of "hello")→ raise PREROLL_CHUNKS.
//   • Replies too long/short                          → MAX_TOKENS.

export const TUNING = {
  // ── Barge-in (interrupting the agent while it speaks) ────────────────────────────────────────────
  // Barge-in now fires on TRANSCRIBED NOVEL WORDS, not raw VAD energy (so the AI's own echo/noise
  // can't cut a reply). This is the minimum number of transcribed characters — counting ONLY words
  // not (fuzzily) attributable to the reply being spoken, so even misheard echo contributes zero —
  // that must accumulate WHILE the agent is speaking before we treat it as a real interruption.
  // Higher = short backchannels ("mhm", "yeah", "ok") are ignored and the agent keeps talking; lower =
  // snappier interruption. 0 = any single transcribed character interrupts (most aggressive).
  BARGE_IN_MIN_CHARS: 6,

  // Self-echo filter: on speakers the browser's AEC often fails to cancel our own Web-Audio TTS
  // playout, so the STT transcribes the agent's own voice — real words that cross BARGE_IN_MIN_CHARS
  // and make it interrupt ITSELF. Since we know EXACTLY what he's voicing, interims heard while
  // speaking are word-matched against the current reply: if at least this fraction of the interim's
  // recent words occur in the reply, it's its own echo → ignored, it keeps talking. Real
  // interruptions ("no wait", "stop that") share few words with the reply, so they still cut in.
  // Lower = stricter filtering (more echo ignored, but a real interruption that REUSES the reply's
  // words might be missed); > 1 disables the filter.
  ECHO_WORD_MATCH: 0.7,

  // ── LLM ───────────────────────────────────────────────────────────────────────────────────────
  MAX_TOKENS: 1024,   // cap on the spoken reply length

  // ── Liveness backstop (host code that never returns) ──────────────────────────────────────────
  // The turn loop is strictly serialized, so anything it AWAITS can wedge it. Host hooks are kept
  // off that path structurally rather than by deadline: tools are dispatched and never joined, and
  // an aborted LLM stream is detached instead of drained. The one hook whose verdict is genuinely
  // REQUIRED to proceed is the turnDetector (it decides whether the turn closes) — bounded by
  // MAX_PAUSE_MS above, as ONE absolute deadline from end-of-speech.
  // Not covered, by design: a custom TTS _synth() that never settles (there is no reply without it),
  // and a muted-TTS turn draining a generator that ignores its abort signal.

  // ── Turn boundary (when is the user done talking?) ────────────────────────────────────────────
  // Hard cap (ms) a turnDetector may hold a turn open across a pause before it's force-committed —
  // so a user who trails off mid-sentence can't hang the turn forever. Only used when a turnDetector
  // is set; with the default silence-only endpointing the VAD redemptionFrames govern this instead.
  MAX_PAUSE_MS: 4000,

  // Browser Web Speech end-of-turn debounce (ms). The engine's own isFinal boundaries are per-pause
  // fragments; after a final we wait this long for a new one before closing the turn, so a mid-thought
  // pause keeps one turn together. Raise if turns split mid-sentence; lower to reply sooner.
  // 500 measured comfortable: Chrome's endpointer already waits out its own internal silence before
  // emitting isFinal, so this only needs to bridge restart seams and brief continuations.
  WEBSPEECH_EOT_MS: 500,

  // Chrome's endpointer can take longer than WEBSPEECH_EOT_MS to promote trailing words to isFinal.
  // Closing while it still holds that un-promoted tail emits a TRUNCATED turn and lets the late final
  // land as a bogus second one (disjoint text, so the seam-dedup can't catch it) — which barges in and
  // kills the reply. So a close waits for the engine to go quiescent; this caps how many extra EOT
  // windows it may wait before giving up on a tail that never resolves (liveness backstop only —
  // reaching it re-exposes the truncation). Worst-case added close latency = this × WEBSPEECH_EOT_MS.
  // Raise if slow engines still split turns; lower to bound the wait harder.
  WEBSPEECH_TAIL_MAX_DEFERS: 3,

  // Web Speech errors that aren't auth ('network', 'audio-capture', …) are retried by relaunching the
  // recognizer — but if the engine is genuinely broken (browser's speech service unreachable, a fake
  // audio device it can't read) EVERY relaunch fails instantly and the old code hot-looped forever,
  // silently, looking like "listening but deaf". So consecutive failures with no recognized text in
  // between are counted: each one waits longer (backoff below), and this many gives up with onFatal
  // instead of spinning. Reset by any result. 'no-speech'/'aborted' are normal and don't count.
  WEBSPEECH_MAX_ERROR_RESTARTS: 5,
  // First retry delay after a failing recognizer; doubles per consecutive failure (capped at 4s), so
  // a dead speech service costs a handful of tries over a few seconds instead of a spin loop.
  WEBSPEECH_ERROR_BACKOFF_MS: 300,

  // Delay before pre-warming the TTS engine after start() (download+compile the voice model, JIT the
  // WASM inference path). Deferred rather than immediate: Piper's ~60MB model download saturates
  // bandwidth and was measured stretching the Deepgram WS handshake from ~0.5s to ~3s when fired
  // concurrently. TTS isn't needed until the first REPLY (a user utterance + LLM roundtrip away), so
  // waiting costs nothing — while NOT warming at all costs the first reply Piper's full cold start
  // (measured 5.4–10.2s to first audio, vs 637ms warmed).
  TTS_WARM_DELAY_MS: 2500,

  // Speculative LLM prefetch: once the live interim has been STABLE this long (no new words), the
  // agent starts generating a reply for the probable final text — overlapping the LLM's first-token
  // latency with the rest of the end-of-turn debounce. Exact-match turns adopt the running stream
  // (instant first token); a changed text just aborts it (cost: a few prompt tokens). Must be
  // comfortably below WEBSPEECH_EOT_MS for the overlap to pay. 0 = prefetch on every interim tick
  // (most aggressive, most wasted calls).
  PREFETCH_MS: 200,

  // Audio chunks (~256ms each at 16kHz/4096-sample frames; ~1s total at 4) kept BEFORE VAD fires and
  // replayed into STT when speech starts, so the first word isn't clipped. Raise if word-starts are
  // getting cut; lower to shave a touch of latency/cost.
  PREROLL_CHUNKS: 4,

  // ── VAD (Silero v5) — speech detection sensitivity ────────────────────────────────────────────
  // These directly govern how readily the mic decides "the user is speaking". Tightening them is the
  // main lever against false speech-starts (self-echo, coughs, keyboard, room noise).
  VAD: {
    // Probability (0–1) above which a frame counts as speech. ↑ → needs clearer/louder speech to
    // trigger (fewer false starts, but may miss a soft start). Default 0.5.
    positiveSpeechThreshold: 0.5,
    // Probability below which we consider it NOT speech (hysteresis floor — keep < positive). Default 0.25.
    negativeSpeechThreshold: 0.25,
    // Minimum consecutive speech frames before a speech-START fires. ↑ → ignores very short blips
    // (coughs, clicks). Default 4 (~130ms).
    minSpeechFrames: 4,
    // Silence frames required to declare speech ENDED. ↑ → more patient across natural pauses (won't
    // cut you off mid-sentence) but slower to respond; ↓ → snappier endpointing. Default 24 (~770ms).
    redemptionFrames: 24,
    // Frames of audio padded before detected speech (smooths the onset). Default 10.
    preSpeechPadFrames: 10,
  },

  // ── Bootstrap VAD (instant, zero-load fallback until Silero is ready) ────────────────────────
  // Silero (MicVAD.new()) needs a CDN fetch + WASM compile + model load (~0.5-2s cold) before it can
  // detect speech at all — start() begins capturing mic audio well before that resolves. Until then,
  // a plain RMS-energy threshold (no model, no async load, gates from frame 1) stands in so the FIRST
  // words spoken right after clicking the mic are never silently dropped from the (size-capped)
  // preroll buffer while waiting for Silero. Swapped out for Silero the moment it's ready, always at
  // an utterance boundary (never mid-speech) — see _swapToSileroWhenReady().
  // NB: these frames are the raw ~256ms worklet capture chunks (4096 samples @16kHz) — much coarser
  // than Silero's own ~32ms internal frames above, so the counts are on a different scale.
  BOOTSTRAP_VAD: {
    // RMS above this (0-1 scale, ~loudness of normal speech close to the mic) counts as speech.
    // Deliberately looser/cruder than Silero — it only needs to survive the first second(s), not
    // replace real speech detection.
    energyThreshold: 0.02,
    // Consecutive ~256ms chunks above threshold before declaring speech-start. 1 = fires on the very
    // first loud chunk — snappiest possible protection for the opening word(s).
    minSpeechFrames: 1,
    // Consecutive ~256ms chunks below threshold before declaring speech-end (~1.5s). Deliberately
    // more patient than Silero's own redemptionFrames above: this stand-in only runs for the first
    // second or two of a session, and the goal here is "never chop a continuous sentence", not tight
    // endpointing — Silero takes over (with its tighter default) as soon as it's ready.
    redemptionFrames: 6,
  },

  // ── TTS (first-audio latency) ─────────────────────────────────────────────────────────────────
  // How soon the FIRST spoken chunk is cut from the streaming LLM text. Lower = the agent starts talking
  // sooner (less waiting on generation), at a small prosody cost (it may break on a comma/clause rather
  // than a full sentence). Only the FIRST chunk is aggressive; every later sentence still breaks on a
  // whole-sentence ender for natural delivery.
  //   • First chunk feels slow / waits for the whole answer → lower firstChunkMaxChars.
  //   • First chunk too choppy ("Sure," then a pause)        → raise firstChunkMinChars.
  TTS: {
    // Minimum non-space chars in the VERY first spoken chunk (the first-WORD opener). A tiny first
    // word ("I", "Hi", "A") makes a choppy micro-clip with a pause after it, so we keep gluing the
    // next word(s) until the opener reaches this many chars. Lower = even snappier first sound but
    // riskier choppiness; 3-4 keeps one/two-letter openers glued without delaying real words.
    firstWordMinChars: 4,
    // Don't cut the first chunk on a comma/clause break until at least this many chars exist, so a tiny
    // leading filler ("Sure,", "Okay,") doesn't become its own choppy clip with a pause after it. A full
    // sentence ender (. ! ?) ALWAYS breaks immediately regardless. Lower = faster first sound, at the risk
    // of a short choppy opener (cheap on local Piper). 8 keeps one-word fillers glued; ~6 starts sooner.
    firstChunkMinChars: 8,
    // Hard cap: if the opening clause has NO punctuation by this many chars, break it at the last word
    // boundary anyway so a long unpunctuated start still begins playing instead of awaiting the sentence.
    firstChunkMaxChars: 70,
    // Hard cap for every LATER sentence: a long run with no sentence ender (lists, dashed prose)
    // breaks at the last word boundary by this many chars, so audio keeps flowing instead of
    // waiting silently for one monster chunk. Generous — normal sentences end well before it.
    sentenceMaxChars: 200,
  },

  // ── STT (Speechmatics) — finalization timing ──────────────────────────────────────────────────
  STT: {
    // Seconds Speechmatics waits before LOCKING interim words into a final. ↓ → a shorter flickering
    // tail (words settle faster) at a small accuracy cost; ↑ → more context, steadier finals. The
    // agent picks per operating_point: 'enhanced' has the accuracy headroom for a tight 1s; 'standard'
    // uses 2s (Speechmatics' documented "optimal balance"). Range 0.7–4.
    maxDelayEnhanced: 1,
    maxDelayStandard: 2,
    // Seconds of silence after which Speechmatics closes a turn ITSELF (emits EndOfUtterance).
    // Required for the ForceEndOfUtterance/EndOfUtterance handshake (see stt.js StartRecognition);
    // must be < max_delay. Speechmatics recommends 0.5-0.8s for voice AI. In practice the agent's
    // VAD commit() is the boundary — audio is VAD-gated, so little post-speech silence reaches
    // Speechmatics for this trigger to fire on.
    eouSilenceTrigger: 0.6,
    // Fallback (ms) after a ForceEndOfUtterance: if Speechmatics never sends EndOfUtterance, close the
    // turn anyway after this long so the pipeline can't hang. Rarely needs changing.
    forceEndSafetyMs: 800,
    // Deepgram Flux end-of-turn confidence (0.5–0.9). Flux's model closes the turn itself when its
    // confidence the user is done exceeds this. ↓ → snappier turn ends but may cut mid-thought
    // pauses; ↑ → more patient. Deepgram default 0.7.
    fluxEotThreshold: 0.7,
    // Cap (ms) on the token fetch that gates open() — a hung/slow backend or provider must not stall
    // voice-mode startup indefinitely. onFatal fires past this so the host can surface it and retry.
    tokenFetchTimeoutMs: 8000,
  },
};
