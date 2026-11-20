#!/usr/bin/env python3
"""Overlap + distant/quiet-voice stress test for speaker verification models (offline, CPU onnxruntime).

Uses the Hungarian ElevenLabs v4 clips from gen-hu-dialogue.sh. Fbank mirrors fbank.js (verified identical).
Run: python3 eval_scenarios.py   → prints tables, writes .cache/scenarios/*.wav samples for listening.
"""
import os, wave, numpy as np, onnxruntime as ort

D = os.path.dirname(os.path.abspath(__file__))
HU, MD, OUT = f'{D}/.cache/hu-dialogue', f'{D}/.cache/models', f'{D}/.cache/scenarios'
os.makedirs(OUT, exist_ok=True)
SR = 16000

MODELS = {  # name: file, input, output, fbank scale, window, threshold (models.js defaults)
  'CAM++ 200k':      ('campplus_200k.onnx', 'feats', 'embs', 1.0, 'povey', 0.52),
  'WeSpeaker CAM++': ('wespeaker_campplus_en.onnx', 'feats', 'embs', 32768.0, 'hamming', 0.50),
  'ResNet34':        ('wespeaker_resnet34_fp32.onnx', 'input_features', 'last_hidden_state', 32768.0, 'hamming', 0.48),
}

def rd(f):
    w = wave.open(f'{HU}/{f}'); x = np.frombuffer(w.readframes(w.getnframes()), np.int16).astype(np.float32) / 32768
    return x
def wr(name, x):
    w = wave.open(f'{OUT}/{name}.wav', 'wb'); w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
    w.writeframes((np.clip(x, -1, 1) * 32767).astype(np.int16).tobytes()); w.close()

def hz2m(h): return 1127 * np.log(1 + h / 700)
m = np.linspace(hz2m(20), hz2m(7600), 82); bm = hz2m(np.arange(257) * SR / 512)
FB = np.stack([np.maximum(0, np.minimum((bm - m[i]) / (m[i+1] - m[i]), (m[i+2] - bm) / (m[i+2] - m[i+1]))) for i in range(80)])
def fbank(x, scale, win):
    x = x * scale; n = 1 + (len(x) - 400) // 160
    fr = x[np.arange(400)[None] + 160 * np.arange(n)[:, None]].copy()
    fr -= fr.mean(1, keepdims=True); fr[:, 1:] -= .97 * fr[:, :-1]; fr[:, 0] *= .03
    t = np.arange(400); c = np.cos(2 * np.pi * t / 399)
    fr *= (0.5 - 0.5 * c) ** 0.85 if win == 'povey' else 0.54 - 0.46 * c
    s = np.fft.rfft(fr, 512); f = np.log(np.maximum((s.real**2 + s.imag**2) @ FB.T, 1e-10))
    return (f - f.mean(0)).astype(np.float32)

SESS = {k: ort.InferenceSession(f'{MD}/{v[0]}', providers=['CPUExecutionProvider']) for k, v in MODELS.items()}
def emb(model, x):
    f, i, o, sc, win, _ = MODELS[model]
    e = SESS[model].run([o], {i: fbank(x, sc, win)[None]})[0][0]; return e / np.linalg.norm(e)

def rir(rt60, drr_db, seed=0):  # synthetic room impulse response: direct path + exponential diffuse tail
    r = np.random.default_rng(seed); n = int(rt60 * SR)
    tail = r.standard_normal(n) * np.exp(-6.9 * np.arange(n) / n); tail[:int(.003 * SR)] = 0
    tail *= 10 ** (-drr_db / 20) / np.sqrt((tail**2).sum()); h = tail; h[0] = 1; return h
def distant(x, atten_db, rt60=.5, drr=-3):  # far talker: reverberant + quieter + duller (air/occlusion lowpass)
    y = np.convolve(x, rir(rt60, drr))[:len(x)]
    y = np.convolve(y, np.ones(3) / 3, 'same')
    return y / (np.sqrt((y**2).mean()) + 1e-9) * np.sqrt((x**2).mean()) * 10 ** (atten_db / 20)
def mix(a, b, rel_db, offset=0.0):  # b added at rel_db relative to a's RMS, starting at offset fraction
    b = b / (np.sqrt((b**2).mean()) + 1e-9) * np.sqrt((a**2).mean()) * 10 ** (rel_db / 20)
    o = int(offset * len(a)); y = a.copy(); seg = b[:len(a) - o]; y[o:o + len(seg)] += seg; return y
