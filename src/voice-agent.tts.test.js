// voice-agent.tts.test.js — headless tests for StreamingTTS's TAPE + tap-to-seek playback.
// No real browser/audio: we mock the Web Audio API (AudioContext + AudioBufferSourceNode, matching
// prod playback), subclass StreamingTTS with an instant fake _synth blob, and drive
// clip completion by hand. Locks in: forward play returns the whole reply; barge-in returns the
// heard prefix; seek hits/misses the tape correctly; forward-skip and backward-replay both end
// with the full reply in history (heardMax is monotonic). Run: `node --test src/voice-agent.tts.test.js`.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// ── mock the Web Audio API (prod plays via AudioContext + AudioBufferSourceNode) ─────────────
// One shared MockCtx with a manual clock (`_now`). Clips read currentTime off it, so a test drives
// playback by advancing the clock + firing the source node's onended. `driver(clip)` wraps the live
// WebAudioClip (prod's `tts._audio`) with the small surface the tests use: paused/ended/tick/end.
class MockNode {
  constructor(ctx) { this.ctx = ctx; this.buffer = null; this.onended = null; }
  connect() {} disconnect() {}
  start() {}                       // WebAudioClip tracks its own start time off ctx.currentTime
  stop() { this.onended?.(); }     // prod sets _stopped before stop() → classified as a pause/abort
}
class MockCtx {
  constructor() { this.state = 'running'; this.destination = {}; this._now = 0; }
  get currentTime() { return this._now; }
  async resume() { this.state = 'running'; }
  async decodeAudioData() { return { duration: 1 }; }   // every clip is 1s
  createBufferSource() { return new MockNode(this); }
}
globalThis.window = { AudioContext: MockCtx, webkitAudioContext: MockCtx };

const { StreamingTTS } = await import('./voice-agent.js');

// A synth blob: prod calls `await wav.arrayBuffer()` then decodes it (decode is mocked to 1s).
const blob = (text) => ({ text, arrayBuffer: async () => new ArrayBuffer(8) });
// Wrap the live WebAudioClip with the test driver surface (advance the shared clock + fire end).
const driver = (clip) => ({
  get paused() { return clip.paused; },
  get ended() { return clip.ended; },
  tick(t) { clip.ctx._now = clip._startCtxTime + t; },                            // move the playhead
  end() { clip.ctx._now = clip._startCtxTime + clip.duration; clip._node.onended?.(); },   // natural end
});
// The currently-playing clip as a driver, or null when nothing is playing.
const liveClip = (tts) => { const c = tts._audio; return c && !c.paused && !c.ended ? driver(c) : null; };

class FakeTTS extends StreamingTTS {
  async _synth(text) { return text ? blob(text) : null; }               // instant non-null blob
}

// A FakeTTS whose synth of a chosen sentence index hangs until released — to open the "no clip
// playing, buffer still synthesizing" gap where a tap can't pause anything.
class GatedTTS extends StreamingTTS {
  constructor(v, gateIdx) { super(v); this._n = 0; this._gateIdx = gateIdx; this._release = null; }
  async _synth(text) {
    if (!text) return null;
    if (this._n++ === this._gateIdx) await new Promise((r) => { this._release = r; });
    return blob(text);
  }
}

const nwCount = (str) => { let n = 0; for (const c of str) if (!/\s/.test(c)) n++; return n; };
const settle = () => new Promise((r) => setTimeout(r, 0));

// Run speak() to completion, ending each clip the moment it starts unless `onClip` intervenes
// (return true to mean "I handled this clip, don't auto-end it").
async function play(tts, input, signal, onClip) {
  let done = false, out = '';
  const p = tts.speak(input, signal).then((r) => { done = true; out = r; });
  for (let i = 0; i < 300 && !done; i++) {
    await settle();
    const a = liveClip(tts);
    if (a) { if (!(onClip && onClip(a, tts))) a.end(); }
  }
  await p;
  return out;
}

