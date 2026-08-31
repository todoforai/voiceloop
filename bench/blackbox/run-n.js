#!/usr/bin/env node
// bench/blackbox/run-n.js — N-repetition runner. Single runs lie (±300ms network/WASM jitter —
// observed flipping conclusions), so every config gets N conversations and POOLED turn stats.
// Drives the SUT Chrome over raw CDP (no deps): reload page → wait ready → run driver →
// pull window.__bench → merge → analyze. Pools all runs' turns for the final table.
//
// Usage: node bench/blackbox/run-n.js <scenario> <label> [N=5] [cdpPort=9223]

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const BENCH = normalize(join(fileURLToPath(import.meta.url), '..', '..'));   // works nested (voiceloop/bench) or standalone
const [scenario = 'smalltalk', label = 'sut', N = '5', port = '9223'] = process.argv.slice(2);

// ── minimal CDP client ─────────────────────────────────────────────────────────────────────────
let msgId = 0, ws;
const pending = new Map();
async function cdpConnect() {
  const pages = await (await fetch(`http://localhost:${port}/json`)).json();
  const page = pages.find((p) => p.type === 'page' && p.url.includes('/bench/blackbox/'));
  if (!page) throw new Error(`no /bench/blackbox/ page on CDP :${port}`);
  ws = new WebSocket(page.webSocketDebuggerUrl);
  ws.onmessage = (m) => { const d = JSON.parse(m.data); const r = pending.get(d.id); if (r) { pending.delete(d.id); r(d); } };
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
}
const cdp = (method, params = {}) => new Promise((res) => { const id = ++msgId; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const evalJs = async (expr) => (await cdp('Runtime.evaluate', { expression: expr, returnByValue: true })).result?.result?.value;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitReady(timeoutMs = 30000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const s = await evalJs(`document.getElementById('state')?.textContent`);
    if (s === 'listening') return true;
    if (s === 'speaking') return true;   // EL page reports mode, not agent state
    await sleep(300);
  }
  return false;
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

// ── pooled stats across all runs' turns ────────────────────────────────────────────────────────
const stats = (v) => {
  v = v.filter((x) => typeof x === 'number').sort((a, b) => a - b);
  if (!v.length) return null;
  return { n: v.length, median: v[v.length >> 1], p95: v[Math.min(v.length - 1, Math.ceil(v.length * 0.95) - 1)],
           min: v[0], max: v[v.length - 1] };
};
const fmt = (s) => (s ? `${s.median} (p95 ${s.p95}, ${s.min}–${s.max}, n=${s.n})` : '—');

// The rig is a SINGLETON: one virtual mic/speaker pair, one SUT Chrome. Two concurrent runs
// hear each other's "person" audio — the transcripts interleave, turns stop matching their
// milestones and BOTH result tables are silently corrupted (observed: EOT n=7/30, phantom
// self-interruptions, 16s p95). Nothing about the output says it happened, so refuse to start.
function lockRig() {
  const lock = join(BENCH, 'results', '.rig.lock');
  try {
    const held = +readFileSync(lock, 'utf8');
    process.kill(held, 0);                       // throws unless that pid is alive
    console.error(`another bench run (pid ${held}) is using the audio rig — refusing to start.\n` +
                  `wait for it, or remove ${lock} if it is stale.`);
    process.exit(1);
  } catch (e) {
    if (e?.code === 'EPERM') { console.error(`rig locked by pid from another user — refusing.`); process.exit(1); }
    // ENOENT (no lock) or ESRCH (dead pid) → stale or free, take it.
  }
  writeFileSync(lock, String(process.pid));
  const release = () => { try { unlinkSync(lock); } catch {} };
  process.on('exit', release);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { release(); process.exit(130); });
}

(async () => {
  lockRig();
  await cdpConnect();
  const reports = [];
  for (let i = 1; i <= +N; i++) {
    console.log(`\n═══ run ${i}/${N} ═══`);
    await cdp('Page.reload', { ignoreCache: true });
    await sleep(2000);
    if (!(await waitReady())) { console.error('SUT never became ready — skipping run'); continue; }
    await sleep(1000);
    const runFile = await runDriver(`${label}-r${i}`);
    const inside = await evalJs('JSON.stringify(window.__bench ?? [])');
    const abs = runFile;   // driver prints absolute paths
    const run = JSON.parse(readFileSync(abs, 'utf8'));
    run.browserEvents = JSON.parse(inside || '[]');
    writeFileSync(abs, JSON.stringify(run, null, 2));
    await analyze(abs);
    reports.push(JSON.parse(readFileSync(abs.replace(/\.json$/, '.report.json'), 'utf8')));
  }
  ws.close();

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
    `| echo words / self-interruptions / echo drops (total) | ${agg.reduce((s, a) => s + (a.echoWords ?? 0), 0)} / ${agg.reduce((s, a) => s + (a.selfInterruptions ?? 0), 0)} / ${agg.reduce((s, a) => s + (a.echoDrops ?? 0), 0)} |`,
    `| user-interrupted (total) | ${agg.reduce((s, a) => s + (a.userInterrupted ?? 0), 0)} |`,
  ].join('\n');
  const out = join(BENCH, 'results', `pooled-${scenario}-${label}-${new Date().toISOString().replace(/[:.]/g, '-')}.md`);
  writeFileSync(out, md);
  console.log('\n' + md + `\n\nsaved → ${out}`);
})();
