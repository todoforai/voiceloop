#!/usr/bin/env node
// bench/blackbox/merge-inside.js — attach the SUT page's window.__bench (internal milestones) to a
// black-box run file. Stdin: the eval output (raw JSON string, possibly wrapper-object or
// double-encoded). Usage: agent-browser eval 'JSON.stringify(window.__bench)' | node merge-inside.js <run.json>
import { readFileSync, writeFileSync } from 'node:fs';

const runFile = process.argv[2];
let raw = readFileSync(0, 'utf8').trim();
let v = JSON.parse(raw);
if (v?.data?.result !== undefined) v = v.data.result;   // agent-browser wrapper form
if (typeof v === 'string') v = JSON.parse(v);           // double-encoded form
if (!Array.isArray(v)) throw new Error('could not extract __bench array');
const run = JSON.parse(readFileSync(runFile, 'utf8'));
run.browserEvents = v;
writeFileSync(runFile, JSON.stringify(run, null, 2));
console.log(`merged ${v.length} internal events into ${runFile}`);
