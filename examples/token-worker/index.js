// voiceloop-token — the tiny backend the live demo needs, and nothing more.
//
// GitHub Pages is static, so the demo has no server to mint credentials. Cloud STT/TTS keys must
// never reach the page, so this Worker holds them and hands out only what each hop needs:
//
//   POST /stt/token  → { token, expires_in }   short-TTL Deepgram key (browser opens the WS itself)
//   POST /tts        → audio/mpeg bytes        ElevenLabs proxy (the xi-api-key stays here)
//   POST /llm        → OpenAI-format SSE       Anthropic proxy (there is no short-TTL key to mint)
//
// Secrets (wrangler secret put): DEEPGRAM_API_KEY, ELEVENLABS_API_KEY, ANTHROPIC_API_KEY.
// ALLOWED_ORIGINS (var) is a comma-separated allowlist — these routes spend real money, so an
// open CORS policy is an open wallet.
//
// Two layers, because they stop different things. The origin allowlist keeps OTHER PAGES from
// spending the keys — that is all CORS can do: it governs what browser JS may read, and a request
// with no Origin header (curl, a script) never engages it, while a non-browser caller can forge one.
// So every paid route also passes through a per-IP rate limit, which is what actually bounds the
// bill when the URL leaks. Neither is authentication; a demo backend holding capped, cheap keys is
// the threat model. Anything costlier needs real auth in front of it.

// Persona for the hosted demo (override with the SYSTEM_PROMPT var). The brevity rule is a cost
// AND a latency control: every output token is billed, and in a voice loop the reply is only as
// fast as the sentence the TTS is waiting to finish.
const HOSTED_PERSONA =
  'You are Jarvis, a voice assistant. Your reply is spoken aloud, so answer EXTREMELY briefly — ' +
  'one short sentence, two at most. Plain speakable prose: no markdown, no lists, no headings. ' +
  'Never explain that you are being brief.';

const json = (obj, status, origin) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...cors(origin) } });

const cors = (origin) => origin ? {
  'access-control-allow-origin': origin,
  'access-control-allow-headers': 'content-type,x-api-key',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'vary': 'Origin',
} : {};

// Echo back only an allowlisted origin: reflecting whatever arrives would let any page spend the key.
const allow = (req, env) => {
  const origin = req.headers.get('Origin');
  if (!origin) return null;
  const list = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return list.includes(origin) ? origin : null;
};

