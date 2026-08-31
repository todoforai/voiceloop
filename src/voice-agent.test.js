// voice-agent.test.js — headless tests for the VoiceAgent TURN LOOP: sendUserText acceptance
// semantics and the _runTurn serializer that keeps rapid turns from overlapping. No browser/audio:
// we inject a fake `llm` and `tts`, drive sendUserText/_onUserTurn directly, and never call start()
// (so no mic/VAD/AudioContext). Run: `node --test packages/shared-voice/src/voice-agent.test.js`.
//
// These lock in: typed/spoken turns are accepted (true) only when live, dropped (false) once
// stopped/blank; held turns queue without replying; and N turns fired back-to-back run STRICTLY
// serially (never two LLM/TTS at once), with history staying chronological.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VoiceAgent, isSelfEcho, novelChars } from './voice-agent.js';

// A controllable fake TTS: records concurrency (how many speaks overlap) and resolves with the
// full streamed text as the "heard" prefix. `gate` lets a test hold a turn open to probe overlap.
function makeFakeTTS() {
  const tts = {
    speaking: 0, maxConcurrent: 0, stopped: 0, release: null,
    async speak(stream /*, signal */) {
      tts.speaking++; tts.maxConcurrent = Math.max(tts.maxConcurrent, tts.speaking);
      let heard = '';
      for await (const t of stream) heard += t;
      if (tts.gate) await new Promise((r) => { tts.release = r; });   // hold the turn open until released
      tts.speaking--;
      return heard;
    },
    stop() { tts.stopped++; },
  };
  return tts;
}

// A fake llm generator: yields the assistant reply for the LATEST user message, one word at a time.
async function* fakeLLM(history /*, system, signal */) {
  const lastUser = [...history].reverse().find((m) => m.role === 'user');
  const reply = `reply-to:${lastUser?.content ?? ''}`;
  for (const w of reply.split(/(?=:)/)) yield { text: w };
}

