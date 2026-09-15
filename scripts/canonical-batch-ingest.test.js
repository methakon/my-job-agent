#!/usr/bin/env node
/**
 * Canonical ingest — batched transport + bounded queue (the LIVE-tape throughput fix).
 *
 * Proves the change is TRANSPORT ONLY:
 *  - every tick of ONE provider message is written in ONE batched call per bucket
 *    (not one awaited WAN write per record);
 *  - validation is unchanged: an invalid record is still rejected, counted, and
 *    never reaches the store; absence stays absence (nothing fabricated);
 *  - the queue bounds concurrency AND depth, and a message it cannot hold is
 *    DROPPED AND COUNTED — never silently absorbed, never faked as data;
 *  - a dropped message creates NO store row (the observation is simply absent).
 *
 * Offline: stub store, no DB, no network.
 */
const assert = require('assert');
const path = require('path');
const REPO = path.join(__dirname, '..');

process.env.CANONICAL_MAX_INGEST_INFLIGHT = '1';
process.env.CANONICAL_MAX_INGEST_QUEUE = '2';

const { TickInterpreterService } = require(path.join(REPO, 'dist', 'trading', 'unified-market-data', 'canonical', 'tick-interpreter.service'));

let pass = 0;
const ok = (label) => { pass += 1; console.log(`  ${pass} ${label} ok`); };

const NOW_ISO = new Date().toISOString();
const optPayload = (strike) => ({
  symbol: `NSE:NIFTY26SEP${strike}PE`,
  ltp: 99.8, bid: 99.65, ask: 99.95, bid_size: 50, ask_size: 75,
  vol_traded_today: 12000, oi: 45000,
  exch_feed_time: NOW_ISO,
});
const indexPath = { symbol: 'NSE:NIFTY50-INDEX', ltp: 23000.5, exch_feed_time: NOW_ISO };

class FakeUnified {
  constructor(opts = {}) {
    this.quoteBatches = [];
    this.snapshotBatches = [];
    this.singleWrites = 0;
    this.delayMs = opts.delayMs ?? 0;
  }
  _row(prefix, key, field) { return { id: `${prefix}-${key}`, [field]: key }; }
  async ingestQuotes(inputs) {
    this.quoteBatches.push(inputs);
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    return inputs.map((i) => this._row('q', i.instrumentKey, 'instrumentKey'));
  }
  async ingestSnapshots(inputs) {
    this.snapshotBatches.push(inputs);
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    return inputs.map((i) => this._row('s', i.instrumentKey, 'symbol'));
  }
  async ingestQuote(input) { this.singleWrites += 1; return this._row('q', input.instrumentKey, 'instrumentKey'); }
  async ingestSnapshot(input) { this.singleWrites += 1; return this._row('s', input.instrumentKey, 'symbol'); }
}

