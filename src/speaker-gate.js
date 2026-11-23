// ── Speaker gate ("voice lock"): keep only the enrolled owner's words ─────────────────────────────
// All audio still streams to the STT as before (zero added latency); the gate judges each returned
// token by WHO said it and drops other voices' words. A convenience filter, NOT a security boundary:
// the other voices are still transcribed (and billed), and whoever controls the client can turn it off.
//
// Two signals, both local (the voiceprint never leaves the device), from CAM++ (3D-Speaker, 200k
// speakers, 192-dim, Apache-2.0) — the lab winner (speaker-verify/README.md: 9/9 HU utterances,
// ~30 ms per 1.5 s window on WASM):
//   • window score — cosine(voiceprint, embedding of the 1.5 s audio window), one every 0.5 s,
//     computed as audio arrives (causal: only the past). Smeared ~1 s at speaker changes.
//   • label score — Soniox diarization tags each token with an anonymous speaker label; every label
//     pools the audio of its FINAL tokens so far and is re-scored as it grows. Long pooled audio is
//     far more reliable than one window, but a label only exists after its first finals land.
// A token is kept if its label scores as the owner and its own window doesn't clearly say someone
// else (the veto catches diarization mislabels — measured: Soniox put an intruder's "Küldd el" on the
// owner's label). Before its label has a score, the window alone decides, at a laxer bar (short owner
// words scored 0.47–0.49 on single windows). Nothing to judge yet (model loading, no scored window —
// e.g. a quiet/distant voice under minRms — and no label score) → DROP (fail-closed). It used to pass
// finals, and with auto-send a stranger's sentence was sent before the owner said a word; losing an
// owner word at session start (re-say it) is the cheaper mistake.
// Timeline: the STT pushes exactly the samples it sends on the current socket (pushSent) and resets
// on a new socket, so token start_ms/end_ms index straight into this buffer.

import { computeFbank, l2Normalize, extractActiveSpeech } from './fbank.js';
import { opfsCachedFetch, loadOrt } from './assets.js';

const SR = 16000;
// Pinned revision: a re-uploaded model would silently change every score (and the thresholds).
export const SPEAKER_MODEL = {
  id: 'campplus-200k',
  url: 'https://huggingface.co/welcomyou/campplus-3dspeaker-200k-onnx/resolve/6265ff7af2a104d745b4389026ed9815c6c1c6ff/campplus_cn_en_common_200k.onnx',
  sizeMB: 28,
  fbank: { scale: 1.0, window: 'povey', numBins: 80, frameLenMs: 25, frameShiftMs: 10, lowFreq: 20, highFreq: 7600, cmvn: 'mean' },
};
export const SPEAKER_GATE_DEFAULTS = {
  threshold: 0.48,       // label score ≥ → owner (lab: owner 0.90, intruders ≤ 0.27; real use: owner 0.50–0.75)
  windowThreshold: 0.40, // window-only verdict before the label has a score
  strongWindow: 0.60,    // window ≥ → owner even under a low label (live owner windows 0.60–0.76, lab intruders ≤ 0.35)
  veto: 0.30,            // window below → not the owner even under the owner's label (tuned on ONE synthetic dialogue — re-measure)
  windowSec: 1.5, hopSec: 0.5,
  minRms: 0.01,          // quieter window = silence → no score
  labelMinSec: 2.0,      // pooled audio a label needs before it's scored (1 s scored the owner 0.30–0.43 live)
  poolPadMs: 60,         // widen each final token's span: Soniox stamps a token as a ~60 ms point, not its sound
  poolGapMs: 400,        // same-label tokens closer than this pool as ONE span (the speech between them too)
  labelMaxSec: 12,       // pool the latest N s per label (bounds the re-score cost)
  labelRescoreSec: 1.0,  // re-score a label after this much new audio
  bufferSec: 30,         // audio kept for label pooling (finals land ~3–5 s after the word)
  maxLogSec: 600,        // cap diagnostic capture per stream (~19 MB PCM) when onStreamLog is set
};

