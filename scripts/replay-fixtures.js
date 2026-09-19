#!/usr/bin/env node
/**
 * REPLAY/SIMULATION — Tick pipeline deterministic replay fixtures.
 *
 * PURPOSE: Prove that raw provider payloads → mapper → canonical tick interpreter
 * produces the correct safety state for every known scenario.  No live connections,
 * no DB, fully deterministic — same inputs always produce the same result.
 *
 * LABEL: ALL fixtures below are REPLAY/SIMULATION data.  Every raw payload is a
 * fabricated construction, not a real market tick.  The canonical tick interpretation
 * pipeline under test is the compiled canonical-tick.js from dist/.
 *
 * PIPELINE UNDER TEST:
 *   raw provider payload (FYERS / Upstox)
 *     → provider mapper (fyersMapper / upstoxMapper)
 *       → canonical tick interpreter (interpretObservation)
 *         → InterpreterResult { ok: true/false }
 *
 * RUN:  node scripts/replay-fixtures.js
 *
 * No external dependencies — uses only the compiled dist/ modules and node:assert.
 */
'use strict';

const assert = require('node:assert/strict');
const { interpretObservation, DEFAULT_TICK_BUDGETS } = require('../dist/trading/unified-market-data/canonical/canonical-tick');
const { fyersMapper, upstoxMapper } = require('../dist/trading/unified-market-data/canonical/provider-mappers');

/* ──────────────────────────────────────────────────────────────────────────
 * REPLAY/SIMULATION: Deterministic clock anchor.
 *
 * All "receivedAt" values are computed relative to this fixed reference so
 * that staleness and future-skew checks are reproducible across machines.
 * The source is a synthetic epoch, not a real trading timestamp.
 * ────────────────────────────────────────────────────────────────────────── */
const REFERENCE_TIME_MS = 1_700_000_000_000; // 2023-11-14T22:13:20Z (synthetic)
const receivedAt = new Date(REFERENCE_TIME_MS);

/* Tight budgets for deterministic testing (maxFutureSkewMs=5s, maxQuoteLagMs=60s) */
const TEST_BUDGETS = { ...DEFAULT_TICK_BUDGETS };

/* ──────────────────────────────────────────────────────────────────────────
 * REPLAY/SIMULATION: Provider raw payloads.
 *
 * Each object mimics the shape a real WebSocket or REST tick delivers from
 * FYERS or Upstox.  The fields are hand-crafted to exercise specific code
 * paths in the mapper → interpreter pipeline.
 * ────────────────────────────────────────────────────────────────────────── */

/** REPLAY/SIMULATION — FYERS normal option tick (NSE:NIFTY26SEP23000PE). */
const FYERS_NORMAL_TICK = {
  symbol: 'NSE:NIFTY26SEP23000PE',
  ltp: 125.50,
  lp: 125.50,
  last_traded_price: 125.50,
  vol_traded_today: 15234,
  volume: 15234,
  oi: 890123,
  open_interest: 890123,
  bid: 125.00,
  ask: 126.00,
  bid_price: 125.00,
  ask_price: 126.00,
  bid_size: 200,
  ask_size: 150,
  open_price: 110.00,
  high_price: 130.00,
  low_price: 105.00,
  prev_close_price: 118.25,
  exch_feed_time: REFERENCE_TIME_MS - 1000, // 1s before received (valid lag)
  last_traded_time: REFERENCE_TIME_MS - 1500,
  v: { lp: 125.50, ltp: 125.50, vol_traded_today: 15234, oi: 890123, bid: 125.00, ask: 126.00 },
};

/** REPLAY/SIMULATION — FYERS partial tick: ltp present, no bid/ask. */
const FYERS_PARTIAL_TICK = {
  symbol: 'NSE:NIFTY26SEP23500CE',
  ltp: 87.25,
  vol_traded_today: 5120,
  oi: 301200,
  exch_feed_time: REFERENCE_TIME_MS - 2000,
};

