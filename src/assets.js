// Remote-asset helpers shared by the on-device models (Piper TTS, speaker gate).

// Dynamic import by URL, hidden from bundlers: Hermes (React Native) rejects `import(expr)` at
// bytecode compile time, so the syntax can't appear in this file even on paths RN never takes.
// Hermes's runtime parser rejects it too, so the Function is built LAZILY — a top-level
// `new Function(...)` would throw at module load and take the whole import down with it.
export const importUrl = (u) => new Function('u', 'return import(u)')(u);

// OPFS blob cache (`dirName`, default 'piper') — same 'piper' directory and url-basename filenames as the lib's own cache, so
// models already downloaded through the lib are reused (and vice versa).
// `onProgress(loaded, total)` fires while the file is coming down the wire (total is 0 if the server
// sends no content-length). A Piper voice is ~60MB: on mobile data that is a minute of apparent
// nothing, so a host needs to be able to SAY so — see PiperTTS.setOnModelProgress. Cache hits report
// nothing (they're instant).
export async function opfsCachedFetch(url, onProgress, dirName = 'piper') {
  const name = url.split('/').at(-1);
  const dir = () => navigator.storage.getDirectory().then((r) => r.getDirectoryHandle(dirName, { create: true }));
  try { return await (await (await dir()).getFileHandle(name)).getFile(); } catch {}
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url}: ${res.status}`);
  let blob;
  if (onProgress && res.body) {
    const total = +(res.headers.get('content-length') || 0);
    const chunks = []; let loaded = 0;
    for await (const c of res.body) { chunks.push(c); loaded += c.byteLength; onProgress(loaded, total); }
    blob = new Blob(chunks);
  } else blob = await res.blob();
  try { const w = await (await (await dir()).getFileHandle(name, { create: true })).createWritable(); await w.write(blob); await w.close(); } catch {}
  return blob;
}

// onnxruntime-web, the SAME module instance Piper gets through the importmap (identical URL → one
// module record, one WASM runtime). Inference runs in ORT's proxy worker so it never blocks the
// audio/UI thread. env is global and read at the first session build — both callers set the same.
const ORT_CDN = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/';
let ortP = null;
export function loadOrt() {
  return (ortP ??= importUrl(`${ORT_CDN}+esm`).then((m) => {
    const ort = m.default ?? m;
    ort.env.wasm.wasmPaths ??= `${ORT_CDN}dist/`;
    ort.env.wasm.numThreads ||= navigator.hardwareConcurrency || 4;   // >1 needs crossOriginIsolated; ort falls back to 1 otherwise
    ort.env.wasm.proxy = true;
    return ort;
  }).catch((e) => { ortP = null; throw e; }));
}
