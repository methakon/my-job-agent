#!/usr/bin/env node
/**
 * Canonical LIVE tick interpreter (deterministic, provider-independent).
 *
 * Acceptance criteria being proven:
 *  - FYERS + Upstox (+ Zerodha) produce the SAME canonical schema from the same
 *    economic tick; provider field/symbol/timestamp differences are normalized;
 *  - invalid / impossible / too-late values are REJECTED with a code and never
 *    repaired or fabricated (absent stays absent — never 0);
 *  - provenance is preserved (source, broker's own id, payload hash, raw payload);
 *  - canonical ticks persist into the common store through one writer shape, and
 *    the store row maps back to canonical without broker-specific logic;
 *  - latency is measured, budget breaches are flagged and counted;
 *  - interpretation is deterministic (same input ⇒ same output) and involves no AI.
 *
 * Offline: fake repositories, no DB, no network.
 */
const assert = require('assert');

const {
  interpretObservation, canonicalInstrumentKey, parseOptionSymbol, normalizeExpiry,
  parseSourceTimestamp, payloadHash, DEFAULT_TICK_BUDGETS,
} = require('../dist/trading/unified-market-data/canonical/canonical-tick');
const { mapperFor, supportedProviders } = require('../dist/trading/unified-market-data/canonical/provider-mappers');
const {
  TickInterpreterService, canonicalToTickInput, canonicalFromStoredQuote,
} = require('../dist/trading/unified-market-data/canonical/tick-interpreter.service');
const { UnifiedMarketDataService } = require('../dist/trading/unified-market-data/unified-market-data.service');

let pass = 0;
const ok = (label) => { pass++; console.log(`  ${pass} ${label} ok`); };

const QUOTE_AT = new Date('2026-09-11T08:04:55.000Z');
const RECEIVED_AT = new Date('2026-09-11T08:04:55.400Z');

/** The SAME economic tick as each broker's native payload (NIFTY 26SEP 23000 PE). */
const fyersPayload = {
  symbol: 'NSE:NIFTY26SEP23000PE',
  ltp: 99.8, bid: 99.65, ask: 99.95, bid_size: 50, ask_size: 75,
  vol_traded_today: 12000, oi: 45000,
  exch_feed_time: '2026-09-11T08:04:55.000Z',
};
const upstoxPayload = {
  instrument_token: 'NSE_FO|NIFTY26SEP23000PE',
  last_price: 99.8, volume: 12000, oi: 45000,
  depth: { buy: [{ price: 99.65, quantity: 50 }], sell: [{ price: 99.95, quantity: 75 }] },
  timestamp: '2026-09-11T08:04:55.000Z',
};
const kitePayload = {
  instrument_token: 12345678,
  last_price: 99.8, volume_traded: 12000, oi: 45000,
  depth: { buy: [{ price: 99.65, quantity: 50 }], sell: [{ price: 99.95, quantity: 75 }] },
  exchange_timestamp: QUOTE_AT.getTime(),
};
const kiteResolve = (token) => (token === '12345678' ? { symbol: 'NIFTY26SEP23000PE', exchange: 'NSE' } : null);

const interpret = (source, payload, resolveSymbol) =>
  interpretObservation(
    source,
    mapperFor(source)(payload, { receivedAt: RECEIVED_AT, resolveSymbol }).observation,
    RECEIVED_AT,
  );

/** Economic content: everything except each broker's own provenance labels.
 *  `depth` is excluded too: it is the provider's own book shape, kept for audit —
 *  the NORMALIZED fields are bid/ask/bidQty/askQty. */
const core = (tick) => {
  const copy = { ...tick };
  for (const key of ['source', 'providerInstrumentId', 'raw', 'rawPayloadHash', 'sourceTimestampKind', 'depth']) delete copy[key];
  return copy;
};