/** REPLAY/SIMULATION — FYERS missing all price fields (no ltp, bid, ask). */
const FYERS_MISSING_PRICES = {
  symbol: 'NSE:BANKNIFTY26SEP58000PE',
  vol_traded_today: 0,
  oi: 0,
  exch_feed_time: REFERENCE_TIME_MS - 500,
};

/** REPLAY/SIMULATION — FYERS numeric zero ltp (impossible value). */
const FYERS_ZERO_LTP = {
  symbol: 'NSE:NIFTY26SEP22500CE',
  ltp: 0,
  bid: 0,
  ask: 0,
  vol_traded_today: 100,
  oi: 5000,
  exch_feed_time: REFERENCE_TIME_MS - 500,
};

/** REPLAY/SIMULATION — FYERS negative volume (impossible value). */
const FYERS_NEGATIVE_VOLUME = {
  symbol: 'NSE:NIFTY26SEP23000PE',
  ltp: 100.00,
  bid: 99.50,
  ask: 100.50,
  vol_traded_today: -5,
  oi: 1200,
  exch_feed_time: REFERENCE_TIME_MS - 500,
};

/** REPLAY/SIMULATION — FYERS crossed book: bid > ask (impossible value). */
const FYERS_CROSSED_BOOK = {
  symbol: 'NSE:NIFTY26SEP23000PE',
  ltp: 125.50,
  bid: 130.00,
  ask: 120.00,
  vol_traded_today: 100,
  oi: 5000,
  exch_feed_time: REFERENCE_TIME_MS - 500,
};

/** REPLAY/SIMULATION — FYERS invalid (unparseable) timestamp. */
const FYERS_INVALID_TIMESTAMP = {
  symbol: 'NSE:NIFTY26SEP23000PE',
  ltp: 125.50,
  bid: 125.00,
  ask: 126.00,
  vol_traded_today: 100,
  oi: 5000,
  exch_feed_time: 'not-a-date-string-at-all',
};

/** REPLAY/SIMULATION — FYERS future skew: sourceTimestamp 10s ahead of receivedAt. */
const FYERS_FUTURE_SKEW = {
  symbol: 'NSE:NIFTY26SEP23000PE',
  ltp: 125.50,
  bid: 125.00,
  ask: 126.00,
  vol_traded_today: 100,
  oi: 5000,
  exch_feed_time: REFERENCE_TIME_MS + 10_000, // 10s in the future (>5s budget)
};

/** REPLAY/SIMULATION — FYERS stale tick: sourceTimestamp 120s old (>60s QUOTE budget). */
const FYERS_STALE_TICK = {
  symbol: 'NSE:NIFTY26SEP23000PE',
  ltp: 125.50,
  bid: 125.00,
  ask: 126.00,
  vol_traded_today: 100,
  oi: 5000,
  exch_feed_time: REFERENCE_TIME_MS - 120_000, // 120s old
};

/** REPLAY/SIMULATION — FYERS unknown instrument: numeric token, no resolution. */
const FYERS_UNKNOWN_INSTRUMENT = {
  symbol: '1234567', // pure numeric token — unresolvable
  ltp: 10.00,
  vol_traded_today: 100,
  oi: 500,
  exch_feed_time: REFERENCE_TIME_MS - 500,
};

/** REPLAY/SIMULATION — FYERS payload with no symbol at all. */
const FYERS_NO_SYMBOL = {
  ltp: 125.50,
  vol_traded_today: 100,
  oi: 500,
  exch_feed_time: REFERENCE_TIME_MS - 500,
};

/** REPLAY/SIMULATION — FYERS mal-formed: null payload. */
const FYERS_MALFORMED_NULL = null;

/** REPLAY/SIMULATION — FYERS mal-formed: string payload (not an object). */
const FYERS_MALFORMED_STRING = 'not a tick payload';

