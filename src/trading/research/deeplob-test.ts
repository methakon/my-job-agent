/**
 * ITEM 310 — Test DeepLOB feature extraction.
 *
 * Verifies that the DeepLOB-inspired order book feature extraction
 * correctly computes micro-price, spread, volume imbalance, and depth.
 *
 * Pure functions: no I/O, no DB, no network, no randomness.
 * RESEARCH / SHADOW ONLY: nothing in production imports this module.
 */

import { extractDeepLobFeatures, type OrderBookSnapshot } from './p2-skills';

// ── Test Harness ──────────────────────────────────────────────────────

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(`FAIL: ${msg}`);
}

function assertClose(a: number, b: number, tol: number, label: string): void {
  assert(Math.abs(a - b) < tol, `${label}: |${a} - ${b}| >= ${tol}`);
}

function assertPositive(val: number, label: string): void {
  assert(val > 0, `${label}: expected positive, got ${val}`);
}

// ── Synthetic Order Books ─────────────────────────────────────────────

/** Balanced order book: equal bid/ask volume. */
const balancedBook: OrderBookSnapshot = {
  bidPrices: [100, 99.5, 99],
  bidVolumes: [100, 100, 100],
  askPrices: [100.5, 101, 101.5],
  askVolumes: [100, 100, 100],
};

/** Bid-heavy order book: more volume on bid side. */
const bidHeavyBook: OrderBookSnapshot = {
  bidPrices: [100, 99.5, 99],
  bidVolumes: [300, 200, 150],
  askPrices: [100.5, 101, 101.5],
  askVolumes: [50, 50, 50],
};

/** Ask-heavy order book: more volume on ask side. */
const askHeavyBook: OrderBookSnapshot = {
  bidPrices: [100, 99.5, 99],
  bidVolumes: [30, 30, 30],
  askPrices: [100.5, 101, 101.5],
  askVolumes: [200, 150, 100],
};

/** Thin order book: single level. */
const thinBook: OrderBookSnapshot = {
  bidPrices: [100],
  bidVolumes: [10],
  askPrices: [100.1],
  askVolumes: [10],
};

// ── Test 1: Balanced book ─────────────────────────────────────────────

function testDeepLobBalanced(): void {
  console.log('Test 1: DeepLOB balanced book');
  const result = extractDeepLobFeatures(balancedBook);
  assert(result.ok, 'Should succeed');
  if (result.ok) {
    assertClose(result.value.midPrice, 100.25, 0.001, 'midPrice');
    assertClose(result.value.spread, 0.5, 0.001, 'spread');
    assertClose(result.value.microPrice, 100.25, 0.001, 'microPrice');
    assertClose(result.value.volumeImbalance, 0, 0.01, 'volumeImbalance');
    assertClose(result.value.depthRatio, 1.0, 0.001, 'depthRatio');
    assert(result.value.levels === 3, 'levels');
  }
  console.log('  PASS');
}

// ── Test 2: Bid-heavy book ────────────────────────────────────────────

function testDeepLobBidHeavy(): void {
  console.log('Test 2: DeepLOB bid-heavy book');
  const result = extractDeepLobFeatures(bidHeavyBook);
  assert(result.ok, 'Should succeed');
  if (result.ok) {
    // Micro-price should be pulled toward bid (more volume on bid)
    assert(result.value.microPrice < result.value.midPrice, 'microPrice pulled toward bid');
    assert(result.value.volumeImbalance > 0, 'Positive imbalance (bid heavy)');
    assertPositive(result.value.bidDepth, 'bidDepth');
    assertPositive(result.value.askDepth, 'askDepth');
    assert(result.value.depthRatio > 1, 'depthRatio > 1 for bid-heavy');
  }
  console.log('  PASS');
}

// ── Test 3: Ask-heavy book ────────────────────────────────────────────