async function main() {
  console.log('canonical LIVE tick interpreter tests\n');

  // ── 1. One canonical schema across FYERS / Upstox / Zerodha ────────────────
  {
    const fyers = interpret('FYERS_LIVE', fyersPayload);
    const upstox = interpret('UPSTOX_LIVE', upstoxPayload);
    const kite = interpret('ZERODHA_KITE', kitePayload, kiteResolve);
    for (const [name, result] of [['FYERS', fyers], ['UPSTOX', upstox], ['ZERODHA', kite]]) {
      assert.equal(result.ok, true, `${name} tick must be accepted (${result.ok ? '' : result.reason})`);
    }
    assert.equal(fyers.tick.instrumentKey, 'NSE:NIFTY26SEP23000PE');
    assert.equal(upstox.tick.instrumentKey, fyers.tick.instrumentKey, 'Upstox key form normalizes to the same identity');
    assert.equal(kite.tick.instrumentKey, fyers.tick.instrumentKey, 'Kite token+symbol normalizes to the same identity');
    assert.deepEqual(core(upstox.tick), core(fyers.tick), 'Upstox and FYERS share one canonical schema');
    assert.deepEqual(core(kite.tick), core(fyers.tick), 'Zerodha shares the SAME canonical schema');
    assert.equal(fyers.tick.strike, 23000);
    assert.equal(fyers.tick.expiry, '2026-09-26');
    assert.equal(fyers.tick.optionType, 'PE');
    assert.equal(fyers.tick.instrumentType, 'OPTION');
    assert.equal(fyers.tick.underlying, 'NIFTY');
    assert.equal(fyers.tick.bid, 99.65);
    assert.equal(fyers.tick.ask, 99.95);
    assert.equal(fyers.tick.bidQty, 50);
    assert.equal(fyers.tick.askQty, 75);
    assert.equal(fyers.tick.volume, 12000);
    assert.equal(fyers.tick.oi, 45000);
    assert.equal(fyers.tick.sourceLagMs, 400, 'broker lag measured in ms');
    ok('FYERS + Upstox + Zerodha yield ONE canonical schema and identity');
  }

  // ── 2. Symbol normalization (identity, not guessing) ──────────────────────
  {
    assert.equal(canonicalInstrumentKey('NSE:NIFTY26SEP23000PE'), 'NSE:NIFTY26SEP23000PE');
    assert.equal(canonicalInstrumentKey('NSE_FO|NIFTY26SEP23000PE'), 'NSE:NIFTY26SEP23000PE');
    assert.equal(canonicalInstrumentKey('nifty26sep23000pe', 'NSE'), 'NSE:NIFTY26SEP23000PE');
    assert.equal(canonicalInstrumentKey('BSE:SENSEX26SEP74000CE'), 'BSE:SENSEX26SEP74000CE');
    assert.equal(canonicalInstrumentKey('NSE_INDEX|Nifty 50'), 'NSE:NIFTY50');
    assert.equal(canonicalInstrumentKey('NSE:NIFTY50-INDEX'), 'NSE:NIFTY50', 'index forms converge');
    assert.equal(canonicalInstrumentKey('999999'), '999999', 'a bare token is never invented into a symbol');
    assert.equal(canonicalInstrumentKey(''), null);
    assert.deepEqual(parseOptionSymbol('NSE:NIFTY26SEP23000PE', RECEIVED_AT), { underlying: 'NIFTY', expiry: '2026-09-26', strike: 23000, optionType: 'PE' });
    assert.deepEqual(parseOptionSymbol('NSE:BANKNIFTY26SEP58500CE', RECEIVED_AT), { underlying: 'BANKNIFTY', expiry: '2026-09-26', strike: 58500, optionType: 'CE' });
    assert.deepEqual(parseOptionSymbol('NSE:NIFTY26SEP', RECEIVED_AT), { underlying: null, expiry: null, strike: null, optionType: null });
    assert.equal(normalizeExpiry('26SEP2026'), '2026-09-26');
    assert.equal(normalizeExpiry('2026-09-26T00:00:00Z'), '2026-09-26');
    assert.equal(normalizeExpiry('26SEP'), null, 'a month-only expiry is never invented into a day');
    ok('provider symbol forms normalize to one identity; unparseable parts stay null');
  }

  // ── 3. Timestamp normalization ────────────────────────────────────────────
  {
    const iso = parseSourceTimestamp('2026-09-11T08:04:55.000Z');
    assert.equal(iso.getTime(), QUOTE_AT.getTime());
    assert.equal(parseSourceTimestamp(QUOTE_AT.getTime()).getTime(), QUOTE_AT.getTime(), 'epoch ms');
    assert.equal(parseSourceTimestamp(Math.floor(QUOTE_AT.getTime() / 1000)).getTime(), QUOTE_AT.getTime(), 'epoch seconds');
    assert.equal(parseSourceTimestamp(QUOTE_AT).getTime(), QUOTE_AT.getTime(), 'Date passthrough');
    assert.equal(parseSourceTimestamp('not-a-date'), null);
    assert.equal(parseSourceTimestamp(null), null);
    assert.equal(interpret('FYERS_LIVE', fyersPayload).tick.sourceTimestampKind, 'QUOTE');
    assert.equal(interpret('ZERODHA_KITE', kitePayload, kiteResolve).tick.sourceTimestampKind, 'EXCHANGE');
    const lastTrade = interpret('FYERS_LIVE', { symbol: 'NSE:NIFTY26SEP23000PE', ltp: 99.8, last_traded_time: RECEIVED_AT.toISOString() });
    assert.equal(lastTrade.tick.sourceTimestampKind, 'LAST_TRADE', 'a last-trade time is labelled, not treated as a quote time');
    const noTs = interpret('UPSTOX_LIVE', { instrument_token: 'NSE_FO|NIFTY26SEP23000PE', last_price: 99.8 });
    assert.equal(noTs.ok, true);
    assert.equal(noTs.tick.sourceTimestamp, null, 'an absent source time stays absent');
    assert.equal(noTs.tick.sourceLagMs, null);
    assert.equal(noTs.tick.latencyWithinBudget, true, 'nothing to measure is not a breach');
    ok('ISO / epoch-seconds / epoch-ms / Date / absent timestamps all normalize deterministically');
  }

  // ── 4. Invalid, impossible and stale values are REJECTED ──────────────────
  {
    const cases = [
      // An unknown broker never reaches interpretation: there is no adapter for it.
      ['unmapped broker', () => (mapperFor('SOME_NEW_BROKER') ? { ok: true } : { ok: false, code: 'UNSUPPORTED_PROVIDER', reason: 'no adapter' }), 'UNSUPPORTED_PROVIDER'],
      ['no identity', () => interpret('FYERS_LIVE', { ltp: 99.8 }), 'SCHEMA'],
      ['option missing strike/right', () => interpret('ZERODHA_KITE', { instrument_token: 999, last_price: 99.8, instrument_type: 'CE' }, () => ({ symbol: 'NIFTY26SEP', exchange: 'NSE' })), 'SCHEMA'],
      ['no price at all', () => interpret('FYERS_LIVE', { symbol: 'NSE:NIFTY26SEP23000PE', volume: 5 }), 'INVALID_VALUE'],
      ['zero ltp', () => interpret('FYERS_LIVE', { symbol: 'NSE:NIFTY26SEP23000PE', ltp: 0 }), 'IMPOSSIBLE_VALUE'],
      ['negative ltp', () => interpret('FYERS_LIVE', { symbol: 'NSE:NIFTY26SEP23000PE', ltp: -3 }), 'IMPOSSIBLE_VALUE'],
      ['negative volume', () => interpret('FYERS_LIVE', { symbol: 'NSE:NIFTY26SEP23000PE', ltp: 1, volume: -10 }), 'IMPOSSIBLE_VALUE'],
      ['negative oi', () => interpret('UPSTOX_LIVE', { instrument_token: 'NSE_FO|NIFTY26SEP23000PE', last_price: 1, oi: -5 }), 'IMPOSSIBLE_VALUE'],
      ['crossed book (bid > ask)', () => interpret('FYERS_LIVE', { symbol: 'NSE:NIFTY26SEP23000PE', bid: 100, ask: 99 }), 'IMPOSSIBLE_VALUE'],
      ['unparseable timestamp', () => interpret('FYERS_LIVE', { symbol: 'NSE:NIFTY26SEP23000PE', ltp: 1, exch_feed_time: 'yesterday' }), 'INVALID_TIMESTAMP'],
      ['future timestamp', () => interpretObservation('FYERS_LIVE', { providerInstrumentId: 'NSE:NIFTY26SEP23000PE', ltp: 1, sourceTimestamp: new Date(RECEIVED_AT.getTime() + 60_000), raw: {} }, RECEIVED_AT), 'FUTURE_TIMESTAMP'],
      ['stale quote', () => interpretObservation('FYERS_LIVE', { providerInstrumentId: 'NSE:NIFTY26SEP23000PE', ltp: 1, sourceTimestamp: new Date(RECEIVED_AT.getTime() - 120_000), sourceTimestampSemantics: 'QUOTE', raw: {} }, RECEIVED_AT), 'STALE'],
      ['stale last-trade', () => interpretObservation('FYERS_LIVE', { providerInstrumentId: 'NSE:NIFTY26SEP23000PE', ltp: 1, sourceTimestamp: new Date(RECEIVED_AT.getTime() - 1_800_000), sourceTimestampSemantics: 'LAST_TRADE', raw: {} }, RECEIVED_AT), 'STALE'],
      ['unresolved Kite token', () => interpret('ZERODHA_KITE', kitePayload, () => null), 'SCHEMA'],
    ];
    for (const [label, run, code] of cases) {
      const result = run();
      assert.equal(result.ok, false, `${label} must be rejected`);
      assert.equal(result.code, code, `${label}: expected ${code}, got ${result.code} (${result.reason})`);
      assert.ok(result.reason && result.reason.length > 5, 'a rejection always carries a human reason');
    }
    // A stale quote is inside its LAST_TRADE budget but outside the QUOTE budget.
    const aged = RECEIVED_AT.getTime() - 300_000;
    assert.equal(interpretObservation('FYERS_LIVE', { providerInstrumentId: 'NSE:NIFTY26SEP23000PE', ltp: 1, sourceTimestamp: new Date(aged), sourceTimestampSemantics: 'QUOTE', raw: {} }, RECEIVED_AT).code, 'STALE');
    assert.equal(interpretObservation('FYERS_LIVE', { providerInstrumentId: 'NSE:NIFTY26SEP23000PE', ltp: 1, sourceTimestamp: new Date(aged), sourceTimestampSemantics: 'LAST_TRADE', raw: {} }, RECEIVED_AT).ok, true,
      'the same age is acceptable as a last-trade time — semantics decide, not a blanket rule');
    ok('invalid / impossible / stale ticks are rejected with codes (never repaired)');
  }

  // ── 5. No fabrication: absent stays absent ────────────────────────────────
  {
    const thin = interpret('FYERS_LIVE', { symbol: 'NSE:NIFTY26SEP23000PE', ltp: 99.8 });
    assert.equal(thin.ok, true);
    for (const field of ['bid', 'ask', 'bidQty', 'askQty', 'volume', 'oi', 'previousOi', 'changeOi', 'iv', 'delta', 'gamma', 'theta', 'vega']) {
      assert.strictEqual(thin.tick[field], null, `${field} must stay null when the provider did not send it`);
    }
    assert.equal(thin.tick.close, null);
    assert.equal(payloadHash({ b: 1, a: 2 }), payloadHash({ a: 2, b: 1 }), 'payload hash is key-order independent');
    assert.notEqual(payloadHash({ a: 1 }), payloadHash({ a: 2 }), 'a different payload hashes differently');
    assert.deepEqual(thin.tick.raw, { symbol: 'NSE:NIFTY26SEP23000PE', ltp: 99.8 }, 'the raw payload is preserved verbatim');
    ok('nothing is fabricated: absent fields stay null and the raw payload is preserved');
  }

  // ── 6. Determinism + provenance ───────────────────────────────────────────
  {
    const a = interpret('FYERS_LIVE', fyersPayload);
    const b = interpret('FYERS_LIVE', fyersPayload);
    assert.deepEqual(a.tick, b.tick, 'same input ⇒ byte-identical canonical tick');
    assert.equal(a.tick.source, 'FYERS_LIVE');
    assert.equal(a.tick.providerInstrumentId, 'NSE:NIFTY26SEP23000PE');
    assert.equal(a.tick.rawPayloadHash, payloadHash(fyersPayload));
    const kiteTick = interpret('ZERODHA_KITE', kitePayload, kiteResolve).tick;
    assert.equal(kiteTick.providerInstrumentId, '12345678', "the broker's own token is kept as provenance");
    assert.notEqual(kiteTick.rawPayloadHash, a.tick.rawPayloadHash, 'different payloads keep distinct provenance');
    const upstoxTick = interpret('UPSTOX_LIVE', upstoxPayload).tick;
    assert.equal(upstoxTick.providerInstrumentId, 'NSE_FO|NIFTY26SEP23000PE', "Upstox's own key form is preserved");
    assert.equal(new Set([a.tick.instrumentKey, upstoxTick.instrumentKey, kiteTick.instrumentKey]).size, 1);
    ok('interpretation is deterministic and every provider keeps its provenance');
  }

  // ── 7. Latency measured, budget breach flagged, metrics aggregated ────────
  {
    const fast = interpret('FYERS_LIVE', fyersPayload);
    assert.equal(fast.tick.sourceLagMs, 400);
    assert.equal(fast.tick.latencyWithinBudget, true);
    const slow = interpretObservation('FYERS_LIVE', {
      providerInstrumentId: 'NSE:NIFTY26SEP23000PE', ltp: 1,
      sourceTimestamp: new Date(RECEIVED_AT.getTime() - 30_000), raw: {},
    }, RECEIVED_AT);
    assert.equal(slow.ok, true, '30s is inside the 60s quote budget: accepted, but flagged');
    assert.equal(slow.tick.sourceLagMs, 30_000);
    assert.equal(slow.tick.latencyWithinBudget, false, 'a breach of the latency budget is flagged, never hidden');

    const repo = () => ({ created: [], create(row) { this.created.push(row); return row; }, async save(row) { return { ...row, id: 'row-1' }; } });
    const quotes = repo();
    const snapshots = repo();
    const unified = new UnifiedMarketDataService(quotes, snapshots);
    const prevMode = process.env.TICK_INTERPRETER_MODE;
    process.env.TICK_INTERPRETER_MODE = 'shadow';
    const shadow = new TickInterpreterService(unified);
    assert.equal(shadow.currentMode, 'shadow');
    const shadowResult = await shadow.interpretAndPersist({ source: 'FYERS_LIVE', payload: fyersPayload, receivedAt: RECEIVED_AT });
    assert.equal(shadowResult.ok, true);
    assert.equal(quotes.created.length, 0, 'shadow mode measures only — it never writes');
    assert.equal(shadow.metrics().latency.samples, 1, 'latency is measured in shadow mode');
    assert.equal(shadow.metrics().latency.p50Ms, 400);

    process.env.TICK_INTERPRETER_MODE = 'on';
    const live = new TickInterpreterService(unified);
    assert.equal(live.currentMode, 'on');
    await live.interpretAndPersist({ source: 'UPSTOX_LIVE', payload: upstoxPayload, receivedAt: RECEIVED_AT });
    assert.equal(quotes.created.length, 1, 'the canonical tick is persisted into the common store');
    const row = quotes.created[0];
    assert.equal(row.instrumentKey, 'NSE:NIFTY26SEP23000PE');
    assert.equal(row.source, 'UPSTOX_LIVE', 'source provenance survives persistence');
    assert.equal(row.sequenceNumber, 1, 'the store stamps the sequence');
    assert.equal(Number(row.ltp), 99.8);
    assert.equal(row.dataQuality, 'GOOD');
    assert.equal(row.depth.providerInstrumentId, 'NSE_FO|NIFTY26SEP23000PE', 'provider identity is stored with the row');
    assert.equal(row.depth.payloadHash, payloadHash(upstoxPayload));

    const back = canonicalFromStoredQuote(row);
    assert.equal(back.instrumentKey, 'NSE:NIFTY26SEP23000PE');
    assert.equal(back.source, 'UPSTOX_LIVE');
    assert.equal(back.optionType, 'PE');
    assert.equal(back.providerInstrumentId, 'NSE_FO|NIFTY26SEP23000PE');
    assert.equal(back.rawPayloadHash, payloadHash(upstoxPayload));
    assert.equal(back.ltp, 99.8);

    // A rejected tick is never persisted and is counted by code.
    await live.interpretAndPersist({ source: 'FYERS_LIVE', payload: { symbol: 'NSE:NIFTY26SEP23000PE', ltp: -1 }, receivedAt: RECEIVED_AT });
    await live.interpretAndPersist({ source: 'MYSTERY_BROKER', payload: {}, receivedAt: RECEIVED_AT });
    assert.equal(quotes.created.length, 1, 'rejected ticks never reach the store');
    const metrics = live.metrics();
    assert.equal(metrics.accepted, 1);
    assert.equal(metrics.rejected, 2);
    assert.equal(metrics.rejectionsByCode.IMPOSSIBLE_VALUE, 1);
    assert.equal(metrics.rejectionsByCode.UNSUPPORTED_PROVIDER, 1);
    assert.equal(metrics.persisted, 1);
    assert.equal(metrics.lastSample.accepted, false);
    if (prevMode === undefined) delete process.env.TICK_INTERPRETER_MODE; else process.env.TICK_INTERPRETER_MODE = prevMode;
    ok('latency measured + flagged, metrics aggregated, canonical ticks persisted, rejects dropped');
  }

  // ── 8. Persisted shape is provider-independent ────────────────────────────
  {
    const mapping = canonicalToTickInput(interpret('FYERS_LIVE', fyersPayload).tick);
    assert.deepEqual(Object.keys(mapping).sort(), Object.keys(canonicalToTickInput(interpret('ZERODHA_KITE', kitePayload, kiteResolve).tick)).sort(),
      'every provider maps to the SAME store-input shape');
    assert.equal(mapping.instrumentKey, 'NSE:NIFTY26SEP23000PE');
    assert.equal(mapping.optionType, 'PE');
    assert.equal(mapping.strike, 23000);
    assert.equal(mapping.expiry, '2026-09-26');
    assert.equal(mapping.source, 'FYERS_LIVE');
    assert.ok(mapping.sourceTimestamp instanceof Date);
    const brokers = supportedProviders();
    for (const expected of ['FYERS', 'FYERS_LIVE', 'UPSTOX', 'UPSTOX_LIVE', 'ZERODHA', 'ZERODHA_KITE', 'KITE']) {
      assert.ok(brokers.includes(expected), `${expected} is a registered provider`);
    }
    assert.equal(mapperFor('nope'), null, 'an unknown provider has no mapper (rejected upstream)');
    assert.equal(DEFAULT_TICK_BUDGETS.maxQuoteLagMs, 60_000);
    ok('one provider-independent store shape for every broker; unknown brokers have no mapper');
  }

  // ── 9. Real provider envelopes (SDK wrapper / nested chain leg) ───────────
  {
    const repo = () => ({ created: [], create(row) { this.created.push(row); return row; }, async save(row) { return { ...row, id: 'row-1' }; } });
    const quotes = repo();
    const unified = new UnifiedMarketDataService(quotes, repo());
    process.env.TICK_INTERPRETER_MODE = 'on';
    const interpreter = new TickInterpreterService(unified);

    // FYERS SDK message: records wrapped in `d`, exch_feed_time in epoch SECONDS.
    interpreter.observe('FYERS_LIVE', {
      d: [{ symbol: 'NSE:NIFTY26SEP23000PE', ltp: 99.8, vol_traded_today: 12000, oi: 45000, exch_feed_time: Math.floor(QUOTE_AT.getTime() / 1000) }],
    }, RECEIVED_AT);
    // The same style message can carry several contracts at once.
    interpreter.observe('FYERS_LIVE', {
      d: [
        { symbol: 'NSE:NIFTY26SEP23000PE', ltp: 99.8, exch_feed_time: Math.floor(QUOTE_AT.getTime() / 1000) },
        { symbol: 'NSE:NIFTY26SEP23000CE', ltp: 120.5, exch_feed_time: Math.floor(QUOTE_AT.getTime() / 1000) },
        { symbol: 'NSE:NIFTY26SEP23000CE', ltp: -1, exch_feed_time: Math.floor(QUOTE_AT.getTime() / 1000) },
      ],
    }, RECEIVED_AT);
    // Upstox option-chain leg: market fields nested under market_data.
    interpreter.observe('UPSTOX_LIVE', {
      instrument_key: 'NSE_FO|NIFTY26SEP23000PE',
      option_greeks: { iv: 12.5 },
      market_data: { ltp: 99.8, volume: 12000, oi: 45000, bid_price: 99.65, ask_price: 99.95, bid_qty: 50, ask_qty: 75 },
    }, RECEIVED_AT);

    const metrics = interpreter.metrics();
    assert.equal(metrics.accepted, 4, 'every good record in a wrapped message is interpreted');
    assert.equal(metrics.rejected, 1, 'a bad record beside good ones is rejected alone');
    assert.equal(metrics.rejectionsByCode.IMPOSSIBLE_VALUE, 1);
    assert.equal(metrics.persisted, 0, 'the shadow hook interprets and measures only — it never writes');
    assert.equal(quotes.created.length, 0, 'nothing was persisted by observe()');

    // Persistence is the `on` path: the SAME real Upstox leg payload, now written.
    const leg = {
      instrument_key: 'NSE_FO|NIFTY26SEP23000PE',
      market_data: { ltp: 99.8, volume: 12000, oi: 45000, bid_price: 99.65, ask_price: 99.95, bid_qty: 50, ask_qty: 75 },
    };
    const written = await interpreter.interpretAndPersist({ source: 'UPSTOX_LIVE', payload: leg, receivedAt: RECEIVED_AT });
    assert.equal(written.ok, true);
    assert.equal(written.tick.instrumentKey, 'NSE:NIFTY26SEP23000PE', 'the Upstox key form lands on the canonical identity');
    assert.equal(quotes.created.length, 1);
    const pe = quotes.created[0];
    assert.equal(pe.instrumentKey, 'NSE:NIFTY26SEP23000PE');
    assert.equal(pe.optionType, 'PE');
    assert.equal(Number(pe.strike), 23000);
    assert.equal(Number(pe.oi), 45000);
    assert.equal(interpreter.metrics().persisted, 1);
    if (process.env.TICK_INTERPRETER_MODE === 'on') delete process.env.TICK_INTERPRETER_MODE;
    ok('real provider envelopes (SDK wrapper, nested chain leg, epoch seconds) interpret correctly');
  }

  console.log(`\n${pass} checks passed, 0 failed`);
}

main().catch((error) => {
  console.error(`\nFAILED: ${error.message}`);
  if (process.env.TICK_TEST_TRACE) console.error(error.stack);
  process.exit(1);
});
