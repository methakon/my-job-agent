#!/usr/bin/env node
/**
 * ITEM 175 — CPCV (Combinatorial Purged Cross-Validation).
 * Tests for src/trading/research/cpcv.ts
 * Category A: pure function tests, no external data.
 */
'use strict';

const path = require('path');
const M = require(path.resolve(__dirname, '../dist/trading/research/cpcv'));

let pass = 0, fail = 0;
function ok(label, cond) {
  if (cond) { pass++; console.log('  PASS ' + label); }
  else { fail++; console.log('  FAIL ' + label); }
}
function eq(a, b, label) { ok(label, JSON.stringify(a) === JSON.stringify(b)); }

// ── C1: Basic CPCV split ──────────────────────────────────────────────

console.log('C1: Basic CPCV split');

const r1 = M.generateCpcvSplits(100, {
  nGroups: 5,
  nTestGroups: 2,
  labelHorizonMs: 60000,
});
ok('C1a: ok', r1.ok);
if (r1.ok) {
  eq(r1.value.version, 'cpcv-v1', 'C1b: version');
  eq(r1.value.totalGroups, 5, 'C1c: totalGroups');
  ok('C1d: folds > 0', r1.value.folds.length > 0);
  // C(5,2) = 10
  eq(r1.value.totalSplits, 10, 'C1e: totalSplits');
}

// ── C2: No overlap between train and test ──────────────────────────────

console.log('C2: No overlap between train and test');

if (r1.ok) {
  const valid = M.validateCpcvSplits(r1.value);
  ok('C2a: no overlap', valid);
}

// ── C3: Insufficient data ─────────────────────────────────────────────

console.log('C3: Insufficient data');

const r3 = M.generateCpcvSplits(5, {
  nGroups: 5,
  nTestGroups: 2,
  labelHorizonMs: 60000,
});
ok('C3a: not ok for too few samples', !r3.ok);
if (!r3.ok) eq(r3.reason, 'INSUFFICIENT_DATA', 'C3b: reason');

// ── C4: Config errors ─────────────────────────────────────────────────

console.log('C4: Config errors');

const r4a = M.generateCpcvSplits(100, {
  nGroups: 1, nTestGroups: 1, labelHorizonMs: 60000
});
ok('C4a: nGroups < 2 is config error', !r4a.ok);
if (!r4a.ok) eq(r4a.reason, 'CONFIG_ERROR', 'C4b: reason');

const r4c = M.generateCpcvSplits(100, {
  nGroups: 5, nTestGroups: 0, labelHorizonMs: 60000
});
ok('C4c: nTestGroups < 1 is config error', !r4c.ok);

const r4d = M.generateCpcvSplits(100, {
  nGroups: 5, nTestGroups: 5, labelHorizonMs: 60000
});
ok('C4d: nTestGroups >= nGroups is config error', !r4d.ok);

// ── C5: Deterministic ─────────────────────────────────────────────────

console.log('C5: Deterministic');

const cfg = { nGroups: 4, nTestGroups: 2, labelHorizonMs: 60000 };
const ra = M.generateCpcvSplits(200, cfg);
const rb = M.generateCpcvSplits(200, cfg);
if (ra.ok && rb.ok) {
  eq(ra.value.folds.length, rb.value.folds.length, 'C5a: same fold count');
  for (let i = 0; i < ra.value.folds.length; i++) {
    eq(ra.value.folds[i].trainGroupIndices, rb.value.folds[i].trainGroupIndices, 'C5b: fold ' + i + ' train');
    eq(ra.value.folds[i].testGroupIndices, rb.value.folds[i].testGroupIndices, 'C5c: fold ' + i + ' test');
  }
}

// ── C6: Groups cover all samples ───────────────────────────────────────

console.log('C6: Groups cover all samples');

if (ra.ok) {
  const f0 = ra.value.folds[0];
  const allGroups = [...f0.trainGroupIndices, ...f0.testGroupIndices].sort((a, b) => a - b);
  const expected = Array.from({ length: 4 }, (_, i) => i);
  eq(allGroups, expected, 'C6a: all groups present');
}

// ── C7: Pairwise combinations ─────────────────────────────────────────

console.log('C7: Pairwise combinations');

const r7 = M.generateCpcvSplits(100, {
  nGroups: 4, nTestGroups: 2, labelHorizonMs: 60000
});
ok('C7a: ok', r7.ok);
if (r7.ok) {
  // C(4,2) = 6
  eq(r7.value.totalSplits, 6, 'C7b: C(4,2) = 6');
}

// ── Summary ────────────────────────────────────────────────────────────

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail > 0 ? 1 : 0);
