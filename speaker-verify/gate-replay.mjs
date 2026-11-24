#!/usr/bin/env node
// Causal replay of the REAL SpeakerGate (src/speaker-gate.js) on a recorded Soniox stream: audio is
// pushed at real-time pace and every token is admitted at the moment it originally arrived
// (arrival_ms), so the gate only knows the past — exactly what the app sees live. Compare with
// gate-eval.py, which pools each label's audio over the WHOLE recording (an upper bound).
// Limit: soniox-stream.mjs records finals only, so partial-tail gating isn't replayed (stt.js handles it).
// Needs: soniox-stream.mjs --diarize output + onnxruntime-web in node (NODE_PATH=/path/node_modules).
// Usage: node gate-replay.mjs [.cache/hu-dialogue/soniox_tokens.json] [key=value gate options…]
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { SpeakerGate, enrollSpeaker, SPEAKER_MODEL } from '../src/speaker-gate.js';
import { computeFbank, l2Normalize } from '../src/fbank.js';
const ort = createRequire(process.env.NODE_PATH + '/')('onnxruntime-web');
const H = new URL('.cache/hu-dialogue/', import.meta.url).pathname;
const tokFile = process.argv[2] ?? H + 'soniox_tokens.json';
const rd = (f) => { const b = readFileSync(f), i = b.indexOf('data') + 8, n = (b.length - i) >> 1, o = new Float32Array(n); for (let k = 0; k < n; k++) o[k] = b.readInt16LE(i + 2 * k) / 32768; return o; };
const session = await ort.InferenceSession.create(readFileSync(new URL('.cache/models/campplus_200k.onnx', import.meta.url).pathname));
const model = { embed: async (pcm) => { const { data, numFrames, numBins } = computeFbank(pcm, SPEAKER_MODEL.fbank); return l2Normalize((await session.run({ feats: new ort.Tensor('float32', data, [1, numFrames, numBins]) })).embs.data); } };

const meta = JSON.parse(readFileSync(H + 'dialogue_meta.json')), toks = JSON.parse(readFileSync(tokFile));
const { voiceprint } = await enrollSpeaker(rd(H + 'enroll_attila.wav'), { model });
const opts = Object.fromEntries(process.argv.slice(3).map((a) => a.split('=')).map(([k, v]) => [k, +v]));
const gate = new SpeakerGate({ voiceprint, model, ...opts });
await new Promise((r) => setTimeout(r, 0));
const pcm = rd(H + 'dialogue_full.wav'), CH = 2048;   // 128 ms frames, like the app
const idle = async () => { while (gate._busy) await new Promise((r) => setTimeout(r, 1)); };   // inference keeps up (≈30 ms / 0.5 s hop)
const role = (ms) => meta.turns.find((t) => t.startSec - .3 <= ms / 1000 && ms / 1000 <= t.endSec + .3)?.role ?? 'other';
const out = []; let ti = 0, word = null, prev;
for (let p = 0; p < pcm.length + 16000 * 8 || ti < toks.length; p += CH) {
  if (p < pcm.length) { gate.pushSent(pcm.subarray(p, p + CH)); await idle(); }
  const now = (p + CH) / 16;
  // One response = one synchronous batch, like stt.js: a label score scheduled by an earlier token
  // of the same batch is NOT visible to later ones.
  for (; ti < toks.length && toks[ti].arrival_ms <= now; ti++) {
    const t = toks[ti]; if (t.text.startsWith('<')) { prev = undefined; continue; }
    const keep = gate.admit(t, prev); prev = { speaker: t.speaker, keep };
    if (/^\s/.test(t.text) || !word) out.push(word = { text: t.text.trim(), keep, role: role((t.start_ms + t.end_ms) / 2), spk: t.speaker });
    else word.text += t.text;
  }
  await idle();
}
const ws = out.filter((w) => w.text);
const own = ws.filter((w) => w.role === 'owner'), oth = ws.filter((w) => w.role === 'other');
console.log(`tokens: ${tokFile.split('/').pop()}  labels: ${JSON.stringify(gate.state.labels)}`);
console.log(`owner words kept: ${own.filter((w) => w.keep).length}/${own.length}   intruder words dropped: ${oth.filter((w) => !w.keep).length}/${oth.length}`);
let cur = null; const lines = [];
for (const w of ws) { const k = w.role; if (!cur || cur.k !== k) lines.push(cur = { k, s: [] }); cur.s.push(w.keep ? w.text : `[${w.text}]`); }
for (const l of lines) console.log(`  ${l.k.padEnd(7)} ${l.s.join(' ')}`);
process.exit(0);
