// ── Browser dependency loader ───────────────────────────────────────────────────────────────────
// The VAD stack ships as UMD globals (window.ort, window.vad) and Piper imports a bare
// "onnxruntime-web" specifier resolved via an importmap. `loadVoiceDeps()` injects all of it once
// from jsDelivr — call it before constructing a VoiceAgent (or just call `prewarmVoice()` while
// your mic button sits idle, and the cold start only owes getUserMedia + the STT connect).
//
// If you bundle these deps yourself (Vite/webpack), skip this file entirely: expose the vad-web
// UMD bundle as `window.vad` and you're done.

import { warmVad } from './voice-agent.js';

const CDN = 'https://cdn.jsdelivr.net/npm/';
const DEPS = [
  { id: 'vl-ort', src: `${CDN}onnxruntime-web@1.22.0/dist/ort.js` },
  { id: 'vl-vad', src: `${CDN}@ricky0123/vad-web@0.0.29/dist/bundle.min.js` },
];

let depsPromise = null;
export function loadVoiceDeps() {
  return (depsPromise ??= new Promise((resolve, reject) => {
    if (!document.getElementById('vl-importmap')) {
      const im = document.createElement('script');
      im.type = 'importmap';
      im.id = 'vl-importmap';
      im.textContent = JSON.stringify({ imports: { 'onnxruntime-web': `${CDN}onnxruntime-web@1.22.0/+esm` } });
      document.head.prepend(im);
    }
    let pending = DEPS.length;
    for (const { id, src } of DEPS) {
      if (document.getElementById(id)) { if (--pending === 0) resolve(); continue; }
      const s = document.createElement('script');
      s.id = id;
      s.src = src;
      s.onload = () => { if (--pending === 0) resolve(); };
      // A failed CDN load must not poison the memo: drop the rejected promise (and the dead <script>
      // so the retry re-injects) so the next call can try again instead of failing forever.
      s.onerror = () => { depsPromise = null; s.remove(); reject(new Error(`Failed to load ${src}`)); };
      document.head.appendChild(s);
    }
  }));
}

// Pre-warm everything that gates 'listening' EXCEPT what needs the click gesture (mic + STT token):
// the CDN scripts AND the Silero v5 VAD ONNX session (WASM compile + model build — the biggest
// chunk of the cold-start path). Memoized and best-effort: safe to call on every mount; a failure
// just means the first start() pays the normal cold cost.
export function prewarmVoice() {
  return loadVoiceDeps().then(() => warmVad()).catch(() => {});
}
