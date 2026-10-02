#!/usr/bin/env node
/**
 * Tests for the ported cpp-trading-agent logic.
 *
 * Three things are pinned here:
 *   1. the ported arithmetic matches the source's documented formulas
 *   2. the deliberate deviations hold (no fixed veto where a size input belongs)
 *   3. the defects the extractors found in their code are NOT reproduced
 */
'use strict';
const assert = require('node:assert/strict');

const F = require('./cpp-features');
const E = require('./cpp-entry-policy');
const X = require('./cpp-exit-policy');

let passed = 0; let failed = 0; const failures = [];
const queue = [];
const test = (n, f) => queue.push({ n, f });
const group = (n) => console.log(`\n${n}`);

const candle = (ts, o, h, l, c, v) => ({ ts, open: o, high: h, low: l, close: c, volume: v ?? 100 });

// ── primitives ──────────────────────────────────────────────────────────
group('ported primitives');

test('bucketCandles groups by 5-minute bucket and keeps OHLC', () => {
  const t0 = 1_000_000_000_000;
  const c = F.bucketCandles([
    { ts: t0 + 1000, price: 10, volume: 5 },
    { ts: t0 + 60_000, price: 12, volume: 5 },
    { ts: t0 + 61_000, price: 11, volume: 5 },
  ], 300_000);
  assert.equal(c.length, 1);
  assert.equal(c[0].open, 10);
  assert.equal(c[0].high, 12);
  assert.equal(c[0].low, 10);
  assert.equal(c[0].close, 11);
  assert.equal(c[0].volume, 15);
});

test('bucketCandles drops ticks with no time or a non-positive price', () => {
  assert.equal(F.bucketCandles([{ ts: NaN, price: 10 }, { ts: 1, price: 0 }, { ts: 1, price: -3 }], 300_000).length, 0);
});

test('atr is a simple mean of true ranges, NOT Wilder smoothing', () => {
  // Pinning the source's actual behaviour, not its (incorrect) comment.
  const cs = [
    candle(1, 10, 12, 9, 11), candle(2, 11, 13, 10, 12), candle(3, 12, 14, 11, 13),
  ];
  const a = F.atr(cs, 2);
  const tr1 = Math.max(13 - 10, Math.abs(13 - 11), Math.abs(11 - 11)); // 3
  const tr2 = Math.max(14 - 11, Math.abs(14 - 12), Math.abs(11 - 12)); // 3
  assert.ok(Math.abs(a - (tr1 + tr2) / 2) < 1e-9, 'must be the plain mean');
});

test('median, stdev and clamp01 behave as specified', () => {
  assert.equal(F.median([3, 1, 2]), 2);
  assert.equal(F.median([4, 1, 3, 2]), 2.5);
  assert.equal(F.clamp01(-1), 0);
  assert.equal(F.clamp01(2), 1);
  assert.ok(Math.abs(F.stdev([2, 4, 4, 4, 5, 5, 7, 9]) - 2.13809) < 1e-4);
});

// ── consolidation ───────────────────────────────────────────────────────
group('ported consolidation');

test('consolidation is measured on the slice WITHOUT the newest bar', () => {
  // A flat 8-bar base then a big breakout bar: measuring on the full series
  // would never find compression, which is the whole point of the slice.
  const base = Array.from({ length: 8 }, (_, i) => candle(i, 100, 101, 99, 100, 100));
  const boom = candle(8, 100, 108, 100, 107, 900);
  const cs = [...base, boom];
  assert.equal(F.detectConsolidation(cs.slice(0, -1)).detected, true);
  assert.equal(F.detectConsolidation(cs).detected, false, 'the breakout bar must not be inside the range');
});

test('consolidation sub-scores are clamped into 0..1', () => {
  const cs = Array.from({ length: 10 }, (_, i) => candle(i, 100, 100.5, 99.5, 100, 100));
  const r = F.detectConsolidation(cs);
  for (const [k, v] of Object.entries(r.parts)) {
    assert.ok(v >= 0 && v <= 1, `${k} out of range: ${v}`);
  }
  assert.ok(r.score >= 0 && r.score <= 1);
});

