/**
 * Test: P0 Features (Gap, VWAP, ATR, RelativeVolume, ORB, Breadth).
 * Run: npx ts-node scripts/test-p0-features.ts
 */

import {
  computeGap,
  computeVwap,
  computeVwapFromBars,
  computeAtr,
  computeRelativeVolume,
  computeOrb,
  computeBreadth,
  Bar,
  Tick,
  BreadthInput,
} from '../src/trading/pattern-engine/p0-features';

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(`FAIL: ${msg}`);
}

function approxEq(a: number, b: number, eps: number = 0.01): boolean {
  return Math.abs(a - b) < eps;
}

// ── Gap Tests ──

// Test 1: Positive gap
{
  const r = computeGap(105, 100, 5);
  assert(approxEq(r.gapPct, 5.0), `T1: gapPct should be 5.0, got ${r.gapPct}`);
  assert(approxEq(r.gapATR, 1.0), `T1: gapATR should be 1.0, got ${r.gapATR}`);
  assert(r.direction === 'UP', `T1: direction should be UP, got ${r.direction}`);
  console.log('  ✓ T1: Positive gap computed correctly');
}

// Test 2: Negative gap
{
  const r = computeGap(95, 100, 10);
  assert(approxEq(r.gapPct, -5.0), `T2: gapPct should be -5.0, got ${r.gapPct}`);
  assert(approxEq(r.gapATR, -0.5), `T2: gapATR should be -0.5, got ${r.gapATR}`);
  assert(r.direction === 'DOWN', `T2: direction should be DOWN`);
  console.log('  ✓ T2: Negative gap computed correctly');
}

// Test 3: Flat gap (< 0.01%)
{
  const r = computeGap(100.005, 100, 5);
  assert(r.direction === 'FLAT', `T3: direction should be FLAT, got ${r.direction}`);
  console.log('  ✓ T3: Flat gap detected');
}

// Test 4: Invalid previous close → zero
{
  const r = computeGap(100, 0, 5);
  assert(r.gapPct === 0, `T4: should be 0 with invalid prev close`);
  console.log('  ✓ T4: Invalid previous close returns zero');
}

// ── VWAP Tests ──

// Test 5: Simple VWAP
{
  const ticks: Tick[] = [
    { ts: 1, price: 100, volume: 10 },
    { ts: 2, price: 110, volume: 20 },
  ];
  const r = computeVwap(ticks);
  // VWAP = (100*10 + 110*20) / (10+20) = (1000+2200)/30 = 3200/30 ≈ 106.667
  assert(approxEq(r.vwap, 106.667, 0.01), `T5: VWAP should be ~106.67, got ${r.vwap}`);
  assert(r.cumulativeVolume === 30, `T5: cumVol should be 30`);
  console.log('  ✓ T5: VWAP computed correctly');
}

// Test 6: Empty ticks
{
  const r = computeVwap([]);
  assert(r.vwap === 0, 'T6: empty should give 0');
  console.log('  ✓ T6: Empty ticks returns zero');
}

// Test 7: VWAP from bars
{
  const bars: Bar[] = [
    { ts: 1, open: 100, high: 110, low: 95, close: 105, volume: 100 },
    { ts: 2, open: 105, high: 115, low: 100, close: 110, volume: 200 },
  ];
  const r = computeVwapFromBars(bars);
  assert(r.cumulativeVolume === 300, 'T7: cumVol should be 300');
  assert(r.vwap > 0, 'T7: VWAP should be positive');
  console.log('  ✓ T7: VWAP from bars computed correctly');
}

// ── ATR Tests ──

// Test 8: ATR basic
{
  const bars: Bar[] = [
    { ts: 1, open: 100, high: 105, low: 95, close: 102, volume: 100 },
    { ts: 2, open: 102, high: 108, low: 100, close: 106, volume: 100 },
    { ts: 3, open: 106, high: 110, low: 104, close: 108, volume: 100 },
  ];
  const r = computeAtr(bars, 2);
  assert(r.trueRanges.length === 2, `T8: should have 2 TRs, got ${r.trueRanges.length}`);
  // TR1: max(105-95, |105-102|, |95-102|) = max(10, 3, 7) = 10
  // TR2: max(108-100, |108-106|, |100-106|) = max(8, 2, 6) = 8
  // ATR(2) first = (10+8)/2 = 9, then no more data
  // TR1 (bar2): max(108-100, |108-102|, |100-102|) = max(8,6,2) = 8
  // TR2 (bar3): max(110-104, |110-106|, |104-106|) = max(6,4,2) = 6
  // ATR(2) with 2 TRs = (8+6)/2 = 7
  assert(approxEq(r.atr, 7, 0.01), `T8: ATR should be 7, got ${r.atr}`);
  console.log('  ✓ T8: ATR computed correctly');
}