def dbfs(x): return 20 * np.log10(np.sqrt((x**2).mean()) + 1e-9)

OWN = ['t01_attila.wav', 't06_attila.wav', 't08_attila.wav', 't09a_attila.wav']
OTH = ['t02_erik.wav', 't07_erik.wav', 't09b_erik.wav', 't05_sarah.wav']
own, oth = [rd(f) for f in OWN], [rd(f) for f in OTH]
VP = {k: emb(k, rd('enroll_attila.wav')) for k in MODELS}

def score(model, x): return float(VP[model] @ emb(model, x))
def row(label, clips, expect):
    cells = []
    for k in MODELS:
        s = np.array([score(k, c) for c in clips]); thr = MODELS[k][5]
        ok = ((s >= thr) == expect).mean()
        cells.append(f'{s.mean():.2f} [{s.min():.2f}–{s.max():.2f}] {ok*100:3.0f}%')
    lvl = np.mean([dbfs(c) for c in clips])
    print(f'| {label:42s} | {"ENGED" if expect else "DOB  "} | {lvl:6.1f} | ' + ' | '.join(cells) + ' |')

hdr = '| Scenario | Elvárt | dBFS | ' + ' | '.join(MODELS) + ' |'
pairs = [(own[i], oth[j]) for i in range(4) for j in range(4)]  # 16 owner×intruder combos

print('\n## A) Egymásba beszélés — tulajdonos a fő hang, idegen ráhallatszik (rel. dB)\n'); print(hdr)
row('tiszta tulajdonos (referencia)', own, True)
for rel in [0, -6, -12, -18, -24]:
    row(f'tulaj + idegen végig {rel:+d} dB', [mix(a, b, rel) for a, b in pairs], True)
for rel in [0, -6]:
    row(f'tulaj + idegen közbevág félúton {rel:+d} dB', [mix(a, b, rel, .5) for a, b in pairs], True)
print('\n## A2) Fordítva — idegen a fő hang, tulajdonos a háttérben\n'); print(hdr)
row('tiszta idegen (referencia)', oth, False)
for rel in [0, -6, -12, -18]:
    row(f'idegen + tulaj háttér {rel:+d} dB', [mix(b, a, rel) for a, b in pairs], False)

print('\n## B) Távoli / halk hang (zengő szoba, RT60 0.5s)\n'); print(hdr)
for att in [-6, -12, -20]:
    row(f'távoli idegen egyedül {att:+d} dB', [distant(b, att) for b in oth], False)
for att in [-6, -12]:
    row(f'távoli tulajdonos egyedül {att:+d} dB', [distant(a, att) for a in own], True)
for att in [-12, -20]:
    row(f'tulaj közel + távoli idegen háttér {att:+d} dB', [mix(a, distant(b, 0), att) for a, b in pairs], True)

# Mitigation probe: sub-window scoring inside an utterance flags the intruder-only part of a "közbevág" clip
print('\n## C) Ötlet: 1 mp-es alablakok egy megszólaláson belül (közbevágás 0 dB, CAM++ 200k)\n')
k = 'CAM++ 200k'; thr = MODELS[k][5]
a, b = own[1], oth[1]
seq = np.concatenate([a, b * np.sqrt((a**2).mean() / (b**2).mean())])  # owner then intruder takes over, same utterance
sc = [score(k, seq[s:s + SR]) for s in range(0, len(seq) - SR, SR // 2)]
print('ablak-pontszámok:', ' '.join(f'{x:.2f}' for x in sc))
print(f'teljes megszólalás pontszáma: {score(k, seq):.2f} (küszöb {thr}) → alablakok alapján {sum(x < thr for x in sc)}/{len(sc)} ablak idegen')

wr('A_overlap_0dB', mix(own[0], oth[0], 0)); wr('A_overlap_-12dB', mix(own[0], oth[0], -12))
wr('A_interrupt_0dB', mix(own[0], oth[0], 0, .5)); wr('B_distant_other_-12dB', distant(oth[0], -12))
wr('B_owner_plus_distant_other_-12dB', mix(own[0], distant(oth[0], 0), -12)); wr('C_owner_then_other', seq)
print(f'\nHallgatható minták: {OUT}/')
