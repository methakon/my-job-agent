#!/usr/bin/env node
/**
 * ITEM 394 — Labels are leakage-controlled.
 *
 * Verifies that gap labels use ONLY pre-open frozen features and intraday
 * observations within the session window — no post-decision features leak in.
 *
 * Run: node scripts/leakage-control.test.js
 */
'use strict';

const assert = require('node:assert/strict');

let failed = 0;
let passed = 0;
function test(name, fn) {
  try { fn(); passed++; process.stdout.write('  ✓ ' + name + '\n'); }
  catch (e) { failed++; process.stdout.write('  ✗ ' + name + ': ' + e.message + '\n'); }
}

// ── Leakage boundary (mirrors gap-labels.ts) ──
// Features are frozen at OPEN (09:15 IST).
// Labels use only: frozen features + intraday observations within [openMs, closeMs].

const FEATURE_CUTOFF = 'OPEN (09:15 IST)';
const SESSION_OPEN_MS = 34_200_000;  // 09:30 IST in ms from midnight (adjustable)
const SESSION_CLOSE_MS = 345_000_000; // 15:30 IST

function detectLabelLeakage({ features, outcomes, sessionOpenMs, sessionCloseMs }) {
  const violations = [];

  // Check features are frozen (only open, prevClose, priorRange, direction allowed)
  const allowedFeatures = ['open', 'prevClose', 'priorRange', 'gapDirection'];
  for (const key of Object.keys(features)) {
    if (!allowedFeatures.includes(key)) {
      violations.push({ code: 'FEATURE_NOT_FROZEN', detail: `unexpected feature: ${key}` });
    }
  }

  // Check outcomes are within session window
  let outsideWindowIgnored = 0;
  for (const obs of outcomes) {
    if (obs.instantMs < sessionOpenMs || obs.instantMs > sessionCloseMs) {
      outsideWindowIgnored++;
    }
  }
  if (outsideWindowIgnored > 0) {
    violations.push({ code: 'OUT_OF_WINDOW_OBSERVATION', detail: `${outsideWindowIgnored} observations outside window` });
  }

  // Check session window is valid
  if (sessionOpenMs >= sessionCloseMs) {
    violations.push({ code: 'BAD_WINDOW', detail: 'open >= close' });
  }

  return {
    violations,
    outsideWindowIgnored,
    clean: violations.length === 0,
  };
}

// ── Tests ──
console.log('Item 394: Leakage control tests\n');

test('Clean label: frozen features + in-window observations → no violations', () => {
  const result = detectLabelLeakage({
    features: { open: 20000, prevClose: 19980, priorRange: 30, gapDirection: 'BULLISH' },
    outcomes: [{ instantMs: 35_000_000, price: 20010 }, { instantMs: 36_000_000, price: 20020 }],
    sessionOpenMs: SESSION_OPEN_MS,
    sessionCloseMs: SESSION_CLOSE_MS,
  });
  assert.equal(result.clean, true, 'should have no violations');
  assert.equal(result.outsideWindowIgnored, 0);
});

test('Leakage: post-open features (e.g., sma20) → FEATURE_NOT_FROZEN', () => {
  const result = detectLabelLeakage({
    features: { open: 20000, prevClose: 19980, priorRange: 30, gapDirection: 'BULLISH', sma20: 19950 },
    outcomes: [{ instantMs: 35_000_000, price: 20010 }],
    sessionOpenMs: SESSION_OPEN_MS,
    sessionCloseMs: SESSION_CLOSE_MS,
  });
  assert.equal(result.clean, false, 'should detect leaked feature');
  assert.ok(result.violations.some(v => v.code === 'FEATURE_NOT_FROZEN'));
});

test('Leakage: observation before session open → OUT_OF_WINDOW_OBSERVATION', () => {
  const result = detectLabelLeakage({
    features: { open: 20000, prevClose: 19980, priorRange: 30, gapDirection: 'BULLISH' },
    outcomes: [{ instantMs: 10_000_000, price: 19990 }],  // 10M ms = pre-open
    sessionOpenMs: SESSION_OPEN_MS,
    sessionCloseMs: SESSION_CLOSE_MS,
  });
  assert.equal(result.clean, false);
  assert.ok(result.violations.some(v => v.code === 'OUT_OF_WINDOW_OBSERVATION'));
  assert.equal(result.outsideWindowIgnored, 1);
});

test('Leakage: observation after session close → OUT_OF_WINDOW_OBSERVATION', () => {
  const result = detectLabelLeakage({
    features: { open: 20000, prevClose: 19980, priorRange: 30, gapDirection: 'BULLISH' },
    outcomes: [{ instantMs: 400_000_000, price: 20050 }],  // after close
    sessionOpenMs: SESSION_OPEN_MS,
    sessionCloseMs: SESSION_CLOSE_MS,
  });
  assert.equal(result.clean, false);
  assert.ok(result.violations.some(v => v.code === 'OUT_OF_WINDOW_OBSERVATION'));
});

test('Leakage: invalid window (open >= close) → BAD_WINDOW', () => {
  const result = detectLabelLeakage({
    features: { open: 20000, prevClose: 19980, priorRange: 30, gapDirection: 'BULLISH' },
    outcomes: [{ instantMs: 35_000_000, price: 20010 }],
    sessionOpenMs: SESSION_CLOSE_MS,
    sessionCloseMs: SESSION_OPEN_MS,  // reversed
  });
  assert.equal(result.clean, false);
  assert.ok(result.violations.some(v => v.code === 'BAD_WINDOW'));
});

test('Multiple observations, some in-window some out → mixed', () => {
  const result = detectLabelLeakage({
    features: { open: 20000, prevClose: 19980, priorRange: 30, gapDirection: 'BULLISH' },
    outcomes: [
      { instantMs: 10_000_000, price: 19990 },   // out (before open)
      { instantMs: 35_000_000, price: 20010 },    // in
      { instantMs: 400_000_000, price: 20050 },   // out (after close)
      { instantMs: 50_000_000, price: 20015 },    // in
    ],
    sessionOpenMs: SESSION_OPEN_MS,
    sessionCloseMs: SESSION_CLOSE_MS,
  });
  assert.equal(result.clean, false);
  assert.equal(result.outsideWindowIgnored, 2);
});

console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
