// Diagnostic contracts, not a hesitation fix. Run against either baseline or candidate source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const src = resolve(process.env.VOICELOOP_TEST_SRC || 'src');
const { VoiceAgent } = await import(pathToFileURL(`${src}/voice-agent.js`));
const { STT_PROVIDERS } = await import(pathToFileURL(`${src}/stt.js`));
const tick = () => new Promise(r => setImmediate(r));

async function withAgent(run) {
  const original = STT_PROVIDERS.elevenlabs;
  let callbacks, commits = 0, speaks = 0;
  const warmed = [];
  STT_PROVIDERS.elevenlabs = opts => {
    callbacks = opts;
    return { nativeEOT: true, continuous: true, prefetchMs: 0, reset() {}, close() {},
      commit() { commits++; } };
  };
  const agent = new VoiceAgent({
    sttProvider: 'elevenlabs',
    llm: async function* () { yield 'Hel'; yield 'lo world.'; },
    tts: { stop() {}, presynth: text => warmed.push(text), async speak(stream) {
      speaks++; let text = ''; for await (const chunk of stream) text += chunk; return text;
    } },
  });
  agent.state = 'listening';
  try { await run({ agent, callbacks, warmed, counts: () => ({ commits, speaks }) }); }
  finally { agent.stop(); STT_PROVIDERS.elevenlabs = original; }
}

test('native EOT: VAD pause and fragmented speculation cannot commit or play a reply', async () => {
  await withAgent(async ({ agent, callbacks, counts }) => {
    agent._onSpeechStart();
    callbacks.onPartial('Send the confirmation to my email.', 100);
    agent._onSpeechEnd();
    await tick(); await tick();
    assert.deepEqual(counts(), { commits: 0, speaks: 0 });
    assert.deepEqual(agent.history, []);
    agent._onSpeechStart();
    callbacks.onPartial('Send the confirmation to my email. Actually, text me.', 200);
    await tick();
    assert.deepEqual(counts(), { commits: 0, speaks: 0 });
    callbacks.onFinal('Send the confirmation to my email. Actually, text me.', 300);
    await agent._turn;
    assert.equal(counts().speaks, 1);
    assert.equal(agent.history.filter(m => m.role === 'user').length, 1);
  });
});

test('diagnostic: a provider prefix final after VAD resume is currently accepted by both builds', async () => {
  await withAgent(async ({ agent, callbacks, counts }) => {
    agent._onSpeechStart(); callbacks.onPartial('Send the confirmation to my email.', 100);
    agent._onSpeechEnd(); agent._onSpeechStart();
    callbacks.onFinal('Send the confirmation to my email.', 200);
    await agent._turn;
    assert.equal(counts().commits, 0, 'not a VAD-forced STT final');
    assert.equal(counts().speaks, 1, 'documents the current early-final behavior, not desired correctness');
    callbacks.onPartial('Actually, make that a text message.', 300);
    callbacks.onFinal('Actually, make that a text message.', 400);
    await agent._turn;
    assert.equal(agent.history.filter(m => m.role === 'user').length, 2);
    assert.equal(counts().speaks, 2);
  });
});
