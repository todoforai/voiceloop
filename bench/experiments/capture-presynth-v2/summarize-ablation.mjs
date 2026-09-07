import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = resolve(process.argv[2]);
const { poolV2, formatV2 } = await import(pathToFileURL(`${root}/bench/metrics-v2.js`));
const scenario = JSON.parse(readFileSync(`${root}/bench/scenarios/hesitation.json`));
const results = readdirSync(`${root}/bench/results`).filter(p => p.endsWith('.v2.report.json'));
const summary = { scenario:'hesitation', scoringVersion:'2.0', arms:{} };
for (const arm of ['baseline','capture','presynth','combined']) {
  const reports = results.filter(p => p.includes(`ablation-${arm}-`)).sort().map(p => JSON.parse(readFileSync(`${root}/bench/results/${p}`)));
  if (!reports.length) continue;
  const pooled = poolV2(reports, scenario);
  const boundaries = [];
  for (const report of reports) {
    const events = report.offlineEvents.sort((a,b) => a.t-b.t);
    for (let turn=0; turn<6; turn++) {
      const start = events.find(e=>e.type==='person_start'&&e.turn===turn)?.t;
      const end = events.find(e=>e.type==='person_end'&&e.turn===turn)?.t;
      const next = events.find(e=>e.type==='person_start'&&e.turn===turn+1)?.t ?? Infinity;
      const finals = events.filter(e=>e.type==='stt_final'&&e.t>=start&&e.t<next);
      if (finals.length <= 1 && !finals.some(e=>e.t<end)) continue;
      boundaries.push({label:report.label,turn,finals:finals.map(e=>({t:e.t-start,text:e.text})),
        personEnd:end-start,
        resumes:events.filter(e=>e.type==='person_resume'&&e.turn===turn).map(e=>e.t-start),
        providerEnds:events.filter(e=>e.type==='flux_turn_info'&&e.provider.event==='EndOfTurn'&&e.t>=start&&e.t<next)
          .map(e=>({t:e.t-start,...e.provider,transport:e.transport})),
        vad:events.filter(e=>e.type==='vad'&&e.t>=start&&e.t<end).map(e=>({t:e.t-start,on:e.on})) });
    }
  }
  const providerCounts = reports.map(r => r.offlineEvents.filter(e=>e.type==='flux_turn_info'&&e.provider.event==='EndOfTurn').length);
  summary.arms[arm] = {...pooled,runs:reports.length,boundaries,providerCounts,
    perRunMedians:reports.map(r=>r.metrics.aggregate.voiceToVoiceMs?.median),
    perRunIncomplete:reports.map(r=>r.metrics.aggregate.incompleteReplies)};
  writeFileSync(`${root}/pooled-${arm}.md`, formatV2(pooled,`hesitation / ${arm}, ${reports.length} runs`));
  const a=pooled.aggregate;
  console.log(arm,JSON.stringify({runs:reports.length,v2v:a.voiceToVoiceMs,wer:a.sessionWer,coverage:a.spokenRatioUninterrupted,
    incomplete:a.incompleteReplies,observed:a.deliveryObserved,stalls:a.stalls,overlap:a.userInterrupted,talkedThrough:a.talkedThrough,
    providerCounts,flaggedTurns:boundaries.map(b=>`${b.label}/t${b.turn}`)}));
}
writeFileSync(`${root}/comparison.json`,JSON.stringify(summary,null,2));
