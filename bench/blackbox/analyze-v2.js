#!/usr/bin/env node
// Audio-based v2 rescoring; writes new artifacts, never overwrites legacy reports.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { segments, RATE } from './energy.js';
import { computeMetricsV2, formatV2, replySegments } from '../metrics-v2.js';
const bench=join(dirname(fileURLToPath(import.meta.url)),'..');
const path=process.argv[2];
if(!path) throw new Error('usage: node bench/blackbox/analyze-v2.js <raw-run.json>');
const run=JSON.parse(readFileSync(path));
const scenario=JSON.parse(readFileSync(join(bench,'scenarios',`${run.scenario}.json`)));
const pcm=readFileSync(path.replace(/\.json$/,'.agent.raw'));
const offset=-(run.audioStartMs??0);
const segs=segments(pcm).map(s=>({start:s.startMs+offset,end:s.endMs+offset}));
const person=run.events.filter(e=>e.type.startsWith('person_'));
const anchor=run.events.find(e=>e.epoch!=null);
if(run.browserEvents?.length&&!anchor) throw new Error('Missing epoch anchor');
const inside=(run.browserEvents??[]).map(({epoch,type,...extra})=>({t:Math.round(epoch-anchor.epoch+anchor.t),type,...extra}));
const events=[...person,...run.events.filter(e=>e.type==='noise_burst'),...inside.filter(e=>!['clip_start','clip_end','barge_stop','audio_transcript'].includes(e.type)),
 ...segs.flatMap(s=>[{t:s.start,type:'clip_start'},{t:s.end,type:'clip_end'}])];
const cachePath=path.replace(/\.json$/,'.transcripts-v2.json');
const audioHash=createHash('sha256').update(pcm).digest('hex');
let cache=existsSync(cachePath)?JSON.parse(readFileSync(cachePath)):{};
if(cache.audioHash!==audioHash || !cache.turns || !cache.model) cache={audioHash,model:'openai/whisper-1',turns:{}};
// Never fill a partial local cache using a different engine just because a key is present.
const useOpenAI = !!process.env.OPENAI_API_KEY && cache.model === 'openai/whisper-1';

function wav(bytes) {
 const h=Buffer.alloc(44);h.write('RIFF');h.writeUInt32LE(bytes.length+36,4);h.write('WAVEfmt ',8);
 h.writeUInt32LE(16,16);h.writeUInt16LE(1,20);h.writeUInt16LE(1,22);h.writeUInt32LE(RATE,24);
 h.writeUInt32LE(RATE*2,28);h.writeUInt16LE(2,32);h.writeUInt16LE(16,34);h.write('data',36);h.writeUInt32LE(bytes.length,40);
 return Buffer.concat([h,bytes]);
}
for(let k=0;k<scenario.turns.length;k++) {
 const end=person.find(e=>e.type==='person_end'&&e.turn===k)?.t;
 const next=person.find(e=>e.type==='person_start'&&e.turn===k+1)?.t??Infinity;
 if(end==null) continue;
 const start=person.find(e=>e.type==='person_start'&&e.turn===k)?.t;
 const audio=replySegments(segs,start,end,next,!!scenario.turns[k].interrupt);
 if(!audio.length) continue;
 // Clamp both ends: never give this reply credit for the previous turn or next response.
 const from=Math.max(end,audio[0].start), to=Math.min(next,audio.at(-1).end);
 const signature=`${from}:${to}`;
 let transcript=cache.turns[k];
 if(transcript?.from!==from || transcript?.to!==to) transcript=null;
 if(!transcript&&useOpenAI) {
  try {
   const bytes=pcm.subarray(Math.max(0,Math.floor((from-offset)*RATE/1000)*2),Math.ceil((to-offset)*RATE/1000)*2);
   const form=new FormData();form.append('file',new Blob([wav(bytes)],{type:'audio/wav'}),'reply.wav');
   form.append('model','whisper-1');form.append('response_format','verbose_json');form.append('timestamp_granularities[]','word');
   const res=await fetch('https://api.openai.com/v1/audio/transcriptions',{method:'POST',headers:{Authorization:`Bearer ${process.env.OPENAI_API_KEY}`},body:form,signal:AbortSignal.timeout(60000)});
   if(!res.ok) throw new Error(`transcription HTTP ${res.status}`);
   const data=await res.json(); if(typeof data.text!=='string') throw new Error('missing transcript text');
   transcript={signature,text:data.text,words:data.words??[],from,to}; cache.turns[k]=transcript;
   writeFileSync(cachePath,JSON.stringify(cache,null,2));
  } catch(e) { console.error(`turn ${k}: ${e.message}; delivery remains unknown`); }
 }
 if(transcript) events.push({t:to,type:'audio_transcript',turn:k,status:'ok',text:transcript.text,method:cache.model});
}
const metrics=computeMetricsV2(events,scenario);
metrics.transcription = events.some(e=>e.type==='audio_transcript') ? (cache.config ?? {engine:'openai',model:'whisper-1',response_format:'verbose_json',word_timestamps:true}) : null;
const out=path.replace(/\.json$/,'.v2.report.json');
writeFileSync(out,JSON.stringify({...run,scoringVersion:metrics.scoringVersion,audioHash,offlineEvents:events,metrics},null,2));
const md=formatV2(metrics,`${run.label} / ${run.scenario}`);
writeFileSync(path.replace(/\.json$/,'.v2.md'),md);
console.log(md+`\nsaved → ${out}`);
