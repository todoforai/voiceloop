# Adding your voice agent as a SUT

The bench is black-box: a scripted "person" plays pre-generated speech into a virtual mic and
records whatever your agent puts on the virtual speaker. **If your agent can use a mic and a
speaker, it can be benchmarked — the whole integration is two audio devices.**

Three working examples, in increasing integration depth — copy the one that matches your agent:

| example | kind | shows |
|---|---|---|
| [`blackbox/fake-agent.js`](blackbox/fake-agent.js) | process SUT | pure audio contract, zero browser |
| [`blackbox/elevenlabs.html`](blackbox/elevenlabs.html) | browser SUT, closed box | minimal page wrapper around a cloud agent SDK |
| [`blackbox/agent.html`](blackbox/agent.html) | browser SUT, instrumented | full milestone events for sub-metric splits |

## 1. The interface

Your agent **listens on `bench_mic` and speaks on `bench_spk`**. That's it. Create the pair with:

```sh
bench/blackbox/audio-setup.sh up
```

### Browser SUTs

Write a page (like `agent.html` / `elevenlabs.html`) that starts your agent, and launch Chrome
pointed at the virtual devices:

```sh
PULSE_SOURCE=bench_mic PULSE_SINK=bench_spk google-chrome --user-data-dir=/tmp/sut \
  --remote-debugging-port=9223 --use-fake-ui-for-media-stream \
  --autoplay-policy=no-user-gesture-required 'http://localhost:7777/bench/blackbox/your-sut.html'
```

The flags matter: `--use-fake-ui-for-media-stream` auto-grants the mic (no permission prompt
blocking headless runs), `--autoplay-policy=no-user-gesture-required` lets audio out without a
click, and `--remote-debugging-port=9223` is how `run-n.js` drives the page.

The page must have:

- **`<div id="state">`** whose text becomes **`listening`** when the agent is ready —
  `run-n.js` polls this element before starting each run (it also accepts `speaking`, for SDKs
  that report mode rather than agent state).

Optionally, record internal milestones on the **epoch clock** so the analyzer can split
voice→voice latency into STT / end-of-turn / TTS stages:

```js
window.__bench = [];
const rec = (type, extra = {}) => window.__bench.push({ epoch: Date.now(), type, ...extra });
```

Event types the analyzer understands (see `metrics.js` header): `stt_partial` / `stt_final`
(`{text}`), `turn_committed`, `llm_first_token`, `reply_done` (`{heardNw, totalNw}`), plus
`vad`, `echo_drop`, `diag`. Emit whatever subset your agent can observe — `elevenlabs.html`
only gets transcript callbacks and that's still useful. All audio-truth metrics work with
**zero** events; `run-n.js` pulls `window.__bench` after each run and merges it automatically.

### Process SUTs (Python, Node, anything native)

No page needed. Point your audio stack at the pulse devices via env:

```sh
PULSE_SOURCE=bench_mic PULSE_SINK=bench_spk python your_agent.py
```

(PyAudio/sounddevice: select the device named `pulse` — the env vars route it. Raw pacat works
too, see `fake-agent.js`.)

`run-n.js` reloads a browser page between runs; for a process SUT **restart the process between
runs instead** — run `driver.js` directly N times:

```sh
for i in 1 2 3 4 5; do
  PULSE_SOURCE=bench_mic PULSE_SINK=bench_spk your-agent &  pid=$!
  node bench/blackbox/driver.js smalltalk mylabel-r$i
  kill $pid
done
```

then pool the resulting `bb-*.json` reports (or adapt `run-n.js`'s pooling section — it's ~40
lines).

## 2. Fairness requirements

Results that don't follow these are not comparable and won't be merged as a RESULTS.md row.