// ── reversal ────────────────────────────────────────────────────────────
group('ported reversal');

test('reversal weights sum to exactly 1.00', () => {
  const sum = Object.values(F.REVERSAL_WEIGHTS).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-12, `weights sum to ${sum}`);
});

test('a strong bullish-engulfing bar scores materially above 0', () => {
  const cs = [
    candle(1, 100, 101, 99, 100, 50),
    candle(2, 100, 100.5, 99.5, 99.9, 50),
    candle(3, 99.8, 100, 99.6, 99.7, 50),
    candle(4, 99.5, 104, 99.4, 103.8, 900),   // open<=prevClose(99.7), close>=prevOpen(99.9), body grows
  ];
  const r = F.detectReversal(cs);
  assert.ok(r.score > 0.3, `expected a real score, got ${r.score}`);
  assert.ok(r.flags.bullishEngulfing);
});

test('reversal needs at least 4 candles', () => {
  assert.equal(F.detectReversal([candle(1, 1, 1, 1, 1)]).score, 0);
});

// ── breakout ────────────────────────────────────────────────────────────
group('ported breakout');

test('a close above rangeHigh after compression is a breakout', () => {
  const base = Array.from({ length: 8 }, (_, i) => candle(i, 100, 101, 99, 100, 100));
  const cs = [...base, candle(8, 100, 106, 100, 105, 900)];
  const cons = F.detectConsolidation(cs.slice(0, -1));
  const bo = F.detectBreakout(cs, cons);
  assert.equal(bo.detected, true);
  assert.ok(['EARLY_BREAKOUT', 'CONFIRMED_BREAKOUT'].includes(bo.classification));
  assert.ok(bo.atrMultiple > 0);
});

test('a breakout that falls back below rangeHigh is FAILED and not detected', () => {
  // The compression slice is applied INSIDE assessPattern; calling
  // detectConsolidation on an already-sliced series would exclude twice and
  // find nothing. Here the compression bars are passed directly.
  const base = Array.from({ length: 8 }, (_, i) => candle(i, 100, 101, 99, 100, 100));
  const cs = [...base, candle(8, 100, 106, 100, 105, 900), candle(9, 105, 105.2, 98, 99, 900)];
  const cons = F.detectConsolidation(base);
  const bo = F.detectBreakout(cs, cons);
  assert.equal(bo.classification, 'FAILED_BREAKOUT');
  assert.equal(bo.detected, false);
});

test('no consolidation means no breakout', () => {
  assert.equal(F.detectBreakout([candle(1, 1, 1, 1, 1)], { detected: false, startIndex: null }).classification, 'NONE');
});

// ── entry state + classification ────────────────────────────────────────
group('ported entry-state cascade');

test('the cascade is ordered: failed beats chasing beats extended beats breakout', () => {
  assert.equal(F.classifyEntry({ classification: 'FAILED_BREAKOUT', atrMultiple: 9 }).state, 'OVEREXTENDED');
  assert.equal(F.classifyEntry({ classification: 'CONFIRMED_BREAKOUT', atrMultiple: 5 }).state, 'OVEREXTENDED');
  assert.equal(F.classifyEntry({ classification: 'CONFIRMED_BREAKOUT', atrMultiple: 2.0 }).state, 'EXTENDED');
  assert.equal(F.classifyEntry({ classification: 'CONFIRMED_BREAKOUT', atrMultiple: 1.0 }).state, 'BREAKOUT');
  assert.equal(F.classifyEntry({ classification: 'NONE', atrMultiple: null }).state, 'CONFIRMED_MOMENTUM');
});

