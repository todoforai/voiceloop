// ── Default LLM: any OpenAI-compatible /chat/completions endpoint ───────────────────────────────
// Normalizes the OpenAI streaming wire format to the VoiceAgent chunk contract:
//   { text }          — one per content delta (streamed straight into the TTS)
//   { tool, args, id }— one per COMPLETED tool call (arguments accumulate across deltas; a call
//                       whose accumulated arguments never parse as JSON is DROPPED with a warning —
//                       firing a side-effecting tool with guessed/empty args would be worse)
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
export function makeOpenAILLM({ llmUrl, apiKey = '', model = '', maxTokens = 1024, tools = {}, fetchFn, extraBody = {} } = {}) {
  const toolSpecs = Object.entries(tools).map(([name, t]) => ({
    type: 'function',
    function: {
      name,
      description: t.description ?? '',
      parameters: { type: 'object', properties: t.params ?? {}, required: t.required ?? Object.keys(t.params ?? {}) },
    },
  }));

  return async function* (history, system, signal) {
    if (!llmUrl) throw new Error('VoiceAgent: no `llm` generator and no `llmUrl` configured — pass one of them');
    const doFetch = fetchFn ?? fetch;
    const r = await doFetch(llmUrl, {
      method: 'POST', signal,
      headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify({
        stream: true,
        messages: [{ role: 'system', content: system }, ...history],
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
        // Truncated/invalid argument JSON (aborted stream, provider bug) → DROP the call. The agent
        // dispatches tools immediately, so guessing `{}` could fire a real side effect with the
        // wrong arguments.
        try { args = c.args ? JSON.parse(c.args) : {}; }
        catch { console.warn(`makeOpenAILLM: dropping tool call "${c.name}" — arguments never parsed: ${c.args}`); continue; }
        yield { tool: c.name, args, ...(c.id ? { id: c.id } : {}) };
      }
      pending.clear();
    };

    // One SSE data payload → zero or more chunks. Returns 'done' on [DONE].
    const handle = function* (payload) {
      if (payload === '[DONE]') return;   // caller checks the sentinel itself
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
  };
}