function makeAgent(over = {}) {
  const events = [];
  const tts = over.tts ?? makeFakeTTS();
  const agent = new VoiceAgent({
    llm: over.llm ?? fakeLLM,
    tts,
    onEvent: (e) => events.push(e),
    ...over.opts,
  });
  return { agent, tts, events };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

// ── Tests ───────────────────────────────────────────────────────────────────────────────────────

test('sendUserText accepts a live turn (true) and emits a finalized user stt event', async () => {
  const { agent, events } = makeAgent();
  const ok = agent.sendUserText('hi');
  assert.equal(ok, true, 'accepted while live');
  const stt = events.find((e) => e.type === 'stt' && e.turnComplete);
  assert.equal(stt.text, 'hi', 'rendered as a finished user bubble');
});

test('sendUserText drops blank/whitespace (false) and never starts a turn', async () => {
  const { agent, tts } = makeAgent();
  assert.equal(agent.sendUserText(''), false);
  assert.equal(agent.sendUserText('   '), false);
  await settle();
  assert.equal(tts.speaking + tts.maxConcurrent, 0, 'no turn ran for blank input');
});

test('sendUserText after stop() revives the reply loop — typed turns need no mic', async () => {
  const { agent, events } = makeAgent();
  agent.stop();   // _closed = true (no pipeline was started; stop is still safe)
  assert.equal(agent.sendUserText('after stop'), true, 'typed turn accepted while paused');
  const stt = events.find((e) => e.type === 'stt' && e.turnComplete);
  assert.equal(stt.text, 'after stop', 'rendered as a finished user bubble');
  await settle();
  assert.equal(agent.closed, false, 'the reply loop is live again (audio stays parked until start())');
});

test('sendUserText after destroy() is rejected — destroy is terminal, never resurrected', async () => {
  const { agent } = makeAgent();
  agent.destroy();
  assert.equal(agent.sendUserText('too late'), false, 'destroyed agent rejects the turn');
  assert.equal(agent.closed, true, 'still closed');
});

// start() with a self-capturing provider (Web Speech) that fatals SYNCHRONOUSLY inside open()
// (browser unsupported → onFatal → stop() sets _closed + idle). start() must NOT then overwrite that
// with a fake 'listening' state — the host reconciles `running` against `closed`, so a fatal session
// left as 'listening' would look alive with no mic. `window` is absent here, so webspeech open() fatals.
test('start() keeps closed/idle when a self-capturing STT fatals synchronously (no fake listening)', async () => {
  const { agent, events } = makeAgent({ opts: { sttProvider: 'webspeech' } });
  await agent.start();
  assert.equal(agent.closed, true, 'the synchronous fatal stopped the agent');
  assert.equal(agent.state, 'idle', 'state stayed idle — not overwritten with listening');
  assert.ok(events.some((e) => e.type === 'error'), 'the fatal surfaced as an error event');
  assert.ok(!events.some((e) => e.type === 'state' && e.state === 'listening'), 'never flipped to listening');
});

test('held turns queue without replying; release runs one turn over them', async () => {
  const { agent, tts, events } = makeAgent();
  agent.setHeld(true);
  assert.equal(agent.sendUserText('one'), true, 'accepted (queued)');
  assert.equal(agent.sendUserText('two'), true, 'accepted (queued)');
  await settle();
  assert.equal(tts.maxConcurrent, 0, 'held: nothing spoken yet');
  // Both user turns are stacked into history, no assistant turn in between.
  assert.deepEqual(agent.history.map((m) => m.role), ['user', 'user'], 'two queued user turns, no reply');

  agent.setHeld(false);   // release → _flush runs ONE turn
  await settle(); await settle();
  assert.equal(agent.history.at(-1).role, 'assistant', 'release produced exactly one assistant reply');
});

test('SERIALIZATION: rapid back-to-back sends never overlap (no two LLM/TTS at once)', async () => {
  const tts = makeFakeTTS();
  const { agent } = makeAgent({ tts });
  // Fire three typed turns in the SAME tick — the bug this guards against is them racing past the
  // serializer and running concurrently.
  agent.sendUserText('a');
  agent.sendUserText('b');
  agent.sendUserText('c');
  // Let everything drain.
  for (let i = 0; i < 12; i++) await settle();
  assert.equal(tts.maxConcurrent, 1, 'turns ran strictly one at a time (never overlapped)');
  // History ends chronological: every user turn recorded, last reply is to the last user message.
  const users = agent.history.filter((m) => m.role === 'user').map((m) => m.content);
  assert.deepEqual(users, ['a', 'b', 'c'], 'all user turns recorded in order');
  assert.equal(agent.history.at(-1).content, 'reply-to:c', 'final reply answers the final turn');
});

test('SERIALIZATION: a send while one turn is mid-TTS supersedes it (one at a time)', async () => {
  const tts = makeFakeTTS();
  tts.gate = true;                       // hold turn A open inside speak()
  const { agent } = makeAgent({ tts });

  agent.sendUserText('first');
  // wait until A is actually inside speak()
  for (let i = 0; i < 10 && tts.speaking === 0; i++) await settle();
  assert.equal(tts.speaking, 1, 'turn A is speaking');

  agent.sendUserText('second');         // arrives mid-A → must abort A, then run B (not in parallel)
  tts.gate = false; tts.release?.();     // let A finish unwinding
  for (let i = 0; i < 12; i++) await settle();

  assert.equal(tts.maxConcurrent, 1, 'B never ran while A was still speaking');
  assert.ok(tts.stopped >= 1, 'the in-flight turn was stopped on supersede');
  assert.equal(agent.history.at(-1).content, 'reply-to:second', 'B replied last');
});

test('entering hold while a turn is queued does not LOSE the accepted utterance', async () => {
  const tts = makeFakeTTS();
  tts.gate = true;                       // hold turn A inside speak() so B stays queued
  const { agent } = makeAgent({ tts });

  agent.sendUserText('first');
  for (let i = 0; i < 10 && tts.speaking === 0; i++) await settle();
  assert.equal(tts.speaking, 1, 'turn A is speaking');

  const ok = agent.sendUserText('second');   // accepted; its _runTurn body is queued behind A
  assert.equal(ok, true, 'accepted synchronously');
  agent.setHeld(true);                        // enter hold BEFORE B reaches its prep/push

  tts.gate = false; tts.release?.();          // let A unwind; B's body now sees _held
  for (let i = 0; i < 12; i++) await settle();

  // 'second' must survive — routed into the held queue, not dropped.
  agent.setHeld(false);                       // release → reply over everything accumulated
  for (let i = 0; i < 12; i++) await settle();
  const users = agent.history.filter((m) => m.role === 'user').map((m) => m.content);
  assert.ok(users.includes('second'), 'the accepted-while-queued utterance was not lost');
});

// ── Tool calls: the create_todo spam regression ──────────────────────────────────────────────────
// The loop that produced duplicate TODOs: the tool's own result is relayed back with notify(), which
// used to run as a full user turn — aborting the turn that was still speaking and re-running the LLM
// over a history whose last entry was the request, so the model called the tool AGAIN.

// An LLM that calls `create_todo` whenever the last user message isn't already answered by a
// [TOOL CALL] of its own — i.e. exactly the naive behaviour of a model reading its history.
async function* toolLLM(history) {
  const said = history.some((m) => m.role === 'assistant' && m.content.includes('[TOOL CALL create_todo]'));
  if (!said) yield { tool: 'create_todo', args: { content: 'do the thing' } };
  yield { text: said ? 'already running' : "I'm on it" };
}

test('TOOL: a relayed result never re-triggers the tool (no duplicate dispatch)', async () => {
  const tts = makeFakeTTS();
  const runs = [];
  const { agent } = makeAgent({
    llm: toolLLM,
    tts,
    opts: {
      // The host relays the outcome back mid-turn via notify().
      tools: { create_todo: { description: 'create a todo', params: { content: { type: 'string' } },
        run: (args) => { runs.push(args); agent.notify('[TOOL RESULT create_todo] Created todo abc1234.'); } } },
    },
  });

  agent.sendUserText('build me a landing page');
  for (let i = 0; i < 40; i++) await settle();

  assert.equal(runs.length, 1, 'the tool ran exactly once');
  assert.equal(tts.maxConcurrent, 1, 'the relayed result never spoke over the turn that called it');
  assert.ok(
    agent.history.some((m) => m.role === 'assistant' && m.content.includes('[TOOL CALL create_todo]')),
    'the call it made is recorded in its own turn, so the next turn can see it already happened',
  );
});

test('TOOL: the same call repeated within one stream runs once', async () => {
  const runs = [];
  const dupLLM = async function* () {
    yield { tool: 'create_todo', args: { content: 'x' } };
    yield { tool: 'create_todo', args: { content: 'x' } };   // provider re-emitted its buffered call
    yield { text: 'on it' };
  };
  const { agent } = makeAgent({ llm: dupLLM, opts: { tools: { create_todo: { run: (args) => runs.push(args) } } } });
  agent.sendUserText('go');
  for (let i = 0; i < 20; i++) await settle();
  assert.equal(runs.length, 1, 'the duplicate tool_use was collapsed');
});

test('TOOL: distinct calls in one turn all run and are all recorded', async () => {
  const runs = [];
  const twoLLM = async function* () {
    yield { tool: 'create_todo', args: { content: 'first' } };
    yield { tool: 'create_todo', args: { content: 'second' } };
    yield { text: 'both going' };
  };
  const { agent } = makeAgent({ llm: twoLLM, opts: { tools: { create_todo: { run: (args) => runs.push(args.content) } } } });
  agent.sendUserText('go');
  for (let i = 0; i < 20; i++) await settle();
  assert.deepEqual(runs, ['first', 'second'], 'different args are different acts');
  const note = agent.history.find((m) => m.role === 'assistant').content;
  assert.ok(note.includes('"first"') && note.includes('"second"'), 'both calls recorded');
});

test('TOOL: a burst of relayed results collapses into ONE reply', async () => {
  const { agent, tts } = makeAgent();
  agent.sendUserText('hi');
  for (let i = 0; i < 20; i++) await settle();
  const before = agent.history.filter((m) => m.role === 'assistant').length;

  agent.notify('[TOOL RESULT open_todo] Opened abc.');
  agent.notify('[TOOL RESULT open_todo] Opened def.');
  agent.notify('[TOOL RESULT open_todo] Opened ghi.');
  for (let i = 0; i < 30; i++) await settle();

  const added = agent.history.filter((m) => m.role === 'assistant').length - before;
  assert.equal(added, 1, 'three results produced one reply, not three interrupting monologues');
  assert.equal(tts.maxConcurrent, 1, 'never spoke over itself');
});

test('TOOL: a NEW request still dispatches (the ledger blocks repeats, not new work)', async () => {
  const runs = [];
  // Only refuses to re-call for a request it has ALREADY called for: it looks at the calls made
  // since the last user message, which is what the persona rule actually says.
  async function* perRequestLLM(history) {
    const lastUser = history.map((m) => m.role).lastIndexOf('user');
    const alreadyCalled = history.slice(lastUser).some((m) => m.role === 'assistant' && m.content.includes('[TOOL CALL'));
    if (!alreadyCalled) yield { tool: 'create_todo', args: { content: history[lastUser].content } };
    yield { text: 'ok' };
  }
  const { agent } = makeAgent({ llm: perRequestLLM, opts: { tools: { create_todo: { run: (a) => runs.push(a.content) } } } });
  agent.sendUserText('task A');
  for (let i = 0; i < 20; i++) await settle();
  agent.sendUserText('unrelated task B');
  for (let i = 0; i < 20; i++) await settle();
  assert.deepEqual(runs, ['task A', 'unrelated task B'], 'two different requests → two dispatches');
});

test('TOOL: a tool that ran is recorded even when the reply itself FAILS', async () => {
  const runs = [];
  const tts = {
    maxConcurrent: 0,
    async speak(stream) { for await (const _ of stream) { /* drain (fires the tool) */ } throw new Error('tts exploded'); },
    stop() {},
  };
  const { agent, events } = makeAgent({
    llm: async function* () { yield { tool: 'create_todo', args: { content: 'x' } }; yield { text: 'on it' }; },
    tts,
    opts: { tools: { create_todo: { run: (a) => runs.push(a.content) } } },
  });
  agent.sendUserText('go');
  for (let i = 0; i < 20; i++) await settle();
  assert.equal(runs.length, 1, 'the tool did run');
  assert.ok(events.some((e) => e.type === 'error'), 'the failure surfaced');
  assert.ok(
    agent.history.some((m) => m.role === 'assistant' && m.content.includes('[TOOL CALL create_todo]')),
    'a failed reply still records what it dispatched — otherwise the next turn re-calls it',
  );
});

test('REPLAY: replaying a finished reply does not strand a queued notify', async () => {
  const tts = makeFakeTTS();
  tts.gate = true;
  const { agent } = makeAgent({ tts });

  agent.sendUserText('hi');                            // turn A, held open inside speak()
  for (let i = 0; i < 10 && tts.speaking === 0; i++) await settle();
  agent.notify('[TOOL RESULT open_todo] Opened abc.'); // queues behind A
  agent.replay('some earlier reply');                  // pure TTS — must NOT claim the pending reply
  tts.gate = false; tts.release?.();
  for (let i = 0; i < 40; i++) await settle();

  assert.equal(agent.history.at(-1).role, 'assistant', 'the queued event was answered, not stranded');
});

test('REPLAY: replaying right after a hold release does not swallow the held turns', async () => {
  const { agent } = makeAgent();
  agent.setHeld(true);
  agent.sendUserText('one');
  agent.sendUserText('two');
  await settle();
  agent.setHeld(false);          // release → _flush() queues a reply over the held history
  agent.replay('older reply');   // a tap in the same tick must not eat it
  for (let i = 0; i < 40; i++) await settle();
  assert.equal(agent.history.at(-1).role, 'assistant', 'the held turns got their reply');
});

// ── Self-echo (speakers leak TTS into the mic; the agent must not interrupt itself) ───────────────

test('SELF-ECHO: isSelfEcho matches echo of the reply, passes real interruptions', async () => {
  const reply = 'Sure, I will create a landing page with a hero section and pricing table.';
  assert.equal(isSelfEcho('i will create a landing page', reply), true, 'verbatim echo');
  assert.equal(isSelfEcho('hero section and pricing', reply), true, 'mid-reply echo');
  assert.equal(isSelfEcho('no wait stop that idea', reply), false, 'real interruption');
  assert.equal(isSelfEcho('', reply), false, 'empty interim');
  assert.equal(isSelfEcho('i will create a page', ''), false, 'no reply text → no filter');
  // unicode words (accented) match too
  assert.equal(isSelfEcho('készítek egy weboldalt', 'Rendben, készítek egy weboldalt neked.'), true);
  // old echo followed by a fresh real interruption still cuts in (recent-tail window)
  assert.equal(
    isSelfEcho('i will create a landing page actually no stop please cancel that request now', reply),
    false, 'fresh interruption after echoed prefix',
  );
  // the strict final-drop profile: whole text, ≥3 matched words — a short quote is NOT echo
  assert.equal(isSelfEcho('pricing table', reply, { window: Infinity, minHits: 3 }), false, 'short quote kept');
  assert.equal(isSelfEcho('a hero section and pricing table', reply, { window: Infinity, minHits: 3 }), true);
  // MIS-heard echo (STT garbles the synthetic voice) still matches via the fuzzy word test
  assert.equal(isSelfEcho('i wil kreate a lending page', reply), true, 'misheard echo still latched');
  assert.equal(isSelfEcho('hero secsion and prising', reply), true, 'misheard mid-reply echo');
  // short words must match exactly — "no" must never fuzz into "now"/"not" of the reply
  assert.equal(isSelfEcho('no no no', 'now I will not do that'), false, 'short words stay exact');
});

test('SELF-ECHO: novelChars counts only words NOT attributable to the reply', async () => {
  const reply = 'Sure, I will create a landing page with a hero section and pricing table.';
  assert.equal(novelChars('i will create a landing page', reply), 0, 'pure echo → zero evidence');
  assert.equal(novelChars('i wil kreate a lending page', reply), 0, 'misheard echo → still zero (fuzzy)');
  assert.ok(novelChars('no wait stop that idea', reply) >= 6, 'real interruption → full evidence');
  const mixed = novelChars('a landing page stop cancel', reply);
  assert.ok(mixed >= 10 && mixed <= 12, `mixed turn → only the novel words count (got ${mixed})`);
  assert.ok(novelChars('whatever words', '') > 0, 'no reply text → everything is novel');
});

// Drive the REAL provider callbacks so the production onPartial/onFinal echo logic is under test —
// not a re-implementation. `withSttAgent` swaps in a callback-capturing STT provider, gives the fake
// TTS a real setOnProgress hook (so _replyText is populated by the PRODUCTION progress wiring, not
// poked from the test), starts a gated reply, and restores the provider registry afterwards.
async function withSttAgent(fn) {
  const { STT_PROVIDERS } = await import('./stt.js');
  const orig = STT_PROVIDERS.elevenlabs;
  let cbs;
  STT_PROVIDERS.elevenlabs = (opts) => { cbs = opts; return { open() {}, feed() {}, commit() {}, close() {}, reset() {} }; };
  try {
    const tts = makeFakeTTS();
    tts.setOnProgress = (f) => { tts._progress = f; };
    const speak = tts.speak.bind(tts);
    tts.speak = async (stream, signal) => {   // report full progress before gating, like a real TTS would
      let heard = '';
      const tapped = (async function* () { for await (const t of stream) { heard += t; yield t; } })();
      const p = speak(tapped, signal);
      await settle(); tts._progress?.(heard);
      return p;
    };
    tts.gate = true;
    const { agent, events } = makeAgent({ tts, opts: { sttProvider: 'elevenlabs' } });
    agent.sendUserText('make me a page');                    // reply "reply-to:make me a page", held open in speak()
    for (let i = 0; i < 10 && tts.speaking === 0; i++) await settle();
    await settle();                                          // let the progress hook fire → _replyText set
    assert.equal(agent.state, 'speaking');
    assert.ok(agent._replyText.length > 0, 'audible prefix populated via the production progress hook');
    await fn({ agent, tts, events, stt: cbs, finish: async () => { tts.gate = false; tts.release?.(); for (let i = 0; i < 20; i++) await settle(); } });
  } finally {
    STT_PROVIDERS.elevenlabs = orig;
  }
}
const ECHO = 'reply-to make me a page';   // what the mic hears of the reply "reply-to:make me a page"

test('SELF-ECHO: echo interim does not barge in and its final is dropped; real words cut in', () =>
  withSttAgent(async ({ agent, tts, events, stt, finish }) => {
    const before = tts.stopped;
    stt.onPartial(ECHO, 100);                               // his own voice, echoed back
    assert.equal(tts.stopped, before, 'echo interim did not stop TTS');
    assert.ok(agent._echoRef, 'turn latched as echo');

    const hist = agent.history.length;
    stt.onFinal(ECHO, 200);                                 // echo turn finalizes → dropped, no user turn
    await settle();
    assert.equal(agent.history.length, hist, 'echo final did not become a user turn');
    assert.ok(events.some((e) => e.type === 'echo'), 'echo surfaced for diagnostics');
    assert.equal(agent._echoRef, '', 'latch cleared by onFinal');

    stt.onPartial('no stop cancel that please', 300);       // real interruption → barge-in
    assert.equal(tts.stopped, before + 1, 'real words stopped TTS');
    await finish();
  }));

test('SELF-ECHO: echoed words locking into `committed` (empty live tail) stays suppressed', () =>
  withSttAgent(async ({ agent, tts, stt, finish }) => {
    const before = tts.stopped;
    stt.onPartial(ECHO, 100);                               // echo latched off the live tail
    stt.onPartial('', 150, ECHO);                           // provider locks the words: same text, now committed
    assert.equal(tts.stopped, before, 'committed-only callback did not barge in');
    assert.ok(agent._echoRef, 'empty tail did not clear the latch');
    const hist = agent.history.length;
    stt.onFinal(ECHO, 200);
    await settle();
    assert.equal(agent.history.length, hist, 'final still dropped after commit callback');
    await finish();
  }));

test('SELF-ECHO: echo landing just AFTER playback ended is still dropped (grace window)', () =>
  withSttAgent(async ({ agent, stt, finish }) => {
    await finish();                                         // reply plays out fully → state listening
    assert.equal(agent.state, 'listening');
    const hist = agent.history.length;
    stt.onPartial(ECHO, 100);                               // STT lag: echo transcribed post-playback
    stt.onFinal(ECHO, 200);
    await settle();
    assert.equal(agent.history.length, hist, 'late echo did not become a user turn');
    // …but past the grace window the same words ARE a user turn (deliberate quoting)
    agent._replyDoneAt = 0;
    stt.onPartial(ECHO, 300); stt.onFinal(ECHO, 400);
    for (let i = 0; i < 20; i++) await settle();
    assert.ok(agent.history.length > hist, 'after the grace window the words count as the user');
  }));

test('SELF-ECHO: a SHORT echo final ("Yes.") is still dropped — minHits scales with length', () =>
  withSttAgent(async ({ agent, stt, finish }) => {
    stt.onPartial('reply-to', 100);                         // echo tail latches (1/1 reply words)
    assert.ok(agent._echoRef, 'short echo interim latched');
    const hist = agent.history.length;
    stt.onFinal('reply-to', 200);                           // 1-word final: minHits 3 would keep it as a user turn
    await settle();
    assert.equal(agent.history.length, hist, 'short echo final dropped, not answered');
    await finish();
  }));

test('SELF-ECHO: previous reply still classifies echo after a new turn started (cross-turn scope)', () =>
  withSttAgent(async ({ agent, tts, stt, finish }) => {
    await finish();                                         // reply "reply-to make me a page" played out fully
    assert.ok(agent._replyText, 'first reply left an audible reference');
    // A new turn begins: _runTurn parks _replyText into _prevReplyText and clears it — but the OLD
    // reply's speakers→mic echo tail is still in flight during this pre-audio window.
    tts.gate = true;                                        // hold the new reply before its audio "plays"
    agent.sendUserText('another request');
    for (let i = 0; i < 10 && !agent._prevReplyText; i++) await settle();
    assert.ok(agent._prevReplyText.includes('reply-to'), 'old audible text parked by the production turn path');
    const hist = agent.history.length;
    stt.onPartial(ECHO, 100);                               // old reply's echo arrives after the clear
    assert.ok(agent._echoRef, 'echo of the PREVIOUS reply latched via _prevReplyText');
    stt.onFinal(ECHO, 200);
    await settle();
    assert.equal(agent.history.length, hist, 'cross-turn echo final dropped');
    await finish();
  }));

test('SELF-ECHO: a mixed final (echo latch but real user words) is KEPT as a user turn', () =>
  withSttAgent(async ({ agent, stt, finish }) => {
    stt.onPartial(ECHO, 100);                               // echo tail latches the turn
    assert.ok(agent._echoRef);
    await finish();
    // …but the FINAL is mostly real user words → strict check fails → kept as a user turn
    const hist = agent.history.length;
    stt.onFinal(`${ECHO} actually build a pricing table instead please thanks`, 300);
    for (let i = 0; i < 20; i++) await settle();
    assert.ok(agent.history.length > hist, 'mixed final became a real user turn');

    // and an EMPTY final clears the latch instead of leaking it into the next turn
    stt.onPartial(ECHO, 400);
    assert.ok(agent._echoRef);
    stt.onFinal('', 500);
    assert.equal(agent._echoRef, '', 'empty final cleared the echo latch');
  }));

test('SELF-ECHO: words ahead of the lagging cursor still latch (clip-bounded scope)', () =>
  withSttAgent(async ({ agent, tts, stt, finish }) => {
    // The proportional cursor lags real audio: report cursor = "reply-to" but scope = the whole
    // clip. Echo of the AHEAD part ("make me a page") must latch instead of barging in.
    tts._progress?.('reply-to', 'reply-to:make me a page');
    assert.equal(agent._replyText, 'reply-to', 'cursor holds the lagging estimate');
    assert.ok(agent._replyEcho.includes('make me a page'), 'echo reference covers the whole clip');
    const stops = tts.stopped;
    stt.onPartial('make me a page', 100);                   // echo of words the cursor has not reached
    assert.ok(agent._echoRef, 'latched via the clip-bounded scope, not the cursor');
    assert.equal(tts.stopped, stops, 'no self-barge-in on ahead-of-cursor echo');
    stt.onFinal('', 150);                                   // close the echo turn
    await finish();
  }));

test('SELF-ECHO: a barged-in reply clamps the echo reference to the HEARD prefix', async () => {
  // TTS reports the whole clip as scope while playing, but speak() resolves with only the heard
  // prefix (barge-in). The clip-bounded reference must be clamped back: the unspoken remainder
  // never hit the speakers, so a user quoting it must not be swallowed as echo.
  const tts = {
    _progress: null,
    setOnProgress(f) { tts._progress = f; },
    async speak(stream /*, signal */) {
      let full = '';
      for await (const t of stream) full += t;
      tts._progress?.('reply-to', full);        // cursor lags, scope = whole reply
      return 'reply-to';                        // barge-in: only this was heard
    },
    stop() {},
  };
  const { agent } = makeAgent({ tts });
  agent.sendUserText('make me a page');
  for (let i = 0; i < 20; i++) await settle();
  assert.equal(agent._replyText, 'reply-to');
  assert.equal(agent._replyEcho, 'reply-to',
    'clamped: unspoken remainder is not echo-eligible after playback stopped');
});

// ── TOOLS: the host `tools` map contract ─────────────────────────────────────────────────────────
// Tools without a run() are dropped, never advertised to the LLM.

test('TOOLS: runless tools are dropped, never advertised', () => {
  const { agent } = makeAgent({ opts: {
    tools: { ghost: { description: 'no run at all' } },
  } });
  assert.equal(agent.tools.ghost, undefined, 'runless tool never advertised');
});

test('TOOLS: a full custom tool passes through untouched', () => {
  const run = () => 'ok';
  const { agent } = makeAgent({ opts: { tools: { get_view: { description: 'V', params: {}, run } } } });
  assert.equal(agent.tools.get_view.run, run);
  assert.equal(agent.tools.get_view.description, 'V');
});

// ── Speculative LLM prefetch ────────────────────────────────────────────────────────────────────
// The agent starts generating a reply once the interim has been stable for PREFETCH_MS, overlapping
// LLM TTFT with the end-of-turn debounce. These lock in: exact-match adoption (one llm call, not
// two), abort on transcript change, and that typed turns / holds / mutes / stops never leak or
// wrongly adopt a speculation.

import { TUNING } from './tuning.js';

// llm fake that records every call + its abort signal (yields synchronously on the first pull).
function makeTrackedLLM() {
  const calls = [];
  const llm = async function* (history, sys, signal) {
    const call = { text: [...history].reverse().find((m) => m.role === 'user')?.content, signal, history: history.map((m) => m.role) };
    calls.push(call);
    yield { text: `reply-to:${call.text}` };
  };
  return { llm, calls };
}

async function withPrefetchAgent(fn) {
  const { STT_PROVIDERS } = await import('./stt.js');
  const orig = STT_PROVIDERS.elevenlabs;
  const origMs = TUNING.PREFETCH_MS;
  TUNING.PREFETCH_MS = 5;
  let cbs;
  STT_PROVIDERS.elevenlabs = (opts) => { cbs = opts; return { open() {}, feed() {}, commit() {}, close() {}, reset() {} }; };
  try {
    const { llm, calls } = makeTrackedLLM();
    const { agent, events } = makeAgent({ llm, opts: { sttProvider: 'elevenlabs' } });
    agent._set('listening');   // prefetch only speculates while listening (no start(): no mic in tests)
    const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));
    await fn({ agent, events, stt: cbs, calls, tick });
    agent.destroy?.();
  } finally {
    STT_PROVIDERS.elevenlabs = orig; TUNING.PREFETCH_MS = origMs;
  }
}