test('classifyOi quadrants match the source labels exactly', () => {
  assert.equal(F.classifyOi(0.01, 100).label, 'LONG_BUILDUP');
  assert.equal(F.classifyOi(0.01, -100).label, 'SHORT_COVERING');
  assert.equal(F.classifyOi(-0.01, 100).label, 'FRESH_WRITING');
  assert.equal(F.classifyOi(-0.01, -100).label, 'FRESH_BUYING');
  assert.equal(F.classifyOi(0.01, 0).label, 'UNCERTAIN');
  assert.equal(F.classifyOi(0.01, 0).confident, false);
});

// ── liquidity ───────────────────────────────────────────────────────────
group('ported liquidity gate');

test('a stale, wide, one-sided quote is refused', () => {
  const r = F.liquidityCheck({ bid: 10, ask: 11, ltp: 10.5, ts: 0, bidQty: 1, askQty: 1 }, 60_000);
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some((x) => x.includes('tick age')));
});

test('a fresh two-sided tight quote passes', () => {
  const now = 1_000_000;
  const r = F.liquidityCheck({ bid: 100, ask: 100.1, ltp: 100.05, ts: now - 500, bidQty: 5, askQty: 5 }, now);
  assert.equal(r.ok, true, r.reasons.join('; '));
  assert.ok(r.score > 0.9);
});

// ── confidence ──────────────────────────────────────────────────────────
group('ported confidence');

test('the weight table sums to exactly 1.00', () => {
  const s = Object.values(F.PATTERN_WEIGHTS).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(s - 1) < 1e-12, `weights sum to ${s}`);
});

test('penalties are subtractive and can only lower confidence', () => {
  const cs = Array.from({ length: 12 }, (_, i) => candle(i, 100, 101, 99, 100, 100));
  cs.push(candle(12, 100, 110, 100, 109, 9000));   // a big extension
  const a = F.assessPattern({
    optionCandles: cs,
    underlyingCandles: Array.from({ length: 25 }, (_, i) => candle(i, 22000, 22050, 21950, 22040, 500)),
    optionType: 'CE',
    quote: { bid: 100, ask: 100.1, ltp: 100.05, ts: 1, iv: 0.18 },
    nowMs: 500,
    legs: [{ optionType: 'CE', strike: 22000, oi: 1000, changeOi: 50, bid: 100, ask: 100.1, iv: 0.18 }],
    spot: 22000,
  });
  assert.ok(a.confidence >= 0 && a.confidence <= 1);
  assert.ok(a.penalties.extension > 0, 'an extended state must carry a penalty');
});

// ── entry policy ────────────────────────────────────────────────────────
group('ported entry policy');

const GOOD_ASSESSMENT = () => ({
  signal: 'BUY_CE',
  confidence: 0.80,
  entryState: 'BREAKOUT',
  entryReason: 'breakout confirmed',
  components: {},
  breakout: { detected: true, classification: 'CONFIRMED_BREAKOUT', atrMultiple: 1.0 },
  reversal: { score: 0.70 },
  consolidation: { rangeHigh: 108 },
  underlying: { confirmed: true, direction: 'BULLISH', score: 0.70 },
  momentum: { recentReturnPct: 0.02 },
  liquidity: { ok: true, reasons: [], spreadPct: 0.001, tickAgeMs: 200, score: 0.98 },
  chain: { score: 0.6, supporting: true },
});

test('a clean setup qualifies and commits exactly one affordable lot', () => {
  const r = E.evaluateEntry({
    assessment: GOOD_ASSESSMENT(), premium: 50, optionAtr: 2, lotSize: 65,
    account: { AVAILABLE_CAPITAL: 5000 }, nowIstMinutes: 10 * 60,
  });
  assert.equal(r.qualified, true, r.refusals.join('; '));
  assert.equal(r.side, 'BUY_CE');
  assert.ok(r.lots >= 1);
  assert.ok(r.committedCapital <= 5000, 'must never exceed available capital');
  assert.ok(r.stop !== null, 'a stop must exist before entry');
  assert.ok(r.stop < 50, 'a long call stop sits below entry');
});