test('forward play returns the whole reply', async () => {
  const tts = new FakeTTS('v');
  const out = await play(tts, 'Hello world. Second sentence here. Third one.');
  assert.equal(out, 'Hello world. Second sentence here. Third one.');
});

test('barge-in returns the heard prefix (not the full reply)', async () => {
  const tts = new FakeTTS('v');
  const ac = new AbortController();
  let cut = false;
  const out = await play(tts, 'Hello world. Second sentence.', ac.signal, (a) => {
    if (!cut) { cut = true; a.tick(0.5); ac.abort(); return true; }     // mid first clip → barge-in
    return false;
  });
  assert.ok(out.length > 0 && out.length < 'Hello world. Second sentence.'.length, `partial prefix, got "${out}"`);
  assert.ok('Hello world. Second sentence.'.startsWith(out), 'heard text is a real prefix');
});

test('seek hits a taped sentence and misses not-yet-streamed text', async () => {
  const tts = new FakeTTS('v');
  let probed = false, inRange = null, outRange = null;
  const out = await play(tts, 'One two. Three four. Five six.', undefined, (a, t) => {
    if (!probed) {
      probed = true;
      // While clip 0 plays, the one-ahead pull means clip 1 is on the tape but clip 2 is not yet.
      inRange = t.seek(8);                                              // start of "Three four." → on tape
      outRange = t.seek(100);                                          // beyond all streamed text
      return true;                                                     // seek(8) interrupts clip0 itself; let loop continue
    }
    return false;
  });
  assert.equal(inRange, true, 'seek into a taped sentence hits');
  assert.equal(outRange, false, 'seek beyond streamed text misses');
  assert.equal(out, 'One two. Three four. Five six.', 'finishes the whole reply after the forward skip');
});

test('a barge-in racing a pending seek still cuts the turn (abort wins)', async () => {
  const tts = new FakeTTS('v');
  const ac = new AbortController();
  let raced = false;
  const out = await play(tts, 'One two. Three four. Five six.', ac.signal, (a, t) => {
    if (!raced && t._curIdx === 0) {
      raced = true;
      a.tick(0.4);                       // heard a bit of clip 0
      t._seekTarget = { idx: 1, startNw: 0 }; t._seekPending = true;   // a seek is pending…
      ac.abort();                        // …and a barge-in lands in the same tick
      return true;
    }
    return false;
  });
  assert.equal(raced, true);
  assert.ok('One two. Three four. Five six.'.startsWith(out), 'heard text is a real prefix');
  assert.ok(out.length < 'One two. Three four. Five six.'.length, `cut short by barge-in, got "${out}"`);
});

test('a seek during the synth gap (no clip playing) is still honored', async () => {
  // Gate synth of sentence 1 so that after sentence 0 ends there's a window with no clip playing.
  const tts = new GatedTTS('v', 1);
  let done = false, out = '';
  const p = tts.speak('Aaa bbb. Ccc ddd. Eee fff.').then((r) => { done = true; out = r; });
  // Let sentence 0 play and end.
  for (let i = 0; i < 20 && !liveClip(tts); i++) await settle();
  liveClip(tts).end();
  // Now sentence 1's synth is hanging → no clip playing. Tap BACK to sentence 0 (taped, cached).
  for (let i = 0; i < 10 && !tts._release; i++) await settle();
  const hit = tts.seek(0);                        // "Aaa bbb." start → on tape, but nothing to pause
  assert.equal(hit, true, 'seek into a taped sentence returns true even with no clip playing');
  tts._release();                                // unblock the gated synth
  // Drive the rest to completion; the loop should honor the pending seek (replay 0), not drop it.
  for (let i = 0; i < 200 && !done; i++) { await settle(); const a = liveClip(tts); if (a) a.end(); }
  await p;
  assert.equal(out, 'Aaa bbb. Ccc ddd. Eee fff.', 'finished the reply (seek honored, not dropped)');
});

