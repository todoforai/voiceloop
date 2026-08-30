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

// ── per-turn + aggregate metrics ────────────────────────────────────────────────────────────────
const STALL_MS = 250;   // a silent gap inside a reply longer than this counts as a stall

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

    // User-interrupted: agent audio STARTING inside the person's still-open turn (a mid-utterance
    // pause is an open turn — this is where aggressive endpointing pays its bill). Scripted
    // interrupt turns are excluded: there the agent is SUPPOSED to be audible while the person talks.
    if (!script.interrupt) t.userInterruptions = between(events, 'clip_start', start.t, end.t).length;

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

  // False barge-ins: barge_stop events not attributable to any scripted interruption.
  const interruptStarts = scenario.turns
    .map((s, k) => (s.interrupt ? events.find((e) => e.type === 'person_start' && e.turn === k)?.t : null))
    .filter((x) => x != null);
  const falseBargeIns = events.filter((e) =>
    e.type === 'barge_stop' && !interruptStarts.some((ts) => e.t >= ts - 500 && e.t < ts + 10000)).length;

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
      falseBargeIns,
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
    `| user-interrupted (agent spoke into open turn) | ${a.userInterrupted} |`,
    `| stalls / false barge-ins / echo drops | ${a.stalls} / ${a.falseBargeIns} / ${a.echoDrops} |`,
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
