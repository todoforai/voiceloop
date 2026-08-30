#!/usr/bin/env node
// bench/blackbox/gen-noise.js — assets for the NOISE scenario (bench/scenarios/noise.json):
//
//   audio/noise/person-*.raw   copied BYTE-IDENTICAL from smalltalk (same lines → clean-vs-noise
//                              is a controlled comparison; fairness rule: never regenerate)
//   audio/noise/bed.raw        continuous café bed: a SECOND ElevenLabs voice chatting irrelevant
//                              sentences + a brown-noise floor, pre-scaled to ~15dB SNR under the
//                              person lines (speech-frame RMS, measured not guessed). driver.js
//                              loops it into bench_mic for the whole conversation, agent turns
//                              included — that's the point.
//   audio/noise/burst-*.raw    two non-speech bursts (cough, door slam) via ElevenLabs
//                              sound-generation, scaled to person-line loudness (someone in the
//                              room, not at the next table). driver.js fires them mid-reply.
//
// All output is raw s16le/16k/mono, bed padded to a whole driver chunk (100ms) so looping needs
// no wrap handling. Usage: ELEVENLABS_API_KEY=… node bench/blackbox/gen-noise.js

import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { segments, frameRms, RATE, FRAME_MS, FRAME_SAMPLES } from './energy.js';

const BENCH = normalize(join(fileURLToPath(import.meta.url), '..', '..'));
const outDir = join(BENCH, 'audio', 'noise');
const smalltalkDir = join(BENCH, 'audio', 'smalltalk');
mkdirSync(outDir, { recursive: true });
const key = process.env.ELEVENLABS_API_KEY;
if (!key) { console.error('ELEVENLABS_API_KEY required (bed voice + sound effects)'); process.exit(1); }

const BED_VOICE = '21m00Tcm4TlvDq8ikWAM';   // "Rachel" — distinct from the person's "George"
const SNR_DB = 15;                          // bed sits this far under the person lines

// Irrelevant café chatter — real words on purpose: if they leak into a SUT's STT and trigger
// word-based barge-in, that is a finding, not a bug in the bed.
const CHATTER = [
  'So anyway, I told him we should just take the earlier train.',
  'Honestly the coffee here is better than the place around the corner.',
  'She said the meeting got moved to Thursday afternoon.',
  'I cannot believe how crowded it is in here today.',
  'Did you end up watching that documentary last night?',
  'We should probably book the tickets before the prices go up.',
  'He keeps talking about moving to the coast someday.',
  'The kitchen ordered way too much milk again this week.',
  'My sister is visiting next weekend with the kids.',
  'Let us split the bill and catch the bus at quarter past.',
];

// ── helpers ────────────────────────────────────────────────────────────────────────────────────
const toRaw = (inFile, outFile, filters = []) =>
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', inFile, ...(filters.length ? ['-af', filters.join(',')] : []), '-ar', String(RATE), '-ac', '1', '-f', 's16le', outFile]);

// RMS over speech frames only (energy.js segments) — file-level RMS would count silences.
function speechRms(pcm) {
  const segs = segments(pcm);
  let sum = 0, n = 0;
  for (const s of segs)
    for (let t = s.startMs; t + FRAME_MS <= s.endMs; t += FRAME_MS) {
      const rms = frameRms(pcm, (t / FRAME_MS) * FRAME_SAMPLES * 2, FRAME_SAMPLES);
      sum += rms * rms; n++;
    }
  return n ? Math.sqrt(sum / n) : 0;
}

function scaled(pcm, gain) {
  const out = Buffer.alloc(pcm.length);
  for (let i = 0; i + 1 < pcm.length; i += 2)
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(pcm.readInt16LE(i) * gain))), i);
  return out;
}

function trimToSpeech(pcm) {
  const segs = segments(pcm);
  if (!segs.length) return pcm;
  const from = Math.floor((segs[0].startMs / 1000) * RATE) * 2;
  const to = Math.ceil((segs[segs.length - 1].endMs / 1000) * RATE) * 2;
  return pcm.subarray(from, Math.min(to, pcm.length));
}

