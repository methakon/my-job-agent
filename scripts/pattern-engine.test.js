#!/usr/bin/env node
/**
 * Pattern/learning engine tests (brief sections 1-13, 15, 16, 18).
 *
 * Pure: no DB, no network. Verifies the detector semantics, the normalisation
 * guarantee (no rupee thresholds), the honesty rules (a NO_TRAde always carries
 * a reason; horizons without data are omitted) and the forward labelling.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const F = require('../dist/trading/pattern-engine/pattern-features');
const {
  DEFAULT_PATTERN_THRESHOLDS: T, assessPattern, bucketCandles, atr, detectConsolidation, detectBreakout,
  detectReversal, classifyEntry, classifyOi, liquidityCheck, underlyingConfirmation, chainConfirmation,
  labelOutcomes, patternThresholdsFromEnv, BREAKOUT_CLASSES, ENTRY_STATES, OUTCOME_LABELS, OI_BEHAVIOURS,
  PATTERN_WEIGHTS,
} = F;

const STEP = 5 * 60_000;
/** Frozen clock for determinism: tick age is part of the liquidity score. */
const FIXED_NOW = Date.UTC(2026, 8, 10, 6, 0, 0);
const series = (rows, startTs = Date.UTC(2026, 8, 10, 4, 0, 0)) =>
  rows.map((r, i) => ({
    ts: startTs + i * STEP, open: r[0], high: r[1], low: r[2], close: r[3], volume: r[4] === undefined ? 100 : r[4],
  }));
const quote = (ltp, over = {}) => ({
  ltp, bid: ltp - 0.0025 * ltp, ask: ltp + 0.0025 * ltp, bidQty: 500, askQty: 500, oi: 10_000, changeOi: 1_200, iv: 0.18,
  ts: Date.now(), ...over,
});

console.log('pattern-engine tests');

// ── 1. Candle construction from ticks ───────────────────────────────────────
{
  const ticks = [
    { ts: 0, price: 100, volume: 5 }, { ts: 1_000, price: 104, volume: 7 }, { ts: 2_000, price: 98, volume: 3 },
    { ts: 300_000, price: 99, volume: 9 }, { ts: 301_000, price: 101, volume: 4 },
  ];
  const candles = bucketCandles(ticks, 300_000);
  assert.equal(candles.length, 2, 'two 5-minute buckets');
  assert.equal(candles[0].open, 100);
  assert.equal(candles[0].high, 104);
  assert.equal(candles[0].low, 98);
  assert.equal(candles[0].close, 98);
  assert.equal(candles[0].volume, 15);
  assert.equal(candles[1].open, 99);
  assert.equal(candles[1].close, 101);
}
console.log('  1 candle aggregation ok');

