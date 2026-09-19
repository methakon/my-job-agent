/**
 * Test: OFI and MLOFI implementations.
 * Run: npx ts-node scripts/test-ofi-mlofi.ts
 */

import { computeOfi, computeOfiDelta, OrderBookSnapshot } from '../src/trading/microstructure/ofi';
import { computeMlofi, computeMlofiFromHistory } from '../src/trading/microstructure/mlofi';

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(`FAIL: ${msg}`);
}

function approxEq(a: number, b: number, eps: number = 0.01): boolean {
  return Math.abs(a - b) < eps;
}

// ── OFI Tests ──

// Test 1: Empty history → INSUFFICIENT_SNAPSHOTS
{
  const r = computeOfi([]);
  assert(r.invalidReason === 'INSUFFICIENT_SNAPSHOTS', 'T1: empty should be INSUFFICIENT_SNAPSHOTS');
  console.log('  ✓ T1: Empty history returns error');
}

// Test 2: Single snapshot → INSUFFICIENT_SNAPSHOTS
{
  const snap: OrderBookSnapshot = {
    instrumentKey: 'NIFTY',
    timestamp: 1,
    bids: [{ price: 100, qty: 100 }],
    asks: [{ price: 101, qty: 100 }],
  };
  const r = computeOfi([snap]);
  assert(r.invalidReason === 'INSUFFICIENT_SNAPSHOTS', 'T2: single should error');
  console.log('  ✓ T2: Single snapshot returns error');
}

// Test 3: No change → OFI = 0
{
  const snap: OrderBookSnapshot = {
    instrumentKey: 'NIFTY',
    timestamp: 1,
    bids: [{ price: 100, qty: 50 }],
    asks: [{ price: 101, qty: 50 }],
  };
  const r = computeOfi([snap, snap]);
  assert(r.value === 0, `T3: no change should give OFI=0, got ${r.value}`);
  assert(r.raw === 0, 'T3: raw should be 0');
  console.log('  ✓ T3: No change gives OFI = 0');
}

// Test 4: Bid depth increases → positive OFI
{
  const prev: OrderBookSnapshot = {
    instrumentKey: 'NIFTY', timestamp: 1,
    bids: [{ price: 100, qty: 50 }],
    asks: [{ price: 101, qty: 50 }],
  };
  const curr: OrderBookSnapshot = {
    instrumentKey: 'NIFTY', timestamp: 2,
    bids: [{ price: 100, qty: 100 }],
    asks: [{ price: 101, qty: 50 }],
  };
  const r = computeOfi([prev, curr]);
  assert(r.value > 0, `T4: bid increase should be positive, got ${r.value}`);
  assert(r.raw === 50, `T4: raw should be 50, got ${r.raw}`);
  console.log('  ✓ T4: Bid depth increase → positive OFI');
}

// Test 5: Ask depth increases → negative OFI
{
  const prev: OrderBookSnapshot = {
    instrumentKey: 'NIFTY', timestamp: 1,
    bids: [{ price: 100, qty: 50 }],
    asks: [{ price: 101, qty: 50 }],
  };
  const curr: OrderBookSnapshot = {
    instrumentKey: 'NIFTY', timestamp: 2,
    bids: [{ price: 100, qty: 50 }],
    asks: [{ price: 101, qty: 100 }],
  };
  const r = computeOfi([prev, curr]);
  assert(r.value < 0, `T5: ask increase should be negative, got ${r.value}`);
  assert(r.raw === -50, `T5: raw should be -50, got ${r.raw}`);
  console.log('  ✓ T5: Ask depth increase → negative OFI');
}

// Test 6: Normalization clamps to [-1, 1]
{
  const prev: OrderBookSnapshot = {
    instrumentKey: 'NIFTY', timestamp: 1,
    bids: [{ price: 100, qty: 0 }],
    asks: [{ price: 101, qty: 0 }],
  };
  const curr: OrderBookSnapshot = {
    instrumentKey: 'NIFTY', timestamp: 2,
    bids: [{ price: 100, qty: 9999 }],
    asks: [{ price: 101, qty: 0 }],
  };
  const r = computeOfi([prev, curr], 5, 100); // maxExpected = 100
  assert(r.value === 1, `T6: should clamp to 1, got ${r.value}`);
  console.log('  ✓ T6: Normalization clamps to [-1, 1]');
}

// Test 7: Instrument mismatch → error
{
  const a: OrderBookSnapshot = { instrumentKey: 'NIFTY', timestamp: 1, bids: [], asks: [] };
  const b: OrderBookSnapshot = { instrumentKey: 'BANKNIFTY', timestamp: 2, bids: [], asks: [] };
  const r = computeOfi([a, b]);
  assert(r.invalidReason === 'INSTRUMENT_MISMATCH', 'T7: should detect mismatch');
  console.log('  ✓ T7: Instrument mismatch detected');
}

