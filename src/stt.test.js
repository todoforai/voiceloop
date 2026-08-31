// stt.test.js — headless regression tests for the Speechmatics STT turn-boundary state machine.
// No browser/network: we drive makeSpeechmaticsSTT directly, stub fetch + WebSocket, and feed it
// the exact event orderings that matter. Run: `node --test packages/shared-voice/src/stt.test.js`.
//
// These lock in the LOCKED-WORDS-ONLY model: a turn closes on Speechmatics' EndOfUtterance (after our
// ForceEndOfUtterance or its silence trigger), the final is exactly the AddTranscript-locked words
// (never a folded tail), and a single monotonic cursor drops out-of-order stragglers from a closed
// turn so they can't leak into the next one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSpeechmaticsSTT, resolveSttProvider, WEBSPEECH_FALLBACK } from './stt.js';

// ── Minimal fakes ─────────────────────────────────────────────────────────────────────────────
// A fake WebSocket we can drive: capture what the STT sends, and hand it server messages on demand.
class FakeWS {
  constructor(url, protocols) { this.url = url; this.protocols = protocols; this.readyState = 1; this.sent = []; this.binaryType = ''; FakeWS.last = this; }
  send(data) { this.sent.push(data); }
  close() { this.readyState = 3; this.onclose?.({ code: 1000, reason: '' }); }
  // Push a server → client JSON message.
  recv(obj) { this.onmessage?.({ data: JSON.stringify(obj) }); }
}

// Install global stubs (fetch → token, WebSocket → FakeWS) for the duration of a test.
function withStubs(fn) {
  const realFetch = globalThis.fetch, realWS = globalThis.WebSocket, realPerf = globalThis.performance;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ token: 'tok' }) });
  globalThis.WebSocket = FakeWS;
  globalThis.performance = globalThis.performance ?? { now: () => Date.now() };
  return Promise.resolve(fn()).finally(() => {
    globalThis.fetch = realFetch; globalThis.WebSocket = realWS; globalThis.performance = realPerf;
  });
}

// Build an STT instance wired to record every onPartial/onFinal, and open + RecognitionStarted it.
async function makeSTT() {
  const events = { partials: [], finals: [] };
  const stt = makeSpeechmaticsSTT({
    apiKey: 'k', sttTokenUrl: 'http://x/api/v1/stt/token', sttModel: 'standard', sttLang: 'en',
    onPartial: (text, ms, committed = '') => events.partials.push({ text, committed }),
    onFinal: (text) => events.finals.push(text),
    onError: () => {}, onFatal: () => {}, onClose: () => {}, isClosed: () => false,
  });
  // feed() lazily opens the socket (async). Drive one frame, let the open() promise resolve, then
  // deliver RecognitionStarted so the socket is "started" and audio/forceEnds flush.
  const frame = new Int16Array(1600);   // 0.1s @16k
  stt.feed(frame);
  await new Promise((r) => setTimeout(r, 0));   // let open()'s awaited token fetch settle
  FakeWS.last.onopen?.();
  FakeWS.last.recv({ message: 'RecognitionStarted' });
  return { stt, events, ws: () => FakeWS.last, frame };
}

const word = (ws, transcript, end) =>
  ws.recv({ message: 'AddTranscript', metadata: { transcript, end_time: end } });
const partial = (ws, transcript, end) =>
  ws.recv({ message: 'AddPartialTranscript', metadata: { transcript, end_time: end } });
const eou = (ws) => ws.recv({ message: 'EndOfUtterance' });
// Assert the STT sent a ForceEndOfUtterance since the last check (commit() → the socket).
const forcedEnd = (ws) => ws.sent.some((s) => typeof s === 'string' && JSON.parse(s).message === 'ForceEndOfUtterance');

// ── Tests ───────────────────────────────────────────────────────────────────────────────────────

test('two clean sequential turns both finalize on EndOfUtterance (locked words only)', () => withStubs(async () => {
  const { stt, events, ws, frame } = await makeSTT();

  // Turn A: partial tail flickers, words lock via AddTranscript, commit → ForceEndOfUtterance, EndOfUtterance closes.
  partial(ws(), 'hello there', 0.5);  // interim tail (never committed)
  word(ws(), 'hello there', 1.0);     // words locked into `committed`
  stt.commit();                       // VAD speech-end → ForceEndOfUtterance
  assert.ok(forcedEnd(ws()), 'commit sent ForceEndOfUtterance');
  eou(ws());                          // Speechmatics closes the turn
  assert.deepEqual(events.finals, ['hello there'], 'A finalized on the locked words');

  // Turn B (agent calls reset() on the fresh speech-start). Stream times are absolute/monotonic.
  stt.reset();
  stt.feed(frame);
  partial(ws(), 'second turn', 2.0);
  word(ws(), 'second turn', 2.5);
  stt.commit();
  eou(ws());
  assert.deepEqual(events.finals, ['hello there', 'second turn'], 'B finalized too');
}));

test('Speechmatics closes a turn ITSELF (silence trigger) with no commit — locked words are the final', () => withStubs(async () => {
  const { stt, events, ws } = await makeSTT();
  partial(ws(), 'no commit needed', 0.5);
  word(ws(), 'no commit needed', 1.0);
  eou(ws());                          // silence-triggered EndOfUtterance, no ForceEndOfUtterance
  assert.deepEqual(events.finals, ['no commit needed'], 'closed on the locked words without a commit');
}));

test('empty finalization closes the turn (always calls onFinal) without emitting a user turn', () => withStubs(async () => {
  const { stt, events, ws } = await makeSTT();
  // Audio was fed but no words locked (e.g. only noise): commit → ForceEndOfUtterance, EndOfUtterance
  // closes on the empty `committed`. The agent still gets an onFinal so it can clear _turnClosing.
  stt.commit();
  eou(ws());
  assert.deepEqual(events.finals, [''], 'onFinal fired (so the agent can clear _turnClosing) — empty');
}));

test('commit with no words this turn still notifies (never leaves the agent waiting)', () => withStubs(async () => {
  const { stt, events, ws } = await makeSTT();
  // Close a turn.
  partial(ws(), 'done', 0.5);
  word(ws(), 'done', 1.0);
  stt.commit();
  eou(ws());
  assert.equal(events.finals.length, 1);
  // A stray VAD end with NO words since the close (e.g. the AI's own echo already closed): commit()
  // must still emit a close so _turnClosing can't stick.
  const before = events.finals.length;
  stt.commit();
  assert.equal(events.finals.length, before + 1, 'stale commit emits an (empty) close');
  assert.equal(events.finals.at(-1), '', 'and it is empty (not a user turn)');
}));

