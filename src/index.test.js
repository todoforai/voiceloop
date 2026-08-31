import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as api from './index.js';

// The hand-written .d.ts is a SECOND source of truth about the public API, and a second source of
// truth rots: LANG_NAMES was exported from index.js and simply never declared, so TypeScript users
// couldn't import a value that existed. Nothing failed — the mismatch was invisible until someone
// hit it. This test makes the two files answer to each other.
const DTS = readFileSync(new URL('./index.d.ts', import.meta.url), 'utf8');
// Value exports only: `interface`/`type` are erased at runtime and correctly have no counterpart.
const declared = new Set(
  [...DTS.matchAll(/^export (?:declare )?(?:class|function|const) (\w+)/gm)].map((m) => m[1]),
);

test('every runtime export is declared in index.d.ts', () => {
  const undeclared = Object.keys(api).filter((k) => !declared.has(k));
  assert.deepEqual(undeclared, [], 'exported from index.js but invisible to TypeScript');
});

test('every declared value export exists at runtime', () => {
  const phantom = [...declared].filter((k) => !(k in api));
  assert.deepEqual(phantom, [], 'declared in index.d.ts but not actually exported — an import that fails at runtime');
});
