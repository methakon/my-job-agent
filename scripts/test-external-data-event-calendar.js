#!/usr/bin/env node
/**
 * Test script for Event Calendar Adapter (Item 288)
 * Run: node scripts/test-external-data-event-calendar.js
 */
'use strict';

const assert = require('node:assert/strict');

const {
  createEventCalendarAdapter,
} = require('../dist/trading/external-data/event-calendar');

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

console.log('=== Event Calendar (Item 288) ===\n');

// --- Mock mode ---
console.log('Mock Mode:');
const adapter = createEventCalendarAdapter('mock');
test('adapter created', () => assert.equal(adapter.getMode(), 'mock'));

const calendar = adapter.fetchCalendar(Date.now());
test('calendar has events', () => assert.ok(calendar.events.length > 0));
test('events have required fields', () => {
  const e = calendar.events[0];
  assert.ok(e.id);
  assert.ok(e.type);
  assert.ok(e.title);
  assert.ok(e.scheduledAt > 0);
  assert.ok(['HIGH', 'MEDIUM', 'LOW'].includes(e.importance));
});
test('events span past and future', () => {
  const now = Date.now();
  const past = calendar.events.filter(e => e.scheduledAt < now);
  const future = calendar.events.filter(e => e.scheduledAt >= now);
  assert.ok(past.length > 0, 'has past events');
  assert.ok(future.length > 0, 'has future events');
});
test('events are sorted by time', () => {
  for (let i = 1; i < calendar.events.length; i++) {
    assert.ok(calendar.events[i].scheduledAt >= calendar.events[i-1].scheduledAt);
  }
});
test('calendar source is mock', () => assert.equal(calendar.source, 'mock'));

// --- Query methods ---
console.log('\nQuery Methods:');
const now = Date.now();
const dayMs = 86400000;
const rangeEvents = adapter.fetchEventsInRange(now - dayMs * 7, now + dayMs * 7);
test('range query returns subset', () => assert.ok(rangeEvents.length > 0));
test('range query all within bounds', () => {
  for (const e of rangeEvents) {
    assert.ok(e.scheduledAt >= now - dayMs * 7);
    assert.ok(e.scheduledAt <= now + dayMs * 7);
  }
});

const rbiEvents = adapter.fetchEventsByType('RBI_POLICY');
test('type filter works', () => {
  for (const e of rbiEvents) {
    assert.equal(e.type, 'RBI_POLICY');
  }
});

const highEvents = adapter.fetchHighImportanceEvents();
test('importance filter works', () => {
  for (const e of highEvents) {
    assert.equal(e.importance, 'HIGH');
  }
});

// --- Disabled mode ---
console.log('\nDisabled Mode:');
const disabled = createEventCalendarAdapter('disabled');
test('disabled returns empty', () => {
  const cal = disabled.fetchCalendar();
  assert.equal(cal.events.length, 0);
});

adapter.dispose();
disabled.dispose();

console.log(`\n=== ${passed}/${total} passed ===`);
process.exit(passed === total ? 0 : 1);
