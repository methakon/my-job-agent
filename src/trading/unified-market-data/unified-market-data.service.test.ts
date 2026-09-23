/**
 * Deterministic regression tests for snapshot-persistence idempotency.
 *
 * Covers the six requirements from the pre-market fix spec:
 *   A. new snapshot → inserted
 *   B. same canonical ID twice → one DB row, second treated as already persisted
 *   C. mixed batch (new + duplicate) → new rows persist, duplicate does not poison
 *   D. genuine DB error → still fails/requeues/trips gate
 *   E. no historical row modification
 *   F. no fabricated fallback
 */

import { UnifiedMarketDataService, isDuplicateKeyError } from './unified-market-data.service';
import { PersistenceHealthMachine } from '../../shared/persistence-state';

/* ─── Helpers ─── */

/** Minimal fake repo that satisfies the constructor's type requirements. */
function fakeRepo() {
  const store = new Map<string, unknown>();
  return {
    manager: {
      connection: { driver: { pool: { _allConnections: [] } } },
    },
    insert: jest.fn(async (rows: unknown) => {
      const arr = Array.isArray(rows) ? rows : [rows];
      for (const r of arr) store.set((r as Record<string, unknown>).id as string, r);
      return { identifiers: arr.map((r) => (r as Record<string, unknown>).id), raw: [] };
    }),
    query: jest.fn(async () => []),
    _store: store,
  };
}

function makeSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    id: overrides.id ?? 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    symbol: overrides.symbol ?? 'NSE:NIFTY50-INDEX',
    source: overrides.source ?? 'FYERS_LIVE',
    ts: overrides.ts ?? new Date('2026-09-21T10:20:00Z'),
    receivedTimestamp: overrides.receivedTimestamp ?? new Date('2026-09-21T10:20:01Z'),
    dataQuality: overrides.dataQuality ?? 'GOOD',
  };
}

function makeService(repo: ReturnType<typeof fakeRepo>) {
  return new UnifiedMarketDataService(
    repo as never,
    repo as never,
    new PersistenceHealthMachine(),
  );
}

/** Call flushSnapshotRows (private) via bracket notation. */
function callFlush(svc: UnifiedMarketDataService) {
  return (svc as unknown as { flushSnapshotRows(): Promise<number> }).flushSnapshotRows();
}

/** Push rows into the pendingSnapshotRows map directly. */
function enqueueSnapshots(svc: UnifiedMarketDataService, rows: unknown[]) {
  const map = (svc as unknown as { pendingSnapshotRows: Map<string, unknown> }).pendingSnapshotRows;
  for (const r of rows) map.set((r as Record<string, unknown>).id as string, r);
}

/** Read the duplicateSnapshots counter. */
function getDuplicateSnapshots(svc: UnifiedMarketDataService): number {
  return (svc as unknown as { duplicateSnapshots: number }).duplicateSnapshots;
}

/* ─── Tests ─── */