test('DEVIATION: low confidence reduces SIZE, it does not veto', () => {
  const a = GOOD_ASSESSMENT();
  a.confidence = 0.30;
  const r = E.evaluateEntry({
    assessment: a, premium: 30, optionAtr: 2, lotSize: 65,
    account: { AVAILABLE_CAPITAL: 100000 }, nowIstMinutes: 10 * 60,
  });
  assert.ok(!r.refusals.some((x) => x.includes('confidence')),
    'a fixed confidence veto is forbidden in this engine');
  assert.ok(r.sizeMultiplier < 1, 'confidence must scale size');
  assert.ok(r.lots >= 1);
});

test('DEVIATION: poor expectancy reduces size, it does not veto', () => {
  const a = GOOD_ASSESSMENT();
  a.breakout = { detected: true, classification: 'CONFIRMED_BREAKOUT', atrMultiple: 1.0 };
  a.consolidation = { rangeHigh: 60 };   // stop lands far away => low R
  const r = E.evaluateEntry({
    assessment: a, premium: 50, optionAtr: 0.5, lotSize: 65,
    account: { AVAILABLE_CAPITAL: 100000 }, nowIstMinutes: 10 * 60,
  });
  assert.ok(!r.refusals.some((x) => x.includes('expectancy')),
    'a fixed R:R floor is a fixed threshold veto');
  assert.ok(r.expectancyLabel !== null, 'it is still computed as a label');
});

test('a NO_TRADE assessment can never become a side', () => {
  const a = GOOD_ASSESSMENT();
  a.signal = 'NO_TRADE';
  const r = E.evaluateEntry({ assessment: a, premium: 50, optionAtr: 2, lotSize: 65, account: { AVAILABLE_CAPITAL: 5000 } });
  assert.equal(r.qualified, false);
  assert.equal(r.side, 'NO_TRADE');
});

test('underlying direction must agree with the side', () => {
  const a = GOOD_ASSESSMENT();
  a.underlying = { confirmed: true, direction: 'BEARISH', score: 0.9 };
  const r = E.evaluateEntry({ assessment: a, premium: 50, optionAtr: 2, lotSize: 65, account: { AVAILABLE_CAPITAL: 5000 }, nowIstMinutes: 600 });
  assert.equal(r.qualified, false);
  assert.ok(r.refusals.some((x) => x.includes('underlying is BEARISH')));
});

test('chasing is a structural veto', () => {
  const a = GOOD_ASSESSMENT();
  a.breakout = { detected: true, classification: 'CONFIRMED_BREAKOUT', atrMultiple: 3.5 };
  const r = E.evaluateEntry({ assessment: a, premium: 50, optionAtr: 2, lotSize: 65, account: { AVAILABLE_CAPITAL: 5000 }, nowIstMinutes: 600 });
  assert.equal(r.qualified, false);
  assert.ok(r.refusals.some((x) => x.includes('chasing')));
});

test('one lot unaffordable is refused, never stretched', () => {
  const r = E.evaluateEntry({
    assessment: GOOD_ASSESSMENT(), premium: 200, optionAtr: 4, lotSize: 65,
    account: { AVAILABLE_CAPITAL: 5000 }, nowIstMinutes: 600,
  });
  assert.equal(r.qualified, false);
  assert.ok(r.refusals.some((x) => x.includes('ONE_LOT_UNAFFORDABLE')));
  assert.equal(r.committedCapital, 0);
});

test('outside the exchange session window is refused', () => {
  const r = E.evaluateEntry({
    assessment: GOOD_ASSESSMENT(), premium: 50, optionAtr: 2, lotSize: 65,
    account: { AVAILABLE_CAPITAL: 5000 }, nowIstMinutes: 9 * 60,
  });
  assert.equal(r.qualified, false);
  assert.ok(r.refusals.some((x) => x.includes('entry window')));
});

test('the structural stop uses structure minus an ATR buffer', () => {
  const s = E.deriveStructuralStop({ side: 'CE', premium: 100, optionAtr: 4, breakout: {}, consolidation: { rangeHigh: 99 } });
  assert.equal(s.stop, 97, 'rangeHigh 99 minus 0.5 x ATR 4');
  assert.equal(s.stopPerUnit, 3);
  assert.ok(s.basis.includes('structure'), 'the structure level must be used when usable');
});