// ── 2. Normalisation: identical shape at 1x and 100x must decide identically ─
{
  const shape = [
    [300, 301, 296, 297, 100], [297, 298, 290, 291, 110], [291, 292, 284, 285, 120], [285, 286, 278, 279, 130],
    [279, 281, 270, 272, 150], [272, 274, 266, 267, 140], [267, 268, 262, 263, 130], [263, 265, 258, 259, 120],
    [259, 261, 254, 255, 110], [255, 257, 248, 250, 120], [250, 252, 246, 247, 100], [247, 249, 244, 245, 95],
    [245, 248, 243, 247, 130], [247, 252, 246, 251, 180], [251, 253, 248, 252, 120], [252, 254, 249, 253, 110],
    [253, 255, 250, 254, 105], [254, 262, 253, 261, 420],
  ];
  const underShape = [
    [20_000, 20_010, 19_960, 19_965, 100], [19_965, 19_975, 19_920, 19_925, 105],
    [19_925, 19_930, 19_880, 19_885, 110], [19_885, 19_890, 19_830, 19_835, 120],
    [19_835, 19_840, 19_790, 19_800, 160], [19_800, 19_805, 19_770, 19_775, 120],
  ];
  const build = (k) => ({
    optionCandles: series(shape.map((r) => r.map((v) => v * k))),
    underlyingCandles: series(underShape.map((r) => r.map((v) => v * k))),
    chainLegs: [
      { strike: 19_800 * k, optionType: 'PE', oi: 5_000 * k, changeOi: 900 * k, volume: 400, iv: 0.19, ltp: 180 * k, bid: 179 * k, ask: 181 * k },
      { strike: 19_900 * k, optionType: 'PE', oi: 6_000 * k, changeOi: 1_500 * k, volume: 500, iv: 0.18, ltp: 150 * k, bid: 149 * k, ask: 151 * k },
      { strike: 19_800 * k, optionType: 'CE', oi: 4_000 * k, changeOi: -200 * k, volume: 300, iv: 0.17, ltp: 120 * k, bid: 119 * k, ask: 121 * k },
      { strike: 19_900 * k, optionType: 'CE', oi: 3_500 * k, changeOi: -300 * k, volume: 260, iv: 0.16, ltp: 90 * k, bid: 89 * k, ask: 91 * k },
    ],
    quote: { ...quote(261 * k), ts: FIXED_NOW },
    optionType: 'PE',
    now: FIXED_NOW,
  });
  const one = assessPattern(build(1));
  const hundred = assessPattern(build(100));
  assert.equal(one.signal, hundred.signal, 'scale must not change the signal');
  assert.equal(one.entryState, hundred.entryState, 'scale must not change the entry state');
  assert.equal(one.patternType, hundred.patternType);
  // Float rounding of a spread that is a *ratio* can differ in the last digits;
  // anything above that is a rupee threshold leaking in.
  assert.ok(Math.abs(one.confidence - hundred.confidence) < 1e-4, `confidence must be scale invariant (${one.confidence} vs ${hundred.confidence})`);
  for (const key of Object.keys(one.components)) {
    assert.ok(Math.abs(one.components[key] - hundred.components[key]) < 1e-6, `component ${key} must be scale invariant`);
  }
  assert.ok(Math.abs(one.breakout.atrMultiple - hundred.breakout.atrMultiple) < 1e-9, 'extension measured in ATR');
}
console.log('  2 scale invariance (no rupee thresholds) ok');

// ── 3. Compression vs trend ─────────────────────────────────────────────────
{
  // A wide, high-volume lead-in (so the compression window has a "before" to
  // measure volume contraction against), then a tight low-volume range.
  const wideLead = [
    [230, 230, 190, 200, 300], [200, 230, 190, 200, 300], [200, 230, 190, 200, 300], [200, 230, 190, 200, 300],
  ];
  const tight = [
    [200, 202, 198, 201, 70], [201, 203, 199, 200, 65], [200, 202, 198, 201, 60], [201, 203, 199, 200, 55],
    [200, 202, 198, 201, 50], [201, 203, 199, 200, 48], [200, 202, 198, 201, 46], [201, 203, 199, 200, 44],
    [200, 202, 198, 201, 42], [201, 203, 199, 200, 40], [200, 202, 199, 201, 38],
  ];
  const range = series([...wideLead, ...tight]);
  const trend = series(Array.from({ length: 12 }, (_, i) => {
    const base = 200 + i * 8;
    return [base, base + 9, base - 2, base + 7, 100];
  }));
  const flat = detectConsolidation(range, T);
  const trending = detectConsolidation(trend, T);
  assert.equal(flat.detected, true, 'a tight range must register as compression');
  assert.ok(flat.rangeWidthPct < 0.05, `range width ${flat.rangeWidthPct} should be narrow`);
  assert.equal(trending.detected, false, 'a one-way trend is not compression');
  assert.ok(flat.components.rangeScore > 0, 'component scores are recorded for later weighting');
  assert.ok(flat.volumeContractionRatio !== null, 'volume contraction is measured');
}
console.log('  3 consolidation detection ok');

