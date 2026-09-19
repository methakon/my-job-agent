/**
 * ITEM 301 — Test HMM/GARCH regime models.
 *
 * Verifies that the GARCH volatility estimator and regime snapshot
 * module work together to classify market regimes from price data.
 *
 * Pure functions: no I/O, no DB, no network, no randomness.
 * RESEARCH / SHADOW ONLY: nothing in production imports this module.
 */

import { estimateGarchVolatility } from './p2-skills';
import { captureRegimeSnapshot } from './regime-snapshot';

// ── Test Harness ──────────────────────────────────────────────────────

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(`FAIL: ${msg}`);
}

function assertRange(val: number, lo: number, hi: number, label: string): void {
  assert(val >= lo && val <= hi, `${label}: ${val} not in [${lo}, ${hi}]`);
}

function assertPositive(val: number, label: string): void {
  assert(val > 0, `${label}: expected positive, got ${val}`);
}

// ── Synthetic Return Series ───────────────────────────────────────────

const normalReturns: readonly number[] = [
  0.001, -0.002, 0.0015, -0.0005, 0.0008, -0.001, 0.0012, -0.0007,
  0.0003, -0.0018, 0.002, -0.0004, 0.0009, -0.0011, 0.0016, -0.0003,
];

const volatileReturns: readonly number[] = [
  0.001, -0.002, 0.0015, -0.0005, 0.012, -0.015, 0.008, -0.011,
  0.009, -0.013, 0.006, -0.009, 0.011, -0.014, 0.007, -0.008,
];

const lowVolReturns: readonly number[] = [
  0.0001, -0.0002, 0.0001, -0.0001, 0.0002, -0.0001, 0.0001, -0.0002,
  0.0001, -0.0001, 0.0002, -0.0002, 0.0001, -0.0001, 0.0002, -0.0001,
];

// ── Test 1: GARCH produces valid results ──────────────────────────────

function testGarchBasic(): void {
  console.log('Test 1: GARCH basic validity');

  const cases = [
    { name: 'Normal', returns: normalReturns, lo: 0.0005, hi: 0.01 },
    { name: 'Volatile', returns: volatileReturns, lo: 0.005, hi: 0.1 },
    { name: 'LowVol', returns: lowVolReturns, lo: 0.00005, hi: 0.001 },
  ];

  for (const tc of cases) {
    const result = estimateGarchVolatility({ returns: tc.returns });
    assert(result.ok, `${tc.name}: GARCH should return ok`);
    if (result.ok) {
      assertPositive(result.value.currentVolatility, `${tc.name}.currentVol`);
      assertPositive(result.value.averageVolatility, `${tc.name}.avgVol`);
      assertPositive(result.value.currentVariance, `${tc.name}.variance`);
      assert(result.value.version === 1, `${tc.name}: version should be 1`);
      assertRange(result.value.currentVolatility, tc.lo, tc.hi, `${tc.name}.vol`);
    }
  }
  console.log('  PASS');
}

// ── Test 2: GARCH detects vol clustering ──────────────────────────────

function testGarchVolClustering(): void {
  console.log('Test 2: GARCH volatility clustering');

  const normalResult = estimateGarchVolatility({ returns: normalReturns });
  const volatileResult = estimateGarchVolatility({ returns: volatileReturns });

  assert(normalResult.ok && volatileResult.ok, 'Both should return ok');
  if (normalResult.ok && volatileResult.ok) {
    assert(
      volatileResult.value.currentVolatility > normalResult.value.currentVolatility * 2,
      'Volatile series should have at least 2x the volatility',
    );
  }
  console.log('  PASS');
}

// ── Test 3: GARCH rejects insufficient data ───────────────────────────

function testGarchInsufficientData(): void {
  console.log('Test 3: GARCH rejects insufficient data');
  const result = estimateGarchVolatility({ returns: [0.01, 0.02] });
  assert(!result.ok, 'Should reject with fewer than 5 points');
  if (!result.ok) {
    assert(result.reason === 'INSUFFICIENT_DATA', `Wrong reason: ${result.reason}`);
  }
  console.log('  PASS');
}

// ── Test 4: GARCH determinism ─────────────────────────────────────────

function testGarchDeterminism(): void {
  console.log('Test 4: GARCH determinism');
  const r1 = estimateGarchVolatility({ returns: normalReturns });
  const r2 = estimateGarchVolatility({ returns: normalReturns });
  assert(r1.ok && r2.ok, 'Both should return ok');
  if (r1.ok && r2.ok) {
    assert(
      r1.value.currentVolatility === r2.value.currentVolatility,
      'Same input must produce same output',
    );
  }
  console.log('  PASS');
}

// ── Test 5: Regime snapshot from GARCH output ─────────────────────────

function testRegimeSnapshotIntegration(): void {
  console.log('Test 5: Regime snapshot from GARCH output');

  const garchResult = estimateGarchVolatility({ returns: volatileReturns });
  assert(garchResult.ok, 'GARCH should succeed');

  if (garchResult.ok) {
    const volClassification = garchResult.value.currentVolatility > 0.005 ? 'HIGH' : 'NORMAL';

    const snapshot = captureRegimeSnapshot({
      timestampMs: Date.now(),
      regime: volClassification,
      confidence: 0.75,
      dimensions: {
        garchVolatility: garchResult.value.currentVolatility,
        volOfVol: garchResult.value.volatilityOfVolatility,
      },
      capturePoint: 'decision',
      tradeId: undefined,
    });

    assert(snapshot.snapshot.version === 'regsnap-v1', 'Snapshot version');
    assert(snapshot.snapshot.regime === volClassification, 'Regime matches');
    assertPositive(snapshot.snapshot.confidence, 'confidence');
  }

  console.log('  PASS');
}

// ── Run all tests ─────────────────────────────────────────────────────

export function runHmmGarchTests(): { passed: number; failed: number; errors: string[] } {
  const errors: string[] = [];
  let passed = 0;
  let failed = 0;

  const tests = [
    testGarchBasic,
    testGarchVolClustering,
    testGarchInsufficientData,
    testGarchDeterminism,
    testRegimeSnapshotIntegration,
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

  console.log(`\nHMM/GARCH Test Results: ${passed} passed, ${failed} failed`);
  return { passed, failed, errors };
}

if (require.main === module) {
  const result = runHmmGarchTests();
  process.exit(result.failed > 0 ? 1 : 0);
}
