// ── Default LLM: any OpenAI-compatible /chat/completions endpoint ───────────────────────────────
// A LOOP adapter (executesTools + acceptsToolGate): one turn may span several model messages. Each
// completion streams { text } deltas straight to the TTS; a COMPLETED tool call (arguments accumulate
// across deltas; a call whose arguments never parse as JSON is DROPPED with a warning — firing a
// side-effecting tool with guessed args would be worse) is announced ({ running: true }), executed
// here, reported with its outcome, fed back to the model as a tool message, and the model's next
// message starts after a { newMessage } boundary — bounded by MAX_ROUNDS per turn.
//
// Works against OpenAI, Groq, Cerebras, Together, OpenRouter, Ollama, vLLM, LiteLLM… anything that
// speaks /chat/completions SSE. NEVER ship a provider secret key to a public page — in production
// point `llmUrl` at your own proxy route that injects the key server-side.
//
// Options:
//   llmUrl   — full /chat/completions URL (required unless you pass a custom `llm` to VoiceAgent)
//   apiKey   — sent as `Authorization: Bearer …` (omit when your proxy handles auth)
//   model    — model name; omitted from the body when empty (lets a proxy pick its default)
//   maxTokens
//   tools    — VoiceAgent's tool map { name: { description, params, required? } }; converted to
//              OpenAI tool specs (params = JSON-schema `properties`; `required` lists mandatory
//              keys, defaulting to all of them)
//   fetchFn  — fetch override (tests, custom agents/headers); defaults to global fetch
//   extraBody— merged into the request body (temperature, provider-specific knobs, …)
// VoiceAgent history → OpenAI chat messages. Plain turns pass through; the agent's native tool
// records (assistant text + tool_use blocks, then a user turn of tool_result blocks — the same
// Anthropic-shaped blocks it keeps for every adapter) become `tool_calls` and `role:"tool"` messages.
export const toOpenAIMessages = (history) => history.flatMap((m) => {
  if (!Array.isArray(m.content)) return [m];
  const text = m.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  if (m.role === 'assistant') {
    const tool_calls = m.content.filter((b) => b.type === 'tool_use')
      .map((b) => ({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
    return [{ role: 'assistant', content: text || null, ...(tool_calls.length ? { tool_calls } : {}) }];
  }
  const results = m.content.filter((b) => b.type === 'tool_result').map((b) => {
    const content = typeof b.content === 'string' ? b.content : String(b.content ?? '');
    return { role: 'tool', tool_call_id: b.tool_use_id, content: b.is_error && !content.startsWith('[failed]') ? `[failed] ${content}` : content };
  });
  return text ? [...results, { role: m.role, content: text }] : results;   // OpenAI has no is_error → text-marked
});

// Render a host tool's return value as model-facing text (the tool_result content in history, and
// what adapters feed back to the model). Never throws: the side effect already RAN, so an
// unserializable result must not retro-fail the call and invite a retry.
export const toolResultText = (result) => {
  if (result === undefined) return 'ok';
  if (typeof result === 'string') return result;
  if (result && typeof result.text === 'string' && typeof result.ok === 'boolean')
    return result.ok ? result.text : `[failed] ${result.text}`;
  try { return JSON.stringify(result) ?? 'ok'; } catch { return String(result); }
};

const MAX_ROUNDS = 6;   // model messages per user turn — a model that keeps calling tools then waits for the user

export function makeOpenAILLM({ llmUrl, apiKey = '', model = '', maxTokens = 1024, tools = {}, fetchFn, extraBody = {} } = {}) {
  const toolSpecs = Object.entries(tools).map(([name, t]) => ({
    type: 'function',
    function: {
      name,
      description: t.description ?? '',
      parameters: { type: 'object', properties: t.params ?? {}, required: t.required ?? Object.keys(t.params ?? {}) },
    },
  }));

  // One completion: streams { text } and COMPLETED { tool, args, id } chunks for a wire-shaped message list.
  async function* streamOnce(messages, signal) {
    const doFetch = fetchFn ?? fetch;
    const r = await doFetch(llmUrl, {
      method: 'POST', signal,
      headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify({
        stream: true,
        messages,
        max_tokens: maxTokens,
        ...(model ? { model } : {}),
        ...(toolSpecs.length ? { tools: toolSpecs } : {}),
        ...extraBody,
      }),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      let msg; try { msg = JSON.parse(body)?.error?.message ?? JSON.parse(body)?.error; } catch {}
      throw new Error(msg || `LLM ${r.status} ${r.statusText}`);
    }

    // Tool-call deltas arrive fragmented ({index, id?, function:{name?, arguments?}} per chunk) —
    // accumulate per index, emit when the provider signals the calls are complete (finish_reason
    // 'tool_calls') or, defensively, at stream end.
    const pending = new Map();   // index -> { id, name, args: '' }
    const flush = function* () {
      for (const c of pending.values()) {
        if (!c.name) continue;
        let args;
        try { args = c.args ? JSON.parse(c.args) : {}; }
        catch { console.warn(`makeOpenAILLM: dropping tool call "${c.name}" — arguments never parsed: ${c.args}`); continue; }
        yield { tool: c.name, args, ...(c.id ? { id: c.id } : {}) };
      }
      pending.clear();
    };

    // One SSE data payload → zero or more chunks.
    const handle = function* (payload) {
      let m; try { m = JSON.parse(payload); } catch { return; }   // tolerate keep-alive junk
      if (m.error) throw new Error(m.error.message ?? String(m.error));
      const choice = m.choices?.[0];
      if (!choice) return;
      const d = choice.delta ?? {};
      if (d.content) yield { text: d.content };
      for (const tc of d.tool_calls ?? []) {
        const cur = pending.get(tc.index ?? 0) ?? { id: '', name: '', args: '' };
        if (tc.id) cur.id = tc.id;
        // Names are ASSIGNED, not concatenated: OpenAI sends the name once, but some compatible
        // providers re-send the full name on later deltas — concatenating would corrupt it.
        if (tc.function?.name) cur.name = tc.function.name;
        if (tc.function?.arguments) cur.args += tc.function.arguments;
        pending.set(tc.index ?? 0, cur);
      }
      if (choice.finish_reason === 'tool_calls') yield* flush();
    };

    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    try {
      while (true) {
        const { value, done } = await reader.read();
        buf += done ? dec.decode() : dec.decode(value, { stream: true });   // flush the decoder at EOF
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') { yield* flush(); return; }
          yield* handle(payload);
        }
        if (done) break;
      }
      // EOF: a final record without a trailing newline is still a record — parse the tail, then
      // flush any buffered tool calls (defensive: stream ended without finish_reason/[DONE]).
      const tail = buf.trim();
      if (tail.startsWith('data:')) {
        const payload = tail.slice(5).trim();
        if (payload !== '[DONE]') yield* handle(payload);
      }
      yield* flush();
    } finally {
      reader.cancel().catch(() => {});
    }
  }

  const gen = async function* (history, system, signal, { toolGate } = {}) {
    if (!llmUrl) throw new Error('VoiceAgent: no `llm` generator and no `llmUrl` configured — pass one of them');
    // Anthropic-shaped working history (what VoiceAgent keeps); re-serialized to the wire every round
    // so tool_use/tool_result pairing stays in ONE place (toOpenAIMessages).
    const hist = [...history];
    for (let round = 0; round < MAX_ROUNDS; round++) {
      let text = '';
      const calls = [];   // { id, tool, args, outcome: Promise<{result}|{error}> }
      const seen = new Set();
      for await (const c of streamOnce([{ role: 'system', content: system }, ...toOpenAIMessages(hist)], signal)) {
        if (c.text) { text += c.text; yield c; continue; }
        const id = c.id || `call-${round}-${calls.length + 1}`;   // announcements need an id to be replaced in place
        if (seen.has(id)) continue;
        seen.add(id);
        yield { tool: c.tool, id, args: c.args, running: true };
        // Execute NOW, in parallel with TTS. A speculative run waits at the gate: it rejects when the
        // speculation is dropped, so the tool never fires for a turn the user was still amending.
        const outcome = (async () => {
          if (toolGate) await toolGate;
          try { return { result: await tools[c.tool]?.run?.(c.args) }; }
          catch (e) { return { error: e?.message || String(e ?? 'failed') }; }
        })();
        calls.push({ id, tool: c.tool, args: c.args, outcome });
      }
      if (!calls.length) return;
      const results = [];
      for (const c of calls) {
        const o = await c.outcome;
        yield { tool: c.tool, id: c.id, args: c.args, ...o };
        const failed = 'error' in o || (o.result && typeof o.result === 'object' && o.result.ok === false);
        results.push({ type: 'tool_result', tool_use_id: c.id, content: 'error' in o ? String(o.error) : toolResultText(o.result), ...(failed ? { is_error: true } : {}) });
      }
      hist.push({ role: 'assistant', content: [...(text ? [{ type: 'text', text }] : []), ...calls.map((c) => ({ type: 'tool_use', id: c.id, name: c.tool, input: c.args ?? {} }))] });
      hist.push({ role: 'user', content: results });
      yield { newMessage: true };
    }
  };
  gen.executesTools = true;
  gen.acceptsToolGate = true;
  return gen;
}
