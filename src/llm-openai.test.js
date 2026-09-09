// llm-openai.test.js — headless tests for the OpenAI-compatible streaming adapter.
// No network: we stub fetchFn with a fake SSE Response and drive the exact byte
// orderings that matter. Run: `node --test src/llm-openai.test.js`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeOpenAILLM } from './llm-openai.js';

// Build a fake streaming Response from a list of Uint8Array/string chunks.
const enc = new TextEncoder();
function fakeResponse(chunks, { ok = true, status = 200, statusText = 'OK' } = {}) {
  let i = 0;
  return {
    ok, status, statusText,
    text: async () => chunks.join(''),
    body: {
      getReader: () => ({
        read: async () => (i < chunks.length
          ? { value: typeof chunks[i] === 'string' ? enc.encode(chunks[i++]) : chunks[i++], done: false }
          : { done: true }),
        cancel: async () => {},
      }),
    },
  };
}

const fetchOf = (chunks, opts) => async () => fakeResponse(chunks, opts);
// A loop adapter fetches once per model message: serve the responses in order and keep the bodies.
const fetchSeq = (...responses) => { const sent = []; const fn = async (_u, init) => { sent.push(JSON.parse(init.body)); return fakeResponse(responses[sent.length - 1] ?? ['data: [DONE]\n\n']); }; fn.sent = sent; return fn; };
const DONE = 'data: [DONE]\n\n';
const collect = async (llm) => {
  const out = [];
  for await (const c of llm([{ role: 'user', content: 'hi' }], 'sys', new AbortController().signal)) out.push(c);
  return out;
};
const delta = (d, finish = null) => `data: ${JSON.stringify({ choices: [{ delta: d, finish_reason: finish }] })}\n\n`;

test('content deltas stream through in order', async () => {
  const llm = makeOpenAILLM({ llmUrl: 'x', fetchFn: fetchOf([delta({ content: 'Hel' }), delta({ content: 'lo' }), 'data: [DONE]\n\n']) });
  assert.deepEqual(await collect(llm), [{ text: 'Hel' }, { text: 'lo' }]);
});

test('an SSE record split across reads is reassembled', async () => {
  const whole = delta({ content: 'split' });
  const llm = makeOpenAILLM({ llmUrl: 'x', fetchFn: fetchOf([whole.slice(0, 12), whole.slice(12), 'data: [DONE]\n\n']) });
  assert.deepEqual(await collect(llm), [{ text: 'split' }]);
});

test('a multibyte UTF-8 char split across reads survives (TextDecoder streaming)', async () => {
  const bytes = enc.encode(delta({ content: 'árvíztűrő' }));
  const llm = makeOpenAILLM({ llmUrl: 'x', fetchFn: fetchOf([bytes.slice(0, 30), bytes.slice(30), 'data: [DONE]\n\n']) });
  assert.deepEqual(await collect(llm), [{ text: 'árvíztűrő' }]);
});

test('CRLF line endings are tolerated', async () => {
  const llm = makeOpenAILLM({ llmUrl: 'x', fetchFn: fetchOf([delta({ content: 'ok' }).replace(/\n/g, '\r\n'), 'data: [DONE]\r\n\r\n']) });
  assert.deepEqual(await collect(llm), [{ text: 'ok' }]);
});

test('final record without a trailing newline is not dropped', async () => {
  const last = delta({ content: 'tail' }).trimEnd();   // no \n at EOF
  const llm = makeOpenAILLM({ llmUrl: 'x', fetchFn: fetchOf([delta({ content: 'head' }), last]) });
  assert.deepEqual(await collect(llm), [{ text: 'head' }, { text: 'tail' }]);
});

// The adapter is a LOOP: a tool call is announced, run, reported, fed back as a tool message, and the
// model's next message follows a { newMessage } boundary.
const loopOf = (id, tool, args, result) => [
  { tool, id, args, running: true }, { tool, id, args, result }, { newMessage: true }, { text: 'done' },
];

