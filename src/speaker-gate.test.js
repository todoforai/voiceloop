import test from 'node:test';
import assert from 'node:assert/strict';
import { SpeakerGate } from './speaker-gate.js';

// Fake model: a positive-DC signal is "the owner" (embeds to the voiceprint), negative is someone else.
const VP = [1, 0];
const model = { embed: async (pcm) => { let s = 0; for (const v of pcm) s += v; return Float32Array.from(s > 0 ? [1, 0] : [0, 1]); } };
const tick = () => new Promise((r) => setTimeout(r, 5));
const tone = (sec, sign) => new Float32Array(sec * 16000).fill(0.1 * sign);

async function gateWith(segments) {   // [[sec, sign]] → gate that has heard them, fully scored
  const g = new SpeakerGate({ voiceprint: VP, model });
  await tick();
  for (const [sec, sign] of segments) { g.pushSent(tone(sec, sign)); await tick(); }
  return g;
}

test('window decides before a label has a score; nothing known → dropped (fail-closed)', async () => {
  const g = await gateWith([[2, 1], [2, -1]]);
  assert.equal(g.admit({ text: ' hi', start_ms: 500, end_ms: 900, speaker: '1', is_final: false }), true);
  assert.equal(g.admit({ text: ' yo', start_ms: 3500, end_ms: 3900, speaker: '2', is_final: false }), false);
  const cold = new SpeakerGate({ voiceprint: VP, model: new Promise(() => {}) });
  assert.equal(cold.admit({ text: ' a', start_ms: 0, end_ms: 100, is_final: true }), false);
  // A quiet voice (window under minRms → no score) with no label score yet is not waved through either
  const quiet = await gateWith([[2, 0.05]]);
  assert.equal(quiet.windowScore(8000), undefined);
  assert.equal(quiet.admit({ text: ' psst', start_ms: 300, end_ms: 700, speaker: '2', is_final: true }), false);
  assert.equal(cold.admit({ text: ' a', start_ms: 0, end_ms: 100, is_final: false }), false);
});

test('label score + window veto; sub-word piece follows its word', async () => {
  const g = await gateWith([[3, 1], [3, -1]]);
  for (let ms = 0; ms < 3000; ms += 500) g.admit({ text: ' w', start_ms: ms, end_ms: ms + 400, speaker: '1', is_final: true });
  await tick();
  assert.ok(g.state.labels['1'].score > 0.9);
  // Owner label, but the audio under the word is someone else → vetoed
  assert.equal(g.admit({ text: ' x', start_ms: 4500, end_ms: 4900, speaker: '1', is_final: true }), false);
  const prev = { speaker: '1', keep: true };
  assert.equal(g.admit({ text: 'ing', start_ms: 4900, end_ms: 5000, speaker: '1', is_final: true }, prev), true);
  assert.equal(g.admit({ text: 'ing', start_ms: 4900, end_ms: 5000, speaker: '2', is_final: true }, prev), false);
});

test('resetStream drops labels and windows', async () => {
  const g = await gateWith([[2, 1]]);
  g.admit({ text: ' a', start_ms: 0, end_ms: 1500, speaker: '1', is_final: true });
  g.resetStream();
  assert.deepEqual(g.state.labels, {});
  assert.equal(g.windowScore(8000), undefined);
});

test('onStreamLog captures PCM, per-token verdicts/reasons, windows, labels, and turns on endStream', async () => {
  const logs = [];
  const g = new SpeakerGate({ voiceprint: VP, model, onStreamLog: (d) => logs.push(d) });
  await tick();
  g.pushSent(tone(2, 1)); await tick();
  g.pushSent(tone(2, -1)); await tick();
  assert.equal(g.admit({ text: ' szia', start_ms: 400, end_ms: 800, speaker: '1', is_final: true }), true);
  assert.equal(g.admit({ text: ' mas', start_ms: 3200, end_ms: 3600, speaker: '2', is_final: true }), false);
  g.logTurn('<end>', 'szia');
  g.endStream('close');
  g.endStream('close');   // idempotent: second call does not duplicate
  assert.equal(logs.length, 1);
  assert.equal(logs[0].pcm.length, 4 * 16000);
  assert.equal(logs[0].tokens.length, 2);
  assert.equal(logs[0].tokens[0].reason, 'win_ok');
  assert.equal(logs[0].tokens[1].reason, 'win_low');
  assert.ok(logs[0].windows.length >= 2);
  assert.equal(logs[0].turns.length, 1);
  assert.equal(logs[0].turns[0].emittedText, 'szia');
  assert.equal(logs[0].meta.endReason, 'close');
  assert.equal(logs[0].meta.dropped, 1);
});

test('label pool: padded token stamps, short same-voice gaps bridged into one span', async () => {
  const g = await gateWith([[4, 1]]);
  // Soniox-style 60 ms stamps, 200 ms apart: pooled as ONE continuous span, not 60 ms crumbs
  for (let ms = 300; ms < 2000; ms += 200) g.admit({ text: ' w', start_ms: ms, end_ms: ms + 60, speaker: '1', is_final: true });
  const lab = g.labels.get('1');
  assert.equal(lab.segs.length, 1);
  assert.ok(lab.sec > 1.7, `pooled ${lab.sec}s`);
  // A gap past poolGapMs starts a new span; another label never extends this one
  g.admit({ text: ' x', start_ms: 3000, end_ms: 3060, speaker: '1', is_final: true });
  assert.equal(lab.segs.length, 2);
  g.admit({ text: ' y', start_ms: 3100, end_ms: 3160, speaker: '2', is_final: true });
  g.admit({ text: ' z', start_ms: 3200, end_ms: 3260, speaker: '1', is_final: true });
  assert.equal(lab.segs.length, 3);
});

test('window-only: a word after a kept same-voice word clears at the veto bar, a fresh one does not', async () => {
  const g = await gateWith([[2, 1]]);
  g.windowScore = () => 0.31;   // between veto (0.30) and windowThreshold (0.33): a phrase-final word
  const w = { text: ' volt.', start_ms: 1000, end_ms: 1060, speaker: '1', is_final: false };
  assert.equal(g.admit(w, { speaker: '1', keep: true }), true);
  assert.equal(g.admit(w), false);
  assert.equal(g.admit(w, { speaker: '2', keep: true }), false);
  g.windowScore = () => 0.2;
  assert.equal(g.admit(w, { speaker: '1', keep: true }), false);
});

test('never worse than no lock for the owner: uncertain words follow the kept word, evidence drops', async () => {
  const g = await gateWith([[2, 1]]);
  const w = { text: ' vége', start_ms: 1000, end_ms: 1060, speaker: '1', is_final: false };
  const kept = { speaker: '1', keep: true };
  g.windowScore = () => undefined;                 // trailing silence: no window
  assert.equal(g.admit(w, kept), true);
  assert.equal(g.admit(w), false);                 // nothing accepted yet → still fail-closed
  g.windowScore = () => 0.2;                       // clear evidence of another voice
  assert.equal(g.admit(w, kept), false);
  g.labels.set('1', { segs: [], sec: 3, scoredSec: 3, score: 0.44 });
  g.windowScore = () => 0.5;                       // unsure label: the window decides
  assert.equal(g.admit(w), true);
  g.windowScore = () => 0.35;
  assert.equal(g.admit(w, kept), true);            // unsure label + unsure window → follows the kept word
  g.labels.get('1').score = 0.2;                   // clearly someone else's label
  g.windowScore = () => 0.7;
  assert.equal(g.admit(w, kept), false);
});