test('the tail is NEVER committed to history — only locked words reach onFinal', () => withStubs(async () => {
  const { stt, events, ws } = await makeSTT();
  // Words lock, then a longer interim tail flickers past them, then the turn closes. Speechmatics
  // hasn't locked the tail (no trailing AddTranscript), so the final is the locked prefix ONLY —
  // the flickering tail is a hypothesis, not committed text.
  word(ws(), 'the answer is', 1.0);
  partial(ws(), 'forty two maybe', 1.8);   // live tail, not locked
  stt.commit();
  eou(ws());
  assert.deepEqual(events.finals, ['the answer is'], 'unlocked tail excluded — no guessed words in history');
}));

test('many turns in a row never wedge (stress)', () => withStubs(async () => {
  const { stt, events, ws, frame } = await makeSTT();
  for (let i = 0; i < 10; i++) {
    stt.reset();
    stt.feed(frame);
    partial(ws(), `turn ${i}`, i * 2 + 0.5);   // interim tail (absolute monotonic stream time)
    word(ws(), `turn ${i}`, i * 2 + 1.0);      // words lock
    stt.commit();
    eou(ws());
  }
  assert.equal(events.finals.length, 10, 'all 10 turns finalized');
  assert.equal(events.finals.at(-1), 'turn 9');
}));

test('late straggler from a closed turn does not corrupt a NEW turn after reset()', () => withStubs(async () => {
  const { stt, events, ws, frame } = await makeSTT();

  // Turn A closes cleanly (cursor advances to 1.0).
  partial(ws(), 'alpha', 0.5);
  word(ws(), 'alpha', 1.0);
  stt.commit();
  eou(ws());
  assert.deepEqual(events.finals, ['alpha']);

  // Agent starts turn B (reset clears the buffer; cursor survives at 1.0).
  stt.reset();
  stt.feed(frame);
  partial(ws(), 'bravo', 2.0);

  // A LATE straggler AddTranscript for the OLD segment arrives now (out of order). Its end_time (0.9)
  // is BEFORE the cursor (1.0), so it must be dropped — not prepended into turn B.
  word(ws(), 'alpha', 0.9);           // stale fragment → gated out by the cursor

  word(ws(), 'bravo', 2.5);
  stt.commit();
  eou(ws());
  assert.equal(events.finals.at(-1).includes('alpha'), false, 'old word did not leak into the new turn');
  assert.equal(events.finals.at(-1), 'bravo', 'turn B is clean');
}));

// PARTIAL-BLANK REGRESSION: during ONE continuous utterance Speechmatics restates the live tail
// around the just-locked boundary, so a fresh partial can carry an end_time at/behind the cursor the
// last AddTranscript advanced. Such an in-turn partial must STILL render — gating it (as the locked-
// word straggler gate does) blanks/freezes the tail for ~max_delay after every lock ("cuts every few
// seconds" during continuous speech, Speechmatics only).
test('behind-cursor partial during an OPEN turn still renders (no periodic tail blank)', () => withStubs(async () => {
  const { stt, events, ws } = await makeSTT();

  partial(ws(), 'one two', 1.0);      // live tail
  word(ws(), 'one two', 1.0);         // Speechmatics locks the tail → cursor advances to 1.0
  // Next live partial restates the region around the boundary; its end_time (0.9) is behind cursor
  // but the turn is still OPEN — it must reach onPartial, not be dropped.
  partial(ws(), 'one two three', 0.9);
  assert.equal(events.partials.at(-1).text, 'one two three', 'the behind-cursor in-turn partial rendered');
}));

// The gate still protects a CLOSED turn: after a turn finalizes, a stale behind-cursor partial from
// the old turn must be dropped so it can't paint a ghost transcript (or trip the barge-in check,
// which also reads onPartial) before the next turn's speech-start.
test('behind-cursor partial after a CLOSED turn is dropped (no ghost transcript)', () => withStubs(async () => {
  const { stt, events, ws } = await makeSTT();

  partial(ws(), 'alpha', 1.0);
  word(ws(), 'alpha', 1.0);           // cursor → 1.0
  stt.commit();
  eou(ws());                          // turn closes (turnOpen = false)
  assert.deepEqual(events.finals, ['alpha']);

  const before = events.partials.length;
  partial(ws(), 'stale alpha', 0.9);  // old-turn straggler behind cursor, turn is CLOSED → drop
  assert.equal(events.partials.length, before, 'stale behind-cursor partial was gated out');
}));

// STRAGGLER REGRESSION: a turn's real trailing final straggles in AFTER the next turn has started —
// its stream position is behind the cursor, so it's gated out (never resurfaces in the new turn).
test('stale trailing final after a close does not leak into the next turn', () => withStubs(async () => {
  const { stt, events, ws, frame } = await makeSTT();

  word(ws(), 'hello there', 1.0);
  stt.commit();
  eou(ws());
  assert.deepEqual(events.finals, ['hello there']);

  stt.reset();
  stt.feed(frame);
  const mark = events.partials.length;   // only inspect turn B's renders
  partial(ws(), 'second turn', 3.0);
  word(ws(), 'hello there', 0.95);   // the real final for turn A, straggling in late → behind cursor 1.0 → dropped

  word(ws(), 'second turn', 3.5);
  stt.commit();
  eou(ws());

  const leaked = events.partials.slice(mark).some((p) => p.committed.includes('hello there'));
  assert.equal(leaked, false, 'stale final must not resurface in the new turn');
  assert.equal(events.finals.at(-1), 'second turn');
}));

// CONTINUOUS-SPEECH REGRESSION (the "goes deaf mid-counting" bug): while a turn is closing, the user
// keeps talking, so the NEXT utterance's words are already being locked at higher stream positions.
// The cursor only advances to the LAST locked word — never past the words being spoken — so the new
// turn's partials/finals (at later end_times) are all accepted. (The old commitEnd/sentSamples floor
// could land past them and gate the turn deaf; the single monotonic cursor can't.)
test('audio fed while a turn is closing does not gate the next turn deaf', () => withStubs(async () => {
  const { stt, events, ws, frame } = await makeSTT();

  // Turn A: words lock up to 1.0s, commit + close.
  for (let i = 0; i < 10; i++) stt.feed(frame);
  partial(ws(), 'one two three', 0.9);
  word(ws(), 'one two three', 1.0);                // cursor → 1.0
  stt.commit();
  eou(ws());
  assert.deepEqual(events.finals, ['one two three']);

  // User kept counting: turn B's words end at 1.5-3.5s — all AFTER the cursor, so they're heard.
  stt.reset();
  stt.feed(frame);
  partial(ws(), 'four five six', 3.0);
  assert.equal(events.partials.at(-1).text, 'four five six', 'new turn partials are heard');
  word(ws(), 'four five six', 3.5);
  stt.commit();
  eou(ws());
  assert.deepEqual(events.finals, ['one two three', 'four five six'], 'new turn finalizes — not gated deaf');
}));