function testDeepLobAskHeavy(): void {
  console.log('Test 3: DeepLOB ask-heavy book');
  const result = extractDeepLobFeatures(askHeavyBook);
  assert(result.ok, 'Should succeed');
  if (result.ok) {
    // Micro-price should be pulled toward ask
    assert(result.value.microPrice > result.value.midPrice, 'microPrice pulled toward ask');
    assert(result.value.volumeImbalance < 0, 'Negative imbalance (ask heavy)');
    assert(result.value.depthRatio < 1, 'depthRatio < 1 for ask-heavy');
  }
  console.log('  PASS');
}

// ── Test 4: Thin book ─────────────────────────────────────────────────

function testDeepLobThinBook(): void {
  console.log('Test 4: DeepLOB thin book');
  const result = extractDeepLobFeatures(thinBook);
  assert(result.ok, 'Should succeed');
  if (result.ok) {
    assert(result.value.levels === 1, 'Single level');
    assertClose(result.value.spread, 0.1, 0.001, 'spread');
    assertClose(result.value.microPrice, 100.05, 0.001, 'microPrice');
  }
  console.log('  PASS');
}

// ── Test 5: Empty book rejected ───────────────────────────────────────

function testDeepLobEmptyBook(): void {
  console.log('Test 5: DeepLOB empty book rejected');
  const emptyBook: OrderBookSnapshot = {
    bidPrices: [],
    bidVolumes: [],
    askPrices: [],
    askVolumes: [],
  };
  const result = extractDeepLobFeatures(emptyBook);
  assert(!result.ok, 'Should reject empty book');
  if (!result.ok) {
    assert(result.reason === 'EMPTY_BOOK', `Wrong reason: ${result.reason}`);
  }
  console.log('  PASS');
}

// ── Test 6: Determinism ───────────────────────────────────────────────

function testDeepLobDeterminism(): void {
  console.log('Test 6: DeepLOB determinism');
  const r1 = extractDeepLobFeatures(balancedBook);
  const r2 = extractDeepLobFeatures(balancedBook);
  assert(r1.ok && r2.ok, 'Both should succeed');
  if (r1.ok && r2.ok) {
    assert(r1.value.midPrice === r2.value.midPrice, 'midPrice deterministic');
    assert(r1.value.microPrice === r2.value.microPrice, 'microPrice deterministic');
    assert(r1.value.volumeImbalance === r2.value.volumeImbalance, 'imbalance deterministic');
  }
  console.log('  PASS');
}

// ── Test 7: Spread edge case (crossed book) ──────────────────────────

function testDeepLobCrossedBook(): void {
  console.log('Test 7: DeepLOB crossed book (bid > ask)');
  const crossedBook: OrderBookSnapshot = {
    bidPrices: [101, 100],
    bidVolumes: [50, 50],
    askPrices: [100.5, 101],
    askVolumes: [50, 50],
  };
  const result = extractDeepLobFeatures(crossedBook);
  assert(result.ok, 'Should handle crossed book');
  if (result.ok) {
    // Spread would be negative — that's fine for feature extraction
    assert(result.value.spread < 0, 'Negative spread for crossed book');
    assert(result.value.levels === 2, 'levels');
  }
  console.log('  PASS');
}

// ── Run all tests ─────────────────────────────────────────────────────

export function runDeepLobTests(): { passed: number; failed: number; errors: string[] } {
  const errors: string[] = [];
  let passed = 0;
  let failed = 0;

  const tests = [
    testDeepLobBalanced,
    testDeepLobBidHeavy,
    testDeepLobAskHeavy,
    testDeepLobThinBook,
    testDeepLobEmptyBook,
    testDeepLobDeterminism,
    testDeepLobCrossedBook,
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

  console.log(`\nDeepLOB Test Results: ${passed} passed, ${failed} failed`);
  return { passed, failed, errors };
}

if (require.main === module) {
  const result = runDeepLobTests();
  process.exit(result.failed > 0 ? 1 : 0);
}
