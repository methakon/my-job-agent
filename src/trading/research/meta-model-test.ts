/**
 * ITEM 313 — Test meta-model ensemble.
 *
 * Verifies that a meta-model can combine predictions from multiple
 * research skills (GARCH, Kalman, Hawkes, DeepLOB) into a composite
 * signal with confidence weighting.
 *
 * Pure functions: no I/O, no DB, no network, no randomness.
 * RESEARCH / SHADOW ONLY: nothing in production imports this module.
 */

import {
  estimateGarchVolatility,
  kalmanFilter,
  estimateHawkesIntensity,
  extractDeepLobFeatures,
  type OrderBookSnapshot,
} from './p2-skills';

// ── Types ─────────────────────────────────────────────────────────────

export interface ModelSignal {
  readonly model: string;
  readonly signal: number;  // -1 (bearish) to +1 (bullish)
  readonly confidence: number; // 0 to 1
}

export interface MetaModelResult {
  readonly compositeSignal: number;
  readonly compositeConfidence: number;
  readonly modelSignals: readonly ModelSignal[];
  readonly agreementRatio: number;
}

// ── Meta-Model Implementation ─────────────────────────────────────────

/**
 * Combine multiple model signals into a confidence-weighted composite.
 *
 * Agreement ratio: fraction of models pointing in the same direction
 * as the weighted composite.
 */
function combineSignals(signals: readonly ModelSignal[]): MetaModelResult | null {
  if (signals.length === 0) return null;

  // Confidence-weighted average
  let weightedSum = 0;
  let totalConfidence = 0;
  for (const s of signals) {
    weightedSum += s.signal * s.confidence;
    totalConfidence += s.confidence;
  }

  const compositeSignal = totalConfidence > 0 ? weightedSum / totalConfidence : 0;
  const compositeConfidence = totalConfidence / signals.length;

  // Agreement: how many models agree with the composite direction
  const compositeDir = compositeSignal > 0.01 ? 1 : compositeSignal < -0.01 ? -1 : 0;
  const agreeCount = signals.filter(s => {
    const sDir = s.signal > 0.01 ? 1 : s.signal < -0.01 ? -1 : 0;
    return sDir === compositeDir || sDir === 0;
  }).length;

  return {
    compositeSignal,
    compositeConfidence,
    modelSignals: signals,
    agreementRatio: agreeCount / signals.length,
  };
}

// ── Test Harness ──────────────────────────────────────────────────────

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(`FAIL: ${msg}`);
}

function assertRange(val: number, lo: number, hi: number, label: string): void {
  assert(val >= lo && val <= hi, `${label}: ${val} not in [${lo}, ${hi}]`);
}

// ── Test 1: Combine unanimous signals ─────────────────────────────────

function testUnanimousSignals(): void {
  console.log('Test 1: Unanimous bullish signals');
  const signals: ModelSignal[] = [
    { model: 'GARCH', signal: 0.8, confidence: 0.9 },
    { model: 'Kalman', signal: 0.7, confidence: 0.85 },
    { model: 'Hawkes', signal: 0.6, confidence: 0.7 },
    { model: 'DeepLOB', signal: 0.9, confidence: 0.8 },
  ];

  const result = combineSignals(signals);
  assert(result !== null, 'Result should not be null');
  if (result) {
    assert(result.compositeSignal > 0, 'Composite should be bullish');
    assertRange(result.compositeSignal, 0, 1, 'compositeSignal');
    assertRange(result.compositeConfidence, 0, 1, 'compositeConfidence');
    assert(result.agreementRatio === 1.0, 'All models agree');
  }
  console.log('  PASS');
}

// ── Test 2: Conflicting signals ───────────────────────────────────────

function testConflictingSignals(): void {
  console.log('Test 2: Conflicting signals');
  const signals: ModelSignal[] = [
    { model: 'GARCH', signal: 0.8, confidence: 0.9 },
    { model: 'Kalman', signal: -0.7, confidence: 0.85 },
    { model: 'Hawkes', signal: 0.3, confidence: 0.5 },
    { model: 'DeepLOB', signal: -0.6, confidence: 0.7 },
  ];

  const result = combineSignals(signals);
  assert(result !== null, 'Result should not be null');
  if (result) {
    // Weighted composite should lean toward high-confidence models
    assertRange(result.agreementRatio, 0, 1, 'agreementRatio');
    // With 4 models split 2-2, agreement should be low
    assert(result.agreementRatio < 1.0, 'Not all agree');
  }
  console.log('  PASS');
}

// ── Test 3: Empty signals ─────────────────────────────────────────────

function testEmptySignals(): void {
  console.log('Test 3: Empty signals returns null');
  const result = combineSignals([]);
  assert(result === null, 'Empty signals should return null');
  console.log('  PASS');
}