// Test 9: ATR with insufficient bars
{
  const bars: Bar[] = [
    { ts: 1, open: 100, high: 105, low: 95, close: 102, volume: 100 },
  ];
  const r = computeAtr(bars, 14);
  assert(r.atr === 0, `T9: single bar → ATR=0`);
  console.log('  ✓ T9: Insufficient bars returns zero ATR');
}

// ── Relative Volume Tests ──

// Test 10: Relative volume
{
  const bars: Bar[] = [];
  for (let i = 0; i < 20; i++) {
    bars.push({ ts: i, open: 100, high: 105, low: 95, close: 102, volume: 100 });
  }
  bars.push({ ts: 20, open: 100, high: 105, low: 95, close: 102, volume: 300 }); // current
  const r = computeRelativeVolume(bars, 20);
  assert(approxEq(r, 3.0, 0.01), `T10: relVol should be 3.0, got ${r}`);
  console.log('  ✓ T10: Relative volume computed correctly');
}

// ── ORB Tests ──

// Test 11: ORB basic
{
  const bars: Bar[] = [
    { ts: 1, open: 100, high: 105, low: 98, close: 103, volume: 100 },
    { ts: 2, open: 103, high: 107, low: 101, close: 106, volume: 100 },
    { ts: 3, open: 106, high: 110, low: 104, close: 108, volume: 100 },
  ];
  const r = computeOrb(bars, 2);
  assert(r.orbHigh === 107, `T11: orbHigh should be 107, got ${r.orbHigh}`);
  assert(r.orbLow === 98, `T11: orbLow should be 98, got ${r.orbLow}`);
  assert(r.rangeSize === 9, `T11: rangeSize should be 9, got ${r.rangeSize}`);
  assert(r.barsInOR === 2, `T11: barsInOR should be 2`);
  console.log('  ✓ T11: ORB computed correctly');
}

// Test 12: ORB empty
{
  const r = computeOrb([]);
  assert(r.orbHigh === 0, 'T12: empty → zeros');
  console.log('  ✓ T12: ORB with empty bars returns zeros');
}

// ── Breadth Tests ──

// Test 13: Breadth basic
{
  const instruments: BreadthInput[] = [
    { currentClose: 105, previousClose: 100 }, // up
    { currentClose: 98, previousClose: 100 },  // down
    { currentClose: 102, previousClose: 100 }, // up
    { currentClose: 100, previousClose: 100 }, // flat
  ];
  const r = computeBreadth(instruments);
  assert(r.advancing === 2, `T13: advancing should be 2, got ${r.advancing}`);
  assert(r.declining === 1, `T13: declining should be 1, got ${r.declining}`);
  assert(r.unchanged === 1, `T13: unchanged should be 1, got ${r.unchanged}`);
  assert(approxEq(r.ratio, 2.0), `T13: ratio should be 2.0, got ${r.ratio}`);
  assert(approxEq(r.normalized, 0.25), `T13: normalized should be 0.25, got ${r.normalized}`);
  console.log('  ✓ T13: Breadth computed correctly');
}

// Test 14: Breadth all advancing
{
  const instruments: BreadthInput[] = [
    { currentClose: 105, previousClose: 100 },
    { currentClose: 102, previousClose: 100 },
  ];
  const r = computeBreadth(instruments);
  assert(r.ratio === 0, `T14: ratio should be 0 (no decliners), got ${r.ratio}`);
  assert(r.normalized === 1.0, `T14: normalized should be 1.0, got ${r.normalized}`);
  console.log('  ✓ T14: All advancing breadth');
}

// Test 15: Breadth empty
{
  const r = computeBreadth([]);
  assert(r.advancing === 0, 'T15: empty → zeros');
  console.log('  ✓ T15: Empty breadth returns zeros');
}

console.log('\n✅ All P0 feature tests passed');