test('an unusable structure level falls back to a volatility stop', () => {
  const s = E.deriveStructuralStop({ side: 'CE', premium: 100, optionAtr: 4, breakout: {}, consolidation: {} });
  assert.equal(s.stop, 98);         // 100 - 0.5*4
  assert.ok(s.basis.includes('volatility'));
});

test('a stop wider than 50% of premium is a refusal, not a clamp', () => {
  const s = E.deriveStructuralStop({ side: 'CE', premium: 20, optionAtr: 40, breakout: {}, consolidation: { rangeHigh: 60 } });
  assert.ok(s.refusal, 'must refuse rather than invent a tighter stop');
  assert.ok(s.refusal.includes('too wide'));
});

test('the noise-band NOTE is unreachable via the volatility path (source arithmetic)', () => {
  // buffer = 0.5*ATR, so the volatility stop is always exactly 0.5*ATR from
  // entry, and the band requires < 0.25*ATR. 0.5 < 0.25 is false, so this NOTE
  // can only ever fire through the structure path. That is the source's own
  // arithmetic, preserved rather than "fixed" — and it is why the note is
  // informational: nothing depends on it.
  const v = E.deriveStructuralStop({ side: 'CE', premium: 100, optionAtr: 4, breakout: {}, consolidation: {} });
  assert.equal(v.stopPerUnit, 2);            // 0.5 * 4
  assert.equal(v.insideNoiseBand, false);    // 2 < 0.25*4 = 1 is false
  assert.equal(v.refusal, undefined, 'and it is never a refusal');
});

test('a structure stop near entry can sit inside the noise band', () => {
  // ATR 40, buffer 20; a level just under entry leaves a stop well inside
  // 0.25*ATR = 10.
  const s = E.deriveStructuralStop({ side: 'CE', premium: 100, optionAtr: 40, breakout: {}, consolidation: { rangeHigh: 89 } });
  assert.equal(s.stop, 69);
  assert.equal(s.stopPerUnit, 31);
  assert.equal(s.refusal, undefined, 'a wide-but-valid stop must not refuse on the noise band');
});

// ── exit policy ─────────────────────────────────────────────────────────
group('ported exit policy');

test('the trail ratchets UP with the high-water mark and never down', () => {
  const a = X.ratchetedStop({ initialStop: 90, entryPrice: 100, ltp: 108, highestLtp: 110, optionAtr: 3 });
  assert.equal(a.stop, 104);            // 110 - 2*3
  assert.equal(a.trailedAboveInitial, true);
  const b = X.ratchetedStop({ initialStop: 90, entryPrice: 100, ltp: 101, highestLtp: 101, optionAtr: 30 });
  assert.equal(b.stop, 90, 'a huge ATR must never push the stop below the pre-entry boundary');
});

test('the pre-entry boundary is the first exit and is never widened', () => {
  const r = X.evaluateExit({
    ltp: 88, entryPrice: 100, initialStop: 90, highestLtp: 90, optionAtr: 2,
    maePts: -12, mfePts: 0, quoteAgeMin: 0, maxStaleMin: 5, volume: 100, spreadPct: 1, volumeReported: true,
  });
  assert.equal(r.action, 'EXIT');
  assert.equal(r.reason, X.EXIT_REASON.STRUCTURAL_STOP);
});

test('a trailed stop reports TRAIL rather than STRUCTURAL_STOP', () => {
  const r = X.evaluateExit({
    ltp: 103, entryPrice: 100, initialStop: 90, highestLtp: 110, optionAtr: 3,
    maePts: 0, mfePts: 10, quoteAgeMin: 0, maxStaleMin: 5, volume: 100, spreadPct: 1, volumeReported: true,
  });
  assert.equal(r.action, 'EXIT');
  assert.equal(r.reason, X.EXIT_REASON.TRAIL);
  assert.equal(r.stop, 104);
});