// SAFETY-TIMER FALLBACK: if Speechmatics never answers a ForceEndOfUtterance with EndOfUtterance, the
// bounded safety timer still closes the turn on the locked words so the pipeline can't hang.
test('safety timer closes the turn on the locked words when EndOfUtterance never arrives', () => withStubs(async () => {
  const { stt, events, ws, frame } = await makeSTT();
  stt.feed(frame);
  word(ws(), 'stuck turn', 1.0);
  stt.commit();                       // ForceEndOfUtterance sent, but no EndOfUtterance comes
  await new Promise((r) => setTimeout(r, 850));   // > forceEndSafetyMs
  assert.deepEqual(events.finals, ['stuck turn'], 'closed on the locked words via the safety fallback');
}));

test('StartRecognition sets end_of_utterance_silence_trigger (required for ForceEndOfUtterance)', () => withStubs(async () => {
  const { ws } = await makeSTT();
  const start = ws().sent.filter((s) => typeof s === 'string').map((s) => JSON.parse(s)).find((m) => m.message === 'StartRecognition');
  assert.ok(start.transcription_config.conversation_config?.end_of_utterance_silence_trigger > 0,
    'silence trigger set so ForceEndOfUtterance / EndOfUtterance are enabled');
}));

// NATIVE-CLOSE THEN STRAY COMMIT: Speechmatics closed the turn itself (silence trigger, no commit()).
// A later stray VAD end must get an IMMEDIATE empty close — not a pointless ForceEndOfUtterance for a
// turn that's already closed (which would stall the agent on the safety timer).
test('commit after a native EndOfUtterance close emits an immediate empty final (no new force-end)', () => withStubs(async () => {
  const { stt, events, ws, frame } = await makeSTT();
  stt.feed(frame);
  word(ws(), 'already closed', 1.0);
  eou(ws());                          // native close — no commit() ran
  assert.deepEqual(events.finals, ['already closed']);
  const sentBefore = ws().sent.length;
  stt.commit();                       // stray VAD end
  assert.deepEqual(events.finals, ['already closed', ''], 'immediate empty close');
  assert.equal(ws().sent.length, sentBefore, 'no ForceEndOfUtterance sent for the closed turn');
}));

// POST-SAFETY LEAK + TAIL FOLD: the safety timer closed turn A (no EndOfUtterance handshake, so the
// flushing AddTranscript never landed). The last interim tail is the only copy of A's final words →
// it's FOLDED into A's final (not stripped). A's late flush then arrives with end_times past the last
// locked word — the cursor advanced to the commit-time stream boundary, so those words are gated (they
// can't duplicate what the fold already kept) while turn B's words (fed after) flow immediately.
test('safety-timeout close keeps the interim tail; the late flush cannot then duplicate into the next turn', () => withStubs(async () => {
  const { stt, events, ws, frame } = await makeSTT();

  for (let i = 0; i < 24; i++) stt.feed(frame);   // 2.5s fed (incl. setup frame) — A's audio
  word(ws(), 'one two', 1.0);          // cursor -> 1.0; 'three four' stays unlocked (tail only)
  partial(ws(), 'three four', 1.8);
  stt.commit();                        // boundary snapshot: 2.5s. ForceEndOfUtterance... no EndOfUtterance comes
  await new Promise((r) => setTimeout(r, 850));   // safety close → tail folded in, cursor → 2.5s boundary
  assert.deepEqual(events.finals, ['one two three four'], 'the un-flushed tail is kept, not stripped');

  // Turn B starts; A's LATE flush finally arrives — locked words within A's audio (≤ boundary) → gated.
  stt.reset();
  for (let i = 0; i < 15; i++) stt.feed(frame);   // B's audio: 2.5s → 4.0s
  word(ws(), 'three four', 2.2);       // late flush of A's tail → behind the boundary → dropped (already kept via the fold)
  eou(ws());                           // A's own late EndOfUtterance → nothing open, ignored
  partial(ws(), 'five six', 3.0);
  word(ws(), 'five six', 3.5);
  stt.commit();
  eou(ws());
  assert.deepEqual(events.finals, ['one two three four', 'five six'], "A's late flush did not duplicate into B");
}));

// REAL WIRE ORDERING for commit: the flushing AddTranscript lands AFTER the ForceEndOfUtterance,
// then EndOfUtterance — the final must include the words flushed post-commit.
test('commit → trailing AddTranscript flush → EndOfUtterance includes the flushed words', () => withStubs(async () => {
  const { stt, events, ws, frame } = await makeSTT();
  stt.feed(frame);
  word(ws(), 'the quick', 0.6);        // locked mid-utterance
  partial(ws(), 'brown fox', 1.1);     // tail still unlocked at commit time
  stt.commit();                        // ForceEndOfUtterance
  word(ws(), 'brown fox', 1.2);        // the flush lands after the commit
  eou(ws());
  assert.deepEqual(events.finals, ['the quick brown fox'], 'post-commit flush included in the final');
}));

// SAFETY CLOSE MUST NOT DEAFEN THE NEXT TURN: user keeps talking while the safety timer closes A —
// B's words (fed after the commit) end past the boundary and must be heard immediately.
test('turn after a safety-timeout close is heard immediately (no deaf window)', () => withStubs(async () => {
  const { stt, events, ws, frame } = await makeSTT();
  for (let i = 0; i < 9; i++) stt.feed(frame);    // 1.0s fed (incl. setup frame)
  word(ws(), 'one two three', 0.9);
  stt.commit();                                    // boundary: 1.0s; no EndOfUtterance will come
  for (let i = 0; i < 30; i++) stt.feed(frame);   // user keeps talking: 1.0s → 4.0s
  await new Promise((r) => setTimeout(r, 850));   // safety close → cursor = 1.0s boundary
  assert.deepEqual(events.finals, ['one two three']);

  stt.reset();
  partial(ws(), 'four five', 2.0);                 // B's words — past the boundary → heard
  assert.equal(events.partials.at(-1).text, 'four five', 'B partials flow immediately');
  word(ws(), 'four five', 2.5);
  stt.commit();
  eou(ws());
  assert.deepEqual(events.finals, ['one two three', 'four five'], 'B finalizes');
}));

