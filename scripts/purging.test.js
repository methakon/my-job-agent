#!/usr/bin/env node
/**
 * ITEM 171 — Purging when labels overlap.
 * Tests for src/trading/research/purging.ts
 * Category A: pure function tests, no external data.
 */
'use strict';

const path = require('path');
const M = require(path.resolve(__dirname, '../dist/trading/research/purging'));

let pass = 0, fail = 0;
function ok(label, cond) {
  if (cond) { pass++; console.log('  PASS ' + label); }
  else { fail++; console.log('  FAIL ' + label); }
}
function eq(a, b, label) { ok(label, JSON.stringify(a) === JSON.stringify(b)); }

// ── P1: Purge overlap basics ──────────────────────────────────────────

console.log('P1: Purge overlap basics');

// No overlap: all samples safe
const r1 = M.purgeOverlappingLabels({
  timestamps: [1000, 2000, 3000],
  labelHorizonMs: 500,
  valStartMs: 5000,
});
eq(r1.version, 'purge-v1', 'P1a: version');
eq(r1.safeIndices, [0, 1, 2], 'P1b: all safe');
eq(r1.purgedCount, 0, 'P1c: nothing purged');
ok('P1d: purgeRatio is 0', r1.purgeRatio === 0);

// All overlap
const r2 = M.purgeOverlappingLabels({
  timestamps: [4000, 4500, 4900],
  labelHorizonMs: 1000,
  valStartMs: 5000,
});
// labelEnds: 5000, 5500, 5900. overlapsVal: 5000>5000=false, 5500>5000=true, 5900>5000=true
eq(r2.safeIndices, [0], 'P2a: first safe (exact boundary)');
eq(r2.purgedIndices, [1, 2], 'P2b: last two purged');
eq(r2.purgedCount, 2, 'P2c: purgedCount');
ok('P2d: purgeRatio = 2/3', Math.abs(r2.purgeRatio - 2/3) < 1e-10);

// Partial overlap
const r3 = M.purgeOverlappingLabels({
  timestamps: [3000, 4000, 5000, 6000],
  labelHorizonMs: 500,
  valStartMs: 4600,
});
// labelEnds: 3500, 4500, 5500, 6500. overlapsVal: 3500>4600=F, 4500>4600=F, 5500>4600=T, 6500>4600=T
eq(r3.safeIndices, [0, 1], 'P3a: first two safe');
eq(r3.purgedIndices, [2, 3], 'P3b: last two purged');

// Empty input
const r4 = M.purgeOverlappingLabels({
  timestamps: [],
  labelHorizonMs: 500,
  valStartMs: 5000,
});
eq(r4.safeIndices, [], 'P4a: empty safe');
ok('P4b: purgeRatio is 0 for empty', r4.purgeRatio === 0);

// ── P2: Double purging with test window ────────────────────────────────

console.log('P2: Double purging with test window');

const r5 = M.purgeOverlappingLabels({
  timestamps: [1000, 3000, 5000, 7000, 9000],
  labelHorizonMs: 500,
  valStartMs: 4000,
  testStartMs: 8000,
});
// Labels: 1500, 3500, 5500, 7500, 9500
// val at 4000: 1500<4000 safe, 3500<4000 safe, 5500>4000 purge, 7500>4000 purge, 9500>4000 purge
// test at 8000: 1500<8000 no overlap, etc.
eq(r5.safeIndices, [0, 1], 'P5a: two safe');
eq(r5.purgedIndices, [2, 3, 4], 'P5b: three purged');

// ── P3: Deterministic (same inputs → same output) ──────────────────────

console.log('P3: Determinism');

const input = { timestamps: [1000, 2000, 3000], labelHorizonMs: 500, valStartMs: 2200 };
const ra = M.purgeOverlappingLabels(input);
const rb = M.purgeOverlappingLabels(input);
eq(ra.safeIndices, rb.safeIndices, 'P3a: safeIndices match');
eq(ra.purgedIndices, rb.purgedIndices, 'P3b: purgedIndices match');
ok('P3c: purgeRatio matches', ra.purgeRatio === rb.purgeRatio);

// ── P4: Edge: label exactly at val start ───────────────────────────────

console.log('P4: Edge — label exactly at val start');

const r6 = M.purgeOverlappingLabels({
  timestamps: [4500],
  labelHorizonMs: 500,
  valStartMs: 5000,
});
// labelEnd = 4500 + 500 = 5000, overlapsVal = 5000 > 5000 = false
ok('P4a: exact boundary not purged', r6.safeIndices.length === 1);

const r7 = M.purgeOverlappingLabels({
  timestamps: [4501],
  labelHorizonMs: 500,
  valStartMs: 5000,
});
// labelEnd = 5001, overlapsVal = 5001 > 5000 = true
ok('P4b: one over boundary purged', r7.purgedIndices.length === 1);

// ── P5: Verify purge success ──────────────────────────────────────────

console.log('P5: Verify purge success');

const r8 = M.purgeOverlappingLabels({
  timestamps: [1000, 2000, 3000],
  labelHorizonMs: 500,
  valStartMs: 5000,
});
const v1 = M.verifyPurgeSuccess(r8, [1000, 2000, 3000], 500, 5000);
ok('P5a: valid when no overlap', v1.valid);
eq(v1.violations, [], 'P5b: no violations');

// Violation: a safe index that actually overlaps
const r9 = { version: 'purge-v1', safeIndices: [0, 1, 2], purgedIndices: [], purgedCount: 0, totalCount: 3, purgeRatio: 0 };
const v2 = M.verifyPurgeSuccess(r9, [4000, 4500, 5000], 1000, 4200);
ok('P5c: invalid when violation exists', !v2.valid);
ok('P5d: violation indices non-empty', v2.violations.length > 0);

// ── P6: Large dataset ─────────────────────────────────────────────────

console.log('P6: Large dataset');

const bigTimestamps = Array.from({ length: 1000 }, (_, i) => i * 1000);
const rBig = M.purgeOverlappingLabels({
  timestamps: bigTimestamps,
  labelHorizonMs: 500,
  valStartMs: 500000,
});
ok('P6a: 1000 samples processed', rBig.totalCount === 1000);
ok('P6b: purgeRatio between 0 and 1', rBig.purgeRatio >= 0 && rBig.purgeRatio <= 1);

// ── Summary ────────────────────────────────────────────────────────────

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail > 0 ? 1 : 0);
