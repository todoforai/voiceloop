// mfcc-baseline.js — Zero-ML classical acoustic baseline (0 MB, ~5-15 ms).
// Extracts 19 MFCCs (DCT-II of 40-bin log-mel) + deltas -> mean & std across frames
// + decimated autocorrelation pitch (F0) stats -> 78-dim L2-normalized vector.

import { computeFbank, l2Normalize } from '../src/fbank.js';

const NUM_MEL = 40;
const NUM_MFCC = 20;

const DCT = new Float32Array(NUM_MFCC * NUM_MEL);
const normScale = Math.sqrt(2.0 / NUM_MEL);
for (let k = 0; k < NUM_MFCC; k++) {
  for (let n = 0; n < NUM_MEL; n++) {
    DCT[k * NUM_MEL + n] = normScale * Math.cos((Math.PI * k * (n + 0.5)) / NUM_MEL);
  }
}

function estimatePitchStats(pcm, sr = 16000) {
  // Decimate 4x (4 kHz) for fast F0 autocorrelation in [70 Hz, 350 Hz]
  const dec = 4;
  const dsr = sr / dec; // 4000 Hz
  const n = Math.floor(pcm.length / dec);
  const ds = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    ds[i] = (pcm[i * 4] + pcm[i * 4 + 1] + pcm[i * 4 + 2] + pcm[i * 4 + 3]) * 0.25;
  }
  const frameLen = 120; // 30ms @ 4kHz
  const hop = 80;       // 20ms
  const minLag = Math.floor(dsr / 350); // 11
  const maxLag = Math.floor(dsr / 70);  // 57
  const pitches = [];
  for (let start = 0; start + frameLen <= n; start += hop) {
    let e0 = 0;
    for (let i = 0; i < frameLen; i++) { const v = ds[start + i]; e0 += v * v; }
    if (e0 < 0.0025) continue;
    let bestLag = 0, bestCorr = 0.48;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let num = 0, e1 = 0, e2 = 0;
      const lim = frameLen - lag;
      for (let i = 0; i < lim; i++) {
        const a = ds[start + i], b = ds[start + i + lag];
        num += a * b; e1 += a * a; e2 += b * b;
      }
      const corr = num / (Math.sqrt(e1 * e2) + 1e-9);
      if (corr > bestCorr) { bestCorr = corr; bestLag = lag; }
    }
    if (bestLag > 0) pitches.push(Math.log2(dsr / bestLag));
  }
  if (pitches.length === 0) return [0, 0];
  let sum = 0;
  for (const p of pitches) sum += p;
  const mu = sum / pitches.length;
  let v = 0;
  for (const p of pitches) v += (p - mu) * (p - mu);
  return [(mu - 7.0) * 1.5, Math.sqrt(v / pitches.length) * 2.0];
}

export function extractMfccEmbedding(pcm) {
  const { data, numFrames } = computeFbank(pcm, {
    scale: 1.0,
    window: 'hamming',
    numBins: NUM_MEL,
    frameLenMs: 25,
    frameShiftMs: 10,
    lowFreq: 40,
    highFreq: 7600,
    cmvn: 'none',
  });

  const C = NUM_MFCC - 1;
  const mfcc = new Float32Array(numFrames * C);
  for (let f = 0; f < numFrames; f++) {
    const fOff = f * NUM_MEL;
    const mOff = f * C;
    for (let k = 1; k < NUM_MFCC; k++) {
      let s = 0;
      const dOff = k * NUM_MEL;
      for (let n = 0; n < NUM_MEL; n++) s += data[fOff + n] * DCT[dOff + n];
      mfcc[mOff + (k - 1)] = s;
    }
  }

  const emb = new Float32Array(C * 4 + 2);
  for (let c = 0; c < C; c++) {
    let sum = 0;
    for (let f = 0; f < numFrames; f++) sum += mfcc[f * C + c];
    const mu = sum / numFrames;
    let v = 0;
    for (let f = 0; f < numFrames; f++) { const d = mfcc[f * C + c] - mu; v += d * d; }
    emb[c] = mu;
    emb[C + c] = Math.sqrt(v / numFrames);
  }

  if (numFrames > 2) {
    const count = numFrames - 2;
    for (let c = 0; c < C; c++) {
      let sum = 0;
      for (let f = 1; f < numFrames - 1; f++) {
        sum += (mfcc[(f + 1) * C + c] - mfcc[(f - 1) * C + c]) * 0.5;
      }
      const mu = sum / count;
      let v = 0;
      for (let f = 1; f < numFrames - 1; f++) {
        const d = (mfcc[(f + 1) * C + c] - mfcc[(f - 1) * C + c]) * 0.5 - mu;
        v += d * d;
      }
      emb[2 * C + c] = mu * 2.0;
      emb[3 * C + c] = Math.sqrt(v / count) * 2.0;
    }
  }

  const [pMean, pStd] = estimatePitchStats(pcm);
  emb[4 * C] = pMean;
  emb[4 * C + 1] = pStd;

  return { embedding: l2Normalize(emb), numFrames };
}