test('stream ending without [DONE] still flushes buffered tool calls', async () => {
  const fetchFn = fetchSeq([
    delta({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'ping', arguments: '{"a"' } }] }),
    delta({ tool_calls: [{ index: 0, function: { arguments: ':1}' } }] }),
  ], [delta({ content: 'done' }), DONE]);
  const llm = makeOpenAILLM({ llmUrl: 'x', fetchFn, tools: { ping: { run: (a) => `pong ${a.a}` } } });
  assert.deepEqual(await collect(llm), loopOf('c1', 'ping', { a: 1 }, 'pong 1'));
});

test('fragmented tool arguments accumulate; the call runs on finish_reason tool_calls and its result is fed back', async () => {
  const fetchFn = fetchSeq([
    delta({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'get_weather', arguments: '' } }] }),
    delta({ tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] }),
    delta({ tool_calls: [{ index: 0, function: { arguments: '"Budapest"}' } }] }),
    delta({}, 'tool_calls'),
    DONE,
  ], [delta({ content: 'done' }), DONE]);
  const llm = makeOpenAILLM({ llmUrl: 'x', fetchFn, tools: { get_weather: { run: () => 'sunny' } } });
  assert.deepEqual(await collect(llm), loopOf('c1', 'get_weather', { city: 'Budapest' }, 'sunny'));
  const msgs = fetchFn.sent[1].messages;
  assert.deepEqual(msgs.at(-2), { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Budapest"}' } }] });
  assert.deepEqual(msgs.at(-1), { role: 'tool', tool_call_id: 'c1', content: 'sunny' });
});

test('two interleaved tool calls (by index) both run, reported in index order, ONE follow-up', async () => {
  const fetchFn = fetchSeq([
    delta({ tool_calls: [{ index: 0, id: 'a', function: { name: 'one', arguments: '{' } }] }),
    delta({ tool_calls: [{ index: 1, id: 'b', function: { name: 'two', arguments: '{}' } }] }),
    delta({ tool_calls: [{ index: 0, function: { arguments: '}' } }] }),
    delta({}, 'tool_calls'),
    DONE,
  ], [delta({ content: 'done' }), DONE]);
  const llm = makeOpenAILLM({ llmUrl: 'x', fetchFn, tools: { one: { run: () => '1' }, two: { run: () => { throw new Error('nope'); } } } });
  assert.deepEqual(await collect(llm), [
    { tool: 'one', id: 'a', args: {}, running: true },
    { tool: 'two', id: 'b', args: {}, running: true },
    { tool: 'one', id: 'a', args: {}, result: '1' },
    { tool: 'two', id: 'b', args: {}, error: 'nope' },
    { newMessage: true }, { text: 'done' },
  ]);
  assert.equal(fetchFn.sent.length, 2);
  assert.deepEqual(fetchFn.sent[1].messages.at(-1), { role: 'tool', tool_call_id: 'b', content: '[failed] nope' });
});

test('a provider re-sending the FULL tool name does not duplicate it', async () => {
  const fetchFn = fetchSeq([
    delta({ tool_calls: [{ index: 0, id: 'c', function: { name: 'get_weather', arguments: '{}' } }] }),
    delta({ tool_calls: [{ index: 0, function: { name: 'get_weather' } }] }),   // re-emit
    delta({}, 'tool_calls'),
    DONE,
  ], [delta({ content: 'done' }), DONE]);
  const runs = [];
  const llm = makeOpenAILLM({ llmUrl: 'x', fetchFn, tools: { get_weather: { run: () => runs.push(1) && 'ok' } } });
  assert.deepEqual(await collect(llm), loopOf('c', 'get_weather', {}, 'ok'));
  assert.equal(runs.length, 1);
});

