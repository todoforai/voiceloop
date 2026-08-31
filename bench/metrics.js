// bench/metrics.js — pure timeline → metrics computation. No browser, fully unit-testable.
//
// Input: a flat event timeline recorded by the harness (all `t` in ms, one monotonic clock):
//   { t, type: 'person_start' | 'person_end', turn }          — scripted person audio in/out of the fake mic
//   { t, type: 'stt_partial', text }                          — any interim transcript callback
//   { t, type: 'stt_final', text }                            — a committed user turn transcript
//   { t, type: 'turn_committed' }                             — agent closed the turn (state → thinking)
//   { t, type: 'llm_first_token' }                            — first char of the scripted response arrived
//   { t, type: 'clip_start' } / { t, type: 'clip_end' }       — one TTS clip physically playing / done
//   { t, type: 'reply_done', heardNw, totalNw }               — reply over: chars voiced vs generated
//   { t, type: 'barge_stop' }                                 — agent playback cut by barge-in
//   { t, type: 'noise_burst', turn, kind, durMs }             — driver mixed a non-speech burst into the mic (ground truth)
//   { t, type: 'noise_stop', resumedMs? }                     — agent audio halted right after a burst (analyze.js);
//                                                               resumedMs set = it came back (stall, not a lost reply)
//   { t, type: 'echo_drop', text }                            — a final swallowed as self-echo
//
// Scenario: { turns: [{ person, response, interrupt? }] } — `person` is the ground-truth text of what
// the fake person says; `interrupt: { afterMs }` means this turn's person audio starts afterMs into
// the agent's PREVIOUS reply (a barge-in), so its metrics include the interruption reactivity.

