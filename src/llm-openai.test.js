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

test('stream ending without [DONE] still flushes buffered tool calls', async () => {
  const llm = makeOpenAILLM({ llmUrl: 'x', fetchFn: fetchOf([
    delta({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'ping', arguments: '{"a"' } }] }),
    delta({ tool_calls: [{ index: 0, function: { arguments: ':1}' } }] }),
  ]) });
  assert.deepEqual(await collect(llm), [{ tool: 'ping', args: { a: 1 }, id: 'c1' }]);
});

test('fragmented tool arguments accumulate; call emitted on finish_reason tool_calls', async () => {
  const llm = makeOpenAILLM({ llmUrl: 'x', fetchFn: fetchOf([
    delta({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'get_weather', arguments: '' } }] }),
    delta({ tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] }),
    delta({ tool_calls: [{ index: 0, function: { arguments: '"Budapest"}' } }] }),
    delta({}, 'tool_calls'),
    'data: [DONE]\n\n',
  ]) });
  assert.deepEqual(await collect(llm), [{ tool: 'get_weather', args: { city: 'Budapest' }, id: 'c1' }]);
});

test('two interleaved tool calls (by index) both emit, in index order', async () => {
  const llm = makeOpenAILLM({ llmUrl: 'x', fetchFn: fetchOf([
    delta({ tool_calls: [{ index: 0, id: 'a', function: { name: 'one', arguments: '{' } }] }),
    delta({ tool_calls: [{ index: 1, id: 'b', function: { name: 'two', arguments: '{}' } }] }),
    delta({ tool_calls: [{ index: 0, function: { arguments: '}' } }] }),
    delta({}, 'tool_calls'),
    'data: [DONE]\n\n',
  ]) });
  assert.deepEqual(await collect(llm), [
    { tool: 'one', args: {}, id: 'a' },
    { tool: 'two', args: {}, id: 'b' },
  ]);
});

test('a provider re-sending the FULL tool name does not duplicate it', async () => {
  const llm = makeOpenAILLM({ llmUrl: 'x', fetchFn: fetchOf([
    delta({ tool_calls: [{ index: 0, id: 'c', function: { name: 'get_weather', arguments: '{}' } }] }),
    delta({ tool_calls: [{ index: 0, function: { name: 'get_weather' } }] }),   // re-emit
    delta({}, 'tool_calls'),
    'data: [DONE]\n\n',
  ]) });
  assert.deepEqual(await collect(llm), [{ tool: 'get_weather', args: {}, id: 'c' }]);
});

test('malformed/truncated tool arguments DROP the call — never fire with {}', async () => {
  const llm = makeOpenAILLM({ llmUrl: 'x', fetchFn: fetchOf([
    delta({ tool_calls: [{ index: 0, id: 'c', function: { name: 'nuke', arguments: '{"target":"Budap' } }] }),
    // stream truncated — no more argument bytes, no [DONE]
  ]) });
  assert.deepEqual(await collect(llm), [], 'truncated call was dropped, not fired with wrong args');
});

test('mixed content + tool call in one turn: text streams, call follows', async () => {
  const llm = makeOpenAILLM({ llmUrl: 'x', fetchFn: fetchOf([
    delta({ content: 'On it. ' }),
    delta({ tool_calls: [{ index: 0, id: 'c', function: { name: 'do_it', arguments: '{}' } }] }),
    delta({}, 'tool_calls'),
    'data: [DONE]\n\n',
  ]) });
  assert.deepEqual(await collect(llm), [{ text: 'On it. ' }, { tool: 'do_it', args: {}, id: 'c' }]);
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
