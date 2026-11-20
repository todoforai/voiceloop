// app.js — UI controller for the Speaker Verification Web Prototype.

import { MODELS, MODEL_BY_ID, BENCH_WAVS } from './models.js';
import { SpeakerVerifier } from './verifier.js';
import { decodeWav16k, rmsEnergy } from './fbank.js';

const verifier = new SpeakerVerifier();
const selectedModels = new Set(MODELS.filter((m) => m.defaultSelected).map((m) => m.id));
const thresholds = Object.fromEntries(MODELS.map((m) => [m.id, m.defaultThreshold]));
const voiceprints = new Map(); // modelId -> { voiceprint, segments, speechSec }
const benchResults = new Map(); // modelId -> result
const testClips = []; // { label, pcm, durationSec }

// DOM refs
const $ = (id) => document.getElementById(id);
const modelGrid = $('model-grid');
const backendSelect = $('backend-select');
const benchStatus = $('bench-status');
const benchTbody = $('bench-tbody');
const winnerBox = $('winner-box');
const liveStatus = $('live-status');
const liveCards = $('live-cards');
const vuFill = $('vu-fill');
const micInfo = $('mic-info');
const timelineCanvas = $('timeline');
const timelineCtx = timelineCanvas.getContext('2d');

// ── Capabilities badges ─────────────────────────────────────────────────────
const hasCOI = typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated;
const hasGPU = typeof navigator !== 'undefined' && !!navigator.gpu;
$('badge-coi').textContent = `SharedArrayBuffer: ${hasCOI ? 'AKTÍV (multi-thread)' : 'inaktív (1 szál)'}`;
$('badge-coi').classList.add(hasCOI ? 'ok' : 'warn');
$('badge-cores').textContent = `CPU szálak: ${navigator.hardwareConcurrency || '?'}`;
$('badge-gpu').textContent = `WebGPU: ${hasGPU ? 'elérhető' : 'nem elérhető'}`;
$('badge-gpu').classList.add(hasGPU ? 'ok' : 'warn');
backendSelect.value = verifier.backend;

backendSelect.addEventListener('change', async () => {
  await verifier.setBackend(backendSelect.value);
  benchStatus.textContent = `Futtatási motor váltva: ${backendSelect.value}. Futtasd újra a benchmarkot az összehasonlításhoz.`;
});

// ── Model selector ──────────────────────────────────────────────────────────
function renderModelGrid() {
  modelGrid.innerHTML = '';
  for (const m of MODELS) {
    const label = document.createElement('label');
    label.className = `model-item ${selectedModels.has(m.id) ? 'selected' : ''}`;
    label.innerHTML = `
      <input type="checkbox" ${selectedModels.has(m.id) ? 'checked' : ''} data-id="${m.id}" />
      <span class="dot" style="background:${m.color}"></span>
      <div>
        <div class="model-name">${m.name}</div>
        <div class="model-meta">${m.arch} · ${m.sizeMB === 0 ? '0 MB' : m.sizeMB + ' MB'} · ${m.embDim}-dim</div>
        <div class="model-meta">${m.note}</div>
      </div>
    `;
    const cb = label.querySelector('input');
    cb.addEventListener('change', () => {
      if (cb.checked) selectedModels.add(m.id);
      else selectedModels.delete(m.id);
      label.classList.toggle('selected', cb.checked);
    });
    modelGrid.appendChild(label);
  }
}
renderModelGrid();

$('btn-select-fast').addEventListener('click', () => {
  selectedModels.clear();
  for (const m of MODELS) if (m.defaultSelected) selectedModels.add(m.id);
  renderModelGrid();
});
$('btn-select-all').addEventListener('click', () => {
  for (const m of MODELS) selectedModels.add(m.id);
  renderModelGrid();
});

// ── Automated 3-speaker + latency benchmark ─────────────────────────────────
let cachedWavs = null;
async function loadBenchWavs() {
  if (cachedWavs) return cachedWavs;
  const out = {};
  for (const w of BENCH_WAVS) {
    const resp = await fetch(`/wavs/${w.file}`);
    if (!resp.ok) throw new Error(`WAV betöltési hiba: ${w.file}`);
    out[w.key] = decodeWav16k(await resp.arrayBuffer());
  }
  cachedWavs = out;
  return out;
}

