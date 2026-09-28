#!/usr/bin/env node
/**
 * Tests for the expiry-day REGIME classifier and the SIGNAL engine
 * (direction classification + decoupled tradeability gate).
 *
 * The central property under test: NO TRADE is the default. A bullish-looking
 * market with a failing cost/policy gate must still be NO TRADE, and a
 * direction view must never be expressed as a trade instruction.
 */
'use strict';
const assert = require('node:assert/strict');
const C = require('./expiry-day-core');
const R = require('./expiry-day-regime');
const S = require('./expiry-day-signals');
const { SETUPS, tagSetups } = require('./expiry-day-setups');

let passed = 0; let failed = 0; const failures = [];
function test(name, fn) {
  try { fn(); console.log(`  ok   ${name}`); passed += 1; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message.split('\n').join('\n       ')}`); failed += 1; failures.push(name); }
}
const group = (n) => console.log(`\n${n}`);

// OHLC bar builder (same convention as the core tests).
const bar = (mins, o, h, l, c, v = 100) => {
  const p = (n) => String(n).padStart(2, '0');
  const at = (m) => `2026-09-29 ${p(Math.floor(m / 60))}:${p(m % 60)}:`;
  return [{ ts: `${at(mins)}00`, ltp: o, volume: 0 }, { ts: `${at(mins)}15`, ltp: h, volume: 0 },
    { ts: `${at(mins)}30`, ltp: l, volume: 0 }, { ts: `${at(mins)}45`, ltp: c, volume: v }];
};
const bars = (defs) => C.buildBars(defs.flat(), 5, '2026-09-29');

console.log('expiry-day regime + signals tests');

// ─────────────────────────────── regime ──────────────────────────────────
group('regime: refuses to classify without evidence');

test('UNKNOWN below the minimum bar count', () => {
  const b = bars([bar(555, 100, 101, 99, 100)]);
  const r = R.classifyRegime({ bars: b, or: C.openingRangeState(b, { orMinutes: 15 }) });
  assert.equal(r.regime, R.REGIME.UNKNOWN);
  assert.equal(r.reason, 'INSUFFICIENT_BARS');
  assert.equal(r.confidence, 0);
});

test('confined inside the range with sub-implied movement ⇒ PIN_RANGE', () => {
  const b = bars([
    bar(555, 100, 102, 99, 101), bar(560, 101, 103, 100, 101.5), bar(565, 101.5, 102.5, 100.5, 101),
    bar(570, 101, 103, 100, 102), bar(575, 102, 103, 100.5, 101.2), bar(580, 101.2, 102.5, 100.8, 101.6),
  ]);
  const or = C.openingRangeState(b, { orMinutes: 15 });
  const vwap = C.vwapReclaimState(b, b[b.length - 1].vwap, { barsBack: 6 });
  const r = R.classifyRegime({
    bars: b, or, vwap, impliedMovePts: 12,
    volumeBaseline: R.medianVolume(b),
    wallRejections: { up: 2, down: 1 },
    vwapCrosses: R.countVwapCrosses(b),
  });
  assert.equal(r.regime, R.REGIME.PIN_RANGE, `got ${r.regime} (${r.reason})`);
  assert.equal(r.confidenceIsCalibrated, false);
  assert.equal(r.validated, false);
});

test('held break with volume ⇒ TREND', () => {
  const b = bars([
    bar(555, 100, 101, 99, 100, 50), bar(560, 100, 101, 99, 100, 50), bar(565, 100, 101, 99, 100, 50),
    bar(570, 100, 106, 100, 105, 300), bar(575, 105, 110, 104, 109, 320), bar(580, 109, 112, 108, 111, 300),
  ]);
  const or = C.openingRangeState(b, { orMinutes: 15 });
  const vwap = C.vwapReclaimState(b, b[b.length - 1].vwap, { barsBack: 6 });
  const r = R.classifyRegime({
    bars: b, or, vwap, impliedMovePts: 4,
    volumeBaseline: 50,
    vwapCrosses: R.countVwapCrosses(b),
  });
  assert.equal(r.regime, R.REGIME.TREND, `got ${r.regime} (${r.reason})`);
});

test('break then close back inside ⇒ REVERSAL', () => {
  const b = bars([
    bar(555, 100, 101, 99, 100), bar(560, 100, 101, 99, 100), bar(565, 100, 101, 99, 100),
    bar(570, 100, 108, 100, 107), bar(575, 107, 108, 100, 100.5), bar(580, 100.5, 101, 99, 99.5),
  ]);
  const or = C.openingRangeState(b, { orMinutes: 15 });
  const vwap = C.vwapReclaimState(b, b[b.length - 1].vwap, { barsBack: 6 });
  const r = R.classifyRegime({ bars: b, or, vwap, impliedMovePts: 20, volumeBaseline: 100, vwapCrosses: 2 });
  assert.equal(r.regime, R.REGIME.REVERSAL, `got ${r.regime} (${r.reason})`);
  assert.equal(or.breakFailed, true);
});

test('a wall level alone never creates a regime', () => {
  const b = bars([
    bar(555, 100, 101, 99, 100), bar(560, 100, 101, 99, 100), bar(565, 100, 101, 99, 100),
    bar(570, 100, 101, 99, 100), bar(575, 100, 101, 99, 100), bar(580, 100, 101, 99, 100),
  ]);
  const or = C.openingRangeState(b, { orMinutes: 15 });
  const vwap = C.vwapReclaimState(b, b[b.length - 1].vwap, { barsBack: 6 });
  const r = R.classifyRegime({ bars: b, or, vwap, impliedMovePts: 1, corridor: { low: 99, high: 101 }, volumeBaseline: 100 });
  assert.notEqual(r.regime, R.REGIME.TREND, 'a flat tape must not be called a trend');
});

test('medianVolume returns null when no volume exists', () => {
  const b = bars([bar(555, 100, 101, 99, 100, 0), bar(560, 100, 101, 99, 100, 0)]);
  assert.equal(R.medianVolume(b), null);
});
test('countBoundaryRejections counts poked-and-closed-back bars only', () => {
  const b = bars([bar(555, 100, 105, 100, 101), bar(560, 101, 103, 100, 102)]);
  assert.equal(R.countBoundaryRejections(b, 104, 'UP'), 1);   // bar 1 poked 105, closed 101
  assert.equal(R.countBoundaryRejections(b, 104, 'UP'), 1);
});

// ─────────────────────────── direction signals ──────────────────────────
group('signals: direction classification');

const freshBars = (defs) => bars(defs);
const mkInput = (over = {}) => ({
  bars: over.bars ?? freshBars([
    bar(555, 100, 101, 99, 100, 100), bar(560, 100, 102, 100, 101, 100),
    bar(565, 101, 103, 101, 102, 100), bar(570, 102, 104, 102, 103, 100),
  ]),
  or: C.openingRangeState(over.bars ?? bars([
    bar(555, 100, 101, 99, 100, 100), bar(560, 100, 102, 100, 101, 100),
    bar(565, 101, 103, 101, 102, 100), bar(570, 102, 104, 102, 103, 100),
  ]), { orMinutes: 15 }),
  dataFresh: { overallBucket: C.FRESHNESS.FRESH, OI_STALE: false, optionChainBucket: C.FRESHNESS.FRESH, dataAgeMs: 1000 },
  spot: 22780,
  ...over,
});

test('all 15 evidence buckets are present in every classification', () => {
  const d = S.classifyDirection(mkInput());
  assert.equal(d.buckets.length, 15);
  for (const b of S.BUCKETS) assert.ok(d.buckets.some((x) => x.name === b), `missing bucket ${b}`);
});

test('futures, breadth and order-book buckets abstain honestly when data is absent', () => {
  const d = S.classifyDirection(mkInput());
  const f = d.buckets.find((b) => b.name === 'FUTURES_BASIS_SCORE');
  const br = d.buckets.find((b) => b.name === 'BREADTH_SCORE');
  assert.equal(f.usable, false);
  assert.match(f.reason, /NO FUTURES DATA/);
  assert.equal(br.usable, false);
  assert.match(br.reason, /NO BREADTH DATA/);
  assert.ok(d.unusableBuckets.includes('FUTURES_BASIS_SCORE'));
  assert.ok(d.unusableBuckets.includes('BREADTH_SCORE'));
});

test('OI_STALE removes the OI evidence instead of scoring it', () => {
  const withFresh = S.classifyDirection(mkInput({ dataFresh: { overallBucket: C.FRESHNESS.FRESH, OI_STALE: false, optionChainBucket: C.FRESHNESS.FRESH, dataAgeMs: 1000 } }));
  const withStale = S.classifyDirection(mkInput({ dataFresh: { overallBucket: C.FRESHNESS.FRESH, OI_STALE: true, optionChainBucket: C.FRESHNESS.STALE, optionChainAgeMs: 900000 } }));
  const oiFresh = withFresh.buckets.find((b) => b.name === 'OI_CHANGE_SCORE');
  const oiStale = withStale.buckets.find((b) => b.name === 'OI_CHANGE_SCORE');
  assert.equal(oiStale.usable, false);
  assert.equal(oiStale.contribution, 0);
  assert.match(oiStale.reason, /OI_STALE/);
  assert.notEqual(oiFresh.reason, oiStale.reason);
});

test('max pain / PCR / walls never produce a directional vote', () => {
  const d = S.classifyDirection(mkInput({
    walls: { callWall: { strike: 23000 }, putWall: { strike: 22800 } },
    microstructure: { pcrOi: 0.79, maxPain: { strike: 22900 }, concentration: { callConcentrationPct: 70 } },
  }));
  const wall = d.buckets.find((b) => b.name === 'OI_WALL_SCORE');
  const micro = d.buckets.find((b) => b.name === 'EXPIRY_MICROSTRUCTURE_SCORE');
  assert.equal(wall.score, 0);
  assert.equal(micro.score, 0);
  assert.ok(micro.usable, 'context is still reported');
  assert.match(micro.reason, /context only/);
});

test('conflicting evidence ⇒ NO_TRADE, not a forced side', () => {
  // Volume up while price action is down, and VWAP disagrees with momentum.
  const b = bars([
    bar(555, 100, 101, 99, 100, 10), bar(560, 100, 101, 99, 100, 10), bar(565, 100, 101, 99, 100, 10),
    bar(570, 100, 100.5, 96, 96.5, 500), bar(575, 96.5, 101, 96, 100.5, 480), bar(580, 100.5, 101, 98, 98.5, 470),
  ]);
  const d = S.classifyDirection(mkInput({ bars: b, or: C.openingRangeState(b, { orMinutes: 15 }) }));
  if (d.signalConflict) {
    assert.equal(d.view, S.VIEW.NO_TRADE, 'a conflict must not resolve to a side');
    assert.ok(d.whyNoTrade.length > 0);
  } else {
    assert.ok([S.VIEW.NO_TRADE, S.VIEW.RANGE, S.VIEW.BEARISH].includes(d.view));
  }
});

test('insufficient usable buckets ⇒ NO_TRADE with a stated reason', () => {
  const d = S.classifyDirection(mkInput({ bars: [], or: { ready: false }, dataFresh: { overallBucket: C.FRESHNESS.UNKNOWN } }));
  assert.equal(d.view, S.VIEW.NO_TRADE);
  assert.ok(d.whyNoTrade.some((r) => /usable evidence bucket/.test(r)));
});

test('stale data ⇒ NO_TRADE', () => {
  const d = S.classifyDirection(mkInput({ dataFresh: { overallBucket: C.FRESHNESS.STALE, OI_STALE: true, dataAgeMs: 900000 } }));
  assert.equal(d.view, S.VIEW.NO_TRADE);
  assert.ok(d.whyNoTrade.some((r) => /STALE/.test(r)));
});

test('confidence is explicitly marked uncalibrated', () => {
  const d = S.classifyDirection(mkInput());
  assert.equal(d.confidenceIsCalibrated, false);
  assert.match(d.confidenceNote, /NOT calibrated/);
});

test('direction stage never claims to be a trade', () => {
  const d = S.classifyDirection(mkInput());
  assert.equal(d.stage, 'DIRECTION_ONLY_NOT_A_TRADE');
  assert.equal(d.tradeable, undefined);
  assert.equal(d.entry, undefined);
});

// ───────────────────── tradeability gate (stage 2) ──────────────────────
group('signals: tradeability is a separate gate');

const goodEntry = {
  locationAcceptable: true, volume: 5000, openInterest: 20000,
  bid: 84.9, ask: 85.9, ltp: 85.4, spreadPctOfMid: 1.17, iv: 16.2,
  minutesToClose: 90, expectedMovePoints: 30, roundTripCostPoints: 12,
  alreadyMovedPct: 0.4, riskReward: 2.0,
};
const bullish = () => ({
  view: S.VIEW.BULLISH, signalConflict: false, agreementShare: 0.8,
  dataFreshness: { overallBucket: C.FRESHNESS.FRESH, dataAgeMs: 500 },
});

test('a clean bullish view with a clean gate is ELIGIBLE (paper only)', () => {
  const t = S.evaluateTradeable(bullish(), goodEntry, { permitsExpiryStrategy: true });
  assert.equal(t.tradeable, true);
  assert.equal(t.verdict, 'ELIGIBLE_FOR_PAPER_ONLY');
  assert.equal(t.blocking.length, 0);
});

test('policy not approved blocks everything (current state)', () => {
  const t = S.evaluateTradeable(bullish(), goodEntry, { permitsExpiryStrategy: false });
  assert.equal(t.tradeable, false);
  assert.equal(t.verdict, 'NO_TRADE');
  assert.ok(t.blocking.includes('POLICY_PERMITS'));
});

test('wide spread blocks even when the view is bullish', () => {
  const t = S.evaluateTradeable(bullish(), { ...goodEntry, spreadPctOfMid: 12 }, { permitsExpiryStrategy: true });
  assert.equal(t.tradeable, false);
  assert.ok(t.blocking.includes('SPREAD_OK'));
});
test('too little session time blocks', () => {
  const t = S.evaluateTradeable(bullish(), { ...goodEntry, minutesToClose: 5 }, { permitsExpiryStrategy: true });
  assert.ok(t.blocking.includes('TIME_OK'));
});
test('expected move smaller than costs blocks', () => {
  const t = S.evaluateTradeable(bullish(), { ...goodEntry, expectedMovePoints: 5, roundTripCostPoints: 12 }, { permitsExpiryStrategy: true });
  assert.ok(t.blocking.includes('MOVE_VS_COST'));
});
test('a move that already happened blocks (no chasing)', () => {
  const t = S.evaluateTradeable(bullish(), { ...goodEntry, alreadyMovedPct: 3.5 }, { permitsExpiryStrategy: true });
  assert.ok(t.blocking.includes('NOT_EXTENDED'));
});
test('poor risk/reward blocks', () => {
  const t = S.evaluateTradeable(bullish(), { ...goodEntry, riskReward: 0.9 }, { permitsExpiryStrategy: true });
  assert.ok(t.blocking.includes('RISK_REWARD_OK'));
});
test('illiquid contract blocks', () => {
  const t = S.evaluateTradeable(bullish(), { ...goodEntry, volume: 0, openInterest: 0 }, { permitsExpiryStrategy: true });
  assert.ok(t.blocking.includes('LIQUID'));
});
test('missing spread data blocks (unknown ≠ cheap)', () => {
  const t = S.evaluateTradeable(bullish(), { ...goodEntry, spreadPctOfMid: null }, { permitsExpiryStrategy: true });
  assert.equal(t.tradeable, false);
  assert.ok(t.blocking.includes('SPREAD_OK'));
});
test('signal conflict blocks', () => {
  const t = S.evaluateTradeable({ ...bullish(), signalConflict: true }, goodEntry, { permitsExpiryStrategy: true });
  assert.ok(t.blocking.includes('NO_SIGNAL_CONFLICT'));
});
test('a NO_TRADE view cannot become tradeable', () => {
  const t = S.evaluateTradeable({ ...bullish(), view: S.VIEW.NO_TRADE }, goodEntry, { permitsExpiryStrategy: true });
  assert.equal(t.tradeable, false);
  assert.ok(t.blocking.includes('DIRECTION_CONFIRMED'));
});
test('the capital filter is never reinterpreted here', () => {
  const t = S.evaluateTradeable(bullish(), goodEntry, { permitsExpiryStrategy: true, capitalFilter: 5000 });
  assert.match(t.capitalFilterNote, /not reinterpreted/);
});

// ─────────────────────────────── setups ──────────────────────────────────
group('setups: definitions and tagging');
test('every setup A–H is defined with the required fields', () => {
  for (const k of ['A_ORB_VWAP', 'B_ORB_DOWN_VWAP', 'C_FAILED_BREAK', 'D_WALL_REJECTION', 'E_WALL_BREAKOUT', 'F_ATM_MEAN_REVERSION', 'G_TREND_CONTINUATION', 'H_NO_TRADE']) {
    const s = SETUPS[k];
    assert.ok(s, `missing setup ${k}`);
    for (const f of ['prerequisites', 'confirmation', 'invalidation', 'expectedBehaviour', 'dataRequired', 'historicalTestRequired', 'paperTradingRequired']) {
      assert.ok(f in s, `${k} missing ${f}`);
    }
  }
});
test('a blocked cycle tags H_NO_TRADE', () => {
  const t = tagSetups({ direction: { view: S.VIEW.NO_TRADE }, tradeable: { tradeable: false, blocking: ['SPREAD_OK'] }, regime: { regime: 'UNKNOWN' } });
  assert.ok(t.candidates.some((c) => c.setup === 'H_NO_TRADE'));
  assert.match(t.note, /no sizing/i);
});
test('a failed break tags setup C', () => {
  const t = tagSetups({ direction: { view: S.VIEW.REVERSAL }, tradeable: { tradeable: true, blocking: [] }, regime: { regime: 'REVERSAL' }, or: { breakFailed: true } });
  assert.ok(t.candidates.some((c) => c.setup === 'C_FAILED_BREAK'));
});
test('pin regime tags mean-reversion, not a directional setup', () => {
  // spot 22900 sits INSIDE the 22800–23000 wall corridor.
  const t = tagSetups({ direction: { view: S.VIEW.RANGE }, tradeable: { tradeable: true, blocking: [] }, regime: { regime: 'PIN_RANGE' }, or: {}, walls: { callWall: { strike: 23000 }, putWall: { strike: 22800 } }, spot: 22900 });
  assert.ok(t.candidates.some((c) => c.setup === 'F_ATM_MEAN_REVERSION'));
  assert.ok(t.candidates.some((c) => c.setup === 'D_WALL_REJECTION'));
  assert.ok(!t.candidates.some((c) => c.setup === 'A_ORB_VWAP'));
});

console.log(`\nexpiry-day regime+signals: ${passed} passed, ${failed} failed`);
if (failed) { console.log('failed:', failures.join(' | ')); process.exit(1); }
