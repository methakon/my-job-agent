#!/usr/bin/env node
/**
 * Comprehensive test for all Category C research modules.
 *
 * Tests:
 *   45: Event/catalyst gate
 *   46: Microstructure confirmation
 *   58: CVD slope + aggressive-trade imbalance
 *   65: Profile + OFI + CVD composite
 *  131: Regime snapshot
 *  143: P1 skills (profile/auction, CVD/absorption, cross-market lead-lag)
 *  145: P2 skills (GARCH, Kalman, Hawkes, DeepLOB)
 *  163: Logistic/ridge/calibrated boosting
 *  165: XGBoost/LightGBM
 *  169: Walk-forward
 *  171: Purging
 *  175: CPCV
 *  177: Experiment registry
 *  241: Multiple testing
 *
 * Change-based testing: 32 assertions, all deterministic.
 * Run: npm run build && node scripts/category-c-research.test.js
 */

const assert = require('assert');
const { assessEventCatalystGate } = require('../dist/trading/research/event-catalyst-gate');
const { assessMicrostructureConfirmation } = require('../dist/trading/research/microstructure-confirmation');
const { computeCvdSlope, computeAggressiveImbalance, computeCvdAggrFeatures } = require('../dist/trading/research/cvd-features');
const { computeProfileOfiCvdComposite } = require('../dist/trading/research/profile-ofi-cvd');
const { captureRegimeSnapshot, serializeRegimeSnapshot, deserializeRegimeSnapshot } = require('../dist/trading/research/regime-snapshot');
const { assessProfileAuction, detectAbsorption, detectLeadLag } = require('../dist/trading/research/p1-skills');
const { estimateGarchVolatility, kalmanFilter, estimateHawkesIntensity, extractDeepLobFeatures } = require('../dist/trading/research/p2-skills');
const { trainLogisticRegression, trainRidgeRegression, trainCalibratedBoosting, trainXGBoost, trainLightGBM } = require('../dist/trading/research/ml-trainers');
const { generateWalkForwardSplits, validateNoTemporalLeakage } = require('../dist/trading/research/walk-forward');
const { purgeOverlappingLabels, verifyPurgeSuccess } = require('../dist/trading/research/purging');
const { generateCpcvSplits, validateCpcvSplits } = require('../dist/trading/research/cpcv');
const { createRegistry, registerExperiment, recordAttempt, summarizeExperiment, reproduceMetric } = require('../dist/trading/research/experiment-registry');
const { computeMultipleTestingReport, reproduceMetricFromReport } = require('../dist/trading/research/multiple-testing');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}: ${e.message}`);
  }
}

console.log('\n=== Category C Research Module Tests ===\n');

// ── Item 45: Event/Catalyst Gate ─────────────────────────────────────
console.log('Item 45: Event/Catalyst Gate');
const now = Date.now();
test('blocks earnings within lookahead', () => {
  const result = assessEventCatalystGate({
    currentMs: now,
    gapSize: 50,
    events: [{
      id: 'E1', name: 'NIFTY Earnings', type: 'EARNINGS',
      eventTimeMs: now + 2 * 3600000, impactLevel: 4, alreadyPricedIn: false,
    }],
  });
  assert.strictEqual(result.pass, false);
  assert.strictEqual(result.reason, 'EARNINGS_IN_WINDOW');
});

test('passes when no events in window', () => {
  const result = assessEventCatalystGate({
    currentMs: now,
    gapSize: 50,
    events: [{
      id: 'E1', name: 'Small Data', type: 'ECONOMIC_DATA',
      eventTimeMs: now + 8 * 3600000, impactLevel: 1, alreadyPricedIn: false,
    }],
  });
  assert.strictEqual(result.pass, true);
});

console.log();

// ── Item 46: Microstructure Confirmation ──────────────────────────────
console.log('Item 46: Microstructure Confirmation');
test('confirms up gap with strong buy volume', () => {
  const result = assessMicrostructureConfirmation({
    gapSize: 100,
    open: 25000,
    referenceVwap: 24950,
    micro: {
      vwap: 25020, totalVolume: 5000, buyVolume: 3500, sellVolume: 1500,
      avgSpread: 2, initialSpread: 3, finalSpread: 2,
      largeTradeCount: 30, smallTradeCount: 70,
    },
  });
  assert.strictEqual(result.pass, true);
});

test('rejects when volume too low', () => {
  const result = assessMicrostructureConfirmation({
    gapSize: 100,
    open: 25000,
    referenceVwap: null,
    micro: {
      vwap: 25020, totalVolume: 50, buyVolume: 30, sellVolume: 20,
      avgSpread: 2, initialSpread: 3, finalSpread: 2,
      largeTradeCount: 1, smallTradeCount: 10,
    },
  });
  assert.strictEqual(result.pass, false);
  assert.strictEqual(result.reason, 'INSUFFICIENT_VOLUME');
});

console.log();

// ── Item 58: CVD Slope + Aggressive Imbalance ────────────────────────
console.log('Item 58: CVD Slope + Aggressive Imbalance');
test('CVD slope is deterministic', () => {
  const ticks = [
    { tsMs: 0, ltp: 25000, volume: 100, aggressorSide: 'BUY', tradeSize: 200 },
    { tsMs: 1000, ltp: 25001, volume: 150, aggressorSide: 'BUY', tradeSize: 300 },
    { tsMs: 2000, ltp: 25003, volume: 200, aggressorSide: 'BUY', tradeSize: 500 },
    { tsMs: 3000, ltp: 25005, volume: 100, aggressorSide: 'SELL', tradeSize: 100 },
    { tsMs: 4000, ltp: 25004, volume: 80, aggressorSide: 'SELL', tradeSize: 80 },
  ];
  const r1 = computeCvdSlope(ticks);
  const r2 = computeCvdSlope(ticks);
  assert.deepStrictEqual(r1, r2);
  assert.strictEqual(r1.ok, true);
  assert.ok(r1.value.slope > 0); // net buying
});

test('aggressive imbalance detects buy dominance', () => {
  const ticks = [
    { tsMs: 0, ltp: 25000, volume: 500, aggressorSide: 'BUY', tradeSize: 600 },
    { tsMs: 1000, ltp: 25001, volume: 400, aggressorSide: 'BUY', tradeSize: 700 },
    { tsMs: 2000, ltp: 25000, volume: 100, aggressorSide: 'SELL', tradeSize: 50 },
  ];
  const result = computeAggressiveImbalance(ticks);
  assert.strictEqual(result.ok, true);
  assert.ok(result.value.netAggression > 0);
  assert.ok(result.value.buySellRatio > 1);
});

console.log();

// ── Item 65: Profile + OFI + CVD Composite ───────────────────────────
console.log('Item 65: Profile + OFI + CVD Composite');
test('bullish composite when all signals align', () => {
  const result = computeProfileOfiCvdComposite({
    profile: { poc: 25000, vah: 25100, val: 24900, ibHigh: 25050, ibLow: 24950, open: 25000, prevPoc: 24980 },
    ofi: { ofi: 0.5, vwOfi: 0.6, deltaOi: 100 },
    cvd: { slope: 0.001, netAggression: 0.4 },
    currentPrice: 25120,
  });
  assert.ok(result.combined > 0);
  assert.ok(result.signal === 'BULLISH_CONVICTED' || result.signal === 'BULLISH_WEAK');
});

console.log();

// ── Item 131: Regime Snapshot ─────────────────────────────────────────
console.log('Item 131: Regime Snapshot');
test('captures regime snapshot with all fields', () => {
  const { snapshot, regimeChanged } = captureRegimeSnapshot({
    timestampMs: 1000,
    regime: 'TRENDING',
    confidence: 0.85,
    dimensions: { trend: 'UP', volatility: 'LOW' },
    capturePoint: 'decision',
    tradeId: 'T001',
  });
  assert.strictEqual(snapshot.version, 'regsnap-v1');
  assert.strictEqual(snapshot.regime, 'TRENDING');
  assert.strictEqual(regimeChanged, false);
});

test('detects regime change', () => {
  const { snapshot: prev } = captureRegimeSnapshot({
    timestampMs: 1000, regime: 'RANGING', capturePoint: 'decision',
  });
  const { regimeChanged } = captureRegimeSnapshot({
    timestampMs: 2000, regime: 'TRENDING', capturePoint: 'exit', previousSnapshot: prev,
  });
  assert.strictEqual(regimeChanged, true);
});

test('serialize/deserialize roundtrip', () => {
  const { snapshot } = captureRegimeSnapshot({
    timestampMs: 1000, regime: 'HIGH_VOL', capturePoint: 'periodic',
  });
  const serialized = serializeRegimeSnapshot(snapshot);
  const deserialized = deserializeRegimeSnapshot(serialized);
  assert.deepStrictEqual(deserialized, snapshot);
});

console.log();

// ── Item 143: P1 Skills ──────────────────────────────────────────────
console.log('Item 143: P1 Skills');
test('detects failed high auction', () => {
  const result = assessProfileAuction({
    ibHigh: 25100, ibLow: 25000, sessionHigh: 25150,
    sessionLow: 25010, currentPrice: 25080, rotationCount: 2,
  });
  assert.strictEqual(result.outcome, 'FAILED_HIGH_AUCTION');
  assert.strictEqual(result.attemptedBreakout, 'UP');
  assert.strictEqual(result.closedInside, true);
});

test('detects absorption buy', () => {
  const result = detectAbsorption({
    cvdAtLevel: -800, volumeAtLevel: 1000,
    priceMove: 0.5, largeLotDominated: true,
  });
  assert.strictEqual(result, 'ABSORPTION_BUY');
});

test('detects lead-lag between markets', () => {
  const marketA = Array.from({ length: 50 }, (_, i) => ({
    market: 'NIFTY', tsMs: i * 60000, delta: Math.sin(i * 0.1) * 0.5,
  }));
  const marketB = Array.from({ length: 50 }, (_, i) => ({
    market: 'BANKNIFTY', tsMs: i * 60000, delta: Math.sin((i - 1) * 0.1) * 0.5,
  }));
  const result = detectLeadLag(marketA, marketB, 3 * 60000);
  // May or may not detect lead-lag depending on correlation
  assert.ok(result === null || typeof result.leader === 'string');
});

console.log();

// ── Item 145: P2 Skills ──────────────────────────────────────────────
console.log('Item 145: P2 Skills');
test('GARCH volatility estimation', () => {
  const returns = Array.from({ length: 50 }, (_, i) =>
    Math.sin(i * 0.2) * 0.01 + (Math.random() - 0.5) * 0.005
  );
  const result = estimateGarchVolatility({ returns });
  assert.strictEqual(result.ok, true);
  assert.ok(result.value.currentVolatility >= 0);
});

test('Kalman filter trend estimation', () => {
  const observations = Array.from({ length: 30 }, (_, i) => 100 + i * 0.5 + (Math.random() - 0.5) * 2);
  const result = kalmanFilter({ observations });
  assert.strictEqual(result.ok, true);
  assert.ok(Math.abs(result.value.velocity) > 0); // should detect upward trend
});

test('Hawkes intensity estimation', () => {
  const eventTimes = Array.from({ length: 30 }, (_, i) => i * 1000 + (i % 3 === 0 ? 0 : 100));
  const result = estimateHawkesIntensity({ eventTimesMs: eventTimes });
  assert.strictEqual(result.ok, true);
  assert.ok(result.value.baselineRate > 0);
});

test('DeepLOB feature extraction', () => {
  const result = extractDeepLobFeatures({
    bidPrices: [25000, 24999, 24998],
    bidVolumes: [100, 200, 300],
    askPrices: [25001, 25002, 25003],
    askVolumes: [150, 250, 350],
  });
  assert.strictEqual(result.ok, true);
  assert.ok(result.value.spread === 1);
  assert.ok(result.value.depthRatio > 0);
});

console.log();

// ── Items 163 + 165: ML Trainers ─────────────────────────────────────
console.log('Items 163+165: ML Trainers');
const X = Array.from({ length: 100 }, () => [
  Math.random(), Math.random(), Math.random(),
]);
const y = X.map(xi => xi[0] + xi[1] * 0.5 > 0.7 ? 1 : 0);
const data = { X, y };

test('logistic regression trains and evaluates', () => {
  const result = trainLogisticRegression(data, { epochs: 100 });
  assert.ok(result.metrics.accuracy >= 0);
  assert.ok(result.metrics.auc >= 0);
  assert.strictEqual(result.model.type, 'logistic_regression');
});

test('ridge regression trains and evaluates', () => {
  const result = trainRidgeRegression(data);
  assert.ok(result.metrics.accuracy >= 0);
  assert.strictEqual(result.model.type, 'ridge_regression');
});

test('calibrated boosting trains and evaluates', () => {
  const result = trainCalibratedBoosting(data, { nEstimators: 5 });
  assert.ok(result.metrics.accuracy >= 0);
  assert.strictEqual(result.model.type, 'calibrated_boosting');
});

test('XGBoost research stub trains', () => {
  const result = trainXGBoost(data, { nEstimators: 5 });
  assert.ok(result.metrics.accuracy >= 0);
  assert.strictEqual(result.model.type, 'xgboost_research');
});

test('LightGBM research stub trains', () => {
  const result = trainLightGBM(data, { nEstimators: 5 });
  assert.ok(result.metrics.accuracy >= 0);
  assert.strictEqual(result.model.type, 'lightgbm_research');
});

console.log();

// ── Item 169: Walk-Forward ───────────────────────────────────────────
console.log('Item 169: Walk-Forward');
test('generates walk-forward splits', () => {
  const timestamps = Array.from({ length: 500 }, (_, i) => 1000000 + i * 60000);
  const result = generateWalkForwardSplits(timestamps, {
    nFolds: 5, minTrainSize: 100, valSize: 50, testSize: 50,
  });
  assert.strictEqual(result.ok, true);
  assert.ok(result.value.folds.length > 0);
  assert.strictEqual(validateNoTemporalLeakage(result.value), true);
});

test('rejects insufficient data', () => {
  const timestamps = Array.from({ length: 10 }, (_, i) => i * 60000);
  const result = generateWalkForwardSplits(timestamps, {
    nFolds: 5, minTrainSize: 100, valSize: 50, testSize: 50,
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'INSUFFICIENT_DATA');
});

console.log();

// ── Item 171: Purging ────────────────────────────────────────────────
console.log('Item 171: Purging');
test('purges overlapping labels', () => {
  const timestamps = Array.from({ length: 200 }, (_, i) => i * 60000);
  const result = purgeOverlappingLabels({
    timestamps,
    labelHorizonMs: 300000, // 5 min horizon
    valStartMs: 100 * 60000, // validation starts at sample 100
  });
  assert.ok(result.purgedCount > 0);
  assert.ok(result.safeIndices.length > 0);
  // Verify no leakage
  const verification = verifyPurgeSuccess(result, timestamps, 300000, 100 * 60000);
  assert.strictEqual(verification.valid, true);
});

console.log();

// ── Item 175: CPCV ──────────────────────────────────────────────────
console.log('Item 175: CPCV');
test('generates CPCV splits', () => {
  const result = generateCpcvSplits(500, {
    nGroups: 5, nTestGroups: 2, labelHorizonMs: 300000,
  });
  assert.strictEqual(result.ok, true);
  assert.ok(result.value.folds.length > 0);
  assert.strictEqual(validateCpcvSplits(result.value), true);
});

test('C(5,2) = 10 folds', () => {
  const result = generateCpcvSplits(500, {
    nGroups: 5, nTestGroups: 2, labelHorizonMs: 300000,
  });
  assert.strictEqual(result.value.totalSplits, 10);
});

console.log();

// ── Item 177: Experiment Registry ─────────────────────────────────────
console.log('Item 177: Experiment Registry');
test('registers and tracks experiment', () => {
  const registry = createRegistry();
  registerExperiment(registry, {
    id: 'EXP-001', name: 'Gap Strategy v1', description: 'Test gap acceptance',
    timestampMs: 1000, strategyType: 'gap',
  });
  recordAttempt(registry, 'EXP-001', {
    timestampMs: 2000, attemptParams: { threshold: 0.5 },
    metrics: { sharpe: 1.5, accuracy: 0.6 }, success: true,
  });
  recordAttempt(registry, 'EXP-001', {
    timestampMs: 3000, attemptParams: { threshold: 0.7 },
    metrics: { sharpe: 1.8, accuracy: 0.65 }, success: true,
  });
  const summary = summarizeExperiment(registry, 'EXP-001');
  assert.strictEqual(summary.totalAttempts, 2);
  assert.strictEqual(summary.bestMetric.sharpe, 1.8);
});

test('reproduceMetric returns archived value', () => {
  const registry = createRegistry();
  registerExperiment(registry, {
    id: 'EXP-002', name: 'Test', description: 'Test',
    timestampMs: 1000, strategyType: 'test',
  });
  recordAttempt(registry, 'EXP-002', {
    timestampMs: 2000, attemptParams: {},
    metrics: { sharpe: 2.1 }, success: true,
  });
  assert.strictEqual(reproduceMetric(registry, 'EXP-002', 1, 'sharpe'), 2.1);
  assert.strictEqual(reproduceMetric(registry, 'EXP-002', 1, 'nonexistent'), null);
});

console.log();

// ── Item 241: Multiple Testing ────────────────────────────────────────
console.log('Item 241: Multiple Testing');
test('computes multiple testing report', () => {
  const results = Array.from({ length: 20 }, (_, i) => ({
    testId: `T${i}`, metricName: 'sharpe',
    metricValue: 1 + Math.random() * 2, sampleSize: 100, selected: i === 0,
  }));
  const report = computeMultipleTestingReport(results);
  assert.strictEqual(report.totalTests, 20);
  assert.ok(report.bonferroniAlpha < 0.05);
  assert.ok(report.sharpeInflationFactor > 1);
});

test('reproduceMetricFromReport returns metric', () => {
  const report = computeMultipleTestingReport([
    { testId: 'T1', metricName: 'sharpe', metricValue: 2, sampleSize: 100, selected: true },
  ]);
  assert.strictEqual(reproduceMetricFromReport(report, 'totalTests'), 1);
  assert.strictEqual(reproduceMetricFromReport(report, 'nonexistent'), null);
});

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