test('PREFETCH: stable interim starts ONE llm call; matching final adopts it (no second call)', () =>
  withPrefetchAgent(async ({ agent, stt, calls, tick }) => {
    stt.onPartial('build a page', 100);
    await tick();                                        // > PREFETCH_MS → speculation fires
    assert.equal(calls.length, 1, 'speculative call started during the debounce');
    assert.equal(calls[0].text, 'build a page');
    stt.onFinal('build a page', 300);                    // turn closes with the exact same text
    for (let i = 0; i < 20; i++) await settle();
    assert.equal(calls.length, 1, 'adopted — no duplicate llm call');
    assert.ok(!calls[0].signal.aborted, 'adopted stream was not aborted');
    assert.equal(agent.history.at(-1)?.role, 'assistant');
    assert.equal(agent.history.at(-1)?.content, 'reply-to:build a page');
  }));

test('PREFETCH: changed transcript aborts the stale speculation immediately; final regenerates', () =>
  withPrefetchAgent(async ({ agent, stt, calls, tick }) => {
    stt.onPartial('build a page', 100);
    await tick();
    assert.equal(calls.length, 1);
    stt.onPartial('build a page with pricing', 200);     // user kept talking → old speculation is stale
    assert.ok(calls[0].signal.aborted, 'stale prefetch aborted on the very next partial');
    await tick();                                        // stability timer for the NEW text
    assert.equal(calls[1]?.text, 'build a page with pricing');
    stt.onFinal('build a page with pricing table', 400); // final differs again → mismatch, fresh call
    for (let i = 0; i < 20; i++) await settle();
    assert.ok(calls[1].signal.aborted, 'mismatched speculation aborted at adoption');
    assert.equal(calls.at(-1).text, 'build a page with pricing table');
  }));