test('a seek during the stream gap (awaiting the next LLM delta) is still honored', async () => {
  // A delta stream that emits sentence 0+1, then HANGS before sentence 2 — so after clip 0 ends and
  // clip 1 plays/ends, the loop sits in `await pull()` waiting for more text: no clip to pause.
  const tts = new FakeTTS('v');
  let releaseStream;
  const stream = (async function* () {
    yield 'Aaa bbb. Ccc ddd. ';
    await new Promise((r) => { releaseStream = r; });
    yield 'Eee fff.';
  })();
  let done = false, out = '';
  const p = tts.speak(stream).then((r) => { done = true; out = r; });
  // Play clips 0 and 1 to their natural ends.
  for (let played = 0; played < 2; ) {
    await settle();
    const a = liveClip(tts);
    if (a) { a.end(); played++; }
    if (done) break;
  }
  // Now the loop is parked in `await pull()` (stream hung). Tap back to sentence 0 — nothing to pause.
  for (let i = 0; i < 10 && !releaseStream; i++) await settle();
  const hit = tts.seek(0);
  assert.equal(hit, true, 'seek returns true during the stream gap');
  releaseStream();                               // unblock the stream → pull() returns
  for (let i = 0; i < 200 && !done; i++) { await settle(); const a = liveClip(tts); if (a) a.end(); }
  await p;
  assert.equal(out, 'Aaa bbb. Ccc ddd. Eee fff.', 'pending seek honored after the gap, reply completes');
});

test('backward replay keeps history at the full reply (heardMax is monotonic)', async () => {
  const tts = new FakeTTS('v');
  let jumped = false;
  const out = await play(tts, 'Alpha beta. Gamma delta.', undefined, (a, t) => {
    // Let clip 0 finish naturally, then once clip 1 is playing, tap back to clip 0.
    if (!jumped && t._curIdx === 1) { jumped = true; t.seek(0); return true; }
    return false;
  });
  assert.equal(jumped, true, 'we actually jumped back to sentence 0');
  assert.equal(out, 'Alpha beta. Gamma delta.', 'history still holds the whole reply');
});

// Stream deltas one chunk at a time, recording the order sentences hit _synth — so we can assert the
// FIRST spoken chunk is cut early (a clause), not held until the whole sentence finishes generating.
class RecordTTS extends StreamingTTS {
  constructor(v) { super(v); this.synths = []; }
  async _synth(text) { if (text) this.synths.push(text); return text ? blob(text) : null; }
}
async function* deltas(arr) { for (const d of arr) { yield d; await new Promise((r) => setTimeout(r, 0)); } }

test('first chunk starts on the first WORD(s) for the lowest first-audio latency, then streams on', async () => {
  const tts = new RecordTTS('v');
  // Staged breaking (firstWordEnd → firstSentenceEnd → sentenceEnd): the FIRST clip is a short opener
  // (first word(s) past firstWordMinChars=4) so audio starts almost immediately, not at the full
  // sentence. No text is lost across the staged breaks.
  await play(tts, deltas(['I can do that ', 'for you, ', 'but give me ', 'a moment.']));
  assert.ok(nwCount(tts.synths[0]) <= 8, `first synth is a short opener, got "${tts.synths[0]}"`);
  assert.equal(tts.synths.join(' ').replace(/\s+/g, ' ').trim(), 'I can do that for you, but give me a moment.', 'no text lost across staged breaks');
});

test('a tiny opener glues to the next word (firstWordMinChars) instead of a choppy micro-clip', async () => {
  const tts = new RecordTTS('v');
  // "I" alone (1 char < firstWordMinChars=4) must not be its own clip — it glues forward until the
  // opener reaches the floor, so the first synth is never a 1-2 char micro-clip.
  await play(tts, deltas(['I ', 'am ', 'on it.']));
  assert.ok(nwCount(tts.synths[0]) >= 4, `first synth meets the firstWordMinChars floor, got "${tts.synths[0]}"`);
  assert.equal(tts.synths.join(' ').replace(/\s+/g, ' ').trim(), 'I am on it.', 'no text lost');
});