// COUNTING REPRO (the reported "missing span + stuttered word" corruption): the user counts
// continuously; Speechmatics locks the numbers incrementally as AddTranscript (advancing end_times)
// with a flickering partial ahead of them, then the turn closes. The final must contain EVERY number
// exactly once, in order — no dropped span (…five, seven…) and no repetition loop (…eleven eleven…).
// With locked-words-only finals this is structural: the final is precisely the concatenated locked
// fragments, so it can neither lose nor duplicate a word.
test('continuous counting finalizes every number once, in order (no gap, no stutter)', () => withStubs(async () => {
  const { stt, events, ws, frame } = await makeSTT();
  const nums = ['one','two','three','four','five','six','seven','eight','nine','ten','eleven','twelve'];
  stt.reset();
  nums.forEach((n, i) => {
    stt.feed(frame);
    partial(ws(), nums.slice(0, i + 1).join(' '), (i + 1) * 0.4);   // interim races ahead
    word(ws(), n, (i + 1) * 0.4);                                    // then that number locks (monotonic end_time)
  });
  stt.commit();
  eou(ws());
  assert.deepEqual(events.finals, [nums.join(' ')], 'all twelve numbers, once each, in order');
}));

// RECONNECT DEAFNESS (the "misses things after a while / gets stuck" bug): Speechmatics closes an
// idle socket (~3min of no audio, or a network drop). feed() lazily reopens — but the NEW socket's
// end_times restart at 0 (relative to ITS StartRecognition). If the old cursor survived, every word
// of the reconnected stream would end "behind" it and be gated as a straggler → permanently deaf.
// A fresh socket must reset its per-socket clock state (cursor/sentSamples/commitBoundary/started).
test('reconnect after a socket drop resets the stream clock — the new session is heard', () => withStubs(async () => {
  const { stt, events, ws, frame } = await makeSTT();

  // Session 1: words lock deep into the stream → cursor is large.
  word(ws(), 'first session words', 150.0);
  stt.commit();
  eou(ws());
  assert.deepEqual(events.finals, ['first session words']);

  // Socket drops (idle timeout / network). isClosed() is false → feed() reopens a NEW socket.
  ws().readyState = 3;
  ws().onclose?.({ code: 1006, reason: 'idle timeout' });
  stt.feed(frame);
  await new Promise((r) => setTimeout(r, 0));   // let the reopen's token fetch settle
  const ws2 = ws();
  ws2.onopen?.();
  ws2.recv({ message: 'RecognitionStarted' });

  // New socket's end_times restart near 0 — far "behind" the old 150s cursor.
  partial(ws2, 'after reconnect', 0.5);
  assert.equal(events.partials.at(-1).text, 'after reconnect', 'partials are heard on the new socket');
  word(ws2, 'after reconnect', 1.0);
  stt.commit();
  ws2.recv({ message: 'EndOfUtterance' });
  assert.deepEqual(events.finals, ['first session words', 'after reconnect'], 'not gated deaf after reconnect');
}));

// IDLE KEEPALIVE: VAD-gated audio means a quiet room sends NOTHING — Speechmatics then closes the
// socket after ~3min (code 1008 idle_timeout) and the session dies mid-listen. The provider trickles
// a short silence frame when nothing has been sent for a while so the socket stays alive.
test('idle keepalive trickles silence so a quiet session is not closed by the provider', () => withStubs(async () => {
  const realSetInterval = globalThis.setInterval;
  const realNow = performance.now;
  let tickFn = null, clock = 0;
  globalThis.setInterval = (fn) => { tickFn = fn; return { unref() {} }; };
  performance.now = () => clock;
  try {
    const { stt, ws } = await makeSTT();
    assert.ok(tickFn, 'keepalive armed on RecognitionStarted');
    // An OPEN turn must never receive injected silence (it could trip the provider's
    // end-of-utterance silence trigger): setup fed audio → sentSinceCommit is true.
    clock += 25000;
    const during = ws().sent.length;
    tickFn();
    assert.equal(ws().sent.length, during, 'no trickle while a turn is open/uncommitted');
    // Close the turn → truly idle listening.
    word(ws(), 'done', 1.0);
    stt.commit();
    eou(ws());
    const before = ws().sent.length;
    tickFn();   // idle, but lastSendMs is fresh? No sends happened since clock+=25000 → stale → trickles
    assert.equal(ws().sent.length, before + 1, 'a silence frame was sent to keep the idle socket alive');
    tickFn();   // the trickle updated lastSendMs → no spam on the next tick
    assert.equal(ws().sent.length, before + 1, 'no repeat within the idle window');
  } finally {
    globalThis.setInterval = realSetInterval;
    performance.now = realNow;
  }
}));

// QUEUED-AUDIO BOUNDARY: audio fed while the socket is still opening (token fetch/handshake) is
// outbox-queued but MUST still count into the stream clock — commit()'s boundary snapshot gates the
// old turn's late flush on the safety path. If open()'s per-socket reset ran AFTER the queued feeds,
// the boundary would be too low and the late flush would leak/duplicate into the next turn.
test('audio queued during the socket open counts into the safety commit boundary', () => withStubs(async () => {
  const events = { partials: [], finals: [] };
  const stt = makeSpeechmaticsSTT({
    apiKey: 'k', sttTokenUrl: 'http://x/api/v1/stt/token', sttModel: 'standard', sttLang: 'en',
    onPartial: (text, ms, committed = '') => events.partials.push({ text, committed }),
    onFinal: (text) => events.finals.push(text),
    onError: () => {}, onFatal: () => {}, onClose: () => {}, isClosed: () => false,
  });
  const frame = new Int16Array(1600);   // 0.1s @16k
  // 2.0s of audio fed BEFORE the socket finishes opening — all outbox-queued.
  for (let i = 0; i < 20; i++) stt.feed(frame);
  await new Promise((r) => setTimeout(r, 0));
  FakeWS.last.onopen?.();
  FakeWS.last.recv({ message: 'RecognitionStarted' });
  const ws = () => FakeWS.last;

  word(ws(), 'one two', 1.0);
  partial(ws(), 'three four', 1.8);
  stt.commit();                        // boundary must be 2.0s (the queued audio), not ~0
  await new Promise((r) => setTimeout(r, 850));   // safety close (no EndOfUtterance)
  assert.deepEqual(events.finals, ['one two three four']);

  // A's late flush lands within the queued-audio span → must be gated by the boundary.
  stt.reset();
  word(ws(), 'three four', 1.9);
  partial(ws(), 'next turn', 2.5);
  const leaked = events.partials.at(-1).committed.includes('three four');
  assert.equal(leaked, false, 'late flush within the queued span is gated — no duplicate');
}));