test('PREFETCH: typed turn never adopts a speech speculation, even with identical text', () =>
  withPrefetchAgent(async ({ agent, stt, calls, tick }) => {
    stt.onPartial('hello there', 100);
    await tick();
    assert.equal(calls.length, 1);
    agent.sendUserText('hello there');                   // typed — must NOT claim the speech prefetch
    for (let i = 0; i < 20; i++) await settle();
    assert.ok(calls[0].signal.aborted, 'speech speculation dropped');
    assert.equal(calls.length, 2, 'typed turn generated its own reply');
  }));

test('PREFETCH: empty final, hold and mute all drop the speculation (no leaks)', () =>
  withPrefetchAgent(async ({ agent, stt, calls, tick }) => {
    stt.onPartial('noise words', 100); await tick();
    stt.onFinal('', 200);                                // empty close
    assert.ok(calls[0].signal.aborted, 'empty final dropped it');
    stt.onPartial('hold me', 300); await tick();
    agent.setHeld(true);
    assert.ok(calls[1].signal.aborted, 'hold entry dropped it');
    agent.setHeld(false); await settle(); agent._set('listening');
    stt.onPartial('mute me', 400); await tick();
    agent.setMuted(true);
    assert.ok(calls[2].signal.aborted, 'mute dropped it');
  }));

