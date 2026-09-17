#!/usr/bin/env node
/**
 * FIX 3 — COMMON-STORE FALLBACK tests.
 * Tests all three source-selection cases:
 *   1. OWN fresh → OWN
 *   2. OWN stale/missing + COMMON fresh → COMMON
 *   3. OWN stale/missing + COMMON stale → NONE
 *
 * Run: node scripts/common-chain-fallback.test.js
 */
'use strict';

const { chainSourceDecision } = require('../dist/trading/upstox-live-paper/upstox-live-paper-common-chain');

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (!condition) {
    console.error(`  FAIL: ${message}`);
    failed++;
  } else {
    console.log(`  PASS: ${message}`);
    passed++;
  }
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    console.error(`  FAIL: ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    failed++;
  } else {
    console.log(`  PASS: ${label}`);
    passed++;
  }
}

// ─── Case 1: OWN fresh → OWN ────────────────────────────────────────────
console.log('\n=== Case 1: OWN fresh → OWN ===');
{
  const now = Date.now();
  const result = chainSourceDecision({
    ownRows: 10,
    ownNewestTsMs: now - 5_000,   // 5 seconds old
    commonRows: 20,
    nowMs: now,
    maxAgeMs: 60_000,             // 60s freshness threshold
  });
  assertEqual(result.source, 'OWN', 'source is OWN');
  assertEqual(result.reason, 'OWN_FRESH', 'reason is OWN_FRESH');
  assert(result.ownAgeMs <= 60_000, 'ownAgeMs within threshold');
}

// ─── Case 2: OWN stale + COMMON fresh → COMMON ──────────────────────────
console.log('\n=== Case 2: OWN stale + COMMON fresh → COMMON ===');
{
  const now = Date.now();
  const result = chainSourceDecision({
    ownRows: 5,
    ownNewestTsMs: now - 120_000,  // 2 minutes old (stale)
    commonRows: 15,
    nowMs: now,
    maxAgeMs: 60_000,
  });
  assertEqual(result.source, 'COMMON', 'source is COMMON');
  assertEqual(result.reason, 'OWN_STALE_COMMON_FRESH', 'reason is OWN_STALE_COMMON_FRESH');
  assert(result.ownAgeMs > 60_000, 'ownAgeMs exceeds threshold');
}

// ─── Case 2b: OWN missing (0 rows) + COMMON fresh → COMMON ─────────────
console.log('\n=== Case 2b: OWN missing + COMMON fresh → COMMON ===');
{
  const now = Date.now();
  const result = chainSourceDecision({
    ownRows: 0,
    ownNewestTsMs: null,
    commonRows: 10,
    nowMs: now,
    maxAgeMs: 60_000,
  });
  assertEqual(result.source, 'COMMON', 'source is COMMON');
  assertEqual(result.reason, 'OWN_EMPTY_COMMON_FRESH', 'reason is OWN_EMPTY_COMMON_FRESH');
}

// ─── Case 3: OWN stale + COMMON stale → NONE ────────────────────────────
console.log('\n=== Case 3: OWN stale + COMMON stale → NONE ===');
{
  const now = Date.now();
  const result = chainSourceDecision({
    ownRows: 5,
    ownNewestTsMs: now - 120_000,  // stale
    commonRows: 0,                  // no common rows
    nowMs: now,
    maxAgeMs: 60_000,
  });
  assertEqual(result.source, 'NONE', 'source is NONE');
  assertEqual(result.reason, 'OWN_STALE_NO_COMMON', 'reason is OWN_STALE_NO_COMMON');
}

// ─── Case 3b: OWN missing + COMMON stale → NONE ─────────────────────────
console.log('\n=== Case 3b: OWN missing + COMMON stale → NONE ===');
{
  const now = Date.now();
  const result = chainSourceDecision({
    ownRows: 0,
    ownNewestTsMs: null,
    commonRows: 0,
    nowMs: now,
    maxAgeMs: 60_000,
  });
  assertEqual(result.source, 'NONE', 'source is NONE');
  assertEqual(result.reason, 'OWN_EMPTY_NO_COMMON', 'reason is OWN_EMPTY_NO_COMMON');
}

// ─── Summary ─────────────────────────────────────────────────────────────
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
