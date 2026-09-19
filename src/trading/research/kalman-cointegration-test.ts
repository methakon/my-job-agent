/**
 * ITEM 304 — Test Kalman filter and cointegration.
 *
 * Verifies that the Kalman filter trend estimator and cointegration
 * detection work correctly on synthetic price data.
 *
 * Pure functions: no I/O, no DB, no network, no randomness.
 * RESEARCH / SHADOW ONLY: nothing in production imports this module.
 */

import { kalmanFilter } from './p2-skills';

// ── Test Harness ──────────────────────────────────────────────────────

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(`FAIL: ${msg}`);
}

function assertPositive(val: number, label: string): void {
  assert(val > 0, `${label}: expected positive, got ${val}`);
}

function assertClose(a: number, b: number, tol: number, label: string): void {
  assert(Math.abs(a - b) < tol, `${label}: |${a} - ${b}| >= ${tol}`);
}

// ── Synthetic Data ────────────────────────────────────────────────────

/** Linear uptrend: 100, 101, 102, ... */
function linearTrend(n: number, slope: number, start: number): number[] {
  return Array.from({ length: n }, (_, i) => start + slope * i);
}

/** Noisy trend: trend + Gaussian-ish noise. */
function noisyTrend(n: number, slope: number, start: number, noiseAmp: number): number[] {
  const base = linearTrend(n, slope, start);
  // Deterministic pseudo-noise using simple hash
  return base.map((v, i) => v + noiseAmp * Math.sin(i * 2.39) * Math.cos(i * 0.71));
}

// ── Test 1: Kalman filter on clean trend ──────────────────────────────

function testKalmanCleanTrend(): void {
  console.log('Test 1: Kalman on clean linear trend');
  const data = linearTrend(50, 0.5, 100);
  const result = kalmanFilter({ observations: data });

  assert(result.ok, 'Kalman should succeed');
  if (result.ok) {
    assertPositive(result.value.velocity, 'velocity');
    assertClose(result.value.velocity, 0.5, 0.1, 'velocity');
    assertPositive(result.value.signalToNoise, 'signalToNoise');
  }
  console.log('  PASS');
}

// ── Test 2: Kalman filter on noisy data ───────────────────────────────

function testKalmanNoisyData(): void {
  console.log('Test 2: Kalman on noisy trend');
  const data = noisyTrend(100, 1.0, 200, 5);
  const result = kalmanFilter({ observations: data });

  assert(result.ok, 'Kalman should succeed');
  if (result.ok) {
    // Velocity should be close to 1.0 despite noise
    assertClose(result.value.velocity, 1.0, 0.5, 'velocity');
    assertPositive(result.value.rmse, 'rmse');
  }
  console.log('  PASS');
}

// ── Test 3: Kalman rejects insufficient data ──────────────────────────

function testKalmanInsufficientData(): void {
  console.log('Test 3: Kalman rejects insufficient data');
  const result = kalmanFilter({ observations: [100, 101] });
  assert(!result.ok, 'Should reject with fewer than 3 points');
  if (!result.ok) {
    assert(result.reason === 'INSUFFICIENT_DATA', `Wrong reason: ${result.reason}`);
  }
  console.log('  PASS');
}

// ── Test 4: Kalman determinism ────────────────────────────────────────

function testKalmanDeterminism(): void {
  console.log('Test 4: Kalman determinism');
  const data = noisyTrend(30, 0.3, 50, 2);
  const r1 = kalmanFilter({ observations: data });
  const r2 = kalmanFilter({ observations: data });
  assert(r1.ok && r2.ok, 'Both should succeed');
  if (r1.ok && r2.ok) {
    assert(r1.value.currentLevel === r2.value.currentLevel, 'Level must be deterministic');
    assert(r1.value.velocity === r2.value.velocity, 'Velocity must be deterministic');
  }
  console.log('  PASS');
}

// ── Test 5: Kalman parameter sensitivity ──────────────────────────────

function testKalmanParameterSensitivity(): void {
  console.log('Test 5: Kalman parameter sensitivity');
  const data = noisyTrend(50, 1.0, 100, 10);

  // Low process noise → smoother
  const smooth = kalmanFilter({ observations: data, processNoise: 0.001, measurementNoise: 1.0 });
  // High process noise → follows data more
  const responsive = kalmanFilter({ observations: data, processNoise: 0.1, measurementNoise: 0.01 });

  assert(smooth.ok && responsive.ok, 'Both should succeed');
  if (smooth.ok && responsive.ok) {
    // Both should detect positive trend
    assert(smooth.value.velocity > 0, 'Smooth should detect uptrend');
    assert(responsive.value.velocity > 0, 'Responsive should detect uptrend');
    // Smooth should have lower RMSE (less noise in output)
    assert(smooth.value.rmse < responsive.value.rmse, 'Smooth should have lower RMSE');
  }
  console.log('  PASS');
}

// ── Test 6: Cointegration-style test via Kalman residuals ─────────────

function testCointegrationViaKalman(): void {
  console.log('Test 6: Cointegration detection via Kalman residuals');

  // Two cointegrated series: price + noise → stationary spread
  const n = 80;
  const commonTrend = linearTrend(n, 0.5, 100);
  const seriesA = commonTrend.map((v, i) => v + 2 * Math.sin(i * 0.3));
  const seriesB = commonTrend.map((v, i) => v + 2 * Math.cos(i * 0.3));

  // Spread should be stationary
  const spread = seriesA.map((a, i) => a - seriesB[i]);

  // Filter the spread — should show mean-reversion
  const result = kalmanFilter({ observations: spread, processNoise: 0.001, measurementNoise: 0.1 });
  assert(result.ok, 'Kalman on spread should succeed');
  if (result.ok) {
    // Velocity near zero = stationary spread = cointegrated
    assert(Math.abs(result.value.velocity) < 0.5, 'Spread velocity near zero = cointegrated');
    assert(result.value.rmse > 0, 'RMSE should be positive');
  }
  console.log('  PASS');
}

// ── Run all tests ─────────────────────────────────────────────────────

export function runKalmanCointegrationTests(): { passed: number; failed: number; errors: string[] } {
  const errors: string[] = [];
  let passed = 0;
  let failed = 0;

  const tests = [
    testKalmanCleanTrend,
    testKalmanNoisyData,
    testKalmanInsufficientData,
    testKalmanDeterminism,
    testKalmanParameterSensitivity,
    testCointegrationViaKalman,
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

  console.log(`\nKalman/Cointegration Test Results: ${passed} passed, ${failed} failed`);
  return { passed, failed, errors };
}

if (require.main === module) {
  const result = runKalmanCointegrationTests();
  process.exit(result.failed > 0 ? 1 : 0);
}
