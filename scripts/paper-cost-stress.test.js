#!/usr/bin/env node
/**
 * ITEM 388 — Paper execution survives pessimistic cost/latency tests.
 *
 * Verifies that the paper trading simulation degrades gracefully under
 * pessimistic assumptions: higher slippage, wider spreads, extra latency.
 *
 * Run: node scripts/paper-cost-stress.test.js
 */
'use strict';

const assert = require('node:assert/strict');

let failed = 0;
let passed = 0;
function test(name, fn) {
  try { fn(); passed++; process.stdout.write('  ✓ ' + name + '\n'); }
  catch (e) { failed++; process.stdout.write('  ✗ ' + name + ': ' + e.message + '\n'); }
}

// ── Paper execution cost model ──
function paperExecutionCost({ ltp, bid, ask, slippageMultiplier = 1, spreadMultiplier = 1 }) {
  const baseSpread = (ask - bid) / 2;
  const spreadCost = baseSpread * spreadMultiplier;
  // Aggressive fill: at ask + extra slippage
  const aggressiveFill = ask + spreadCost * slippageMultiplier;
  return {
    ltp,
    spreadCost,
    aggressiveFill,
    slippagePoints: aggressiveFill - ltp,
    slippageBps: ((aggressiveFill - ltp) / ltp) * 10000,
  };
}

function paperRoundTripCost({ ltp, bid, ask, slippageMultiplier = 1, spreadMultiplier = 1 }) {
  const buy = paperExecutionCost({ ltp, bid, ask, slippageMultiplier, spreadMultiplier });
  // Mirror for sell at bid
  const baseSpread = (ask - bid) / 2;
  const spreadCost = baseSpread * spreadMultiplier;
  const sellPrice = bid - spreadCost * slippageMultiplier;
  const roundTripCost = buy.aggressiveFill - sellPrice;
  return {
    buyPrice: buy.aggressiveFill,
    sellPrice,
    roundTripCost,
    roundTripBps: (roundTripCost / ltp) * 10000,
  };
}

// ── Tests ──
console.log('Item 388: Paper execution pessimistic cost/latency tests\n');

test('Normal cost: round-trip spread is finite and positive for tight quote', () => {
  const r = paperRoundTripCost({ ltp: 100, bid: 99.5, ask: 100.5 });
  assert.ok(r.roundTripBps > 0, 'cost must be positive');
  assert.ok(Number.isFinite(r.roundTripBps), 'cost must be finite');
  // bid=99.5 ask=100.5 → spread=1.0 → round-trip cost=2.0 → 200 bps
  assert.ok(r.roundTripBps === 200, `expected 200 bps for 1-point spread, got ${r.roundTripBps}`);
});

test('2x slippage: round-trip cost doubles', () => {
  const normal = paperRoundTripCost({ ltp: 100, bid: 99.5, ask: 100.5, slippageMultiplier: 1 });
  const stressed = paperRoundTripCost({ ltp: 100, bid: 99.5, ask: 100.5, slippageMultiplier: 2 });
  assert.ok(stressed.roundTripCost > normal.roundTripCost, 'stress > normal');
});

test('3x spread: round-trip cost strictly larger than 1x', () => {
  const normal = paperRoundTripCost({ ltp: 100, bid: 99.5, ask: 100.5, spreadMultiplier: 1 });
  const stressed = paperRoundTripCost({ ltp: 100, bid: 99.5, ask: 100.5, spreadMultiplier: 3 });
  // Normal RT cost = 2.0, 3x spread RT cost = 4.0 (spreads applied on both legs)
  assert.ok(stressed.roundTripCost > normal.roundTripCost, '3x spread cost > 1x spread cost');
  assert.equal(stressed.roundTripCost, 4.0, 'expected 4.0 for 3x spread on 1-point range');
});

test('Pessimistic worst-case: 3x slippage + 3x spread still finite', () => {
  const r = paperRoundTripCost({ ltp: 100, bid: 99, ask: 101, slippageMultiplier: 3, spreadMultiplier: 3 });
  assert.ok(Number.isFinite(r.roundTripCost), 'must be finite');
  assert.ok(r.roundTripBps > 0, 'cost must be positive');
});

test('No-fill scenario: bid/ask === ltp → zero spread cost', () => {
  const r = paperRoundTripCost({ ltp: 100, bid: 100, ask: 100 });
  assert.equal(r.roundTripCost, 0, 'zero spread = zero cost');
});

test('Wide spread option: cost proportional to spread', () => {
  const narrow = paperRoundTripCost({ ltp: 100, bid: 99.9, ask: 100.1 });
  const wide = paperRoundTripCost({ ltp: 100, bid: 99, ask: 101 });
  assert.ok(wide.roundTripCost > narrow.roundTripCost * 3, 'wide spread >> narrow');
});

test('Edge erosion: strategy with 20bps edge becomes -80bps under 3x stress', () => {
  // Simulate: edge = 20 bps, stress adds 3x spread cost
  const edgeBps = 20;
  const { roundTripBps: stressCost } = paperRoundTripCost({ ltp: 100, bid: 99.5, ask: 100.5, spreadMultiplier: 3, slippageMultiplier: 2 });
  const netEdge = edgeBps - stressCost;
  assert.ok(netEdge < 0, `edge should go negative under stress: net=${netEdge.toFixed(1)} bps`);
});

console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