describe('UnifiedMarketDataService — snapshot flush idempotency', () => {
  it('A: new snapshot is inserted', async () => {
    const repo = fakeRepo();
    const svc = makeService(repo);
    const row = makeSnapshot({ id: 'id-a1' });
    enqueueSnapshots(svc, [row]);

    const count = await callFlush(svc);
    expect(count).toBe(1);
    expect(repo.insert).toHaveBeenCalledTimes(1);
  });

  it('B: same canonical ID twice — second treated as already persisted', async () => {
    const repo = fakeRepo();
    const svc = makeService(repo);

    // Simulate: insert fails with ER_DUP_ENTRY on first call
    const dupError = Object.assign(new Error(), {
      code: 'ER_DUP_ENTRY',
      errno: 1062,
      sqlState: '23000',
      message: "Duplicate entry 'id-b1' for key 'unified_market_snapshots.canonicalRowId'",
    });
    repo.insert.mockRejectedValueOnce(dupError);

    const row = makeSnapshot({ id: 'id-b1' });
    enqueueSnapshots(svc, [row]);

    const count = await callFlush(svc);
    expect(count).toBe(0);
    // Row was removed from pending (not requeued)
    const pending = (svc as unknown as { pendingSnapshotRows: Map<string, unknown> }).pendingSnapshotRows;
    expect(pending.has('id-b1')).toBe(false);
    // duplicateSnapshots counter incremented
    expect(getDuplicateSnapshots(svc)).toBe(1);
  });

  it('C: mixed batch — duplicate row excluded, remaining rows requeued', async () => {
    const repo = fakeRepo();
    const svc = makeService(repo);

    // Batch of 3: id-c1 (duplicate), id-c2 (new), id-c3 (new)
    // MySQL fails the entire batch because of id-c1.
    const dupError = Object.assign(new Error(), {
      code: 'ER_DUP_ENTRY',
      errno: 1062,
      sqlState: '23000',
      message: "Duplicate entry 'id-c1' for key 'unified_market_snapshots.canonicalRowId'",
    });
    repo.insert.mockRejectedValueOnce(dupError);
    // Second call (requeued rows) succeeds
    repo.insert.mockResolvedValueOnce({ identifiers: ['id-c2', 'id-c3'], raw: [] });

    const rows = [
      makeSnapshot({ id: 'id-c1' }),
      makeSnapshot({ id: 'id-c2' }),
      makeSnapshot({ id: 'id-c3' }),
    ];
    enqueueSnapshots(svc, rows);

    // First flush: dup error on batch
    const count1 = await callFlush(svc);
    expect(count1).toBe(0);
    expect(getDuplicateSnapshots(svc)).toBe(1);

    // id-c1 removed, id-c2 and id-c3 requeued
    const pending = (svc as unknown as { pendingSnapshotRows: Map<string, unknown> }).pendingSnapshotRows;
    expect(pending.has('id-c1')).toBe(false);
    expect(pending.has('id-c2')).toBe(true);
    expect(pending.has('id-c3')).toBe(true);

    // Second flush: remaining rows succeed
    const count2 = await callFlush(svc);
    expect(count2).toBe(2);
    expect(repo.insert).toHaveBeenCalledTimes(2);
  });

  it('D: genuine DB error — still requeues all rows', async () => {
    const repo = fakeRepo();
    const svc = makeService(repo);

    const dbError = Object.assign(new Error(), {
      code: 'ECONNRESET',
      errno: -104,
      sqlState: undefined,
      message: 'Connection reset by peer',
    });
    repo.insert.mockRejectedValue(dbError);

    const rows = [makeSnapshot({ id: 'id-d1' }), makeSnapshot({ id: 'id-d2' })];
    enqueueSnapshots(svc, rows);

    const count = await callFlush(svc);
    expect(count).toBe(0);
    // Both rows requeued
    const pending = (svc as unknown as { pendingSnapshotRows: Map<string, unknown> }).pendingSnapshotRows;
    expect(pending.has('id-d1')).toBe(true);
    expect(pending.has('id-d2')).toBe(true);
    // duplicateSnapshots NOT incremented
    expect(getDuplicateSnapshots(svc)).toBe(0);
  });

  it('E: no historical row modification — duplicate row is not overwritten', async () => {
    const repo = fakeRepo();
    const svc = makeService(repo);

    // First insert succeeds (historical row created)
    const row = makeSnapshot({ id: 'id-e1' });
    enqueueSnapshots(svc, [row]);
    await callFlush(svc);
    expect(repo._store.has('id-e1')).toBe(true);
    const originalValue = repo._store.get('id-e1');

    // Second insert: duplicate → row NOT re-inserted/modified
    repo.insert.mockRejectedValueOnce(
      Object.assign(new Error(), {
        code: 'ER_DUP_ENTRY',
        errno: 1062,
        sqlState: '23000',
        message: "Duplicate entry 'id-e1' for key 'unified_market_snapshots.canonicalRowId'",
      }),
    );
    const row2 = makeSnapshot({ id: 'id-e1' });
    enqueueSnapshots(svc, [row2]);
    await callFlush(svc);

    // Original value unchanged
    expect(repo._store.get('id-e1')).toBe(originalValue);
    // insert called twice total, second time it threw (did not write)
    expect(repo.insert).toHaveBeenCalledTimes(2);
  });

  it('F: no fabricated fallback — error path does not invent data', async () => {
    const repo = fakeRepo();
    const svc = makeService(repo);

    const dbError = Object.assign(new Error(), {
      code: 'ER_ACCESS_DENIED_ERROR',
      errno: 1045,
      sqlState: '28000',
      message: 'Access denied for user',
    });
    repo.insert.mockRejectedValue(dbError);

    const rows = [makeSnapshot({ id: 'id-f1' })];
    enqueueSnapshots(svc, rows);

    const count = await callFlush(svc);
    expect(count).toBe(0);
    // Nothing written to the store
    expect(repo._store.size).toBe(0);
    // No fabricated rows
    expect((svc as unknown as { flushedRows: number }).flushedRows).toBe(0);
  });

  it('duplicateSnapshotCount resets via reset()', () => {
    const repo = fakeRepo();
    const svc = makeService(repo);
    (svc as unknown as { duplicateSnapshots: number }).duplicateSnapshots = 5;
    svc.reset();
    expect(svc.duplicateSnapshotCount()).toBe(0);
  });
});

