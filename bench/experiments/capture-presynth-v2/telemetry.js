// Benchmark-only: no runtime edits, no packet payloads or authentication data recorded.
export function installFluxTelemetry(rec) {
  const NativeWebSocket = globalThis.WebSocket;
  let socketSeq = 0;
  globalThis.WebSocket = class extends NativeWebSocket {
    constructor(url, protocols) {
      super(url, protocols);
      if (new URL(url).hostname !== 'api.deepgram.com') return;
      const socketId = ++socketSeq;
      let samplesSent = 0, packets = 0, lastSend = null, maxGapMs = 0;
      const snapshot = () => ({ socketId, samplesSent, packets, maxGapMs,
        lastSendMono: lastSend, mono: performance.now() });
      const send = this.send.bind(this);
      this.send = data => {
        const result = send(data);
        if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
          const now = performance.now();
          if (lastSend !== null) maxGapMs = Math.max(maxGapMs, now - lastSend);
          lastSend = now; samplesSent += data.byteLength / 2; packets++;
        }
        return result;
      };
      this.addEventListener('message', e => {
        if (typeof e.data !== 'string') return;
        let m; try { m = JSON.parse(e.data); } catch { return; }
        if (m.type !== 'TurnInfo') return;
        // Keep the provider's timing/confidence/turn identity as supplied, without interpreting units.
        const fields = {};
        for (const k of ['type','event','turn_index','transcript','words','end_of_turn_confidence',
          'audio_window_start','audio_window_end','sequence_id']) if (k in m) fields[k] = m[k];
        rec('flux_turn_info', { provider: fields, transport: snapshot() });
        maxGapMs = 0;
      });
      this.addEventListener('open', () => rec('flux_open', snapshot()));
      this.addEventListener('close', e => rec('flux_close', { ...snapshot(), code: e.code }));
    }
  };
}

export function traceAgent(agent, rec) {
  for (const method of ['_onSpeechStart','_onSpeechEnd','_onUserTurn','_takePrefetch']) {
    const original = agent[method];
    agent[method] = function (...args) {
      rec('agent_boundary', { method, mono: performance.now(), speaking: this._speaking,
        state: this.state, turnGen: this._turnGen, text: typeof args[0] === 'string' ? args[0] : undefined });
      return original.apply(this, args);
    };
  }
}