/** REPLAY/SIMULATION — Upstox normal option tick. */
const UPSTOX_NORMAL_TICK = {
  instrument_key: 'NSE_FO|NIFTY26SEP23000PE',
  trading_symbol: 'NIFTY26SEP23000PE',
  last_price: 125.50,
  volume: 15234,
  oi: 890123,
  bid: 125.00,
  ask: 126.00,
  bid_qty: 200,
  ask_qty: 150,
  ohlc: { open: 110.00, high: 130.00, low: 105.00, close: 118.25 },
  timestamp: REFERENCE_TIME_MS - 1000,
  instrument_type: 'OPT',
  strike_price: 23000,
  expiry: '2026-09-26',
  option_type: 'PE',
};

/** REPLAY/SIMULATION — Upstox missing all price fields (no last_price, bid, ask). */
const UPSTOX_MISSING_PRICES = {
  instrument_key: 'NSE_FO|BANKNIFTY26SEP58000PE',
  trading_symbol: 'BANKNIFTY26SEP58000PE',
  volume: 0,
  oi: 0,
  timestamp: REFERENCE_TIME_MS - 500,
  instrument_type: 'OPT',
  strike_price: 58000,
  expiry: '2026-09-26',
  option_type: 'PE',
};

/** REPLAY/SIMULATION — Upstox stale tick (>60s old for QUOTE). */
const UPSTOX_STALE_TICK = {
  instrument_key: 'NSE_FO|NIFTY26SEP23000PE',
  trading_symbol: 'NIFTY26SEP23000PE',
  last_price: 125.50,
  bid: 125.00,
  ask: 126.00,
  volume: 100,
  oi: 5000,
  timestamp: REFERENCE_TIME_MS - 120_000, // 120s old
  instrument_type: 'OPT',
  strike_price: 23000,
  expiry: '2026-09-26',
  option_type: 'PE',
};

/** REPLAY/SIMULATION — Upstox future skew: timestamp 10s ahead. */
const UPSTOX_FUTURE_SKEW = {
  instrument_key: 'NSE_FO|NIFTY26SEP23000PE',
  trading_symbol: 'NIFTY26SEP23000PE',
  last_price: 125.50,
  bid: 125.00,
  ask: 126.00,
  volume: 100,
  oi: 5000,
  timestamp: REFERENCE_TIME_MS + 10_000, // 10s in future
  instrument_type: 'OPT',
  strike_price: 23000,
  expiry: '2026-09-26',
  option_type: 'PE',
};

/* ──────────────────────────────────────────────────────────────────────────
 * REPLAY/SIMULATION: Pipeline simulator.
 *
 * Feeds a raw payload through: mapper → interpretObservation.
 * Returns the InterpreterResult plus the intermediate observation for
 * inspection.  Pure — no side effects, no DB, no network.
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * REPLAY/SIMULATION — Simulate the full tick pipeline for FYERS.
 * @param {object|null} rawPayload — The raw FYERS WebSocket/REST payload.
 * @param {Date}        [rxAt=receivedAt] — When the tick was "received" (synthetic).
 * @returns {{ mapperResult: object, interpreterResult: object }}
 */
function simulateFyersPipeline(rawPayload, rxAt = receivedAt) {
  const mapperResult = fyersMapper(rawPayload, {});
  if (!mapperResult.ok) {
    return {
      mapperResult,
      interpreterResult: { ok: false, code: 'SCHEMA', reason: mapperResult.reason, source: 'FYERS' },
    };
  }
  const interpreterResult = interpretObservation('FYERS', mapperResult.observation, rxAt, TEST_BUDGETS);
  return { mapperResult, interpreterResult };
}

/**
 * REPLAY/SIMULATION — Simulate the full tick pipeline for Upstox.
 * @param {object|null} rawPayload — The raw Upstox WebSocket/REST payload.
 * @param {Date}        [rxAt=receivedAt] — When the tick was "received" (synthetic).
 * @returns {{ mapperResult: object, interpreterResult: object }}
 */
