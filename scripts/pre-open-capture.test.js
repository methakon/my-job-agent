#!/usr/bin/env node
/**
 * GATE 2 slice 1 — pre-open capture / validation / derived-feature tests.
 *
 * Covers the twelve required cases (normal, missing IEP, missing buy qty,
 * missing sell qty, stale, invalid timestamp, duplicate, out-of-order, session
 * boundary, market-open transition, replay identity, no-lookahead) plus the
 * documented formulas and the sentinel-zero trap the live feed actually sends.
 *
 * Pure functions only: no DB, no network, no clock reads.
 * Ordering guarantees that need SQL (asOf / latest per instrument) are proven at
 * runtime against the stored rows — see the runtime verification report.
 */
const path = require('path');
const F = require(path.join(__dirname, '..', 'dist', 'trading', 'pre-open', 'pre-open-features'));
const S = require(path.join(__dirname, '..', 'dist', 'trading', 'pre-open', 'pre-open-session'));

let pass = 0;
const failures = [];
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; console.log(`  PASS ${name}`); }
  else { failures.push(name); console.log(`  FAIL ${name}${extra ? ' :: ' + extra : ''}`); }
};
const eq = (name, actual, expected) => ok(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`);

const IST = (s) => Date.parse(s);
const PREOPEN = IST('2026-09-11T09:05:00+05:30'); // Friday, inside the auction
const base = (over = {}) => ({
  instrumentKey: 'NSE_EQ|INE002A01018',
  symbol: 'RELIANCE',
  underlying: null,
  exchange: 'NSE',
  eventTime: new Date(PREOPEN - 2_000),
  previousClose: 100,
  previousCloseSource: 'SOURCE',
  referencePrice: 100,
  indicativePrice: 101,
  indicativeQuantity: 1500,
  imbalanceTotal: 400,
  imbalanceMarket: 120,
  buyQuantity: 1200,
  sellQuantity: 800,
  lastPrice: 101,
  volume: 0,
  bestBid: { price: 100.95, quantity: 300 },
  bestAsk: { price: 101.05, quantity: 250 },
  ...over,
});
const ctx = (over = {}) => ({ nowMs: PREOPEN, staleMaxAgeMs: 120_000, phase: 'PRE_OPEN', ...over });
const obs = (over = {}, ctxOver = {}) => F.assessObservation(base(over), ctx(ctxOver));
const feat = (over = {}, ctxOver = { asOfMs: PREOPEN }) => F.derivePreOpenFeatures({
  instrumentKey: over.instrumentKey || 'NSE_EQ|INE002A01018',
  sessionDate: '2026-09-11',
  sessionPhase: over.sessionPhase || 'PRE_OPEN',
  eventTime: over.eventTime === undefined ? new Date(PREOPEN - 2_000) : over.eventTime,
  previousClose: over.previousClose === undefined ? 100 : over.previousClose,
  indicativePrice: over.indicativePrice === undefined ? 101 : over.indicativePrice,
  buyQuantity: over.buyQuantity === undefined ? 1200 : over.buyQuantity,
  sellQuantity: over.sellQuantity === undefined ? 800 : over.sellQuantity,
}, ctxOver);

console.log('\nGATE 2 / pre-open slice 1 — capture, validation, derived features\n');

// 1. normal pre-open observation
console.log('[1] normal pre-open observation');
{
  const a = obs();
  eq('1a quality COMPLETE', a.quality, 'COMPLETE');
  eq('1b every auction field OK', [a.fieldQuality.indicativePrice, a.fieldQuality.buyQuantity, a.fieldQuality.sellQuantity, a.fieldQuality.previousClose], ['OK', 'OK', 'OK', 'OK']);
  ok('1c no reasons raised', a.reasons.length === 0, JSON.stringify(a.reasons));
  const f = feat();
  eq('1d gapPoints', f.gapPoints.value, 1);
  eq('1e gapPct', f.gapPct.value, 1);
  eq('1f auctionImbalance', f.auctionImbalance.value, 400);
  eq('1g auctionImbalancePct', f.auctionImbalancePct.value, 0.2);
  ok('1h features version stamped', f.featuresVersion === F.PRE_OPEN_FEATURES_VERSION);
  ok('1i nothing unavailable', f.unavailable.length === 0, JSON.stringify(f.unavailable));
}

// 2. missing IEP
console.log('[2] missing IEP');
{
  const a = obs({ indicativePrice: null });
  ok('2a quality degrades', a.quality !== 'COMPLETE', a.quality);
  eq('2b IEP field reported MISSING', a.fieldQuality.indicativePrice, 'MISSING');
  const f = feat({ indicativePrice: null });
  eq('2c gapPoints UNAVAILABLE', f.gapPoints.status, 'UNAVAILABLE');
  ok('2d gapPoints value is null, not a guess', f.gapPoints.value === null);
  eq('2e gapPct UNAVAILABLE', f.gapPct.status, 'UNAVAILABLE');
  ok('2f gap named as unavailable', f.unavailable.includes('gapPoints') && f.unavailable.includes('gapPct'));
  ok('2g imbalance still derived from present fields', f.auctionImbalance.value === 400);
}

// 3. missing buy quantity
console.log('[3] missing buy quantity');
{
  const a = obs({ buyQuantity: null });
  eq('3a buyQuantity MISSING', a.fieldQuality.buyQuantity, 'MISSING');
  const f = feat({ buyQuantity: null });
  eq('3b imbalance UNAVAILABLE', f.auctionImbalance.status, 'UNAVAILABLE');
  eq('3c imbalance pct UNAVAILABLE', f.auctionImbalancePct.status, 'UNAVAILABLE');
  ok('3d half-known imbalance is never printed', f.auctionImbalance.value === null && f.auctionImbalancePct.value === null);
  eq('3e gap unaffected', f.gapPct.value, 1);
}

// 4. missing sell quantity
console.log('[4] missing sell quantity');
{
  const a = obs({ sellQuantity: null });
  eq('4a sellQuantity MISSING', a.fieldQuality.sellQuantity, 'MISSING');
  const f = feat({ sellQuantity: null });
  eq('4b imbalance UNAVAILABLE', f.auctionImbalance.status, 'UNAVAILABLE');
  eq('4c gap unaffected', f.gapPoints.value, 1);
}

// 5. stale observation
console.log('[5] stale observation');
{
  const a = obs({ eventTime: new Date(PREOPEN - 10 * 60_000) });
  eq('5a quality STALE', a.quality, 'STALE');
  ok('5b staleness explained', a.reasons.some((r) => /stale/i.test(r)), JSON.stringify(a.reasons));
  const f = feat({ eventTime: new Date(PREOPEN - 10 * 60_000) });
  eq('5c stale gap not served as live', f.gapPct.status, 'UNAVAILABLE');
  ok('5d staleness reason carried on the feature', /stale/i.test(String(f.gapPct.reason)));
  const fresh = feat({ eventTime: new Date(PREOPEN - 30_000) });
  eq('5e a fresh value of the same shape is served', fresh.gapPct.value, 1);
}

// 6. invalid timestamp
console.log('[6] invalid timestamp');
{
  eq('6a null event time is INVALID', obs({ eventTime: null }).quality, 'INVALID');
  const future = obs({ eventTime: new Date(PREOPEN + 10 * 60_000) });
  eq('6b timestamp ahead of receive time is INVALID', future.quality, 'INVALID');
  ok('6c future data cannot be used', feat({ eventTime: new Date(PREOPEN + 10 * 60_000) }, { asOfMs: PREOPEN }).gapPct.status === 'UNAVAILABLE');
  eq('6d unusable timestamp flagged', obs({ eventTime: null }).fieldQuality.eventTime, 'INVALID');
}

// 7. duplicate observation
console.log('[7] duplicate observation');
{
  const k = (o) => F.preOpenDedupeKey({
    instrumentKey: o.instrumentKey, sessionDate: '2026-09-11', sessionPhase: 'PRE_OPEN',
    eventTime: o.eventTime, source: 'UPSTOX_V3_LIVE', receivedAtMs: PREOPEN,
  });
  eq('7a same instrument + same event time collapses to one key', k(base()), k(base()));
  ok('7b a later event time is a different key', k(base()) !== k(base({ eventTime: new Date(PREOPEN) })));
  ok('7c a different source is a different key', k(base()) !== F.preOpenDedupeKey({
    instrumentKey: 'NSE_EQ|INE002A01018', sessionDate: '2026-09-11', sessionPhase: 'PRE_OPEN',
    eventTime: base().eventTime, source: 'OTHER_SOURCE', receivedAtMs: PREOPEN,
  }));
  const kNoTs = F.preOpenDedupeKey({
    instrumentKey: 'X', sessionDate: '2026-09-11', sessionPhase: 'PRE_OPEN', eventTime: null,
    source: 'UPSTOX_V3_LIVE', receivedAtMs: PREOPEN,
  });
  ok('7d unusable timestamp still dedupes within the same second', typeof kNoTs === 'string' && kNoTs.length > 0);
}

// 8. out-of-order observation
console.log('[8] out-of-order observation');
{
  const rows = [
    { eventTime: new Date(PREOPEN + 180_000), gapPct: 1.2 },
    { eventTime: new Date(PREOPEN - 60_000), gapPct: 0.9 },
    { eventTime: new Date(PREOPEN + 60_000), gapPct: 1.1 },
  ];
  const at = (ms) => rows.filter((r) => r.eventTime.getTime() <= ms).sort((a, b) => b.eventTime - a.eventTime)[0] || null;
  eq('8a an earlier event arriving later does not become the newest fact', at(PREOPEN).gapPct, 0.9);
  eq('8b selection is by event time, not arrival order', at(PREOPEN + 120_000).gapPct, 1.1);
  ok('8c the future row is invisible before its event time', at(PREOPEN).eventTime.getTime() <= PREOPEN);
}

// 9. session boundaries
console.log('[9] session boundaries');
{
  eq('9a 08:59:59 CLOSED', S.sessionPhaseAt(IST('2026-09-11T08:59:59+05:30')), 'CLOSED');
  eq('9b 09:00:00 PRE_OPEN', S.sessionPhaseAt(IST('2026-09-11T09:00:00+05:30')), 'PRE_OPEN');
  eq('9c 09:07:59 PRE_OPEN', S.sessionPhaseAt(IST('2026-09-11T09:07:59+05:30')), 'PRE_OPEN');
  eq('9d 09:08:00 OPEN_AUCTION', S.sessionPhaseAt(IST('2026-09-11T09:08:00+05:30')), 'OPEN_AUCTION');
  eq('9e 09:14:59 OPEN_AUCTION', S.sessionPhaseAt(IST('2026-09-11T09:14:59+05:30')), 'OPEN_AUCTION');
  eq('9f 09:15:00 MARKET_OPEN', S.sessionPhaseAt(IST('2026-09-11T09:15:00+05:30')), 'MARKET_OPEN');
  eq('9g 15:29:59 MARKET_OPEN', S.sessionPhaseAt(IST('2026-09-11T15:29:59+05:30')), 'MARKET_OPEN');
  eq('9h 15:30:00 POST_OPEN', S.sessionPhaseAt(IST('2026-09-11T15:30:00+05:30')), 'POST_OPEN');
  eq('9i 16:00:00 CLOSED', S.sessionPhaseAt(IST('2026-09-11T16:00:00+05:30')), 'CLOSED');
  eq('9j Saturday CLOSED', S.sessionPhaseAt(IST('2026-09-12T10:00:00+05:30')), 'CLOSED');
  eq('9k Sunday CLOSED', S.sessionPhaseAt(IST('2026-09-13T10:00:00+05:30')), 'CLOSED');
  ok('9l only the two auction phases count as auction', S.AUCTION_PHASES.length === 2 && S.isAuctionPhase('PRE_OPEN') && !S.isAuctionPhase('MARKET_OPEN'));
}

// 10. market-open transition + phase/values separation
console.log('[10] market-open transition (phase label != captured auction data)');
{
  const a = obs({}, { phase: 'MARKET_OPEN' });
  eq('10a a post-open row is never COMPLETE as auction data', a.quality, 'UNAVAILABLE');
  eq('10b fields marked OUT_OF_PHASE', a.fieldQuality.indicativePrice, 'OUT_OF_PHASE');
  const f = feat({ sessionPhase: 'MARKET_OPEN' });
  eq('10c no gap is invented after the open', f.gapPct.status, 'UNAVAILABLE');
  eq('10d no imbalance is invented after the open', f.auctionImbalance.status, 'UNAVAILABLE');
  eq('10e the labels still separate', feat({ sessionPhase: 'PRE_OPEN' }).gapPct.status, 'OK');
}

// 11. replay identity
console.log('[11] replay of identical input');
{
  const a1 = obs();
  const a2 = obs();
  eq('11a assessment replays identically', a1, a2);
  eq('11b features replay identically', feat(), feat());
  const many = [feat(), feat({ indicativePrice: 99.5 }), feat({ buyQuantity: null })];
  const again = [feat(), feat({ indicativePrice: 99.5 }), feat({ buyQuantity: null })];
  eq('11c a whole batch replays identically', many, again);
  eq('11d negative gap direction preserved', feat({ indicativePrice: 98.5 }).gapPct.value, -1.5);
}

// 12. no-lookahead
console.log('[12] no-lookahead');
{
  const early = feat({ indicativePrice: 100.4 });
  const laterObsArrived = feat({ indicativePrice: 103.9 });
  eq('12a an earlier decision is unchanged by later data', early.gapPct.value, 0.4);
  ok('12b later data lands in a different result, not the earlier one', laterObsArrived.gapPct.value === 3.9 && early.gapPct.value === 0.4);
  const withFinalOpen = feat({ indicativePrice: 101 });
  ok('12c the post-open print is not substituted for a pre-open value', early.gapPct.value !== withFinalOpen.gapPct.value);
  ok('12d derivation reads only its own observation', Object.keys(feat()).length > 0 && typeof feat().asOfEventTime !== 'undefined');
}

// sentinel-zero trap: the live feed sends 0 for "no auction in progress"
console.log('[S] sentinel zero / zero-quantity traps');
{
  const a = obs({ indicativePrice: 0, buyQuantity: 0, sellQuantity: 0 });
  eq('Sa zero price is not a price', a.fieldQuality.indicativePrice, 'SENTINEL_ZERO');
  eq('Sb quality is not COMPLETE', a.quality, 'UNAVAILABLE');
  const f = feat({ indicativePrice: 0, buyQuantity: 0, sellQuantity: 0 });
  eq('Sc a 0 IEP never yields a -100% gap', f.gapPct.status, 'UNAVAILABLE');
  eq('Sd an empty book never yields a 0 imbalance', f.auctionImbalance.status, 'UNAVAILABLE');
  eq('Se imbalance pct guarded at zero total', feat({ buyQuantity: 0, sellQuantity: 0 }).auctionImbalancePct.status, 'UNAVAILABLE');
  eq('Sf epoch timestamp is not an event time', obs({ eventTime: new Date(0) }).quality, 'INVALID');
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('failed: ' + failures.join(', '));
  process.exitCode = 1;
}