// PREFIX LOCK: a partial races ahead ("one two three four"), then AddTranscript locks only its
// prefix ("one two"). The unlocked remainder is the only copy of the newest words — a safety close
// must keep it, not strip it (and a diverging lock must still clear the tail).
test('safety close after a prefix lock keeps the unlocked remainder of the tail', () => withStubs(async () => {
  const { stt, events, ws, frame } = await makeSTT();
  stt.feed(frame);
  partial(ws(), 'one two three four', 1.8);   // tail races ahead
  word(ws(), 'one two', 1.0);                 // prefix locks; remainder 'three four' still unlocked
  stt.commit();
  await new Promise((r) => setTimeout(r, 850));   // safety close (no EndOfUtterance)
  assert.deepEqual(events.finals, ['one two three four'], 'unlocked remainder folded in, not stripped');
}));

// ── Deepgram Flux provider ───────────────────────────────────────────────────────────────────────
// Flux owns the turn boundary (nativeEOT): TurnInfo Update → onPartial, EndOfTurn → unsolicited
// onFinal. commit() is only the VAD-gated fallback path. Auth is via the ['bearer', token]
// subprotocol, audio is raw binary like Speechmatics.

import { makeDeepgramSTT } from './stt.js';

async function makeDG() {
  const events = { partials: [], finals: [] };
  const stt = makeDeepgramSTT({
    apiKey: 'k', sttTokenUrl: 'http://x/api/v1/stt/token', sttModel: 'flux-general-en', sttLang: 'en',
    onPartial: (text) => events.partials.push(text),
    onFinal: (text) => events.finals.push(text),
    onError: () => {}, onFatal: () => {}, onClose: () => {}, isClosed: () => false,
  });
  const frame = new Int16Array(1600);
  stt.feed(frame);
  await new Promise((r) => setTimeout(r, 0));
  FakeWS.last.onopen?.();
  return { stt, events, ws: () => FakeWS.last, frame };
}
const turn = (ws, event, transcript) => ws.recv({ type: 'TurnInfo', event, transcript });

test('deepgram: declares continuous + nativeEOT and authenticates via bearer subprotocol', () => withStubs(async () => {
  const { stt, ws } = await makeDG();
  assert.equal(stt.continuous, true);
  assert.equal(stt.nativeEOT, true);
  assert.ok(ws().url.includes('model=flux-general-en'), 'model in URL');
  assert.deepEqual(ws().protocols, ['bearer', 'tok'], 'short-TTL token via subprotocol');
}));

test('deepgram: native EndOfTurn closes turns unsolicited, sequential turns stay clean', () => withStubs(async () => {
  const { events, ws } = await makeDG();
  turn(ws(), 'Update', 'hello');
  turn(ws(), 'Update', 'hello there');
  turn(ws(), 'EndOfTurn', 'hello there');
  turn(ws(), 'Update', 'second');
  turn(ws(), 'EndOfTurn', 'second turn');
  assert.deepEqual(events.partials, ['hello', 'hello there', 'second']);
  assert.deepEqual(events.finals, ['hello there', 'second turn']);
}));

test('deepgram: VAD-gated fallback commit() flushes the latest turn text after the safety window', () => withStubs(async () => {
  const { stt, events, ws, frame } = await makeDG();
  stt.feed(frame);
  turn(ws(), 'Update', 'fallback words');
  stt.commit();
  assert.deepEqual(events.finals, [], 'waits for a possible native EndOfTurn first');
  await new Promise((r) => setTimeout(r, 850));   // > forceEndSafetyMs
  assert.deepEqual(events.finals, ['fallback words']);

  stt.commit();   // nothing fed since → empty close so the host's closing latch clears
  assert.deepEqual(events.finals, ['fallback words', '']);
}));

test('deepgram: native EndOfTurn during the commit safety window wins (no duplicate final)', () => withStubs(async () => {
  const { stt, events, ws, frame } = await makeDG();
  stt.feed(frame);
  turn(ws(), 'Update', 'race words');
  stt.commit();
  turn(ws(), 'EndOfTurn', 'race words');   // native final lands before the safety timer
  await new Promise((r) => setTimeout(r, 850));
  assert.deepEqual(events.finals, ['race words'], 'exactly one final');
}));

// ── Web Speech (browser SpeechRecognition) ──────────────────────────────────────────────────────
// No cloud/token/socket: the provider wraps the browser SpeechRecognition engine, and it OWNS its own
// mic + end-of-turn (selfCapture + nativeEOT). We stub a fake recognition global + fake timers and
// drive onresult / lifecycle to lock: interim → onPartial tail, isFinal → accumulate the turn, and a
// silence gap (the EOT debounce elapsing with no new final) → one onFinal turn. No feed/commit/reset.
import { mock } from 'node:test';
import { makeWebSpeechSTT } from './stt.js';
import { TUNING } from './tuning.js';

class FakeRec {
  constructor() { this.continuous = false; this.interimResults = false; this.lang = ''; this.started = false; FakeRec.last = this; }
  start() { if (this.started) throw new Error('already started'); this.started = true; this.onstart?.(); }
  stop() { this.started = false; this.onend?.(); }
  // Deliver a batch of { transcript, isFinal } results (resultIndex 0 for simplicity).
  emit(results) {
    this.onresult?.({ resultIndex: 0, results: Object.assign(results.map((r) => ({ 0: { transcript: r.transcript }, isFinal: r.isFinal })), { length: results.length }) });
  }
}

// Fake timers so the EOT debounce is deterministic (advance the clock instead of waiting real ms).
function withWebSpeech(fn) {
  const realWin = globalThis.window, realPerf = globalThis.performance;
  globalThis.window = { SpeechRecognition: FakeRec };
  globalThis.performance = globalThis.performance ?? { now: () => Date.now() };
  // Node 20 has no global navigator (the mic pre-open probe reads navigator.mediaDevices); on ≥21
  // it exists as a getter-only global, so define rather than assign — and only when absent.
  const stubbedNav = !('navigator' in globalThis) &&
    Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
  mock.timers.enable({ apis: ['setTimeout'] });
  return Promise.resolve(fn()).finally(() => {
    mock.timers.reset(); globalThis.window = realWin; globalThis.performance = realPerf;
    if (stubbedNav) delete globalThis.navigator;
  });
}
const EOT = TUNING.WEBSPEECH_EOT_MS;

function makeWS() {
  const events = { partials: [], finals: [], errors: [], fatals: [], closes: 0 };
  const stt = makeWebSpeechSTT({
    sttLang: 'en',
    onPartial: (text, ms, committed = '') => events.partials.push({ text, committed }),
    onFinal: (text) => events.finals.push(text),
    onError: (m) => events.errors.push(m),
    onFatal: (m) => events.fatals.push(m), onClose: () => { events.closes++; }, isClosed: () => false,
  });
  return { stt, events, rec: () => FakeRec.last };
}

