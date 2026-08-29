// bench/blackbox/energy.js — shared RMS-energy speech detection for the black-box rig.
// One implementation used by the offline analyzer (segments) AND the online driver (Gate),
// so both see the same speech boundaries.

export const RATE = 16000;              // s16le mono
export const FRAME_MS = 20;
export const FRAME_SAMPLES = (RATE * FRAME_MS) / 1000;

// RMS of one s16 frame (0..32767 scale).
export function frameRms(buf, offset, samples) {
  let sum = 0, n = 0;
  for (let i = 0; i < samples; i++) {
    const o = offset + i * 2;
    if (o + 1 >= buf.length) break;
    const v = buf.readInt16LE(o); sum += v * v; n++;
  }
  return n ? Math.sqrt(sum / n) : 0;
}

// Defaults: onset needs a clearly-audible level for 2 frames (40ms); offset after `hangMs` below the
// lower threshold (hysteresis so breaths/reverb tails don't chop segments).
export const DEFAULTS = { on: 500, off: 250, onFrames: 2, hangMs: 250 };

// Offline: raw s16le PCM buffer → [{ startMs, endMs }] speech segments. Gaps shorter than hangMs
// are absorbed (one segment); longer gaps split — matching metrics.js's clip/stall model.
export function segments(pcm, opts = {}) {
  const { on, off, onFrames, hangMs } = { ...DEFAULTS, ...opts };
  const out = [];
  let inSeg = false, run = 0, segStart = 0, lastLoud = 0;
  const frames = Math.floor(pcm.length / 2 / FRAME_SAMPLES);
  for (let f = 0; f < frames; f++) {
    const t = f * FRAME_MS;
    const rms = frameRms(pcm, f * FRAME_SAMPLES * 2, FRAME_SAMPLES);
    if (!inSeg) {
      run = rms >= on ? run + 1 : 0;
      if (run >= onFrames) { inSeg = true; segStart = t - (onFrames - 1) * FRAME_MS; lastLoud = t; }
    } else {
      if (rms >= off) lastLoud = t;
      else if (t - lastLoud >= hangMs) { out.push({ startMs: segStart, endMs: lastLoud + FRAME_MS }); inSeg = false; run = 0; }
    }
  }
  if (inSeg) out.push({ startMs: segStart, endMs: frames * FRAME_MS });
  return out;
}

// Online: feed s16le chunks as they arrive; fires onSpeech(tMs)/onSilence(tMs) with the STREAM
// time (bytes-derived, not wall clock — the caller anchors it). Same thresholds as segments().
export class Gate {
  constructor({ onSpeech = () => {}, onSilence = () => {}, ...opts } = {}) {
    Object.assign(this, { ...DEFAULTS, ...opts, onSpeech, onSilence });
    this._carry = Buffer.alloc(0); this._frames = 0; this._in = false; this._run = 0; this._lastLoud = 0;
    this.speaking = false;
  }
  feed(chunk) {
    let buf = this._carry.length ? Buffer.concat([this._carry, chunk]) : chunk;
    const frameBytes = FRAME_SAMPLES * 2;
    let o = 0;
    for (; o + frameBytes <= buf.length; o += frameBytes) {
      const t = this._frames++ * FRAME_MS;
      const rms = frameRms(buf, o, FRAME_SAMPLES);
      if (!this._in) {
        this._run = rms >= this.on ? this._run + 1 : 0;
        if (this._run >= this.onFrames) { this._in = this.speaking = true; this._lastLoud = t; this.onSpeech(t - (this.onFrames - 1) * FRAME_MS); }
      } else {
        if (rms >= this.off) this._lastLoud = t;
        else if (t - this._lastLoud >= this.hangMs) { this._in = this.speaking = false; this._run = 0; this.onSilence(this._lastLoud + FRAME_MS); }
      }
    }
    this._carry = buf.subarray(o);
  }
  get streamMs() { return this._frames * FRAME_MS; }
}
