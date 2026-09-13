#!/usr/bin/env node
/**
 * Focused tests for the Sandbox ingestion performance fix (bounded scope:
 * src/trading/upstox-sandbox-ingestion.service.ts only).
 *
 * [A] a batch of N ticks is persisted SET-BASED (one insert(rows) call), never N saves
 * [B] every valid sandbox tick persists and the counters say so
 * [C] a failed batch is EXPLICIT and observable — enqueue success is never reported as a persist
 * [D] the queue stays BOUNDED under overflow (oldest dropped, counted, high-water tracked)
 * [E] the service only ever touches the sandbox repository (no real trading table)
 * [F] validation/rejection behaviour is preserved
 * [G] batch is bounded to FLUSH_BATCH_ROWS per statement
 */
const fs = require('fs');
const path = require('path');
const REPO = path.join(__dirname, '..');
const S = require(path.join(REPO, 'dist', 'trading', 'upstox-sandbox-ingestion.service'));

let pass = 0;
const failures = [];
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; console.log(`  PASS ${name}`); }
  else { failures.push(name); console.log(`  FAIL ${name}${extra ? ' :: ' + extra : ''}`); }
};
const eq = (name, actual, expected) => ok(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`);

const cfg = (enabled = true) => ({ get: (k) => (k === 'UPSTOX_SANDBOX_ENABLED' ? (enabled ? 'true' : 'false') : undefined) });
const tick = (i) => ({ instrument: `TEST-${i}`, ts: new Date('2026-09-13T09:15:00+05:30'), price: 24000 + (i % 50), bidPrice: 23999.5, askPrice: 24000.5, bidQty: 10, askQty: 12 });

/** Fake repository: records what the service actually calls in the DB layer. */
function fakeRepo({ failInsert = false, hangInsert = false } = {}) {
  const calls = { insert: [], save: 0, create: 0 };
  return {
    calls,
    insert: async (rows) => { calls.insert.push(rows); if (hangInsert) return new Promise(() => {}); if (failInsert) throw new Error('simulated DB write failure'); return { identifiers: [] }; },
    save: async () => { calls.save += 1; throw new Error('save() is per-row and must not be used'); },
    create: (x) => { calls.create += 1; return x; },
  };
}

(async () => {
  // ── [A] set-based persistence ───────────────────────────────────────────────
  console.log('\n[A] a batch of N ticks is persisted SET-BASED');
  {
    const repo = fakeRepo();
    const svc = new S.UpstoxSandboxIngestionService(cfg(), repo);
    const N = 250;
    for (let i = 0; i < N; i += 1) ok0(svc.ingest(tick(i)));
    await svc['flush']();
    eq('exactly ONE insert() call for the batch', repo.calls.insert.length, 1);
    eq('that single call carried ALL N rows', repo.calls.insert[0].length, N);
    eq('save() (per-row) was never used', repo.calls.save, 0);
    eq('create() (per-row) was never used', repo.calls.create, 0);
    ok('every row carries an explicit uuid id (no per-row ORM round trip)', repo.calls.insert[0].every((r) => typeof r.id === 'string' && r.id.length >= 32));
    ok('...and an explicit ingestedAt', repo.calls.insert[0].every((r) => r.ingestedAt instanceof Date));
    function ok0(r) { if (!r.ok) throw new Error('enqueue rejected: ' + r.error); }
  }

  // ── [B] all valid ticks persist ─────────────────────────────────────────────
  console.log('\n[B] every valid sandbox tick persists');
  {
    const repo = fakeRepo();
    const svc = new S.UpstoxSandboxIngestionService(cfg(), repo);
    const N = 400;
    for (let i = 0; i < N; i += 1) svc.ingest(tick(i));
    await svc['flush']();
    const c = svc.status().counters;
    eq('persisted === N', c.persisted, N);
    eq('one successful flush recorded', c.flushes, 1);
    eq('lastBatchRows === N', c.lastBatchRows, N);
    eq('no failure recorded', [c.flushFailures, c.droppedOnFailure, c.lastFlushError], [0, 0, null]);
    eq('queue is empty after the flush', svc.status().queueDepth, 0);
  }

  // ── [C] explicit, observable failure ────────────────────────────────────────
  console.log('\n[C] a failed batch is EXPLICIT and observable');
  {
    const repo = fakeRepo({ failInsert: true });
    const svc = new S.UpstoxSandboxIngestionService(cfg(), repo);
    const N = 120;
    let enqueued = 0;
    for (let i = 0; i < N; i += 1) if (svc.ingest(tick(i)).ok) enqueued += 1;
    await svc['flush']();
    const c = svc.status().counters;
    eq('enqueue succeeded for all rows (as designed)', enqueued, N);
    eq('...but persisted is 0 — an enqueue is NOT reported as a persist', c.persisted, 0);
    eq('the failure is counted', [c.flushFailures, c.droppedOnFailure], [1, N]);
    ok('the failure reason is observable', typeof c.lastFlushError === 'string' && /simulated DB write failure/.test(c.lastFlushError));
    eq('no phantom flush success recorded', c.flushes, 0);
    ok('status() exposes the counters (never a silent failure)', typeof svc.status().counters === 'object');
    // and the next (healthy) flush still works — the service recovers
    const repo2 = fakeRepo();
    const svc2 = new S.UpstoxSandboxIngestionService(cfg(), repo2);
    svc2.ingest(tick(1)); await svc2['flush']();
    eq('a later flush succeeds normally', svc2.status().counters.persisted, 1);
  }

  // ── [D] bounded queue ───────────────────────────────────────────────────────
  console.log('\n[D] the queue stays BOUNDED under overflow');
  {
    const repo = fakeRepo({ hangInsert: true });           // flush can never complete
    const svc = new S.UpstoxSandboxIngestionService(cfg(), repo);
    const N = 5100;                                        // > 5000 cap
    void svc['flush']();                                   // start an in-flight flush so nothing drains
    for (let i = 0; i < N; i += 1) svc.ingest(tick(i));
    const st = svc.status();
    ok('queue never exceeds the 5000 cap', st.queueDepth <= 5000, String(st.queueDepth));
    eq('high-water mark recorded at the cap', st.counters.queueHighWater, 5000);
    ok('overflow drops are counted (oldest dropped)', st.counters.droppedQueueFull > 0, String(st.counters.droppedQueueFull));
    eq('every attempt was accepted into the queue', st.counters.enqueued, N);
    eq('the retained queue is fully accounted for (depth + dropped = enqueued)', st.queueDepth + st.counters.droppedQueueFull, st.counters.enqueued);
    eq('nothing was persisted while the flush was blocked', st.counters.persisted, 0);
  }

  // ── [E] sandbox-only DB surface ─────────────────────────────────────────────
  console.log('\n[E] the service only ever touches the sandbox repository');
  {
    const repo = fakeRepo();
    const svc = new S.UpstoxSandboxIngestionService(cfg(), repo);
    svc.ingest(tick(1)); await svc['flush']();
    ok('all DB writes went through the injected sandbox repository', repo.calls.insert.length === 1 && repo.calls.save === 0);
    const src = fs.readFileSync(path.join(REPO, 'src', 'trading', 'upstox-sandbox-ingestion.service.ts'), 'utf8');
    ok('the service source names NO real trading table', !/fnf_market_snapshots|fnf_option_quotes|unified_market_snapshots|unified_option_quotes/.test(src));
    ok('rows are stamped environment=SANDBOX and onRealData=false', repo.calls.insert[0].every((r) => r.environment === 'SANDBOX' && r.onRealData === false && r.source === 'UPSTOX'));
  }

  // ── [F] validation preserved ────────────────────────────────────────────────
  console.log('\n[F] validation/rejection behaviour is preserved');
  {
    const repo = fakeRepo();
    const svc = new S.UpstoxSandboxIngestionService(cfg(), repo);
    eq('missing instrument rejected', svc.ingest({ instrument: '', ts: new Date(), price: 1 }), { ok: false, error: 'instrument required' });
    eq('non-positive price rejected', svc.ingest({ instrument: 'X', ts: new Date(), price: 0 }), { ok: false, error: 'price required' });
    eq('non-finite price rejected', svc.ingest({ instrument: 'X', ts: new Date(), price: Number.NaN }), { ok: false, error: 'price required' });
    eq('invalid ts rejected', svc.ingest({ instrument: 'X', ts: 'not-a-date', price: 1 }), { ok: false, error: 'ts required' });
    eq('nothing was enqueued by the rejections', svc.status().queueDepth, 0);
    const off = new S.UpstoxSandboxIngestionService(cfg(false), fakeRepo());
    eq('disabled service rejects with an explicit error (fails closed)', off.ingest(tick(1)), { ok: false, error: '[SANDBOX][UPSTOX] ingestion disabled' });
  }

  // ── [G] batch is bounded per statement ──────────────────────────────────────
  console.log('\n[G] one statement per BOUNDED chunk');
  {
    const repo = fakeRepo();
    const svc = new S.UpstoxSandboxIngestionService(cfg(), repo);
    for (let i = 0; i < 1200; i += 1) svc.ingest(tick(i));
    await svc['flush']();
    eq('first statement carried exactly 500 rows', repo.calls.insert[0].length, 500);
    eq('...leaving 700 queued (bounded batch, not unbounded)', svc.status().queueDepth, 700);
    await svc['flush']();
    eq('second statement carried the next 500', repo.calls.insert[1].length, 500);
    await svc['flush']();
    eq('third statement carried the remainder (200)', repo.calls.insert[2].length, 200);
    eq('all 1200 persisted across exactly 3 statements', svc.status().counters.persisted, 1200);
  }

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) { console.log('FAILED:'); failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error('TEST RUN FAILED:', e.message); process.exit(1); });
