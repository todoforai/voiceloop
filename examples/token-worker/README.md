# voiceloop-token

The tiny backend the live demo needs. GitHub Pages is static, so it has no server to mint
credentials — and cloud STT/TTS keys must never reach the page. This Worker holds them and hands
out only what each hop needs.

| route | returns | why |
|---|---|---|
| `POST /stt/token` | `{ token, expires_in }` | short-TTL Deepgram key; the browser opens the WS itself |
| `POST /tts` | `audio/mpeg` | ElevenLabs proxy — the `xi-api-key` stays server-side |

(The voiceloop demo runs this exact Worker.)

## Deploy

```sh
wrangler deploy
wrangler secret put DEEPGRAM_API_KEY
wrangler secret put ELEVENLABS_API_KEY
```

`ALLOWED_ORIGINS` (in `wrangler.toml`) is a comma-separated allowlist. These routes spend real
money, so an open CORS policy is an open wallet — a request from an unlisted origin gets no CORS
headers and a 403. `/tts` also caps text at 600 chars so a leaked URL costs cents, not a plan.

## Use it from the demo

In the demo's settings: STT = `deepgram`, STT token url = `<worker>/stt/token`.