// ── Test 4: Single signal ─────────────────────────────────────────────

function testSingleSignal(): void {
  console.log('Test 4: Single signal passthrough');
  const signals: ModelSignal[] = [
    { model: 'GARCH', signal: 0.5, confidence: 0.8 },
  ];

  const result = combineSignals(signals);
  assert(result !== null, 'Result should not be null');
  if (result) {
    assert(result.compositeSignal === 0.5, 'Should equal the single signal');
    assert(result.compositeConfidence === 0.8, 'Should equal the single confidence');
    assert(result.agreementRatio === 1.0, 'Single model always agrees');
  }
  console.log('  PASS');
}

// ── Test 5: Integration with actual P2 skills ────────────────────────

function testIntegrationWithSkills(): void {
  console.log('Test 5: Integration with P2 skills');

  // Generate signals from actual skills
  const returns = Array.from({ length: 30 }, (_, i) => 0.001 * Math.sin(i * 0.5));
  const garchResult = estimateGarchVolatility({ returns });
  const kalmanResult = kalmanFilter({ observations: returns.map((_, i) => 100 + i * 0.1 + returns[i] * 10) });

  const events = Array.from({ length: 30 }, (_, i) => 1000000 + i * 500);
  const hawkesResult = estimateHawkesIntensity({ eventTimesMs: events });

  const book: OrderBookSnapshot = {
    bidPrices: [100, 99.5],
    bidVolumes: [200, 100],
    askPrices: [100.5, 101],
    askVolumes: [100, 100],
  };
  const deeplobResult = extractDeepLobFeatures(book);

  // Convert to ModelSignals (only successful ones)
  const signals: ModelSignal[] = [];
  if (garchResult.ok) {
    // High vol → slight bearish (risk-off)
    const volSignal = garchResult.value.currentVolatility > 0.005 ? -0.3 : 0.3;
    signals.push({ model: 'GARCH', signal: volSignal, confidence: 0.7 });
  }
  if (kalmanResult.ok) {
    const trendSignal = Math.max(-1, Math.min(1, kalmanResult.value.velocity * 10));
    signals.push({ model: 'Kalman', signal: trendSignal, confidence: 0.8 });
  }
  if (hawkesResult.ok) {
    const hawkSignal = hawkesResult.value.isSelfExciting ? 0.5 : 0.0;
    signals.push({ model: 'Hawkes', signal: hawkSignal, confidence: 0.6 });
  }
  if (deeplobResult.ok) {
    const lobSignal = Math.max(-1, Math.min(1, deeplobResult.value.volumeImbalance * 2));
    signals.push({ model: 'DeepLOB', signal: lobSignal, confidence: 0.75 });
  }

  const result = combineSignals(signals);
  assert(result !== null, 'Result should not be null');
  if (result) {
    assertRange(result.compositeSignal, -1, 1, 'compositeSignal');
    assertRange(result.compositeConfidence, 0, 1, 'compositeConfidence');
    assert(result.modelSignals.length >= 3, 'At least 3 models should succeed');
  }
  console.log('  PASS');
}

// ── Test 6: Determinism ───────────────────────────────────────────────

function testMetaModelDeterminism(): void {
  console.log('Test 6: Meta-model determinism');
  const signals: ModelSignal[] = [
    { model: 'A', signal: 0.5, confidence: 0.8 },
    { model: 'B', signal: -0.3, confidence: 0.6 },
  ];
  const r1 = combineSignals(signals);
  const r2 = combineSignals(signals);
  assert(r1 !== null && r2 !== null, 'Both should return results');
  if (r1 && r2) {
    assert(r1.compositeSignal === r2.compositeSignal, 'Composite deterministic');
    assert(r1.agreementRatio === r2.agreementRatio, 'Agreement deterministic');
  }
  console.log('  PASS');
}

// ── Run all tests ─────────────────────────────────────────────────────

export function runMetaModelTests(): { passed: number; failed: number; errors: string[] } {
  const errors: string[] = [];
  let passed = 0;
  let failed = 0;

  const tests = [
    testUnanimousSignals,
    testConflictingSignals,
    testEmptySignals,
    testSingleSignal,
    testIntegrationWithSkills,
    testMetaModelDeterminism,
  ];

  for (const test of tests) {
    try {
      test();
      passed++;
    } catch (e) {
      failed++;
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }

  console.log(`\nMeta-Model Test Results: ${passed} passed, ${failed} failed`);
  return { passed, failed, errors };
}

if (require.main === module) {
  const result = runMetaModelTests();
  process.exit(result.failed > 0 ? 1 : 0);
}