- **Use the bench mock LLM.** `node bench/server.js <scenario>` serves an OpenAI-compatible
  `/v1/chat/completions` on port 7777 with **fixed scripted responses, 300ms TTFT, 300 chars/s**.
  Point your agent's LLM base URL at it (`base_url: 'http://localhost:7777/v1'` works with any
  OpenAI client). This is what makes the numbers measure the *voice pipeline*, not the language
  model. If your architecture genuinely cannot take an external LLM (speech-to-speech models
  like GPT-4o realtime audio), you may run with the built-in brain, but your RESULTS.md caveat
  must say so explicitly, e.g.: *"⟨SUT⟩ cannot use the bench mock LLM (speech-to-speech
  architecture); its voice→voice numbers include real model inference time and are not directly
  comparable to mock-LLM rows."*
- **AEC off.** The virtual devices have no acoustic coupling (headset-equivalent), so there is
  no echo to cancel — but Chrome's AEC, given the TTS as far-end reference and nothing to find,
  suppresses the person's speech during playback and eats whole barge-ins. Force
  `echoCancellation: false, noiseSuppression: false` (both example pages show the
  `getUserMedia` wrapper; both keep an `?aec=on` escape hatch for testing the
  speakers-with-echo scenario). This *helps* every SUT, it never hurts one.
- **Default product config.** Benchmark your agent as a user would get it — no
  scenario-specific tuning (VAD thresholds, turn-detection eagerness, prompt tricks keyed to
  the script). Upgrading to your own faster *published* option (as we did enabling flash TTS on
  ConvAI) is fine if disclosed.
- **Same scenario audio.** Use the committed clips in `bench/audio/<scenario>/`
  (byte-identical every run); don't regenerate them.
- **5 runs pooled, minimum.** Single runs lie — ±300ms network/WASM jitter has flipped
  conclusions in this rig. Report the pooled median + p95 from `run-n.js` (or equivalent
  pooling for process SUTs), never a single conversation.

## 3. Cloud agents

If your agent's brain runs in someone else's cloud (ConvAI-style), it still must call the mock
LLM. Expose it with a tunnel:

```sh
cloudflared tunnel --url http://localhost:7777    # gives https://….trycloudflare.com
```

and configure the cloud agent's custom-LLM URL to `https://…/v1`. **Disclose the tunnel toll**:
measured overhead from our rig is **~170–240ms TTFB** (cloud → Cloudflare → local mock vs.
localhost). Word your caveat like RESULTS.md's ConvAI entry — state the toll, credit it in the
comparison, and note whether the ranking survives the credit. The bench server logs each LLM
request epoch-clocked (`[llm] turn N request @ …`), so you can quantify your actual RTT from
the run logs.

## 4. Submitting results

Open a PR containing:

- [ ] **Your SUT page or script** in `blackbox/` (e.g. `blackbox/pipecat-agent.py`,
      `blackbox/vapi.html`) with a header comment saying how to launch it, following the
      examples. Keys stay server-side or in env — never in the file.
- [ ] **The pooled summary** — `results/pooled-<scenario>-<label>-….md` as produced by
      `run-n.js` (raw `bb-*.json` / `.agent.raw` artifacts are not tracked).
- [ ] **A RESULTS.md row** (voice→voice median, p95, barge-in stop, stalls) **plus a
      per-configuration note and any fairness caveats** — both directions: tolls you pay
      (tunnel) and advantages you have.
- [ ] **Environment disclosure** — CPU, OS, Chrome version, Node version, and network region
      relative to the cloud providers involved (latency to a US-hosted STT looks very
      different from EU).

## Full run, end to end

```sh
bench/blackbox/audio-setup.sh up
node bench/blackbox/gen-audio.js smalltalk           # once (ELEVENLABS_API_KEY, or espeak fallback)
node bench/server.js smalltalk &                     # mock LLM + SUT page host on :7777
# start your SUT on bench_mic/bench_spk (browser or process, see §1)
node bench/blackbox/run-n.js smalltalk your-label 5 9223   # → results/pooled-….md
```

One benchmark at a time per machine — the audio devices are shared
(`pgrep -f blackbox/driver.js` to check).