test('later sentences break at the word-boundary cap when a long run has no sentence ender', async () => {
  const tts = new RecordTTS('v');
  // First sentence ends normally; the SECOND runs 300+ chars with no . ! ? … : — sentenceEnd's
  // sentenceMaxChars cap (200) must cut it at a word boundary so audio keeps flowing.
  const run = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ');
  const words = ('Sure. ' + run + '.').split(' ').map((w, i, a) => i < a.length - 1 ? w + ' ' : w);
  await play(tts, deltas(words));
  const later = tts.synths.slice(1);   // everything after the opener
  assert.ok(later.length >= 2, `the long run split into multiple chunks, got ${later.length}`);
  assert.ok(later.every((s) => s.length <= 200), `every chunk within sentenceMaxChars, got ${later.map((s) => s.length)}`);
  assert.equal(tts.synths.join(' ').replace(/\s+/g, ' ').trim(), 'Sure. ' + run + '.', 'no text lost across capped breaks');
});

test('first chunk falls back to a word break when an unpunctuated opener runs long', async () => {
  const tts = new RecordTTS('v');
  // No punctuation until the end, streamed word-by-word so acc passes firstChunkMaxChars (70) BEFORE the
  // period arrives → break at a word boundary instead of awaiting the sentence.
  const longOpener = 'okay so the thing about this particular situation is that it really does take a while before anything happens';
  const words = longOpener.split(' ').map((w, i, a) => i < a.length - 1 ? w + ' ' : w + '.');
  await play(tts, deltas(words));
  assert.ok(tts.synths[0].length <= 70, `first chunk capped near firstChunkMaxChars, got ${tts.synths[0].length}`);
  assert.ok(longOpener.startsWith(tts.synths[0]), 'first chunk is a real prefix of the opener (word boundary)');
  assert.equal(tts.synths.join(' '), longOpener + '.', 'no text lost across the break');
});

// ── markdown is stripped before synthesis (the EAR gets plain prose, not "star star") ──────────
// The persona forbids markdown, but as a safety net any formatting that slips in must not be voiced.
// We capture what reaches _synth (RecordTTS) and assert the syntax chars are gone, while the spoken
// RESULT (returned by speak) stays the RAW text — the tape keeps raw so the cursor/seek stay aligned.
test('markdown is stripped from the text sent to the synthesizer', async () => {
  const tts = new RecordTTS('v');
  const md = 'Here is **bold** and `code`. See [the docs](https://x.com) now.';
  const out = await play(tts, md);
  const synthed = tts.synths.join(' ');
  assert.ok(!/[*`\[\]]/.test(synthed), `no markdown syntax reaches synth, got "${synthed}"`);
  assert.ok(synthed.includes('bold') && synthed.includes('code') && synthed.includes('the docs'), 'content survives stripping');
  assert.equal(out, md, 'speak() still returns the RAW reply (tape text), so cursor/seek stay aligned');
});

test('markdown headings, lists and links are spoken as plain prose', async () => {
  const tts = new RecordTTS('v');
  const out = await play(tts, '# Title here.\n- first item.\n- second one.\nRead [more](http://a.b).');
  const synthed = tts.synths.join(' ');
  assert.ok(!/^#|^[-*+]\s|\]\(/m.test(synthed), `markers gone, got "${synthed}"`);
  assert.ok(synthed.includes('Title here') && synthed.includes('first item') && synthed.includes('more'), 'text preserved');
  assert.ok(out.includes('# Title here'), 'raw markdown kept for the on-screen renderer');
});

// The reply is split into per-sentence chunks BEFORE stripMd runs, so an emphasis span that spans a
// sentence boundary (a '.' INSIDE **...**) is torn across two chunks — each left with an UNPAIRED
// marker the paired rules can't match. Assert the trailing sweep removes those strays too.
test('emphasis split across a sentence boundary leaves no stray marker for the synth', async () => {
  const tts = new RecordTTS('v');
  await play(tts, 'I am **Ada. At your service**, friend. Ready now.');
  const synthed = tts.synths.join(' ');
  assert.ok(!/[*_~`]/.test(synthed), `no stray emphasis marker reaches synth, got "${synthed}"`);
  assert.ok(synthed.includes('Ada') && synthed.includes('service'), 'content survives stripping');
});

