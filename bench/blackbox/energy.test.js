// bench/blackbox/energy.test.js — the offline segmenter and online Gate agree on synthetic PCM.
// Run: `node --test bench/blackbox/energy.test.js`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { segments, Gate, RATE } from './energy.js';

// Synthetic PCM: concatenated (ms, amplitude) spans of a 440Hz tone (amp 0 = silence).
function pcm(spans) {
  const total = spans.reduce((a, [ms]) => a + ms, 0);
  const buf = Buffer.alloc(Math.floor((total / 1000) * RATE) * 2);
  let sample = 0;
  for (const [ms, amp] of spans) {
    const n = Math.floor((ms / 1000) * RATE);
    for (let i = 0; i < n; i++, sample++)
      buf.writeInt16LE(Math.round(amp * Math.sin((2 * Math.PI * 440 * sample) / RATE)), sample * 2);
  }
  return buf;
}

test('segments: one utterance with a short intra-word gap stays ONE segment', () => {
  const buf = pcm([[300, 0], [400, 8000], [150, 0], [400, 8000], [1000, 0]]);
  const segs = segments(buf);
  assert.equal(segs.length, 1, '150ms gap < hangMs absorbed');
  assert.ok(Math.abs(segs[0].startMs - 300) < 60, `onset ~300ms, got ${segs[0].startMs}`);
  assert.ok(Math.abs(segs[0].endMs - 1250) < 100, `offset ~1250ms, got ${segs[0].endMs}`);
});

test('segments: a real pause splits into two segments', () => {
  const segs = segments(pcm([[200, 0], [400, 8000], [600, 0], [400, 8000], [500, 0]]));
  assert.equal(segs.length, 2);
});

test('segments: pure silence and quiet noise yield nothing', () => {
  assert.equal(segments(pcm([[2000, 0]])).length, 0);
  assert.equal(segments(pcm([[2000, 150]])).length, 0, 'below-threshold hum ignored');
});

test('Gate (streaming, odd chunk sizes) matches the offline segmenter', () => {
  const buf = pcm([[300, 0], [500, 8000], [800, 0], [300, 8000], [600, 0]]);
  const offline = segments(buf);
  const on = [], off = [];
  const g = new Gate({ onSpeech: (t) => on.push(t), onSilence: (t) => off.push(t) });
  for (let o = 0; o < buf.length; o += 777) g.feed(buf.subarray(o, Math.min(o + 777, buf.length)));   // deliberately frame-unaligned
  assert.equal(on.length, offline.length, 'same number of onsets');
  offline.forEach((s, i) => {
    assert.ok(Math.abs(on[i] - s.startMs) < 40, `onset ${i}: gate ${on[i]} vs offline ${s.startMs}`);
    assert.ok(Math.abs(off[i] - s.endMs) < 40, `offset ${i}: gate ${off[i]} vs offline ${s.endMs}`);
  });
});
