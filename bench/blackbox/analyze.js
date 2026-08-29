#!/usr/bin/env node
// bench/blackbox/analyze.js — turn a black-box recording (driver.js output) into the bench report.
// The driver's live Gate already put clip_start/clip_end + person_start/person_end on the timeline;
// here we re-derive agent speech OFFLINE from the recorded audio (ground truth, immune to any live
// hiccup), fold the two, and run the SAME computeMetrics as the instrumented harness — so black-box
// and instrumented reports are directly comparable rows of one table.
//
// Optionally transcribes the agent audio (per reply) to estimate delivery: if $OPENAI_API_KEY is
// set, each reply segment goes through whisper-1 and spokenRatio is computed against the scripted
// response text. Without it those columns stay '—' (latency numbers need no transcription).
//
// Usage: node bench/blackbox/analyze.js bench/results/bb-<...>.json

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { segments, RATE } from './energy.js';
import { computeMetrics, formatReport, wer } from '../metrics.js';

const ROOT = normalize(join(fileURLToPath(import.meta.url), '..', '..', '..'));
const runFile = process.argv[2];
if (!runFile) { console.error('usage: analyze.js <bb-run.json>'); process.exit(1); }
const run = JSON.parse(readFileSync(runFile, 'utf8'));
const scenario = JSON.parse(readFileSync(join(ROOT, 'bench', 'scenarios', `${run.scenario}.json`), 'utf8'));
const pcm = readFileSync(runFile.replace(/\.json$/, '.agent.raw'));

// ── offline agent-speech segments (recAnchor: first person_start aligns driver time ↔ audio time) ──
// The recording starts when the speaker stream opens; the driver's events are on its own clock with
// the same origin (t0 at conversation start, recording begins earlier/at 0). clip_* events from the
// live gate carry driver-clock times; recompute them from audio so glitches in live gating never
// skew the report. Audio t=0 == driver t≈0 (both anchored at stream open — see driver.js recAnchor).
const segs = segments(pcm);
const offsetMs = -(run.audioStartMs ?? 0);   // recording starts BEFORE driver t0 → shift audio times back into driver time
const clipEvents = segs.flatMap((s) => [
  { t: Math.round(s.startMs + offsetMs), type: 'clip_start' },
  { t: Math.round(s.endMs + offsetMs), type: 'clip_end' },
]);

// Person + barge events from the driver; drop its live clip_* in favor of the offline ones.
const personEvents = run.events.filter((e) => e.type.startsWith('person_'));

// INSTRUMENTED merge: if the SUT page recorded internal milestones (window.__bench, epoch-clocked),
// re-base them onto driver time via the shared epoch (same machine, same clock) and fold them in.
// stt/turn/llm/reply events come from inside; audio truth (clips, barge) still comes from the recording.
let insideEvents = [];
if (run.browserEvents?.length) {
  const anchor = run.events.find((e) => e.epoch != null);
  const epochT0 = anchor.epoch - anchor.t;   // epoch value at driver t=0
  insideEvents = run.browserEvents.map(({ epoch, type, ...extra }) => ({ t: Math.round(epoch - epochT0), type, ...extra }));
}
// barge_stop: for each scripted interrupt, the end of the clip ACTIVE while the person speaks.
// A clip must overlap the interrupting utterance — otherwise the interrupt landed in a gap between
// the agent's sentences (nothing to cut) and attributing the NEXT reply's clip_end would be bogus.
const bargeEvents = scenario.turns.flatMap((turn, k) => {
  if (!turn.interrupt) return [];
  const ps = personEvents.find((e) => e.type === 'person_start' && e.turn === k);
  const pe = personEvents.find((e) => e.type === 'person_end' && e.turn === k);
  if (!ps) return [];
  const active = segs.find((s) => s.startMs + offsetMs < (pe?.t ?? ps.t + 3000) && s.endMs + offsetMs > ps.t);
  return active ? [{ t: Math.round(active.endMs + offsetMs), type: 'barge_stop' }] : [];
});

// ── optional: transcribe each reply segment → spokenRatio + response fidelity ───────────────────
// Skipped when instrumented events exist (they carry exact reply_done/heardNw already).
const key = insideEvents.length ? null : process.env.OPENAI_API_KEY;
const replyEvents = [];
if (key) {
  const nw = (s) => { let n = 0; for (const c of s) if (!/\s/.test(c)) n++; return n; };
  // A "reply" = consecutive segments between two person turns (join segments < 1.2s apart).
  for (let k = 0; k < scenario.turns.length; k++) {
    const end = personEvents.find((e) => e.type === 'person_end' && e.turn === k)?.t;
    const next = personEvents.find((e) => e.type === 'person_start' && e.turn === k + 1)?.t ?? Infinity;
    if (end == null) continue;
    const replySegs = segs.filter((s) => s.startMs >= end && s.startMs < next);
    if (!replySegs.length) continue;
    const from = replySegs[0].startMs, to = replySegs[replySegs.length - 1].endMs;
    const slice = pcm.subarray(Math.floor((from / 1000) * RATE) * 2, Math.ceil((to / 1000) * RATE) * 2);
    const wav = `/tmp/bb-reply-${k}.wav`;
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 's16le', '-ar', String(RATE), '-ac', '1', '-i', 'pipe:0', wav], { input: slice });
    const form = new FormData();
    form.append('file', new Blob([readFileSync(wav)], { type: 'audio/wav' }), 'r.wav');
    form.append('model', 'whisper-1');
    const r = await fetch('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form });
    const heardText = r.ok ? (await r.json()).text ?? '' : '';
    const scripted = scenario.turns[k].response;
    replyEvents.push({ t: to, type: 'reply_done', heardNw: Math.round(nw(scripted) * Math.max(0, 1 - wer(scripted, heardText))), totalNw: nw(scripted), transcript: heardText });
  }
}

const events = [...personEvents, ...clipEvents, ...bargeEvents, ...replyEvents, ...insideEvents].sort((a, b) => a.t - b.t);
const metrics = computeMetrics(events, scenario);
const report = formatReport(metrics, `${run.label} / ${run.scenario} (${insideEvents.length ? 'black-box + instrumented' : 'black-box'})`);
const out = runFile.replace(/\.json$/, '.report.json');
writeFileSync(out, JSON.stringify({ ...run, offlineEvents: events, metrics }, null, 2));
console.log(report + `\n\nsaved → ${out}` + (key ? '' : '\n(no OPENAI_API_KEY — spokenRatio/WER columns skipped)'));
