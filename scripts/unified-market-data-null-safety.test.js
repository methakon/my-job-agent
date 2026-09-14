#!/usr/bin/env node
/**
 * Stage 1 (D4 + D5) — absence is NOT zero, and the index/underlying snapshot now
 * has somewhere to keep its book.
 *
 * The defect being guarded: `volume: finite(x) ?? 0` turned "the provider sent
 * nothing" into a real 0, so a manufactured 0 and a genuine 0 became the same
 * stored value. These tests prove that is no longer possible, at BOTH layers:
 *   - behaviour  (ingestQuote / ingestSnapshot)      — what gets written
 *   - schema     (entity metadata)                   — what CAN be written
 *
 * Pure logic against fake repositories. No DB, no Nest, no network.
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { UnifiedMarketDataService } = require('../dist/trading/unified-market-data/unified-market-data.service.js');
const { UnifiedOptionQuote } = require('../dist/trading/unified-market-data/unified-option-quote.entity.js');
const { UnifiedMarketSnapshot } = require('../dist/trading/unified-market-data/unified-market-snapshot.entity.js');
const { getMetadataArgsStorage } = require('typeorm');

function fakeRepo() {
  const saved = [];
  return { saved, create: (row) => row, save: async (row) => (saved.push(row), row) };
}
function service() {
  const quotes = fakeRepo();
  const snapshots = fakeRepo();
  return { svc: new UnifiedMarketDataService(quotes, snapshots), quotes, snapshots };
}

/** Column options the entity actually declares (what the DB is told to be). */
function columnOptions(target, propertyName) {
  const column = getMetadataArgsStorage().columns.find(
    (c) => c.target === target && c.propertyName === propertyName,
  );
  assert.ok(column, `entity declares column ${propertyName}`);
  return column.options;
}

