// verifier.js — Browser speaker verification engine wrapping onnxruntime-web + DSP baseline.
// Supports WASM (1-thread / multi-thread SIMD) and WebGPU execution providers.

import { computeFbank, l2Normalize, cosineSimilarity, extractActiveSpeech } from '../src/fbank.js';
import { extractMfccEmbedding } from './mfcc-baseline.js';
import { MODEL_BY_ID } from './models.js';

const ORT_CDN = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/';

let ortPromise = null;
async function getOrt() {
  if (!ortPromise) {
    ortPromise = import(`${ORT_CDN}ort.all.min.mjs`).then((m) => {
      const ort = m.default || m;
      ort.env.wasm.wasmPaths = ORT_CDN;
      ort.env.logLevel = 'error';
      return ort;
    });
  }
  return ortPromise;
}

export class SpeakerVerifier {
  constructor() {
    this.sessions = new Map();     // `${modelId}:${backend}` -> { session, loadMs, actualEP }
    this.modelBytes = new Map();   // modelId -> ArrayBuffer (cached across backend switches)
    this.backend = this.detectDefaultBackend();
  }

  detectDefaultBackend() {
    if (typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated) return 'wasm-mt';
    return 'wasm-1t';
  }

  async setBackend(backend) {
    this.backend = backend;
    // Clear cached sessions so next call initializes on the chosen EP
    for (const { session } of this.sessions.values()) {
      try { await session.release?.(); } catch {}
    }
    this.sessions.clear();
  }

  async loadModel(modelId, onStatus) {
    const spec = MODEL_BY_ID[modelId];
    if (!spec) throw new Error(`Unknown model: ${modelId}`);
    if (spec.kind === 'dsp') return { loadMs: 0, actualEP: 'js-dsp' };

    const key = `${modelId}:${this.backend}`;
    if (this.sessions.has(key)) return this.sessions.get(key);

    const ort = await getOrt();
    let bytes = this.modelBytes.get(modelId);
    const t0 = performance.now();
    if (!bytes) {
      onStatus?.(`Letöltés: ${spec.shortName} (${spec.sizeMB} MB)...`);
      const resp = await fetch(`/models/${spec.file}`);
      if (!resp.ok) throw new Error(`Modell letöltési hiba (${resp.status}): ${spec.file}`);
      bytes = await resp.arrayBuffer();
      this.modelBytes.set(modelId, bytes);
    }

    onStatus?.(`Inicializálás (${this.backend}): ${spec.shortName}...`);
    const threads = this.backend === 'wasm-mt' && crossOriginIsolated
      ? Math.min(navigator.hardwareConcurrency || 4, 4)
      : 1;
    ort.env.wasm.numThreads = threads;
    ort.env.wasm.simd = true;

    const eps = this.backend === 'webgpu' ? ['webgpu', 'wasm'] : ['wasm'];
    let actualEP = this.backend;
    let session;
    try {
      session = await ort.InferenceSession.create(bytes, {
        executionProviders: eps,
        graphOptimizationLevel: 'all',
      });
    } catch (err) {
      if (this.backend === 'webgpu') {
        actualEP = 'wasm-fallback';
        session = await ort.InferenceSession.create(bytes, {
          executionProviders: ['wasm'],
          graphOptimizationLevel: 'all',
        });
      } else {
        throw err;
      }
    }

    // Warm-up pass (0.5s dummy silence) so JIT/WASM compilation doesn't skew first latency measurement
    const warmup = new Float32Array(8000);
    await this._runSession(ort, spec, session, warmup);

    const loadMs = performance.now() - t0;
    const entry = { session, loadMs, actualEP };
    this.sessions.set(key, entry);
    return entry;
  }

  async _runSession(ort, spec, session, pcm) {
    const t0 = performance.now();
    const { data, numFrames, numBins } = computeFbank(pcm, spec.fbank);
    const t1 = performance.now();

    let feeds;
    if (spec.layout === 'NEMO') {
      // Transpose [T, F] -> [1, F, T]
      const transposed = new Float32Array(numFrames * numBins);
      for (let t = 0; t < numFrames; t++) {
        for (let b = 0; b < numBins; b++) {
          transposed[b * numFrames + t] = data[t * numBins + b];
        }
      }
      feeds = {
        [spec.inputName]: new ort.Tensor('float32', transposed, [1, numBins, numFrames]),
        length: new ort.Tensor('int64', BigInt64Array.from([BigInt(numFrames)]), [1]),
      };
    } else {
      feeds = {
        [spec.inputName]: new ort.Tensor('float32', data, [1, numFrames, numBins]),
      };
    }

    const results = await session.run(feeds, [spec.outputName]);
    const t2 = performance.now();
    const raw = results[spec.outputName].data;
    const embedding = l2Normalize(raw);
    return {
      embedding,
      fbankMs: t1 - t0,
      inferMs: t2 - t1,
      totalMs: t2 - t0,
      numFrames,
    };
  }

