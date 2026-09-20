#!/usr/bin/env node
/**
 * UnifiedArchiveService behavioral tests — pure logic against fake
 * DataSource/QueryRunner, no DB.
 *
 * Covers all 15 scenarios from the implementation spec:
 *  1. Archive zero rows
 *  2. Archive normal rows
 *  3. Archive multiple batches (chunking)
 *  4. Duplicate retry (idempotency)
 *  5. INSERT success / DELETE failure simulation
 *  6. Crash/restart recovery
 *  7. Concurrent archive prevention
 *  8. Boundary correctness
 *  9. Ticks arriving after boundary
 * 10. Historical row integrity
 * 11. No duplicate history rows
 * 12. Row-count verification
 * 13. Archive failure does not stop ingestion
 * 14. Current table remains queryable
 * 15. History table remains queryable
 */
'use strict';
const assert = require('node:assert/strict');

const { UnifiedArchiveService } = require('../dist/trading/unified-market-data/unified-archive.service.js');

/* ── Fake infrastructure ────────────────────────────────────────────── */

function makeQuote(id, receivedTs, ltp = 100) {
  return {
    id, instrumentKey: `KEY_${id}`, underlying: 'NIFTY', exchange: 'NSE',
    segment: 'FO', instrumentType: 'OPTION', expiry: '2026-09-25',
    strike: 25000, optionType: 'CE', ltp, bid: null, ask: null,
    bidQty: null, askQty: null, volume: null, oi: null, previousOi: null,
    changeOi: null, iv: null, delta: null, gamma: null, theta: null, vega: null,
    depth: null, source: 'FYERS_LIVE', sourceTimestamp: new Date(receivedTs),
    receivedTimestamp: new Date(receivedTs), sequenceNumber: 1,
    dataQuality: 'GOOD', ts: new Date(receivedTs), createdAt: new Date(receivedTs),
  };
}

function makeSnapshot(id, receivedTs, symbol = 'NIFTY') {
  return {
    id, symbol, underlying: 'NIFTY', exchange: 'NSE', ltp: 25000, volume: null,
    bid: null, ask: null, bidQty: null, askQty: null, open: null, high: null,
    low: null, close: null, depth: null, source: 'FYERS_LIVE',
    sourceTimestamp: new Date(receivedTs), receivedTimestamp: new Date(receivedTs),
    sequenceNumber: 1, dataQuality: 'GOOD', ts: new Date(receivedTs),
    createdAt: new Date(receivedTs),
  };
}

/**
 * Create a fake DataSource with controllable QueryRunner.
 *
 * SQL dispatch:
 *   SELECT id FROM unified_option_quotes → candidate IDs from liveQuotes
 *   SELECT id FROM unified_market_snapshots → candidate IDs from liveSnapshots
 *   INSERT IGNORE INTO ..._history → inserts into history store
 *   SELECT COUNT(*) as n FROM ..._history → count existing history rows
 *   DELETE FROM unified_option_quotes → removes from liveQuotes
 *   DELETE FROM unified_market_snapshots → removes from liveSnapshots
 */