(async () => {
  // ── [A] the batched path and its reported state ────────────────────────────
  console.log('\n[A] batched transport');
  {
    const store = new FakeUnified();
    const svc = new TickInterpreterService(store);
    assert.strictEqual(await svc.persistMany([]), 0, 'an empty batch writes nothing');
    ok('an empty message writes nothing and cannot crash');

    const outcome = await svc.ingestMessage('FYERS_LIVE', [optPayload(23000), optPayload(23100), optPayload(23200), indexPath]);
    assert.strictEqual(store.quoteBatches.length, 1, `expected ONE batched option write, got ${store.quoteBatches.length}`);
    assert.strictEqual(store.quoteBatches[0].length, 3, 'all three option ticks travel in that one batch');
    assert.strictEqual(store.snapshotBatches.length, 1, 'the index tick is batched too');
    assert.strictEqual(store.singleWrites, 0, 'no per-record awaited write remains on the message path');
    assert.strictEqual(outcome.accepted, 4, 'all four records validated');
    assert.strictEqual(outcome.persisted, 4, 'persisted counts every tick written');
    ok('a 4-record message costs ONE batched write per bucket, not 4 awaited writes');
    ok('outcome counts stay truthful under batching');
    assert.strictEqual(svc.metrics().droppedUnderLoad, 0, 'nothing dropped when the queue is not under load');
  }

  // ── [B] validation is unchanged ────────────────────────────────────────────
  console.log('\n[B] validation unchanged (transport only)');
  {
    const store = new FakeUnified();
    const svc = new TickInterpreterService(store);
    // A tick with NO price at all is not market data (no ltp/bid/ask).
    const bad = { symbol: 'NSE:NIFTY26SEP23000PE', exch_feed_time: NOW_ISO };
    const outcome = await svc.ingestMessage('FYERS_LIVE', [optPayload(23000), bad]);
    assert.strictEqual(outcome.accepted, 1, 'only the valid tick is accepted');
    assert.strictEqual(outcome.rejected, 1, 'the invalid tick is rejected and counted');
    assert.strictEqual(outcome.persisted, 1, 'the rejected tick is not persisted');
    const written = store.quoteBatches.flat().map((i) => i.instrumentKey);
    assert.deepStrictEqual(written, ['NSE:NIFTY26SEP23000PE'], 'only the valid tick reached the store');
    ok('an invalid record is still rejected, counted and never stored');
    ok('nothing is fabricated for a rejected record');
  }

  // ── [C] back-pressure: bounded concurrency AND depth ───────────────────────
  console.log('\n[C] bounded queue');
  {
    const store = new FakeUnified({ delayMs: 15 });
    const svc = new TickInterpreterService(store);
    const total = 12;
    let accepted = 0;
    for (let i = 0; i < total; i += 1) {
      if (svc.enqueueMessage('FYERS_LIVE', [optPayload(23000 + i * 100)])) accepted += 1;
    }
    assert.ok(accepted < total, `the queue must refuse some of ${total} messages (accepted ${accepted})`);
    assert.strictEqual(svc.metrics().droppedUnderLoad, total - accepted, 'every refusal is counted as dropped');
    assert.ok(svc.metrics().ingestQueueDepth <= 2, 'queue depth stays bounded');
    assert.ok(svc.metrics().ingestInFlight <= 1, 'concurrency stays bounded by CANONICAL_MAX_INGEST_INFLIGHT');
    ok(`queue bounds both depth and concurrency (accepted ${accepted}/${total}, dropped ${total - accepted})`);

    // Drain, then prove the dropped messages created NO rows: the store saw exactly
    // one row per accepted message — absence stayed absence.
    await new Promise((r) => setTimeout(r, 400));
    const rows = store.quoteBatches.flat().length;
    assert.strictEqual(rows, accepted, `store holds one row per accepted message (${rows} vs ${accepted})`);
    assert.strictEqual(svc.metrics().droppedUnderLoad, total - accepted, 'the drop count does not change while draining');
    assert.strictEqual(svc.metrics().ingestQueueDepth, 0, 'the queue fully drains');
    assert.strictEqual(svc.metrics().ingestInFlight, 0, 'no work is left in flight');
    ok('a dropped message creates no store row (ABSENT, never fabricated)');
    ok('the queue drains to empty with nothing left in flight');
  }

  // ── [D] a rejected record cannot break the queue ───────────────────────────
  console.log('\n[D] a bad payload cannot break the stream');
  {
    const store = new FakeUnified();
    const svc = new TickInterpreterService(store);
    svc.enqueueMessage('FYERS_LIVE', null);
    svc.enqueueMessage('FYERS_LIVE', 'not a payload');
    svc.enqueueMessage('FYERS_LIVE', { d: [{ symbol: 'NSE:NIFTY26SEP23000PE', ltp: 99.8, exch_feed_time: NOW_ISO }] });
    await new Promise((r) => setTimeout(r, 150));
    assert.strictEqual(svc.metrics().ingestQueueDepth, 0, 'the queue still drains past malformed payloads');
    assert.strictEqual(svc.metrics().ingestInFlight, 0, 'no stuck in-flight work');
    assert.strictEqual(store.quoteBatches.flat().length, 1, 'the one valid nested tick is written');
    ok('malformed payloads are dropped/counted without breaking the stream');
  }

  // ── [E] the write-behind store path itself ─────────────────────────────────
  console.log('\n[E] write-behind flush');
  {
    const { UnifiedMarketDataService } = require(path.join(REPO, 'dist', 'trading', 'unified-market-data', 'unified-market-data.service'));
    class FakeRepo {
      constructor() { this.inserts = []; this.saves = 0; this.fail = false; }
      create(o) { return { ...o }; }
      async insert(rows) {
        if (this.fail) throw new Error('simulated write failure');
        this.inserts.push(Array.isArray(rows) ? rows : [rows]);
        return {};
      }
      async save(row) { this.saves += 1; this.inserts.push([row]); return row; }
    }
    const ts = new Date().toISOString();
    const tickInput = (strike) => ({
      instrumentKey: `NSE:NIFTY26SEP${strike}PE`, underlying: 'NIFTY', exchange: 'NSE', segment: 'FO',
      instrumentType: 'OPT', expiry: '2026-09-26', strike, optionType: 'PE', ltp: 99.8, bid: 99.65, ask: 99.95,
      volume: null, oi: 45000, source: 'FYERS_LIVE', sourceTimestamp: ts,
    });
    const quotes = new FakeRepo();
    const snaps = new FakeRepo();
    const svc = new UnifiedMarketDataService(quotes, snaps);

    const rows = await svc.ingestQuotes([tickInput(23000), tickInput(23100), tickInput(23200)]);
    assert.strictEqual(rows.length, 3, 'every input maps to a row');
    assert.ok(rows.every((r) => r && r.id), 'each cached row carries its replay-safe id');
    assert.strictEqual(quotes.inserts.length, 0, 'the tape path performs NO I/O');
    assert.deepStrictEqual(svc.writeBehindStats(), { pendingQuotes: 3, pendingSnapshots: 0, flushedRows: 0, droppedRows: 0, flushTimeouts: 0, flushing: false });
    ok('the message path buffers rows without touching the database');

    await svc.flushPending();
    assert.strictEqual(quotes.inserts.length, 1, 'the flush issues ONE statement');
    assert.strictEqual(quotes.inserts[0].length, 3, 'carrying every buffered row (a real multi-row INSERT)');
    assert.strictEqual(quotes.saves, 0, 'no row-by-row writes');
    assert.strictEqual(svc.writeBehindStats().flushedRows, 3, 'flushed rows are counted');
    ok('one flush = one multi-row INSERT for the whole batch');

    await svc.ingestQuotes([tickInput(23000)]);
    assert.strictEqual(svc.writeBehindStats().pendingQuotes, 0, 'a repeated observation is not queued again');
    ok('a repeated tick is not buffered twice (replay-safe)');

    await svc.ingestQuotes([tickInput(23300)]);
    assert.strictEqual(svc.writeBehindStats().pendingQuotes, 1, 'a new tick is buffered');
    quotes.fail = true;
    await svc.flushPending();
    assert.strictEqual(svc.writeBehindStats().pendingQuotes, 1, 'a failed flush re-queues rather than losing the row');
    assert.strictEqual(svc.writeBehindStats().flushedRows, 3, 'a failed flush is not counted as written');
    quotes.fail = false;
    await svc.flushPending();
    assert.strictEqual(svc.writeBehindStats().pendingQuotes, 0, 'the re-queued row is written on the next flush');
    ok('a failed flush re-queues (no silent loss) and recovers');
  }

  // ── [F] a wedged flush must never stop the writes ──────────────────────────
  console.log('\n[F] a flush that never returns is bounded');
  {
    process.env.UNIFIED_FLUSH_TIMEOUT_MS = '150';
    process.env.UNIFIED_MAX_ROWS_PER_FLUSH = '500';
    const { UnifiedMarketDataService } = require(path.join(REPO, 'dist', 'trading', 'unified-market-data', 'unified-market-data.service'));
    class WedgedRepo {
      constructor() { this.inserts = 0; this.mode = 'hang'; }
      create(o) { return { ...o }; }
      insert() {
        this.inserts += 1;
        return this.mode === 'hang' ? new Promise(() => {}) : Promise.resolve({});
      }
      async save(row) { return row; }
    }
    const ts = new Date().toISOString();
    const tick = (strike) => ({
      instrumentKey: `NSE:NIFTY26SEP${strike}PE`, underlying: 'NIFTY', exchange: 'NSE', segment: 'FO',
      instrumentType: 'OPT', expiry: '2026-09-26', strike, optionType: 'PE', ltp: 99.8, bid: 99.65, ask: 99.95,
      volume: null, oi: 45000, source: 'FYERS_LIVE', sourceTimestamp: ts,
    });
    const quotes = new WedgedRepo();
    const svc = new UnifiedMarketDataService(quotes, new WedgedRepo());

    await svc.ingestQuotes([tick(23000), tick(23100)]);
    const t0 = Date.now();
    await svc.flushPending();
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 2000, `the flush returned instead of hanging (took ${elapsed}ms)`);
    const st = svc.writeBehindStats();
    assert.strictEqual(st.flushing, false, 'the in-flight flag is RELEASED, so writes can continue');
    assert.strictEqual(st.flushTimeouts, 1, 'the timeout is counted');
    assert.strictEqual(st.pendingQuotes, 2, 'the rows stay buffered — nothing is lost');
    ok('a hung write is bounded, releases the pipeline and keeps the rows');

    // ...and the pipeline actually recovers: the very next flush writes them.
    quotes.mode = 'ok';
    await svc.flushPending();
    assert.strictEqual(svc.writeBehindStats().pendingQuotes, 0, 'the next flush writes the buffered rows');
    assert.strictEqual(quotes.inserts, 2, 'a second attempt was made (the wedge did not stop the pipeline)');
    ok('the pipeline recovers on the next tick (a wedge cannot stop the tape)');
    delete process.env.UNIFIED_FLUSH_TIMEOUT_MS;
  }

  // ── [G] one INSERT is capped so it cannot grow into a stall ────────────────
  console.log('\n[G] the batch size is capped');
  {
    process.env.UNIFIED_MAX_ROWS_PER_FLUSH = '2';
    const { UnifiedMarketDataService } = require(path.join(REPO, 'dist', 'trading', 'unified-market-data', 'unified-market-data.service'));
    class CapRepo {
      constructor() { this.batches = []; }
      create(o) { return { ...o }; }
      async insert(rows) { this.batches.push((Array.isArray(rows) ? rows : [rows]).length); return {}; }
      async save(row) { return row; }
    }
    const ts = new Date().toISOString();
    const tick = (strike) => ({
      instrumentKey: `NSE:NIFTY26SEP${strike}PE`, underlying: 'NIFTY', exchange: 'NSE', segment: 'FO',
      instrumentType: 'OPT', expiry: '2026-09-26', strike, optionType: 'PE', ltp: 99.8, bid: 99.65, ask: 99.95,
      volume: null, oi: 45000, source: 'FYERS_LIVE', sourceTimestamp: ts,
    });
    const quotes = new CapRepo();
    const svc = new UnifiedMarketDataService(quotes, new CapRepo());
    await svc.ingestQuotes([1, 2, 3, 4, 5].map((i) => tick(23000 + i * 100)));
    await svc.flushPending();
    assert.deepStrictEqual(quotes.batches, [2], 'the first flush writes only the cap');
    assert.strictEqual(svc.writeBehindStats().pendingQuotes, 3, 'the remainder stays buffered for the next tick');
    await svc.flushPending();
    await svc.flushPending();
    assert.deepStrictEqual(quotes.batches, [2, 2, 1], 'later ticks drain the remainder in bounded batches');
    assert.strictEqual(svc.writeBehindStats().pendingQuotes, 0, 'the buffer fully drains');
    ok('an INSERT is capped and the remainder drains over subsequent ticks');
    delete process.env.UNIFIED_MAX_ROWS_PER_FLUSH;
  }

  console.log(`\n${pass} checks passed`);
})().catch((err) => {
  console.error(`\nFAILED: ${err && err.message}`);
  process.exit(1);
});