  async embed(modelId, pcm) {
    const spec = MODEL_BY_ID[modelId];
    if (spec.kind === 'dsp') {
      const t0 = performance.now();
      const { embedding, numFrames } = extractMfccEmbedding(pcm);
      const dt = performance.now() - t0;
      return { embedding, fbankMs: dt, inferMs: 0, totalMs: dt, numFrames };
    }
    const ort = await getOrt();
    const { session } = await this.loadModel(modelId);
    return this._runSession(ort, spec, session, pcm);
  }

  /**
   * Build a robust voiceprint from enrollment PCM (16 kHz mono):
   * strips silence, embeds overlapping 2.5s windows, and averages normalized vectors.
   */
  async enroll(modelId, pcm) {
    const speech = extractActiveSpeech(pcm, 0.012);
    const usable = speech.length >= 16000 ? speech : pcm;
    const win = 40000;  // 2.5s
    const hop = 24000;  // 1.5s
    const chunks = [];
    if (usable.length <= win + 8000) {
      chunks.push(usable);
    } else {
      for (let pos = 0; pos + 20000 <= usable.length; pos += hop) {
        chunks.push(usable.subarray(pos, Math.min(pos + win, usable.length)));
      }
    }
    const embs = [];
    let totalMs = 0;
    for (const c of chunks) {
      const r = await this.embed(modelId, c);
      embs.push(r.embedding);
      totalMs += r.totalMs;
    }
    const dim = embs[0].length;
    const avg = new Float32Array(dim);
    for (const e of embs) {
      for (let i = 0; i < dim; i++) avg[i] += e[i];
    }
    return {
      voiceprint: l2Normalize(avg),
      segments: chunks.length,
      speechSec: usable.length / 16000,
      enrollMs: totalMs,
    };
  }

  async verify(modelId, pcm, voiceprint, threshold) {
    const spec = MODEL_BY_ID[modelId];
    const thr = threshold ?? spec.defaultThreshold;
    const res = await this.embed(modelId, pcm);
    const score = cosineSimilarity(res.embedding, voiceprint);
    return {
      score,
      match: score >= thr,
      threshold: thr,
      ...res,
    };
  }

  /**
   * Run full benchmark on 3-speaker dataset + latency sweep across 0.5s..3.0s windows.
   */
  async benchmarkModel(modelId, wavs, onStatus) {
    const loaded = await this.loadModel(modelId, onStatus);
    const spec = MODEL_BY_ID[modelId];

    // 1. Latency sweep on a real speech clip (median of 3 runs per duration)
    onStatus?.(`Sebességmérés: ${spec.shortName}...`);
    const samplePcm = wavs['leijun-test']; // 8.2s real speech
    const durations = [0.5, 1.0, 1.5, 2.0, 3.0];
    const latencies = {};
    for (const sec of durations) {
      const slice = samplePcm.subarray(0, Math.min(samplePcm.length, Math.floor(sec * 16000)));
      const runs = [];
      for (let r = 0; r < 3; r++) {
        const res = await this.embed(modelId, slice);
        runs.push(res.totalMs);
      }
      runs.sort((a, b) => a - b);
      latencies[sec] = runs[1]; // median
    }

    // 2. Accuracy on 3 speakers (enroll vs test, all 3 same + 6 diff pairs)
    onStatus?.(`Pontosság mérés (3 beszélő): ${spec.shortName}...`);
    const embs = {};
    for (const [k, pcm] of Object.entries(wavs)) {
      embs[k] = (await this.embed(modelId, pcm)).embedding;
    }

    const speakers = ['fangjun', 'leijun', 'liudehua'];
    const sameScores = [];
    const diffScores = [];
    for (const s1 of speakers) {
      for (const s2 of speakers) {
        const sc = cosineSimilarity(embs[`${s1}-enroll`], embs[`${s2}-test`]);
        if (s1 === s2) sameScores.push(sc);
        else diffScores.push(sc);
      }
    }

    // 3. Short-clip (1.2s) separation test (critical for near-realtime!)
    const sameShort = [];
    const diffShort = [];
    for (const s1 of speakers) {
      for (const s2 of speakers) {
        const testPcm = wavs[`${s2}-test`];
        const shortSlice = testPcm.subarray(0, Math.min(testPcm.length, 19200)); // 1.2s
        const eShort = (await this.embed(modelId, shortSlice)).embedding;
        const sc = cosineSimilarity(embs[`${s1}-enroll`], eShort);
        if (s1 === s2) sameShort.push(sc);
        else diffShort.push(sc);
      }
    }

    const minSame = Math.min(...sameScores);
    const avgSame = sameScores.reduce((a, b) => a + b, 0) / sameScores.length;
    const maxDiff = Math.max(...diffScores);
    const avgDiff = diffScores.reduce((a, b) => a + b, 0) / diffScores.length;
    const margin = minSame - maxDiff;
    const marginShort = Math.min(...sameShort) - Math.max(...diffShort);
    const suggestedThreshold = (minSame + maxDiff) / 2;

    return {
      modelId,
      loadMs: loaded.loadMs,
      actualEP: loaded.actualEP,
      latencies,
      rtf15: latencies[1.5] / 1500,
      minSame,
      avgSame,
      maxDiff,
      avgDiff,
      margin,
      marginShort,
      suggestedThreshold,
    };
  }
}
