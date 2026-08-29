// bench/metrics.test.js — the metrics computation locked in against a synthetic timeline.
// Run: `node --test bench/metrics.test.js`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wer, computeMetrics, formatReport } from './metrics.js';

test('wer: exact match 0, total miss 1, substitutions counted', () => {
  assert.equal(wer('hello world', 'hello world'), 0);
  assert.equal(wer('hello world', ''), 1);
  assert.equal(wer('a b c d', 'a b x d'), 0.25);
  assert.equal(wer('Hello, World!', 'hello world'), 0, 'punctuation/case normalized');
});

const scenario = {
  turns: [
    { person: 'what is the weather today', response: 'It is sunny and warm outside today.' },
    { person: 'stop wait what about tomorrow', response: 'Tomorrow looks rainy in the morning.', interrupt: { afterMs: 800 } },
  ],
};

// Turn 0: person speaks 0→1500, EOT at 1900, prefetch token at 1700 (before close!), clip at 2100.
// Turn 1: person interrupts at 3000 (agent speaking since 2100), agent stops at 3250.
const timeline = [
  { t: 0, type: 'person_start', turn: 0 },
  { t: 420, type: 'stt_partial', text: 'what is' },
  { t: 1500, type: 'person_end', turn: 0 },
  { t: 1700, type: 'llm_first_token' },                       // speculative prefetch beat the close
  { t: 1900, type: 'turn_committed' },
  { t: 1905, type: 'stt_final', text: 'what is the weather today' },
  { t: 2100, type: 'clip_start' },
  { t: 2900, type: 'clip_end' },
  { t: 2950, type: 'clip_start' },

  { t: 3000, type: 'person_start', turn: 1 },                 // barge-in over the playing reply
  { t: 3250, type: 'barge_stop' },
  { t: 3250, type: 'clip_end' },
  { t: 3260, type: 'reply_done', heardNw: 14, totalNw: 28 },  // half the reply got voiced
  { t: 3400, type: 'stt_partial', text: 'stop wait' },
  { t: 4400, type: 'person_end', turn: 1 },
  { t: 4700, type: 'turn_committed' },
  { t: 4705, type: 'stt_final', text: 'stop wait what about tomorrow' },
  { t: 5000, type: 'llm_first_token' },
  { t: 5400, type: 'clip_start' },
  { t: 6400, type: 'clip_end' },
  { t: 6410, type: 'reply_done', heardNw: 30, totalNw: 30 },
];

test('per-turn: latencies, negative prefetch TTFT, WER, interrupt overlap', () => {
  const m = computeMetrics(timeline, scenario);
  const [t0, t1] = m.turns;

  assert.equal(t0.firstPartialMs, 420);
  assert.equal(t0.eotMs, 400, 'person_end 1500 → commit 1900');
  assert.equal(t0.llmFirstTokenMs, 200, 'token at 1700, person_end 1500');
  assert.equal(t0.voiceToVoiceMs, 600, 'person_end 1500 → clip 2100');
  assert.equal(t0.ttsFirstAudioMs, 400, 'token 1700 → clip 2100');
  assert.equal(t0.wer, 0);

  assert.equal(t1.interruptStopMs, 250, 'person_start 3000 → barge_stop 3250');
  assert.equal(t1.spokenRatio, 1, "turn 1's own reply fully voiced");
  assert.equal(t1.voiceToVoiceMs, 1000);
});

test('aggregate: interrupted reply excluded from spokenRatioUninterrupted; no false barge-ins', () => {
  const m = computeMetrics(timeline, scenario);
  const a = m.aggregate;
  assert.equal(a.falseBargeIns, 0, 'the one barge_stop is attributed to the scripted interrupt');
  assert.equal(a.spokenRatioUninterrupted, 1, 'turn 0 (cut by the scripted interrupt) excluded, turn 1 full');
  assert.equal(a.wer, 0);
  assert.equal(a.stalls, 0);
  assert.ok(a.voiceToVoiceMs.median >= 600);
});

test('a barge_stop with no scripted interrupt nearby counts as a FALSE barge-in', () => {
  const events = [
    { t: 0, type: 'person_start', turn: 0 },
    { t: 1000, type: 'person_end', turn: 0 },
    { t: 1400, type: 'turn_committed' },
    { t: 1405, type: 'stt_final', text: 'what is the weather today' },
    { t: 1500, type: 'llm_first_token' },
    { t: 1800, type: 'clip_start' },
    { t: 2000, type: 'barge_stop' },                          // nothing scripted → agent cut itself
    { t: 2000, type: 'clip_end' },
    { t: 2010, type: 'reply_done', heardNw: 5, totalNw: 28 },
  ];
  const m = computeMetrics(events, { turns: [scenario.turns[0]] });
  assert.equal(m.aggregate.falseBargeIns, 1);
});

test('stalls: a >250ms silent gap between clips with text remaining is counted', () => {
  const events = [
    { t: 0, type: 'person_start', turn: 0 },
    { t: 1000, type: 'person_end', turn: 0 },
    { t: 1400, type: 'turn_committed' },
    { t: 1405, type: 'stt_final', text: 'what is the weather today' },
    { t: 1500, type: 'llm_first_token' },
    { t: 1800, type: 'clip_start' }, { t: 2300, type: 'clip_end' },
    { t: 2900, type: 'clip_start' }, { t: 3400, type: 'clip_end' },   // 600ms gap → stall
    { t: 3450, type: 'clip_start' }, { t: 3900, type: 'clip_end' },   // 50ms gap → fine
    { t: 3910, type: 'reply_done', heardNw: 28, totalNw: 28 },
  ];
  const m = computeMetrics(events, { turns: [scenario.turns[0]] });
  assert.equal(m.turns[0].stalls, 1);
});

test('a turn with no person audio in the timeline reports missing, not a crash', () => {
  const m = computeMetrics([], scenario);
  assert.equal(m.turns[0].missing, true);
  assert.equal(m.turns[1].missing, true);
});

test('formatReport renders a markdown table with the headline number', () => {
  const r = formatReport(computeMetrics(timeline, scenario), 'unit');
  assert.ok(r.includes('voice→voice latency'));
  assert.ok(r.includes('| 0 | 600 |'), 'turn 0 row carries the 600ms v→v');
});