async function main() {
  // ── D4.1  Option quote: values the provider did NOT send stay NULL ─────────
  {
    const { svc } = service();
    const row = await svc.ingestQuote({
      instrumentKey: 'NSE:NIFTY26SEP25600CE',
      ltp: 120.5,
      source: 'FYERS_LIVE',
      // volume / oi deliberately absent, as a provider that does not publish them
    });
    assert.equal(row.volume, null, 'absent volume persists as NULL, never 0');
    assert.equal(row.oi, null, 'absent oi persists as NULL, never 0');
    assert.notEqual(row.volume, 0, 'absent volume is NOT the number zero');
    assert.notEqual(row.oi, 0, 'absent oi is NOT the number zero');
  }

  // ── D4.2  A GENUINE zero is preserved as zero, and is distinguishable ─────
  {
    const { quotes, svc } = service();
    const absent = await svc.ingestQuote({ instrumentKey: 'NSE:A', ltp: 10, source: 'FYERS_LIVE' });
    const zero = await svc.ingestQuote({ instrumentKey: 'NSE:B', ltp: 10, volume: 0, oi: 0, source: 'FYERS_LIVE' });
    assert.equal(zero.volume, 0, 'a provider-published 0 volume is stored as 0');
    assert.equal(zero.oi, 0, 'a provider-published 0 oi is stored as 0');
    assert.notStrictEqual(absent.volume, zero.volume, 'missing and zero are NOT the same value');
    assert.equal(quotes.saved.length, 2);
  }

  // ── D4.3  Non-finite / junk inputs are absent, never 0 ────────────────────
  for (const junk of [undefined, null, '', 'abc', Number.NaN, Number.POSITIVE_INFINITY]) {
    const { svc } = service();
    const row = await svc.ingestQuote({ instrumentKey: 'NSE:C', ltp: 10, volume: junk, oi: junk, source: 'FYERS_LIVE' });
    assert.equal(row.volume, null, `volume ${String(junk)} → NULL`);
    assert.equal(row.oi, null, `oi ${String(junk)} → NULL`);
  }

  // ── D4.4  Snapshot volume behaves the same way ────────────────────────────
  {
    const { svc } = service();
    const absent = await svc.ingestSnapshot({ instrumentKey: 'NSE:NIFTY50-INDEX', ltp: 25600, source: 'FYERS_LIVE' });
    const zero = await svc.ingestSnapshot({
      instrumentKey: 'NSE:NIFTY50-INDEX', ltp: 25600, volume: 0, source: 'FYERS_LIVE',
    });
    assert.equal(absent.volume, null, 'absent snapshot volume → NULL');
    assert.equal(zero.volume, 0, 'published 0 snapshot volume → 0');
    assert.notStrictEqual(absent.volume, zero.volume, 'missing and zero differ for snapshots too');
  }

  // ── D5.1  Index/underlying L1 sizes + depth now persist ───────────────────
  {
    const { snapshots, svc } = service();
    const depth = { providerDepth: { buy: [{ price: 25599.9, quantity: 120 }], sell: [{ price: 25600.1, quantity: 80 }] } };
    const row = await svc.ingestSnapshot({
      instrumentKey: 'NSE:NIFTY50-INDEX',
      ltp: 25600,
      bid: 25599.9,
      ask: 25600.1,
      bidQty: 120,
      askQty: 80,
      depth,
      source: 'FYERS_LIVE',
    });
    assert.equal(row.bid, 25599.9, 'index bid persisted');
    assert.equal(row.ask, 25600.1, 'index ask persisted');
    assert.equal(row.bidQty, 120, 'index bidQty persisted (was dropped on write before D5)');
    assert.equal(row.askQty, 80, 'index askQty persisted');
    assert.deepEqual(row.depth, depth, 'index depth block persisted');
    assert.ok(snapshots.saved.length === 1);
  }

  // ── D5.2  Absent book stays NULL, is not invented ────────────────────────
  {
    const { svc } = service();
    const row = await svc.ingestSnapshot({ instrumentKey: 'NSE:NIFTY50-INDEX', ltp: 25600, source: 'FYERS_LIVE' });
    for (const f of ['bid', 'ask', 'bidQty', 'askQty', 'depth']) {
      assert.equal(row[f], null, `absent ${f} stays NULL`);
    }
  }

  // ── D4.5/D5.3  Schema: the DB must be able to hold what the code writes ───
  {
    const vol = columnOptions(UnifiedOptionQuote, 'volume');
    const oi = columnOptions(UnifiedOptionQuote, 'oi');
    assert.equal(vol.nullable, true, 'unified_option_quotes.volume is nullable');
    assert.equal(oi.nullable, true, 'unified_option_quotes.oi is nullable');
    assert.equal(vol.default, undefined, 'volume has no fabricated DB default');
    assert.equal(oi.default, undefined, 'oi has no fabricated DB default');

    const snapVol = columnOptions(UnifiedMarketSnapshot, 'volume');
    assert.equal(snapVol.nullable, true, 'unified_market_snapshots.volume is nullable');
    assert.equal(snapVol.default, undefined, 'snapshot volume has no fabricated DB default');

    for (const f of ['bid', 'ask', 'bidQty', 'askQty', 'depth']) {
      assert.equal(columnOptions(UnifiedMarketSnapshot, f).nullable, true, `snapshot ${f} column is nullable`);
    }
  }

  // ── The migration must exist and be the thing that relaxes the schema ────
  {
    const dir = path.join(__dirname, '..', 'src', 'migration');
    const file = fs.readdirSync(dir).find((f) => /NullPreservingVolumeOiAndIndexDepth/.test(f));
    assert.ok(file, 'Stage-1 migration is present');
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    assert.ok(/MODIFY COLUMN volume DECIMAL\(18,2\) NULL/.test(sql), 'migration relaxes quote volume to NULL');
    assert.ok(/MODIFY COLUMN oi DECIMAL\(18,2\) NULL/.test(sql), 'migration relaxes quote oi to NULL');
    assert.ok(/ADD COLUMN bid/.test(sql), 'migration adds index bid column');
    assert.ok(/canonicalKey/.test(sql), 'migration adds the pre-open canonical key');
    assert.ok(/public async down/.test(sql), 'migration is reversible');
  }

  console.log('unified-market-data null-safety (D4/D5): ALL PASS');
}

main().catch((err) => {
  console.error('FAIL:', err && err.message ? err.message : err);
  process.exit(1);
});
