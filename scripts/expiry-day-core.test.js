#!/usr/bin/env node
/**
 * Deterministic unit tests for scripts/expiry-day-core.js — the expiry-day
 * decision engine's shared maths. No DB, no network, no clock dependence
 * except where a fixed `nowMs` is injected.
 */
'use strict';
const assert = require('node:assert/strict');
const C = require('./expiry-day-core');

let passed = 0; let failed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); console.log(`  ok   ${name}`); passed += 1; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message.split('\n').join('\n       ')}`); failed += 1; failures.push(name); }
}
const group = (n) => console.log(`\n${n}`);

console.log('expiry-day-core tests');

// ── clock / IST semantics ────────────────────────────────────────────────
group('clock: IST wall clock, never NOW()');
test('istNowMs shifts UTC to IST wall clock', () => {
  const utc = Date.UTC(2026, 8, 29, 0, 0, 0);            // 00:00 UTC
  assert.equal(new Date(C.istNowMs(utc)).toISOString().slice(11, 16), '05:30');
});
test('istDateIso returns the IST calendar date, not the UTC one', () => {
  const utc = Date.UTC(2026, 8, 28, 19, 0, 0);            // 19:00 UTC = 00:30 IST next day
  assert.equal(C.istDateIso(utc), '2026-09-29');
});
test('istMinutesOfDay converts an IST Date to minutes', () => {
  assert.equal(C.istMinutesOfDay(new Date('2026-09-29T09:20:00Z')), 9 * 60 + 20);
});
test('parseIstTs reads a MySQL datetime as IST wall clock', () => {
  const ms = C.parseIstTs('2026-09-29 09:20:00');
  assert.equal(new Date(ms).toISOString(), '2026-09-29T09:20:00.000Z');
});
test('parseIstTs handles ISO strings and nulls', () => {
  assert.equal(C.parseIstTs('2026-09-29T09:20:00.000Z'), Date.UTC(2026, 8, 29, 9, 20, 0));
  assert.equal(C.parseIstTs(null), null);
  assert.equal(C.parseIstTs('not-a-date'), null);
});
test('ageMs is measured on the IST clock for a 15:00 IST stamp', () => {
  // now = 2026-09-29 09:15 UTC  →  IST wall clock 14:45
  const nowUtc = Date.UTC(2026, 8, 29, 9, 15, 0);
  const age = C.ageMs('2026-09-29 15:00:00', nowUtc);     // 15 min later in IST ⇒ negative
  assert.equal(age, -15 * 60_000);
});

// ── freshness contract ───────────────────────────────────────────────────
group('freshness: stale data must lose its vote');
test('buckets: FRESH / AGING / STALE / UNKNOWN boundaries', () => {
  assert.equal(C.freshnessBucket(5_000), 'FRESH');
  assert.equal(C.freshnessBucket(45_000), 'AGING');
  assert.equal(C.freshnessBucket(600_000), 'STALE');
  assert.equal(C.freshnessBucket(null), 'UNKNOWN');
});
test('weights: STALE and UNKNOWN contribute zero, never neutral', () => {
  assert.equal(C.freshnessWeight('FRESH'), 1);
  assert.equal(C.freshnessWeight('AGING'), 0.5);
  assert.equal(C.freshnessWeight('STALE'), 0);
  assert.equal(C.freshnessWeight('UNKNOWN'), 0);
});
test('datumFreshness separates tick clock from OI clock and flags OI_STALE', () => {
  const now = Date.UTC(2026, 8, 29, 3, 30, 0);            // 09:00 IST
  const f = C.datumFreshness({
    marketDataTimestamp: '2026-09-29 08:59:50',           // 10s old
    optionChainTimestamp: '2026-09-29 08:40:00',          // 20 min old
    tickTimestamp: '2026-09-29 08:59:58',
    nowMs: now,
  });
  assert.equal(f.marketDataBucket, 'FRESH');
  assert.equal(f.optionChainBucket, 'STALE');
  assert.equal(f.tickBucket, 'FRESH');
  assert.equal(f.OI_STALE, true);
  assert.equal(f.overallBucket, 'STALE');
  assert.equal(f.dataAgeMs, 20 * 60_000);
});
test('datumFreshness: fresh OI is not flagged stale', () => {
  const now = Date.UTC(2026, 8, 29, 3, 30, 0);
  const f = C.datumFreshness({ optionChainTimestamp: '2026-09-29 08:59:30', nowMs: now });
  assert.equal(f.OI_STALE, false);
});

// ── bars / VWAP ──────────────────────────────────────────────────────────
const T = (hhmm, ltp, volume = 0) => ({ ts: `2026-09-29 ${hhmm}:00`, ltp, volume });

group('bars and VWAP');
test('buildBars aggregates fixed 5-minute bars with correct OHLC', () => {
  const bars = C.buildBars([
    T('09:15', 22700, 100), T('09:17', 22720, 50), T('09:19', 22690, 50),
  ], 5, '2026-09-29');
  assert.equal(bars.length, 1);
  assert.equal(bars[0].bucketMinutes, 9 * 60 + 15);
  assert.equal(bars[0].open, 22700);
  assert.equal(bars[0].high, 22720);
  assert.equal(bars[0].low, 22690);
  assert.equal(bars[0].close, 22690);
  assert.equal(bars[0].volume, 200);
});
test('buildBars keeps bar sequence and cumulative volume monotone', () => {
  const bars = C.buildBars([
    T('09:15', 100, 10), T('09:20', 110, 10), T('09:25', 120, 10),
  ], 5, '2026-09-29');
  assert.deepEqual(bars.map((b) => b.bucketMinutes), [555, 560, 565]);
  assert.equal(bars[2].cumVolume, 30);
  assert.ok(bars[2].vwap > bars[0].vwap);
});
test('vwap is null when cumulative volume is zero (never a fake VWAP)', () => {
  assert.equal(C.vwapFromSums(12345, 0), null);
  const bars = C.buildBars([T('09:15', 22700, 0)], 5, '2026-09-29');
  assert.equal(bars[0].vwap, null);
});
test('buildBars clips the 24x7 tape to the cash session (regression)', () => {
  // Overnight flat quotes must NOT become "the opening range". On 2026-09-28 the
  // stored tape ran 00:56–23:59 IST, and using it unclipped produced a
  // degenerate OR (high == low) and a fake held break.
  const bars = C.buildBars([
    T('00:56', 23140, 0), T('00:57', 23140, 0), T('03:00', 23140, 0), T('08:59', 23140, 0),
    T('09:15', 22760, 100), T('09:20', 22780, 100), T('15:30', 22790, 100),
  ], 5, '2026-09-28');
  // 09:15 and 09:20 are different 5-minute buckets; 15:30 is the last one.
  assert.equal(bars.length, 3, 'only the 09:15, 09:20 and 15:30 buckets survive');
  assert.equal(bars[0].bucketMinutes, 555);
  assert.equal(bars[0].open, 22760);
  assert.equal(bars[0].high, 22760, 'overnight 23140 must not appear in any bar');
  assert.equal(bars[2].bucketMinutes, C.SESSION_CLOSE_MIN);
  assert.ok(bars.every((b) => b.high <= 22800 && b.low >= 22700));
});
test('buildBars can opt out of session clipping when explicitly asked', () => {
  const bars = C.buildBars([T('00:56', 23140, 10)], 5, '2026-09-28', { clipToSession: false });
  assert.equal(bars.length, 1);
});
test('typicalPrice rejects non-finite legs', () => {
  assert.equal(C.typicalPrice({ high: 10, low: 8, close: 9 }), 9);
  assert.equal(C.typicalPrice({ high: 10, low: null, close: 9 }), null);
});

// ── opening range / VWAP state ──────────────────────────────────────────
/**
 * Bar builder. The tuple is (bucketMinute, open, high, low, close, volume) and
 * the builder feeds OPEN, HIGH, LOW and CLOSE observations to buildBars — a
 * previous version only fed `close`, which silently flattened every high/low
 * and made OHLC-dependent tests meaningless.
 */
const bar = (mins, o, h, l, c, v = 100) => {
  const pad = (n) => String(n).padStart(2, '0');
  const at = (m) => `2026-09-29 ${pad(Math.floor(m / 60))}:${pad(m % 60)}:`;
  return [
    { ts: `${at(mins)}00`, ltp: o, volume: 0 },
    { ts: `${at(mins)}10`, ltp: h, volume: 0 },
    { ts: `${at(mins)}20`, ltp: l, volume: 0 },
    { ts: `${at(mins)}30`, ltp: c, volume: v },
  ];
};
const mkBars = (defs) => C.buildBars(defs.flat(), 5, '2026-09-29');

group('opening range / VWAP state machine');
test('openingRangeState is not ready before the OR window completes', () => {
  const bars = mkBars([bar(555, 100, 101, 99, 100)]);
  const st = C.openingRangeState(bars, { orMinutes: 15 });
  assert.equal(st.ready, false);
  assert.equal(st.reason, 'INSUFFICIENT_BARS');
});
test('openingRangeState: inside the range ⇒ no break', () => {
  const bars = mkBars([
    bar(555, 100, 110, 98, 105), bar(560, 105, 112, 100, 104), bar(565, 104, 108, 99, 103),
    bar(570, 103, 106, 101, 104), bar(575, 104, 107, 102, 105),
  ]);
  const st = C.openingRangeState(bars, { orMinutes: 15 });
  assert.equal(st.ready, true);
  assert.equal(st.orHigh, 112);
  assert.equal(st.orLow, 98);
  assert.equal(st.closePos, 'INSIDE');
  assert.equal(st.beyondBuffer, false);
});
test('openingRangeState: a close beyond buffer ⇒ UP break, not yet held', () => {
  const bars = mkBars([
    bar(555, 100, 110, 98, 105), bar(560, 105, 112, 100, 104), bar(565, 104, 108, 99, 103),
    bar(570, 103, 118, 103, 116),   // closes 4 pts above orHigh 112 (buffer 1.4)
  ]);
  const st = C.openingRangeState(bars, { orMinutes: 15 });
  assert.equal(st.closePos, 'UP');
  assert.equal(st.beyondBuffer, true);
  assert.equal(st.falseBreak, true);      // only one close outside
});
test('openingRangeState: two closes outside with no retest ⇒ held', () => {
  const bars = mkBars([
    bar(555, 100, 110, 98, 105), bar(560, 105, 112, 100, 104), bar(565, 104, 108, 99, 103),
    bar(570, 103, 118, 103, 116), bar(575, 116, 120, 115, 119),
  ]);
  const st = C.openingRangeState(bars, { orMinutes: 15 });
  assert.equal(st.closePos, 'UP');
  assert.equal(st.held, true);
});
test('openingRangeState: break then retest of the boundary keeps the break alive', () => {
  // Bar 5 dips to the orHigh boundary (a retest) but CLOSES above it, so the
  // break is still holding — a retest is not a failure.
  const bars = mkBars([
    bar(555, 100, 110, 98, 105), bar(560, 105, 112, 100, 104), bar(565, 104, 108, 99, 103),
    bar(570, 103, 118, 103, 116), bar(575, 116, 117, 111, 114),
  ]);
  const st = C.openingRangeState(bars, { orMinutes: 15 });
  assert.equal(st.closePos, 'UP');
  assert.equal(st.breakFailed, false);
  assert.equal(st.held, false);       // retested, so not a clean trend hold
});
test('openingRangeState: a poke that closes back inside is not a break', () => {
  const bars = mkBars([
    bar(555, 100, 110, 98, 105), bar(560, 105, 112, 100, 104), bar(565, 104, 108, 99, 103),
    bar(570, 103, 113, 103, 105),   // poked above 112 but closed 105 ⇒ INSIDE
  ]);
  const st = C.openingRangeState(bars, { orMinutes: 15 });
  assert.equal(st.closePos, 'INSIDE');
  assert.equal(st.pokedUp, true);
  assert.equal(st.beyondBuffer, false);
});
test('openingRangeState: break then close back inside ⇒ breakFailed (SETUP C state)', () => {
  const bars = mkBars([
    bar(555, 100, 110, 98, 105), bar(560, 105, 112, 100, 104), bar(565, 104, 108, 99, 103),
    bar(570, 103, 118, 103, 116),   // genuine close above the range
    bar(575, 116, 117, 111, 112),   // traded back and closed inside
  ]);
  const st = C.openingRangeState(bars, { orMinutes: 15 });
  assert.equal(st.hadBreak, true);
  assert.equal(st.breakFailed, true);
  assert.equal(st.closePos, 'INSIDE');
  assert.equal(st.held, null);        // no longer a live break at all
});
test('vwapReclaimState detects RECLAIM after a downside excursion', () => {
  const bars = mkBars([
    bar(555, 100, 101, 98, 99, 100), bar(560, 99, 100, 97, 98, 100),
    bar(565, 98, 99, 96, 97, 100), bar(570, 97, 101, 97, 100, 100),
  ]);
  const last = bars[bars.length - 1];
  const st = C.vwapReclaimState(bars, last.vwap, { barsBack: 4 });
  assert.equal(['RECLAIM', 'FLIP_RECLAIM'].includes(st.state), true, `got ${st.state}`);
});
test('vwapReclaimState returns UNKNOWN without a VWAP', () => {
  const bars = mkBars([bar(555, 100, 101, 99, 100, 0)]);
  assert.equal(C.vwapReclaimState(bars, null).state, 'UNKNOWN');
});
test('directionalPersistence counts dominant bar bodies', () => {
  const bars = mkBars([
    bar(555, 100, 101, 99, 101, 10), bar(560, 101, 102, 100, 102, 10),
    bar(565, 102, 103, 101, 103, 10), bar(570, 103, 104, 102, 101, 10),
  ]);
  const p = C.directionalPersistence(bars, 4);
  assert.equal(p.up, 3);
  assert.equal(p.down, 1);
  assert.equal(p.dominant, 'UP');
  assert.equal(p.score, 0.5);
});

// ── gaps / implied range ────────────────────────────────────────────────
group('gaps and implied range');
test('classifyGap covers the five opening classes', () => {
  assert.equal(C.classifyGap(0.05), 'FLAT_OPEN');
  assert.equal(C.classifyGap(0.30), 'GAP_UP_SMALL');
  assert.equal(C.classifyGap(0.90), 'GAP_UP_LARGE');
  assert.equal(C.classifyGap(-0.30), 'GAP_DOWN_SMALL');
  assert.equal(C.classifyGap(-0.90), 'GAP_DOWN_LARGE');
});
test('classifyGap returns UNKNOWN for non-finite input', () => {
  assert.equal(C.classifyGap(NaN), 'UNKNOWN');
  assert.equal(C.classifyGap(undefined), 'UNKNOWN');
});
test('openingPositionInImpliedRange places the open inside/outside', () => {
  const inside = C.openingPositionInImpliedRange(22780, 22626, 22934);
  assert.equal(inside.position, 'INSIDE_EXPECTED_RANGE');
  const upper = C.openingPositionInImpliedRange(22920, 22626, 22934);
  assert.equal(upper.position, 'NEAR_UPPER_BOUNDARY');
  const out = C.openingPositionInImpliedRange(23000, 22626, 22934);
  assert.equal(out.outside, true);
});
test('openingPositionInImpliedRange is UNKNOWN on a degenerate range', () => {
  assert.equal(C.openingPositionInImpliedRange(100, 100, 100).position, 'UNKNOWN');
});

// ── greeks ──────────────────────────────────────────────────────────────
group('option maths');
test('bsGreeks put-call parity holds within tolerance', () => {
  const p = { S: 22780, K: 22800, T: 1 / 365, r: 0.06, q: 0, vol: 0.15 };
  const c = C.bsGreeks({ ...p, type: 'CE' });
  const put = C.bsGreeks({ ...p, type: 'PE' });
  const lhs = c.price - put.price;
  const rhs = p.S * Math.exp(-p.q * p.T) - p.K * Math.exp(-p.r * p.T);
  assert.ok(Math.abs(lhs - rhs) < 0.01, `parity off by ${Math.abs(lhs - rhs)}`);
});
test('bsGreeks call delta in (0,1), put delta in (-1,0), gamma > 0', () => {
  const c = C.bsGreeks({ S: 22780, K: 22800, T: 1 / 365, r: 0.06, vol: 0.15, type: 'CE' });
  const p = C.bsGreeks({ S: 22780, K: 22800, T: 1 / 365, r: 0.06, vol: 0.15, type: 'PE' });
  assert.ok(c.delta > 0 && c.delta < 1);
  assert.ok(p.delta < 0 && p.delta > -1);
  assert.ok(c.gamma > 0);
});
test('bsGreeks ATM is ~0.5 delta on expiry day (one day to expiry)', () => {
  const c = C.bsGreeks({ S: 22800, K: 22800, T: 1 / 365, r: 0.06, vol: 0.15, type: 'CE' });
  assert.ok(Math.abs(c.delta - 0.5) < 0.02, `delta ${c.delta}`);
});
test('bsGreeks is null on non-finite or zero inputs (no fabricated greeks)', () => {
  assert.equal(C.bsGreeks({ S: 0, K: 22800, T: 0.01, vol: 0.15 }), null);
  assert.equal(C.bsGreeks({ S: 22780, K: 22800, T: 0, vol: 0.15 }), null);
  assert.equal(C.bsGreeks({ S: 22780, K: 22800, T: 0.01, vol: 0 }), null);
  assert.equal(C.bsGreeks({ S: NaN, K: 22800, T: 0.01, vol: 0.15 }), null);
});
test('theta is negative for a long option (decay costs the buyer)', () => {
  const c = C.bsGreeks({ S: 22780, K: 23000, T: 1 / 365, r: 0.06, vol: 0.18, type: 'CE' });
  assert.ok(c.thetaPerDay < 0, `theta ${c.thetaPerDay}`);
});
test('impliedMoveFromStraddle derives the expected range', () => {
  const m = C.impliedMoveFromStraddle(153.55, 22780.25);
  assert.equal(m.impliedMovePts, 153.55);
  assert.equal(m.impliedLow, 22626.7);
  assert.equal(m.impliedHigh, 22933.8);
  assert.ok(Math.abs(m.impliedMovePct - 0.674) < 0.01);
});
test('impliedMoveFromStraddle is null on bad input', () => {
  assert.equal(C.impliedMoveFromStraddle(null, 22780), null);
  assert.equal(C.impliedMoveFromStraddle(100, 0), null);
});
test('realisedRange reads high/low across bars', () => {
  const bars = mkBars([bar(555, 100, 110, 98, 105), bar(560, 105, 115, 104, 112)]);
  const r = C.realisedRange(bars);
  assert.equal(r.high, 115);
  assert.equal(r.low, 98);
  assert.equal(r.range, 17);
});

// ── OI structure ────────────────────────────────────────────────────────
group('OI structure');
const chain = [
  { strike: 22700, ceOi: 500, peOi: 900, ceChg: 300, peChg: 100 },
  { strike: 22800, ceOi: 2100, peOi: 800, ceChg: -500, peChg: -200 },
  { strike: 22900, ceOi: 1500, peOi: 300, ceChg: 200, peChg: 0 },
  { strike: 23000, ceOi: 200, peOi: 100, ceChg: 0, peChg: 0 },
];
test('maxPainStrikes minimises aggregate intrinsic pain', () => {
  assert.ok(['22800', '22900'].includes(String(C.maxPainStrikes(chain).strike)));
});
test('maxPainStrikes is null on an empty chain', () => {
  assert.equal(C.maxPainStrikes([]), null);
  assert.equal(C.maxPainStrikes(null), null);
});
test('oiConcentration sums both sides and reports top-strike share', () => {
  const c = C.oiConcentration(chain, 2);
  assert.equal(c.callOiTotal, 4300);
  assert.equal(c.putOiTotal, 2100);
  assert.equal(c.topCallStrikes[0].strike, 22800);
  assert.equal(c.topPutStrikes[0].strike, 22700);
  assert.ok(c.callConcentrationPct > 80 && c.callConcentrationPct < 90, `${c.callConcentrationPct}`);
});
test('oiConcentration returns null percentages when a side has no OI', () => {
  const c = C.oiConcentration([{ strike: 100, ceOi: 0, peOi: 0 }], 1);
  assert.equal(c.callConcentrationPct, null);
  assert.equal(c.putConcentrationPct, null);
});
test('oiMigrations surfaces the largest OI changes by magnitude (signed)', () => {
  const m = C.oiMigrations(chain, 3);
  // |−500| at 22800 CE is the largest change, so it leads the list, signed.
  assert.equal(m.largestAdds[0].change, -500);
  assert.equal(m.largestAdds[0].strike, 22800);
  assert.ok(m.largestAdds.length >= 2);
  // Every returned change must be non-zero and sorted by descending magnitude.
  const mags = m.largestAdds.map((r) => Math.abs(r.change));
  assert.deepEqual(mags, [...mags].sort((a, b) => b - a));
  assert.ok(m.largestAdds.every((r) => r.change !== 0));
});
test('spreadMetrics converts bid/ask into a cost gate', () => {
  const s = C.spreadMetrics(84.9, 85.9, 85.4);
  assert.equal(s.spread, 1);
  assert.equal(s.mid, 85.4);
  assert.ok(s.spreadPctOfMid > 1.1 && s.spreadPctOfMid < 1.2);
  assert.equal(C.spreadMetrics(null, 85.9, 85), null);
  assert.equal(C.spreadMetrics(0, 0, 0), null);
});
test('r2 is null-safe', () => {
  assert.equal(C.r2(1.23456, 2), 1.23);
  assert.equal(C.r2('x'), null);
});

console.log(`\nexpiry-day-core: ${passed} passed, ${failed} failed`);
if (failed) { console.log('failed tests:', failures.join(' | ')); process.exit(1); }