// ── speak(input, signal, fromNw): REPLAY a finished reply from a tapped word ────────────────────
// After a reply plays out, tapping a word re-speaks from there. speak() seeds the playhead to the
// sentence containing fromNw, starts playback inside it, and still tapes the whole reply (so a
// backward tap within the replay hits cached clips). heardMax seeds to fromNw (the replayed prefix
// already counts as heard). We assert it starts in the right sentence and plays to the end.
test('replay from a mid-reply word starts in that sentence and finishes the reply', async () => {
  const tts = new FakeTTS('v');
  const reply = 'Alpha beta. Gamma delta. Epsilon zeta.';
  // nw offset of "Gamma" = non-whitespace chars in "Alpha beta. " = 10.
  const fromNw = nwCount('Alpha beta. ');
  let firstClipText = null;
  let done = false, out = '';
  const p = tts.speak(reply, undefined, fromNw).then((r) => { done = true; out = r; });
  for (let i = 0; i < 300 && !done; i++) {
    await settle();
    const a = liveClip(tts);
    if (a) { if (firstClipText === null) firstClipText = tts._tape[tts._curIdx].text; a.end(); }
  }
  await p;
  assert.equal(firstClipText, 'Gamma delta.', 'replay starts in the tapped sentence, not at the top');
  assert.equal(out, reply, 'replay still returns the whole reply (heardMax seeded to fromNw, then plays to end)');
});

test('replay from offset 0 plays the whole reply from the start', async () => {
  const tts = new FakeTTS('v');
  const reply = 'One two. Three four.';
  let firstClipText = null;
  const out = await (async () => {
    let done = false, o = '';
    const p = tts.speak(reply, undefined, 0).then((r) => { done = true; o = r; });
    for (let i = 0; i < 300 && !done; i++) { await settle(); const a = liveClip(tts); if (a) { if (firstClipText === null) firstClipText = tts._tape[tts._curIdx].text; a.end(); } }
    await p; return o;
  })();
  assert.ok(firstClipText.startsWith('One'), 'starts at the first sentence');
  assert.equal(out, reply);
});

// ── speculative first-clip presynth ─────────────────────────────────────────────────────────────
// presynth() pre-renders the expected first chunk during the end-of-turn debounce; speak() must
// reuse the clip on exact text match, re-synth on mismatch, and never leak a stale clip forward.

class CountingTTS extends StreamingTTS {
  constructor() { super('v'); this.synths = []; }
  async _synth(text) { if (text) this.synths.push(text); return text ? blob(text) : null; }
}

// Drive a speak() to completion: keep ending whatever clip is playing until speak resolves
// (between clips _audio is briefly null — poll rather than assume).
const driveToEnd = async (tts, p) => {
  let done = false; p.then(() => { done = true; });
  while (!done) { if (tts._audio) driver(tts._audio).end(); await settle(); }
  return p;
};

test('presynth hit: matching first chunk is not synthesized twice', async () => {
  const tts = new CountingTTS();
  tts.presynth('Hello');   // = the stage-0 chunk firstWordEnd yields from this reply
  await settle();
  const p = tts.speak(async function* () { yield 'Hello there, how are you today.'; }());
  await driveToEnd(tts, p);
  assert.equal(tts.synths.filter((s) => s === 'Hello').length, 1, 'first chunk rendered exactly once (by presynth)');
  assert.equal(tts._preClip, null, 'slot consumed');
});

