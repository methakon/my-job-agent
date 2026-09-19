/**
 * ITEM 307 — Test Hawkes intensity estimation.
 *
 * Verifies that the Hawkes process intensity estimator correctly
 * identifies self-exciting vs Poisson-like event patterns.
 *
 * Pure functions: no I/O, no DB, no network, no randomness.
 * RESEARCH / SHADOW ONLY: nothing in production imports this module.
 */

import { estimateHawkesIntensity } from './p2-skills';

// ── Test Harness ──────────────────────────────────────────────────────

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(`FAIL: ${msg}`);
}

function assertPositive(val: number, label: string): void {
  assert(val > 0, `${label}: expected positive, got ${val}`);
}

// ── Synthetic Event Series ────────────────────────────────────────────

/** Poisson-like: roughly uniform spacing. */
function poissonEvents(n: number, intervalMs: number): readonly number[] {
  const base = 1000000;
  return Array.from({ length: n }, (_, i) => base + i * intervalMs + (i % 3 === 0 ? 50 : 0));
}

/** Self-exciting: bursts of activity. */
function selfExcitingEvents(n: number): readonly number[] {
  const events: number[] = [];
  let t = 1000000;
  for (let i = 0; i < n; i++) {
    events.push(t);
    // After each event, next event is likely very soon (burst)
    t += i % 5 === 0 ? 5 : 200 + (i % 7) * 30;
  }
  return events;
}

// ── Test 1: Hawkes on Poisson-like data ───────────────────────────────

function testHawkesPoisson(): void {
  console.log('Test 1: Hawkes on Poisson-like events');
  const events = poissonEvents(50, 1000);
  const result = estimateHawkesIntensity({ eventTimesMs: events });

  assert(result.ok, 'Hawkes should succeed');
  if (result.ok) {
    assertPositive(result.value.baselineRate, 'baselineRate');
    assertPositive(result.value.alpha, 'alpha');
    assertPositive(result.value.beta, 'beta');
    // Poisson-like: branching ratio should be low
    assert(result.value.branchingRatio < 1.0, 'Poisson branching ratio < 1');
  }
  console.log('  PASS');
}

// ── Test 2: Hawkes on self-exciting data ──────────────────────────────

function testHawkesSelfExciting(): void {
  console.log('Test 2: Hawkes on self-exciting events');
  const events = selfExcitingEvents(60);
  const result = estimateHawkesIntensity({ eventTimesMs: events });

  assert(result.ok, 'Hawkes should succeed');
  if (result.ok) {
    assertPositive(result.value.branchingRatio, 'branchingRatio');
    // Self-exciting: branching ratio should be higher
    assert(result.value.currentIntensity > result.value.baselineRate, 'Intensity should exceed baseline');
  }
  console.log('  PASS');
}

// ── Test 3: Hawkes rejects insufficient data ──────────────────────────

function testHawkesInsufficientData(): void {
  console.log('Test 3: Hawkes rejects insufficient data');
  const result = estimateHawkesIntensity({ eventTimesMs: [1000, 2000, 3000] });
  assert(!result.ok, 'Should reject with fewer than 10 events');
  if (!result.ok) {
    assert(result.reason === 'INSUFFICIENT_DATA', `Wrong reason: ${result.reason}`);
  }
  console.log('  PASS');
}

// ── Test 4: Hawkes rejects zero duration ──────────────────────────────

function testHawkesZeroDuration(): void {
  console.log('Test 4: Hawkes rejects zero duration');
  const result = estimateHawkesIntensity({ eventTimesMs: new Array(20).fill(5000) });
  assert(!result.ok, 'Should reject zero-duration events');
  if (!result.ok) {
    assert(result.reason === 'ZERO_DURATION', `Wrong reason: ${result.reason}`);
  }
  console.log('  PASS');
}

// ── Test 5: Hawkes determinism ────────────────────────────────────────

function testHawkesDeterminism(): void {
  console.log('Test 5: Hawkes determinism');
  const events = poissonEvents(40, 800);
  const r1 = estimateHawkesIntensity({ eventTimesMs: events });
  const r2 = estimateHawkesIntensity({ eventTimesMs: events });
  assert(r1.ok && r2.ok, 'Both should succeed');
  if (r1.ok && r2.ok) {
    assert(r1.value.branchingRatio === r2.value.branchingRatio, 'Branching ratio deterministic');
    assert(r1.value.currentIntensity === r2.value.currentIntensity, 'Current intensity deterministic');
  }
  console.log('  PASS');
}

// ── Test 6: Hawkes branching ratio sensitivity ────────────────────────

function testHawkesBranchingThreshold(): void {
  console.log('Test 6: Hawkes branching threshold');
  const events = selfExcitingEvents(60);
  const result = estimateHawkesIntensity({
    eventTimesMs: events,
    branchingThreshold: 0.1, // low threshold
  });
  assert(result.ok, 'Hawkes should succeed');
  if (result.ok) {
    // Self-exciting data should exceed a low threshold
    assert(result.value.branchingRatio > 0.1, 'Should exceed low threshold');
  }
  console.log('  PASS');
}

// ── Test 7: Hawkes current intensity vs baseline ──────────────────────

function testHawkesIntensityDecay(): void {
  console.log('Test 7: Hawkes intensity decay');
  // Cluster at start, gap at end
  const events: number[] = [];
  for (let i = 0; i < 30; i++) events.push(1000000 + i * 10); // tight cluster
  for (let i = 0; i < 20; i++) events.push(1001000 + i * 500); // sparse

  const result = estimateHawkesIntensity({ eventTimesMs: events, decay: 0.005 });
  assert(result.ok, 'Hawkes should succeed');
  if (result.ok) {
    // Current intensity should be between baseline and peak
    assert(result.value.currentIntensity >= result.value.baselineRate, 'Current >= baseline');
  }
  console.log('  PASS');
}

// ── Run all tests ─────────────────────────────────────────────────────

export function runHawkesIntensityTests(): { passed: number; failed: number; errors: string[] } {
  const errors: string[] = [];
  let passed = 0;
  let failed = 0;

  const tests = [
    testHawkesPoisson,
    testHawkesSelfExciting,
    testHawkesInsufficientData,
    testHawkesZeroDuration,
    testHawkesDeterminism,
    testHawkesBranchingThreshold,
    testHawkesIntensityDecay,
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

  console.log(`\nHawkes Intensity Test Results: ${passed} passed, ${failed} failed`);
  return { passed, failed, errors };
}

if (require.main === module) {
  const result = runHawkesIntensityTests();
  process.exit(result.failed > 0 ? 1 : 0);
}
