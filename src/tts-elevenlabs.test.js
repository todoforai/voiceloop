// tts-elevenlabs.test.js — ElevenLabsTTS socket path lifecycle, against a scripted mock WebSocket.
// Locks in: a healthy socket returns a Blob and reports usage; abort → null without backoff; a
// stalled open / failed mint / empty final / provider error fall back to HTTP (exactly one HTTP
// call) and back the socket off; a stale socket's late close can't fail a replacement's clip;
// close() during an open leaves no live socket. Run: `node --test src/tts-elevenlabs.test.js`.
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = { AudioContext: class {}, webkitAudioContext: class {} };
const { ElevenLabsTTS } = await import('./tts-elevenlabs.js');

const B64 = Buffer.from('mp3bytes').toString('base64');
// Scripted socket: `script(ws, msg)` decides what the "server" sends back for each client frame.
const sockets = [];
function installWS(script) {
  globalThis.WebSocket = class {
    constructor(url) { this.url = url; this.readyState = 0; this.sent = []; sockets.push(this);
      queueMicrotask(() => { if (script.openFails) { this.readyState = 3; this.onerror?.(); } else if (!script.hang) { this.readyState = 1; this.onopen?.(); } }); }
    send(s) { const m = JSON.parse(s); this.sent.push(m); script.onSend?.(this, m); }
    close() { this.readyState = 3; queueMicrotask(() => this.onclose?.({ code: 1000 })); }
    // server helpers
    reply(m) { this.onmessage?.({ data: JSON.stringify(m) }); }
    serverClose() { this.readyState = 3; this.onclose?.({ code: 1011 }); }
  };
}
// Default server: answers each text frame with one audio chunk + final for that context.
const okServer = { onSend: (ws, m) => { if (m.text && m.context_id.startsWith('c')) { ws.reply({ audio: B64, contextId: m.context_id }); ws.reply({ isFinal: true, contextId: m.context_id }); } } };

let httpCalls, usageCalls;
globalThis.fetch = async (url, init) => {
  if (String(url).endsWith('/usage')) { usageCalls.push(JSON.parse(init.body)); return new Response('{}'); }
  httpCalls.push(JSON.parse(init.body));
  return new Response(Buffer.from('httpmp3'), { headers: { 'content-type': 'audio/mpeg' } });
};
const make = (o = {}) => { httpCalls = []; usageCalls = []; sockets.length = 0;
  return new ElevenLabsTTS({ ttsUrl: 'https://x/tts', headers: { 'X-API-Key': 'k' }, languageCode: 'hu', usageUrl: 'https://x/usage', getWsToken: async () => ({ token: 'sutkn_t' }), ...o }); };

test('socket clip → Blob, one usage report, no HTTP', async () => {
  installWS(okServer); const tts = make();
  const b = await tts._synth('Szia világ.');
  assert.equal(await b.text(), 'mp3bytes'); assert.equal(b.type, 'audio/mpeg');
  assert.deepEqual(usageCalls, [{ chars: 11, voice_id: 'JBFqnCBsd6RMkjVDRZzb', model_id: 'eleven_flash_v2_5' }]);
  assert.equal(httpCalls.length, 0);
  assert.ok(sockets[0].url.includes('single_use_token=sutkn_t') && sockets[0].url.includes('language_code=hu'));
  const second = await tts._synth('Második.'); assert.ok(second); assert.equal(sockets.length, 1, 'socket reused');
  tts.close(); assert.equal(sockets[0].readyState, 3);
});

test('warm() runs a throwaway socket clip: not reported as usage, socket stays warm', async () => {
  installWS(okServer); const tts = make();
  await tts.warm();
  assert.equal(sockets.length, 1); assert.ok(sockets[0].sent.some((m) => m.text === 'Ok. '));
  assert.equal(usageCalls.length, 0); assert.ok(tts._conn);
  await tts._synth('Igazi.'); assert.equal(usageCalls.length, 1); assert.equal(sockets.length, 1);
});

test('abort mid-clip → null, close_context sent, socket stays, no backoff', async () => {
  installWS({ onSend: () => {} }); const tts = make();   // server never answers
  const ac = new AbortController(); const p = tts._synth('Hosszú mondat.', ac.signal);
  await new Promise((r) => setTimeout(r, 5)); ac.abort();
  assert.equal(await p, null);
  assert.ok(sockets[0].sent.some((m) => m.close_context && m.context_id === 'c1'));
  assert.equal(tts._wsDisabledUntil, 0); assert.ok(tts._conn, 'socket kept');
  assert.equal(httpCalls.length, 0); assert.equal(usageCalls.length, 0);
});

