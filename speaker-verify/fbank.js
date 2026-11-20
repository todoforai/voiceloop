// fbank.js — Zero-dependency Kaldi-compatible log-Mel filterbank & audio utils (16 kHz mono).
// Designed for browser & Node ESM; precomputes FFT twiddle factors & filterbanks per config.

const SR = 16000;
const N_FFT = 512;
const HALF_FFT = (N_FFT >> 1) + 1; // 257

// Precomputed bit-reversal & twiddle tables for 512-point radix-2 FFT
const BIT_REV = new Uint16Array(N_FFT);
for (let i = 0; i < N_FFT; i++) {
  let x = i, r = 0;
  for (let b = 0; b < 9; b++) { r = (r << 1) | (x & 1); x >>= 1; }
  BIT_REV[i] = r;
}

const COS_TBL = new Float32Array(N_FFT >> 1);
const SIN_TBL = new Float32Array(N_FFT >> 1);
for (let i = 0; i < (N_FFT >> 1); i++) {
  const angle = (-2 * Math.PI * i) / N_FFT;
  COS_TBL[i] = Math.cos(angle);
  SIN_TBL[i] = Math.sin(angle);
}

// In-place radix-2 Cooley-Tukey FFT on length-512 real/imag buffers
function fft512(re, im) {
  for (let i = 0; i < N_FFT; i++) {
    const j = BIT_REV[i];
    if (j > i) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let size = 2; size <= N_FFT; size <<= 1) {
    const half = size >> 1;
    const step = N_FFT / size;
    for (let i = 0; i < N_FFT; i += size) {
      for (let j = 0; j < half; j++) {
        const k = j * step;
        const wr = COS_TBL[k], wi = SIN_TBL[k];
        const idx = i + j + half;
        const tr = wr * re[idx] - wi * im[idx];
        const ti = wr * im[idx] + wi * re[idx];
        re[idx] = re[i + j] - tr;
        im[idx] = im[i + j] - ti;
        re[i + j] += tr;
        im[i + j] += ti;
      }
    }
  }
}

const hzToMel = (hz) => 1127.0 * Math.log(1.0 + hz / 700.0);

const filterbankCache = new Map();
function getMelFilterbank(numBins, lowFreq, highFreq) {
  const key = `${numBins}:${lowFreq}:${highFreq}`;
  if (filterbankCache.has(key)) return filterbankCache.get(key);

  const melLow = hzToMel(lowFreq);
  const melHigh = hzToMel(highFreq);
  const melPts = new Float64Array(numBins + 2);
  for (let i = 0; i < numBins + 2; i++) {
    melPts[i] = melLow + ((melHigh - melLow) * i) / (numBins + 1);
  }
  const binWidth = SR / N_FFT;
  const binMels = new Float64Array(HALF_FFT);
  for (let k = 0; k < HALF_FFT; k++) binMels[k] = hzToMel(k * binWidth);

  // Sparse representation: for each mel bin, store [startK, endK, weights]
  const banks = new Array(numBins);
  for (let m = 0; m < numBins; m++) {
    const left = melPts[m], center = melPts[m + 1], right = melPts[m + 2];
    let start = HALF_FFT, end = -1;
    const w = new Float32Array(HALF_FFT);
    for (let k = 0; k < HALF_FFT; k++) {
      const mel = binMels[k];
      const up = (mel - left) / (center - left);
      const down = (right - mel) / (right - center);
      const val = Math.max(0, Math.min(up, down));
      if (val > 0) {
        w[k] = val;
        if (k < start) start = k;
        if (k > end) end = k;
      }
    }
    banks[m] = { start, end, weights: w };
  }
  filterbankCache.set(key, banks);
  return banks;
}

const windowCache = new Map();
function getWindow(type, len) {
  const key = `${type}:${len}`;
  if (windowCache.has(key)) return windowCache.get(key);
  const w = new Float32Array(len);
  const denom = len - 1;
  for (let n = 0; n < len; n++) {
    const c = Math.cos((2 * Math.PI * n) / denom);
    if (type === 'povey') w[n] = Math.pow(0.5 - 0.5 * c, 0.85);
    else if (type === 'hamming') w[n] = 0.54 - 0.46 * c;
    else w[n] = 0.5 - 0.5 * c; // hann
  }
  windowCache.set(key, w);
  return w;
}

/**
 * Compute Kaldi-style log Mel filterbank features.
 * @param {Float32Array} pcm - 16 kHz mono float32 in [-1, 1]
 * @param {object} opts
 * @returns {{ data: Float32Array, numFrames: number, numBins: number }}
 */
