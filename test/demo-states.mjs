// Demo-page STATE probes — the invariants `npm test` cannot see, because they live in
// index.html's module state (aiEl/aiTurn/turnEls/toolEls/interimEl) and its seams with the
// agent lifecycle: rebuilds reuse turn/tool ids, destroy() doesn't stop detached tool results,
// stragglers arrive after their turn ended. Drives the real page in a real browser.
//
// Run:  npx playwright install chromium   (once)
//       python3 -m http.server 8899       (repo root)
//       node test/demo-states.mjs
//
// State-machine probe: drive the REAL page (echo mode, TTS muted) through lifecycle seams and
// check invariants. Synthetic assistant events are injected via agent().onEvent — the exact
// entry point the library uses — so the page's routing logic is exercised, not a copy of it.
import { chromium } from 'playwright';
const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const p = await b.newPage();
p.on('pageerror', e => console.log('PAGEERROR', e.message));
await p.goto('http://localhost:8899/index.html');
await p.evaluate(() => document.querySelector('details').open = true);
await p.waitForTimeout(1000);
await p.selectOption('#mode', 'echo');
await p.click('#muteTts');

const rows = () => p.$$eval('#chat > *', ns => ns.map(n => n.className.replace('msg ', '') + '|' + n.textContent.trim().slice(0, 40)));
const say = async (t) => { await p.fill('#typed', t); await p.click('#send'); await p.waitForTimeout(1400); };
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { console.log((ok ? 'PASS' : 'FAIL') + ' ' + name + (ok ? '' : '  → ' + detail)); ok ? pass++ : fail++; };

// ── T1 baseline: one turn, one user + one ai bubble ─────────────────────────
await say('alpha beta');
let r = await rows();
check('T1 turn renders user+ai', r.length === 2 && r[1].startsWith('ai echoed|alpha beta'), JSON.stringify(r));

// ── T2 rebuild + notify: agent2's turn 1 must NOT collide with agent1's turn 1 ──
// A settings change destroys the agent; the next notify() builds agent2 whose _replySeq restarts
// at 1 — the same id agent1's reply carried. If aiTurn survived the rebuild, the new reply is
// judged "same turn" and OVERWRITES agent1's answer.
await p.evaluate(() => { document.getElementById('model').dispatchEvent(new Event('change')); });
await p.waitForTimeout(300);
await p.evaluate(() => { window.__a2 = null; });
await p.evaluate(() => document.getElementById('send').click());  // no text: no-op, agent still null
await p.evaluate(async () => {
  // build agent2 the way the page does, then notify (a reply with NO user turn)
  document.getElementById('typed').value = 'x'; document.getElementById('send').click();
});
await p.waitForTimeout(1400);
await p.evaluate(() => window.agent().notify('background ping'));
await p.waitForTimeout(1400);
r = await rows();
const alphaIntact = r.some(x => x.startsWith('ai echoed|alpha beta'));
const xIntact = r.some(x => x.startsWith('ai echoed|x'));
const pingOwn = r.some(x => x.includes('background ping'));
check('T2 old replies survive an agent rebuild', alphaIntact && xIntact, JSON.stringify(r));
check('T2 notify() after rebuild gets its own bubble', pingOwn && alphaIntact && xIntact, JSON.stringify(r));

// ── T3 stale turnEls across rebuild: a straggler-shaped event from agent2 must not land in
// agent1's bubble. Simulate agent1 leaving an unsettled entry (draft, never finalized), rebuild,
// then agent2 emits turn with the SAME id. ───────────────────────────────────
await p.click('#clear');
await say('first agent reply');                       // agent2 turn 2... ids opaque — use synthetic:
await p.evaluate(() => {
  const a = window.agent();
  a.onEvent({ type: 'assistant', text: 'orphan draft', final: false, turn: 99 });   // never settles
});
await p.waitForTimeout(200);
await p.evaluate(() => { document.getElementById('model').dispatchEvent(new Event('change')); });  // destroy
await p.waitForTimeout(200);
await say('second agent');                            // builds agent3
await p.evaluate(() => {
  window.agent().onEvent({ type: 'assistant', text: 'NEW reply turn 99', final: true, turn: 99 });  // agent3 reusing id 99
});
await p.waitForTimeout(300);
r = await rows();
const orphanOverwritten = r.some(x => x.includes('NEW reply turn 99') && !x.includes('orphan'));
const orphanBubble = r.find(x => x.includes('orphan draft'));
check('T3 a reused turn id does not resurrect the old agent\'s bubble',
  !r.some(x => x.includes('orphan draft') && x.includes('NEW')) &&
  r.filter(x => x.includes('NEW reply turn 99')).length === 1 &&
  r.indexOf(r.find(x => x.includes('NEW reply turn 99'))) > r.indexOf(r.find(x => x.includes('second agent'))),
  JSON.stringify(r));

// ── T4 terminal error resets the reply slot: the next reply opens a NEW bubble ──
await p.click('#clear');
await say('before error');
await p.evaluate(() => {
  const a = window.agent();
  a.onEvent({ type: 'assistant', text: 'dying reply', final: false, turn: 55 });
  a.onEvent({ type: 'error', error: 'synth exploded', turn: 55 });
  a.onEvent({ type: 'assistant', text: 'next reply', final: true, turn: 56 });
});
await p.waitForTimeout(300);
r = await rows();
check('T4 reply after a turn-tagged error gets a fresh bubble',
  r.some(x => x.includes('dying reply')) && r.some(x => x.includes('next reply')) &&
  !r.some(x => x.includes('dying') && x.includes('next')), JSON.stringify(r));

