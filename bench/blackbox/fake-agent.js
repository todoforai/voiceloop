#!/usr/bin/env node
// bench/blackbox/fake-agent.js — a MINIMAL scripted voice agent used to smoke-test the black-box
// rig end-to-end (no browser, no LLM, no STT): listens on bench_mic, and whenever it hears speech
// end, replies with a fixed-duration tone burst after a fixed "thinking" delay. Supports barge-in:
// speech heard while replying cuts the reply after stopDelayMs.
//
// Known timings in → known metrics out = the rig itself is validated:
//   voiceToVoice ≈ THINK_MS (+gate hang), interruptStop ≈ STOP_DELAY_MS.
//
// Usage: node bench/blackbox/fake-agent.js

import { spawn } from 'node:child_process';
import { Gate, RATE } from './energy.js';

const THINK_MS = 700;         // person stops → reply audio starts
const REPLY_MS = 4000;        // reply duration (long enough for scripted interrupts to land)
const STOP_DELAY_MS = 250;    // person barge-in → reply cut
const CHUNK_MS = 100, CHUNK_SAMPLES = (RATE * CHUNK_MS) / 1000;

const mic = spawn('pacat', ['--record', '-d', 'bench_mic', '--raw', `--rate=${RATE}`, '--channels=1', '--format=s16le', '--latency-msec=40']);
const spk = spawn('pacat', ['--playback', '-d', 'bench_spk', '--raw', `--rate=${RATE}`, '--channels=1', '--format=s16le', '--latency-msec=40']);

let replyUntil = 0, replySample = 0, pendingReply = null;
const now = () => performance.now();

const gate = new Gate({
  onSpeech: () => {
    if (now() < replyUntil) setTimeout(() => { replyUntil = 0; }, STOP_DELAY_MS);   // barge-in → cut
    clearTimeout(pendingReply);
  },
  onSilence: () => {
    clearTimeout(pendingReply);
    pendingReply = setTimeout(() => { replyUntil = now() + REPLY_MS; }, THINK_MS);
  },
});
mic.stdout.on('data', (c) => gate.feed(c));

// Speaker: continuous stream, tone while replying, silence otherwise (realtime pacing).
setInterval(() => {
  const buf = Buffer.alloc(CHUNK_SAMPLES * 2);
  if (now() < replyUntil)
    for (let i = 0; i < CHUNK_SAMPLES; i++, replySample++)
      buf.writeInt16LE(Math.round(9000 * Math.sin((2 * Math.PI * 330 * replySample) / RATE)), i * 2);
  spk.stdin.write(buf);
}, CHUNK_MS);

console.log(`fake-agent: think=${THINK_MS}ms reply=${REPLY_MS}ms stopDelay=${STOP_DELAY_MS}ms — listening on bench_mic`);