function marginPill(v) {
  const cls = v >= 0.30 ? 'good' : v >= 0.15 ? 'mid' : 'bad';
  return `<span class="pill ${cls}">${v >= 0 ? '+' : ''}${v.toFixed(3)}</span>`;
}
function msCell(v) {
  const cls = v <= 80 ? 'good' : v <= 200 ? 'mid' : 'bad';
  return `<span class="pill ${cls}">${v.toFixed(0)} ms</span>`;
}

function renderBenchTable() {
  const rows = [...benchResults.values()];
  if (rows.length === 0) return;
  benchTbody.innerHTML = '';
  for (const r of rows) {
    const m = MODEL_BY_ID[r.modelId];
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><span class="dot" style="display:inline-block;margin-right:6px;background:${m.color}"></span><strong>${m.shortName}</strong></td>
      <td class="small">${r.actualEP}</td>
      <td class="num">${m.sizeMB === 0 ? '0 MB' : m.sizeMB.toFixed(1) + ' MB'}</td>
      <td class="num">${r.loadMs.toFixed(0)} ms</td>
      <td class="num">${r.latencies[0.5].toFixed(0)} ms</td>
      <td class="num">${r.latencies[1.0].toFixed(0)} ms</td>
      <td class="num">${msCell(r.latencies[1.5])}</td>
      <td class="num">${r.latencies[2.0].toFixed(0)} ms</td>
      <td class="num">${r.latencies[3.0].toFixed(0)} ms</td>
      <td class="num">${r.rtf15.toFixed(3)}x</td>
      <td class="num">${r.minSame.toFixed(2)} / ${r.avgSame.toFixed(2)}</td>
      <td class="num">${r.maxDiff.toFixed(2)} / ${r.avgDiff.toFixed(2)}</td>
      <td class="num">${marginPill(r.margin)}</td>
      <td class="num">${marginPill(r.marginShort)}</td>
      <td class="num">${r.suggestedThreshold.toFixed(2)}</td>
    `;
    benchTbody.appendChild(tr);
  }

  // Pick neural winner: best balance of margin and 1.5s latency
  const neural = rows.filter((r) => MODEL_BY_ID[r.modelId].kind === 'onnx');
  if (neural.length > 0) {
    const bestMargin = [...neural].sort((a, b) => b.margin - a.margin)[0];
    const fastest = [...neural].sort((a, b) => a.latencies[1.5] - b.latencies[1.5])[0];
    const bm = MODEL_BY_ID[bestMargin.modelId];
    const fm = MODEL_BY_ID[fastest.modelId];
    winnerBox.style.display = 'block';
    winnerBox.innerHTML = `
      <strong>Összegzés (${backendSelect.value}):</strong>
      Legjobb elválasztás: <strong>${bm.shortName}</strong> (margó ${bestMargin.margin >= 0 ? '+' : ''}${bestMargin.margin.toFixed(3)}, 1.5s hang = ${bestMargin.latencies[1.5].toFixed(0)} ms).
      Leggyorsabb neurális modell: <strong>${fm.shortName}</strong> (${fastest.latencies[1.5].toFixed(0)} ms / 1.5s, RTF ${fastest.rtf15.toFixed(3)}x).
      ${fastest.latencies[1.5] < 150 ? '→ Kényelmesen near-realtime (500 ms frissítéssel is bőven belefér).' : '→ Közepes terhelésű, 1.0–1.5 mp ablakkal vagy megszólalás végén futtatva ajánlott.'}
    `;
  }
}

$('btn-run-bench').addEventListener('click', async () => {
  const ids = [...selectedModels];
  if (ids.length === 0) {
    benchStatus.textContent = 'Jelölj ki legalább egy modellt!';
    return;
  }
  $('btn-run-bench').disabled = true;
  benchResults.clear();
  benchTbody.innerHTML = '';
  winnerBox.style.display = 'none';
  try {
    benchStatus.textContent = '3 beszélős teszt WAV fájlok betöltése...';
    const wavs = await loadBenchWavs();
    const failed = [];
    for (const id of ids) {
      try {
        const res = await verifier.benchmarkModel(id, wavs, (msg) => { benchStatus.textContent = msg; });
        benchResults.set(id, res);
        renderBenchTable();
      } catch (err) {
        console.error(id, err);
        failed.push(`${MODEL_BY_ID[id].shortName}: ${err.message || err}`);
      }
    }
    benchStatus.textContent = `Kész! ${benchResults.size}/${ids.length} megoldás lemérve (${backendSelect.value}).`
      + (failed.length ? ` Hibák: ${failed.join(' | ')}` : '');
  } catch (err) {
    console.error(err);
    benchStatus.textContent = `Hiba: ${err.message || err}`;
  } finally {
    $('btn-run-bench').disabled = false;
  }
});

// ── Audio capture (16 kHz mono via AudioWorklet with linear resampler) ──────
const WORKLET_SRC = `
class Resample16kProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.pos = 0;
    this.buf = [];
  }
  process(inputs) {
    const ch = inputs[0]?.[0];
    if (!ch || ch.length === 0) return true;
    const out = [];
    while (this.pos < ch.length) {
      const i = Math.floor(this.pos);
      const frac = this.pos - i;
      const a = ch[i];
      const b = i + 1 < ch.length ? ch[i + 1] : a;
      out.push(a + (b - a) * frac);
      this.pos += this.ratio;
    }
    this.pos -= ch.length;
    if (out.length > 0) this.port.postMessage(new Float32Array(out));
    return true;
  }
}
registerProcessor('resample-16k', Resample16kProcessor);
`;

class MicCapture {
  constructor() {
    this.ctx = null;
    this.stream = null;
    this.node = null;
    this.onChunk = null;
  }
  async start(onChunk) {
    this.onChunk = onChunk;
    if (this.ctx) return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: false },
    });
    this.ctx = new AudioContext();
    const blob = new Blob([WORKLET_SRC], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    await this.ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, 'resample-16k');
    this.node.port.onmessage = (e) => {
      const pcm = e.data;
      const rms = rmsEnergy(pcm);
      vuFill.style.width = `${Math.min(100, rms * 550)}%`;
      this.onChunk?.(pcm, rms);
    };
    src.connect(this.node);
    // Keep node alive without outputting to speakers
    const mute = this.ctx.createGain();
    mute.gain.value = 0;
    this.node.connect(mute);
    mute.connect(this.ctx.destination);
  }
  stop() {
    this.onChunk = null;
    vuFill.style.width = '0%';
    try { this.node?.disconnect(); } catch {}
    try { this.stream?.getTracks().forEach((t) => t.stop()); } catch {}
    try { this.ctx?.close(); } catch {}
    this.ctx = null; this.stream = null; this.node = null;
  }
}

const mic = new MicCapture();

function concatFloat32(chunks) {
  let len = 0;
  for (const c of chunks) len += c.length;
  const out = new Float32Array(len);
  let pos = 0;
  for (const c of chunks) { out.set(c, pos); pos += c.length; }
  return out;
}

// ── 1. Enrollment ───────────────────────────────────────────────────────────
let enrolling = false;
let enrollChunks = [];
let enrollSpeechSamples = 0;

$('btn-enroll').addEventListener('click', async () => {
  if (!enrolling) {
    if (liveRunning) stopLive();
    const ids = [...selectedModels];
    if (ids.length === 0) {
      liveStatus.textContent = 'Jelölj ki legalább egy modellt felül!';
      return;
    }
    enrollChunks = [];
    enrollSpeechSamples = 0;
    enrolling = true;
    $('btn-enroll').textContent = 'Felvétel leállítása és betanítás';
    $('btn-enroll').className = 'danger';
    liveStatus.textContent = 'Beszélj folyamatosan 6–12 másodpercet a mikrofonba...';
    try {
      await mic.start((pcm, rms) => {
        enrollChunks.push(pcm);
        if (rms >= 0.012) enrollSpeechSamples += pcm.length;
        const tot = enrollChunks.reduce((s, c) => s + c.length, 0) / 16000;
        const sp = enrollSpeechSamples / 16000;
        micInfo.textContent = `Felvétel: ${tot.toFixed(1)} mp (aktív beszéd: ${sp.toFixed(1)} mp)`;
      });
    } catch (err) {
      enrolling = false;
      $('btn-enroll').textContent = '1. Hangminta felvétele (beszélj 6–12 mp-et)';
      $('btn-enroll').className = 'primary';
      liveStatus.textContent = `Mikrofon hiba: ${err.message}`;
    }
  } else {
    enrolling = false;
    mic.stop();
    $('btn-enroll').disabled = true;
    $('btn-enroll').textContent = 'Hanglenyomat számítása...';
    $('btn-enroll').className = 'primary';

    const pcm = concatFloat32(enrollChunks);
    const ids = [...selectedModels];
    voiceprints.clear();
    try {
      for (const id of ids) {
        const m = MODEL_BY_ID[id];
        liveStatus.textContent = `Hanglenyomat készítése: ${m.shortName}...`;
        await verifier.loadModel(id, (msg) => { liveStatus.textContent = msg; });
        const res = await verifier.enroll(id, pcm);
        voiceprints.set(id, res);
      }
      const first = voiceprints.values().next().value;
      micInfo.textContent = `Betanítva: ${voiceprints.size} modell (${first.speechSec.toFixed(1)} mp beszéd, ${first.segments} szegmens)`;
      liveStatus.textContent = 'Hanglenyomat kész (csak a böngésző memóriájában)! Indíthatod az élő figyelést vagy vehetsz fel tesztklipeket.';
      $('btn-live').disabled = false;
      $('btn-clear-enroll').disabled = false;
      $('btn-rec-clip').disabled = false;
      renderLiveCards();
      renderClipTable();
    } catch (err) {
      console.error(err);
      liveStatus.textContent = `Betanítási hiba: ${err.message || err}`;
    } finally {
      $('btn-enroll').disabled = false;
      $('btn-enroll').textContent = '1. Hangminta újrafelvétele';
    }
  }
});

$('btn-clear-enroll').addEventListener('click', () => {
  if (liveRunning) stopLive();
  voiceprints.clear();
  testClips.length = 0;
  liveCards.innerHTML = '';
  micInfo.textContent = 'Nincs betanított hangminta';
  $('btn-live').disabled = true;
  $('btn-clear-enroll').disabled = true;
  $('btn-rec-clip').disabled = true;
  renderClipTable();
  liveStatus.textContent = 'Hanglenyomat törölve.';
});

// ── 2. Live near-realtime verification ──────────────────────────────────────
let liveRunning = false;
let liveTimer = null;
let liveBusy = false;
const RING_LEN = 16000 * 3; // 3s ring buffer
const ring = new Float32Array(RING_LEN);
let ringPos = 0;
let ringFilled = 0;
const latencyHistory = new Map(); // modelId -> number[]
const timelineHistory = []; // { t, scores: { [modelId]: number | null } }

function pushRing(pcm) {
  for (let i = 0; i < pcm.length; i++) {
    ring[ringPos] = pcm[i];
    ringPos = (ringPos + 1) % RING_LEN;
  }
  ringFilled = Math.min(RING_LEN, ringFilled + pcm.length);
}

function readRing(samples) {
  const n = Math.min(samples, ringFilled);
  const out = new Float32Array(n);
  let start = (ringPos - n + RING_LEN) % RING_LEN;
  for (let i = 0; i < n; i++) {
    out[i] = ring[(start + i) % RING_LEN];
  }
  return out;
}

function renderLiveCards() {
  liveCards.innerHTML = '';
  for (const id of voiceprints.keys()) {
    const m = MODEL_BY_ID[id];
    const thr = thresholds[id];
    const div = document.createElement('div');
    div.className = 'live-card';
    div.id = `live-card-${id}`;
    div.innerHTML = `
      <div class="live-top">
        <strong><span class="dot" style="display:inline-block;margin-right:6px;background:${m.color}"></span>${m.shortName}</strong>
        <span id="live-pill-${id}" class="pill idle">VÁRAKOZÁS</span>
      </div>
      <div id="live-score-${id}" class="score-big">—</div>
      <div class="meter">
        <div id="live-bar-${id}" class="meter-fill" style="background:${m.color}"></div>
        <div id="live-thr-mark-${id}" class="meter-thr" style="left:${thr * 100}%"></div>
      </div>
      <div id="live-lat-${id}" class="small" style="margin-bottom:8px;">Inferencia: — ms</div>
      <div class="thr-row">
        <span>Küszöb:</span>
        <input type="range" min="0.20" max="0.95" step="0.01" value="${thr.toFixed(2)}" data-thr="${id}" />
        <strong id="live-thr-val-${id}">${thr.toFixed(2)}</strong>
      </div>
    `;
    const slider = div.querySelector('input[type="range"]');
    slider.addEventListener('input', () => {
      const v = parseFloat(slider.value);
      thresholds[id] = v;
      $(`live-thr-val-${id}`).textContent = v.toFixed(2);
      $(`live-thr-mark-${id}`).style.left = `${v * 100}%`;
    });
    liveCards.appendChild(div);
  }
}

function p95(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))];
}

function drawTimeline() {
  const ctx = timelineCtx;
  const W = timelineCanvas.width, H = timelineCanvas.height;
  ctx.clearRect(0, 0, W, H);

  const now = performance.now();
  const span = 15000; // 15s window

  // Horizontal grid lines (0.2, 0.4, 0.6, 0.8)
  ctx.strokeStyle = '#e2e8f0';
  ctx.lineWidth = 1;
  ctx.font = '11px sans-serif';
  ctx.fillStyle = '#94a3b8';
  for (const g of [0.2, 0.4, 0.6, 0.8]) {
    const y = H - g * H;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    ctx.fillText(g.toFixed(1), 6, y - 3);
  }

  // Threshold dashed line for first enrolled model
  const firstId = voiceprints.keys().next().value;
  if (firstId) {
    const yThr = H - thresholds[firstId] * H;
    ctx.save();
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = '#0f172a';
    ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(0, yThr); ctx.lineTo(W, yThr); ctx.stroke();
    ctx.restore();
  }

  // Plot each model's curve
  for (const id of voiceprints.keys()) {
    const m = MODEL_BY_ID[id];
    ctx.strokeStyle = m.color;
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    let started = false;
    for (const pt of timelineHistory) {
      const age = now - pt.t;
      if (age > span) continue;
      const sc = pt.scores[id];
      if (sc == null) { started = false; continue; }
      const x = W - (age / span) * W;
      const y = H - Math.max(0, Math.min(1, sc)) * H;
      if (!started) { ctx.moveTo(x, y); started = true; }
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
}

async function liveTick() {
  if (!liveRunning || liveBusy) return;
  const winSec = parseFloat($('live-window').value);
  const rmsThr = parseFloat($('live-rms').value);
  const samples = Math.floor(winSec * 16000);
  if (ringFilled < Math.min(samples, 12800)) return; // wait at least 0.8s

  const slice = readRing(samples);
  const rms = rmsEnergy(slice);

  if (rms < rmsThr) {
    for (const id of voiceprints.keys()) {
      const card = $(`live-card-${id}`);
      card.className = 'live-card';
      $(`live-pill-${id}`).className = 'pill idle';
      $(`live-pill-${id}`).textContent = 'CSEND';
    }
    timelineHistory.push({ t: performance.now(), scores: {} });
    while (timelineHistory.length > 150) timelineHistory.shift();
    drawTimeline();
    return;
  }

  liveBusy = true;
  const scoresNow = {};
  try {
    for (const [id, vp] of voiceprints.entries()) {
      const res = await verifier.verify(id, slice, vp.voiceprint, thresholds[id]);
      scoresNow[id] = res.score;
      const hist = latencyHistory.get(id) || [];
      hist.push(res.totalMs);
      if (hist.length > 30) hist.shift();
      latencyHistory.set(id, hist);
      const avg = hist.reduce((a, b) => a + b, 0) / hist.length;

      const card = $(`live-card-${id}`);
      card.className = `live-card ${res.match ? 'match' : 'reject'}`;
      const pill = $(`live-pill-${id}`);
      pill.className = `pill ${res.match ? 'good' : 'bad'}`;
      pill.textContent = res.match ? 'TE BESZÉLSZ ✓' : 'IDEGEN HANG ✗';
      $(`live-score-${id}`).textContent = res.score.toFixed(3);
      $(`live-bar-${id}`).style.width = `${Math.max(0, Math.min(100, res.score * 100))}%`;
      $(`live-lat-${id}`).textContent = `Inferencia: ${res.totalMs.toFixed(0)} ms (átl ${avg.toFixed(0)} ms · p95 ${p95(hist).toFixed(0)} ms · fbank ${res.fbankMs.toFixed(0)} ms)`;
    }
    timelineHistory.push({ t: performance.now(), scores: scoresNow });
    while (timelineHistory.length > 150) timelineHistory.shift();
    drawTimeline();
  } catch (err) {
    console.error(err);
    liveStatus.textContent = `Élő hiba: ${err.message}`;
  } finally {
    liveBusy = false;
  }
}

async function startLive() {
  ringPos = 0; ringFilled = 0;
  latencyHistory.clear();
  timelineHistory.length = 0;
  liveRunning = true;
  $('btn-live').textContent = 'Élő figyelés leállítása';
  $('btn-live').className = 'danger';
  liveStatus.textContent = 'Élő figyelés fut! Beszélj, majd teszteld más hanggal vagy háttérvideóval.';
  await mic.start((pcm) => pushRing(pcm));
  const hopMs = parseInt($('live-hop').value, 10);
  liveTimer = setInterval(liveTick, hopMs);
}

function stopLive() {
  liveRunning = false;
  clearInterval(liveTimer);
  liveTimer = null;
  mic.stop();
  $('btn-live').textContent = '2. Élő figyelés indítása';
  $('btn-live').className = 'success';
  liveStatus.textContent = 'Élő figyelés leállítva.';
}

$('btn-live').addEventListener('click', () => {
  if (liveRunning) stopLive();
  else startLive();
});

$('live-hop').addEventListener('change', () => {
  if (liveRunning) {
    clearInterval(liveTimer);
    liveTimer = setInterval(liveTick, parseInt($('live-hop').value, 10));
  }
});

// ── 3. Recorded Clip Comparison Matrix ──────────────────────────────────────
function renderClipTable() {
  const ids = [...voiceprints.keys()];
  const thead = $('clip-thead');
  const tbody = $('clip-tbody');
  if (ids.length === 0) {
    thead.innerHTML = '<tr><th>Tesztklip</th><th>Hossz</th><th class="small">Vedd fel előbb a hangmintát, majd rögzíts tesztklipeket.</th></tr>';
    tbody.innerHTML = '';
    return;
  }
  thead.innerHTML = `<tr>
    <th>Tesztklip</th>
    <th class="num">Hossz</th>
    ${ids.map((id) => `<th class="num">${MODEL_BY_ID[id].shortName}</th>`).join('')}
  </tr>`;

  tbody.innerHTML = '';
  for (const clip of testClips) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>${clip.label}</strong></td>
      <td class="num">${clip.durationSec.toFixed(1)}s</td>
      ${ids.map((id) => {
        const r = clip.results[id];
        if (!r) return '<td class="num">—</td>';
        return `<td class="num"><span class="pill ${r.match ? 'good' : 'bad'}">${r.score.toFixed(3)} ${r.match ? '✓' : '✗'}</span> <span class="small">${r.totalMs.toFixed(0)}ms</span></td>`;
      }).join('')}
    `;
    tbody.appendChild(tr);
  }
}

