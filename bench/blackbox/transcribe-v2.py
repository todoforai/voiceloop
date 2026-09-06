#!/usr/bin/env python3
"""Transcribe cached v2 reply windows locally; no script prompts or reference text provided."""
import argparse, hashlib, json, pathlib, os
from importlib.metadata import version
import numpy as np
from faster_whisper import WhisperModel
p=argparse.ArgumentParser();p.add_argument('runs',nargs='+');p.add_argument('--model',default='small.en');args=p.parse_args()
# Refuse CPU model loading while any relevant audio-rig collector is active.
locks={pathlib.Path(__file__).resolve().parents[1]/'results/.rig.lock'}
locks.update(pathlib.Path(raw).resolve().parent/'.rig.lock' for raw in args.runs)
for lock in locks:
    if not lock.exists():continue
    try:os.kill(int(lock.read_text()),0)
    except ProcessLookupError:continue
    raise RuntimeError(f'Live audio collector owns {lock}; transcribe after collection')
config=dict(engine='faster-whisper',model=args.model,device='cpu',compute_type='int8',cpu_threads=4,
            beam_size=5,language='en',condition_on_previous_text=False,word_timestamps=True,vad_filter=False,
            faster_whisper_version=version('faster-whisper'),ctranslate2_version=version('ctranslate2'),cache_schema=1)
model=WhisperModel(args.model,device='cpu',compute_type='int8',cpu_threads=4,num_workers=1)
for raw in args.runs:
    path=pathlib.Path(raw); report=path.with_suffix('.v2.report.json')
    if not report.exists():raise RuntimeError(f'Run analyze-v2.js first: {path}')
    run=json.loads(report.read_text()); data=path.with_suffix('.agent.raw').read_bytes()
    pcm=np.frombuffer(data,dtype='<i2').astype(np.float32)/32768
    events=run['offlineEvents']; offset=-(run.get('audioStartMs') or 0)
    cachepath=path.with_suffix('.transcripts-v2.json')
    cache=json.loads(cachepath.read_text()) if cachepath.exists() else {}
    modelname=f'faster-whisper/{args.model}/int8'
    digest=hashlib.sha256(data).hexdigest()
    if cache.get('audioHash')!=digest or cache.get('config')!=config:cache=dict(audioHash=digest,model=modelname,config=config,turns={})
    clips=[dict(start=e['t'],end=next(x['t'] for x in events if x['type']=='clip_end' and x['t']>=e['t'])) for e in events if e['type']=='clip_start']
    for t in run['metrics']['turns']:
        if t.get('missing'):continue
        k=t['turn'];start=next(e['t'] for e in events if e['type']=='person_start' and e['turn']==k);end=next(e['t'] for e in events if e['type']=='person_end' and e['turn']==k)
        nxt=next((e['t'] for e in events if e['type']=='person_start' and e['turn']==k+1),float('inf'))
        audio=[s for s in clips if s['start'] >= (end if 'interruptStatus' in t else start) and s['start']<nxt and s['end']>end]
        if not audio:continue
        lo=max(end,audio[0]['start']);hi=min(nxt,audio[-1]['end'])
        # JS number stringification is used for cache signature; keep numerical bounds as authority.
        sig=f'{lo:g}:{hi:g}'
        existing=cache['turns'].get(str(k))
        if existing and existing.get('from')==lo and existing.get('to')==hi:continue
        samples=pcm[max(0,int((lo-offset)*16)):int(np.ceil((hi-offset)*16))]
        segments,_=model.transcribe(samples,language='en',beam_size=5,condition_on_previous_text=False,word_timestamps=True,vad_filter=False)
        segments=list(segments);text=' '.join(s.text.strip() for s in segments)
        words=[dict(word=w.word,start=w.start,end=w.end) for s in segments for w in (s.words or [])]
        cache['turns'][str(k)]=dict(signature=sig,text=text,words=words,**{'from':lo,'to':hi})
        cachepath.write_text(json.dumps(cache,indent=2));print(path.name,k,text,flush=True)