// ── T5 mic/state coherence: typed turns while micOn=false must never claim "listening — just talk"
const status = await p.$eval('#status', n => n.textContent);
const bodyState = await p.evaluate(() => document.body.dataset.state);
check('T5 status matches micOn=false', !/listening — just talk/.test(status), status + ' / ' + bodyState);

// ── T6 late straggler correction (regression guard for the original bug) ────
await p.click('#clear');
await p.evaluate(() => {
  const a = window.agent();
  a.onEvent({ type: 'stt', turnComplete: true, text: 'question one', ms: 0 });
  a.onEvent({ type: 'assistant', text: 'answer one part', full: 'answer one part two', final: false, turn: 70 });
  a.onEvent({ type: 'stt', turnComplete: true, text: 'question two', ms: 0 });   // barge-in
  a.onEvent({ type: 'assistant', text: 'answer one part', full: 'answer one part two', final: true, turn: 70 });  // straggler final
  a.onEvent({ type: 'assistant', text: 'answer two', full: 'answer two', final: true, turn: 71 });
});
await p.waitForTimeout(300);
r = await rows();
const order = r.map(x => x.split('|')[1]?.slice(0, 12));
check('T6 straggler lands above, new reply below',
  r.length === 4 && r[1].includes('answer one') && r[3].includes('answer two'), JSON.stringify(r));
check('T6 interrupted reply keeps its cut mark + tail', (await p.$$eval('#chat .cut', n => n.length)) === 1 &&
  (await p.$$eval('#chat .tail', n => n.map(x => x.textContent))).join('') === ' two', 'cut/tail wrong');

// ── T7 tool chip lifecycle: one id = one act = one chip, updated in place (spinner → result →
// late correction). Ids are provider-unique per call within an agent; cross-agent reuse is the
// identity guard's job (T9), so the page never treats a same-agent same-id event as a new act. ──
await p.click('#clear');
await p.evaluate(() => {
  const a = window.agent();
  a.onEvent({ type: 'tool', name: 'weather', id: 't1', args: { city: 'Paris' }, running: true });
  a.onEvent({ type: 'tool', name: 'weather', id: 't1', args: { city: 'Paris' }, result: 'sunny' });
  a.onEvent({ type: 'tool', name: 'lookup', id: 't2', args: {}, running: true });   // a second act → its own chip
});
await p.waitForTimeout(200);
r = await rows();
check('T7 one chip per id, updated in place; distinct ids stack',
  r.length === 2 && r[0].includes('sunny') && !r[0].includes('…') && r[1].includes('lookup') && r[1].includes('…'),
  JSON.stringify(r));

// ── T8 interim STT bubble dies with its agent: destroy mid-utterance must not leave a ghost ──
await p.click('#clear');
await p.evaluate(() => {
  window.agent().onEvent({ type: 'stt', turnComplete: false, text: 'half a sen', ms: 0 });
  document.getElementById('model').dispatchEvent(new Event('change'));   // dropAgent
});
await p.waitForTimeout(200);
r = await rows();
check('T8 no interim ghost after the agent is dropped', !r.some(x => x.includes('interim')), JSON.stringify(r));

// ── T9 identity guard: a DEAD agent's late detached-tool result must not touch the new
// agent's chip, even with the same id ──
await p.click('#clear');
await say('guard test');
const deadEmit = await p.evaluate(() => {
  const dead = window.agent();
  const emit = dead.onEvent.bind(dead);       // capture the dead agent's event path
  document.getElementById('model').dispatchEvent(new Event('change'));   // dropAgent
  return new Promise(res => { window.__deadEmit = emit; res(true); });
});
await say('new agent turn');                  // builds the next agent
await p.evaluate(() => {
  window.agent().onEvent({ type: 'tool', name: 'lookup', id: 'x1', args: {}, running: true });  // NEW agent's chip
  window.__deadEmit({ type: 'tool', name: 'lookup', id: 'x1', args: {}, result: 'STALE FROM DEAD AGENT' });
});
await p.waitForTimeout(200);
r = await rows();
check('T9 dead agent\'s late tool result is dropped, new chip still spinning',
  r.some(x => x.includes('lookup') && x.includes('…')) && !r.some(x => x.includes('STALE')), JSON.stringify(r));

// ── T10 interrupted → real result corrects the SAME chip (kept mapping) ──
await p.evaluate(() => {
  const a = window.agent();
  a.onEvent({ type: 'tool', name: 'slow', id: 's1', args: {}, running: true });
  a.onEvent({ type: 'tool', name: 'slow', id: 's1', args: {}, result: { ok: false, text: 'interrupted — did not finish' } });
  a.onEvent({ type: 'tool', name: 'slow', id: 's1', args: {}, result: 'late but real' });   // detached run settling
});
await p.waitForTimeout(200);
r = await rows();
check('T10 late real result corrects the interrupted chip in place',
  r.filter(x => x.includes('slow')).length === 1 && r.some(x => x.includes('late but real')), JSON.stringify(r));

console.log(`\n${pass} pass, ${fail} fail`);
await b.close();
process.exit(fail ? 1 : 0);
