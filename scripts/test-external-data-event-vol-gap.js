#!/usr/bin/env node
/**
 * Test script for Event Volatility Gap (Item 293)
 * Run: node scripts/test-external-data-event-vol-gap.js
 */
'use strict';

const assert = require('node:assert/strict');

const {
  createEventVolGapAdapter,
  computeExpectedGap,
  classifyGapRisk,
  suggestStrikeBuffer,
  computeEventVolGaps,
} = require('../dist/trading/external-data/event-vol-gap');

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

console.log('=== Event Volatility Gap (Item 293) ===\n');

// --- Pure functions ---
console.log('Pure Functions:');

test('computeExpectedGap: zero hours => 0', () => {
  assert.equal(computeExpectedGap(0, 1.2, 1.5), 0);
});
test('computeExpectedGap: zero ATR => 0', () => {
  assert.equal(computeExpectedGap(24, 0, 1.5), 0);
});
test('computeExpectedGap: positive values', () => {
  const gap = computeExpectedGap(48, 1.2, 1.5);
  assert.ok(gap > 0, `expected positive, got ${gap}`);
});
test('computeExpectedGap: higher ATR => larger gap', () => {
  const g1 = computeExpectedGap(48, 1.0, 1.5);
  const g2 = computeExpectedGap(48, 2.0, 1.5);
  assert.ok(g2 > g1);
});
test('computeExpectedGap: higher scalar => larger gap', () => {
  const g1 = computeExpectedGap(48, 1.2, 1.0);
  const g2 = computeExpectedGap(48, 1.2, 2.0);
  assert.ok(g2 > g1);
});

test('classifyGapRisk: LOW for small gap', () => assert.equal(classifyGapRisk(0.1), 'LOW'));
test('classifyGapRisk: MEDIUM', () => assert.equal(classifyGapRisk(0.3), 'MEDIUM'));
test('classifyGapRisk: HIGH', () => assert.equal(classifyGapRisk(0.7), 'HIGH'));
test('classifyGapRisk: EXTREME for large gap', () => assert.equal(classifyGapRisk(1.2), 'EXTREME'));

test('suggestStrikeBuffer: positive', () => {
  const buf = suggestStrikeBuffer(0.5, 24500);
  assert.ok(buf > 0);
});
test('suggestStrikeBuffer: scales with underlying', () => {
  const buf1 = suggestStrikeBuffer(0.5, 10000);
  const buf2 = suggestStrikeBuffer(0.5, 30000);
  assert.ok(buf2 > buf1);
});

// --- Adapter mock mode ---
console.log('\nMock Mode:');
const adapter = createEventVolGapAdapter('mock');
test('adapter created', () => assert.equal(adapter.getMode(), 'mock'));

const volResult = adapter.compute(1.2, 24500);
test('entries returned', () => assert.ok(volResult.entries.length > 0));
test('each entry has all fields', () => {
  const e = volResult.entries[0];
  assert.ok(e.eventType);
  assert.ok(e.event);
  assert.ok(e.hoursToEvent > 0);
  assert.ok(e.historicalATR > 0);
  assert.ok(e.eventVolScalar > 0);
  assert.ok(e.expectedGapPct >= 0);
  assert.ok(e.expectedGapPoints >= 0);
  assert.ok(['LOW', 'MEDIUM', 'HIGH', 'EXTREME'].includes(e.riskLevel));
  assert.ok(e.strikeSuggestion >= 0);
});
test('maxExpectedGap >= 0', () => assert.ok(volResult.maxExpectedGap >= 0));
test('aggregateRisk in [0, 1]', () => {
  assert.ok(volResult.aggregateRisk >= 0);
  assert.ok(volResult.aggregateRisk <= 1);
});
test('entries sorted by gap descending', () => {
  for (let i = 1; i < volResult.entries.length; i++) {
    assert.ok(volResult.entries[i].expectedGapPct <= volResult.entries[i-1].expectedGapPct);
  }
});

// --- computeEventVolGaps pure function ---
console.log('\nPure Function: computeEventVolGaps');
test('empty distance => empty result', () => {
  const emptyDist = { entries: [], proximityScore: 0, nextHighEvent: null, hoursToHighEvent: null, timestamp: Date.now() };
  const r = computeEventVolGaps(emptyDist, 1.2, 24500);
  assert.equal(r.entries.length, 0);
  assert.equal(r.maxExpectedGap, 0);
});

// --- Disabled mode ---
console.log('\nDisabled Mode:');
const disabled = createEventVolGapAdapter('disabled');
test('disabled returns empty', () => {
  const r = disabled.compute();
  assert.equal(r.entries.length, 0);
  assert.equal(r.maxExpectedGap, 0);
});

adapter.dispose();
disabled.dispose();

console.log(`\n=== ${passed}/${total} passed ===`);
process.exit(passed === total ? 0 : 1);
