import test from 'node:test';
import assert from 'node:assert/strict';
import { computeFbank, cosineSimilarity, l2Normalize, extractActiveSpeech } from '../src/fbank.js';
import { extractMfccEmbedding } from './mfcc-baseline.js';
import { MODELS } from './models.js';

function sineWave(freq, sec, sr = 16000, amp = 0.5) {
  const n = Math.floor(sec * sr);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / sr);
  return out;
}

test('computeFbank returns expected shape and zero-mean CMVN', () => {
  const pcm = sineWave(220, 1.0);
  const { data, numFrames, numBins } = computeFbank(pcm, {
    scale: 32768, window: 'hamming', numBins: 80, frameLenMs: 25, frameShiftMs: 10, cmvn: 'mean',
  });
  assert.equal(numBins, 80);
  assert.equal(numFrames, 98); // (16000 - 400)/160 + 1
  assert.equal(data.length, numFrames * numBins);
  for (let b = 0; b < 80; b++) {
    let mean = 0;
    for (let f = 0; f < numFrames; f++) mean += data[f * 80 + b];
    mean /= numFrames;
    assert.ok(Math.abs(mean) < 1e-4, `bin ${b} mean ${mean} not ~0`);
  }
});

test('extractActiveSpeech strips silence and keeps voiced region', () => {
  const pcm = new Float32Array(16000 * 2);
  pcm.set(sineWave(180, 0.5, 16000, 0.3), 8000);
  const active = extractActiveSpeech(pcm, 0.02);
  assert.ok(active.length >= 7000 && active.length <= 12000, `unexpected active len ${active.length}`);
});

test('mfcc baseline separates distinct harmonic spectra and is L2-normalized', () => {
  const a1 = sineWave(130, 1.5);
  const a2 = sineWave(132, 1.5);
  const b = sineWave(290, 1.5);
  const ea1 = extractMfccEmbedding(a1).embedding;
  const ea2 = extractMfccEmbedding(a2).embedding;
  const eb = extractMfccEmbedding(b).embedding;
  assert.equal(ea1.length, 78);
  assert.ok(Math.abs(cosineSimilarity(ea1, ea1) - 1.0) < 1e-5);
  assert.ok(cosineSimilarity(ea1, ea2) > cosineSimilarity(ea1, eb));
});

test('model registry entries have unique ids and valid configs', () => {
  const ids = new Set();
  for (const m of MODELS) {
    assert.ok(!ids.has(m.id), `duplicate id ${m.id}`);
    ids.add(m.id);
    assert.ok(m.embDim > 0);
    if (m.kind === 'onnx') {
      assert.ok(m.file && m.url && m.fbank && m.inputName && m.outputName);
    }
  }
});

test('l2Normalize produces unit norm', () => {
  const v = l2Normalize(new Float32Array([3, 4]));
  assert.ok(Math.abs(v[0] - 0.6) < 1e-6 && Math.abs(v[1] - 0.8) < 1e-6);
});
