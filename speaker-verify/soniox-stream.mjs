#!/usr/bin/env node
// Streams a 16 kHz mono WAV to Soniox realtime (EU) at real-time pace, like the app does; saves final tokens
// (text, start_ms, end_ms, speaker) + arrival time, so gate-eval.py can gate words by owner-voice score.
// Usage: SONIOX_API_KEY=… node soniox-stream.mjs in.wav out.json [--diarize] [--jarvis]
import { readFileSync, writeFileSync } from 'node:fs';
const [inWav, outJson] = process.argv.slice(2);
const diarize = process.argv.includes('--diarize');
const jarvis = process.argv.includes('--jarvis'); // JARVIS endpointing: level 0, sensitivity -0.5 (voiceAgentStore.ts)
const key = process.env.SONIOX_API_KEY; if (!key) throw new Error('SONIOX_API_KEY missing');
const wav = readFileSync(inWav); const pcm = wav.subarray(wav.indexOf('data') + 8);
const ws = new WebSocket('wss://stt-rt.eu.soniox.com/transcribe-websocket');
const tokens = []; const t0 = { v: 0 };
ws.onopen = async () => {
  ws.send(JSON.stringify({ api_key: key, model: 'stt-rt-v6', audio_format: 'pcm_s16le', sample_rate: 16000, num_channels: 1,
    language_hints: ['hu'], enable_endpoint_detection: true, enable_speaker_diarization: diarize,
    ...(jarvis ? { endpoint_latency_adjustment_level: 0, endpoint_sensitivity: -0.5 } : { endpoint_latency_adjustment_level: 2 }) }));
  t0.v = performance.now(); const chunk = 4096; // 128 ms, same frame size as the app
  for (let i = 0; i < pcm.length; i += chunk) {
    ws.send(pcm.subarray(i, i + chunk));
    const due = t0.v + ((i + chunk) / 2 / 16000) * 1000; await new Promise(r => setTimeout(r, Math.max(0, due - performance.now())));
  }
  ws.send('');
};
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.error_code) { console.error(m); process.exit(1); }
  const now = performance.now() - t0.v;
  for (const t of m.tokens || []) if (t.is_final) tokens.push({ ...t, arrival_ms: Math.round(now) });
  if (m.finished) { writeFileSync(outJson, JSON.stringify(tokens, null, 1)); console.log(`${tokens.length} final tokens → ${outJson}`); process.exit(0); } };
ws.onerror = (e) => { console.error('ws error', e.message); process.exit(1); };
