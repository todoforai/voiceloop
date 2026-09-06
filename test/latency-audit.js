const { VoiceAgent, StreamingTTS, isSelfEcho, novelChars } = await import(process.env.VOICELOOP_SOURCE || '../src/voice-agent.js');
import { computeMetrics } from '../bench/metrics.js';
import { performance } from 'node:perf_hooks';

const tick = () => new Promise(resolve => setImmediate(resolve));
const results = {};

// No browser or providers: the synth is held until explicitly released.
let release;
class HeldTTS extends StreamingTTS {
  async _synth() { await new Promise(resolve => { release = resolve; }); return null; }
}
const tts = new HeldTTS('test');
const ctl = new AbortController();
let settled = false;
const speaking = tts.speak('Hello there.', ctl.signal).then(() => { settled = true; });
while (!release) await tick();
const abortedAt = performance.now();
ctl.abort();
await tick();
const returnedBeforeSynthReleased = settled;
const timer = setTimeout(release, 300); // deterministic stand-in for remaining non-cancellable inference
await speaking;
results.abortDuringSynth = { returnedBeforeSynthReleased, returnMs: +(performance.now() - abortedAt).toFixed(2) };
clearTimeout(timer);
release();

// Same answer, different provider delta boundaries. Neither agent calls start().
results.presynthByDelta = {};
for (const chunks of [['Hello world.'], ['Hel', 'lo', ' world.'], ['I', ' can help.']]) {
  const warmed = [];
  let pulls = 0;
  const agent = new VoiceAgent({
    llm: async function* () { for (const text of chunks) { pulls++; yield { text }; } },
    tts: { presynth: text => warmed.push(text), stop() {} },
  });
  agent.state = 'listening'; agent._turnText = 'hello';
  agent._startPrefetch('hello');
  await tick();
  results.presynthByDelta[JSON.stringify(chunks)] = { warmed, pulls };
  agent._dropPrefetch();
}

// Silent synthesis failures still return the entire answer as 'heard'.
class FailedTTS extends StreamingTTS {
  async _synth() { throw new Error('synthetic outage'); }
}
const silent = new FailedTTS('test');
let errors = 0;
silent.onEvent = e => { if (e.type === 'error') errors++; };
const response = 'Hello world. Everything failed.';
results.silentDelivery = { generated: response, returnedAsHeard: await silent.speak(response), errors };

// One transcript can currently receive credit for two distinct person turns.
const scenario = { turns: [{ person: 'hello', response: 'hi' }, { person: 'hello', response: 'hi' }] };
const metrics = computeMetrics([
  { t: 0, type: 'person_start', turn: 0 }, { t: 100, type: 'person_end', turn: 0 },
  { t: 1000, type: 'person_start', turn: 1 }, { t: 1100, type: 'person_end', turn: 1 },
  { t: 1200, type: 'stt_final', text: 'hello' },
], scenario);
results.oneFinalForTwoTurns = metrics.turns.map(t => ({ turn: t.turn, wer: t.wer }));

results.interruptionEvidence = ['stop', 'wait', 'no', 'stop stop', 'no wait'].map(heard => ({
  heard, novel: novelChars(heard, 'I can stop that task and wait for you.'),
  classifiedEcho: isSelfEcho(heard, 'I can stop that task and wait for you.'),
}));
console.log(JSON.stringify(results, null, 2));