test('webspeech: is selfCapture + nativeEOT (agent builds no pipeline, runs no VAD-commit)', () => withWebSpeech(async () => {
  const { stt } = makeWS();
  assert.equal(stt.selfCapture, true, 'owns its mic → the agent forwards no PCM');
  assert.equal(stt.nativeEOT, true, 'owns its end-of-turn → the agent runs no VAD-commit');
  assert.equal(typeof stt.feed, 'undefined', 'no feed(): the agent never hands it audio');
  assert.equal(typeof stt.commit, 'undefined', 'no commit(): the agent never closes its turns');
}));

test('webspeech: interim → onPartial tail; finals accumulate; a silence gap → one onFinal turn', () => withWebSpeech(async () => {
  const { stt, events, rec } = makeWS();
  stt.open();
  assert.ok(rec().started, 'open() started recognition');
  assert.equal(rec().lang, 'en-US', 'bare "en" mapped to a BCP-47 tag');

  rec().emit([{ transcript: 'hello', isFinal: false }]);
  assert.deepEqual(events.partials.at(-1), { text: 'hello', committed: '' }, 'interim is the live tail');

  rec().emit([{ transcript: 'hello there', isFinal: true }]);
  assert.deepEqual(events.partials.at(-1), { text: '', committed: 'hello there' }, 'a final locks into the turn-so-far');

  // A second isFinal chunk after a SHORT pause (< EOT) extends the SAME turn — the timer re-arms.
  mock.timers.tick(EOT - 100);
  rec().emit([{ transcript: 'friend', isFinal: true }]);
  assert.deepEqual(events.partials.at(-1), { text: '', committed: 'hello there friend' });
  assert.deepEqual(events.finals, [], 'still mid-turn — no flush yet');

  // Now a full silence gap with no new final → the turn closes exactly once.
  mock.timers.tick(EOT);
  assert.deepEqual(events.finals, ['hello there friend'], 'the EOT debounce flushed one finalized turn');

  // The next utterance is an independent turn.
  rec().emit([{ transcript: 'next', isFinal: true }]);
  mock.timers.tick(EOT);
  assert.deepEqual(events.finals, ['hello there friend', 'next']);
}));

test('webspeech: an interim continuation after a final postpones EOT (one turn, not split)', () => withWebSpeech(async () => {
  const { stt, events, rec } = makeWS();
  stt.open();
  rec().emit([{ transcript: 'hello', isFinal: true }]);   // final → EOT timer armed
  mock.timers.tick(EOT - 200);                            // user pauses, then resumes BEFORE the deadline
  rec().emit([{ transcript: 'how are', isFinal: false }]); // live interim continuation must re-arm the timer
  mock.timers.tick(EOT - 200);                            // cross the ORIGINAL deadline — must NOT have fired
  assert.deepEqual(events.finals, [], 'the interim continuation kept the turn open (no premature split)');
  rec().emit([{ transcript: 'how are you', isFinal: true }]);
  mock.timers.tick(EOT);                                   // now real silence → close as ONE turn
  assert.deepEqual(events.finals, ['hello how are you'], 'the whole utterance closed as a single turn');
}));

test('webspeech: interim-only noise that never finalizes never fires a turn', () => withWebSpeech(async () => {
  const { stt, events, rec } = makeWS();
  stt.open();
  rec().emit([{ transcript: 'uhh', isFinal: false }]);   // interim only, no isFinal
  mock.timers.tick(EOT * 3);
  assert.deepEqual(events.finals, [], 'no isFinal → no turn (a bare interim is never a user turn)');
}));

test('webspeech: setEnabled(false) mutes (stops, cancels a pending turn, no restart), (true) resumes', () => withWebSpeech(async () => {
  const { stt, events, rec } = makeWS();
  stt.open();
  const live = rec();
  live.emit([{ transcript: 'hello', isFinal: true }]);   // a turn is pending on the EOT timer
  stt.setEnabled(false);
  assert.equal(live.started, false, 'mute stopped the running recognition');
  mock.timers.tick(EOT * 2);
  assert.deepEqual(events.finals, [], 'mute cancelled the pending turn — a muted mic emits nothing');
  live.onend?.();   // Chrome fires onend after stop() — must NOT auto-restart while muted
  assert.equal(rec().started, false, 'stays stopped while muted');
  stt.setEnabled(true);
  assert.ok(rec().started, 'unmute relaunches recognition');
}));

test('webspeech: onend auto-restarts while listening (Chrome ends on silence), stops on close', () => withWebSpeech(async () => {
  const { stt, rec } = makeWS();
  stt.open();
  const first = rec();
  first.onend();   // Chrome closed the session on silence
  assert.ok(FakeRec.last !== first && FakeRec.last.started, 'restarted a fresh recognition');
  stt.close();
  assert.equal(FakeRec.last.started, false, 'close() stops and does not relaunch');
}));

test('webspeech: a stale recognizer restarted by onend cannot emit into the live turn', () => withWebSpeech(async () => {
  const { stt, events, rec } = makeWS();
  stt.open();
  const first = rec();
  first.onend();                 // silence → restart; `first` is now superseded
  const second = rec();
  assert.ok(second !== first);
  first.emit([{ transcript: 'ghost', isFinal: true }]);   // the OLD recognizer's late event
  second.emit([{ transcript: 'real', isFinal: true }]);
  mock.timers.tick(EOT);
  assert.deepEqual(events.finals, ['real'], 'only the live recognizer shaped the turn — no "ghost"');
}));

test('webspeech: a Chrome auto-restart mid-utterance does NOT split the turn (no fragment+repeat)', () => withWebSpeech(async () => {
  const { stt, events, rec } = makeWS();
  stt.open();
  const first = rec();
  first.emit([{ transcript: 'hello there', isFinal: true }]);   // opening words → EOT armed
  // Chrome auto-ends on its SHORT internal silence (well under EOT_MS) mid-thought; onend restarts a
  // fresh recognizer. The user was NOT silent for a real end-of-turn, so the turn must stay open.
  mock.timers.tick(EOT / 3);   // internal-silence gap, shorter than the end-of-turn debounce
  first.onend();
  const second = rec();
  assert.ok(second !== first && second.started, 'restarted');
  // The user keeps talking on the new recognizer within the debounce window → SAME turn, no premature
  // flush (that fragment would have been message #1, then the re-finalized opening = message #2 repeat).
  mock.timers.tick(EOT / 3);
  second.emit([{ transcript: 'how are you', isFinal: true }]);
  assert.deepEqual(events.finals, [], 'no premature flush across the restart — the turn stayed open');
  mock.timers.tick(EOT);   // now real silence → close as ONE continuous turn
  assert.deepEqual(events.finals, ['hello there how are you'], 'one continuous turn, opening not duplicated');
}));