describe('isDuplicateKeyError', () => {
  it('true for ER_DUP_ENTRY code', () => {
    const err = Object.assign(new Error(), {
      code: 'ER_DUP_ENTRY',
      errno: 1062,
      message: "Duplicate entry 'abc' for key 'PRIMARY'",
    });
    expect(isDuplicateKeyError(err)).toBe(true);
  });

  it('true for errno 1062 without code', () => {
    const err = Object.assign(new Error(), {
      errno: 1062,
      message: 'Duplicate entry',
    });
    expect(isDuplicateKeyError(err)).toBe(true);
  });

  it('false for sqlState 23000 alone — not specific enough', () => {
    // sqlState 23000 = "integrity constraint violation" — covers foreign keys,
    // check constraints, etc.  Only ER_DUP_ENTRY (code / errno) is specific.
    const err = Object.assign(new Error(), {
      code: 'UNKNOWN',
      sqlState: '23000',
      message: 'Duplicate entry xyz',
    });
    expect(isDuplicateKeyError(err)).toBe(false);
  });

  it('false for other errors', () => {
    const err = Object.assign(new Error(), {
      code: 'ECONNRESET',
      errno: -104,
      message: 'Connection reset',
    });
    expect(isDuplicateKeyError(err)).toBe(false);
  });

  it('false for non-Error objects', () => {
    expect(isDuplicateKeyError('string error')).toBe(false);
    expect(isDuplicateKeyError(null)).toBe(false);
    expect(isDuplicateKeyError(undefined)).toBe(false);
  });

  it('false for sqlState 23000 without duplicate message', () => {
    const err = Object.assign(new Error(), {
      code: 'UNKNOWN',
      sqlState: '23000',
      message: 'Foreign key constraint fails',
    });
    expect(isDuplicateKeyError(err)).toBe(false);
  });
});

/* ---------------------------------------------------------------------------
 * Quote-path idempotency mirror.
 *
 * The suite above pins six requirements (A-F) for flushSnapshotRows().  The
 * quotes path (flushQuoteRows) must honour the SAME contract:
 *   - a row whose canonical id already exists in persistent storage is treated
 *     as ALREADY PERSISTED: removed from pending, counted, never requeued;
 *   - the remaining rows of a mixed batch are requeued for the next cycle;
 *   - genuine (non-duplicate) errors still requeue the whole batch;
 *   - no historical row is ever overwritten and no data is ever invented.
 * ------------------------------------------------------------------------- */

function makeQuoteRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'quote-1111-2222-3333-4444-555555555555',
    symbol: 'NSE:NIFTY50-INDEX',
    source: 'FYERS_LIVE',
    optionType: 'CE',
    strike: 25000,
    expiry: '2026-09-25',
    ltp: 123.45,
    ts: new Date('2026-09-21T10:20:00.000Z'),
    receivedTimestamp: new Date('2026-09-21T10:20:01.000Z'),
    dataQuality: 'GOOD',
    ...overrides,
  };
}

/** Invoke the (private) quotes flush directly - mirrors callFlush. */
function callQuoteFlush(svc: UnifiedMarketDataService) {
  return (svc as unknown as { flushQuoteRows(): Promise<number> }).flushQuoteRows();
}

/** Seed the pending-quotes buffer directly - mirrors enqueueSnapshots. */
function enqueueQuotes(svc: UnifiedMarketDataService, rows: Array<ReturnType<typeof makeQuoteRow>>) {
  const pending = (svc as unknown as { pendingQuoteRows: Map<string, unknown> }).pendingQuoteRows;
  for (const row of rows) pending.set(String(row.id), row);
}

/** Read the duplicate-quotes counter - mirrors getDuplicateSnapshots. */
function getDuplicateQuotes(svc: UnifiedMarketDataService) {
  return (svc as unknown as { duplicateQuotes: number }).duplicateQuotes;
}