// ── 4. Breakout classification incl. FAILED ─────────────────────────────────
{
  const base = [
    [200, 202, 198, 201, 100], [201, 203, 199, 200, 95], [200, 202, 198, 201, 90], [201, 203, 199, 200, 85],
    [200, 202, 198, 201, 80], [201, 203, 199, 200, 75], [200, 202, 198, 201, 70], [201, 203, 199, 200, 65],
  ];
  const early = series([...base, [204, 206, 202, 205, 300]]);
  // Spike above the range, then a close back INSIDE it on the next bar.
  const failed = series([...base, [203, 214, 202, 208, 320], [208, 210, 197, 199, 260]]);
  // The range is measured on the tape BEFORE the newest bar (production does the
  // same) — a range that must include the breakout bar can never be found.
  const consolidation = detectConsolidation(series(base), T);
  assert.equal(consolidation.detected, true, 'the pre-breakout range is compression');
  assert.equal(detectBreakout(early, consolidation, T, 0.004).classification, 'EARLY_BREAKOUT');
  assert.equal(detectBreakout(failed, consolidation, T, 0.004).classification, 'FAILED_BREAKOUT',
    'a spike that closes back inside the range is a failed breakout');
  assert.equal(detectBreakout(series(base), consolidation, T, 0.004).detected, false, 'inside the range = no breakout');
  assert.ok(BREAKOUT_CLASSES.includes('FAILED_BREAKOUT'));
}
console.log('  4 breakout / failed-breakout classification ok');

// ── 5. Canonical case: bearish underlying + bullish PE premium → BUY_PE ─────
{
  const optionRows = [
    [300, 301, 296, 297, 100], [297, 298, 290, 291, 110], [291, 292, 284, 285, 120], [285, 286, 278, 279, 130],
    [279, 281, 270, 272, 150], [272, 274, 266, 267, 140], [267, 268, 262, 263, 130], [263, 265, 258, 259, 120],
    [259, 261, 254, 255, 110], [255, 257, 248, 250, 120], [250, 252, 246, 247, 100], [247, 249, 244, 245, 95],
    [245, 248, 243, 247, 130], [247, 252, 246, 251, 180], [251, 253, 248, 252, 120], [252, 254, 249, 253, 110],
    [253, 255, 250, 254, 105], [254, 262, 253, 261, 420],
  ];
  const bearish = [
    [20_000, 20_010, 19_960, 19_965, 100], [19_965, 19_975, 19_920, 19_925, 105],
    [19_925, 19_930, 19_880, 19_885, 110], [19_885, 19_890, 19_830, 19_835, 120],
    [19_835, 19_840, 19_790, 19_800, 160], [19_800, 19_805, 19_770, 19_775, 120],
  ];
  const bullish = [
    [19_900, 19_920, 19_890, 19_915, 100], [19_915, 19_935, 19_905, 19_930, 105],
    [19_930, 19_950, 19_920, 19_945, 110], [19_945, 19_965, 19_935, 19_960, 120],
    [19_960, 19_985, 19_955, 19_980, 160], [19_980, 20_005, 19_975, 20_000, 220],
  ];
  const legs = [
    { strike: 19_700, optionType: 'PE', oi: 5_000, changeOi: 900, volume: 400, iv: 0.19, ltp: 180, bid: 179, ask: 181 },
    { strike: 19_800, optionType: 'PE', oi: 6_000, changeOi: 1_500, volume: 500, iv: 0.18, ltp: 150, bid: 149, ask: 151 },
    { strike: 19_700, optionType: 'CE', oi: 4_000, changeOi: -200, volume: 300, iv: 0.17, ltp: 120, bid: 119, ask: 121 },
    { strike: 19_800, optionType: 'CE', oi: 3_500, changeOi: -300, volume: 260, iv: 0.16, ltp: 90, bid: 89, ask: 91 },
  ];
  const matching = assessPattern({
    optionCandles: series(optionRows), underlyingCandles: series(bearish), chainLegs: legs,
    quote: quote(261), optionType: 'PE', spot: 19_775,
  });
  const mismatched = assessPattern({
    optionCandles: series(optionRows), underlyingCandles: series(bullish), chainLegs: legs,
    quote: quote(261), optionType: 'PE', spot: 19_775,
  });
  assert.equal(matching.signal, 'BUY_PE', `expected BUY_PE, got ${matching.signal} (conf ${matching.confidence}, ${matching.reason})`);
  assert.ok(matching.confidence >= T.minConfidence, 'confidence above the configured floor');
  assert.equal(matching.entryState, 'BREAKOUT', `entry state was ${matching.entryState}: ${matching.reason}`);
  assert.ok(matching.reason.length > 0, 'a signal always carries its reasoning');
  assert.equal(matching.underlying.preferred, 'BEARISH', 'PE expects a bearish underlying');
  assert.equal(mismatched.signal, 'NO_TRADE', 'an opposite underlying must block the entry');
  assert.ok(mismatched.confidence < matching.confidence, 'unconfirmed underlying lowers confidence');
  assert.ok(mismatched.reason.includes('does not confirm'), `reason should say why: ${mismatched.reason}`);
  // The whole component breakdown is stored so the dashboard can explain itself.
  for (const key of Object.keys(PATTERN_WEIGHTS)) assert.ok(key in matching.components, `component ${key} present`);
  assert.ok(matching.chain.strikesExamined >= 2, 'the broader chain is examined, not just one contract');
}
console.log('  5 canonical PE reversal -> breakout ok');

