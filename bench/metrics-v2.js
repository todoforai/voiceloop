// Versioned audio-based quality scoring. Legacy metrics remain available in metrics.js.
import { computeMetrics, norm, wer, deriveNoiseStops } from './metrics.js';
export const SCORING_VERSION = '2.0';

export function stats(values) {
  const v = values.filter(Number.isFinite).sort((a,b) => a-b);
  return v.length ? { n: v.length, median: v[v.length >> 1], p95: v[Math.ceil(v.length*.95)-1] } : null;
}

// A pause is not yielding if speech resumes while the person still has the floor.
// Require 200ms of silence BEFORE the person's end; stopping on their last word isn't yielding.
export function sustainedStop(segs, start, end) {
  const overlap = segs.filter(s => s.start < end && s.end > start);
  if (!overlap.length) return { status: 'no_overlap', ms: null, reentries: 0 };
  const last = overlap.at(-1);
  return { status: last.end <= end - 200 ? 'yielded' : 'failed',
    ms: last.end <= end - 200 ? Math.round(last.end - start) : null,
    reentries: overlap.length - 1 };
}

// Each final belongs to ONE turn. No matching against the expected answer. Explicit turn IDs
// support adapters with delayed callbacks; otherwise join all finals in a disjoint time window.
export function attributeFinals(events, scenario) {
  const starts = scenario.turns.map((_,k) => events.find(e => e.type === 'person_start' && e.turn === k)?.t);
  const ends = scenario.turns.map((_,k) => events.find(e => e.type === 'person_end' && e.turn === k)?.t);
  const finals = scenario.turns.map(() => []); const unassigned = []; const ambiguous = new Set();
  for (const f of events.filter(e => e.type === 'stt_final' && e.text?.trim() && e.text !== '...')) {
    const candidates = starts.flatMap((start,i) => start != null && ends[i] != null && f.t >= start && f.t < ends[i]+5000 ? [i] : []);
    if (!Number.isInteger(f.turn) && candidates.length > 1) {
      candidates.forEach(i => ambiguous.add(i)); unassigned.push(f); continue;
    }
    const k = Number.isInteger(f.turn) ? f.turn : candidates[0] ?? -1;
    if (k >= 0 && k < finals.length && starts[k] != null && ends[k] != null) finals[k].push(f.text);
    else unassigned.push(f);
  }
  return { text: finals.map(f => f.join(' ')), unassigned, ambiguous };
}

// Ordered exact word coverage is an omission estimate, NOT proof of semantics or acoustic truth.
// Report response WER too: repeated/extra words must not receive perfect fidelity credit.
export function wordCoverage(reference, hypothesis) {
  const r=norm(reference), h=norm(hypothesis); let prev=new Array(h.length+1).fill(0);
  for (const word of r) {
    const cur=[0]; for(let j=1;j<=h.length;j++) cur[j]=word===h[j-1]?prev[j-1]+1:Math.max(prev[j],cur[j-1]);
    prev=cur;
  }
  return r.length ? prev[h.length]/r.length : (h.length ? 0 : 1);
}

