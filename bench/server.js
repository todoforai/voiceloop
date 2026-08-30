#!/usr/bin/env node
// bench/server.js — the whole bench backend in one file, zero dependencies:
//   • serves the repo statically (so /bench/run.html can import ../src/index.js)
//   • POST /v1/chat/completions — the FIXED mock LLM: same scenario responses for every system
//     under test, simulated TTFT + a constant character rate, real OpenAI SSE wire format.
//     Turn selection is by the number of user messages in the request (not a counter), so
//     aborted speculative prefetches don't desync the script.
//   • POST /bench/save — the harness posts its recorded timeline; we compute + print the report
//     and write timeline+metrics to bench/results/.
//
// Run:  node bench/server.js [scenario]      (default: smalltalk)
// Then: open http://localhost:7777/bench/run.html and press Run.

import http from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeMetrics, formatReport } from './metrics.js';

const ROOT = normalize(join(fileURLToPath(import.meta.url), '..', '..'));
const PORT = +(process.env.PORT || 7777);
const scenarioName = process.argv[2] || 'smalltalk';
const scenario = JSON.parse(readFileSync(join(ROOT, 'bench', 'scenarios', `${scenarioName}.json`), 'utf8'));

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json',
               '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.css': 'text/css', '.wasm': 'application/wasm' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function mockLLM(req, res, body) {
  const { messages = [] } = JSON.parse(body);
  const turn = messages.filter((m) => m.role === 'user').length - 1;
  console.log(`[llm] turn ${turn} request @ ${Date.now()}`);   // epoch-clocked: lets us quantify SUT→mock-LLM network RTT (tunneled SUTs pay extra)
  const text = scenario.turns[turn]?.response ?? "I have nothing scripted for this turn.";
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' });
  const send = (delta) => res.write(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: null }] })}\n\n`);
  await sleep(scenario.ttftMs ?? 300);                       // simulated model TTFT
  const chunk = 12;                                          // chars per SSE delta
  const interval = (chunk / (scenario.charsPerSec ?? 300)) * 1000;
  for (let i = 0; i < text.length && !res.destroyed; i += chunk) {
    send({ content: text.slice(i, i + chunk) });
    await sleep(interval);
  }
  if (!res.destroyed) { res.write('data: [DONE]\n\n'); res.end(); }
}

function saveRun(body) {
  const { events, label = 'voiceloop' } = JSON.parse(body);
  const metrics = computeMetrics(events, scenario);
  const report = formatReport(metrics, `${label} / ${scenario.name}`);
  const dir = join(ROOT, 'bench', 'results');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const file = join(dir, `${scenario.name}-${label}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, JSON.stringify({ scenario: scenario.name, label, events, metrics }, null, 2));
  console.log('\n' + report + '\n\nsaved → ' + file);
  return report;
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' }); return res.end(); }
  if (req.method === 'POST') {
    let body = ''; for await (const c of req) body += c;
    try {
      if (url.pathname === '/v1/chat/completions') return await mockLLM(req, res, body);
      if (url.pathname === '/bench/el-signed-url') {   // ElevenLabs ConvAI signed URL (key stays server-side)
        const agentId = new URLSearchParams(body).get('agent_id') || JSON.parse(body || '{}').agent_id;
        const r = await fetch(`https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${agentId}`, { headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY } });
        const b = await r.json();
        res.writeHead(r.ok ? 200 : 500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        return res.end(JSON.stringify(b));
      }
      if (url.pathname === '/bench/stt-token') {   // browser can't call Deepgram's grant endpoint (CORS) — mint here
        const r = await fetch('https://api.deepgram.com/v1/auth/grant', { method: 'POST', headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY}` } });
        const b = await r.json();
        res.writeHead(r.ok ? 200 : 500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        return res.end(JSON.stringify({ token: b.access_token, expires_in: b.expires_in ?? 30, error: b.err_msg }));
      }
      if (url.pathname === '/bench/sm-stt-token') {   // Speechmatics realtime JWT (ttl 60s)
        const r = await fetch('https://mp.speechmatics.com/v1/api_keys?type=rt', {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.SPEECHMATICS_ACCESS_KEY}` },
          body: JSON.stringify({ ttl: 60 }),
        });
        const b = await r.json();
        res.writeHead(r.ok ? 200 : 500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        return res.end(JSON.stringify({ token: b.key_value, error: b.detail }));
      }
      if (url.pathname === '/bench/el-stt-token') {   // ElevenLabs Scribe realtime single-use token
        const r = await fetch('https://api.elevenlabs.io/v1/single-use-token/realtime_scribe', { method: 'POST', headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY } });
        const b = await r.json();
        res.writeHead(r.ok ? 200 : 500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        return res.end(JSON.stringify({ token: b.token, error: b.detail?.message }));
      }
      if (url.pathname === '/bench/el-tts') {   // ElevenLabsTTS proxy form: key stays here
        const { text, voice_id, model_id, output_format } = JSON.parse(body);
        const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice_id}?output_format=${output_format || 'mp3_44100_64'}`, {
          method: 'POST', headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, model_id }),
        });
        res.writeHead(r.status, { 'Content-Type': r.headers.get('content-type') ?? 'audio/mpeg', 'Access-Control-Allow-Origin': '*' });
        return res.end(Buffer.from(await r.arrayBuffer()));
      }
      if (url.pathname === '/bench/save') { const report = saveRun(body); res.writeHead(200, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' }); return res.end(report); }
    } catch (e) { res.writeHead(500); return res.end(String(e.message)); }
    res.writeHead(404); return res.end();
  }
  if (url.pathname === '/bench/scenario.json') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(scenario)); }
  // static: repo files (import ../src/*.js from the harness page)
  const path = normalize(join(ROOT, decodeURIComponent(url.pathname === '/' ? '/bench/run.html' : url.pathname)));
  if (!path.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  try {
    const data = readFileSync(path);
    // COOP/COEP → crossOriginIsolated → SharedArrayBuffer → MULTI-THREADED onnxruntime WASM.
    // Without these, Piper inference runs on ONE thread regardless of cores. no-store: bench
    // iterates on src/ constantly — never serve stale modules.
    res.writeHead(200, { 'Content-Type': MIME[extname(path)] ?? 'application/octet-stream', 'Cache-Control': 'no-store',
                         'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'credentialless' });
    res.end(data);
  } catch { res.writeHead(404); res.end('not found'); }
}).listen(PORT, () => console.log(`bench server: http://localhost:${PORT}/bench/run.html  (scenario: ${scenario.name}, ${scenario.turns.length} turns)`));