test('PREFETCH: timer firing after the final has cleared the interim does not speculate', () =>
  withPrefetchAgent(async ({ agent, stt, calls, tick }) => {
    stt.onPartial('quick words', 100);
    stt.onFinal('quick words', 120);                     // final lands BEFORE the stability timer fires
    await tick();
    for (let i = 0; i < 20; i++) await settle();
    assert.equal(calls.length, 1, 'exactly the turn call — no post-final speculation');
    assert.ok(agent._prefetch == null && agent._prefetchTimer == null, 'nothing left armed');
  }));

test('PREFETCH: history that grew since speculation (histLen mismatch) rejects adoption', () =>
  withPrefetchAgent(async ({ agent, stt, calls, tick }) => {
    stt.onPartial('what about that', 100); await tick();
    assert.equal(calls.length, 1);
    // A raced turn commits its assistant message AFTER the speculation snapshotted history —
    // the prefetched request is missing that context and must be regenerated, not adopted.
    agent.history.push({ role: 'assistant', content: 'late-committed reply' });
    stt.onFinal('what about that', 300);
    for (let i = 0; i < 20; i++) await settle();
    assert.ok(calls[0].signal.aborted, 'stale-base speculation aborted');
    assert.equal(calls.length, 2, 'regenerated with the full history');
    assert.ok(calls[1].history.includes('assistant'), 'fresh call saw the late assistant message');
  }));

test('PREFETCH: stop() aborts an in-flight speculation', () =>
  withPrefetchAgent(async ({ agent, stt, calls, tick }) => {
    stt.onPartial('about to stop', 100); await tick();
    assert.equal(calls.length, 1);
    agent.stop();
    assert.ok(calls[0].signal.aborted);
    assert.equal(agent._prefetch, null);
  }));

// ── [TOOL CALL] mimicry filter ──────────────────────────────────────────────────────────────────
// The model sometimes TYPES a `[TOOL CALL name] {...}` ledger line into its reply instead of
// calling the tool natively (it learned the format from its own history). The stream filter must
// convert a bare typed call into a REAL tool run, drop remembered ones (with → outcome), and never
// leak the markup into the spoken/visible text.

test('MIMICRY: a typed [TOOL CALL] line runs the tool and never reaches the reply text', async () => {
  const runs = [];
  const llm = async function* () {
    yield { text: 'Megkeresem.\n' };
    yield { text: '[TOOL CALL run_shell] {"cmd":"tfa-memory search \\"builtin\\""}' };
    yield { text: '\nMindjárt megvan.' };
  };
  const { agent, tts } = makeAgent({ llm, opts: { tools: { run_shell: { description: '', params: {}, run: (a) => { runs.push(a); return 'ok'; } } } } });
  agent.sendUserText('keresd meg');
  for (let i = 0; i < 40; i++) await settle();
  assert.equal(runs.length, 1, 'the typed call became a real tool run');
  assert.equal(runs[0].cmd, 'tfa-memory search "builtin"');
  const said = agent.history.filter((m) => m.role === 'assistant').map((m) => m.content).join('\n');
  // History keeps ONE ledger line (from the real run), but the spoken text is markup-free.
  assert.ok(!said.split('\n').some((l) => !l.startsWith('[TOOL CALL') && l.includes('[TOOL CALL')), 'no markup inside spoken lines');
  assert.ok(said.includes('Megkeresem.'), 'surrounding prose survived');
  assert.ok(said.includes('Mindjárt megvan.'), 'text after the line survived');
});