export function computeMetricsV2(events, scenario) {
  events = [...events].sort((a,b)=>a.t-b.t);
  const segs=events.filter(e=>e.type==='clip_start').map(e=>({start:e.t,end:events.find(x=>x.type==='clip_end'&&x.t>=e.t)?.t??Infinity}));
  // Never feed SUT delivery/stop claims into audio quality scoring.
  const result=computeMetrics(events.filter(e=>!['reply_done','barge_stop','content_word'].includes(e.type)),scenario);
  result.scoringVersion=SCORING_VERSION;
  const stt=attributeFinals(events,scenario);
  const hasStt=events.some(e=>e.type==='stt_final'||e.type==='stt_partial');
  for (const t of result.turns) {
    if(t.missing) continue;
    const k=t.turn, start=events.find(e=>e.type==='person_start'&&e.turn===k).t;
    const end=events.find(e=>e.type==='person_end'&&e.turn===k).t;
    const next=events.find(e=>e.type==='person_start'&&e.turn===k+1)?.t??Infinity;
    t.sttFinal=stt.text[k]; t.sttStatus=!hasStt?'unknown':stt.ambiguous.has(k)?'ambiguous':t.sttFinal?'observed':'missing';
    t.wer=['unknown','ambiguous'].includes(t.sttStatus)?null:wer(scenario.turns[k].person,t.sttFinal);
    const audio=replySegments(segs,start,end,next,!!scenario.turns[k].interrupt);
    // Preserve onset definition for leaderboard continuity. Track continuous early replies too.
    t.noAudioReply=!audio.length;
    const transcript=events.find(e=>e.type==='audio_transcript'&&e.turn===k&&e.status==='ok');
    t.deliveryStatus=!audio.length?'silent':transcript?'transcribed':'unknown';
    t.spokenRatio=!audio.length?0:transcript?wordCoverage(scenario.turns[k].response,transcript.text):null;
    t.responseWer=transcript?wer(scenario.turns[k].response,transcript.text):!audio.length?1:null;
    // Do not relabel an omission as an echo-caused self-interruption. Causation is unobserved.
    delete t.selfInterrupted; t.incompleteReply=!scenario.turns[k+1]?.interrupt && t.spokenRatio!=null && t.spokenRatio<.8;
    if(scenario.turns[k].interrupt) {
      const stop=sustainedStop(segs,start,end);
      t.interruptStatus=stop.status; t.interruptStopMs=stop.ms; t.interruptReentries=stop.reentries;
    } else {
      const entries=segs.filter(s=>s.start>=start&&s.start<end);
      const pauses=events.filter(e=>e.type==='person_pause'&&e.turn===k);
      const resumes=events.filter(e=>e.type==='person_resume'&&e.turn===k);
      const attempts=entries.flatMap(s=>{
        const pause=pauses.find(p=>p.t<=s.start&&(resumes.find(r=>r.t>p.t)?.t??end)>s.start);
        const from=pause?resumes.find(r=>r.t>s.start)?.t:s.start;
        return from==null?[]:[sustainedStop(segs,from,end)];
      });
      t.talkedThrough=attempts.some(x=>x.status==='failed');
      t.yieldMs=attempts.filter(x=>x.status==='yielded').at(-1)?.ms??null;
    }
  }
  result.aggregate=aggregateV2(result.turns,scenario);
  // Whole-conversation WER needs no turn attribution and cannot hide ambiguous/dropped finals.
  // Fixed-order scripted speech vs EVERY observed user final, with insertions/deletions retained.
  const reference=scenario.turns.map(t=>t.person).join(' ');
  const hypothesis=events.filter(e=>e.type==='stt_final'&&e.text?.trim()).map(e=>e.text).join(' ');
  result.aggregate.sessionWer=hasStt?wer(reference,hypothesis):null;
  result.aggregate.sessionWerWords=hasStt?norm(reference).length:0;
  result.aggregate.sessionWerErrors=hasStt?Math.round(result.aggregate.sessionWer*norm(reference).length):0;
  result.aggregate.unassignedSttFinals=stt.unassigned.length;
  result.aggregate.echoWords=computeMetrics(events,scenario).aggregate.echoWords;
  result.aggregate.echoDrops=events.filter(e=>e.type==='echo_drop').length;
  const noise=deriveNoiseStops({segs:segs.map(s=>({startMs:s.start,endMs:s.end})),bursts:events.filter(e=>e.type==='noise_burst'),personEvents:events.filter(e=>e.type.startsWith('person_'))});
  result.aggregate.noiseStops=noise.filter(e=>e.resumedMs==null).length;
  result.aggregate.noiseStalls=noise.filter(e=>e.resumedMs!=null).length;
  result.aggregate.noiseBursts=events.filter(e=>e.type==='noise_burst').length; // lexical proxy, not causation
  return result;
}

export function aggregateV2(turns, scenario) {
  const valid=turns.filter(t=>!t.missing);
  const uninterrupted=valid.filter(t=>!scenario.turns[t.turn+1]?.interrupt);
  const mean=xs=>{const v=xs.filter(Number.isFinite);return v.length?v.reduce((a,b)=>a+b,0)/v.length:null;};
  return {
    expectedTurns:turns.length, missingPersonTurns:turns.length-valid.length,
    noAudioReplies:valid.filter(t=>t.noAudioReply).length,
    voiceToVoiceMs:stats(valid.map(t=>t.voiceToVoiceMs)),
    voiceToVoiceMissing:valid.filter(t=>t.voiceToVoiceMs==null).length,
    interruptStopMs:stats(valid.map(t=>t.interruptStopMs)),
    interruptFailures:valid.filter(t=>t.interruptStatus==='failed').length,
    interruptNoOverlap:valid.filter(t=>t.interruptStatus==='no_overlap').length,
    interruptReentries:valid.reduce((n,t)=>n+(t.interruptReentries??0),0),
    wer:mean(valid.map(t=>t.wer)), sttObserved:valid.filter(t=>t.sttStatus==='observed').length,
    sttScored:valid.filter(t=>t.wer!=null).length,
    sttUnknown:valid.filter(t=>t.sttStatus==='unknown').length,
    sttAmbiguous:valid.filter(t=>t.sttStatus==='ambiguous').length,
    sttMissing:valid.filter(t=>t.sttStatus==='missing').length,
    spokenRatioUninterrupted:mean(uninterrupted.map(t=>t.spokenRatio)),
    responseWer:mean(uninterrupted.map(t=>t.responseWer)),
    deliveryObserved:uninterrupted.filter(t=>t.spokenRatio!=null).length,
    deliveryExpected:uninterrupted.length,
    incompleteReplies:uninterrupted.filter(t=>t.incompleteReply).length,
    stalls:valid.reduce((n,t)=>n+t.stalls,0),
    userInterrupted:valid.reduce((n,t)=>n+(t.userInterruptions??0),0),
    talkedThrough:valid.filter(t=>t.talkedThrough).length,
    yieldMs:stats(valid.map(t=>t.yieldMs)),
  };
}

