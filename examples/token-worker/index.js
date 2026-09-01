// voiceloop-token — the tiny backend the live demo needs, and nothing more.
//
// GitHub Pages is static, so the demo has no server to mint credentials. Cloud STT/TTS keys must
// never reach the page, so this Worker holds them and hands out only what each hop needs:
//
//   POST /stt/token  → { token, expires_in }   short-TTL Deepgram key (browser opens the WS itself)
//   POST /tts        → audio/mpeg bytes        ElevenLabs proxy (the xi-api-key stays here)
//
// Secrets (wrangler secret put): DEEPGRAM_API_KEY, ELEVENLABS_API_KEY.
// ALLOWED_ORIGINS (var) is a comma-separated allowlist — these routes spend real money, so an
// open CORS policy is an open wallet.

const json = (obj, status, origin) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...cors(origin) } });

const cors = (origin) => origin ? {
  'access-control-allow-origin': origin,
  'access-control-allow-headers': 'content-type,x-api-key',
  'access-control-allow-methods': 'POST,OPTIONS',
  'vary': 'Origin',
} : {};

// Echo back only an allowlisted origin: reflecting whatever arrives would let any page spend the key.
const allow = (req, env) => {
  const origin = req.headers.get('Origin');
  if (!origin) return null;
  const list = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return list.includes(origin) ? origin : null;
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
    if (req.method !== 'POST') return json({ error: 'POST only' }, 405, origin);

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

    return json({ error: 'not found' }, 404, origin);
  },
};
