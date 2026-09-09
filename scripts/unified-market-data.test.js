#!/usr/bin/env node
/**
 * UnifiedMarketDataService behavioral tests (brief s4/s5/s7/s8) — pure
 * normalization/quality/sequence/cache logic against fake repositories, no DB.
 *
 * Covers: normalized option + snapshot ingestion, provenance stamping,
 * per-source sequence numbers, GOOD/INVALID data-quality gate, latest-tick
 * cache (single source of truth for engines), source summaries, freshness.
 */
'use strict';
const assert = require('node:assert/strict');

const { UnifiedMarketDataService } = require('../dist/trading/unified-market-data/unified-market-data.service.js');

/** Fake TypeORM repository: create/save keep the row object as-is. */
function fakeRepo({ failSave = false } = {}) {
  const saved = [];
  return {
    saved,
    create: (row) => row,
    save: async (row) => {
      if (failSave) throw new Error('db unavailable (simulated)');
      saved.push(row);
      return row;
    },
  };
}

function service(fakes = {}) {
  const quotes = fakes.quotes ?? fakeRepo();
  const snapshots = fakes.snapshots ?? fakeRepo();
  return { svc: new UnifiedMarketDataService(quotes, snapshots), quotes, snapshots };
}

async function main() {
  // ── 1. Option quote: normalization + provenance + GOOD quality ────────────
  {
    const { svc, quotes } = service();
    const ts = '2026-09-10T10:15:30.000Z';
    const row = await svc.ingestQuote({
      instrumentKey: 'NSE:NIFTY26SEP25600CE',
      underlying: 'NIFTY',
      exchange: 'NSE',
      segment: 'FO',
      instrumentType: 'OPTION',
      expiry: '2026-09-24',
      strike: 25600,
      optionType: 'ce', // lowercased input must normalize to CE
      ltp: 125.5,
      bid: 125.05,
      ask: 125.95,
      bidQty: 150,
      askQty: 300,
      volume: 1234,
      oi: 98765,
      iv: 12.34,
      delta: 0.512345,
      gamma: 0.00123,
      source: 'FYERS_LIVE',
      sourceTimestamp: ts,
    });
    assert.ok(row, 'ingestQuote returns a row');
    assert.equal(row.instrumentKey, 'NSE:NIFTY26SEP25600CE');
    assert.equal(row.optionType, 'CE', 'optionType normalized to uppercase');
    assert.equal(row.ltp, 125.5);
    assert.equal(row.dataQuality, 'GOOD');
    assert.equal(row.source, 'FYERS_LIVE');
    assert.ok(row.sourceTimestamp instanceof Date && row.sourceTimestamp.toISOString() === ts, 'source ts preserved');
    assert.ok(row.receivedTimestamp instanceof Date, 'receive ts stamped');
    assert.equal(row.ts.toISOString(), ts, 'observation ts = source ts');
    assert.equal(row.sequenceNumber, 1, 'first source sequence = 1');
    assert.equal(quotes.saved.length, 1, 'row persisted exactly once');
  }

  // ── 2. Malformed: garbage source ts → INVALID; absent source ts → GOOD ────
  {
    const { svc } = service();
    const invalid = await svc.ingestQuote({
      instrumentKey: 'NSE:NIFTY26SEP25600PE',
      underlying: 'NIFTY',
      ltp: 5,
      source: 'FYERS_LIVE',
      sourceTimestamp: 'not-a-date',
    });
    assert.equal(invalid.dataQuality, 'INVALID', 'malformed source ts → INVALID');

    const noTs = await svc.ingestQuote({
      instrumentKey: 'NSE:NIFTY26SEP25600PE',
      underlying: 'NIFTY',
      ltp: 5,
      source: 'UPSTOX_LIVE',
    });
    assert.equal(noTs.dataQuality, 'GOOD', 'absent source ts falls back to receive time, stays GOOD');
  }

  // ── 3. No price at all → INVALID ──────────────────────────────────────────
  {
    const { svc } = service();
    const row = await svc.ingestQuote({
      instrumentKey: 'NSE:NIFTY26SEP25600CE',
      underlying: 'NIFTY',
      source: 'FYERS_LIVE',
    });
    assert.equal(row.dataQuality, 'INVALID', 'no ltp/bid/ask → INVALID');
  }

  // ── 4. Snapshot ingestion + latest cache ──────────────────────────────────
  {
    const { svc, snapshots } = service();
    const snap = await svc.ingestSnapshot({
      instrumentKey: 'NSE:NIFTY50-INDEX',
      underlying: 'NIFTY',
      exchange: 'NSE',
      segment: 'INDEX',
      instrumentType: 'INDEX',
      ltp: 25600.35,
      volume: 123456,
      source: 'FYERS_LIVE',
      sourceTimestamp: '2026-09-10T10:15:30.000Z',
    });
    assert.equal(snap.dataQuality, 'GOOD');
    assert.equal(svc.latestSnapshot('NSE:NIFTY50-INDEX').ltp, 25600.35);
    assert.equal(snapshots.saved.length, 1);
  }

  // ── 5. Per-source monotonic sequences ─────────────────────────────────────
  {
    const { svc } = service();
    assert.equal(svc.nextSequence('FYERS_LIVE'), 1);
    assert.equal(svc.nextSequence('UPSTOX_LIVE'), 1);
    assert.equal(svc.nextSequence('FYERS_LIVE'), 2);
  }

  // ── 6. Latest cache is the single source of truth for engines ─────────────
  {
    const { svc } = service();
    await svc.ingestQuote({
      instrumentKey: 'NSE:NIFTY26SEP25600CE', underlying: 'NIFTY', ltp: 100,
      source: 'FYERS_LIVE', sourceTimestamp: new Date(Date.now() - 5_000).toISOString(),
    });
    const cached = svc.latestQuote('NSE:NIFTY26SEP25600CE');
    assert.ok(cached, 'latest quote cached');
    assert.equal(cached.ltp, 100);
    const age = svc.quoteAgeMs('NSE:NIFTY26SEP25600CE');
    assert.ok(age !== null && age <= 10_000, `quoteAgeMs sane (${age})`);
    assert.equal(svc.listLatestQuotes().length, 1);
    assert.ok(svc.hasFreshData(60_000), 'fresh data within 60s window');
    assert.equal(svc.hasFreshData(1), false, 'not fresh within 1ms window');
  }

  // ── 7. Source summary (feed observability) ────────────────────────────────
  {
    const { svc } = service();
    await svc.ingestQuote({ instrumentKey: 'NSE:NIFTY26SEP25600CE', underlying: 'NIFTY', ltp: 10, source: 'FYERS_LIVE' });
    await svc.ingestSnapshot({ instrumentKey: 'NSE:NIFTY50-INDEX', ltp: 25600, source: 'FYERS_LIVE' });
    const summary = svc.sourceSummary();
    assert.equal(summary.FYERS_LIVE.ticks, 2, 'both quote + snapshot counted');
    assert.ok(summary.FYERS_LIVE.lastAt, 'lastAt recorded');
  }

  // ── 8. Empty instrument/source rejected ───────────────────────────────────
  {
    const { svc } = service();
    assert.equal(await svc.ingestQuote({ instrumentKey: '', source: 'FYERS_LIVE' }), null);
    assert.equal(await svc.ingestQuote({ instrumentKey: 'NSE:NIFTY26SEP25600CE', source: '  ' }), null);
    assert.equal(await svc.ingestSnapshot({ instrumentKey: '', source: 'FYERS_LIVE' }), null);
  }

  // ── 9. Persist failure does not lose the observation (cache-first) ────────
  {
    const quotes = fakeRepo({ failSave: true });
    const { svc } = service({ quotes });
    const row = await svc.ingestQuote({
      instrumentKey: 'NSE:NIFTY26SEP25600CE', underlying: 'NIFTY', ltp: 99,
      source: 'FYERS_LIVE', sourceTimestamp: '2026-09-10T10:15:30.000Z',
    });
    assert.ok(row, 'ingestQuote resolves even when DB save fails');
    assert.equal(svc.latestQuote('NSE:NIFTY26SEP25600CE').ltp, 99, 'cache still holds the tick');
  }

  // ── 10. reset() clears everything ─────────────────────────────────────────
  {
    const { svc } = service();
    await svc.ingestQuote({ instrumentKey: 'NSE:NIFTY26SEP25600CE', underlying: 'NIFTY', ltp: 1, source: 'FYERS_LIVE' });
    svc.reset();
    assert.equal(svc.listLatestQuotes().length, 0);
    assert.deepEqual(svc.sourceSummary(), {});
  }

  console.log('unified-market-data tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
