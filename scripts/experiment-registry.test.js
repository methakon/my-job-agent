#!/usr/bin/env node
/**
 * ITEM 177 — Track every experiment and number of attempts.
 * Tests for src/trading/research/experiment-registry.ts
 * Category A: pure function tests, no external data.
 */
'use strict';

const path = require('path');
const M = require(path.resolve(__dirname, '../dist/trading/research/experiment-registry'));

let pass = 0, fail = 0;
function ok(label, cond) {
  if (cond) { pass++; console.log('  PASS ' + label); }
  else { fail++; console.log('  FAIL ' + label); }
}
function eq(a, b, label) { ok(label, JSON.stringify(a) === JSON.stringify(b)); }

// ── E1: Create empty registry ──────────────────────────────────────────

console.log('E1: Create empty registry');

const reg = M.createRegistry();
ok('E1a: is Map', reg instanceof Map);
ok('E1b: empty', reg.size === 0);

// ── E2: Register experiment ────────────────────────────────────────────

console.log('E2: Register experiment');

const exp = M.registerExperiment(reg, {
  id: 'exp-001',
  name: 'Gap Fade Strategy',
  description: 'Test gap fade on NIFTY',
  timestampMs: 1000000,
  strategyType: 'gap-fade',
  metadata: { universe: 'NIFTY50' },
});
eq(exp.id, 'exp-001', 'E2a: id');
eq(exp.name, 'Gap Fade Strategy', 'E2b: name');
eq(exp.strategyType, 'gap-fade', 'E2c: strategyType');
ok('E2d: empty attempts', exp.attempts.length === 0);
ok('E2e: metadata preserved', exp.metadata.universe === 'NIFTY50');

// ── E3: Record attempts ───────────────────────────────────────────────

console.log('E3: Record attempts');

const a1 = M.recordAttempt(reg, 'exp-001', {
  timestampMs: 1100000,
  attemptParams: { lookback: 5 },
  metrics: { sharpe: 1.2, maxDD: 0.05 },
  success: true,
  notes: 'First attempt',
});
ok('E3a: attempt not null', a1 !== null);
if (a1) {
  eq(a1.attemptNumber, 1, 'E3b: attemptNumber 1');
  ok('E3c: metrics correct', a1.metrics.sharpe === 1.2);
}

const a2 = M.recordAttempt(reg, 'exp-001', {
  timestampMs: 1200000,
  attemptParams: { lookback: 10 },
  metrics: { sharpe: 0.8, maxDD: 0.12 },
  success: false,
});
ok('E3d: second attempt', a2 !== null);
if (a2) eq(a2.attemptNumber, 2, 'E3e: attemptNumber 2');

// ── E4: Record attempt for non-existent experiment ─────────────────────

console.log('E4: Record attempt for non-existent experiment');

const aBad = M.recordAttempt(reg, 'exp-999', {
  timestampMs: 1000000,
  attemptParams: {},
  metrics: {},
  success: true,
});
ok('E4a: returns null', aBad === null);

// ── E5: Summarize experiment ───────────────────────────────────────────

console.log('E5: Summarize experiment');

const summary = M.summarizeExperiment(reg, 'exp-001');
ok('E5a: not null', summary !== null);
if (summary) {
  eq(summary.totalAttempts, 2, 'E5b: totalAttempts');
  eq(summary.successfulAttempts, 1, 'E5c: successfulAttempts');
  ok('E5d: bestMetric.sharpe = 1.2', summary.bestMetric.sharpe === 1.2);
  ok('E5e: bestMetric.maxDD = 0.05', summary.bestMetric.maxDD === 0.05);
}

// ── E6: Summarize non-existent experiment ──────────────────────────────

console.log('E6: Summarize non-existent experiment');

const sBad = M.summarizeExperiment(reg, 'exp-999');
ok('E6a: returns null', sBad === null);

// ── E7: List experiments ───────────────────────────────────────────────

console.log('E7: List experiments');

const list = M.listExperiments(reg);
eq(list.length, 1, 'E7a: one experiment');
eq(list[0].id, 'exp-001', 'E7b: correct id');

// ── E8: Reproduce metric ──────────────────────────────────────────────

console.log('E8: Reproduce metric');

const m1 = M.reproduceMetric(reg, 'exp-001', 1, 'sharpe');
ok('E8a: sharpe from attempt 1 = 1.2', m1 === 1.2);
const m2 = M.reproduceMetric(reg, 'exp-001', 2, 'maxDD');
ok('E8b: maxDD from attempt 2 = 0.12', m2 === 0.12);
const m3 = M.reproduceMetric(reg, 'exp-001', 1, 'unknown');
ok('E8c: unknown metric returns null', m3 === null);
const m4 = M.reproduceMetric(reg, 'exp-999', 1, 'sharpe');
ok('E8d: non-existent experiment returns null', m4 === null);

// ── E9: Multiple experiments ───────────────────────────────────────────

console.log('E9: Multiple experiments');

M.registerExperiment(reg, {
  id: 'exp-002',
  name: 'Breakout Strategy',
  description: 'Test breakouts',
  timestampMs: 2000000,
  strategyType: 'breakout',
});
const list2 = M.listExperiments(reg);
eq(list2.length, 2, 'E9a: two experiments');

// ── E10: Attempt counter increments ────────────────────────────────────

console.log('E10: Attempt counter increments');

M.recordAttempt(reg, 'exp-001', {
  timestampMs: 1300000,
  attemptParams: { lookback: 15 },
  metrics: { sharpe: 1.5 },
  success: true,
});
const summary2 = M.summarizeExperiment(reg, 'exp-001');
if (summary2) {
  eq(summary2.totalAttempts, 3, 'E10a: 3 total attempts');
  eq(summary2.successfulAttempts, 2, 'E10b: 2 successful');
}

// ── Summary ────────────────────────────────────────────────────────────

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail > 0 ? 1 : 0);