// ── text normalization + word error rate ────────────────────────────────────────────────────────
export const norm = (s) => (s.toLowerCase().normalize('NFKD').match(/[\p{L}\p{N}']+/gu) ?? []);

// Word-level Levenshtein distance (substitution/insert/delete all cost 1).
export function wer(refText, hypText) {
  const ref = norm(refText), hyp = norm(hypText);
  if (!ref.length) return hyp.length ? 1 : 0;
  let prev = Array.from({ length: hyp.length + 1 }, (_, j) => j);
  for (let i = 1; i <= ref.length; i++) {
    const cur = [i];
    for (let j = 1; j <= hyp.length; j++)
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[hyp.length] / ref.length;
}

// ── noise_stop derivation (used by analyze.js on offline segments; pure → unit-testable) ────────
// For each driver noise_burst (ground truth: first burst sample on the mic), did the agent's
// audio halt in REACTION? Heuristic, stated as such: the segment active at burst time must end
// inside the reaction window (burst end + 1s). A halt that resumes ≥600ms later is a noise stall
// (resumedMs set); one that never resumes before the next person line is a killed reply. Gaps
// <600ms are normal TTS sentence pauses (clean smalltalk runs show inter-clip gaps up to ~500ms).
// Guards: a stop already attributable to scripted person speech (person line open at the stop, or
// a derived barge_stop within 250ms) is NOT double-counted as a noise stop.
export function deriveNoiseStops({ segs, bursts, personEvents, bargeStops = [] }) {
  const personOpen = (t) => personEvents.some((ps) => ps.type === 'person_start' &&
    t >= ps.t && t < (personEvents.find((pe) => pe.type === 'person_end' && pe.turn === ps.turn)?.t ?? ps.t + 10000));
  return bursts.flatMap((nb) => {
    const active = segs.find((s) => s.startMs <= nb.t && s.endMs > nb.t);
    if (!active) return [];                                     // burst hit agent silence — nothing to cut
    const stopT = active.endMs;
    if (stopT > nb.t + (nb.durMs ?? 2000) + 1000) return [];    // reply outlived the burst — no reaction
    if (personOpen(stopT) || bargeStops.some((b) => Math.abs(b.t - stopT) < 250)) return [];   // scripted speech owns this stop
    const nextPerson = personEvents.find((e) => e.type === 'person_start' && e.t > nb.t)?.t ?? Infinity;
    const next = segs.find((s) => s.startMs > stopT && s.startMs < nextPerson);
    const gapMs = next ? Math.round(next.startMs - stopT) : null;
    if (gapMs != null && gapMs < 600) return [];                // natural sentence gap, not a flinch
    return [{ t: Math.round(stopT), type: 'noise_stop', turn: nb.turn, kind: nb.kind, stopMs: Math.round(stopT - nb.t), ...(gapMs != null ? { resumedMs: gapMs } : {}) }];
  });
}

// ── per-turn + aggregate metrics ────────────────────────────────────────────────────────────────
const STALL_MS = 250;   // a silent gap inside a reply longer than this counts as a stall
const YIELD_WINDOW_MS = 2500;   // how long we wait for the agent to back off after the user resumes
const YIELD_GRACE_MS = 500;     // backing off just past the person's last word still counts as yielding

const between = (events, type, from, to = Infinity) =>
  events.filter((e) => e.type === type && e.t >= from && e.t < to);
const firstAfter = (events, type, from, to = Infinity) => between(events, type, from, to)[0] ?? null;

export function computeMetrics(events, scenario) {
  events = [...events].sort((a, b) => a.t - b.t);
  const turns = [];

  // ECHO WORDS (echo scenarios): response-script words surfacing in the USER-side transcript —
  // the SUT transcribing its own speakers→mic echo as user speech. Counted over ALL stt_final
  // text: words that occur in some scripted RESPONSE but in NO person line (so a correctly-heard
  // person contributes zero). Exact normalized matching keeps it deterministic; misheard echo
  // undercounts slightly — the conservative direction. SUTs that FILTER their echo emit no such
  // finals (voiceloop surfaces them as echo_drop instead), so this measures pollution that the
  // SUT would actually have acted on.
  const respWords = new Set(scenario.turns.flatMap((s) => norm(s.response ?? '')));
  const personWords = new Set(scenario.turns.flatMap((s) => norm(s.person ?? '')));
  const echoWords = events.filter((e) => e.type === 'stt_final' && e.text)
    .reduce((n, e) => n + norm(e.text).filter((w) => respWords.has(w) && !personWords.has(w)).length, 0);

  // Person speech intervals — "was anyone talking around t?" for self-interruption attribution
  // (a real person-caused stop follows live person speech within STT latency; POST_MS bounds it).
  const PERSON_POST_MS = 800;
  const personIntervals = scenario.turns.map((_, i) => {
    const ps = events.find((e) => e.type === 'person_start' && e.turn === i);
    const pe = events.find((e) => e.type === 'person_end' && e.turn === i);
    return ps ? [ps.t, (pe?.t ?? ps.t + 10000) + PERSON_POST_MS] : null;
  }).filter(Boolean);
  const personNear = (t) => personIntervals.some(([a, b]) => t >= a && t <= b);

  for (let k = 0; k < scenario.turns.length; k++) {
    const script = scenario.turns[k];
    const start = events.find((e) => e.type === 'person_start' && e.turn === k);
    const end = events.find((e) => e.type === 'person_end' && e.turn === k);
    if (!start || !end) { turns.push({ turn: k, missing: true }); continue; }
    const nextStart = events.find((e) => e.type === 'person_start' && e.turn === k + 1);
    const windowEnd = nextStart?.t ?? Infinity;   // this turn's reply lives before the next person turn

    const t = { turn: k, person: script.person };

    // STT: first partial after speech starts; final text vs the ground-truth script.
    const p = firstAfter(events, 'stt_partial', start.t, windowEnd);
    t.firstPartialMs = p ? Math.round(p.t - start.t) : null;
    // Black-box runs see no STT internals: wer only when a final was actually observed, else null
    // (an INSTRUMENTED run that lost the final still counts it as a total miss via hasStt).
    // Matching is BEST-WER within a generous window, not first-in-window: some stacks (ElevenLabs)
    // only surface the user transcript alongside the agent's reply — after the next turn already
    // started — so a strict [start, nextStart) window would misattribute perfectly-heard turns.
    const hasStt = events.some((e) => e.type === 'stt_final' || e.type === 'stt_partial');
    const finals = between(events, 'stt_final', start.t - 500, windowEnd + 15000).filter((e) => e.text?.trim() && e.text !== '...');
    const fin = finals.reduce((best, e) => (!best || wer(script.person, e.text) < wer(script.person, best.text) ? e : best), null);
    t.sttFinal = fin?.text ?? '';
    t.wer = fin ? +wer(script.person, fin.text).toFixed(3) : (hasStt ? 1 : null);

    // End-of-turn: person stops speaking → agent commits the turn.
    const commit = firstAfter(events, 'turn_committed', end.t - 500, windowEnd);   // -500: a native-EOT provider can commit just before the tail silence fully elapses
    t.eotMs = commit ? Math.round(commit.t - end.t) : null;

    // LLM + TTS: first token → first audible clip. voiceToVoice is the headline: person stops → agent audible.
    // A turn can carry SEVERAL llm_first_token events (aborted speculative prefetches + the real
    // request) — attribute the LATEST one before the reply's first clip: that's the stream that
    // actually fed the TTS (an adopted prefetch is the only token and still wins, staying negative).
    const clip = firstAfter(events, 'clip_start', end.t, windowEnd);
    const toks = between(events, 'llm_first_token', end.t - 2000, clip?.t ?? windowEnd);   // -2000: prefetch fires DURING the person's speech
    const tok = toks[toks.length - 1] ?? null;
    t.llmFirstTokenMs = tok ? Math.round(tok.t - end.t) : null;                    // negative = prefetch beat the turn close
    t.ttsFirstAudioMs = tok && clip ? Math.round(clip.t - tok.t) : null;
    t.voiceToVoiceMs = clip ? Math.round(clip.t - end.t) : null;

    // Delivery: chars voiced vs the fixed response, and stalls (silent gaps mid-reply).
    const done = firstAfter(events, 'reply_done', end.t, windowEnd + 30000);       // reply may finish after the next turn's audio started (overlap)
    if (done) { t.spokenRatio = done.totalNw ? +(done.heardNw / done.totalNw).toFixed(3) : 1; }
    const clips = between(events, 'clip_start', end.t, windowEnd)
      .map((s) => ({ start: s.t, end: firstAfter(events, 'clip_end', s.t)?.t ?? s.t }));
    t.stalls = clips.slice(1).filter((c, i) => c.start - clips[i].end > STALL_MS).length;

    // Talking over the user is ALLOWED — people do it constantly. What matters is whether the
    // agent YIELDS once the user keeps going. On a turn with mid-utterance pauses we look at each
    // time the agent entered the pause and the person then resumed:
    //   overlapStartMs  — how many turns the agent entered early at all (informational)
    //   yieldMs         — person resumes → agent audio stops (null = never yielded: it talked through)
    //   talkedThrough   — the failure: the agent kept speaking over the resuming user
    // Scripted interrupt turns are excluded: there the agent is SUPPOSED to be audible.
    if (!script.interrupt) {
      const entries = between(events, 'clip_start', start.t, end.t);
      t.userInterruptions = entries.length ? 1 : 0;                                // turns, not events
      // For each overlap, find the moment the person is demonstrably still talking over it:
      // an entry made during a pause is judged from the resume that ends the pause; an entry
      // made while the person is already speaking is judged from the entry itself.
      const resumes = between(events, 'person_resume', start.t, end.t);
      const pauses = between(events, 'person_pause', start.t, end.t);
      const inPause = (t) => pauses.some((p) => p.t <= t && (resumes.find((r) => r.t > p.t)?.t ?? end.t) > t);
      const yields = [];
      for (const e of entries) {
        const from = inPause(e.t) ? resumes.find((r) => r.t > e.t)?.t : e.t;
        if (from == null) continue;                       // pause never ended — nothing to yield to
        // Yielding only counts while the person is still speaking (+grace); the reply that
        // follows a properly closed turn is not "talking over" anyone.
        const until = Math.min(from + YIELD_WINDOW_MS, end.t + YIELD_GRACE_MS);
        const stop = firstAfter(events, 'clip_end', from, until);
        const resumedAgain = stop && firstAfter(events, 'clip_start', stop.t, until);
        yields.push(stop && !resumedAgain ? Math.round(stop.t - from) : null);
      }
      t.yieldMs = yields.find((y) => y !== null) ?? null;
      t.talkedThrough = yields.length > 0 && yields.every((y) => y === null);
    }

    // First CONTENT word: analyze.js transcribes the reply with word timestamps and emits a
    // turn-tagged content_word at the first word matching the scripted response — a filler head
    // start ("Hmm,") moves clip_start but not this. Negative = content began mid-pause.
    const cw = events.find((e) => e.type === 'content_word' && e.turn === k);
    t.contentWordMs = cw ? Math.round(cw.t - end.t) : null;

    // Interruption (this turn's person speech starts over the previous reply): overlap between the
    // person starting and the agent's audio actually stopping. Some overlap is natural; report it.
    if (script.interrupt) {
      const stop = firstAfter(events, 'barge_stop', start.t - 500, windowEnd);
      t.interruptStopMs = stop ? Math.round(stop.t - start.t) : null;              // null = never stopped (failed barge-in)
    }

    // SELF-INTERRUPTION: the agent cut its own reply with nobody talking — the signature failure
    // of broken echo handling (it hears its own voice, "barges in" on itself). Audio truth: on a
    // turn whose reply no scripted interrupt touches, the reply was delivered visibly short
    // (spokenRatio, from reply_done or the offline transcript), OR an explicit barge_stop landed
    // outside every person-speech window. 0.8: whisper-derived ratios on fully-voiced replies sit
    // well above it, a self-cut loses at least a sentence.
    const scriptedNext = !!scenario.turns[k + 1]?.interrupt;
    const selfStop = between(events, 'barge_stop', end.t, windowEnd).some((e) => !personNear(e.t));
    t.selfInterrupted = !scriptedNext &&
      (selfStop || (typeof t.spokenRatio === 'number' && t.spokenRatio < 0.8));
    turns.push(t);
  }

  // False barge-ins: barge_stop events not attributable to any scripted interruption, PLUS
  // noise_stop events without a resume (analyze.js: agent audio halted right after a driver
  // noise_burst — the burst event is ground truth, so attribution is exact, no window guessing).
  // A noise stop the agent RECOVERS from (resumedMs set) is reported separately as
  // agent-stalled-by-noise: the reply survives, but the listener hears the agent flinch.
  const interruptStarts = scenario.turns
    .map((s, k) => (s.interrupt ? events.find((e) => e.type === 'person_start' && e.turn === k)?.t : null))
    .filter((x) => x != null);
  const noiseStops = events.filter((e) => e.type === 'noise_stop');
  const falseBargeIns = events.filter((e) =>
    e.type === 'barge_stop' && !interruptStarts.some((ts) => e.t >= ts - 500 && e.t < ts + 10000)).length
    + noiseStops.filter((e) => e.resumedMs == null).length;

  const nums = (key) => turns.map((t) => t[key]).filter((v) => typeof v === 'number');
  const stats = (key) => {
    const v = nums(key).sort((a, b) => a - b);
    if (!v.length) return null;
    return { median: v[v.length >> 1], p95: v[Math.min(v.length - 1, Math.ceil(v.length * 0.95) - 1)], mean: Math.round(v.reduce((a, b) => a + b, 0) / v.length) };
  };

  return {
    turns,
    aggregate: {
      voiceToVoiceMs: stats('voiceToVoiceMs'),
      contentWordMs: stats('contentWordMs'),
      eotMs: stats('eotMs'),
      ttsFirstAudioMs: stats('ttsFirstAudioMs'),
      firstPartialMs: stats('firstPartialMs'),
      interruptStopMs: stats('interruptStopMs'),
      wer: nums('wer').length ? +(nums('wer').reduce((a, b) => a + b, 0) / nums('wer').length).toFixed(3) : null,
      spokenRatioUninterrupted: (() => {
        const v = turns.filter((t, k) => !scenario.turns[k + 1]?.interrupt && typeof t.spokenRatio === 'number').map((t) => t.spokenRatio);
        return v.length ? +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(3) : null;
      })(),
      stalls: nums('stalls').reduce((a, b) => a + b, 0),
      userInterrupted: nums('userInterruptions').reduce((a, b) => a + b, 0),
      talkedThrough: turns.filter((t) => t.talkedThrough).length,
      yieldMs: stats('yieldMs'),
      falseBargeIns,
      agentStalledByNoise: noiseStops.filter((e) => e.resumedMs != null).length,   // subset of `stalls` (a ≥600ms resume gap is also a >250ms stall)
      echoDrops: events.filter((e) => e.type === 'echo_drop').length,
      echoWords,
      selfInterruptions: turns.filter((t) => t.selfInterrupted).length,
    },
  };
}

// Render the report as a terminal/markdown table string.
export function formatReport(m, label = '') {
  const a = m.aggregate;
  const f = (s, unit = 'ms') => (s ? `${s.median}${unit} (p95 ${s.p95}${unit})` : '—');
  const lines = [
    `# voiceloop bench${label ? ` — ${label}` : ''}`,
    '',
    '| metric | value |',
    '|---|---|',
    `| voice→voice latency | ${f(a.voiceToVoiceMs)} |`,
    `| first content word (vs person end) | ${f(a.contentWordMs)} |`,
    `| end-of-turn delay | ${f(a.eotMs)} |`,
    `| TTS first audio (after 1st token) | ${f(a.ttsFirstAudioMs)} |`,
    `| STT first partial | ${f(a.firstPartialMs)} |`,
    `| barge-in stop overlap | ${f(a.interruptStopMs)} |`,
    `| STT word error rate | ${a.wer == null ? '—' : (a.wer * 100).toFixed(1) + '%'} |`,
    `| spoken ratio (uninterrupted) | ${a.spokenRatioUninterrupted ?? '—'} |`,
    `| overlap starts / talked through (never yielded) | ${a.userInterrupted} / ${a.talkedThrough} |`,
    `| yield time (user resumes → agent stops) | ${f(a.yieldMs)} |`,
    `| stalls / false barge-ins / echo drops | ${a.stalls} / ${a.falseBargeIns} / ${a.echoDrops} |`,
    `| agent-stalled-by-noise (halt + resume, subset of stalls) | ${a.agentStalledByNoise} |`,
    `| echo words / self-interruptions | ${a.echoWords} / ${a.selfInterruptions} |`,
    '',
    '| turn | v→v | EOT | 1st tok | TTS 1st | WER | spoken | stop | cw | uint |',
    '|---|---|---|---|---|---|---|---|---|---|',
    ...m.turns.map((t) => t.missing
      ? `| ${t.turn} | (missing) |||||||||`
      : `| ${t.turn} | ${t.voiceToVoiceMs ?? '—'} | ${t.eotMs ?? '—'} | ${t.llmFirstTokenMs ?? '—'} | ${t.ttsFirstAudioMs ?? '—'} | ${t.wer == null ? '—' : (t.wer * 100).toFixed(0) + '%'} | ${t.spokenRatio ?? '—'} | ${t.interruptStopMs ?? (t.interruptStopMs === null ? 'FAIL' : '—')} | ${t.contentWordMs ?? '—'} | ${t.userInterruptions ?? '—'} |`),
  ];
  return lines.join('\n');
}