// ── 6. Chasing guard: an extended move is never a fresh entry ───────────────
{
  const base = series([
    [200, 202, 198, 201, 100], [201, 203, 199, 200, 95], [200, 202, 198, 201, 90], [201, 203, 199, 200, 85],
    [200, 202, 198, 201, 80], [201, 203, 199, 200, 75], [200, 202, 198, 201, 70], [201, 203, 199, 200, 65],
  ]);
  const spike = series([
    [200, 202, 198, 201, 100], [201, 203, 199, 200, 95], [200, 202, 198, 201, 90], [201, 203, 199, 200, 85],
    [200, 202, 198, 201, 80], [201, 203, 199, 200, 75], [200, 202, 198, 201, 70], [201, 203, 199, 200, 65],
    [205, 212, 204, 211, 300], [211, 230, 210, 229, 500], [229, 260, 228, 258, 700],
  ]);
  const consolidation = detectConsolidation(base, T);
  const breakout = detectBreakout(spike, consolidation, T, 0.004);
  assert.ok(breakout.atrMultiple > T.breakoutMaxExtensionAtr,
    `extension ${breakout.atrMultiple} should exceed the ${T.breakoutMaxExtensionAtr} ATR budget`);
  const entry = classifyEntry(
    { distanceAtr: breakout.atrMultiple, recentReturnPct: 0.25, breakoutClass: breakout.classification, reversalScore: 0.8 },
    T,
  );
  assert.ok(entry.state === 'EXTENDED' || entry.state === 'OVEREXTENDED', `expected EXTENDED/OVEREXTENDED, got ${entry.state}`);
  assert.ok(ENTRY_STATES.includes(entry.state));
  const extended = assessPattern({
    optionCandles: spike, underlyingCandles: series([
      [20_000, 20_010, 19_960, 19_965, 100], [19_965, 19_975, 19_920, 19_925, 105],
      [19_925, 19_930, 19_880, 19_885, 110], [19_885, 19_890, 19_830, 19_835, 120],
      [19_835, 19_840, 19_790, 19_800, 160], [19_800, 19_805, 19_770, 19_775, 120],
    ]), chainLegs: [], quote: quote(258), optionType: 'PE',
  });
  assert.equal(extended.signal, 'NO_TRADE', 'an already-explosive move is not a fresh entry');
}
console.log('  6 extended-move guard ok');

// ── 7. Liquidity gate (spread + staleness) ──────────────────────────────────
{
  const wide = liquidityCheck(quote(200, { bid: 190, ask: 212 }), T, Date.now());
  assert.equal(wide.ok, false, 'a wide spread blocks entry');
  assert.ok(wide.reasons.join(' ').includes('spread'), wide.reasons.join(' '));
  const stale = liquidityCheck(quote(200, { ts: Date.now() - 120_000 }), T, Date.now());
  assert.equal(stale.ok, false, 'a stale quote blocks entry');
  assert.ok(stale.reasons.join(' ').includes('stale'), stale.reasons.join(' '));
  const thin = liquidityCheck(quote(200, { bidQty: 0, askQty: 0 }), T, Date.now());
  assert.equal(thin.ok, false, 'no displayed depth blocks entry');
  const good = liquidityCheck(quote(200), T, Date.now());
  assert.equal(good.ok, true, 'a tight, fresh, deep quote passes');
}
console.log('  7 liquidity gate ok');

