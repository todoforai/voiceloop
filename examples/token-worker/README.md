# voiceloop-token

The tiny backend the live demo needs. GitHub Pages is static, so it has no server to mint
credentials — and cloud STT/TTS keys must never reach the page. This Worker holds them and hands
out only what each hop needs.

| route | returns | why |
|---|---|---|
| `POST /stt/token` | `{ token, expires_in }` | short-TTL Deepgram key; the browser opens the WS itself |
| `POST /tts` | `audio/mpeg` | ElevenLabs proxy — the `xi-api-key` stays server-side |
| `POST /llm` | OpenAI-format SSE | Anthropic proxy — Claude has no short-TTL key to mint, so the key stays here |

(The voiceloop demo runs this exact Worker.)

## Deploy

```sh
wrangler deploy
wrangler secret put DEEPGRAM_API_KEY
wrangler secret put ELEVENLABS_API_KEY
wrangler secret put ANTHROPIC_API_KEY
```

`ALLOWED_ORIGINS` (in `wrangler.toml`) is a comma-separated allowlist. These routes spend real
money, so an open CORS policy is an open wallet — a request from an unlisted origin gets no CORS
headers and a 403. But CORS is **not** authentication: it governs what browser JS may read, and a
request with no `Origin` (curl, a script) never engages it while a non-browser caller can forge one.
So every paid route also passes per-IP rate limits in two windows: a 60s `[[ratelimits]]` burst
limiter (best-effort, per-Cloudflare-location — `/stt/token` gets a tight one, the `/tts`+`/llm`
conversation hot path a roomier one) and a long-window quota (`QUOTA_LIMIT` calls per
`QUOTA_PERIOD_H` hours, default 300/6h) counted globally in a Durable Object — that one is the
actual wallet cap. Combine it with provider-side spend caps; anything costlier than a demo key
needs real auth in front.

`/tts` caps text at 600 chars and `/llm` caps the conversation at 8000.

`/llm` pins the model server-side (`ANTHROPIC_MODEL`, default `claude-haiku-4-5-20251001`) and caps
`max_tokens`, and forwards an ALLOWLIST rather than the caller's object (only `messages` and a
clamped `max_tokens` are read from the request; model and stream mode are server-owned):
the page picks neither model nor limits, and a large `tools` schema can't smuggle billable input
tokens past the size check. Anthropic serves an OpenAI-compatible `/v1/chat/completions`, so the SSE passes straight
through to voiceloop's built-in `makeOpenAILLM` — no client-side adapter.

The persona is pinned server-side too (`SYSTEM_PROMPT` var, default: Jarvis, answer extremely
briefly): caller-supplied `system` messages are stripped, so a client can't prompt the hosted
demo into long — i.e. expensive — answers. Brevity doubles as a latency control: the reply is
only as fast as the sentence the TTS is waiting to finish.

## Use it from the demo

In the demo's settings: STT = `deepgram`, STT token url = `<worker>/stt/token`. Mode =
`full loop — hosted claude haiku` uses `/llm` and needs no key or LLM url at all.

| route | returns |
|---|---|
| `GET /tts` | `{ voices: [{ id, name }] }` — listing needs the key too, so the browser can't ask ElevenLabs itself |

## The fastest config

Benchmarked at **984ms voice→voice vs 2126ms** for the zero-key path ([RESULTS](../../bench/results/RESULTS.md)) —
the whole gap is end-of-turn (366ms vs 1565ms). In the demo's settings:

- **STT** `deepgram` · **STT token url** `<worker>/stt/token`
- **TTS** `elevenlabs` · **TTS url** `<worker>/tts`
- **mode** `hosted claude haiku` — measured 568ms to first token, 893ms to first sound in-browser