test('presynth miss: different reply re-synthesizes and drops the stale clip', async () => {
  const tts = new CountingTTS();
  tts.presynth('Wrong guess,');
  await settle();
  const p = tts.speak(async function* () { yield 'Actually no. Something else entirely.'; }());
  const heard = await driveToEnd(tts, p);
  assert.equal(heard, 'Actually no. Something else entirely.');
  assert.ok(tts.synths.some((s) => s.startsWith('Actually')), 'real first chunk synthesized');
  assert.equal(tts._preClip, null, 'stale speculation cleared, not leaked to a later reply');
});

test('presynth is deduped for the same text', async () => {
  const tts = new CountingTTS();
  tts.presynth('Same text');
  tts.presynth('Same text');
  await settle();
  assert.equal(tts.synths.filter((s) => s === 'Same text').length, 1);
});

// ── onProgress scope (the clip-bounded echo reference) ─────────────────────────────────────────
// _playBuf's onProgress carries a 2nd arg: prefix + the WHOLE clip playing. The proportional
// cursor (1st arg) lags real audio, so the echo filter judges against this upper bound instead —
// but ONLY while that clip is actually playing (the agent clamps it back on stop).

test('onProgress scope covers the whole playing clip, ahead of the lagging cursor', async () => {
  const tts = new FakeTTS('v');
  const seen = [];
  tts.setOnProgress((spoken, scope) => seen.push({ spoken, scope }));
  await play(tts, 'Hello world. Second sentence here.', undefined, (a, t) => {
    a.tick(0.1);   // cursor barely moved into the clip…
    return false;  // …then auto-end
  });
  assert.ok(seen.length > 0);
  const first = seen.find((s) => s.scope?.includes('Hello world.'));
  assert.ok(first, 'scope carries the full first clip from its very first tick');
  assert.ok(first.scope.length >= first.spoken.length, 'scope is an upper bound of the cursor');
  const second = seen.find((s) => s.scope?.includes('Second sentence here.'));
  assert.ok(second.scope.includes('Hello world.'), 'later clips keep the spoken prefix in scope');
});

test('barge-in: speak() resolves with the HEARD prefix, not the scope upper bound', async () => {
  const tts = new FakeTTS('v');
  const ac = new AbortController();
  let scopes = [];
  tts.setOnProgress((_s, scope) => scopes.push(scope));
  const out = await play(tts, 'Hello world. Second sentence here.', ac.signal, (a) => {
    a.tick(0.5); ac.abort(); return true;   // cut mid-first-clip (stage-0 clip = "Hello")
  });
  assert.ok(scopes.some((s) => s.includes('Hello')), 'scope reached the full clip before the cut');
  assert.ok(!out.includes('Second'), 'heard prefix excludes never-played text');
});

// ── Liveness: a custom llm generator that ignores its AbortSignal ────────────────────────────────
// speak()'s producer parks in it.next() on HOST code. If that generator never yields again after a
// barge-in, awaiting it in the cleanup path would never return from speak() — wedging _speakTurn and
// every turn queued behind it. The aborted stream is DETACHED instead. These lock in that speak()
// settles, that the next reply works, that synths stay serialized (one ONNX predict at a time), and
// that the abandoned producer can't corrupt the newer turn's state when it finally wakes up.

// Counts overlapping _synth calls — a single ONNX session cannot run two predict()s at once.
class ConcurrencyTTS extends StreamingTTS {
  constructor(v) { super(v); this.live = 0; this.maxLive = 0; this.synthed = []; }
  async _synth(text) {
    if (!text) return null;
    this.live++; this.maxLive = Math.max(this.maxLive, this.live);
    await new Promise((r) => setTimeout(r, 5));
    this.live--; this.synthed.push(text);
    return blob(text);
  }
}

// Yields one sentence, then hangs forever — ignoring `signal` entirely, as a broken host llm would.
const deafStream = (first) => {
  let release;
  const gen = (async function* () { yield first; await new Promise((r) => { release = r; }); yield 'Never reached.'; })();
  return { gen, wake: () => release?.() };
};

