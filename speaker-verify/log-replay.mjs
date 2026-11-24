#!/usr/bin/env node
// Causal replay of the REAL SpeakerGate on "Save logs for DEBUG" sessions (session.wav + tokens.json
// + meta.json): audio pushed at the app's pace, each FINAL token admitted at its logged arrival_ms,
// with the session's own voiceprint. Compares the logged live verdicts with today's gate code.
// Benchmark: an optional <session>/truth.json — {"default":"owner"|"other", "other":[[startMs,endMs]…],
// "owner":[[…]]} (spans override the default; a session without one counts as owner-only, unverified)
// — scores owner words kept and other-voice words dropped, the two numbers to never trade blindly.
// Usage: NODE_PATH=/path/node_modules node log-replay.mjs [~/voice-logs] [key=value gate options…]
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { SpeakerGate, SPEAKER_MODEL } from '../src/speaker-gate.js';
import { computeFbank, l2Normalize } from '../src/fbank.js';
const ort = createRequire(process.env.NODE_PATH + '/')('onnxruntime-web');
const args = process.argv.slice(2), opts = {};
for (const a of args.filter((a) => a.includes('='))) { const [k, v] = a.split('='); opts[k] = +v; }
const root = args.find((a) => !a.includes('=')) ?? `${homedir()}/voice-logs`;
const dirs = existsSync(`${root}/tokens.json`) ? [root] : readdirSync(root).sort().map((d) => `${root}/${d}`);
const session = await ort.InferenceSession.create(readFileSync(new URL('.cache/models/campplus_200k.onnx', import.meta.url).pathname));
const model = { embed: async (pcm) => { const { data, numFrames, numBins } = computeFbank(pcm, SPEAKER_MODEL.fbank); return l2Normalize((await session.run({ feats: new ort.Tensor('float32', data, [1, numFrames, numBins]) })).embs.data); } };
const rd = (f) => { const b = readFileSync(f), i = b.indexOf('data') + 8, n = (b.length - i) >> 1, o = new Float32Array(n); for (let k = 0; k < n; k++) o[k] = b.readInt16LE(i + 2 * k) / 32768; return o; };
let liveDrop = 0, nowDrop = 0, total = 0;
const bench = { owner: [0, 0], other: [0, 0] };   // [right, total]
const truthOf = (dir) => {
  const f = `${dir}/truth.json`, t = existsSync(f) ? JSON.parse(readFileSync(f)) : { default: 'owner', unverified: true };
  const inS = (spans, ms) => (spans ?? []).some(([a, b]) => a <= ms && ms <= b);
  return { t, who: (ms) => (inS(t.other, ms) ? 'other' : inS(t.owner, ms) ? 'owner' : t.default) };
};
for (const dir of dirs) {
  const meta = JSON.parse(readFileSync(`${dir}/meta.json`)), toks = JSON.parse(readFileSync(`${dir}/tokens.json`)).filter((t) => t.is_final);
  if (!toks.length) continue;
  const gate = new SpeakerGate({ voiceprint: meta.voiceprint, model, ...opts });
  await new Promise((r) => setTimeout(r, 0));
  const pcm = rd(`${dir}/session.wav`), CH = 1024;   // 64 ms frames, like the app
  const idle = async () => { while (gate._busy) await new Promise((r) => setTimeout(r, 1)); };
  let ti = 0, prev; const out = [];
  for (let p = 0; p < pcm.length || ti < toks.length; p += CH) {
    if (p < pcm.length) { gate.pushSent(pcm.subarray(p, p + CH)); await idle(); }
    for (; ti < toks.length && toks[ti].arrival_ms <= (p + CH) / 16; ti++) {
      const t = toks[ti], keep = gate.admit(t, prev); prev = { speaker: t.speaker, keep };
      out.push({ t, keep });
    }
    await idle();
  }
  const { t: truth, who } = truthOf(dir);
  for (const o of out) { const w = who((o.t.start_ms + o.t.end_ms) / 2), b = bench[w]; b[1]++; if (o.keep === (w === 'owner')) b[0]++; }
  const lv = out.filter((o) => !o.t.keep).length, nw = out.filter((o) => !o.keep).length;
  liveDrop += lv; nowDrop += nw; total += out.length;
  const txt = out.map((o) => (o.keep ? o.t.text : `[${o.t.text.trim()}]`)).join('');
  console.log(`${dir.split('/').pop()}  dropped live ${lv}/${out.length} → now ${nw}/${out.length}  ${truth.unverified ? '' : '(truth.json) '}labels ${JSON.stringify(Object.fromEntries(Object.entries(gate.state.labels).map(([k, l]) => [k, +(l.score ?? NaN).toFixed(2)])))}\n   ${txt.trim()}`);
}
console.log(`TOTAL dropped live ${liveDrop}/${total} → now ${nowDrop}/${total}`);
const pct = ([r, n]) => `${r}/${n}${n ? ` (${(100 * r / n).toFixed(1)}%)` : ''}`;
console.log(`BENCH owner words kept ${pct(bench.owner)}   other-voice words dropped ${pct(bench.other)}`);
process.exit(0);
