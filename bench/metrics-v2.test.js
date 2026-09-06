import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sustainedStop, attributeFinals, computeMetricsV2, wordCoverage, aggregateV2, replySegments, poolV2 } from './metrics-v2.js';
const person=(turn,start,end)=>[{t:start,type:'person_start',turn},{t:end,type:'person_end',turn}];
const clip=(start,end)=>[{t:start,type:'clip_start'},{t:end,type:'clip_end'}];

test('sustained stop ignores intermediate pauses and excludes legitimate next answer',()=>{
 const segs=[{start:0,end:500},{start:800,end:1200},{start:2100,end:3000}];
 assert.deepEqual(sustainedStop(segs,200,2000),{status:'yielded',ms:1000,reentries:1});
});
test('stop must leave 200ms silence before user finishes, otherwise failed not fast',()=>{
 assert.equal(sustainedStop([{start:0,end:1850}],100,2000).status,'failed');
 assert.equal(sustainedStop([{start:0,end:2200}],100,2000).status,'failed');
 assert.equal(sustainedStop([{start:0,end:1800}],100,2000).ms,1700);
 assert.equal(sustainedStop([{start:2100,end:2200}],100,2000).status,'no_overlap');
});
test('ambiguous delayed transcript cannot credit either repeated turn',()=>{
 const s={turns:[{person:'hello',response:'hi'},{person:'hello',response:'hi'}]};
 const e=[...person(0,0,100),...person(1,1000,1100),{t:1200,type:'stt_final',text:'hello'}];
 const m=computeMetricsV2(e,s);
 assert.deepEqual(m.turns.map(t=>t.wer),[null,null]);
 assert.equal(m.aggregate.sttAmbiguous,2);
 assert.equal(m.aggregate.unassignedSttFinals,1);
});
test('split finals join, echo insertions penalize WER, explicit IDs support delayed callbacks',()=>{
 const s={turns:[{},{}]};
 const e=[...person(0,0,100),...person(1,1000,1100),
 {t:80,type:'stt_final',text:'hello'},{t:200,type:'stt_final',text:'world'},
 {t:1200,type:'stt_final',turn:0,text:'late'},{t:9000,type:'stt_final',text:'unclaimed'}];
 assert.deepEqual(attributeFinals(e,s).text,['hello world late','']);
 assert.equal(attributeFinals(e,s).unassigned.length,1);
});
test('silent TTS cannot receive UI delivery credit; unknown transcription stays unknown',()=>{
 const s={turns:[{person:'hello',response:'hello world'}]};
 const e=[...person(0,0,100),{t:1000,type:'reply_done',heardNw:10,totalNw:10}];
 const silent=computeMetricsV2(e,s);
 assert.equal(silent.turns[0].spokenRatio,0);assert.equal(silent.aggregate.noAudioReplies,1);
 const unknown=computeMetricsV2([...e,...clip(200,500)],s);
 assert.equal(unknown.turns[0].spokenRatio,null);assert.equal(unknown.aggregate.deliveryObserved,0);
 const audio=computeMetricsV2([...e,...clip(200,500),{t:500,type:'audio_transcript',turn:0,status:'ok',text:'hello'}],s);
 assert.equal(audio.turns[0].spokenRatio,.5);assert.equal(audio.aggregate.incompleteReplies,1);
 assert.equal(audio.turns[0].selfInterrupted,undefined);
});
test('word coverage is ordered and repeated output still has WER penalty',()=>{
 assert.equal(wordCoverage('hello world','world hello'),.5);
 const s={turns:[{person:'hello',response:'hello world'}]};
 const m=computeMetricsV2([...person(0,0,100),...clip(200,500),{t:500,type:'audio_transcript',turn:0,status:'ok',text:'hello world hello world'}],s);
 assert.equal(m.turns[0].spokenRatio,1);assert.equal(m.turns[0].responseWer,1);
});
test('interrupted replies are excluded from delivery gate, pooling retains missing turns',()=>{
 const s={turns:[{person:'hello',response:'hi'},{person:'stop',response:'ok',interrupt:{}}]};
 const m=computeMetricsV2([...person(0,0,100)],s);
 assert.equal(m.aggregate.deliveryExpected,0);assert.equal(m.aggregate.missingPersonTurns,1);
 assert.equal(aggregateV2([...m.turns,...m.turns],s).missingPersonTurns,2);
});
test('hesitation with later failed yielding cannot pass because of an earlier stop',()=>{
 const s={turns:[{person:'hello more',response:'yes'}]};
 const e=[...person(0,0,3000),{t:500,type:'person_pause',turn:0},{t:1000,type:'person_resume',turn:0},...clip(700,1300),...clip(1500,3100)];
 const m=computeMetricsV2(e,s);assert.equal(m.aggregate.talkedThrough,1);
});

test('crossing old audio is not an answer to the interrupting turn',()=>{
 const segs=[{start:500,end:3000}];
 assert.deepEqual(replySegments(segs,1000,2000,4000,true),[]);
 const s={turns:[{person:'stop',response:'ok',interrupt:{}}]};
 const m=computeMetricsV2([...person(0,1000,2000),...clip(500,3000)],s);
 assert.equal(m.aggregate.noAudioReplies,1);assert.equal(m.aggregate.interruptFailures,1);
 assert.equal(m.aggregate.voiceToVoiceMissing,1);
});
test('pool retains unknown, ambiguity and safety diagnostics',()=>{
 const s={turns:[{person:'hello',response:'hi'}]};
 const m=computeMetricsV2([...person(0,0,100),{t:200,type:'noise_burst',durMs:200,kind:'cough'},...clip(150,400)],s);
 const p=poolV2([{metrics:m},{metrics:m}],s);
 assert.equal(p.aggregate.sttUnknown,2);assert.equal(p.aggregate.noiseBursts,2);
 assert.equal(p.aggregate.noiseStops,2);
});

test('pool refuses mixed transcription engines',()=>{
 const s={turns:[{person:'hello',response:'hi'}]};
 const m=computeMetricsV2([...person(0,0,100)],s);
 assert.throws(()=>poolV2([{metrics:{...m,transcription:{engine:'openai'}}},{metrics:{...m,transcription:{engine:'faster-whisper'}}}],s),/different transcription/);
});

test('conversation WER counts all finals even when turn attribution is ambiguous',()=>{
 const s={turns:[{person:'hello',response:'hi'},{person:'world',response:'ok'}]};
 const m=computeMetricsV2([...person(0,0,100),...person(1,1000,1100),{t:1200,type:'stt_final',text:'world'}],s);
 assert.equal(m.aggregate.sttAmbiguous,2);
 assert.equal(m.aggregate.sessionWer,.5);
 assert.equal(poolV2([{metrics:m},{metrics:m}],s).aggregate.sessionWer,.5);
});