export function computeFbank(pcm, {
  scale = 1.0,
  window = 'povey',
  numBins = 80,
  frameLenMs = 25,
  frameShiftMs = 10,
  lowFreq = 20.0,
  highFreq = 7600.0,
  cmvn = 'mean', // 'mean' | 'per_feature' | 'none'
  preemph = 0.97,
} = {}) {
  const frameLen = Math.floor((SR * frameLenMs) / 1000);
  const frameShift = Math.floor((SR * frameShiftMs) / 1000);
  const numFrames = pcm.length >= frameLen ? 1 + Math.floor((pcm.length - frameLen) / frameShift) : 0;
  if (numFrames < 1) {
    return { data: new Float32Array(numBins), numFrames: 1, numBins };
  }

  const win = getWindow(window, frameLen);
  const banks = getMelFilterbank(numBins, lowFreq, highFreq);
  const out = new Float32Array(numFrames * numBins);

  const frame = new Float32Array(frameLen);
  const re = new Float32Array(N_FFT);
  const im = new Float32Array(N_FFT);
  const power = new Float32Array(HALF_FFT);

  for (let f = 0; f < numFrames; f++) {
    const offset = f * frameShift;
    // Scale + DC offset removal
    let mean = 0;
    for (let i = 0; i < frameLen; i++) {
      const v = pcm[offset + i] * scale;
      frame[i] = v;
      mean += v;
    }
    mean /= frameLen;
    for (let i = 0; i < frameLen; i++) frame[i] -= mean;

    // Pre-emphasis (backwards so we can do it in-place)
    for (let i = frameLen - 1; i > 0; i--) frame[i] -= preemph * frame[i - 1];
    frame[0] *= (1.0 - preemph);

    // Apply window & zero-pad to 512
    for (let i = 0; i < frameLen; i++) re[i] = frame[i] * win[i];
    for (let i = frameLen; i < N_FFT; i++) re[i] = 0;
    im.fill(0);

    fft512(re, im);

    for (let k = 0; k < HALF_FFT; k++) {
      power[k] = re[k] * re[k] + im[k] * im[k];
    }

    const rowOffset = f * numBins;
    for (let m = 0; m < numBins; m++) {
      const { start, end, weights } = banks[m];
      let sum = 0;
      for (let k = start; k <= end; k++) sum += power[k] * weights[k];
      out[rowOffset + m] = Math.log(sum > 1e-10 ? sum : 1e-10);
    }
  }

  if (cmvn === 'mean' || cmvn === 'per_feature') {
    for (let m = 0; m < numBins; m++) {
      let sum = 0;
      for (let f = 0; f < numFrames; f++) sum += out[f * numBins + m];
      const mu = sum / numFrames;
      if (cmvn === 'mean') {
        for (let f = 0; f < numFrames; f++) out[f * numBins + m] -= mu;
      } else {
        let varSum = 0;
        for (let f = 0; f < numFrames; f++) {
          const d = out[f * numBins + m] - mu;
          varSum += d * d;
        }
        const invStd = 1.0 / (Math.sqrt(varSum / numFrames) + 1e-5);
        for (let f = 0; f < numFrames; f++) out[f * numBins + m] = (out[f * numBins + m] - mu) * invStd;
      }
    }
  }

  return { data: out, numFrames, numBins };
}

export function l2Normalize(vec) {
  let norm = 0;
  for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm) || 1;
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] / norm;
  return out;
}

export function cosineSimilarity(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9);
}

export function rmsEnergy(pcm) {
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) sum += pcm[i] * pcm[i];
  return Math.sqrt(sum / (pcm.length || 1));
}

/**
 * Simple energy VAD: keeps 30ms frames above RMS threshold (with 1-frame padding).
 * Useful for stripping silence during enrollment so embeddings come purely from speech.
 */
export function extractActiveSpeech(pcm, threshold = 0.015) {
  const frameSize = 480; // 30ms @ 16kHz
  const nFrames = Math.floor(pcm.length / frameSize);
  if (nFrames === 0) return pcm;
  const active = new Uint8Array(nFrames);
  for (let f = 0; f < nFrames; f++) {
    let sum = 0;
    const base = f * frameSize;
    for (let i = 0; i < frameSize; i++) { const v = pcm[base + i]; sum += v * v; }
    if (Math.sqrt(sum / frameSize) >= threshold) active[f] = 1;
  }
  // 2-frame hangover padding so word edges stay intact
  const padded = new Uint8Array(nFrames);
  for (let f = 0; f < nFrames; f++) {
    if (active[f]) {
      for (let d = -2; d <= 2; d++) {
        if (f + d >= 0 && f + d < nFrames) padded[f + d] = 1;
      }
    }
  }
  let count = 0;
  for (let f = 0; f < nFrames; f++) if (padded[f]) count++;
  if (count === 0) return new Float32Array(0);
  const out = new Float32Array(count * frameSize);
  let pos = 0;
  for (let f = 0; f < nFrames; f++) {
    if (padded[f]) {
      out.set(pcm.subarray(f * frameSize, (f + 1) * frameSize), pos);
      pos += frameSize;
    }
  }
  return out;
}

/** Decode 16-bit PCM mono WAV ArrayBuffer to Float32Array [-1, 1] */
export function decodeWav16k(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  // Find 'data' chunk robustly
  let offset = 12;
  while (offset + 8 <= view.byteLength) {
    const id = String.fromCharCode(
      view.getUint8(offset), view.getUint8(offset + 1),
      view.getUint8(offset + 2), view.getUint8(offset + 3)
    );
    const size = view.getUint32(offset + 4, true);
    if (id === 'data') {
      const n = Math.floor(size / 2);
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = view.getInt16(offset + 8 + i * 2, true) / 32768.0;
      return out;
    }
    offset += 8 + size;
  }
  throw new Error('Invalid WAV: missing data chunk');
}