export function formatV2(m,label='') {
  const a=m.aggregate, timing=x=>x?`${x.median}ms (p95 ${x.p95}, n=${x.n})`:'unknown';
  const pct=x=>x==null?'unknown':`${(100*x).toFixed(1)}%`;
  return `# Scoring v${SCORING_VERSION}: ${label}\n\n| Metric | Value |\n|---|---|\n`+[
    ['Delivery evidence',a.deliveryObserved===a.deliveryExpected?'complete for eligible replies':'INCOMPLETE — not eligible for a quality-pass claim'],
    ['Delivery transcriber',m.transcription?JSON.stringify(m.transcription):'none / unknown'],
    ['Voice→voice',timing(a.voiceToVoiceMs)],['Sustained barge-in stop',timing(a.interruptStopMs)],
    ['Barge-in failures / no overlap',`${a.interruptFailures} / ${a.interruptNoOverlap}`],
    ['Missing person turns / no audio replies',`${a.missingPersonTurns} / ${a.noAudioReplies}`],
    ['Conversation STT WER (all finals, no attribution)',pct(a.sessionWer)],
    ['STT WER (non-oracle attribution)',`${pct(a.wer)} (${a.sttScored} scored)`],
    ['STT observed / missing / ambiguous / unknown',`${a.sttObserved} / ${a.sttMissing} / ${a.sttAmbiguous} / ${a.sttUnknown}`],
    ['Unassigned finals',a.unassignedSttFinals??0],
    ['Missing voice→voice timing',a.voiceToVoiceMissing],
    ['Reply word coverage, uninterrupted',`${pct(a.spokenRatioUninterrupted)} (${a.deliveryObserved}/${a.deliveryExpected} observed)`],
    ['Reply WER, uninterrupted',pct(a.responseWer)],['Incomplete replies (<80% words)',a.deliveryObserved?`${a.incompleteReplies} / ${a.deliveryObserved}`:'unknown'],
    ['Stalls',a.stalls],['Overlap / talked through',`${a.userInterrupted} / ${a.talkedThrough}`],
    ['Yield',timing(a.yieldMs)],
    ['Echo words / filtered finals (lexical proxies)',`${a.echoWords??0} / ${a.echoDrops??0}`],
    ['Noise stops / stalls / bursts (heuristic)',`${a.noiseStops??0} / ${a.noiseStalls??0} / ${a.noiseBursts??0}`],
  ].map(([k,v])=>`| ${k} | ${v} |`).join('\n')+'\n';
}

// Crossing old output is not a new reply. Early onset during a normal hesitation is retained,
// but an interrupting turn requires an onset after the person's turn ended (conservative).
export function replySegments(segs,start,end,next,interrupt) {
  return segs.filter(s=>s.start>= (interrupt?end:start) && s.start<next && s.end>end);
}
export function poolV2(reports,scenario) {
  const turns=reports.flatMap(r=>r.metrics.turns);
  const aggregate=aggregateV2(turns,scenario);
  for(const key of ['unassignedSttFinals','echoWords','echoDrops','noiseStops','noiseStalls','noiseBursts'])
    aggregate[key]=reports.reduce((n,r)=>n+(r.metrics.aggregate[key]??0),0);
  aggregate.sessionWerWords=reports.reduce((n,r)=>n+(r.metrics.aggregate.sessionWerWords??0),0);
  aggregate.sessionWerErrors=reports.reduce((n,r)=>n+(r.metrics.aggregate.sessionWerErrors??0),0);
  aggregate.sessionWer=aggregate.sessionWerWords?aggregate.sessionWerErrors/aggregate.sessionWerWords:null;
  const configurations=[...new Set(reports.map(r=>r.metrics.transcription).filter(Boolean).map(c=>JSON.stringify(c)))];
  if(configurations.length>1) throw new Error('Cannot pool delivery from different transcription configurations');
  return {scoringVersion:SCORING_VERSION,turns,aggregate,qualityEvidenceComplete:aggregate.deliveryObserved===aggregate.deliveryExpected,transcription:configurations.length?JSON.parse(configurations[0]):null};
}