test('LIVENESS: barge-in on an llm stream that ignores its signal still resolves speak()', async () => {
  const tts = new ConcurrencyTTS('v');
  const ctl = new AbortController();
  const { gen } = deafStream('First sentence.');

  let out = null;
  const p = tts.speak(gen, ctl.signal).then((r) => { out = r; });
  // Play out everything the stream gave us; the producer then parks in the deaf next().
  for (let i = 0; i < 60; i++) { await settle(); liveClip(tts)?.end(); }
  ctl.abort();                                            // barge-in; the generator never reacts

  await Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('speak() never returned — the turn loop is wedged')), 2000))]);
  assert.equal(out, 'First sentence.', 'resolves with what was actually heard');
});

test('LIVENESS: the turn AFTER an abandoned stream plays normally, with synths still serialized', async () => {
  const tts = new ConcurrencyTTS('v');
  const ctl = new AbortController();
  const { gen, wake } = deafStream('First sentence.');

  const p = tts.speak(gen, ctl.signal);
  for (let i = 0; i < 50 && !liveClip(tts); i++) await settle();
  ctl.abort();
  await p;

  const out = await play(tts, 'Brand new reply. Second part.');
  assert.equal(out, 'Brand new reply. Second part.', 'the next turn is unaffected');
  wake();                                                 // the abandoned producer finally wakes up
  for (let i = 0; i < 30; i++) await settle();
  assert.equal(tts.maxLive, 1, 'never two concurrent synths — _synthQ still serializes across turns');
  assert.ok(!tts.synthed.includes('Never reached.'), 'the detached producer did not enqueue stale work');
});

test('LIVENESS: an abandoned producer waking late does not clear a newer reply presynth clip', async () => {
  const tts = new ConcurrencyTTS('v');
  const ctl = new AbortController();
  const { gen, wake } = deafStream('First sentence.');

  const p = tts.speak(gen, ctl.signal);
  for (let i = 0; i < 50 && !liveClip(tts); i++) await settle();
  ctl.abort();
  await p;

  tts.presynth('Next reply opener.');                     // speculation for the NEXT turn
  const pre = tts._preClip;
  assert.ok(pre, 'speculation is parked');
  wake();                                                 // stale producer resumes, mid-pull, generation behind
  for (let i = 0; i < 30; i++) await settle();
  assert.equal(tts._preClip, pre, 'the stale producer must not consume the newer turn speculation');
});

// ── a synth failure mid-reply must not swallow the rest of the answer ─────────────────────────
// One clip failing to render is a VOICE problem, not an ANSWER problem: the model already produced
// the text and the user already sees it. Throwing out of speak() at the failed clip abandoned every
// remaining sentence — the reply went silent partway and the turn recorded only the prefix as heard,
// so the agent's own history disagreed with what was on screen ("lost between talk"). A failed clip
// is now SKIPPED: its text still counts as delivered, and the following sentences still speak.
class FlakyTTS extends StreamingTTS {
  constructor(v, failText) { super(v); this.failText = failText; this.attempts = []; }
  async _synth(text) {
    this.attempts.push(text);
    if (text === this.failText) throw new Error('synth exploded');
    return text ? blob(text) : null;
  }
}

test('a mid-reply synth failure still speaks the sentences after it', async () => {
  const tts = new FlakyTTS('v', 'Second sentence here.');
  const out = await play(tts, 'Hello world. Second sentence here. Third one.');
  // The whole reply is returned — the failed sentence is silent, not amputated.
  assert.equal(out, 'Hello world. Second sentence here. Third one.');
  assert.ok(tts.attempts.includes('Third one.'), 'the sentence AFTER the failure was still synthesized');
});

test('a failing FIRST clip does not abandon the reply', async () => {
  const tts = new FlakyTTS('v', 'Hello world.');
  const out = await play(tts, 'Hello world. Second sentence here.');
  assert.equal(out, 'Hello world. Second sentence here.');
});

