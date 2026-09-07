import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installFluxTelemetry, traceAgent } from './experiments/capture-presynth-v2/telemetry.js';

test('Flux telemetry preserves transport and records samples without credentials or packet payloads', () => {
  const original = globalThis.WebSocket;
  class FakeSocket extends EventTarget {
    static OPEN = 1;
    constructor(url, protocols) { super(); this.url = url; this.protocols = protocols; this.sent = []; }
    send(data) { this.sent.push(data); return 'sent'; }
  }
  globalThis.WebSocket = FakeSocket;
  const events = [];
  try {
    installFluxTelemetry((type, data) => events.push({ type, ...data }));
    const ws = new WebSocket('wss://api.deepgram.com/v2/listen', ['bearer', 'secret-test-token']);
    assert.equal(WebSocket.OPEN, 1);
    const packet = new Int16Array(512);
    assert.equal(ws.send(packet), 'sent');
    ws.send(new Int16Array(4096).buffer);
    assert.equal(events.length, 0, 'no per-packet logging');
    assert.equal(ws.sent[0], packet, 'original data identity is preserved');
    const provider = { type:'TurnInfo',event:'EndOfTurn',turn_index:3,transcript:'hello',
      audio_window_start:1,audio_window_end:2,end_of_turn_confidence:.9 };
    ws.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(provider) }));
    assert.equal(events[0].transport.samplesSent, 4608);
    assert.equal(events[0].transport.packets, 2);
    assert.deepEqual(events[0].provider, provider);
    assert.equal(JSON.stringify(events).includes('secret-test-token'), false);
    const other = new WebSocket('wss://example.test/socket', ['other-secret']);
    other.send(packet);
    other.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(provider) }));
    assert.equal(events.length, 1, 'unrelated sockets are not instrumented');
  } finally { globalThis.WebSocket = original; }
});

test('agent tracing preserves receiver, arguments and return value', () => {
  const events = [], calls = [];
  const methods = ['_onSpeechStart','_onSpeechEnd','_onUserTurn','_takePrefetch'];
  const agent = { state:'listening', _speaking:true };
  for (const method of methods) agent[method] = function (...args) { calls.push([this, method, args]); return 42; };
  traceAgent(agent, (type, extra) => events.push({ type, ...extra }));
  assert.equal(agent._onUserTurn('hello', { speech:true }), 42);
  assert.equal(calls[0][0], agent);
  assert.deepEqual(calls[0][2], ['hello', { speech:true }]);
  assert.equal(events[0].method, '_onUserTurn');
});