test('a runaway tool loop is bounded', async () => {
  const call = [delta({ tool_calls: [{ index: 0, id: 'c', function: { name: 'again', arguments: '{}' } }] }), delta({}, 'tool_calls'), DONE];
  const fetchFn = fetchSeq(...Array(20).fill(call));
  const llm = makeOpenAILLM({ llmUrl: 'x', fetchFn, tools: { again: { run: () => 'more' } } });
  await collect(llm);
  assert.equal(fetchFn.sent.length, 6, 'stopped after MAX_ROUNDS model messages');
});

test('the tool gate is awaited before any tool runs; a rejected gate never executes it', async () => {
  const call = [delta({ tool_calls: [{ index: 0, id: 'c', function: { name: 'send', arguments: '{}' } }] }), delta({}, 'tool_calls'), DONE];
  let ran = 0;
  const llm = makeOpenAILLM({ llmUrl: 'x', fetchFn: fetchSeq(call, [delta({ content: 'sent' }), DONE]), tools: { send: { run: () => ++ran && 'ok' } } });
  let commit;
  const gate = new Promise((r) => { commit = r; });
  const gen = llm([], 'sys', new AbortController().signal, { toolGate: gate });
  assert.deepEqual((await gen.next()).value, { tool: 'send', id: 'c', args: {}, running: true });
  const next = gen.next();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(ran, 0, 'held at the door');
  commit();
  assert.deepEqual((await next).value, { tool: 'send', id: 'c', args: {}, result: 'ok' });
  const dropped = makeOpenAILLM({ llmUrl: 'x', fetchFn: fetchSeq(call), tools: { send: { run: () => ++ran && 'ok' } } });
  const out = [];
  await assert.rejects((async () => { for await (const c of dropped([], 'sys', undefined, { toolGate: Promise.reject(new Error('dropped')) })) out.push(c); })());
  assert.equal(ran, 1, 'a dropped speculation never fired the tool');
});

test('malformed/truncated tool arguments DROP the call — never fire with {}', async () => {
  const llm = makeOpenAILLM({ llmUrl: 'x', fetchFn: fetchOf([
    delta({ tool_calls: [{ index: 0, id: 'c', function: { name: 'nuke', arguments: '{"target":"Budap' } }] }),
    // stream truncated — no more argument bytes, no [DONE]
  ]) });
  assert.deepEqual(await collect(llm), [], 'truncated call was dropped, not fired with wrong args');
});

test('mixed content + tool call in one turn: text streams, call follows, text rides in the fed-back assistant message', async () => {
  const fetchFn = fetchSeq([
    delta({ content: 'On it. ' }),
    delta({ tool_calls: [{ index: 0, id: 'c', function: { name: 'do_it', arguments: '{}' } }] }),
    delta({}, 'tool_calls'),
    DONE,
  ], [delta({ content: 'done' }), DONE]);
  const llm = makeOpenAILLM({ llmUrl: 'x', fetchFn, tools: { do_it: { run: () => undefined } } });
  assert.deepEqual(await collect(llm), [{ text: 'On it. ' }, ...loopOf('c', 'do_it', {}, undefined)]);
  assert.equal(fetchFn.sent[1].messages.at(-2).content, 'On it. ');
  assert.equal(fetchFn.sent[1].messages.at(-1).content, 'ok');
});

test('provider error event throws with the message', async () => {
  const llm = makeOpenAILLM({ llmUrl: 'x', fetchFn: fetchOf(['data: {"error":{"message":"rate limited"}}\n\n']) });
  await assert.rejects(collect(llm), /rate limited/);
});

test('non-OK HTTP response throws the provider error message', async () => {
  const fetchFn = async () => ({ ok: false, status: 401, statusText: 'Unauthorized', text: async () => '{"error":{"message":"bad key"}}' });
  const llm = makeOpenAILLM({ llmUrl: 'x', fetchFn });
  await assert.rejects(collect(llm), /bad key/);
});