test('MIMICRY: a remembered call (with → outcome) is dropped, not re-executed', async () => {
  const runs = [];
  const llm = async function* () {
    yield { text: 'Ezt már megnéztem.\n[TOOL CALL run_shell] {"cmd":"ls"} → file1 file2\nNincs benne.' };
  };
  const { agent } = makeAgent({ llm, opts: { tools: { run_shell: { description: '', params: {}, run: (a) => { runs.push(a); return 'ok'; } } } } });
  agent.sendUserText('nézd meg');
  for (let i = 0; i < 40; i++) await settle();
  assert.equal(runs.length, 0, 'a hallucinated past call never re-executes');
  const said = agent.history.filter((m) => m.role === 'assistant').map((m) => m.content).join('\n');
  assert.ok(!said.includes('[TOOL CALL'), 'the remembered line is gone');
  assert.ok(said.includes('Ezt már megnéztem.') && said.includes('Nincs benne.'));
});

test('MIMICRY: a typed call duplicated by the native tool_use runs once', async () => {
  const runs = [];
  const llm = async function* () {
    yield { tool: 'run_shell', args: { cmd: 'ls' } };
    yield { text: '[TOOL CALL run_shell] {"cmd":"ls"}\ndone' };
  };
  const { agent } = makeAgent({ llm, opts: { tools: { run_shell: { description: '', params: {}, run: (a) => { runs.push(a); return 'ok'; } } } } });
  agent.sendUserText('go');
  for (let i = 0; i < 40; i++) await settle();
  assert.equal(runs.length, 1, 'dedup collapsed the typed echo of the native call');
});

test('MIMICRY: marker split across stream chunks is still caught; plain brackets pass through', async () => {
  const runs = [];
  const llm = async function* () {
    yield { text: 'ok [TOO' };
    yield { text: 'L CALL run_shell] {"cmd":"pwd"}\n' };
    yield { text: 'see [brackets] stay' };
  };
  const { agent } = makeAgent({ llm, opts: { tools: { run_shell: { description: '', params: {}, run: (a) => { runs.push(a); return 'ok'; } } } } });
  agent.sendUserText('go');
  for (let i = 0; i < 40; i++) await settle();
  assert.equal(runs.length, 1, 'split marker reassembled into a real run');
  const said = agent.history.filter((m) => m.role === 'assistant').map((m) => m.content).join('\n');
  assert.ok(said.includes('[brackets] stay'), 'ordinary bracketed text is untouched');
});

test('MIMICRY: typed echo of an id-carrying native call (agent-loop) does not re-execute', async () => {
  const runs = [];
  const llm = async function* () {
    // Loop-mode chunk: id + attached result — the loop already executed it.
    yield { tool: 'run_shell', id: 'call-1', args: { cmd: 'ls' }, result: 'file1' };
    yield { text: 'Lefuttattam.\n[TOOL CALL run_shell] {"cmd":"ls"}\n' };
  };
  const { agent } = makeAgent({ llm, opts: { tools: { run_shell: { description: '', params: {}, run: (a) => { runs.push(a); return 'ok'; } } } } });
  agent.sendUserText('go');
  for (let i = 0; i < 40; i++) await settle();
  assert.equal(runs.length, 0, 'the typed echo must not execute what the loop already ran');
});

test('MIMICRY: a false-alarm line keeps its newline when passed through', async () => {
  const llm = async function* () {
    yield { text: '[TOOL CALL bad name] not the format\nnext line' };   // space in name → not the ledger format
  };
  const { agent } = makeAgent({ llm, opts: {} });
  agent.sendUserText('go');
  for (let i = 0; i < 40; i++) await settle();
  const said = agent.history.filter((m) => m.role === 'assistant').map((m) => m.content).join('\n');
  assert.ok(said.includes('[TOOL CALL bad name] not the format\nnext line'), 'line boundary preserved on passthrough');
});

test('MIMICRY: a truncated/unparseable typed call is dropped silently', async () => {
  const runs = [];
  const llm = async function* () {
    yield { text: '[TOOL CALL run_shell] {"cmd":"tfa-memory search \\"cut off' };  // stream died mid-JSON
  };
  const { agent } = makeAgent({ llm, opts: { tools: { run_shell: { description: '', params: {}, run: (a) => { runs.push(a); return 'ok'; } } } } });
  agent.sendUserText('go');
  for (let i = 0; i < 40; i++) await settle();
  assert.equal(runs.length, 0, 'half a command must not execute');
  const said = agent.history.filter((m) => m.role === 'assistant').map((m) => m.content).join('\n');
  assert.ok(!said.includes('[TOOL CALL'), 'the broken markup did not leak');
});

// ── Liveness: host code that never returns must not wedge the turn loop ─────────────────────────
// The turn loop is strictly serialized, so anything it awaits can wedge it permanently. Three hooks
// are host-supplied; these lock in that none of them can. Each test races a deadline so a
// REGRESSION FAILS the suite instead of hanging it forever.

