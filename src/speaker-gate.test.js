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

test('window decides before a label has a score; finals pass when nothing is known', async () => {
  const g = await gateWith([[2, 1], [2, -1]]);
  assert.equal(g.admit({ text: ' hi', start_ms: 500, end_ms: 900, speaker: '1', is_final: false }), true);
  assert.equal(g.admit({ text: ' yo', start_ms: 3500, end_ms: 3900, speaker: '2', is_final: false }), false);
  const cold = new SpeakerGate({ voiceprint: VP, model: new Promise(() => {}) });
  assert.equal(cold.admit({ text: ' a', start_ms: 0, end_ms: 100, is_final: true }), true);
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
