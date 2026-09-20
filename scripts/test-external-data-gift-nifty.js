#!/usr/bin/env node
/**
 * Test script for Gift NIFTY Adapter (Item 282)
 * Verifies: mock mode, computation functions, health tracking, disabled mode.
 * Run: node scripts/test-external-data-gift-nifty.js
 */
'use strict';

const assert = require('node:assert/strict');

// Import from compiled dist (after npx tsc)
const {
  createGiftNiftyAdapter,
  computeGiftNiftyGap,
  computeBasis,
  computeCrossMarketAlignment,
} = require('../dist/trading/external-data/gift-nifty-features');

let passed = 0;
let total = 0;

function test(name, fn) {
  total++;
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}: ${e.message}`);
  }
}

console.log('=== Gift NIFTY Features (Item 282) ===\n');

// --- Mock mode ---
console.log('Mock Mode:');
const adapter = createGiftNiftyAdapter('mock');
test('adapter created', () => assert.equal(adapter.getMode(), 'mock'));

const features = adapter.fetchSnapshots(24500);
test('snapshots returned (4 symbols)', () => assert.equal(features.snapshots.length, 4));
test('gap signal has direction', () => assert.ok(['UP', 'DOWN', 'FLAT'].includes(features.gapSignal.gapDirection)));
test('impliedNiftyOpen is positive', () => assert.ok(features.gapSignal.impliedNiftyOpen > 0));
test('timestamp is recent', () => assert.ok(Date.now() - features.timestamp < 5000));
test('spreadVsNifty is computed', () => assert.equal(typeof features.spreadVsNifty, 'number'));
test('health shows mock', () => assert.equal(adapter.getHealth().mode, 'mock'));

// --- Pure functions ---
console.log('\nPure Functions:');
test('gap UP when LTP > prevClose', () => {
  const gap = computeGiftNiftyGap(25000, 24500);
  assert.equal(gap.gapDirection, 'UP');
  assert.ok(gap.gapPct > 0);
});
test('gap DOWN when LTP < prevClose', () => {
  const gap = computeGiftNiftyGap(24000, 24500);
  assert.equal(gap.gapDirection, 'DOWN');
  assert.ok(gap.gapPct < 0);
});
test('gap FLAT when diff < 0.05%', () => {
  const gap = computeGiftNiftyGap(24501, 24500);
  assert.equal(gap.gapDirection, 'FLAT');
});
test('basis = gift - nifty', () => {
  assert.equal(computeBasis(24600, 24500), 100);
});
test('cross-market alignment: all up => +1', () => {
  const snaps = [
    { changePct: 0.5 }, { changePct: 0.3 }, { changePct: 0.1 },
  ];
  assert.equal(computeCrossMarketAlignment(snaps), 1);
});
test('cross-market alignment: mixed => fractional', () => {
  const snaps = [
    { changePct: 0.5 }, { changePct: -0.3 },
  ];
  const a = computeCrossMarketAlignment(snaps);
  assert.ok(a > -1 && a < 1);
});

// --- Disabled mode ---
console.log('\nDisabled Mode:');
const disabled = createGiftNiftyAdapter('disabled');
test('disabled returns empty', () => {
  const f = disabled.fetchSnapshots();
  assert.equal(f.snapshots.length, 0);
  assert.equal(f.timestamp, 0);
});

adapter.dispose();
disabled.dispose();

console.log(`\n=== ${passed}/${total} passed ===`);
process.exit(passed === total ? 0 : 1);