test('webspeech: a GENUINE end-of-turn silence closes the turn even if a restart lands in the gap', () => withWebSpeech(async () => {
  const { stt, events, rec } = makeWS();
  stt.open();
  const first = rec();
  first.emit([{ transcript: 'hello there', isFinal: true }]);   // opening words, then the user goes quiet
  // A full EOT_MS of real silence elapses. Chrome's auto-restart coincidentally lands inside it — the
  // silence clock is measured from the last TEXT, not the recognizer, so the boundary is restart-immune:
  // it closes exactly once, on wall-clock silence, whether or not a recognizer is alive at that instant.
  mock.timers.tick(EOT / 2);
  first.onend();                                    // restart lands mid-silence
  assert.ok(rec() !== first && rec().started, 'restarted');
  mock.timers.tick(EOT / 2);                        // cross the end-of-turn deadline
  assert.deepEqual(events.finals, ['hello there'], 'the genuine silence closed the turn once');
}));

test('webspeech: a re-finalized opening across the restart seam is deduped, not appended twice', () => withWebSpeech(async () => {
  const { stt, events, rec } = makeWS();
  stt.open();
  const first = rec();
  first.emit([{ transcript: 'hello there', isFinal: true }]);
  first.onend();   // Chrome auto-ended while still buffering that audio → restart
  const second = rec();
  // Chrome re-delivers the tail it had buffered as the new recognizer's first final (the classic
  // duplicate), then the real continuation.
  second.emit([{ transcript: 'there how are', isFinal: true }]);   // "there" overlaps the seam
  second.emit([{ transcript: 'you today', isFinal: true }]);
  mock.timers.tick(EOT);
  assert.deepEqual(events.finals, ['hello there how are you today'], 'seam overlap dropped — no "there there"');
}));

test('webspeech: the silence clock closes a turn once, even across repeated quiet restarts', () => withWebSpeech(async () => {
  const { stt, events, rec } = makeWS();
  stt.open();
  const first = rec();
  first.emit([{ transcript: 'all done', isFinal: true }]);   // final words, then the user goes quiet
  first.onend();                 // Chrome auto-ends; the EOT timer keeps ticking from the last word
  rec().onend();                 // ...and the fresh recognizer ends again on continued silence
  mock.timers.tick(EOT);         // the silence clock (armed at "all done") elapses → one close
  assert.deepEqual(events.finals, ['all done'], 'closed exactly once on the wall-clock silence');
  assert.ok(rec().started, 'still listening for the next turn');
}));

test('webspeech: the live draft (committed + interim) never regresses across a restart seam', () => withWebSpeech(async () => {
  const { stt, events, rec } = makeWS();
  stt.open();
  const first = rec();
  first.emit([{ transcript: 'hello', isFinal: true }]);                 // "hello" locks into the turn
  first.emit([{ transcript: 'there ho', isFinal: false }]);            // live tail forming
  assert.deepEqual(events.partials.at(-1), { text: 'there ho', committed: 'hello' }, 'draft = committed + tail');
  // Chrome auto-ends mid-word; the fresh recognizer hasn't produced anything yet. The draft must NOT
  // blank back to just "hello" — the committed turn is preserved and the last tail stays available.
  first.onend();
  // onend emits no partial frame, so the UI still shows the last one — the draft holds across the gap.
  assert.deepEqual(events.partials.at(-1), { text: 'there ho', committed: 'hello' }, 'the draft held across the restart gap (no blank frame)');
  const second = rec();
  // The fresh recognizer re-finalizes the buffered tail (seam) then continues — no duplicate, no gap.
  second.emit([{ transcript: 'there how are you', isFinal: true }]);
  mock.timers.tick(EOT);
  assert.deepEqual(events.finals, ['hello there how are you'], 'seam deduped into one clean turn');
}));

test('webspeech: a tail re-finalized AFTER the turn already closed is deduped, not a bogus new turn', () => withWebSpeech(async () => {
  const { stt, events, rec } = makeWS();
  stt.open();
  const first = rec();
  first.emit([{ transcript: 'hello there', isFinal: true }]);   // opening words → silence clock armed
  mock.timers.tick(EOT);                                        // genuine silence → turn closes
  assert.deepEqual(events.finals, ['hello there'], 'the turn closed');
  // Chrome auto-restarted around the close and re-finalizes the tail it was still buffering as the
  // FRESH recognizer's opening final — the classic post-flush duplicate. It must NOT become a turn.
  first.onend();
  const second = rec();
  second.emit([{ transcript: 'there', isFinal: true }]);        // re-finalized tail of the closed turn
  mock.timers.tick(EOT);
  assert.deepEqual(events.finals, ['hello there'], 'the late seam was dropped — no duplicate "there" turn');
}));

// REGRESSION: Chrome's endpointer can take LONGER than EOT_MS to promote trailing words to isFinal.
// The silence clock is (re)armed on interims, but only FINALIZED words become a turn — so a close
// firing while the engine still holds an un-promoted tail used to emit a TRUNCATED turn, and the late
// final then opened a bogus SECOND turn. The two texts are disjoint, so the justClosed seam-guard has
// no overlap to dedup: the duplicate barged in and killed the reply. flush() now waits for the engine
// to go quiescent instead of guessing with a clock.
test('webspeech: a close is deferred while the engine still holds an un-promoted tail (no truncated turn)', () => withWebSpeech(async () => {
  const { stt, events, rec } = makeWS();
  stt.open();
  const r = rec();
  r.emit([{ transcript: 'book a meeting', isFinal: true }]);           // opening words lock in
  r.emit([{ transcript: 'for tomorrow at five', isFinal: false }]);    // trailing words STILL interim
  mock.timers.tick(EOT + 1);                                           // the clock elapses first
  assert.deepEqual(events.finals, [], 'no truncated turn while the engine is still finalizing');
  r.emit([{ transcript: 'for tomorrow at five', isFinal: true }]);     // the endpointer catches up
  mock.timers.tick(EOT);
  assert.deepEqual(events.finals, ['book a meeting for tomorrow at five'], 'one complete turn, not a truncation + a duplicate');
}));

