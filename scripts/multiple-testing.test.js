#!/usr/bin/env node
/**
 * ITEM 241 — Track multiple-testing exposure and selection bias.
 * Tests for src/trading/research/multiple-testing.ts
 * Category A: pure function tests, no external data.
 */
'use strict';

const path = require('path');
const M = require(path.resolve(__dirname, '../dist/trading/research/multiple-testing'));

let pass = 0, fail = 0;
function ok(label, cond) {
  if (cond) { pass++; console.log('  PASS ' + label); }
  else { fail++; console.log('  FAIL ' + label); }
}
function eq(a, b, label) { ok(label, JSON.stringify(a) === JSON.stringify(b)); }

// ── M1: Empty results ─────────────────────────────────────────────────

console.log('M1: Empty results');

const r1 = M.computeMultipleTestingReport([]);
eq(r1.totalTests, 0, 'M1a: totalTests 0');
eq(r1.bonferroniAlpha, 0.05, 'M1b: bonferroniAlpha default');
eq(r1.sharpeInflationFactor, 1, 'M1c: inflation factor 1');
eq(r1.selectionBiasScore, 1, 'M1d: bias score 1');

// ── M2: Single test ───────────────────────────────────────────────────

console.log('M2: Single test');

const r2 = M.computeMultipleTestingReport([
  { testId: 'A', metricName: 'sharpe', metricValue: 2.0, sampleSize: 100, selected: true }
]);
eq(r2.totalTests, 1, 'M2a: totalTests 1');
eq(r2.selectedTests, 1, 'M2b: selectedTests 1');
ok('M2c: bonferroniAlpha = baseAlpha', r2.bonferroniAlpha === 0.05);

// ── M3: Bonferroni correction ─────────────────────────────────────────

console.log('M3: Bonferroni correction');

const results3 = [
  { testId: 'A', metricName: 'sharpe', metricValue: 2.0, sampleSize: 100, selected: false },
  { testId: 'B', metricName: 'sharpe', metricValue: 2.1, sampleSize: 100, selected: false },
  { testId: 'C', metricName: 'sharpe', metricValue: 2.2, sampleSize: 100, selected: true },
];
const r3 = M.computeMultipleTestingReport(results3);
eq(r3.totalTests, 3, 'M3a: totalTests 3');
ok('M3b: bonferroniAlpha = 0.05/3', Math.abs(r3.bonferroniAlpha - 0.05 / 3) < 1e-10);

// ── M4: Custom base alpha ─────────────────────────────────────────────

console.log('M4: Custom base alpha');

const r4 = M.computeMultipleTestingReport(results3, 0.01);
ok('M4a: bonferroniAlpha = 0.01/3', Math.abs(r4.bonferroniAlpha - 0.01 / 3) < 1e-10);

// ── M5: Harvey-Zhu inflation factor ────────────────────────────────────

console.log('M5: Harvey-Zhu inflation factor');

ok('M5a: inflation > 1 for multiple tests', r3.sharpeInflationFactor > 1);

// ── M6: Selection bias ────────────────────────────────────────────────

console.log('M6: Selection bias');

ok('M6a: bias score >= 1', r3.selectionBiasScore >= 1);

// ── M7: Reproduce metric ──────────────────────────────────────────────

console.log('M7: Reproduce metric');

const r7a = M.reproduceMetricFromReport(r3, 'totalTests');
eq(r7a, 3, 'M7a: totalTests');
const r7b = M.reproduceMetricFromReport(r3, 'bonferroniAlpha');
eq(r7b, r3.bonferroniAlpha, 'M7b: bonferroniAlpha');
const r7c = M.reproduceMetricFromReport(r3, 'unknown');
eq(r7c, null, 'M7c: unknown metric returns null');

// ── M8: Deterministic ─────────────────────────────────────────────────

console.log('M8: Deterministic');

const ra = M.computeMultipleTestingReport(results3);
const rb = M.computeMultipleTestingReport(results3);
eq(ra.bonferroniAlpha, rb.bonferroniAlpha, 'M8a: bonferroniAlpha');
eq(ra.sharpeInflationFactor, rb.sharpeInflationFactor, 'M8b: inflationFactor');
ok('M8c: biasScore matches', ra.selectionBiasScore === rb.selectionBiasScore);

// ── M9: Minimum Sharpe for significance ────────────────────────────────

console.log('M9: Minimum Sharpe for significance');

ok('M9a: minimumSharpe > 0', r3.minimumSharpeForSignificance > 0);

// ── M10: Holm corrected p-values ──────────────────────────────────────

console.log('M10: Holm corrected p-values');

ok('M10a: holmCorrectedPValues is array', Array.isArray(r3.holmCorrectedPValues));

// ── Summary ────────────────────────────────────────────────────────────

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail > 0 ? 1 : 0);