async function elTts(text, mp3Path) {
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${BED_VOICE}?output_format=mp3_22050_32`, {
    method: 'POST', headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, model_id: 'eleven_turbo_v2_5' }),
  });
  if (!r.ok) throw new Error(`elevenlabs tts ${r.status}: ${await r.text()}`);
  writeFileSync(mp3Path, Buffer.from(await r.arrayBuffer()));
}

async function elSfx(prompt, seconds, mp3Path) {
  const r = await fetch('https://api.elevenlabs.io/v1/sound-generation', {
    method: 'POST', headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: prompt, duration_seconds: seconds, prompt_influence: 0.6 }),
  });
  if (!r.ok) throw new Error(`elevenlabs sfx ${r.status}: ${await r.text()}`);
  writeFileSync(mp3Path, Buffer.from(await r.arrayBuffer()));
}

// ── person lines: byte-identical copies from smalltalk ─────────────────────────────────────────
const scenario = JSON.parse(readFileSync(join(BENCH, 'scenarios', 'noise.json'), 'utf8'));
const smalltalk = JSON.parse(readFileSync(join(BENCH, 'scenarios', 'smalltalk.json'), 'utf8'));
let personRms = 0;
{
  let sum = 0;
  for (let k = 0; k < scenario.turns.length; k++) {
    if (scenario.turns[k].person !== smalltalk.turns[k]?.person || scenario.turns[k].response !== smalltalk.turns[k]?.response)
      throw new Error(`turn ${k}: noise person/response text differs from smalltalk — clean-vs-noise must stay controlled`);
    const dst = join(outDir, `person-${k}.raw`);
    if (!existsSync(dst)) copyFileSync(join(smalltalkDir, `person-${k}.raw`), dst);
    const rms = speechRms(readFileSync(dst));
    sum += rms * rms;
    console.log(`person-${k}.raw: copied from smalltalk (speech RMS ${Math.round(rms)})`);
  }
  personRms = Math.sqrt(sum / scenario.turns.length);
}
console.log(`person speech RMS: ${Math.round(personRms)} → bed target ${Math.round(personRms / 10 ** (SNR_DB / 20))} (-${SNR_DB}dB)`);

// ── café bed: chatter sentences joined with gaps, over a brown-noise floor ─────────────────────
const bedRaw = join(outDir, 'bed.raw');
if (!existsSync(bedRaw)) {
  const pieces = [];
  for (let i = 0; i < CHATTER.length; i++) {
    const mp3 = join(outDir, `bed-line-${i}.mp3`), raw = join(outDir, `bed-line-${i}.tmp.raw`);
    if (!existsSync(mp3)) await elTts(CHATTER[i], mp3);
    toRaw(mp3, raw, ['lowpass=f=4000']);                       // a table away, not in your ear
    pieces.push(trimToSpeech(readFileSync(raw)));
    pieces.push(Buffer.alloc(Math.round((0.4 + (i % 3) * 0.15) * RATE) * 2));   // 400–700ms gaps
  }
  const speech = Buffer.concat(pieces);
  // Brown-noise floor 10dB under the chatter: the bed never goes silent, so an energy VAD sees a
  // continuous café, not convenient gaps. Mix first, THEN scale the combined bed to the SNR target.
  const floorRaw = join(outDir, 'bed-floor.tmp.raw');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i',
    `anoisesrc=colour=brown:duration=${Math.ceil(speech.length / 2 / RATE) + 1}:amplitude=0.05`,
    '-ar', String(RATE), '-ac', '1', '-f', 's16le', floorRaw]);
  let floor = readFileSync(floorRaw).subarray(0, speech.length);
  const floorRmsNow = Math.sqrt([...Array(Math.floor(floor.length / 2 / FRAME_SAMPLES))].reduce((a, _, f) => a + frameRms(floor, f * FRAME_SAMPLES * 2, FRAME_SAMPLES) ** 2, 0) / Math.floor(floor.length / 2 / FRAME_SAMPLES));
  floor = scaled(floor, (speechRms(speech) / 10 ** (10 / 20)) / floorRmsNow);
  let bed = Buffer.alloc(speech.length);   // driver loops per-sample (modulo) — no chunk padding, no silent seam
  for (let i = 0; i + 1 < speech.length; i += 2)
    bed.writeInt16LE(Math.max(-32768, Math.min(32767, speech.readInt16LE(i) + floor.readInt16LE(i))), i);
  bed = scaled(bed, personRms / 10 ** (SNR_DB / 20) / speechRms(bed));
  writeFileSync(bedRaw, bed);
  console.log(`bed.raw: ${(bed.length / 2 / RATE).toFixed(1)}s, speech RMS ${Math.round(speechRms(bed))} (target ${Math.round(personRms / 10 ** (SNR_DB / 20))})`);
} else console.log('bed.raw: exists, skipping');

// ── bursts: cough + door slam at person-line loudness ──────────────────────────────────────────
const BURSTS = [
  { file: 'burst-cough.raw', prompt: 'a single person coughing twice, dry cough, close to the microphone, no other sounds', seconds: 2 },
  { file: 'burst-door.raw', prompt: 'a heavy wooden door slamming shut once, sharp bang, no other sounds', seconds: 1.5 },
];
for (const b of BURSTS) {
  const raw = join(outDir, b.file);
  if (existsSync(raw)) { console.log(`${b.file}: exists, skipping`); continue; }
  const mp3 = raw.replace(/\.raw$/, '.mp3'), tmp = raw + '.tmp';
  if (!existsSync(mp3)) await elSfx(b.prompt, b.seconds, mp3);
  toRaw(mp3, tmp);
  let pcm = trimToSpeech(readFileSync(tmp));
  pcm = scaled(pcm, personRms / speechRms(pcm));
  writeFileSync(raw, pcm);
  console.log(`${b.file}: ${(pcm.length / 2 / RATE).toFixed(2)}s, RMS ${Math.round(speechRms(pcm))} (person ${Math.round(personRms)})`);
}
execFileSync('sh', ['-c', `rm -f ${outDir}/*.tmp.raw ${outDir}/*.raw.tmp`]);
console.log(`\ndone → ${outDir}`);