test('non-OK with a non-JSON body falls back to status text', async () => {
  const fetchFn = async () => ({ ok: false, status: 502, statusText: 'Bad Gateway', text: async () => '<html>oops</html>' });
  const llm = makeOpenAILLM({ llmUrl: 'x', fetchFn });
  await assert.rejects(collect(llm), /502 Bad Gateway/);
});

test('keep-alive junk and comment lines are skipped', async () => {
  const llm = makeOpenAILLM({ llmUrl: 'x', fetchFn: fetchOf([': ping\n\n', 'data: not-json\n\n', delta({ content: 'ok' }), 'data: [DONE]\n\n']) });
  assert.deepEqual(await collect(llm), [{ text: 'ok' }]);
});

test('missing llmUrl throws a clear config error', async () => {
  const llm = makeOpenAILLM({});
  await assert.rejects(collect(llm), /no `llm` generator and no `llmUrl`/);
});

test('request body: system message first, tools converted, model omitted when empty', async () => {
  let sent;
  const fetchFn = async (url, init) => { sent = JSON.parse(init.body); return fakeResponse(['data: [DONE]\n\n']); };
  const llm = makeOpenAILLM({ llmUrl: 'x', fetchFn, tools: {
    get_weather: { description: 'w', params: { city: { type: 'string' }, units: { type: 'string' } }, required: ['city'], run: () => {} },
  } });
  await collect(llm);
  assert.equal(sent.messages[0].role, 'system');
  assert.equal(sent.messages[0].content, 'sys');
  assert.equal(sent.model, undefined, 'empty model omitted (proxy default wins)');
  assert.equal(sent.stream, true);
  const t = sent.tools[0].function;
  assert.equal(t.name, 'get_weather');
  assert.deepEqual(t.parameters.required, ['city'], 'explicit required list wins over all-keys default');
});

test('abort mid-stream surfaces as AbortError', async () => {
  const ctl = new AbortController();
  const fetchFn = async (url, { signal }) => ({
    ok: true,
    body: {
      getReader: () => ({
        read: () => new Promise((resolve, reject) => {
          if (signal.aborted) return reject(new DOMException('aborted', 'AbortError'));
          signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
          resolve({ value: enc.encode(delta({ content: 'x' })), done: false });
          // subsequent reads hang until abort
          resolve = () => {};
        }),
        cancel: async () => {},
      }),
    },
  });
  const llm = makeOpenAILLM({ llmUrl: 'x', fetchFn });
  const gen = llm([], 'sys', ctl.signal);
  assert.deepEqual((await gen.next()).value, { text: 'x' });
  ctl.abort();
  await assert.rejects(gen.next(), (e) => e.name === 'AbortError');
});

import { toOpenAIMessages } from './llm-openai.js';

test('toOpenAIMessages: native tool blocks → tool_calls + role:tool; text kept; is_error text-marked', () => {
  const out = toOpenAIMessages([
    { role: 'user', content: 'go' },
    { role: 'assistant', content: [{ type: 'text', text: 'on it' }, { type: 'tool_use', id: 'c1', name: 'ls', input: { p: '.' } }, { type: 'tool_use', id: 'c2', name: 'rm', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'a b' }, { type: 'tool_result', tool_use_id: 'c2', content: 'denied', is_error: true }, { type: 'text', text: 'hurry' }] },
    { role: 'user', content: [{ type: 'text', text: 'hello' }] },
  ]);
  assert.deepEqual(out, [
    { role: 'user', content: 'go' },
    { role: 'assistant', content: 'on it', tool_calls: [
      { id: 'c1', type: 'function', function: { name: 'ls', arguments: '{"p":"."}' } },
      { id: 'c2', type: 'function', function: { name: 'rm', arguments: '{}' } },
    ] },
    { role: 'tool', tool_call_id: 'c1', content: 'a b' },
    { role: 'tool', tool_call_id: 'c2', content: '[failed] denied' },
    { role: 'user', content: 'hurry' },
    { role: 'user', content: 'hello' },
  ]);
});