test('webspeech: onend releases a deferred close (the engine dropped the tail — turn closes at once)', () => withWebSpeech(async () => {
  const { stt, events, rec } = makeWS();
  stt.open();
  const first = rec();
  first.emit([{ transcript: 'send the report', isFinal: true }]);
  first.emit([{ transcript: 'to bo', isFinal: false }]);   // tail the engine never promotes
  mock.timers.tick(EOT + 1);                               // close deferred — the recognizer is still live
  assert.deepEqual(events.finals, [], 'deferred while live');
  first.onend();                                           // Chrome gives up on the tail → no longer pending
  mock.timers.tick(EOT);
  assert.deepEqual(events.finals, ['send the report'], 'closes on the finalized words once the engine is quiescent');
}));

test('webspeech: a tail that never resolves cannot hang the turn (deferral budget is bounded)', () => withWebSpeech(async () => {
  const { stt, events, rec } = makeWS();
  stt.open();
  const r = rec();
  r.emit([{ transcript: 'send the report', isFinal: true }]);
  r.emit([{ transcript: 'to bo', isFinal: false }]);   // live recognizer, tail never promotes, no onend
  for (let i = 0; i < 10; i++) mock.timers.tick(EOT);  // stepped (each window re-arms once)
  assert.deepEqual(events.finals, ['send the report'], 'the cap closed the turn — a stuck tail never hangs it');
}));

test('webspeech: continued speech resets the deferral budget (a long utterance is never cut)', () => withWebSpeech(async () => {
  const { stt, events, rec } = makeWS();
  stt.open();
  const r = rec();
  r.emit([{ transcript: 'first', isFinal: true }]);
  // Keep talking well past the deferral cap. Each tail sits past the deadline (spending a defer)
  // before the engine promotes it and the user speaks on — that progress must reset the budget, or a
  // long utterance gets cut at the cap. The cap may only ever fire on a genuinely STUCK tail.
  for (let i = 0; i < 12; i++) {
    r.emit([{ transcript: `word${i}`, isFinal: false }]);
    mock.timers.tick(EOT + 1);                                  // deadline passes with the tail live → defer
    r.emit([{ transcript: `word${i}`, isFinal: true }]);         // the engine catches up → progress
  }
  assert.deepEqual(events.finals, [], 'still one open turn — continued speech is not a stuck tail');
  r.emit([{ transcript: 'last words', isFinal: true }]);
  mock.timers.tick(EOT);
  assert.equal(events.finals.length, 1, 'closed exactly once — the utterance was never cut at the cap');
  assert.ok(events.finals[0].startsWith('first word0') && events.finals[0].endsWith('last words'), 'one turn holding every word');
}));

test('webspeech: word-boundary dedup keeps a genuine shorter suffix (no over-eager drop)', () => withWebSpeech(async () => {
  const { stt, events, rec } = makeWS();
  stt.open();
  // "bye" is a letter-suffix of "goodbye" but a distinct WORD — it must survive (naive endsWith would eat it).
  rec().emit([{ transcript: 'goodbye', isFinal: true }]);
  rec().emit([{ transcript: 'bye now', isFinal: true }]);
  mock.timers.tick(EOT);
  assert.deepEqual(events.finals, ['goodbye bye now'], 'shared letters ≠ seam — the real words are kept');
}));

// A recognizer that can never run (browser speech service unreachable, unreadable capture device)
// errors and ends instantly, forever. Restarting it in a tight loop looks exactly like "listening"
// while being deaf — so failures back off and eventually give up out loud.
const failLaunch = (r, error = 'network') => { r.onerror?.({ error }); r.onend?.(); };
const BACKOFF_MAX = TUNING.WEBSPEECH_ERROR_BACKOFF_MS * 2 ** TUNING.WEBSPEECH_MAX_ERROR_RESTARTS;

test('webspeech: a permanently failing engine backs off and finally fatals (no silent hot loop)', () => withWebSpeech(async () => {
  const { stt, events, rec } = makeWS();
  stt.open();
  for (let i = 0; i < TUNING.WEBSPEECH_MAX_ERROR_RESTARTS; i++) {
    const r = rec();
    failLaunch(r);
    assert.equal(rec(), r, 'the relaunch is deferred, not immediate — no spin');
    mock.timers.tick(BACKOFF_MAX);
    assert.ok(rec() !== r && rec().started, 'retried after the backoff');
  }
  failLaunch(rec());
  assert.equal(events.fatals.length, 1, 'gave up out loud instead of restarting forever');
  assert.match(events.fatals[0], /network/, 'the fatal names the underlying engine error');
  mock.timers.tick(BACKOFF_MAX * 4);
  assert.equal(rec().started, false, 'and stays stopped');
  assert.equal(events.errors.length, TUNING.WEBSPEECH_MAX_ERROR_RESTARTS, 'each retry was surfaced as recoverable');
}));

test('webspeech: recognized text clears the failure budget (a flaky engine is not a dead one)', () => withWebSpeech(async () => {
  const { stt, events, rec } = makeWS();
  stt.open();
  for (let i = 0; i < TUNING.WEBSPEECH_MAX_ERROR_RESTARTS * 3; i++) {
    failLaunch(rec());
    mock.timers.tick(BACKOFF_MAX);
    rec().emit([{ transcript: 'still here', isFinal: false }]);   // the engine DID work this time
  }
  assert.deepEqual(events.fatals, [], 'intermittent failures never exhaust the budget');
}));

test("webspeech: 'no-speech'/'aborted' are normal idle churn — restart immediately, never fatal", () => withWebSpeech(async () => {
  const { stt, events, rec } = makeWS();
  stt.open();
  for (let i = 0; i < TUNING.WEBSPEECH_MAX_ERROR_RESTARTS * 3; i++) {
    const r = rec();
    failLaunch(r, i % 2 ? 'aborted' : 'no-speech');
    assert.ok(rec() !== r && rec().started, 'relaunched at once — silence must not cost latency');
  }
  assert.deepEqual(events.fatals, [], 'silence is not a broken engine');
  assert.deepEqual(events.errors, [], 'and is never surfaced to the user');
}));

test('webspeech: unsupported browser → open() reports fatal', () => withWebSpeech(async () => {
  globalThis.window = {};   // no SpeechRecognition
  const { stt, events } = makeWS();
  stt.open();
  assert.equal(events.fatals.length, 1, 'fatal so the host can fall back');
}));

test('resolveSttProvider: webspeech downgrades to the cloud fallback where the browser has none', () => withWebSpeech(async () => {
  assert.equal(resolveSttProvider('webspeech'), 'webspeech', 'supported browser keeps the free on-device engine');
  globalThis.window = {};   // Firefox / Linux WebKitGTK shell: no SpeechRecognition at all
  assert.equal(resolveSttProvider('webspeech'), WEBSPEECH_FALLBACK, 'downgraded instead of fataling voice mode');
  assert.equal(resolveSttProvider('deepgram'), 'deepgram', 'an explicit provider choice is never rewritten');
}));