test('provider error on a context → HTTP fallback for that clip, socket backed off', async () => {
  installWS({ onSend: (ws, m) => { if (m.text) ws.reply({ error: 'boom', message: 'synth failed', contextId: m.context_id }); } });
  const tts = make(); const diags = []; tts.onEvent = (e) => diags.push(e.diag);
  const b = await tts._synth('Teszt.');
  assert.equal(await b.text(), 'httpmp3'); assert.equal(httpCalls.length, 1);
  assert.ok(tts._wsDisabledUntil > Date.now()); assert.deepEqual(diags, ['tts_ws_error', 'tts_ws_fallback']);
  await tts._synth('Még egy.'); assert.equal(httpCalls.length, 2); assert.equal(sockets.length, 1, 'no reconnect while backed off');
});

test('empty final → fallback (not silently null)', async () => {
  installWS({ onSend: (ws, m) => { if (m.text) ws.reply({ isFinal: true, contextId: m.context_id }); } });
  const tts = make(); const b = await tts._synth('Teszt.'); assert.equal(await b.text(), 'httpmp3');
});

test('token mint failure → HTTP, backoff, warm() respects backoff', async () => {
  installWS(okServer); const tts = make({ getWsToken: async () => { throw new Error('401'); } });
  const b = await tts._synth('Teszt.'); assert.equal(await b.text(), 'httpmp3'); assert.equal(sockets.length, 0);
  await tts.warm(); assert.equal(sockets.length, 0, 'warm must not reconnect during backoff');
});

test('handshake hang → bounded by open timeout, HTTP serves', async () => {
  installWS({ hang: true }); const tts = make();
  
  const t0 = Date.now();
  const b = await Promise.race([tts._synth('Teszt.'), new Promise((r) => setTimeout(() => r('slow'), 4500))]);
  assert.notEqual(b, 'slow', 'fell back within the open timeout'); assert.equal(await b.text(), 'httpmp3');
  assert.ok(Date.now() - t0 >= 3900);
});

test('stale socket close cannot fail the replacement socket\'s clip', async () => {
  // Server answers only the warm clip; real clips wait for the test to reply by hand.
  installWS({ onSend: (ws, m) => { if (m.text === 'Ok. ') { ws.reply({ audio: B64, contextId: m.context_id }); ws.reply({ isFinal: true, contextId: m.context_id }); } } });
  const tts = make();
  await tts.warm(); const a = sockets[0];
  tts.setVoice('otherVoice');                       // retires a (intentional, no backoff)
  const p = tts._synth('Teszt.');                   // opens b
  await new Promise((r) => setTimeout(r, 5)); const b = sockets[1]; assert.ok(b && b !== a);
  a.serverClose();                                  // late close from the OLD socket
  assert.equal(tts._wsDisabledUntil, 0, 'stale close is not a failure of the live socket');
  const ctx = b.sent.find((m) => m.text && m.text !== 'Ok. ').context_id;
  b.reply({ audio: B64, contextId: ctx }); b.reply({ isFinal: true, contextId: ctx });
  assert.equal(await (await p).text(), 'mp3bytes');
});

test('close() during open → no live socket afterwards, pending clip returns null', async () => {
  installWS({ hang: true }); const tts = make();
  const p = tts._synth('Teszt.'); await new Promise((r) => setTimeout(r, 2));
  tts.close();
  sockets[0].readyState = 1; sockets[0].onopen?.();   // handshake completes after close
  assert.equal(await p, null); assert.equal(tts._conn, null); assert.equal(httpCalls.length, 0);
});

test('without getWsToken the HTTP path is untouched', async () => {
  installWS(okServer); const tts = make({ getWsToken: undefined });
  const b = await tts._synth('Teszt.'); assert.equal(await b.text(), 'httpmp3'); assert.equal(sockets.length, 0);
  assert.deepEqual(httpCalls[0], { text: 'Teszt.', model_id: 'eleven_flash_v2_5', language_code: 'hu', voice_id: 'JBFqnCBsd6RMkjVDRZzb', output_format: 'mp3_44100_64' });
});