// ── 8. Underlying + chain confirmation helpers ──────────────────────────────
{
  const down = series([
    [20_000, 20_010, 19_960, 19_965, 100], [19_965, 19_975, 19_920, 19_925, 105],
    [19_925, 19_930, 19_880, 19_885, 110], [19_885, 19_890, 19_830, 19_835, 120],
    [19_835, 19_840, 19_790, 19_800, 160], [19_800, 19_805, 19_770, 19_775, 200],
  ]);
  const peUnderlying = underlyingConfirmation(down, 'PE', T);
  assert.equal(peUnderlying.direction, 'BEARISH');
  assert.equal(peUnderlying.confirmed, true, 'a falling underlying confirms a PE breakout');
  assert.ok(peUnderlying.score > 0);
  assert.equal(underlyingConfirmation(down, 'CE', T).confirmed, false, 'the same tape does not confirm a CE breakout');
  // A young tape (fewer bars than the long MA) must still resolve direction:
  // defaulting to BEARISH there would make every fresh session CE-blind.
  const youngUp = series([
    [19_900, 19_920, 19_890, 19_915, 100], [19_915, 19_935, 19_905, 19_930, 105],
    [19_930, 19_950, 19_920, 19_945, 110], [19_945, 19_965, 19_935, 19_960, 120],
    [19_960, 19_985, 19_955, 19_980, 160], [19_980, 20_005, 19_975, 20_000, 220],
  ]);
  const young = underlyingConfirmation(youngUp, 'CE', T);
  assert.equal(young.direction, 'BULLISH', 'a rising young tape is bullish');
  assert.equal(young.confirmed, true, 'a rising young tape confirms a CE breakout');
  assert.equal(underlyingConfirmation(youngUp, 'PE', T).confirmed, false, 'and does not confirm a PE breakout');
  const chain = chainConfirmation([
    { strike: 19_700, optionType: 'PE', oi: 5_000, changeOi: 900, volume: 400, iv: 0.19, ltp: 180, bid: 179, ask: 181 },
    { strike: 19_800, optionType: 'PE', oi: 6_000, changeOi: 1_500, volume: 500, iv: 0.18, ltp: 150, bid: 149, ask: 151 },
    { strike: 19_700, optionType: 'CE', oi: 4_000, changeOi: -200, volume: 300, iv: 0.17, ltp: 120, bid: 119, ask: 121 },
    { strike: 19_800, optionType: 'CE', oi: 3_500, changeOi: -300, volume: 260, iv: 0.16, ltp: 90, bid: 89, ask: 91 },
  ], 'PE', 19_775);
  assert.ok(chain.pcr !== null && chain.pcr > 1, 'PCR is computed from the examined chain');
  assert.equal(chain.atmStrike, 19_800, 'ATM comes from the real strike list');
  assert.ok(chain.supporting, `PE OI build-up should support: ${JSON.stringify(chain.parts)}`);
  // ATM-by-volume fallback when no spot is supplied (never a hard-coded strike).
  assert.equal(chainConfirmation([
    { strike: 19_700, optionType: 'PE', oi: 1, changeOi: 1, volume: 1, iv: 0.19, ltp: 1 },
    { strike: 19_800, optionType: 'PE', oi: 1, changeOi: 1, volume: 1, iv: 0.18, ltp: 1 },
  ], 'PE', null).atmStrike, 19_800, 'median strike fallback when spot is unknown');
}
console.log('  8 underlying / chain confirmation ok');

