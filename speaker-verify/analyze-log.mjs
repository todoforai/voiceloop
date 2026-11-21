#!/usr/bin/env node
// Summarize one (or the latest) recorded ~/voice-logs/<session> directory:
// per-speaker score distributions, RMS, decision reasons, and kept/[dropped] transcript.
// Usage: node speaker-verify/analyze-log.mjs [~/voice-logs/<id>]
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

let dir = process.argv[2];
if (!dir) {
  const root = join(homedir(), 'voice-logs');
  if (!existsSync(root)) { console.error(`No sessions directory yet: ${root}`); process.exit(1); }
  const dirs = readdirSync(root).filter((d) => statSync(join(root, d)).isDirectory()).sort();
  if (!dirs.length) { console.error(`No sessions in ${root}`); process.exit(1); }
  dir = join(root, dirs.at(-1));
}
const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
const tokens = JSON.parse(readFileSync(join(dir, 'tokens.json'), 'utf8'));
const finals = tokens.filter((t) => t.is_final);
const pct = (xs, p) => xs.length ? xs[Math.min(xs.length - 1, Math.floor(xs.length * p))] : null;
const stats = (xs) => {
  const s = xs.filter((v) => v != null).sort((a, b) => a - b);
  return s.length ? `n=${s.length} min=${s[0].toFixed(3)} med=${pct(s, 0.5).toFixed(3)} max=${s.at(-1).toFixed(3)}` : 'none';
};

console.log(`Session: ${dir}`);
console.log(`  dur=${meta.durationSec}s  end=${meta.endReason}  mic="${meta.micLabel || meta.micDeviceId}"  lang=${meta.sttLang || '?'}`);
console.log(`  modelReady=${meta.modelReady} (${meta.modelReadyMs ?? '?'} ms)  err=${meta.modelError || 'none'}  dropped=${meta.dropped}/${finals.length} finals`);

const reasons = {};
for (const t of finals) reasons[t.reason] = (reasons[t.reason] || 0) + 1;
console.log(`  reasons (finals): ${JSON.stringify(reasons)}`);

const bySpk = new Map();
for (const t of finals) {
  const k = t.speaker ?? '?';
  if (!bySpk.has(k)) bySpk.set(k, { kept: 0, drop: 0, w: [], lab: [] });
  const b = bySpk.get(k);
  if (t.keep) b.kept++; else b.drop++;
  if (t.w != null) b.w.push(t.w);
  if (t.lab != null) b.lab.push(t.lab);
}
for (const [k, b] of bySpk) {
  console.log(`  spk ${k}: kept=${b.kept} drop=${b.drop}  win(${stats(b.w)})  lab(${stats(b.lab)})`);
}

const wins = meta.windows || [];
console.log(`  windows (${wins.length}): scored=${wins.filter((w) => w.score != null).length}  rms(${stats(wins.map((w) => w.rms))})  score(${stats(wins.map((w) => w.score))})`);

console.log('\nTranscript (finals — [dropped:reason@w/lab]):');
let line = '', curSpk = null;
const flush = () => { if (line) { console.log(`  spk ${curSpk}: ${line.trim()}`); line = ''; } };
for (const t of finals) {
  if (t.speaker !== curSpk) { flush(); curSpk = t.speaker; }
  line += t.keep ? t.text : ` [${t.text.trim()}:${t.reason}@${t.w ?? '-'}/${t.lab ?? '-'}]`;
}
flush();

if (meta.turns?.length) {
  console.log('\nTurns emitted:');
  for (const u of meta.turns) console.log(`  @${(u.at_ms / 1000).toFixed(1)}s ${u.marker}${u.held ? ' (held)' : ''}: ${JSON.stringify(u.emittedText)}`);
}