$('btn-rec-clip').addEventListener('click', async () => {
  if (liveRunning) stopLive();
  const label = $('clip-label').value.trim() || `Klip #${testClips.length + 1}`;
  $('btn-rec-clip').disabled = true;
  $('btn-rec-clip').textContent = 'Felvétel (3 mp)...';
  const chunks = [];
  try {
    await mic.start((pcm) => chunks.push(pcm));
    await new Promise((r) => setTimeout(r, 3000));
    mic.stop();
    const pcm = concatFloat32(chunks);
    const results = {};
    for (const [id, vp] of voiceprints.entries()) {
      results[id] = await verifier.verify(id, pcm, vp.voiceprint, thresholds[id]);
    }
    testClips.push({ label, pcm, durationSec: pcm.length / 16000, results });
    renderClipTable();
    // Suggest next label
    const suggestions = ['Saját hang (halkan)', 'Idegen hang / YouTube', 'Saját hang (távolabbról)', 'Háttérzaj / TV'];
    $('clip-label').value = suggestions[testClips.length % suggestions.length];
  } catch (err) {
    liveStatus.textContent = `Klip felvételi hiba: ${err.message}`;
  } finally {
    $('btn-rec-clip').disabled = false;
    $('btn-rec-clip').textContent = 'Tesztklip felvétele (3 mp)';
  }
});