// ── 9. OI behaviour classification ──────────────────────────────────────────
{
  assert.equal(classifyOi(0.05, 1_000).behaviour, 'LONG_BUILDUP');
  assert.equal(classifyOi(-0.05, 1_000).behaviour, 'FRESH_WRITING');
  assert.equal(classifyOi(0.05, -1_000).behaviour, 'SHORT_COVERING');
  assert.equal(classifyOi(-0.05, -1_000).behaviour, 'FRESH_BUYING');
  assert.equal(classifyOi(null, 500).behaviour, 'UNCERTAIN');
  assert.ok(OI_BEHAVIOURS.length === 5);
}
console.log('  9 OI behaviour ok');

// ── 10. Forward labelling: MFE/MAE, horizon honesty, first touch wins ───────
{
  const entryTs = Date.UTC(2026, 8, 10, 5, 0, 0);
  const ticks = [];
  for (let m = 1; m <= 20; m++) ticks.push({ ts: entryTs + m * 60_000, price: 100 + m * 5 }); // up to +100%
  const up = labelOutcomes({ entryPrice: 100, entryTs, futureTicks: ticks, targetPct: 0.15, stopPct: 0.08 });
  assert.equal(up.length, 5, 'all five horizons labelled once the future exists');
  assert.equal(up[0].horizonMinutes, 5);
  assert.equal(up[0].maxFavourablePct, 0.25);
  assert.equal(up[0].maxAdversePct, 0.05);
  assert.equal(up[0].label, 'TARGET_REACHED');
  assert.equal(up[0].covered, true, 'the tape reaches the 5-minute horizon');
  assert.equal(up[4].horizonMinutes, 60);
  assert.equal(up[4].covered, false, 'the tape is only 20 minutes long, so 60 is not covered');
  // A short future still labels every horizon that has ANY data, but only the
  // horizons the tape actually reaches are marked `covered` — metrics must
  // filter on that flag, so a partial window can never masquerade as a
  // measurement.
  const partial = labelOutcomes({ entryPrice: 100, entryTs, futureTicks: ticks.slice(0, 6) });
  assert.equal(partial.length, 5, 'every horizon with any future data is labelled');
  assert.equal(partial.find((h) => h.horizonMinutes === 5).covered, true);
  assert.ok(partial.filter((h) => h.horizonMinutes > 10).every((h) => h.covered === false),
    'horizons past the end of the tape are marked uncovered');
  // Both barriers touched: the FIRST touch decides (no optimistic bias).
  const stopFirst = labelOutcomes({
    entryPrice: 100, entryTs, targetPct: 0.15, stopPct: 0.05,
    futureTicks: [
      { ts: entryTs + 60_000, price: 94 }, { ts: entryTs + 120_000, price: 130 },
    ],
  });
  assert.equal(stopFirst[0].label, 'STOP_REACHED', 'the stop was hit first');
  const targetFirst = labelOutcomes({
    entryPrice: 100, entryTs, targetPct: 0.15, stopPct: 0.05,
    futureTicks: [
      { ts: entryTs + 60_000, price: 120 }, { ts: entryTs + 120_000, price: 90 },
    ],
  });
  assert.equal(targetFirst[0].label, 'TARGET_REACHED', 'the target was hit first');
  // A failed breakout is recorded as such, not as a generic loss.
  const failed = labelOutcomes({
    entryPrice: 100, entryTs, futureTicks: [{ ts: entryTs + 60_000, price: 96 }, { ts: entryTs + 120_000, price: 90 }],
  });
  assert.equal(failed[0].label, 'FAILED_BREAKOUT');
  assert.ok(OUTCOME_LABELS.includes(failed[0].label));
}
console.log('  10 forward labelling ok');

// ── 11. NO_TRADE always explains itself (failed signals are recorded) ───────
{
  const flat = series(Array.from({ length: 10 }, () => [200, 201, 199, 200, 100]));
  const assessment = assessPattern({
    optionCandles: flat, underlyingCandles: flat, chainLegs: [], quote: quote(200), optionType: 'CE',
  });
  assert.equal(assessment.signal, 'NO_TRADE');
  assert.ok(assessment.reason.length > 0, 'a rejected setup still carries its reason');
  assert.ok(['NO_PATTERN', 'CONSOLIDATION_OBSERVED'].includes(assessment.patternType), assessment.patternType);
  assert.ok(assessment.components && typeof assessment.components.reversal === 'number');
  const quiet = assessPattern({
    optionCandles: flat, underlyingCandles: flat, chainLegs: [], quote: quote(200), optionType: 'CE',
  });
  assert.equal(quiet.signal, 'NO_TRADE', 'a quiet tape never produces a signal');
}
console.log('  11 rejected setups carry reasons ok');