// Test 8: Multi-level OFI
{
  const prev: OrderBookSnapshot = {
    instrumentKey: 'NIFTY', timestamp: 1,
    bids: [
      { price: 100, qty: 10 },
      { price: 99, qty: 20 },
    ],
    asks: [
      { price: 101, qty: 10 },
      { price: 102, qty: 20 },
    ],
  };
  const curr: OrderBookSnapshot = {
    instrumentKey: 'NIFTY', timestamp: 2,
    bids: [
      { price: 100, qty: 30 },  // +20
      { price: 99, qty: 10 },   // -10
    ],
    asks: [
      { price: 101, qty: 5 },   // -5
      { price: 102, qty: 15 },  // -5
    ],
  };
  const r = computeOfi([prev, curr]);
  // Level 100: bid +20, ask 0 → +20
  // Level 99: bid -10, ask 0 → -10
  // Level 101: bid 0, ask -5 → +5
  // Level 102: bid 0, ask -5 → +5
  // Total raw = 20 - 10 + 5 + 5 = 20
  assert(r.raw === 20, `T8: multi-level raw should be 20, got ${r.raw}`);
  assert(r.value > 0, `T8: should be positive, got ${r.value}`);
  console.log('  ✓ T8: Multi-level OFI computes correctly');
}

// ── MLOFI Tests ──

// Test 9: No change → MLOFI = 0
{
  const snap: OrderBookSnapshot = {
    instrumentKey: 'NIFTY', timestamp: 1,
    bids: [{ price: 100, qty: 50 }, { price: 99, qty: 30 }],
    asks: [{ price: 101, qty: 50 }, { price: 102, qty: 30 }],
  };
  const r = computeMlofi(snap, snap);
  assert(r.value === 0, `T9: no change → MLOFI=0, got ${r.value}`);
  console.log('  ✓ T9: No change gives MLOFI = 0');
}

// Test 10: Closer levels weighted more heavily
{
  const prev: OrderBookSnapshot = {
    instrumentKey: 'NIFTY', timestamp: 1,
    bids: [{ price: 100, qty: 0 }],
    asks: [{ price: 101, qty: 0 }],
  };
  // Level 0 (best bid) gets +100
  const currLevel0: OrderBookSnapshot = {
    instrumentKey: 'NIFTY', timestamp: 2,
    bids: [{ price: 100, qty: 100 }],
    asks: [{ price: 101, qty: 0 }],
  };
  const r0 = computeMlofi(prev, currLevel0, 5, 0.5);

  // Same +100 but at level 1 (further away)
  const currLevel1: OrderBookSnapshot = {
    instrumentKey: 'NIFTY', timestamp: 2,
    bids: [
      { price: 100, qty: 0 },
      { price: 99, qty: 100 },
    ],
    asks: [{ price: 101, qty: 0 }],
  };
  const r1 = computeMlofi(prev, currLevel1, 5, 0.5);

  assert(r0.value > r1.value, `T10: level 0 (${r0.value}) should weight more than level 1 (${r1.value})`);
  console.log('  ✓ T10: Closer levels weighted more heavily');
}

// Test 11: MLOFI normalized to [-1, 1]
{
  const prev: OrderBookSnapshot = {
    instrumentKey: 'NIFTY', timestamp: 1,
    bids: [{ price: 100, qty: 0 }],
    asks: [{ price: 101, qty: 0 }],
  };
  const curr: OrderBookSnapshot = {
    instrumentKey: 'NIFTY', timestamp: 2,
    bids: [{ price: 100, qty: 50000 }],
    asks: [{ price: 101, qty: 0 }],
  };
  const r = computeMlofi(prev, curr, 1, 0.5);
  assert(r.value >= -1 && r.value <= 1, `T11: should be in [-1,1], got ${r.value}`);
  console.log('  ✓ T11: MLOFI normalized to [-1, 1]');
}

// Test 12: History wrapper
{
  const snap: OrderBookSnapshot = {
    instrumentKey: 'NIFTY', timestamp: 1,
    bids: [{ price: 100, qty: 50 }],
    asks: [{ price: 101, qty: 50 }],
  };
  const r = computeMlofiFromHistory([snap]);
  assert(r.invalidReason === 'INSUFFICIENT_SNAPSHOTS', 'T12: single should error');
  console.log('  ✓ T12: History wrapper handles insufficient snapshots');
}

console.log('\n✅ All OFI/MLOFI tests passed');