const before = (ms, p, what) => Promise.race([
  p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} did not settle in ${ms}ms`)), ms)),
]);

test('LIVENESS: a turnDetector that never returns still force-closes the turn at maxPauseMs', async () => {
  const { agent, events } = makeAgent({ opts: { turnDetector: () => new Promise(() => {}), maxPauseMs: 30 } });
  const committed = [];
  agent.stt = { commit: () => committed.push(1), reset() {}, feed() {} };
  agent._turnText = 'is anyone there';
  agent._speaking = false;
  await before(2000, agent._endOfSpeech(), 'end-of-speech with a hung turnDetector');
  assert.equal(committed.length, 1, 'the hung detector did not hold the turn open forever');
  assert.ok(events.some((e) => e.type === 'error' && /no verdict/.test(e.error)), 'the hang is reported, not silent');
});

test('LIVENESS: maxPauseMs is ONE deadline — a slow "not yet" verdict does not buy a fresh window', async () => {
  const MAX = 300;   // generous budget: the old two-window bug lands at ~1.6x, well clear of the 1.45x bar
  const { agent } = makeAgent({ opts: { maxPauseMs: MAX, turnDetector: () => new Promise((r) => setTimeout(() => r(false), MAX * 0.6)) } });
  let closedAt = 0;
  const started = Date.now();
  agent.stt = { commit: () => { closedAt = Date.now(); }, reset() {}, feed() {} };
  agent._turnText = 'i was saying';
  agent._speaking = false;
  await agent._endOfSpeech();
  await new Promise((r) => setTimeout(r, MAX));
  assert.ok(closedAt, 'the turn still closes at the deadline');
  const held = closedAt - started;
  assert.ok(held < MAX * 1.45, `turn held ${held}ms — must stay within the documented ${MAX}ms cap, not ~2x it`);
});

test('LIVENESS: a live turnDetector verdict is still honored (no timeout regression)', async () => {
  const { agent } = makeAgent({ opts: { turnDetector: async () => false, maxPauseMs: 10_000 } });
  const committed = [];
  agent.stt = { commit: () => committed.push(1), reset() {}, feed() {} };
  agent._turnText = 'wait i am still';
  agent._speaking = false;
  await agent._endOfSpeech();
  assert.equal(committed.length, 0, 'false verdict keeps listening — the cap must not pre-empt a real answer');
  clearTimeout(agent._maxPause);
});

test('LIVENESS: a turnDetector abandoned because the user resumed reports no error', async () => {
  const { agent, events } = makeAgent({ opts: { turnDetector: () => new Promise(() => {}), maxPauseMs: 30 } });
  agent.stt = { commit() {}, reset() {}, feed() {} };
  agent._turnText = 'hold on';
  agent._speaking = false;
  const p = agent._endOfSpeech();
  agent._onSpeechStart();                                  // user resumed while the detector deliberated
  await before(2000, p, 'end-of-speech');
  assert.ok(!events.some((e) => e.type === 'error'), 'a verdict nobody needed anymore is not an error');
});

test('LIVENESS: a hung tool does not block the turn (tools are dispatched, never joined)', async () => {
  const llm = async function* () { yield { tool: 'stuck', args: {} }; yield { text: 'On it.' }; };
  const { agent } = makeAgent({ llm, opts: { tools: { stuck: { description: '', params: {}, run: () => new Promise(() => {}) } } } });
  agent.sendUserText('go');
  await before(2000, agent._turn, 'the turn');             // the bug was this never resolving
  assert.equal(agent.state, 'listening', 'the agent is ready for the next turn');
  const said = agent.history.filter((m) => m.role === 'assistant').map((m) => m.content).join('\n');
  assert.ok(said.includes('[TOOL CALL stuck]'), 'the dispatch is recorded even though the tool never returned');
});

test('LIVENESS: a hung tool is not re-called by the next turn (the ledger stands in for its result)', async () => {
  let runs = 0;
  // Re-calls the tool unless the history already shows it was dispatched.
  const llm = async function* (history) {
    if (history.some((m) => m.content?.includes('[TOOL CALL stuck]'))) { yield { text: 'Still waiting.' }; return; }
    yield { tool: 'stuck', args: {} }; yield { text: 'On it.' };
  };
  const { agent } = makeAgent({ llm, opts: { tools: { stuck: { description: '', params: {}, run: () => { runs++; return new Promise(() => {}); } } } } });
  agent.sendUserText('go');
  await before(2000, agent._turn, 'the first turn');
  agent.sendUserText('and now?');
  await before(2000, agent._turn, 'the second turn');
  assert.equal(runs, 1, 'the still-running tool was not dispatched a second time');
});

test('LIVENESS: a hung tool does not block the turn on the TTS-ERROR exit path either', async () => {
  const llm = async function* () { yield { tool: 'stuck', args: {} }; yield { text: 'On it.' }; };
  // A TTS that drains the stream (so the tool dispatches) and then fails the reply.
  const tts = { async speak(stream) { for await (const _ of stream) { /* drain */ } throw new Error('synth exploded'); }, stop() {} };
  const { agent, events } = makeAgent({ llm, tts, opts: { tools: { stuck: { description: '', params: {}, run: () => new Promise(() => {}) } } } });
  agent.sendUserText('go');
  await before(2000, agent._turn, 'the turn whose TTS failed');
  assert.ok(events.some((e) => e.type === 'error' && /synth exploded/.test(e.error)), 'the TTS failure is surfaced');
  const said = agent.history.filter((m) => m.role === 'assistant').map((m) => m.content).join('\n');
  assert.ok(said.includes('[TOOL CALL stuck]'), 'the dispatch is still ledgered on the error path');
});

test('LIVENESS: a tool that awaits notify() completes instead of deadlocking against its own turn', async () => {
  const llm = async function* (history) {
    if (history.some((m) => m.content?.includes('[TOOL RESULT'))) { yield { text: 'It is sunny.' }; return; }
    yield { tool: 'weather', args: {} }; yield { text: 'Checking.' };
  };
  let settled = false;
  const { agent } = makeAgent({ llm, opts: {} });
  agent.tools = { weather: { description: '', params: {}, run: async () => {
    await agent.notify('[TOOL RESULT weather] sunny');     // queues behind the turn that dispatched us
    settled = true; return 'sunny';
  } } };
  agent.sendUserText('weather?');
  await before(2000, agent._turn, 'the dispatching turn');
  for (let i = 0; i < 60; i++) await settle();
  assert.ok(settled, 'the tool ran to completion — joining it at turn end would deadlock here');
});

test('LIVENESS: a normal tool still reports its real result', async () => {
  const llm = async function* () { yield { tool: 'fast', args: { x: 1 } }; yield { text: 'Done.' }; };
  const { agent, events } = makeAgent({ llm, opts: { tools: { fast: { description: '', params: {}, run: async () => 'ok' } } } });
  agent.sendUserText('go');
  await before(2000, agent._turn, 'the turn');
  for (let i = 0; i < 20; i++) await settle();
  const tool = events.find((e) => e.type === 'tool');
  assert.equal(tool.result, 'ok', 'the real result is reported');
  assert.ok(!events.some((e) => e.type === 'error'), 'no spurious failure');
});

// ── Tool-executing adapters: running markers + the commit gate ───────────────────────────────────
// An adapter that runs tools inside its own generator (llm.executesTools) may announce a call with
// `running: true` before executing, so the host shows a live spinner chip the outcome replaces in
// place (same id). A turn dying mid-execution must resolve every announced call — a spinner may
// never be left stuck. Speculative prefetch stays OFF for such an adapter unless it also honors the
// commit gate (llm.acceptsToolGate), which holds tools at the door until the turn commits.

test('RUNNING: announcement is reported, replaced by the outcome, and never executed by the agent', async () => {
  const runs = [];
  const llm = async function* () {
    yield { tool: 'run_shell', id: 'c1', args: { cmd: 'ls' }, running: true };    // adapter: executing now
    yield { tool: 'run_shell', id: 'c1', args: { cmd: 'ls' }, result: 'file1' };  // adapter: outcome attached
    yield { text: 'one file.' };
  };
  const { agent, events } = makeAgent({ llm, opts: { tools: { run_shell: { description: '', params: {}, run: (a) => { runs.push(a); return 'never'; } } } } });
  agent.sendUserText('go');
  for (let i = 0; i < 40; i++) await settle();
  assert.equal(runs.length, 0, 'both chunks belong to the adapter-executed call — the agent runs nothing');
  const tools = events.filter((e) => e.type === 'tool');
  assert.deepEqual(tools[0], { type: 'tool', name: 'run_shell', id: 'c1', args: { cmd: 'ls' }, running: true });
  assert.deepEqual(tools[1], { type: 'tool', name: 'run_shell', id: 'c1', args: { cmd: 'ls' }, result: 'file1' });
  // Ledger records the call ONCE, with its outcome (the running marker adds nothing).
  const said = agent.history[agent.history.length - 1].content;
  assert.equal((said.match(/\[TOOL CALL run_shell\]/g) || []).length, 1);
  assert.match(said, /→ file1/);
});

test('RUNNING: a turn dying mid-execution finalizes the announced call as interrupted', async () => {
  const llm = async function* () {
    yield { tool: 'run_shell', id: 'c9', args: { cmd: 'sleep 99' }, running: true };
    throw new Error('stream died');   // outcome never arrives
  };
  const { agent, events } = makeAgent({ llm });
  agent.sendUserText('go');
  for (let i = 0; i < 40; i++) await settle();
  const final = events.filter((e) => e.type === 'tool' && !e.running).pop();
  assert.ok(final, 'the announced call got a resolving event');
  assert.deepEqual(final.result, { ok: false, text: 'interrupted — did not finish' });
  assert.equal(final.id, 'c9', 'resolves the SAME chip the announcement opened');
  // Never executed and never observed → not in the ledger; the next turn may call it fresh.
  const said = agent.history.filter((m) => m.role === 'assistant').map((m) => m.content).join('\n');
  assert.ok(!said.includes('[TOOL CALL run_shell]'));
});

test('GATE: an executesTools adapter without acceptsToolGate is never speculated on', async () => {
  let started = 0;
  const llm = async function* () { started++; yield { text: 'hi' }; };
  llm.executesTools = true;
  const { agent } = makeAgent({ llm });
  agent.state = 'listening'; agent._turnText = 'are you there';   // _startPrefetch revalidates the live transcript
  agent._startPrefetch('are you there');
  for (let i = 0; i < 10; i++) await settle();
  assert.equal(started, 0, 'no speculation: an ungated tool run could fire a side effect');
  assert.equal(agent._prefetch, null);
});

test('GATE: an acceptsToolGate adapter IS speculated on, and tools wait for the commit', async () => {
  let gate = null, ran = false;
  const llm = async function* (_h, _s, _sig, { toolGate } = {}) {
    gate = toolGate;
    yield { text: 'work' };
    await toolGate;                       // the adapter's beforeToolCall hook, in miniature
    ran = true;
    yield { tool: 'send_email', id: 'e1', args: {}, result: 'sent' };
  };
  llm.executesTools = true; llm.acceptsToolGate = true;
  const { agent } = makeAgent({ llm });
  agent.state = 'listening'; agent._turnText = 'email bob';   // _startPrefetch revalidates the live transcript
  agent._startPrefetch('email bob');
  for (let i = 0; i < 10; i++) await settle();
  assert.ok(agent._prefetch, 'speculation started — text streams ahead');
  assert.ok(gate instanceof Promise, 'the adapter was handed a commit gate');
  assert.equal(ran, false, 'the side effect is held at the door while the user may still change the turn');
  const pf = agent._takePrefetch('email bob');
  assert.ok(pf, 'the speculation is adopted by the matching spoken final');
  for await (const _ of pf.gen) { /* drain */ }
  assert.equal(ran, true, 'committing the turn opens the gate');
});

test('GATE: a dropped speculation rejects the gate — no side effect, and the generator unwinds', async () => {
  let ran = false, unwound = false;
  // Tool BEFORE any text, so the very first gen.next() genuinely PARKS on the gate — a text-first
  // generator would be suspended at its yield instead and gen.return() alone would close it, which
  // proves nothing about the gate.
  const llm = async function* (_h, _s, _sig, { toolGate } = {}) {
    try {
      await toolGate;                     // the naive contract: no abort race
      ran = true;
      yield { tool: 'send_email', id: 'e1', args: {}, result: 'sent' };
    } finally { unwound = true; }
  };
  llm.executesTools = true; llm.acceptsToolGate = true;
  const { agent } = makeAgent({ llm });
  agent.state = 'listening'; agent._turnText = 'email bob';
  agent._startPrefetch('email bob');
  for (let i = 0; i < 10; i++) await settle();
  agent._dropPrefetch();                  // user kept talking → the speculation is discarded
  for (let i = 0; i < 20; i++) await settle();
  assert.equal(ran, false, 'an abandoned speculation must never execute its tools');
  assert.equal(unwound, true, 'the gate rejected, so the generator unwound — no leaked fetch/iterator');
});

test('GATE: an adapter that only awaits the gate is not left hanging when the turn is superseded', async () => {
  let unwound = false;
  const llm = async function* (_h, _s, _sig, { toolGate } = {}) {
    try { await toolGate; yield { text: 'sent' }; } finally { unwound = true; }
  };
  llm.executesTools = true; llm.acceptsToolGate = true;
  const { agent } = makeAgent({ llm });
  agent.state = 'listening'; agent._turnText = 'a';
  agent._startPrefetch('a');
  for (let i = 0; i < 5; i++) await settle();
  agent._turnText = 'a b';                // transcript moved on
  agent._startPrefetch('a b');            // supersedes → drops the previous speculation
  for (let i = 0; i < 20; i++) await settle();
  assert.equal(unwound, true, 'the superseded speculation unwound instead of parking forever');
});

test('RUNNING: a late announcement from a detached producer cannot open a stuck spinner', async () => {
  let release;
  const held = new Promise((r) => { release = r; });
  const llm = async function* () {
    yield { text: 'thinking.' };
    await held;                                          // producer detached by the turn ending
    yield { tool: 'run_shell', id: 'late', args: {}, running: true };
  };
  // Barge-in TTS: returns after the first chunk but leaves the pump DRAINING in the background —
  // exactly what speak() detaches, a producer that wakes and keeps pushing after the turn is over.
  const tts = {
    setOnProgress() {},
    async speak(stream) {
      const it = stream[Symbol.asyncIterator]();
      const { value } = await it.next();
      (async () => { while (!(await it.next()).done); })().catch(() => {});   // detached pump
      return value ?? '';
    },
    stop() {},
  };
  const { agent, events } = makeAgent({ llm, tts });
  agent.sendUserText('go');
  for (let i = 0; i < 40; i++) await settle();
  const before = events.filter((e) => e.type === 'tool').length;
  release();                                             // wakes AFTER the turn finalized its chips
  for (let i = 0; i < 40; i++) await settle();
  const after = events.filter((e) => e.type === 'tool');
  assert.equal(after.length, before, 'no spinner opened after the turn finalized');
  assert.ok(!after.some((e) => e.running), 'and certainly no unresolved running chip');
});

test('RUNNING: an id-less announcement is dropped (it could never be replaced or finalized)', async () => {
  const llm = async function* () {
    yield { tool: 'run_shell', args: { cmd: 'ls' }, running: true };   // no id
    throw new Error('stream died');
  };
  const { agent, events } = makeAgent({ llm });
  agent.sendUserText('go');
  for (let i = 0; i < 40; i++) await settle();
  assert.ok(!events.some((e) => e.type === 'tool' && e.running), 'never rendered as a chip');
  assert.ok(!events.some((e) => e.type === 'tool' && e.result?.text?.includes('interrupted')),
    'and so never needs an interrupted resolution');
});

test('RUNNING: a re-emitted running/outcome pair does not resurrect a settled chip', async () => {
  const llm = async function* () {
    yield { tool: 'run_shell', id: 'c1', args: { cmd: 'ls' }, running: true };
    yield { tool: 'run_shell', id: 'c1', args: { cmd: 'ls' }, result: 'file1' };
    yield { tool: 'run_shell', id: 'c1', args: { cmd: 'ls' }, running: true };    // adapter re-emits
    yield { tool: 'run_shell', id: 'c1', args: { cmd: 'ls' }, result: 'file1' };
    yield { text: 'one file.' };
  };
  const { agent, events } = makeAgent({ llm });
  agent.sendUserText('go');
  for (let i = 0; i < 40; i++) await settle();
  const tools = events.filter((e) => e.type === 'tool');
  assert.equal(tools.filter((e) => e.running).length, 1, 'the settled chip is not reopened');
  assert.equal(tools.filter((e) => !e.running).length, 1, 'and its outcome is reported once');
  assert.ok(!tools.some((e) => e.result?.text?.includes('interrupted')), 'never falsely interrupted');
});
