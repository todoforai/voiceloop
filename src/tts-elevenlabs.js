// ── ElevenLabs TTS (cloud, human-grade voices) ─────────────────────────────────────────────────
// A StreamingTTS provider: only `_synth(text, signal) → audio Blob` — sentence chunking, playback,
// barge-in, seek and speculative presynth all come from the base class, so switching Piper ↔
// ElevenLabs changes the VOICE, not the behavior. decodeAudioData handles the returned mp3.
//
// Auth, two modes (mirrors the STT providers' "key stays server-side" stance):
//   • ttsUrl  — YOUR backend proxy: POST { text, voice_id, model_id } → audio bytes. The proxy adds
//               the xi-api-key and forwards to ElevenLabs. Recommended for production.
//   • apiKey  — direct browser→ElevenLabs (dev/bench only: the key is visible in the page).
//
// Latency: eleven_flash_v2_5 is EL's low-latency model (~75ms model time); the rest of a clip's
// cost is network TTFB + transfer, which presynth (during the end-of-turn debounce) and the base
// class's ahead-of-playback synth queue hide for all but the first clip of a cold turn.
import { StreamingTTS } from './voice-agent.js';

const EL_API = 'https://api.elevenlabs.io/v1/text-to-speech';

export class ElevenLabsTTS extends StreamingTTS {
  constructor({ ttsUrl, apiKey, voiceId = 'JBFqnCBsd6RMkjVDRZzb' /* George */,
                modelId = 'eleven_flash_v2_5', format = 'mp3_44100_64' } = {}) {
    super(voiceId);
    if (!ttsUrl && !apiKey) throw new Error('ElevenLabsTTS needs ttsUrl (backend proxy) or apiKey (direct, dev only)');
    this.ttsUrl = ttsUrl; this.apiKey = apiKey; this.modelId = modelId; this.format = format;
  }

  // Listing voices needs the key, so on the proxy path it has to come from YOUR backend: a GET on
  // the same ttsUrl returns [{ id, name }] (see examples/token-worker). Direct mode asks ElevenLabs
  // with the key it already has. Either way a failure is non-fatal — an empty list just means the
  // host keeps whatever voiceId it was constructed with, and synthesis is unaffected.
  async voices() {
    const [url, headers] = this.ttsUrl
      ? [this.ttsUrl, {}]
      : ['https://api.elevenlabs.io/v2/voices?page_size=100', { 'xi-api-key': this.apiKey }];
    try {
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
      if (!r.ok) return [];
      const body = await r.json();
      return (body.voices ?? []).map((v) => ({ id: v.voice_id ?? v.id, name: v.name }));
    } catch { return []; }
  }

  // Pre-establish the connection (DNS + TLS + any proxy hop) so the first real clip only pays TTFB.
  // A HEAD to the API root is enough to open the socket; failures are non-fatal.
  async warm() {
    const url = this.ttsUrl ?? EL_API;
    try { await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(3000) }); } catch {}
  }

  async _synth(text, signal) {
    text = text?.trim();
    if (signal?.aborted || !text) return null;
    const direct = !this.ttsUrl;
    const url = direct ? `${EL_API}/${this.voiceId}?output_format=${this.format}` : this.ttsUrl;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(direct ? { 'xi-api-key': this.apiKey } : {}) },
      // The proxy form carries voice/model/format in the body so one backend route serves any voice.
      body: JSON.stringify(direct ? { text, model_id: this.modelId }
                                  : { text, voice_id: this.voiceId, model_id: this.modelId, output_format: this.format }),
      signal,
    });
    if (!res.ok) throw new Error(`ElevenLabs TTS ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
    const blob = await res.blob();
    return signal?.aborted ? null : blob;
  }
}