function simulateUpstoxPipeline(rawPayload, rxAt = receivedAt) {
  const mapperResult = upstoxMapper(rawPayload, {});
  if (!mapperResult.ok) {
    return {
      mapperResult,
      interpreterResult: { ok: false, code: 'SCHEMA', reason: mapperResult.reason, source: 'UPSTOX' },
    };
  }
  const interpreterResult = interpretObservation('UPSTOX', mapperResult.observation, rxAt, TEST_BUDGETS);
  return { mapperResult, interpreterResult };
}

/* ──────────────────────────────────────────────────────────────────────────
 * REPLAY/SIMULATION: Test assertions.
 *
 * Each test exercises one scenario and asserts the safety state produced
 * by the interpreter.  "Safety state" = whether the tick was accepted or
 * rejected, and if rejected, which machine-readable RejectionCode applies.
 * ────────────────────────────────────────────────────────────────────────── */

const results = [];
let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    results.push({ name, status: 'PASS' });
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    results.push({ name, status: 'FAIL', error: err.message });
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
  }
}

function assertOk(result, expectedKey) {
  assert.equal(result.interpreterResult.ok, true, `expected ok:true, got ${JSON.stringify(result.interpreterResult)}`);
  if (expectedKey) {
    assert.equal(result.interpreterResult.tick.instrumentKey, expectedKey,
      `instrumentKey: expected "${expectedKey}", got "${result.interpreterResult.tick.instrumentKey}"`);
  }
}

function assertRejected(result, expectedCode, label) {
  assert.equal(result.interpreterResult.ok, false, `${label}: expected ok:false`);
  assert.equal(result.interpreterResult.code, expectedCode,
    `${label}: expected code "${expectedCode}", got "${result.interpreterResult.code}"`);
}

/* ─── REPLAY/SIMULATION: Execute all scenarios ─── */

console.log('\n═══════════════════════════════════════════════════════════════');
console.log('  REPLAY/SIMULATION — Tick Pipeline Deterministic Fixtures');
console.log('  All data below is synthetic. No live market data used.');
console.log('═══════════════════════════════════════════════════════════════\n');

/* ── Scenario 1: Normal FYERS option tick ── */
test('FYERS normal option tick → ok:true, correct instrument identity', () => {
  const r = simulateFyersPipeline(FYERS_NORMAL_TICK);
  assertOk(r, 'NSE:NIFTY26SEP23000PE');
  const t = r.interpreterResult.tick;
  assert.equal(t.instrumentType, 'OPTION');
  assert.equal(t.optionType, 'PE');
  assert.equal(t.strike, 23000);
  assert.equal(t.underlying, 'NIFTY');
  assert.equal(t.exchange, 'NSE');
  assert.equal(t.segment, 'FO');
  assert.equal(t.ltp, 125.50);
  assert.equal(t.bid, 125.00);
  assert.equal(t.ask, 126.00);
  assert.equal(t.volume, 15234);
  assert.equal(t.oi, 890123);
  assert.equal(t.dataQuality, 'GOOD');
  assert.equal(typeof t.rawPayloadHash, 'string');
  assert.ok(t.rawPayloadHash.length === 64, 'rawPayloadHash should be SHA-256 hex');
});

/* ── Scenario 2: Normal Upstox option tick ── */
test('Upstox normal option tick → ok:true, correct instrument identity', () => {
  const r = simulateUpstoxPipeline(UPSTOX_NORMAL_TICK);
  assertOk(r, 'NSE:NIFTY26SEP23000PE');
  const t = r.interpreterResult.tick;
  assert.equal(t.instrumentType, 'OPTION');
  assert.equal(t.optionType, 'PE');
  assert.equal(t.strike, 23000);
  assert.equal(t.underlying, 'NIFTY');
  assert.equal(t.ltp, 125.50);
  assert.equal(t.bid, 125.00);
  assert.equal(t.ask, 126.00);
  assert.equal(t.dataQuality, 'GOOD');
});

