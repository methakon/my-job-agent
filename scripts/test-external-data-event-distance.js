#!/usr/bin/env node
/**
 * Test script for Event Distance (Item 290)
 * Run: node scripts/test-external-data-event-distance.js
 */
'use strict';

const assert = require('node:assert/strict');

const {
  createEventDistanceAdapter,
  computeEventDistances,
} = require('../dist/trading/external-data/event-distance');

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

console.log('=== Event Distance (Item 290) ===\n');

// --- Mock mode ---
console.log('Mock Mode:');
const adapter = createEventDistanceAdapter('mock');
test('adapter created', () => assert.equal(adapter.getMode(), 'mock'));

const result = adapter.compute();
test('entries returned', () => assert.ok(result.entries.length > 0));
test('each entry has type', () => {
  for (const e of result.entries) {
    assert.ok(e.type);
  }
});
test('hoursToNext is positive number or null', () => {
  for (const e of result.entries) {
    if (e.hoursToNext !== null) {
      assert.ok(e.hoursToNext > 0, `expected positive, got ${e.hoursToNext}`);
    }
  }
});
test('daysSinceLast is non-negative or null', () => {
  for (const e of result.entries) {
    if (e.daysSinceLast !== null) {
      assert.ok(e.daysSinceLast >= 0, `expected >= 0, got ${e.daysSinceLast}`);
    }
  }
});
test('proximityScore in [0, 1]', () => {
  assert.ok(result.proximityScore >= 0);
  assert.ok(result.proximityScore <= 1);
});
test('timestamp is recent', () => assert.ok(Date.now() - result.timestamp < 5000));

// --- Pure function with explicit calendar ---
console.log('\nPure Functions:');
test('computeEventDistances with empty calendar', () => {
  const cal = { events: [], asOf: 0, source: 'test' };
  const r = computeEventDistances(cal, Date.now());
  assert.equal(r.entries.length, 0);
  assert.equal(r.proximityScore, 0);
});
test('computeEventDistances with single future event', () => {
  const now = Date.now();
  const cal = {
    events: [{
      id: 'test-1',
      type: 'RBI_POLICY',
      title: 'Test RBI',
      description: 'test',
      scheduledAt: now + 3600000, // +1 hour
      importance: 'HIGH',
      expectedImpact: 'UNKNOWN',
      affectedSymbols: [],
      source: 'test',
    }],
    asOf: now,
    source: 'test',
  };
  const r = computeEventDistances(cal, now);
  assert.equal(r.entries.length, 1);
  assert.equal(r.entries[0].hoursToNext, 1.0);
  assert.ok(r.entries[0].daysSinceLast === null);
  assert.equal(r.nextHighEvent?.id, 'test-1');
  assert.equal(r.hoursToHighEvent, 1.0);
});

// --- High importance ---
console.log('\nHigh Importance:');
const highEntries = adapter.computeHighImportance();
test('high importance filter works', () => {
  for (const e of highEntries) {
    assert.equal(e.importance, 'HIGH');
  }
});

// --- Disabled mode ---
console.log('\nDisabled Mode:');
const disabled = createEventDistanceAdapter('disabled');
test('disabled returns empty', () => {
  const r = disabled.compute();
  assert.equal(r.entries.length, 0);
  assert.equal(r.proximityScore, 0);
});

adapter.dispose();
disabled.dispose();

console.log(`\n=== ${passed}/${total} passed ===`);
process.exit(passed === total ? 0 : 1);