// ── 12. Thresholds are env-configurable; defaults are sane ─────────────────
{
  const fromEnv = patternThresholdsFromEnv({
    PATTERN_MIN_CONFIDENCE: '0.72', PATTERN_ALLOW_EXTENDED_ENTRIES: 'true', PATTERN_MAX_SPREAD_PCT: '0.01',
  });
  assert.equal(fromEnv.minConfidence, 0.72);
  assert.equal(fromEnv.allowExtendedEntries, true);
  assert.equal(fromEnv.maxSpreadPct, 0.01);
  assert.equal(patternThresholdsFromEnv({}).minConfidence, T.minConfidence);
  assert.equal(patternThresholdsFromEnv({}).allowExtendedEntries, false);
  assert.ok(T.maxSpreadPct > 0 && T.maxSpreadPct < 0.1, 'spread gate is a normalized fraction');
  assert.ok(T.maxTickAgeMs > 0 && T.maxTickAgeMs <= 60_000);
}
console.log('  12 env-configurable thresholds ok');

// ── 13. ATR sanity ─────────────────────────────────────────────────────────
{
  assert.equal(atr(series([])), null, 'no candles, no ATR');
  const steady = series(Array.from({ length: 20 }, (_, i) => [100 + i, 102 + i, 99 + i, 101 + i, 100]));
  const value = atr(steady, 14);
  assert.ok(value !== null && value > 0 && value < 10, `ATR ${value}`);
}
console.log('  13 ATR ok');

// ── 14. No rupee constants in the pure engine (normalisation guard) ────────
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'trading', 'pattern-engine', 'pattern-features.ts'), 'utf8');
  assert.ok(!src.includes('₹'), 'no rupee symbol in the detector');
  assert.ok(!/\b5000\b/.test(src), 'no hard-coded 5000 capital in the detector');
  assert.ok(!/\bhasAutoTrade\b|\bautoTradeEnabled\b/.test(src), 'detection is not coupled to a desk flag');
  // The engine must never write strategy parameters (brief s18) — it only reads them.
  assert.ok(!/update\(|save\(|insert\(/.test(src), 'the detector has no persistence side effects');
}
console.log('  14 normalisation / no side effects ok');

// ── 15. Only session tape, only live contracts ─────────────────────────────
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'trading', 'pattern-engine', 'pattern-engine.service.ts'), 'utf8');
  assert.ok(src.includes('withinMarketSession'), 'engine has an explicit market-session guard');
  assert.ok(src.includes('09:15–15:30 IST'), 'the guard states the session span it enforces');
  assert.ok(src.includes('liveContracts'), 'candidates are restricted to contracts that are live NOW');
  assert.ok(src.includes('no contract ticked within'), 'a universe with no live contract says so rather than assessing stale ticks');
  // The stale-contract filter must apply to the WINDOW, the CANDIDATES and the
  // chain legs too — otherwise the cross-checks use dead strikes.
  assert.ok(/const strikes = \[\.\.\.new Set\(liveContracts/.test(src), 'the ATM window is built from live contracts');
  assert.ok(/const candidates = liveContracts/.test(src), 'candidates are live contracts');
  assert.ok(/const chainLegs: ChainLeg\[\] = liveContracts/.test(src), 'chain cross-checks use live contracts too');
  const staleLines = src.split('\n').filter((line) => line.includes('latestPerContract')
    && !/const latestPerContract|liveContracts = latestPerContract|latestPerContract\.length/.test(line));
  assert.equal(staleLines.length, 0, `no scan path may still key off stale contracts: ${staleLines.join(' | ')}`);
}
console.log('  15 session guard + live candidates ok');

console.log('pattern-engine tests passed');
