#!/usr/bin/env node
/**
 * Tests for the expiry-day backtest metric layer and the paper journal.
 *
 * The critical property: with zero expiry sessions the backtest MUST refuse to
 * produce numbers. A test that would let it invent statistics is a failing test.
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const B = require('./expiry-day-backtest');
const J = require('./expiry-day-paper-journal');

let passed = 0; let failed = 0; const failures = [];
function test(name, fn) {
  try { fn(); console.log(`  ok   ${name}`); passed += 1; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message.split('\n').join('\n       ')}`); failed += 1; failures.push(name); }
}
const group = (n) => console.log(`\n${n}`);
const t = (returnPts, extra = {}) => ({ returnPts, ...extra });

console.log('expiry-day backtest + journal tests');

// ───────────────────────────── metrics ───────────────────────────────────
group('backtest: trade metrics');
test('no occurrences ⇒ nulls, not zeros pretending to be data', () => {
  const m = B.tradeMetrics([]);
  assert.equal(m.n, 0);
  assert.equal(m.winRate, null);
  assert.equal(m.expectancy, null);
  assert.equal(m.profitFactor, null);
});
test('win rate, expectancy and profit factor compute from returns', () => {
  // returns sorted: [-4, -2, 6, 10]  ⇒ median = (-2 + 6) / 2 = 2
  const m = B.tradeMetrics([t(10), t(-4), t(6), t(-2)]);
  assert.equal(m.n, 4);
  assert.equal(m.winRate, 0.5);
  assert.equal(m.avgReturn, 2.5);
  assert.equal(m.medianReturn, 2);
  assert.equal(m.profitFactor, 2.667);       // gross win 16 / gross loss 6
  assert.equal(m.expectancy, 2.5);
});
test('max drawdown tracks the equity curve peak', () => {
  const m = B.tradeMetrics([t(10), t(-25), t(5)]);
  assert.equal(m.maxDrawdownPts, 25);
});
test('profit factor is explicitly INFINITE with no losing trade', () => {
  const m = B.tradeMetrics([t(5), t(7)]);
  assert.equal(m.profitFactor, 'INFINITE_NO_LOSSES');
});
test('MAE/MFE/slippage/time-to-target aggregate when present', () => {
  const m = B.tradeMetrics([
    t(10, { maePts: 4, mfePts: 14, slippagePts: 1.2, timeToTargetMin: 22, timeToInvalidationMin: null, falseBreak: true }),
    t(-6, { maePts: 9, mfePts: 2, slippagePts: 1.4, timeToTargetMin: null, timeToInvalidationMin: 14, falseBreak: false }),
  ]);
  assert.equal(m.avgMAE, 6.5);
  assert.equal(m.avgMFE, 8);
  assert.equal(m.avgSlippagePts, 1.3);
  assert.equal(m.medianTimeToTargetMin, 22);
  assert.equal(m.medianTimeToInvalidationMin, 14);
  assert.equal(m.falseBreakRate, 0.5);
});

// ──────────────────────── walk-forward discipline ───────────────────────
group('backtest: walk-forward');
const sess = (d, isExpiry = false) => ({ date: d, isExpiry });

test('split is chronological and leaves an OOS tail', () => {
  const s = ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04', '2026-01-05'].map((d) => sess(d));
  const sp = B.splitWalkForward(s, { trainFrac: 0.6, valFrac: 0.2 });
  assert.deepEqual(sp.train.map((x) => x.date), ['2026-01-01', '2026-01-02', '2026-01-03']);
  assert.deepEqual(sp.validation.map((x) => x.date), ['2026-01-04']);
  assert.deepEqual(sp.outOfSample.map((x) => x.date), ['2026-01-05']);
  assert.ok(sp.outOfSample.length > 0, 'OOS must not be empty');
});
test('split handles zero sessions', () => {
  const sp = B.splitWalkForward([]);
  assert.equal(sp.train.length, 0);
  assert.equal(sp.outOfSample.length, 0);
});
test('OVERFIT is flagged when a positive train expectancy dies out-of-sample', () => {
  const v = B.overfitCheck({ trainMetric: { n: 40, expectancy: 6 }, oosMetric: { n: 20, expectancy: -1 } });
  assert.equal(v.verdict, 'OVERFIT');
});
test('DEGRADED when OOS expectancy is under 40% of train', () => {
  const v = B.overfitCheck({ trainMetric: { n: 40, expectancy: 10 }, oosMetric: { n: 20, expectancy: 2 } });
  assert.equal(v.verdict, 'DEGRADED');
});
test('STABLE when sign and magnitude hold', () => {
  const v = B.overfitCheck({ trainMetric: { n: 40, expectancy: 5 }, oosMetric: { n: 20, expectancy: 4 } });
  assert.equal(v.verdict, 'STABLE');
});
test('small training sample is refused rather than judged', () => {
  const v = B.overfitCheck({ trainMetric: { n: 6, expectancy: 9 }, oosMetric: { n: 3, expectancy: 9 } });
  assert.equal(v.verdict, 'INSUFFICIENT_SAMPLE');
});
test('empty OOS slice is reported, not treated as success', () => {
  const v = B.overfitCheck({ trainMetric: { n: 40, expectancy: 5 }, oosMetric: { n: 0, expectancy: null } });
  assert.equal(v.verdict, 'NO_OOS_DATA');
});

// ───────────────────── the honest INSUFFICIENT_DATA path ────────────────
group('backtest: refuses to fabricate');
test('classifySessionDates flags expiry sessions', () => {
  const r = B.classifySessionDates(['2026-09-09', '2026-09-29', '2026-10-01'], { expiryDates: ['2026-09-29'] });
  assert.equal(r[1].isExpiry, true);
  assert.equal(r[0].isExpiry, false);
});
test('zero expiry sessions ⇒ INSUFFICIENT_DATA and a refusal verdict', () => {
  const run = B.buildRun({
    indexKey: 'NIFTY',
    sessions: [sess('2026-09-09'), sess('2026-09-10'), sess('2026-09-11')],
    setupResults: { A_ORB_VWAP: [] },
  });
  assert.equal(run.status, 'INSUFFICIENT_DATA');
  assert.equal(run.sessionInventory.expirySessions, 0);
  assert.match(run.verdict, /NO_VALIDATION_POSSIBLE/);
  assert.ok(run.nextActions.length >= 2);
});
test('per-setup metrics stay null when there are no occurrences', () => {
  const run = B.buildRun({ indexKey: 'NIFTY', sessions: [], setupResults: { C_FAILED_BREAK: [] } });
  assert.equal(run.perSetup.C_FAILED_BREAK.n, 0);
  assert.equal(run.perSetup.C_FAILED_BREAK.winRate, null);
});
test('≥20 expiry sessions flips the status to MEASURABLE', () => {
  const many = Array.from({ length: 25 }, (_, i) => sess(`2026-01-${String(i + 1).padStart(2, '0')}`, true));
  const run = B.buildRun({ indexKey: 'NIFTY', sessions: many, setupResults: { A_ORB_VWAP: [t(3), t(-1)] } });
  assert.equal(run.status, 'MEASURABLE');
  assert.equal(run.perSetup.A_ORB_VWAP.n, 2);
});

// ───────────────────────────── paper journal ────────────────────────────
group('paper journal: hypotheticals only');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'expiry-journal-'));
const fakeCycle = (over = {}) => ({
  index: 'NIFTY', dateIso: '2026-09-29', spot: 22780,
  direction: {
    view: 'NO_TRADE', confidence: 42, confidenceIsCalibrated: false, confidenceNote: 'uncalibrated',
    bullishEvidence: ['PRICE_ACTION_SCORE'], bearishEvidence: [], neutralEvidence: ['OI_WALL_SCORE'],
    unusableBuckets: ['FUTURES_BASIS_SCORE', 'BREADTH_SCORE'], signalConflict: false,
    netEvidence: 0.12, agreementShare: 0.6, whyNoTrade: ['policy not approved'],
  },
  regime: { regime: 'PIN_RANGE', reason: 'CONTAINED_BELOW_IMPLIED', validated: false },
  freshness: { overallBucket: 'FRESH', OI_STALE: false, dataAgeMs: 900 },
  optionMetrics: { atm: { spread: { spread: 1, spreadPctOfMid: 1.2 } } },
  impliedMove: { impliedMovePts: 153.55 },
  openingRange: { orHigh: 22850, orLow: 22650, breakBuffer: 20 },
  setups: { candidates: [{ setup: 'H_NO_TRADE', why: 'blocked: POLICY_PERMITS' }] },
  tradeable: { blocking: ['POLICY_PERMITS'], tradeable: false },
  authority: { canPlaceOrder: false },
  ...over,
});

test('record carries every required provenance field', () => {
  const r = J.buildRecord({ cycle: fakeCycle(), nowMs: Date.UTC(2026, 8, 29, 3, 30, 0) });
  for (const f of ['schema', 'recordedAtUtc', 'recordedAtIst', 'index', 'sessionDate', 'spot', 'bias', 'confidence',
    'confidenceIsCalibrated', 'evidenceFor', 'evidenceAgainst', 'dataFreshness', 'setup', 'invalidation',
    'whyNotTrade', 'blockingGates', 'hypothetical', 'authority']) {
    assert.ok(f in r, `missing ${f}`);
  }
  assert.equal(r.authority.canPlaceOrder, false);
  assert.equal(r.hypothetical.entryPrice, null, 'no price is invented for an unselected contract');
  assert.equal(r.recordedAtIst, '2026-09-29 09:00');
});
test('append/read round-trips and paperReport aggregates', () => {
  J.append(J.buildRecord({ cycle: fakeCycle() }), { dir: tmpDir });
  J.append(J.buildRecord({ cycle: fakeCycle({ direction: { view: 'RANGE', confidence: 60, confidenceIsCalibrated: false, bullishEvidence: [], bearishEvidence: [], neutralEvidence: [], unusableBuckets: [], signalConflict: false, whyNotTrade: [] }, regime: { regime: 'PIN_RANGE', reason: 'x', validated: false }, setups: { candidates: [{ setup: 'F_ATM_MEAN_REVERSION', why: 'pin' }] }, tradeable: { blocking: [], tradeable: false } }) }), { dir: tmpDir });
  const recs = J.read('2026-09-29', { dir: tmpDir });
  assert.equal(recs.length, 2);
  const rep = J.paperReport('2026-09-29', { dir: tmpDir });
  assert.equal(rep.cycles, 2);
  assert.equal(rep.byBias.NO_TRADE, 1);
  assert.equal(rep.byBias.RANGE, 1);
  assert.equal(rep.calibratedConfidenceCycles, 0);
});
test('paperReport on a missing day is empty, not an error', () => {
  const rep = J.paperReport('1999-01-01', { dir: tmpDir });
  assert.equal(rep.cycles, 0);
  assert.equal(rep.noTradeRate, null);
});
test('NO_TRADE rate is reported explicitly (honest outcome)', () => {
  J.append(J.buildRecord({ cycle: fakeCycle() }), { dir: tmpDir });
  const rep = J.paperReport('2026-09-29', { dir: tmpDir });
  assert.ok(rep.noTradeRate > 0);
  assert.match(rep.note, /successful outcome/);
});

fs.rmSync(tmpDir, { recursive: true, force: true });
console.log(`\nexpiry-day backtest+journal: ${passed} passed, ${failed} failed`);
if (failed) { console.log('failed:', failures.join(' | ')); process.exit(1); }