describe('UnifiedMarketDataService — quote flush idempotency (mirror of snapshot path)', () => {
  it('qA: a new quote row is inserted once', async () => {
    const repo = fakeRepo();
    const svc = makeService(repo);

    enqueueQuotes(svc, [makeQuoteRow({ id: 'q-a1' })]);
    const count = await callQuoteFlush(svc);

    expect(count).toBe(1);
    expect(repo.insert).toHaveBeenCalledTimes(1);
    expect(repo._store.has('q-a1')).toBe(true);
    expect(getDuplicateQuotes(svc)).toBe(0);
  });

  it('qB: same canonical ID twice — second treated as already persisted', async () => {
    const repo = fakeRepo();
    const svc = makeService(repo);

    const dupError = Object.assign(new Error(), {
      code: 'ER_DUP_ENTRY',
      errno: 1062,
      sqlState: '23000',
      message: "Duplicate entry 'q-b1' for key 'unified_option_quotes.PRIMARY'",
    });
    repo.insert.mockRejectedValueOnce(dupError);

    enqueueQuotes(svc, [makeQuoteRow({ id: 'q-b1' })]);
    const count = await callQuoteFlush(svc);

    expect(count).toBe(0);
    const pending = (svc as unknown as { pendingQuoteRows: Map<string, unknown> }).pendingQuoteRows;
    expect(pending.has('q-b1')).toBe(false);
    expect(getDuplicateQuotes(svc)).toBe(1);
    expect(repo.insert).toHaveBeenCalledTimes(1);
  });

  it('qC: mixed batch — duplicate row excluded, remaining rows requeued', async () => {
    const repo = fakeRepo();
    const svc = makeService(repo);

    const dupError = Object.assign(new Error(), {
      code: 'ER_DUP_ENTRY',
      errno: 1062,
      sqlState: '23000',
      message: "Duplicate entry 'q-c1' for key 'unified_option_quotes.PRIMARY'",
    });
    repo.insert.mockRejectedValueOnce(dupError);
    repo.insert.mockResolvedValueOnce({ identifiers: ['q-c2', 'q-c3'], raw: [] });

    enqueueQuotes(svc, [
      makeQuoteRow({ id: 'q-c1' }),
      makeQuoteRow({ id: 'q-c2' }),
      makeQuoteRow({ id: 'q-c3' }),
    ]);

    const first = await callQuoteFlush(svc);
    expect(first).toBe(0);
    expect(getDuplicateQuotes(svc)).toBe(1);

    const pending = (svc as unknown as { pendingQuoteRows: Map<string, unknown> }).pendingQuoteRows;
    expect(pending.has('q-c1')).toBe(false);
    expect(pending.has('q-c2')).toBe(true);
    expect(pending.has('q-c3')).toBe(true);

    const second = await callQuoteFlush(svc);
    expect(second).toBe(2);
    expect(repo.insert).toHaveBeenCalledTimes(2);
  });

  it('qD: genuine DB error — still requeues ALL rows', async () => {
    const repo = fakeRepo();
    const svc = makeService(repo);

    const netError = Object.assign(new Error('Connection reset'), { code: 'ECONNRESET', errno: -104 });
    repo.insert.mockRejectedValueOnce(netError);

    enqueueQuotes(svc, [makeQuoteRow({ id: 'q-d1' }), makeQuoteRow({ id: 'q-d2' })]);
    const count = await callQuoteFlush(svc);

    expect(count).toBe(0);
    const pending = (svc as unknown as { pendingQuoteRows: Map<string, unknown> }).pendingQuoteRows;
    expect(pending.has('q-d1')).toBe(true);
    expect(pending.has('q-d2')).toBe(true);
    expect(getDuplicateQuotes(svc)).toBe(0);
  });

  it('qE: duplicate never overwrites a historical row', async () => {
    const repo = fakeRepo();
    const svc = makeService(repo);

    enqueueQuotes(svc, [makeQuoteRow({ id: 'q-e1' })]);
    await callQuoteFlush(svc);
    const stored = repo._store.get('q-e1');
    expect(stored).toBeDefined();

    const dupError = Object.assign(new Error(), {
      code: 'ER_DUP_ENTRY',
      errno: 1062,
      sqlState: '23000',
      message: "Duplicate entry 'q-e1' for key 'unified_option_quotes.PRIMARY'",
    });
    repo.insert.mockRejectedValueOnce(dupError);

    enqueueQuotes(svc, [makeQuoteRow({ id: 'q-e1', ltp: 999.99 })]);
    await callQuoteFlush(svc);

    expect(repo._store.get('q-e1')).toBe(stored);
    expect(getDuplicateQuotes(svc)).toBe(1);
    expect(repo.insert).toHaveBeenCalledTimes(2);
  });

  it('qF: no fabricated fallback — error path does not invent data', async () => {
    const repo = fakeRepo();
    const svc = makeService(repo);

    const accessError = Object.assign(new Error('Access denied'), { code: 'ER_ACCESS_DENIED_ERROR', errno: 1045 });
    repo.insert.mockRejectedValueOnce(accessError);

    enqueueQuotes(svc, [makeQuoteRow({ id: 'q-f1' })]);
    const count = await callQuoteFlush(svc);

    expect(count).toBe(0);
    expect(repo._store.size).toBe(0);
    expect(getDuplicateQuotes(svc)).toBe(0);
    expect((svc as unknown as { flushedRows: number }).flushedRows).toBe(0);
    const pending = (svc as unknown as { pendingQuoteRows: Map<string, unknown> }).pendingQuoteRows;
    expect(pending.has('q-f1')).toBe(true);
  });

  it('reset() clears the duplicate-quote counter', async () => {
    const repo = fakeRepo();
    const svc = makeService(repo);

    (svc as unknown as { duplicateQuotes: number }).duplicateQuotes = 5;
    await Promise.resolve((svc as unknown as { reset(): unknown }).reset());
    expect((svc as unknown as { duplicateQuoteCount(): number }).duplicateQuoteCount()).toBe(0);
  });
});
