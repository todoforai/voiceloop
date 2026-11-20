#!/usr/bin/env python3
"""Gate Soniox realtime words by owner-voice score (CAM++ 200k). Compares 3 gating strategies on the HU dialogue.
Needs .cache/hu-dialogue/soniox_tokens.json from soniox-stream.mjs. Run: python3 gate-eval.py"""
import json, numpy as np
exec(open('eval_scenarios.py').read().split("OWN = [")[0])  # fbank/emb/rd/SR from the scenario script
H = f'{D}/.cache/hu-dialogue'
meta = json.load(open(f'{H}/dialogue_meta.json')); toks = json.load(open(f'{H}/soniox_tokens.json'))
K, THR = 'CAM++ 200k', 0.52
x = rd('dialogue_full.wav'); vp = emb(K, rd('enroll_attila.wav')); sc = lambda a: float(vp @ emb(K, a))

# Words = merge sub-word tokens (Soniox tokens starting with a space start a new word)
words = []
for t in toks:
    if t['text'].startswith('<'): continue
    if not words or t['text'].startswith(' '): words.append(dict(text=t['text'].strip(), s=t['start_ms']/1000, e=t['end_ms']/1000, spk=t.get('speaker'), arr=t['arrival_ms']/1000))
    else: words[-1].update(text=words[-1]['text'] + t['text'], e=t['end_ms']/1000, arr=t['arrival_ms']/1000)
words = [w for w in words if w['text']]

def truth(w):  # ground truth by which turn the word's midpoint falls in; overlap turn = owner's words + Erik's words
    m = (w['s'] + w['e']) / 2
    for t in meta['turns']:
        if t['startSec'] - .3 <= m <= t['endSec'] + .3: return t['role']
    return 'other'

# Streaming window scores: 1.5 s window ending every 0.5 s (what the browser computes live)
win = {}
for end in np.arange(1.0, len(x)/SR + .01, .5):
    s0 = max(0, int((end - 1.5) * SR)); seg = x[s0:int(end*SR)]
    win[round(end, 1)] = sc(seg) if np.sqrt((seg**2).mean()) > .01 and len(seg) > SR*.8 else None
def win_score(m):  # mean of windows that contain time m
    v = [s for e, s in win.items() if s is not None and e - 1.5 <= m <= e]; return np.mean(v) if v else 0.0

# Strategy 1: whole utterance (Soniox endpoint segments → one score)
utts, cur = [], []
for t in toks:
    if t['text'] in ('<end>', '<fin>'):
        if cur: utts.append(cur); cur = []
    elif not t['text'].startswith('<'): cur.append(t)
if cur: utts.append(cur)
utt_of = {}
for ui, u in enumerate(utts):
    s, e = u[0]['start_ms']/1000, u[-1]['end_ms']/1000; us = sc(x[int(s*SR):int(e*SR)+1600])
    for w in words:
        if s - .05 <= w['s'] <= e + .05: utt_of[id(w)] = us
# Strategy 3: Soniox diarization speaker → score each speaker's pooled audio (up to now), gate by speaker
spk_score = {}
for spk in {w['spk'] for w in words}:
    a = np.concatenate([x[int(w['s']*SR):int(w['e']*SR)] for w in words if w['spk'] == spk]); spk_score[spk] = sc(a) if len(a) > SR*.5 else 0

strategies = {
  '1. egész megszólalás': lambda w: utt_of.get(id(w), 0) >= THR,
  '2. csúszó ablak / szó': lambda w: win_score((w['s']+w['e'])/2) >= THR,
  '3. Soniox beszélő + hangszín': lambda w: spk_score[w['spk']] >= THR,
  # 4: speaker label says owner AND local window isn't clearly someone else (catches diarization mislabels)
  '4. 3 + ablak-vétó (<0.30)': lambda w: spk_score[w['spk']] >= THR and win_score((w['s']+w['e'])/2) >= 0.30,
}
print(f"Soniox: {len(words)} szó, {len(utts)} megszólalás, beszélők: " + ', '.join(f'S{k}={v:.2f}' for k, v in sorted(spk_score.items())))
lat = [w['arr'] - w['e'] for w in words]; print(f"Soniox végleges szó késése a szó vége után: medián {np.median(lat)*1000:.0f} ms, p90 {np.percentile(lat,90)*1000:.0f} ms\n")
print('| Stratégia | tulaj szó átment | idegen szó kiszűrve | átfedéses forduló: átment |'); print('|---|---|---|---|')
for name, f in strategies.items():
    o = [f(w) for w in words if truth(w) == 'owner']; n = [not f(w) for w in words if truth(w) == 'other']
    ov = [w['text'] for w in words if truth(w) == 'overlap' and f(w)]
    print(f"| {name} | {sum(o)}/{len(o)} ({100*np.mean(o):.0f}%) | {sum(n)}/{len(n)} ({100*np.mean(n):.0f}%) | {' '.join(ov)} |")
print('\nAI-hoz jutó szöveg (2. stratégia):')
for t in meta['turns']:
    ws = [w for w in words if t['startSec']-.3 <= (w['s']+w['e'])/2 <= t['endSec']+.3]
    kept = [w['text'] for w in ws if strategies['2. csúszó ablak / szó'](w)]; drop = [w['text'] for w in ws if not strategies['2. csúszó ablak / szó'](w)]
    print(f"  [{t['speaker']:24s}] ✅ {' '.join(kept) or '—'}" + (f"   ⛔ {' '.join(drop)}" if drop else ''))
json.dump(dict(words=words, thr=THR, win=[dict(end=k, score=v) for k, v in win.items()]), open(f'{H}/gate_result.json', 'w'), ensure_ascii=False)