// Per-IP, on the paid routes only. Fails OPEN when the binding is absent so the example still runs
// under a plain `wrangler dev`, but the deployed config always has it.
const rateLimited = async (req, env) => {
  const ip = req.headers.get('CF-Connecting-IP') || 'unknown';
  return env.PAID_RATE_LIMITER ? !(await env.PAID_RATE_LIMITER.limit({ key: ip })).success : false;
};

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const origin = allow(req, env);

    if (req.method === 'OPTIONS') {
      // A disallowed origin gets no CORS headers at all — the browser then blocks it, which is the point.
      return new Response(null, { status: origin ? 204 : 403, headers: cors(origin) });
    }
    if (req.headers.get('Origin') && !origin) return json({ error: 'origin not allowed' }, 403, null);

    // GET /tts → the voice list. Listing needs the key too, so the browser can't ask ElevenLabs
    // itself (that endpoint is NOT public); the picker in a UI has to be fed from here.
    if (req.method === 'GET' && url.pathname === '/tts') {
      if (!env.ELEVENLABS_API_KEY) return json({ error: 'ELEVENLABS_API_KEY not configured' }, 500, origin);
      if (await rateLimited(req, env)) return json({ error: 'rate limited — try again in a minute' }, 429, origin);   // listing hits the key too
      const r = await fetch('https://api.elevenlabs.io/v2/voices?page_size=100', { headers: { 'xi-api-key': env.ELEVENLABS_API_KEY } });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) return json({ error: body.detail?.message || 'voice list failed' }, 502, origin);
      return json({ voices: (body.voices ?? []).map((v) => ({ id: v.voice_id, name: v.name })) }, 200, origin);
    }

    if (req.method !== 'POST') return json({ error: 'POST only' }, 405, origin);

    // Everything below mints a credential or bills a provider.
    if (await rateLimited(req, env)) return json({ error: 'rate limited — try again in a minute' }, 429, origin);

    if (url.pathname === '/stt/token') {
      if (!env.DEEPGRAM_API_KEY) return json({ error: 'DEEPGRAM_API_KEY not configured' }, 500, origin);
      // Deepgram mints the short-lived credential; the browser never sees the project key.
      const r = await fetch('https://api.deepgram.com/v1/auth/grant', {
        method: 'POST',
        headers: { authorization: `Token ${env.DEEPGRAM_API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ ttl_seconds: 300 }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok || !body.access_token) return json({ error: body.err_msg || body.error || 'grant failed' }, 502, origin);
      // voiceloop reads { token, expires_in } (see mintSttToken in src/stt.js).
      return json({ token: body.access_token, expires_in: body.expires_in ?? 300 }, 200, origin);
    }

    if (url.pathname === '/tts') {
      if (!env.ELEVENLABS_API_KEY) return json({ error: 'ELEVENLABS_API_KEY not configured' }, 500, origin);
      const { text, voice_id, model_id, output_format } = await req.json().catch(() => ({}));
      if (!text) return json({ error: 'text required' }, 400, origin);
      // Cap the spend per call: a leaked demo URL should cost cents, not a plan.
      if (text.length > 600) return json({ error: 'text too long' }, 413, origin);
      const fmt = output_format || 'mp3_44100_64';
      const r = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${voice_id || 'JBFqnCBsd6RMkjVDRZzb'}?output_format=${fmt}`,
        {
          method: 'POST',
          headers: { 'xi-api-key': env.ELEVENLABS_API_KEY, 'content-type': 'application/json' },
          body: JSON.stringify({ text, model_id: model_id || 'eleven_flash_v2_5' }),
        });
      if (!r.ok) return json({ error: `elevenlabs ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}` }, 502, origin);
      // Stream the audio straight through — buffering it here would add latency to the first clip.
      return new Response(r.body, { status: 200, headers: { 'content-type': 'audio/mpeg', ...cors(origin) } });
    }

    // Anthropic speaks /v1/chat/completions in OpenAI's format, so the SSE stream passes straight
    // through to the built-in makeOpenAILLM — this route adds the key and an allowlist, nothing else.
    // Streamed, never buffered: the first token is what the user waits for before any audio starts.
    if (url.pathname === '/llm') {
      if (!env.ANTHROPIC_API_KEY) return json({ error: 'ANTHROPIC_API_KEY not configured' }, 500, origin);
      const body = await req.json().catch(() => ({}));
      // Strip any caller-supplied system prompt: the persona is pinned HERE, like the model —
      // otherwise a caller could prompt the hosted demo into long (= expensive) answers.
      const messages = Array.isArray(body.messages) ? body.messages.filter((m) => m?.role !== 'system') : [];
      if (!messages.length) return json({ error: 'messages required' }, 400, origin);
      // Same reasoning as /tts's length cap: a leaked demo URL should cost cents, not a plan.
      if (JSON.stringify(messages).length > 8000) return json({ error: 'conversation too long' }, 413, origin);
      const r = await fetch('https://api.anthropic.com/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${env.ANTHROPIC_API_KEY}`, 'content-type': 'application/json' },
        // Built from an ALLOWLIST, never `...body`: forwarding the caller's object would carry
        // fields the size check above never measured — a huge `tools` schema bills as input tokens
        // on a 200-byte `messages`, and `max_completion_tokens` is a second output cap whose
        // precedence over max_tokens is undocumented. Only these four fields cross this boundary,
        // and the model is pinned here so a caller can't ask for the priciest model on the account.
        body: JSON.stringify({
          model: env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001',
          max_tokens: Math.min(Number(body.max_tokens) || 512, 1024),
          messages: [{ role: 'system', content: env.SYSTEM_PROMPT || HOSTED_PERSONA }, ...messages],
          stream: true,
        }),
      });
      if (!r.ok) return json({ error: `anthropic ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}` }, 502, origin);
      return new Response(r.body, { status: 200, headers: { 'content-type': 'text/event-stream', ...cors(origin) } });
    }

    return json({ error: 'not found' }, 404, origin);
  },
};