/* ── Scenario 3: Partial tick (ltp present, no bid/ask) ── */
test('FYERS partial tick (ltp only) → ok:true, bid/ask null', () => {
  const r = simulateFyersPipeline(FYERS_PARTIAL_TICK);
  assertOk(r, 'NSE:NIFTY26SEP23500CE');
  const t = r.interpreterResult.tick;
  assert.equal(t.optionType, 'CE');
  assert.equal(t.strike, 23500);
  assert.equal(t.ltp, 87.25);
  assert.equal(t.bid, null, 'bid should be absent');
  assert.equal(t.ask, null, 'ask should be absent');
  assert.equal(t.dataQuality, 'GOOD');
});

/* ── Scenario 4: Missing all price fields ── */
test('FYERS missing all prices → rejected INVALID_VALUE', () => {
  const r = simulateFyersPipeline(FYERS_MISSING_PRICES);
  assertRejected(r, 'INVALID_VALUE', 'FYERS missing prices');
});

/* ── Scenario 5: Upstox missing all price fields ── */
test('Upstox missing all prices → rejected INVALID_VALUE', () => {
  const r = simulateUpstoxPipeline(UPSTOX_MISSING_PRICES);
  assertRejected(r, 'INVALID_VALUE', 'Upstox missing prices');
});

/* ── Scenario 6: Numeric zero ltp ── */
test('FYERS zero ltp → rejected IMPOSSIBLE_VALUE', () => {
  const r = simulateFyersPipeline(FYERS_ZERO_LTP);
  assertRejected(r, 'IMPOSSIBLE_VALUE', 'FYERS zero ltp');
});

/* ── Scenario 7: Negative volume ── */
test('FYERS negative volume → rejected IMPOSSIBLE_VALUE', () => {
  const r = simulateFyersPipeline(FYERS_NEGATIVE_VOLUME);
  assertRejected(r, 'IMPOSSIBLE_VALUE', 'FYERS negative volume');
});

/* ── Scenario 8: Crossed book (bid > ask) ── */
test('FYERS crossed book (bid > ask) → rejected IMPOSSIBLE_VALUE', () => {
  const r = simulateFyersPipeline(FYERS_CROSSED_BOOK);
  assertRejected(r, 'IMPOSSIBLE_VALUE', 'FYERS crossed book');
});

/* ── Scenario 9: Duplicate ticks — identical canonical output ── */
test('FYERS duplicate tick → both ok:true, identical canonical key and hash', () => {
  const r1 = simulateFyersPipeline(FYERS_NORMAL_TICK);
  const r2 = simulateFyersPipeline(FYERS_NORMAL_TICK);
  assertOk(r1, 'NSE:NIFTY26SEP23000PE');
  assertOk(r2, 'NSE:NIFTY26SEP23000PE');
  assert.equal(r1.interpreterResult.tick.instrumentKey, r2.interpreterResult.tick.instrumentKey);
  assert.equal(r1.interpreterResult.tick.rawPayloadHash, r2.interpreterResult.tick.rawPayloadHash);
  assert.equal(r1.interpreterResult.tick.ltp, r2.interpreterResult.tick.ltp);
  assert.equal(r1.interpreterResult.tick.sourceLagMs, r2.interpreterResult.tick.sourceLagMs);
});

/* ── Scenario 10: Out-of-order (future skew) ── */
test('FYERS future skew (10s ahead) → rejected FUTURE_TIMESTAMP', () => {
  const r = simulateFyersPipeline(FYERS_FUTURE_SKEW);
  assertRejected(r, 'FUTURE_TIMESTAMP', 'FYERS future skew');
});

/* ── Scenario 11: Out-of-order Upstox ── */
test('Upstox future skew (10s ahead) → rejected FUTURE_TIMESTAMP', () => {
  const r = simulateUpstoxPipeline(UPSTOX_FUTURE_SKEW);
  assertRejected(r, 'FUTURE_TIMESTAMP', 'Upstox future skew');
});