test('every clip failing still resolves with the full text (not a throw)', async () => {
  class AllFail extends StreamingTTS { async _synth() { throw new Error('no voice'); } }
  const tts = new AllFail('v');
  const out = await play(tts, 'One. Two.');
  assert.equal(out, 'One. Two.');
});

test('a skipped sentence is REPORTED, not silently dropped', async () => {
  const tts = new FlakyTTS('v', 'Second sentence here.');
  const events = [];
  tts.onEvent = (e) => events.push(e);
  await play(tts, 'Hello world. Second sentence here. Third one.');
  const err = events.find((e) => e.type === 'error');
  assert.ok(err, 'an error event was emitted for the unvoiced sentence');
  assert.match(err.error, /synth exploded/);
});

// heardMax after a skipped clip is a DELIVERY marker, not an audibility claim, and the two callers
// want opposite things — so pin the tradeoff rather than leave it to a future reader's guess.
// history: must contain the skipped sentence (the user READ it; dropping it desyncs the model).
// echo guard: over-wide scope only ever SUPPRESSES a barge-in on those exact words, and words that
// were never played can't come back off the mic — so the widened scope is inert in practice.
test('a skipped sentence is still part of the returned (delivered) text', async () => {
  const tts = new FlakyTTS('v', 'Middle one.');
  const out = await play(tts, 'First here. Middle one. Last here.');
  assert.equal(out, 'First here. Middle one. Last here.');
});

// The failure must not eat a LATER barge-in: after skipping, the next clip plays normally and an
// abort on it still truncates at what was really heard.
test('barge-in after a skipped clip still returns only the audible prefix', async () => {
  const tts = new FlakyTTS('v', 'Middle one.');
  const ctl = new AbortController();
  const out = await play(tts, 'First here. Middle one. Last here.', ctl.signal, (clip, t) => {
    // abort while the sentence AFTER the failed one is playing
    if (t._curIdx === 2) { ctl.abort(); clip.end(); return true; }
    return false;
  });
  assert.ok(out.startsWith('First here.'), 'kept what was actually played before the abort');
  // The skipped sentence is still credited (it was delivered on screen), but the abort must stop the
  // text there — a barge-in during clip 2 cannot report clip 2 as fully heard.
  assert.ok(out.includes('Middle one.'), 'the skipped-but-delivered sentence is still credited');
});

// The skip is scoped to SYNTH failures (entry.err). A dead audio path is NOT a per-sentence problem
// — every later clip would fail the same way — so _playBuf still throws and the turn surfaces it.
// Without this boundary the fix would turn "audio is broken" into a silent no-op reply.
test('a playback (not synth) failure still throws out of speak()', async () => {
  const tts = new FakeTTS('v');
  const realDecode = MockCtx.prototype.decodeAudioData;
  MockCtx.prototype.decodeAudioData = async () => { throw new Error('decode died'); };
  try {
    // speak() directly: play()'s polling loop would swallow the rejection into its own promise.
    await assert.rejects(() => tts.speak('One. Two.'), /Audio decode: decode died/);
  } finally { MockCtx.prototype.decodeAudioData = realDecode; }
});

// The skip branch advances idx before `continue` — if it ever didn't, an all-failing reply would
// spin forever and wedge the turn serializer behind it. Bound it in wall-clock, not iterations.
test('an all-failing reply terminates promptly (no spin)', async () => {
  class AllFail extends StreamingTTS { async _synth() { throw new Error('nope'); } }
  const tts = new AllFail('v');
  const long = Array.from({ length: 40 }, (_, i) => `Sentence number ${i}.`).join(' ');
  const t0 = Date.now();
  const out = await Promise.race([
    tts.speak(long),
    new Promise((_, rej) => setTimeout(() => rej(new Error('speak() did not terminate — spin')), 4000)),
  ]);
  assert.equal(out, long, 'all sentences still counted as delivered');
  assert.ok(Date.now() - t0 < 4000);
});