let sessionP = null;
/** Load (download once → OPFS cache) and build the model. `onProgress(loaded, total)` on a cache miss. */
export function loadSpeakerModel(onProgress) {
  return (sessionP ??= (async () => {
    const [ort, blob] = await Promise.all([loadOrt(), opfsCachedFetch(SPEAKER_MODEL.url, onProgress, 'speaker-gate')]);
    const session = await ort.InferenceSession.create(await blob.arrayBuffer(), { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
    let q = Promise.resolve();   // one session, one run at a time
    const embed = (pcm) => (q = q.catch(() => {}).then(async () => {
      const { data, numFrames, numBins } = computeFbank(pcm, SPEAKER_MODEL.fbank);
      const out = await session.run({ feats: new ort.Tensor('float32', data, [1, numFrames, numBins]) });
      return l2Normalize(out.embs.data);
    }));
    return { embed };
  })().catch((e) => { sessionP = null; throw e; }));   // a failed download must not poison the memo
}

const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

/** Voiceprint from an enrollment recording (16 kHz mono Float32, ~15 s of the owner reading):
 *  silence stripped, 2.5 s windows (1.5 s hop) embedded and averaged. Returns a plain number[]. */
export async function enrollSpeaker(pcm, { onProgress, model } = {}) {
  const { embed } = model ?? await loadSpeakerModel(onProgress);
  const speech = extractActiveSpeech(pcm, 0.012);
  if (speech.length < 4 * SR) throw new Error('Too little speech — read the whole text aloud, close to the mic.');
  const win = 2.5 * SR, hop = 1.5 * SR, sum = new Float32Array(192);
  let n = 0;
  for (let p = 0; p + win / 2 <= speech.length; p += hop) {
    const e = await embed(speech.subarray(p, Math.min(p + win, speech.length)));
    for (let i = 0; i < sum.length; i++) sum[i] += e[i];
    n++;
  }
  return { voiceprint: Array.from(l2Normalize(sum)), model: SPEAKER_MODEL.id, speechSec: speech.length / SR, segments: n };
}

export class SpeakerGate {
  /** `model` ({ embed(pcm) → unit vector }) overrides the CDN-loaded one — Node replays, tests.
   *  `onStreamLog(dump)` (optional, dev/diagnostics) receives the full stream PCM + per-token verdicts on stream end. */
  constructor({ voiceprint, onProgress, model, onStreamLog, ...opts }) {
    this.vp = Float32Array.from(voiceprint);
    this.o = { ...SPEAKER_GATE_DEFAULTS, ...opts };
    this._onStreamLog = onStreamLog || null;
    this._log = null;
    this._createdAt = Date.now();
    this._modelReadyMs = null;
    this._modelError = null;
    this.model = null;
    (model ? Promise.resolve(model) : loadSpeakerModel(onProgress)).then(
      (m) => { this.model = m; this._modelReadyMs = Date.now() - this._createdAt; this._pump(); },
      (e) => { this._modelError = String(e?.message || e); console.warn('speaker gate: model load failed — every word is dropped until a new session', e); },
    );
    this.resetStream();
  }

  /** New STT stream: its token times restart at 0, and its speaker labels are new people. */
  resetStream() {
    this.endStream('reset');
    this._gen = (this._gen || 0) + 1;
    const n = this.o.bufferSec * SR;
    this.buf = new Float32Array(n); this.total = 0;   // ring buffer; `total` = samples pushed this stream
    this.windows = [];        // { end (sample), score | null }
    this.nextEnd = this.o.windowSec * SR;
    this.labels = new Map();  // label → { segs: [[s, e]], sec, scoredSec, score }
    this._poolSpk = undefined; // label of the last pooled token (a span only grows while the same voice talks)
    this._busy = false; this.dropped = 0;
    this._log = this._onStreamLog ? { startedAt: Date.now(), pcmChunks: [], pcmSamples: 0, truncated: false, tokens: [], windows: [], labelScores: [], turns: [] } : null;
  }

  /** Flush the current stream's diagnostic capture (if `onStreamLog` is attached and anything arrived). */
  endStream(reason = 'close') {
    const log = this._log;
    if (!log) return;
    this._log = null;
    if (!log.tokens.length && !log.turns.length) return;
    const pcm = new Int16Array(log.pcmSamples);
    let off = 0;
    for (const c of log.pcmChunks) { pcm.set(c, off); off += c.length; }
    try {
      this._onStreamLog({
        pcm, sampleRate: SR, tokens: log.tokens, windows: log.windows, labelScores: log.labelScores, turns: log.turns,
        meta: {
          startedAt: log.startedAt, endedAt: Date.now(), endReason: reason,
          durationSec: +(this.total / SR).toFixed(2), truncated: log.truncated, dropped: this.dropped,
          modelReady: !!this.model, modelReadyMs: this._modelReadyMs, modelError: this._modelError,
          options: { ...this.o }, finalLabels: this.state.labels,
        },
      });
    } catch (e) { console.warn('speaker gate: onStreamLog failed', e); }
  }

  /** Record a turn boundary (`<end>` / `<fin>`) and what text survived gating. */
  logTurn(marker, emittedText, held = false) {
    if (this._log) this._log.turns.push({ marker, at_ms: Math.round(this.total * 1000 / SR), emittedText, held });
  }

  /** The exact samples the STT just sent on the current stream (Int16 or Float32). */
  pushSent(chunk) {
    const n = this.buf.length, isI16 = chunk instanceof Int16Array, f = isI16 ? 1 / 32768 : 1;
    for (let i = 0; i < chunk.length; i++) this.buf[(this.total + i) % n] = chunk[i] * f;
    this.total += chunk.length;
    if (this._log && !this._log.truncated) {
      const cap = this.o.maxLogSec * SR;
      if (this._log.pcmSamples + chunk.length <= cap) {
        let copy;
        if (isI16) copy = chunk.slice();
        else { copy = new Int16Array(chunk.length); for (let i = 0; i < chunk.length; i++) copy[i] = Math.max(-1, Math.min(1, chunk[i])) * 32767; }
        this._log.pcmChunks.push(copy);
        this._log.pcmSamples += copy.length;
      } else this._log.truncated = true;
    }
    this._pump();
  }

  _slice(s, e) {   // [s, e) in stream samples, clipped to what the ring still holds
    s = Math.max(s, this.total - this.buf.length, 0); e = Math.min(e, this.total);
    const out = new Float32Array(Math.max(0, e - s)), n = this.buf.length;
    for (let i = 0; i < out.length; i++) out[i] = this.buf[(s + i) % n];
    return out;
  }

  // Background scoring, one inference at a time: the newest due window first (a slow device skips
  // stale ones rather than falling behind), then any label whose pool grew enough.
  async _pump() {
    if (!this.model || this._busy) return;
    this._busy = true;
    const gen = this._gen, hop = this.o.hopSec * SR, win = this.o.windowSec * SR;
    try {
      while (gen === this._gen) {
        if (this.total >= this.nextEnd) {
          const end = this.nextEnd + Math.floor((this.total - this.nextEnd) / hop) * hop;   // skip to the newest due
          this.nextEnd = end + hop;
          const pcm = this._slice(end - win, end);
          let rms = 0; for (let i = 0; i < pcm.length; i++) rms += pcm[i] * pcm[i];
          const rmsVal = Math.sqrt(rms / pcm.length);
          const score = rmsVal < this.o.minRms ? null : dot(this.vp, await this.model.embed(pcm));
          if (gen !== this._gen) return;
          this.windows.push({ end, score });
          if (this._log && !this._log.truncated) this._log.windows.push({ end_ms: Math.round(end * 1000 / SR), rms: +rmsVal.toFixed(5), score: score == null ? null : +score.toFixed(4) });
          while (this.windows.length && this.windows[0].end < this.total - this.buf.length) this.windows.shift();
          continue;
        }
        let labKey = null, lab = null;
        for (const [k, l] of this.labels) if (l.sec >= this.o.labelMinSec && l.sec - l.scoredSec >= this.o.labelRescoreSec) { labKey = k; lab = l; break; }
        if (!lab) break;
        lab.scoredSec = lab.sec;
        const parts = []; let len = 0;
        for (let i = lab.segs.length - 1; i >= 0 && len < this.o.labelMaxSec * SR; i--) { const p = this._slice(...lab.segs[i]); parts.unshift(p); len += p.length; }
        const pcm = new Float32Array(len); let o = 0; for (const p of parts) { pcm.set(p, o); o += p.length; }
        if (len >= 0.5 * SR) {
          const score = dot(this.vp, await this.model.embed(pcm));
          if (gen === this._gen) {
            lab.score = score;
            if (this._log && !this._log.truncated) this._log.labelScores.push({ at_ms: Math.round(this.total * 1000 / SR), speaker: labKey, sec: +lab.sec.toFixed(2), score: +score.toFixed(4) });
          }
        }
      }
    } catch (e) { console.warn('speaker gate: scoring failed', e); }
    finally { if (gen === this._gen) this._busy = false; }   // a stale pump must not unlock the new stream's
  }

  /** Mean score of the windows covering sample `m`; undefined when none is scored yet. */
  windowScore(m) {
    let sum = 0, n = 0;
    for (const w of this.windows) if (w.score != null && w.end - this.o.windowSec * SR <= m && m <= w.end) { sum += w.score; n++; }
    return n ? sum / n : undefined;
  }

  /** Decide one STT token: { text, start_ms, end_ms, speaker, is_final } → keep it? `prev` is the
   *  verdict of the token right before it in the TEXT it joins ({ speaker, keep } — the caller keeps
   *  one cursor for finals and a throwaway one per partial tail): a sub-word piece (no leading space)
   *  of the same speaker follows its word's verdict, so a word is never half-dropped. A FINAL token
   *  also feeds its audio to its speaker label's pool. */
  admit(t, prev) {
    const cont = !!(prev && !/^\s/.test(t.text) && prev.speaker === t.speaker);
    if (t.is_final) this._pool(t);
    const d = cont ? { keep: prev.keep, reason: 'cont', w: null, lab: null, labSec: 0 } : this._judgeDetail(t, prev);
    if (!d.keep && t.is_final) this.dropped++;
    if (this._log && !this._log.truncated && this._log.tokens.length < 20000) {
      this._log.tokens.push({
        text: t.text, start_ms: t.start_ms ?? null, end_ms: t.end_ms ?? null,
        speaker: t.speaker ?? null, is_final: !!t.is_final,
        arrival_ms: Math.round(this.total * 1000 / SR),
        keep: d.keep, reason: d.reason,
        w: d.w == null ? null : +d.w.toFixed(4),
        lab: d.lab == null ? null : +d.lab.toFixed(4),
        labSec: +d.labSec.toFixed(2), ready: !!this.model,
      });
    }
    return d.keep;
  }

  // Soniox token times are ~60 ms stamps, not the word's sound: pooling them raw fed the model
  // 60 ms crumbs (live: the owner's own label scored 0.30–0.43 and every later word was dropped).
  // Pad each stamp and bridge short same-label gaps so the pool holds the actual continuous speech.
  _pool(t) {
    if (t.start_ms == null || t.end_ms == null) return;
    const lab = this._label(t.speaker), pad = this.o.poolPadMs * SR / 1000;
    const s = Math.max(0, Math.round(t.start_ms * SR / 1000 - pad)), e = Math.min(this.total, Math.round(t.end_ms * SR / 1000 + pad));
    if (!lab || e <= s) return;
    const last = lab.segs.at(-1);
    if (last && this._poolSpk === t.speaker && s <= last[1] + this.o.poolGapMs * SR / 1000) {
      if (e > last[1]) { lab.sec += (e - last[1]) / SR; last[1] = e; }
    } else { lab.segs.push([s, e]); lab.sec += (e - s) / SR; }
    this._poolSpk = t.speaker;
    // Keep only what the ring still holds, and at most the pool budget — a long session must not
    // grow per-label history (or the re-score walk) without bound.
    const oldest = this.total - this.buf.length; let kept = 0;
    for (let i = lab.segs.length - 1; i >= 0; i--) {
      kept += lab.segs[i][1] - lab.segs[i][0];
      if (lab.segs[i][1] <= oldest || kept > this.o.labelMaxSec * SR * 1.5) { lab.segs.splice(0, i + (lab.segs[i][1] <= oldest ? 1 : 0)); break; }
    }
    this._pump();
  }
  _label(k) {
    if (k == null) return null;
    let l = this.labels.get(k);
    if (!l) this.labels.set(k, l = { segs: [], sec: 0, scoredSec: 0, score: undefined });
    return l;
  }

  // Never worse than no lock for the owner: a word is dropped only on EVIDENCE of another voice.
  // Uncertain (no window score — trailing silence, quiet tail — or a window between veto and the
  // window bar) → the word follows the previous kept word of the same label: the end of the
  // owner's sentence is not cut (live: "…keletre volt." lost "volt." at 0.39). A strong window
  // overrides a low label (live: label 0.44 while every window said 0.70+ → a whole sentence lost).
  // Fail-closed stays only where nothing was accepted yet (the stranger-before-owner bug).
  _judgeDetail(t, prev) {
    if (t.start_ms == null || t.end_ms == null) return { keep: true, reason: 'no_ts', w: null, lab: null, labSec: 0 };
    const lab = this._label(t.speaker), w = this.windowScore((t.start_ms + t.end_ms) * SR / 2000), o = this.o, labSec = lab?.sec ?? 0;
    const r = (keep, reason) => ({ keep, reason, w, lab: lab?.score ?? null, labSec });
    if (w != null && w < o.veto) return r(false, lab?.score != null ? 'label_veto' : 'win_low');   // clearly someone else
    if (lab?.score != null) {
      if (lab.score >= o.threshold) return r(true, 'label_ok');
      return w != null && w >= o.strongWindow ? r(true, 'win_strong') : r(false, 'label_low');
    }
    if (w != null && w >= o.windowThreshold) return r(true, 'win_ok');
    const follow = !!(prev?.keep && prev.speaker === t.speaker);
    return r(follow, follow ? 'follow' : w != null ? 'win_low' : this.model ? 'no_score' : 'no_model');
  }

  /** Debug/UI snapshot: per-label scores + the latest window. */
  get state() {
    const last = this.windows.at(-1);
    return { ready: !!this.model, window: last?.score, dropped: this.dropped, labels: Object.fromEntries([...this.labels].map(([k, l]) => [k, { sec: +l.sec.toFixed(1), score: l.score }])) };
  }
}