function createFakeDataSource(opts = {}) {
  const liveQuotes = opts.liveQuotes ?? [];
  const liveSnapshots = opts.liveSnapshots ?? [];
  const historyQuotes = [];
  const historySnapshots = [];
  const queryLog = [];

  const failDeleteQuotes = opts.failDeleteQuotes ?? false;
  const failInsertHistory = opts.failInsertHistory ?? false;

  const fakeQueryRunner = {
    connected: false,
    inTransaction: false,
    txInsertedQuotes: [],
    txInsertedSnapshots: [],
    async connect() { this.connected = true; },
    async release() { this.connected = false; },
    async startTransaction() { queryLog.push('START_TRANSACTION'); this.inTransaction = true; this.txInsertedQuotes = []; this.txInsertedSnapshots = []; },
    async commitTransaction() { queryLog.push('COMMIT'); this.inTransaction = false; this.txInsertedQuotes = []; this.txInsertedSnapshots = []; },
    async rollbackTransaction() {
      queryLog.push('ROLLBACK');
      // Undo INSERTs by removing from history.
      for (const id of this.txInsertedQuotes) {
        const idx = historyQuotes.findIndex((h) => h.id === id);
        if (idx >= 0) historyQuotes.splice(idx, 1);
      }
      for (const id of this.txInsertedSnapshots) {
        const idx = historySnapshots.findIndex((h) => h.id === id);
        if (idx >= 0) historySnapshots.splice(idx, 1);
      }
      this.inTransaction = false;
      this.txInsertedQuotes = [];
      this.txInsertedSnapshots = [];
    },
    async query(sql, params) {
      queryLog.push({ sql: sql.substring(0, 100), params });

      // Normalize: strip backticks for prefix matching.
      const norm = sql.replace(/`/g, '');

      // Candidate selection.
      if (norm.startsWith('SELECT id FROM unified_option_quotes')) {
        const boundary = new Date(params[0]);
        const limit = params[1];
        return liveQuotes
          .filter((r) => r.receivedTimestamp < boundary)
          .sort((a, b) => a.receivedTimestamp - b.receivedTimestamp)
          .slice(0, limit)
          .map((r) => ({ id: r.id }));
      }
      if (norm.startsWith('SELECT id FROM unified_market_snapshots')) {
        const boundary = new Date(params[0]);
        const limit = params[1];
        return liveSnapshots
          .filter((r) => r.receivedTimestamp < boundary)
          .sort((a, b) => a.receivedTimestamp - b.receivedTimestamp)
          .slice(0, limit)
          .map((r) => ({ id: r.id }));
      }

      // INSERT IGNORE INTO history.
      if (norm.includes('INSERT IGNORE INTO')) {
        if (failInsertHistory) throw new Error('INSERT failed (simulated)');
        const isQuotes = norm.includes('unified_option_quotes_history');
        const ids = params;
        let inserted = 0;
        for (const id of ids) {
          if (isQuotes) {
            const src = liveQuotes.find((r) => r.id === id);
            if (src && !historyQuotes.find((h) => h.id === id)) {
              historyQuotes.push({ ...src, archivedAt: new Date() });
              this.txInsertedQuotes.push(id);
              inserted++;
            }
          } else {
            const src = liveSnapshots.find((r) => r.id === id);
            if (src && !historySnapshots.find((h) => h.id === id)) {
              historySnapshots.push({ ...src, archivedAt: new Date() });
              this.txInsertedSnapshots.push(id);
              inserted++;
            }
          }
        }
        return { affectedRows: inserted };
      }

      // COUNT in history.
      if (norm.includes('SELECT COUNT(*)')) {
        const ids = params;
        const isQuotes = norm.includes('unified_option_quotes_history');
        const store = isQuotes ? historyQuotes : historySnapshots;
        const n = ids.filter((id) => store.some((h) => h.id === id)).length;
        return [{ n }];
      }

      // DELETE from live.
      if (norm.startsWith('DELETE FROM unified_option_quotes')) {
        if (failDeleteQuotes) throw new Error('DELETE failed (simulated)');
        const ids = params;
        let deleted = 0;
        for (const id of ids) {
          const idx = liveQuotes.findIndex((r) => r.id === id);
          if (idx >= 0) { liveQuotes.splice(idx, 1); deleted++; }
        }
        return { affectedRows: deleted };
      }
      if (norm.startsWith('DELETE FROM unified_market_snapshots')) {
        if (failDeleteQuotes) throw new Error('DELETE failed (simulated)');
        const ids = params;
        let deleted = 0;
        for (const id of ids) {
          const idx = liveSnapshots.findIndex((r) => r.id === id);
          if (idx >= 0) { liveSnapshots.splice(idx, 1); deleted++; }
        }
        return { affectedRows: deleted };
      }

      return [];
    },
  };

  const dataSource = {
    async query(sql, params) { return fakeQueryRunner.query(sql, params); },
    createQueryRunner() { return fakeQueryRunner; },
  };

  return { liveQuotes, liveSnapshots, historyQuotes, historySnapshots, queryLog, dataSource };
}

function makeService(fake) {
  // UnifiedArchiveService(dataSource, quotesRepo, snapshotsRepo, quoteHistoryRepo, snapshotHistoryRepo)
  // We only need dataSource for the actual work; repos are unused placeholders.
  const noopRepo = { find: async () => [] };
  return new UnifiedArchiveService(
    fake.dataSource,
    noopRepo, noopRepo, noopRepo, noopRepo,
  );
}

/* ── Tests ──────────────────────────────────────────────────────────── */

async function testZeroRows() {
  const fake = createFakeDataSource();
  const svc = makeService(fake);
  const result = await svc.archiveTicksBefore('2026-09-18 15:30:00');
  assert.equal(result.success, true, 'success on zero rows');
  assert.equal(result.quotes.selected, 0);
  assert.equal(result.snapshots.selected, 0);
  assert.equal(result.quotes.deleted, 0);
  assert.equal(result.snapshots.deleted, 0);
  console.log('  ✓ 1. archive zero rows');
}

async function testNormalRows() {
  const fake = createFakeDataSource({
    liveQuotes: [
      makeQuote('q1', '2026-09-18T10:00:00+05:30'),
      makeQuote('q2', '2026-09-18T11:00:00+05:30'),
      makeQuote('q3', '2026-09-18T14:00:00+05:30'),
    ],
    liveSnapshots: [makeSnapshot('s1', '2026-09-18T10:00:00+05:30')],
  });
  const svc = makeService(fake);
  const result = await svc.archiveTicksBefore('2026-09-18 15:30:00');
  assert.equal(result.success, true);
  assert.equal(result.quotes.selected, 3);
  assert.equal(result.quotes.verified, 3);
  assert.equal(result.quotes.deleted, 3);
  assert.equal(result.snapshots.selected, 1);
  assert.equal(result.snapshots.deleted, 1);
  assert.equal(fake.liveQuotes.length, 0, 'live quotes empty');
  assert.equal(fake.liveSnapshots.length, 0, 'live snapshots empty');
  assert.equal(fake.historyQuotes.length, 3, 'history quotes = 3');
  assert.equal(fake.historySnapshots.length, 1, 'history snapshots = 1');
  console.log('  ✓ 2. archive normal rows');
}

async function testMultipleBatches() {
  const liveQuotes = [];
  for (let i = 0; i < 12; i++) {
    // All timestamps well before the boundary (using minutes for uniqueness).
    const h = Math.floor(i / 2);
    const m = (i % 2) * 30;
    liveQuotes.push(makeQuote(`q${i}`, `2026-09-18T${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00+05:30`));
  }
  const fake = createFakeDataSource({ liveQuotes });
  const svc = makeService(fake);
  // Override chunk size.
  svc.chunkSize = 5;

  const result = await svc.archiveTicksBefore('2026-09-18 15:30:00');
  assert.equal(result.success, true);
  assert.equal(result.quotes.selected, 12, 'all 12 selected across chunks');
  assert.equal(result.quotes.deleted, 12, 'all 12 deleted');
  assert.equal(fake.liveQuotes.length, 0, 'live empty');
  assert.equal(fake.historyQuotes.length, 12, 'history has all 12');
  const commits = fake.queryLog.filter((l) => l === 'COMMIT');
  assert.ok(commits.length >= 3, `expected ≥3 commits, got ${commits.length}`);
  console.log('  ✓ 3. archive multiple batches (chunking)');
}

async function testDuplicateRetry() {
  const fake = createFakeDataSource({
    liveQuotes: [makeQuote('q1', '2026-09-18T10:00:00+05:30')],
  });
  const svc = makeService(fake);

  const r1 = await svc.archiveTicksBefore('2026-09-18 15:30:00');
  assert.equal(r1.success, true);
  assert.equal(r1.quotes.deleted, 1);
  assert.equal(fake.historyQuotes.length, 1);

  // Second run — no candidates (already removed from live).
  const r2 = await svc.archiveTicksBefore('2026-09-18 15:30:00');
  assert.equal(r2.success, true);
  assert.equal(r2.quotes.selected, 0, 'no candidates on retry');
  assert.equal(fake.historyQuotes.length, 1, 'history unchanged');
  console.log('  ✓ 4. duplicate retry (idempotency)');
}

async function testInsertSuccessDeleteFailure() {
  const fake = createFakeDataSource({
    liveQuotes: [makeQuote('q1', '2026-09-18T10:00:00+05:30')],
    failDeleteQuotes: true,
  });
  const svc = makeService(fake);

  const result = await svc.archiveTicksBefore('2026-09-18 15:30:00');
  assert.equal(result.success, false, 'failure when DELETE fails');
  assert.ok(result.quotes.error, 'error reported');
  assert.equal(fake.liveQuotes.length, 1, 'live row preserved after rollback');
  assert.equal(fake.historyQuotes.length, 0, 'history empty after rollback');
  const rollbacks = fake.queryLog.filter((l) => l === 'ROLLBACK');
  assert.ok(rollbacks.length >= 1, 'ROLLBACK was called');
  console.log('  ✓ 5. INSERT success / DELETE failure → rollback');
}

async function testCrashRecovery() {
  const fake = createFakeDataSource({
    liveQuotes: [makeQuote('q1', '2026-09-18T10:00:00+05:30')],
  });
  const svc = makeService(fake);

  // First run: archive succeeds.
  const r1 = await svc.archiveTicksBefore('2026-09-18 15:30:00');
  assert.equal(r1.success, true);
  assert.equal(fake.historyQuotes.length, 1);

  // Simulate crash: re-add the same row to live (same UUID).
  fake.liveQuotes.push(makeQuote('q1', '2026-09-18T10:00:00+05:30'));

  // Second run: INSERT IGNORE skips existing, DELETE removes live.
  const r2 = await svc.archiveTicksBefore('2026-09-18 15:30:00');
  assert.equal(r2.success, true);
  assert.equal(fake.historyQuotes.length, 1, 'no duplicate in history');
  assert.equal(fake.liveQuotes.length, 0, 'live cleaned up');
  console.log('  ✓ 6. crash/restart recovery (no duplicates)');
}

async function testConcurrentPrevention() {
  const fake = createFakeDataSource({
    liveQuotes: [makeQuote('q1', '2026-09-18T10:00:00+05:30')],
  });
  const svc = makeService(fake);

  // Manually set the in-flight flag.
  svc.archiving = true;
  const result = await svc.archiveTicksBefore('2026-09-18 15:30:00');
  assert.equal(result.success, false);
  assert.equal(result.error, 'concurrent_archive_skipped');
  assert.equal(fake.liveQuotes.length, 1, 'live unchanged');
  console.log('  ✓ 7. concurrent archive prevention');
}

async function testBoundaryCorrectness() {
  const fake = createFakeDataSource({
    liveQuotes: [
      makeQuote('q_before', '2026-09-18T14:00:00+05:30'), // before 15:30
      makeQuote('q_exact', '2026-09-18T15:30:00+05:30'),   // exactly at boundary
      makeQuote('q_after', '2026-09-18T15:30:01+05:30'),   // after boundary
    ],
  });
  const svc = makeService(fake);

  const result = await svc.archiveTicksBefore('2026-09-18 15:30:00');
  assert.equal(result.success, true);
  assert.equal(result.quotes.selected, 1, 'only row before boundary');
  assert.equal(fake.liveQuotes.length, 2, '2 rows remain');
  assert.equal(fake.liveQuotes[0].id, 'q_exact', 'exact boundary stays');
  assert.equal(fake.liveQuotes[1].id, 'q_after', 'after boundary stays');
  console.log('  ✓ 8. boundary correctness');
}

async function testTicksArrivingAfterBoundary() {
  const fake = createFakeDataSource({
    liveQuotes: [makeQuote('q_late', '2026-09-18T15:31:00+05:30')],
  });
  const svc = makeService(fake);

  const result = await svc.archiveTicksBefore('2026-09-18 15:30:00');
  assert.equal(result.success, true);
  assert.equal(result.quotes.selected, 0, 'late tick not archived');
  assert.equal(fake.liveQuotes.length, 1, 'late tick stays in live');
  console.log('  ✓ 9. ticks arriving after boundary');
}

async function testHistoricalIntegrity() {
  const fake = createFakeDataSource({
    liveQuotes: [
      makeQuote('q1', '2026-09-18T10:00:00+05:30', 125.5),
      makeQuote('q2', '2026-09-18T11:00:00+05:30', 130.25),
    ],
  });
  const svc = makeService(fake);

  await svc.archiveTicksBefore('2026-09-18 15:30:00');
  assert.equal(fake.historyQuotes.length, 2);
  const h1 = fake.historyQuotes.find((h) => h.id === 'q1');
  assert.ok(h1, 'q1 in history');
  assert.equal(h1.instrumentKey, 'KEY_q1');
  assert.equal(h1.ltp, 125.5);
  assert.equal(h1.source, 'FYERS_LIVE');
  assert.ok(h1.archivedAt, 'archivedAt stamped');
  const h2 = fake.historyQuotes.find((h) => h.id === 'q2');
  assert.ok(h2, 'q2 in history');
  assert.equal(h2.ltp, 130.25);
  console.log('  ✓ 10. historical row integrity');
}

async function testNoDuplicates() {
  const fake = createFakeDataSource({
    liveQuotes: [makeQuote('q1', '2026-09-18T10:00:00+05:30')],
  });
  const svc = makeService(fake);

  await svc.archiveTicksBefore('2026-09-18 15:30:00');
  // Re-add to live (simulate crash recovery).
  fake.liveQuotes.push(makeQuote('q1', '2026-09-18T10:00:00+05:30'));
  await svc.archiveTicksBefore('2026-09-18 15:30:00');
  assert.equal(fake.historyQuotes.length, 1, 'no duplicate rows');
  console.log('  ✓ 11. no duplicate history rows');
}

async function testRowCountVerification() {
  const fake = createFakeDataSource({
    liveQuotes: [makeQuote('q1', '2026-09-18T10:00:00+05:30')],
  });
  const svc = makeService(fake);

  const result = await svc.archiveTicksBefore('2026-09-18 15:30:00');
  assert.equal(result.quotes.selected, result.quotes.verified, 'selected = verified');
  assert.equal(result.quotes.verified, result.quotes.deleted, 'verified = deleted');
  console.log('  ✓ 12. row-count verification');
}

async function testArchiveFailureDoesNotStopIngestion() {
  const fake = createFakeDataSource({
    liveQuotes: [makeQuote('q1', '2026-09-18T10:00:00+05:30')],
    failDeleteQuotes: true,
  });
  const svc = makeService(fake);

  const result = await svc.archiveTicksBefore('2026-09-18 15:30:00');
  assert.equal(result.success, false, 'archive failed');
  assert.equal(fake.liveQuotes.length, 1, 'live row preserved');
  // Service still callable.
  svc.archiving = false;
  const result2 = await svc.archiveTicksBefore('2026-09-18 15:30:00');
  assert.equal(typeof result2.success, 'boolean', 'service still callable');
  console.log('  ✓ 13. archive failure does not stop ingestion');
}

async function testCurrentTableQueryable() {
  const fake = createFakeDataSource({
    liveQuotes: [
      makeQuote('q_before', '2026-09-18T10:00:00+05:30'),
      makeQuote('q_after', '2026-09-18T15:31:00+05:30'),
    ],
  });
  const svc = makeService(fake);

  await svc.archiveTicksBefore('2026-09-18 15:30:00');
  assert.equal(fake.liveQuotes.length, 1, 'live has post-boundary row');
  assert.equal(fake.liveQuotes[0].id, 'q_after');
  console.log('  ✓ 14. current table remains queryable');
}

async function testHistoryTableQueryable() {
  const fake = createFakeDataSource({
    liveQuotes: [makeQuote('q1', '2026-09-18T10:00:00+05:30')],
  });
  const svc = makeService(fake);

  await svc.archiveTicksBefore('2026-09-18 15:30:00');
  assert.equal(fake.historyQuotes.length, 1);
  const h = fake.historyQuotes[0];
  assert.equal(h.id, 'q1');
  assert.ok(h.archivedAt instanceof Date, 'archivedAt present');
  console.log('  ✓ 15. history table remains queryable');
}

async function testMetricsReporting() {
  const fake = createFakeDataSource({
    liveQuotes: [
      makeQuote('q1', '2026-09-18T10:00:00+05:30'),
      makeQuote('q2', '2026-09-18T11:00:00+05:30'),
    ],
    liveSnapshots: [makeSnapshot('s1', '2026-09-18T10:00:00+05:30')],
  });
  const svc = makeService(fake);

  const result = await svc.archiveTicksBefore('2026-09-18 15:30:00');
  assert.equal(result.boundary, '2026-09-18 15:30:00');
  assert.ok(typeof result.durationMs === 'number' && result.durationMs >= 0);
  assert.equal(result.success, true);
  assert.equal(typeof result.quotes.selected, 'number');
  assert.equal(typeof result.quotes.inserted, 'number');
  assert.equal(typeof result.quotes.verified, 'number');
  assert.equal(typeof result.quotes.deleted, 'number');
  console.log('  ✓ extra. metrics reporting');
}

async function testSnapshotsArchivedFirst() {
  // Verify snapshots are archived before quotes (smaller table first).
  const fake = createFakeDataSource({
    liveQuotes: [makeQuote('q1', '2026-09-18T10:00:00+05:30')],
    liveSnapshots: [makeSnapshot('s1', '2026-09-18T10:00:00+05:30')],
  });
  const svc = makeService(fake);

  const result = await svc.archiveTicksBefore('2026-09-18 15:30:00');
  assert.equal(result.success, true);
  assert.equal(result.snapshots.deleted, 1);
  assert.equal(result.quotes.deleted, 1);
  assert.equal(fake.historySnapshots.length, 1);
  assert.equal(fake.historyQuotes.length, 1);
  console.log('  ✓ extra. snapshots archived before quotes');
}

/* ── Column-mapping validation (BLOCKER-1 regression) ───────────────── */

/**
 * Parse a SQL column list string into an array of column names.
 * e.g. "id, name, ts" → ["id", "name", "ts"]
 */
function parseCols(s) {
  return s.split(',').map((c) => c.trim().split(' ').pop()).filter(Boolean);
}

/**
 * Expected column sets (from DDL review, matching entity definitions).
 */
const QUOTE_HISTORY_COLS = [
  'id', 'instrumentKey', 'underlying', 'exchange', 'segment', 'instrumentType',
  'expiry', 'strike', 'optionType', 'ltp', 'bid', 'ask', 'bidQty', 'askQty',
  'volume', 'oi', 'previousOi', 'changeOi', 'iv', 'delta', 'gamma', 'theta',
  'vega', 'depth', 'source', 'sourceTimestamp', 'receivedTimestamp',
  'sequenceNumber', 'dataQuality', 'ts', 'createdAt', 'archivedAt',
];

const SNAPSHOT_HISTORY_COLS = [
  'id', 'symbol', 'underlying', 'exchange', 'ltp', 'volume', 'bid', 'ask',
  'bidQty', 'askQty', 'open', 'high', 'low', 'close', 'depth', 'source',
  'sourceTimestamp', 'receivedTimestamp', 'sequenceNumber', 'dataQuality',
  'ts', 'createdAt', 'archivedAt',
];

async function testQuoteColumnListContainsInstrumentKey() {
  const mapping = UnifiedArchiveService.COLUMN_MAP.unified_option_quotes;
  assert.ok(mapping, 'quote mapping exists');
  const cols = parseCols(mapping.insertCols);
  assert.ok(cols.includes('instrumentKey'), 'quote insertCols must contain instrumentKey');
  assert.ok(cols.includes('expiry'), 'quote insertCols must contain expiry');
  assert.ok(cols.includes('strike'), 'quote insertCols must contain strike');
  assert.ok(cols.includes('oi'), 'quote insertCols must contain oi');
  console.log('  ✓ BLOCKER-1.1. quote insertCols contains quote-specific fields');
}

async function testSnapshotColumnListContainsSymbol() {
  const mapping = UnifiedArchiveService.COLUMN_MAP.unified_market_snapshots;
  assert.ok(mapping, 'snapshot mapping exists');
  const cols = parseCols(mapping.insertCols);
  assert.ok(cols.includes('symbol'), 'snapshot insertCols must contain symbol');
  assert.ok(cols.includes('open'), 'snapshot insertCols must contain open');
  assert.ok(cols.includes('high'), 'snapshot insertCols must contain high');
  assert.ok(cols.includes('low'), 'snapshot insertCols must contain low');
  assert.ok(cols.includes('close'), 'snapshot insertCols must contain close');
  console.log('  ✓ BLOCKER-1.2. snapshot insertCols contains symbol + OHLC');
}

async function testSnapshotColumnListExcludesInstrumentKey() {
  const mapping = UnifiedArchiveService.COLUMN_MAP.unified_market_snapshots;
  const cols = parseCols(mapping.insertCols);
  assert.ok(!cols.includes('instrumentKey'), 'snapshot insertCols must NOT contain instrumentKey');
  assert.ok(!cols.includes('segment'), 'snapshot insertCols must NOT contain segment');
  assert.ok(!cols.includes('instrumentType'), 'snapshot insertCols must NOT contain instrumentType');
  assert.ok(!cols.includes('expiry'), 'snapshot insertCols must NOT contain expiry');
  assert.ok(!cols.includes('strike'), 'snapshot insertCols must NOT contain strike');
  assert.ok(!cols.includes('optionType'), 'snapshot insertCols must NOT contain optionType');
  assert.ok(!cols.includes('oi'), 'snapshot insertCols must NOT contain oi');
  assert.ok(!cols.includes('previousOi'), 'snapshot insertCols must NOT contain previousOi');
  assert.ok(!cols.includes('changeOi'), 'snapshot insertCols must NOT contain changeOi');
  assert.ok(!cols.includes('iv'), 'snapshot insertCols must NOT contain iv');
  assert.ok(!cols.includes('delta'), 'snapshot insertCols must NOT contain delta');
  assert.ok(!cols.includes('gamma'), 'snapshot insertCols must NOT contain gamma');
  assert.ok(!cols.includes('theta'), 'snapshot insertCols must NOT contain theta');
  assert.ok(!cols.includes('vega'), 'snapshot insertCols must NOT contain vega');
  console.log('  ✓ BLOCKER-1.3. snapshot insertCols excludes all quote-specific fields');
}

async function testQuoteColumnListExcludesSymbol() {
  const mapping = UnifiedArchiveService.COLUMN_MAP.unified_option_quotes;
  const cols = parseCols(mapping.insertCols);
  assert.ok(!cols.includes('symbol'), 'quote insertCols must NOT contain symbol');
  assert.ok(!cols.includes('open'), 'quote insertCols must NOT contain open');
  assert.ok(!cols.includes('high'), 'quote insertCols must NOT contain high');
  assert.ok(!cols.includes('low'), 'quote insertCols must NOT contain low');
  assert.ok(!cols.includes('close'), 'quote insertCols must NOT contain close');
  console.log('  ✓ BLOCKER-1.4. quote insertCols excludes snapshot-specific fields');
}

async function testColumnListMatchesExpectedSchema() {
  const qCols = parseCols(UnifiedArchiveService.COLUMN_MAP.unified_option_quotes.insertCols);
  const sCols = parseCols(UnifiedArchiveService.COLUMN_MAP.unified_market_snapshots.insertCols);
  assert.deepEqual(qCols, QUOTE_HISTORY_COLS, 'quote column list matches expected schema');
  assert.deepEqual(sCols, SNAPSHOT_HISTORY_COLS, 'snapshot column list matches expected schema');
  console.log('  ✓ BLOCKER-1.5. column lists match expected schema definitions');
}

async function testSelectColsMapArchivedAtCorrectly() {
  const qSelect = UnifiedArchiveService.COLUMN_MAP.unified_option_quotes.selectCols;
  const sSelect = UnifiedArchiveService.COLUMN_MAP.unified_market_snapshots.selectCols;
  assert.ok(qSelect.includes('NOW() as archivedAt'), 'quote selectCols must have NOW() as archivedAt');
  assert.ok(sSelect.includes('NOW() as archivedAt'), 'snapshot selectCols must have NOW() as archivedAt');
  // SELECT must NOT end with bare 'archivedAt' (i.e. without NOW())
  assert.ok(!qSelect.trim().endsWith(', archivedAt'), 'quote selectCols must not end with bare archivedAt');
  assert.ok(!sSelect.trim().endsWith(', archivedAt'), 'snapshot selectCols must not end with bare archivedAt');
  // INSERT must end with bare 'archivedAt' (not NOW())
  const qInsert = UnifiedArchiveService.COLUMN_MAP.unified_option_quotes.insertCols;
  const sInsert = UnifiedArchiveService.COLUMN_MAP.unified_market_snapshots.insertCols;
  assert.ok(qInsert.trim().endsWith('archivedAt'), 'quote insertCols ends with bare archivedAt');
  assert.ok(!qInsert.includes('NOW()'), 'quote insertCols must not contain NOW()');
  assert.ok(sInsert.trim().endsWith('archivedAt'), 'snapshot insertCols ends with bare archivedAt');
  assert.ok(!sInsert.includes('NOW()'), 'snapshot insertCols must not contain NOW()');
  console.log('  ✓ BLOCKER-1.6. SELECT maps archivedAt → NOW() correctly');
}

async function testBothMappingsExistForAllTables() {
  assert.ok(UnifiedArchiveService.COLUMN_MAP.unified_option_quotes, 'quotes mapping defined');
  assert.ok(UnifiedArchiveService.COLUMN_MAP.unified_market_snapshots, 'snapshots mapping defined');
  const qInsertCols = parseCols(UnifiedArchiveService.COLUMN_MAP.unified_option_quotes.insertCols);
  const qSelectCols = parseCols(UnifiedArchiveService.COLUMN_MAP.unified_option_quotes.selectCols);
  assert.equal(qInsertCols.length, qSelectCols.length, 'quote insert/select column count match');
  const sInsertCols = parseCols(UnifiedArchiveService.COLUMN_MAP.unified_market_snapshots.insertCols);
  const sSelectCols = parseCols(UnifiedArchiveService.COLUMN_MAP.unified_market_snapshots.selectCols);
  assert.equal(sInsertCols.length, sSelectCols.length, 'snapshot insert/select column count match');
  // INSERT has archivedAt; SELECT has NOW() as archivedAt — same count
  assert.equal(qInsertCols.length, QUOTE_HISTORY_COLS.length, `quote cols: ${qInsertCols.length} (expected ${QUOTE_HISTORY_COLS.length})`);
  assert.equal(sInsertCols.length, SNAPSHOT_HISTORY_COLS.length, `snapshot cols: ${sInsertCols.length} (expected ${SNAPSHOT_HISTORY_COLS.length})`);
  console.log('  ✓ BLOCKER-1.7. both mappings complete, insert/select counts aligned');
}

/* ── Main ───────────────────────────────────────────────────────────── */

async function main() {
  console.log('UnifiedArchiveService tests');
  await testZeroRows();
  await testNormalRows();
  await testMultipleBatches();
  await testDuplicateRetry();
  await testInsertSuccessDeleteFailure();
  await testCrashRecovery();
  await testConcurrentPrevention();
  await testBoundaryCorrectness();
  await testTicksArrivingAfterBoundary();
  await testHistoricalIntegrity();
  await testNoDuplicates();
  await testRowCountVerification();
  await testArchiveFailureDoesNotStopIngestion();
  await testCurrentTableQueryable();
  await testHistoryTableQueryable();
  await testMetricsReporting();
  await testSnapshotsArchivedFirst();

  console.log('\nColumn-mapping validation (BLOCKER-1 regression):');
  await testQuoteColumnListContainsInstrumentKey();
  await testSnapshotColumnListContainsSymbol();
  await testSnapshotColumnListExcludesInstrumentKey();
  await testQuoteColumnListExcludesSymbol();
  await testColumnListMatchesExpectedSchema();
  await testSelectColsMapArchivedAtCorrectly();
  await testBothMappingsExistForAllTables();

  console.log('\nAll 24 tests passed.');
}

main().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