/* ── Scenario 12: Stale tick ── */
test('FYERS stale tick (120s old) → rejected STALE', () => {
  const r = simulateFyersPipeline(FYERS_STALE_TICK);
  assertRejected(r, 'STALE', 'FYERS stale');
});

/* ── Scenario 13: Stale Upstox ── */
test('Upstox stale tick (120s old) → rejected STALE', () => {
  const r = simulateUpstoxPipeline(UPSTOX_STALE_TICK);
  assertRejected(r, 'STALE', 'Upstox stale');
});

/* ── Scenario 14: Unknown instrument (numeric token, no symbol) ── */
test('FYERS numeric token → ok:true with UNKNOWN instrument type (caller must resolve)', () => {
  const r = simulateFyersPipeline(FYERS_UNKNOWN_INSTRUMENT);
  assert.equal(r.interpreterResult.ok, true, 'numeric token should pass interpreter (not invented, not rejected)');
  assert.equal(r.interpreterResult.tick.instrumentType, 'UNKNOWN');
  assert.equal(r.interpreterResult.tick.instrumentKey, '1234567');
});

/* ── Scenario 15: No symbol at all ── */
test('FYERS no symbol field → rejected SCHEMA (mapper-level catch)', () => {
  const r = simulateFyersPipeline(FYERS_NO_SYMBOL);
  assert.equal(r.interpreterResult.ok, false, 'no symbol should be rejected');
  assert.equal(r.interpreterResult.code, 'SCHEMA');
});

/* ── Scenario 16: Invalid timestamp ── */
test('FYERS invalid timestamp → rejected INVALID_TIMESTAMP', () => {
  const r = simulateFyersPipeline(FYERS_INVALID_TIMESTAMP);
  assertRejected(r, 'INVALID_TIMESTAMP', 'FYERS invalid timestamp');
});

/* ── Scenario 17: Malformed null payload ── */
test('FYERS null payload → rejected SCHEMA', () => {
  const r = simulateFyersPipeline(FYERS_MALFORMED_NULL);
  assertRejected(r, 'SCHEMA', 'FYERS null payload');
});

/* ── Scenario 18: Malformed string payload ── */
test('FYERS string payload → rejected SCHEMA', () => {
  const r = simulateFyersPipeline(FYERS_MALFORMED_STRING);
  assertRejected(r, 'SCHEMA', 'FYERS string payload');
});

/* ── Scenario 19: Cross-provider identity equivalence ── */
test('FYERS and Upstox same contract → identical canonical instrumentKey', () => {
  const fyers = simulateFyersPipeline(FYERS_NORMAL_TICK);
  const upstox = simulateUpstoxPipeline(UPSTOX_NORMAL_TICK);
  assertOk(fyers, 'NSE:NIFTY26SEP23000PE');
  assertOk(upstox, 'NSE:NIFTY26SEP23000PE');
  assert.equal(fyers.interpreterResult.tick.instrumentKey, upstox.interpreterResult.tick.instrumentKey);
});

/* ── Scenario 20: Latency budget flag ── */
test('FYERS normal tick (1s lag) → latencyWithinBudget = true', () => {
  const r = simulateFyersPipeline(FYERS_NORMAL_TICK);
  assertOk(r);
  assert.equal(r.interpreterResult.tick.latencyWithinBudget, true, '1s lag should be within 5s budget');
  assert.ok(r.interpreterResult.tick.sourceLagMs <= 5000, 'sourceLagMs should be <= 5000');
});

/* ── Summary ── */
console.log('\n─────────────────────────────────────────────────────────────');
console.log(`  Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
console.log('─────────────────────────────────────────────────────────────\n');

const scenarios = results.map(r => r.name);

if (failed > 0) {
  process.exit(1);
}
