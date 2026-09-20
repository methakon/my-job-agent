#!/usr/bin/env node
/**
 * ITEM 169 — Walk-forward time-respecting train/validation/test split.
 * Tests for src/trading/research/walk-forward.ts
 * Category A: pure function tests, no external data.
 */
'use strict';

const path = require('path');
const M = require(path.resolve(__dirname, '../dist/trading/research/walk-forward'));

let pass = 0, fail = 0;
function ok(label, cond) {
  if (cond) { pass++; console.log('  PASS ' + label); }
  else { fail++; console.log('  FAIL ' + label); }
}
function eq(a, b, label) { ok(label, JSON.stringify(a) === JSON.stringify(b)); }

// ── W1: Basic walk-forward split ───────────────────────────────────────

console.log('W1: Basic walk-forward split');

const ts = Array.from({ length: 100 }, (_, i) => i * 1000);
const result = M.generateWalkForwardSplits(ts, {
  nFolds: 3,
  minTrainSize: 20,
  valSize: 10,
  testSize: 5,
});
ok('W1a: ok', result.ok);
if (result.ok) {
  eq(result.value.version, 'wf-v1', 'W1b: version');
  ok('W1c: has folds', result.value.folds.length > 0);
  ok('W1d: totalSamples', result.value.totalSamples === 100);
  const f = result.value.folds[0];
  eq(f.trainIndices.length, 20, 'W1e: train size');
  eq(f.valIndices.length, 10, 'W1f: val size');
  eq(f.testIndices.length, 5, 'W1g: test size');
  ok('W1h: train max < val min', Math.max(...f.trainIndices) < Math.min(...f.valIndices));
  ok('W1i: val max < test min', Math.max(...f.valIndices) < Math.min(...f.testIndices));
}

// ── W2: No temporal leakage ───────────────────────────────────────────

console.log('W2: No temporal leakage');

if (result.ok) {
  const valid = M.validateNoTemporalLeakage(result.value);
  ok('W2a: no leakage', valid);
}

// ── W3: Insufficient data ─────────────────────────────────────────────

console.log('W3: Insufficient data');

const r2 = M.generateWalkForwardSplits(
  [1000, 2000],
  { nFolds: 3, minTrainSize: 20, valSize: 10, testSize: 5 }
);
ok('W3a: not ok', !r2.ok);
if (!r2.ok) eq(r2.reason, 'INSUFFICIENT_DATA', 'W3b: reason');

// ── W4: Config error ──────────────────────────────────────────────────

console.log('W4: Config error');

const r3 = M.generateWalkForwardSplits(ts, {
  nFolds: 0, minTrainSize: 20, valSize: 10, testSize: 5
});
ok('W4a: not ok for nFolds=0', !r3.ok);
if (!r3.ok) eq(r3.reason, 'CONFIG_ERROR', 'W4b: reason');

const r4 = M.generateWalkForwardSplits(ts, {
  nFolds: 3, minTrainSize: 0, valSize: 10, testSize: 5
});
ok('W4c: not ok for minTrainSize=0', !r4.ok);

const r5 = M.generateWalkForwardSplits(ts, {
  nFolds: 3, minTrainSize: 20, valSize: 0, testSize: 5
});
ok('W4d: not ok for valSize=0', !r5.ok);

// ── W5: Deterministic ─────────────────────────────────────────────────

console.log('W5: Deterministic');

const cfg = { nFolds: 3, minTrainSize: 20, valSize: 10, testSize: 5 };
const ra = M.generateWalkForwardSplits(ts, cfg);
const rb = M.generateWalkForwardSplits(ts, cfg);
if (ra.ok && rb.ok) {
  eq(ra.value.folds.length, rb.value.folds.length, 'W5a: same fold count');
  for (let i = 0; i < ra.value.folds.length; i++) {
    eq(ra.value.folds[i].trainIndices, rb.value.folds[i].trainIndices, 'W5b: fold ' + i + ' train');
    eq(ra.value.folds[i].valIndices, rb.value.folds[i].valIndices, 'W5c: fold ' + i + ' val');
  }
}

// ── W6: Fold ordering ─────────────────────────────────────────────────

console.log('W6: Fold ordering — val slides forward');

if (ra.ok) {
  for (let i = 1; i < ra.value.folds.length; i++) {
    const prev = ra.value.folds[i - 1];
    const curr = ra.value.folds[i];
    ok('W6: fold ' + i + ' val start > fold ' + (i - 1) + ' val start',
      curr.valIndices[0] > prev.valIndices[0]);
  }
}

// ── W7: No test window ────────────────────────────────────────────────

console.log('W7: No test window (testSize=0)');

const r7 = M.generateWalkForwardSplits(ts, {
  nFolds: 5, minTrainSize: 15, valSize: 10, testSize: 0
});
ok('W7a: ok', r7.ok);
if (r7.ok) {
  const f7 = r7.value.folds[0];
  eq(f7.testIndices.length, 0, 'W7b: no test indices');
}

// ── Summary ────────────────────────────────────────────────────────────

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail > 0 ? 1 : 0);
