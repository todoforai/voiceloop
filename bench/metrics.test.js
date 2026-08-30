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

test('user-interrupted: clip_start inside an open person turn counts; scripted interrupts do not', () => {
  const hesitation = {
    turns: [
      { person: 'i would like to book umm a table for four', response: 'A table for four, wonderful.' },
      { person: 'stop wait', response: 'Okay.', interrupt: { afterMs: 500 } },
    ],
  };
  const events = [
    { t: 0, type: 'person_start', turn: 0 },                  // line contains an 800ms pause…
    { t: 1200, type: 'clip_start' },                          // …agent answers the half-sentence mid-pause
    { t: 1900, type: 'clip_end' },
    { t: 3000, type: 'person_end', turn: 0 },
    { t: 3600, type: 'clip_start' },                          // real reply after the turn closed — fine
    { t: 5000, type: 'person_start', turn: 1 },               // scripted barge-in over that reply
    { t: 5300, type: 'barge_stop' }, { t: 5300, type: 'clip_end' },
    { t: 5800, type: 'person_end', turn: 1 },
    { t: 6300, type: 'clip_start' }, { t: 6800, type: 'clip_end' },
  ];
  const m = computeMetrics(events, hesitation);
  assert.equal(m.turns[0].userInterruptions, 1, 'the mid-pause clip counts');
  assert.equal(m.turns[1].userInterruptions, undefined, 'scripted interrupt turn excluded');
  assert.equal(m.aggregate.userInterrupted, 1);
});

test('no agent audio during person turns → user-interrupted 0', () => {
  const m = computeMetrics(timeline, scenario);
  assert.equal(m.aggregate.userInterrupted, 0);
});

test('content_word: first scripted word timing lands next to voice→voice', () => {
  const events = [
    { t: 0, type: 'person_start', turn: 0 },
    { t: 1000, type: 'person_end', turn: 0 },
    { t: 1600, type: 'clip_start' },                          // audio starts here ("Hmm," filler)
    { t: 2400, type: 'content_word', turn: 0, word: 'It' },   // scripted content only here
    { t: 3000, type: 'clip_end' },
  ];
  const m = computeMetrics(events, { turns: [scenario.turns[0]] });
  assert.equal(m.turns[0].voiceToVoiceMs, 600);
  assert.equal(m.turns[0].contentWordMs, 1400, 'filler head start visible as the v→v/content gap');
  assert.equal(m.aggregate.contentWordMs.median, 1400);
});

test('echo words: response words in the user transcript counted, person words excluded', () => {
  const events = [
    { t: 0, type: 'person_start', turn: 0 },
    { t: 1500, type: 'person_end', turn: 0 },
    { t: 1905, type: 'stt_final', text: 'what is the weather today' },       // correct person turn → 0
    { t: 2100, type: 'clip_start' },
    { t: 3000, type: 'stt_final', text: 'sunny and warm outside' },          // echo leak → 4 ("today" is in the person line)
    { t: 4000, type: 'clip_end' },
  ];
  const m = computeMetrics(events, { turns: [scenario.turns[0]] });
  assert.equal(m.aggregate.echoWords, 4);
});

test('clean transcripts carry zero echo words', () => {
  assert.equal(computeMetrics(timeline, scenario).aggregate.echoWords, 0);
});

test('self-interruption: a short reply with no one talking counts; scripted cuts do not', () => {
  const events = [
    { t: 0, type: 'person_start', turn: 0 },
    { t: 1000, type: 'person_end', turn: 0 },
    { t: 1800, type: 'clip_start' },
    { t: 2600, type: 'barge_stop' },                          // person silent since 1000 (+800ms grace) → self
    { t: 2600, type: 'clip_end' },
    { t: 2610, type: 'reply_done', heardNw: 8, totalNw: 28 },
  ];
  const m = computeMetrics(events, { turns: [scenario.turns[0]] });
  assert.equal(m.turns[0].selfInterrupted, true);
  assert.equal(m.aggregate.selfInterruptions, 1);
});

test('self-interruption: full clean runs and scripted-interrupt cuts report zero', () => {
  const m = computeMetrics(timeline, scenario);
  assert.equal(m.aggregate.selfInterruptions, 0, 'turn 0 cut by the SCRIPTED interrupt, turn 1 fully voiced');
});

test('self-interruption: short spokenRatio alone (no barge_stop event) is caught — black-box view', () => {
  const events = [
    { t: 0, type: 'person_start', turn: 0 },
    { t: 1000, type: 'person_end', turn: 0 },
    { t: 1800, type: 'clip_start' }, { t: 2400, type: 'clip_end' },
    { t: 2410, type: 'reply_done', heardNw: 10, totalNw: 28 },   // reply died at 36% with nobody speaking
  ];
  const m = computeMetrics(events, { turns: [scenario.turns[0]] });
  assert.equal(m.turns[0].selfInterrupted, true);
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
