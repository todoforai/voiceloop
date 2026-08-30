#!/usr/bin/env node
// bench/blackbox/gen-audio.js — pre-generate the "person" utterances for a scenario as raw
// s16le/16k/mono PCM (what driver.js streams into bench_mic). One-time per scenario; the SAME
// audio is then replayed byte-identically at every system under test — that's what makes STT
// accuracy and EOT numbers comparable across runs.
//
// Voice: ElevenLabs TTS when a key is available (realistic human voice — the fair test for
// cloud STT), else espeak-ng as a fallback (robotic; fine for latency work, unfair for WER).
// Key lookup: $ELEVENLABS_API_KEY, or ELEVENLABS_API_KEY= line in the file at $ELEVENLABS_ENV.
//
// Usage: node bench/blackbox/gen-audio.js [scenario] [voiceId]

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { segments, RATE } from './energy.js';

const BENCH = normalize(join(fileURLToPath(import.meta.url), '..', '..'));   // works nested (voiceloop/bench) or standalone
const scenarioName = process.argv[2] || 'smalltalk';
const voiceId = process.argv[3] || 'JBFqnCBsd6RMkjVDRZzb';   // "George" — neutral male
const scenario = JSON.parse(readFileSync(join(BENCH, 'scenarios', `${scenarioName}.json`), 'utf8'));
const outDir = join(BENCH, 'audio', scenarioName);
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

function findKey() {
  if (process.env.ELEVENLABS_API_KEY) return process.env.ELEVENLABS_API_KEY;
  const envFile = process.env.ELEVENLABS_ENV;
  if (envFile && existsSync(envFile)) {
    const m = readFileSync(envFile, 'utf8').match(/^ELEVENLABS_API_KEY=(.+)$/m);
    if (m) return m[1].trim();
  }
  return null;
}

const toRaw = (inFile, outFile) =>
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', inFile, '-ar', '16000', '-ac', '1', '-f', 's16le', outFile]);

async function elevenlabs(text, key, mp3Path) {
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_22050_32`, {
    method: 'POST',
    headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, model_id: 'eleven_turbo_v2_5' }),
  });
  if (!r.ok) throw new Error(`elevenlabs ${r.status}: ${await r.text()}`);
  writeFileSync(mp3Path, Buffer.from(await r.arrayBuffer()));
}

const key = findKey();
console.log(`voice: ${key ? `elevenlabs/${voiceId}` : 'espeak-ng (no ELEVENLABS_API_KEY — robotic fallback)'}`);

async function synthToRaw(text, src, raw) {
  if (key) await elevenlabs(text, key, src);
  else execFileSync('espeak-ng', ['-v', 'en-us', '-s', '160', '-w', src, text]);
  toRaw(src, raw);
  return readFileSync(raw);
}

// Trim a segment's PCM to its energy bounds so the silence WE insert between parts is the whole
// pause — TTS-added lead-in/tail silence would otherwise stretch every scripted pause.
function trimToSpeech(pcm) {
  const segs = segments(pcm);
  if (!segs.length) return pcm;
  const from = Math.floor((segs[0].startMs / 1000) * RATE) * 2;
  const to = Math.ceil((segs[segs.length - 1].endMs / 1000) * RATE) * 2;
  return pcm.subarray(from, Math.min(to, pcm.length));
}

const silenceOf = (ms) => Buffer.alloc(Math.round((ms / 1000) * RATE) * 2);

for (let k = 0; k < scenario.turns.length; k++) {
  const turn = scenario.turns[k];
  const raw = join(outDir, `person-${k}.raw`);
  if (existsSync(raw)) { console.log(`turn ${k}: exists, skipping`); continue; }

  if (turn.personParts) {
    // Hesitation-style turn: render each part separately, energy-trim, join with EXACT silence.
    // (Single-render SSML/break tags are not honored reliably by eleven_turbo — this is.)
    const pieces = [];
    for (let j = 0; j < turn.personParts.length; j++) {
      const part = turn.personParts[j];
      const pSrc = join(outDir, `person-${k}-part${j}.${key ? 'mp3' : 'wav'}`);
      const pRaw = join(outDir, `person-${k}-part${j}.raw`);
      pieces.push(trimToSpeech(await synthToRaw(part.text, pSrc, pRaw)));
      if (part.pauseMs) pieces.push(silenceOf(part.pauseMs));
    }
    writeFileSync(raw, Buffer.concat(pieces));
    // Verify the rendered gaps against the scripted pauses (the whole point of this scenario).
    const segs = segments(readFileSync(raw));
    const gaps = segs.slice(1).map((s, i) => Math.round(s.startMs - segs[i].endMs));
    console.log(`turn ${k}: pauses scripted [${turn.personParts.filter((p) => p.pauseMs).map((p) => p.pauseMs)}] rendered gaps [${gaps}]`);
  } else {
    const src = join(outDir, `person-${k}.${key ? 'mp3' : 'wav'}`);
    await synthToRaw(turn.person, src, raw);
  }
  const secs = (readFileSync(raw).length / 2 / 16000).toFixed(2);
  console.log(`turn ${k}: ${secs}s  "${turn.person}"`);
}
console.log(`\ndone → ${outDir}`);
