#!/usr/bin/env node
/**
 * Test script for Macro Features Adapter (Item 285)
 * Run: node scripts/test-external-data-macro.js
 */
'use strict';

const assert = require('node:assert/strict');

const {
  createMacroFeaturesAdapter,
  classifyRegime,
} = require('../dist/trading/external-data/macro-features');

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

console.log('=== Macro Features (Item 285) ===\n');

// --- Mock mode ---
console.log('Mock Mode:');
const adapter = createMacroFeaturesAdapter('mock');
test('adapter created', () => assert.equal(adapter.getMode(), 'mock'));

const features = adapter.fetch();
test('4 snapshots returned', () => assert.equal(features.snapshots.length, 4));
test('USDINR present', () => assert.ok(features.snapshots.find(s => s.symbol === 'USDINR')));
test('BRENT_CRUDE present', () => assert.ok(features.snapshots.find(s => s.symbol === 'BRENT_CRUDE')));
test('INDIA_10Y present', () => assert.ok(features.snapshots.find(s => s.symbol === 'INDIA_10Y')));
test('INDIA_VIX present', () => assert.ok(features.snapshots.find(s => s.symbol === 'INDIA_VIX')));
test('regime has all fields', () => assert.ok(features.regime.usdInrTrend));
test('compositeRisk in [-1, 1]', () => {
  assert.ok(features.regime.compositeRisk >= -1);
  assert.ok(features.regime.compositeRisk <= 1);
});
test('timestamp recent', () => assert.ok(Date.now() - features.timestamp < 5000));

// --- Pure function: classifyRegime ---
console.log('\nPure Functions:');
test('regime: high VIX => EXTREME', () => {
  const snaps = [
    { symbol: 'USDINR', changePct: 0 },
    { symbol: 'BRENT_CRUDE', changePct: 0 },
    { symbol: 'INDIA_10Y', changePct: 0 },
    { symbol: 'INDIA_VIX', value: 30 },
  ];
  const r = classifyRegime(snaps);
  assert.equal(r.vixRegime, 'EXTREME');
});
test('regime: low VIX => LOW', () => {
  const snaps = [
    { symbol: 'USDINR', changePct: 0 },
    { symbol: 'BRENT_CRUDE', changePct: 0 },
    { symbol: 'INDIA_10Y', changePct: 0 },
    { symbol: 'INDIA_VIX', value: 10 },
  ];
  const r = classifyRegime(snaps);
  assert.equal(r.vixRegime, 'LOW');
});
test('regime: crude up big => HEADWIND', () => {
  const snaps = [
    { symbol: 'USDINR', changePct: 0 },
    { symbol: 'BRENT_CRUDE', changePct: 1.0 },
    { symbol: 'INDIA_10Y', changePct: 0 },
    { symbol: 'INDIA_VIX', value: 14 },
  ];
  const r = classifyRegime(snaps);
  assert.equal(r.crudeImpact, 'HEADWIND');
});
test('regime: empty snaps => defaults', () => {
  const r = classifyRegime([]);
  assert.equal(r.usdInrTrend, 'STABLE');
  assert.equal(r.compositeRisk, 0);
});

// --- Disabled mode ---
console.log('\nDisabled Mode:');
const disabled = createMacroFeaturesAdapter('disabled');
test('disabled returns empty', () => {
  const f = disabled.fetch();
  assert.equal(f.snapshots.length, 0);
  assert.equal(f.timestamp, 0);
});

adapter.dispose();
disabled.dispose();

console.log(`\n=== ${passed}/${total} passed ===`);
process.exit(passed === total ? 0 : 1);