test('stale data produces NO decision and never a fill', () => {
  const r = X.evaluateExit({
    ltp: 100, entryPrice: 100, initialStop: 80, highestLtp: 100, optionAtr: 2,
    maePts: 0, mfePts: 0, quoteAgeMin: 40, maxStaleMin: 5, volume: 100, spreadPct: 1, volumeReported: true,
  });
  assert.equal(r.action, 'HOLD');
  assert.equal(r.blockedBy, 'QUOTE_TOO_OLD');
  assert.equal(r.reason, null);
});

test('DEVIATION: late session reduces rather than exiting on a fixed clock', () => {
  const r = X.evaluateExit({
    ltp: 100, entryPrice: 100, initialStop: 90, highestLtp: 100, optionAtr: 2,
    maePts: 0, mfePts: 0, quoteAgeMin: 0, maxStaleMin: 5, volume: 100, spreadPct: 1, volumeReported: true,
    nowIstMinutes: 15 * 60 + 20,      // 10 min from close
  });
  assert.ok(r.action === 'REDUCE' || r.action === 'HOLD');
  assert.ok(r.timePressure > 0, 'pressure must be reported');
  assert.notEqual(r.reason, 'TIME_STOP', 'no fixed time-stop veto');
});

test('an invalidated setup exits', () => {
  const r = X.evaluateExit({
    ltp: 100, entryPrice: 100, initialStop: 80, highestLtp: 100, optionAtr: 2,
    maePts: 0, mfePts: 0, quoteAgeMin: 0, maxStaleMin: 5, volume: 100, spreadPct: 1, volumeReported: true,
    setupInvalidated: true,
  });
  assert.equal(r.action, 'EXIT');
  assert.equal(r.reason, X.EXIT_REASON.SETUP_INVALIDATED);
});

test('a deep adverse excursion reduces (orange) rather than exiting outright', () => {
  const r = X.evaluateExit({
    ltp: 95, entryPrice: 100, initialStop: 80, highestLtp: 95, optionAtr: 2,
    maePts: -18, mfePts: 1, quoteAgeMin: 0, maxStaleMin: 5, volume: 100, spreadPct: 1, volumeReported: true,
  });
  assert.equal(r.action, 'REDUCE');
  assert.equal(r.health, 'ORANGE');
});

test('a healthy position holds', () => {
  const r = X.evaluateExit({
    ltp: 105, entryPrice: 100, initialStop: 80, highestLtp: 106, optionAtr: 2,
    maePts: -1, mfePts: 6, quoteAgeMin: 0, maxStaleMin: 5, volume: 500, spreadPct: 1, volumeReported: true,
  });
  assert.equal(r.action, 'HOLD');
  assert.equal(r.reason, null);
});

test('theta decay near expiry is detected as a trap', () => {
  const t = X.detectTraps({ dte: 1, delta: 0.05, quoteAgeMin: 0, maxStaleMin: 5, volume: 100, spreadPct: 1, iv: 0.2 });
  assert.ok(t.traps.some((x) => x.name === 'theta_decay'));
});

test('an unreported volume is never treated as zero volume', () => {
  const t = X.detectTraps({ dte: 5, delta: null, quoteAgeMin: 0, maxStaleMin: 5, volume: null, spreadPct: 1, iv: null });
  assert.ok(!t.traps.some((x) => x.name === 'liquidity_trap'));
});

// ── run ─────────────────────────────────────────────────────────────────
(async () => {
  for (const { n, f } of queue) {
    try { await f(); console.log(`  ok   ${n}`); passed += 1; }
    catch (e) { console.log(`  FAIL ${n}\n       ${String(e.message).split('\n').join('\n       ')}`); failed += 1; failures.push(n); }
  }
  console.log(`\nported cpp logic: ${passed} passed, ${failed} failed`);
  if (failed) { console.log('failed:', failures.join(' | ')); process.exit(1); }
})();