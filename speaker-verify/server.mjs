#!/usr/bin/env node
// server.mjs — Zero-dependency local server for the Speaker Verification Comparison Lab.
// Sets COOP/COEP headers so onnxruntime-web unlocks SharedArrayBuffer (multi-threaded WASM SIMD).
// Serves cached ONNX models and 3-speaker benchmark WAVs from .cache/ (auto-downloads if missing).
//
// Run: node voiceloop/speaker-verify/server.mjs   (default http://localhost:7788)

import http from 'node:http';
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODELS, BENCH_WAVS } from './models.js';

const DIR = normalize(join(fileURLToPath(import.meta.url), '..'));
const CACHE_MODELS = join(DIR, '.cache', 'models');
const CACHE_WAVS = join(DIR, '.cache', 'wavs');
const PORT = +(process.env.PORT || 7788);

mkdirSync(CACHE_MODELS, { recursive: true });
mkdirSync(CACHE_WAVS, { recursive: true });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.onnx': 'application/octet-stream',
  '.wav': 'audio/wav',
  '.wasm': 'application/wasm',
};

const MODEL_URL_BY_FILE = Object.fromEntries(MODELS.filter((m) => m.file).map((m) => [m.file, m.url]));
const WAV_BASE = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/';
const WAV_SET = new Set(BENCH_WAVS.map((w) => w.file));

const inflight = new Map();
async function ensureCached(localPath, url) {
  if (existsSync(localPath)) return;
  if (inflight.has(localPath)) return inflight.get(localPath);
  const p = (async () => {
    console.log(`[cache] downloading ${url}`);
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Upstream ${resp.status} for ${url}`);
    const buf = Buffer.from(await resp.arrayBuffer());
    writeFileSync(localPath, buf);
    console.log(`[cache] saved ${localPath} (${(buf.length / 1e6).toFixed(1)} MB)`);
  })().finally(() => inflight.delete(localPath));
  inflight.set(localPath, p);
  return p;
}

function sendFile(req, res, filePath) {
  if (!existsSync(filePath)) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  const st = statSync(filePath);
  res.writeHead(200, {
    'Content-Type': MIME[extname(filePath)] || 'application/octet-stream',
    'Content-Length': st.size,
    'Cache-Control': filePath.includes('.cache') ? 'public, max-age=86400' : 'no-cache',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'same-origin',
  });
  createReadStream(filePath).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://localhost:${PORT}`);
    const pathname = u.pathname === '/' ? '/index.html' : u.pathname;

    if (pathname.startsWith('/models/')) {
      const file = pathname.slice('/models/'.length);
      const url = MODEL_URL_BY_FILE[file];
      if (!url) { res.writeHead(404); res.end('Unknown model'); return; }
      const localPath = join(CACHE_MODELS, file);
      await ensureCached(localPath, url);
      return sendFile(req, res, localPath);
    }

    if (pathname.startsWith('/hu-dialogue/')) {
      const file = pathname.slice('/hu-dialogue/'.length);
      if (file.includes('/') || file.includes('..')) { res.writeHead(403); res.end('Forbidden'); return; }
      return sendFile(req, res, join(DIR, '.cache', 'hu-dialogue', file));
    }

    if (pathname.startsWith('/wavs/')) {
      const file = pathname.slice('/wavs/'.length);
      if (!WAV_SET.has(file)) { res.writeHead(404); res.end('Unknown wav'); return; }
      const localPath = join(CACHE_WAVS, file);
      await ensureCached(localPath, WAV_BASE + file);
      return sendFile(req, res, localPath);
    }

    // Static files inside speaker-verify/ only
    const safePath = normalize(join(DIR, pathname));
    if (!safePath.startsWith(DIR)) { res.writeHead(403); res.end('Forbidden'); return; }
    return sendFile(req, res, safePath);
  } catch (err) {
    console.error('[server error]', err);
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end(String(err));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Speaker Verification Lab listening at http://localhost:${PORT}`);
});
