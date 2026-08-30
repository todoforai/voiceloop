#!/usr/bin/env node
// bench/blackbox/run-proc.js — run-n for PROCESS SUTs (python agents etc.). run-n.js reloads a
// browser page between runs; here each run gets a FRESH process: spawn → wait for SUT_READY on
// stdout → drive → SIGTERM. Pooling/stats identical to run-n.js so rows are comparable.
//
// Usage: node bench/blackbox/run-proc.js <scenario> <label> <N> -- <sut cmd...>
//   e.g. node bench/blackbox/run-proc.js smalltalk pipecat 5 -- /tmp/pipecat-venv/bin/python bench/blackbox/sut-pipecat.py

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const BENCH = normalize(join(fileURLToPath(import.meta.url), '..', '..'));
const sep = process.argv.indexOf('--');
if (sep < 0) { console.error('usage: run-proc.js <scenario> <label> <N> -- <sut cmd...>'); process.exit(1); }
const [scenario = 'smalltalk', label = 'sut', N = '5'] = process.argv.slice(2, sep);
const sutCmd = process.argv.slice(sep + 1);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startSut() {
  const p = spawn(sutCmd[0], sutCmd.slice(1), { env: process.env });
  p.stderr.on('data', (c) => process.stderr.write(c));
  const ready = new Promise((res, rej) => {
    let out = '';
    p.stdout.on('data', (c) => { out += c; process.stdout.write(c); if (out.includes('SUT_READY')) res(); });
    p.on('exit', (code) => rej(new Error(`SUT exited early (${code})`)));
    setTimeout(() => rej(new Error('SUT never became ready (60s)')), 60000);
  });
  return { p, ready };
}

function runDriver(runLabel) {
  return new Promise((res, rej) => {
    const p = spawn('node', [join(BENCH, 'blackbox', 'driver.js'), scenario, runLabel]);
    let out = '';
    p.stdout.on('data', (c) => { out += c; process.stdout.write(c); });
    p.stderr.on('data', (c) => process.stderr.write(c));
    p.on('exit', (code) => {
      const m = out.match(/events → (\S+\.json)/);
      code === 0 && m ? res(m[1]) : rej(new Error(`driver failed (${code})`));
    });
  });
}

function analyze(runFile) {
  return new Promise((res, rej) => {
    const p = spawn('node', [join(BENCH, 'blackbox', 'analyze.js'), runFile], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = ''; p.stdout.on('data', (c) => { out += c; });
    p.on('exit', (code) => (code === 0 ? res(out) : rej(new Error('analyze failed'))));
  });
}

// ── pooled stats (same as run-n.js) ────────────────────────────────────────────────────────────
const stats = (v) => {
  v = v.filter((x) => typeof x === 'number').sort((a, b) => a - b);
  if (!v.length) return null;
  return { n: v.length, median: v[v.length >> 1], p95: v[Math.min(v.length - 1, Math.ceil(v.length * 0.95) - 1)],
           min: v[0], max: v[v.length - 1] };
};
const fmt = (s) => (s ? `${s.median} (p95 ${s.p95}, ${s.min}–${s.max}, n=${s.n})` : '—');

(async () => {
  const reports = [];
  for (let i = 1; i <= +N; i++) {
    console.log(`\n═══ run ${i}/${N} ═══`);
    const { p: sut, ready } = startSut();
    try {
      await ready;
      await sleep(1500);   // pipeline live; give streams a beat, like run-n's post-ready sleep
      const runFile = await runDriver(`${label}-r${i}`);
      await analyze(runFile);
      reports.push(JSON.parse(readFileSync(runFile.replace(/\.json$/, '.report.json'), 'utf8')));
    } catch (e) {
      console.error(`run ${i} failed: ${e.message} — skipping`);
    } finally {
      await new Promise((r) => {
        if (sut.exitCode !== null) return r();
        const t = setTimeout(() => { sut.kill('SIGKILL'); r(); }, 8000);
        sut.on('exit', () => { clearTimeout(t); r(); });
        sut.kill('SIGTERM');
      });
      await sleep(1000);
    }
  }

  const turns = reports.flatMap((r) => r.metrics.turns.filter((t) => !t.missing));
  const agg = reports.map((r) => r.metrics.aggregate);
  const pool = (k) => stats(turns.map((t) => t[k]));
  const md = [
    `# pooled: ${label} / ${scenario} — ${reports.length} runs, ${turns.length} turns`,
    '',
    '| metric | pooled median (p95, range, n) |',
    '|---|---|',
    `| voice→voice | ${fmt(pool('voiceToVoiceMs'))} |`,
    `| first content word | ${fmt(pool('contentWordMs'))} |`,
    `| EOT delay | ${fmt(pool('eotMs'))} |`,
    `| TTS first audio | ${fmt(pool('ttsFirstAudioMs'))} |`,
    `| STT first partial | ${fmt(pool('firstPartialMs'))} |`,
    `| barge-in stop | ${fmt(pool('interruptStopMs'))} |`,
    `| per-run v→v medians | ${agg.map((a) => a.voiceToVoiceMs?.median ?? '—').join(', ')} |`,
    `| stalls / false barge-ins (total) | ${agg.reduce((s, a) => s + a.stalls, 0)} / ${agg.reduce((s, a) => s + a.falseBargeIns, 0)} |`,
    `| agent-stalled-by-noise (total) | ${agg.reduce((s, a) => s + (a.agentStalledByNoise ?? 0), 0)} |`,
    `| user-interrupted (total) | ${agg.reduce((s, a) => s + (a.userInterrupted ?? 0), 0)} |`,
    `| echo words / self-interruptions / echo drops (total) | ${agg.reduce((s, a) => s + (a.echoWords ?? 0), 0)} / ${agg.reduce((s, a) => s + (a.selfInterruptions ?? 0), 0)} / ${agg.reduce((s, a) => s + (a.echoDrops ?? 0), 0)} |`,
  ].join('\n');
  const out = join(BENCH, 'results', `pooled-${scenario}-${label}-${new Date().toISOString().replace(/[:.]/g, '-')}.md`);
  writeFileSync(out, md);
  console.log('\n' + md + `\n\nsaved → ${out}`);
})();
