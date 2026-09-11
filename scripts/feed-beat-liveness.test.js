#!/usr/bin/env node
/**
 * Provider-liveness regression tests (2026-09-11 incident).
 *
 * Measured failure: the FYERS producer kept ticking and persisting ticks, but its
 * ownership poll awaited a lease READ that never returned, so its heartbeat
 * stopped advancing for 7+ minutes. The arbiter then treated the primary as DOWN
 * and kept NIFTY on the standby even after the primary had recovered.
 *
 * What must hold:
 *  1. withTimeout bounds any lease/DB operation and REJECTS on a hang (never
 *     fabricates a result, so a timed-out operation cannot create or preserve
 *     ownership).
 *  2. The provider heartbeat is published independently of the lease read — a
 *     hung read cannot stop it.
 *  3. A hung/failed heartbeat does not stop the award refresh either (isolation
 *     in both directions).
 *  4. A timed-out lease WRITE is not recorded as delivered (so the next poll
 *     retries and nothing is treated as ownership).
 */
const assert = require('assert');
const { FeedArbitrationService, withTimeout } = require('../dist/trading/unified-market-data/feed-arbitration.service');
const { FnoMarketDataService } = require('../dist/trading/fno-market-data.service');

let pass = 0;
const ok = (label) => { pass++; console.log(`  ${pass} ${label} ok`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const never = () => new Promise(() => {});

/** Fake `this` for the private ownership watch (compiled TS keeps it on the prototype). */
const watchCtx = (over = {}) => ({
  arbiterPollTimer: null,
  feedName: 'FYERS_WS',
  arbiterOwnerByUniverse: new Map(),
  arbiterDecisionAt: null,
  arbiterUniverses: ['NIFTY', 'BANKNIFTY'],
  statusValue: { connected: true, lastTickAt: new Date().toISOString() },
  credentialsOk: true,
  logger: { warn: () => {}, log: () => {} },
  arbiterWarnAt: 0,
  arbiterWarn: FnoMarketDataService.prototype.arbiterWarn,
  safeMessage: (error) => (error && error.message ? error.message : String(error)),
  arbitration: { beat: async () => {}, decisions: async () => [] },
  ...over,
});

/** Fake `this` for FeedArbitrationService.beat(). */
const beatCtx = (over = {}) => ({
  enabled: true,
  host: 'test-host',
  dbTimeoutMs: 300,
  local: new Map(),
  lastState: new Map(),
  lastHeartbeatMs: new Map(),
  lastFailOpenWarnMs: 0,
  cache: {},
  logger: { warn: () => {}, log: () => {} },
  leases: { upsert: async () => {} },
  ...over,
});

async function main() {
  console.log('provider-liveness (hung lease read) regression tests\n');
  const prevPoll = process.env.FEED_OWNERSHIP_POLL_MS;
  process.env.FEED_OWNERSHIP_POLL_MS = '3600000'; // one tick per hour: tests trigger it manually
  // The timeout timers are unref'd (they must never delay shutdown in a service),
  // so this harness keeps the loop alive the way a real service's sockets do —
  // otherwise Node would exit before the assertions run.
  const keepAlive = setInterval(() => {}, 1_000);

  // ── 1. withTimeout bounds a hang and passes a fast result through ──────────
  {
    const t0 = Date.now();
    let err;
    try { await withTimeout(never(), 250, 'lease read'); } catch (e) { err = e; }
    const dt = Date.now() - t0;
    assert.ok(err, 'a hung operation must reject');
    assert.match(err.message, /timed out after 250ms \(lease read\)/);
    assert.ok(dt >= 200 && dt < 3_000, `bounded (took ${dt}ms)`);
    assert.equal(await withTimeout(async () => 'ok', 250, 'fast'), 'ok', 'a fast result is returned unchanged');
    let err2;
    try { await withTimeout(() => never(), 150, 'lease write FYERS_WS'); } catch (e) { err2 = e; }
    assert.match(err2.message, /lease write FYERS_WS/, 'a hung factory function is bounded too');
    ok('withTimeout bounds hung reads/writes and rejects (never fabricates a result)');
  }

  // ── 2. CORE REGRESSION: heartbeat published while the lease read hangs ─────
  {
    const beats = [];
    const ctx = watchCtx({
      arbitration: {
        beat: async (name, patch) => { beats.push({ name, patch }); },
        decisions: () => never(), // the exact production failure
      },
    });
    FnoMarketDataService.prototype.startArbiterOwnershipWatch.call(ctx);
    await sleep(80);
    clearInterval(ctx.arbiterPollTimer);
    assert.equal(beats.length >= 1, true, 'a heartbeat must be published even though the read never resolves');
    assert.equal(beats[0].name, 'FYERS_WS');
    assert.equal(beats[0].patch.state, 'ACTIVE');
    assert.deepEqual(beats[0].patch.universes, ['NIFTY', 'BANKNIFTY'], 'coverage is published before the first award');
    assert.equal(ctx.arbiterDecisionAt, null, 'no award snapshot is invented by a failed read');
    ok('hung lease read cannot freeze the provider heartbeat (incident regression)');
  }

  // ── 3. Normal path: award snapshot is still recorded, then narrowed ───────
  {
    const beats = [];
    const ctx = watchCtx({
      arbitration: {
        beat: async (name, patch) => { beats.push(patch); },
        decisions: async () => [
          { universe: 'NIFTY', owner: 'FYERS_WS', standby: [], ranked: ['FYERS_WS'], reason: 'owns' },
          { universe: 'SENSEX', owner: 'UPSTOX_REST', standby: ['FYERS_WS'], ranked: [], reason: 'owns' },
        ],
      },
    });
    FnoMarketDataService.prototype.startArbiterOwnershipWatch.call(ctx);
    await sleep(80);
    clearInterval(ctx.arbiterPollTimer);
    assert.ok(ctx.arbiterDecisionAt, 'award snapshot recorded');
    assert.equal(ctx.arbiterOwnerByUniverse.get('NIFTY'), 'FYERS_WS');
    assert.equal(ctx.arbiterOwnerByUniverse.get('SENSEX'), 'UPSTOX_REST');
    assert.deepEqual(beats[0].universes, ['NIFTY', 'BANKNIFTY'], 'first tick publishes declared coverage');
    // Second tick (award now known) publishes only what the arbiter awarded.
    const beats2 = [];
    const ctx2 = watchCtx({
      arbiterOwnerByUniverse: new Map([['NIFTY', 'FYERS_WS'], ['SENSEX', 'UPSTOX_REST']]),
      arbitration: { beat: async (_n, patch) => { beats2.push(patch); }, decisions: async () => [] },
    });
    FnoMarketDataService.prototype.startArbiterOwnershipWatch.call(ctx2);
    await sleep(60);
    clearInterval(ctx2.arbiterPollTimer);
    assert.deepEqual(beats2[0].universes, ['NIFTY'], 'once awarded, only the owned universe is published');
    ok('normal path still publishes the awarded coverage and never invents ownership');
  }

  // ── 4. A failing heartbeat does not stop the award refresh (isolation) ────
  {
    const ctx = watchCtx({
      arbitration: {
        beat: async () => { throw new Error('lease write exploded'); },
        decisions: async () => [{ universe: 'NIFTY', owner: 'UPSTOX_REST', standby: [], ranked: [], reason: 'failed over' }],
      },
    });
    FnoMarketDataService.prototype.startArbiterOwnershipWatch.call(ctx);
    await sleep(80);
    clearInterval(ctx.arbiterPollTimer);
    assert.equal(ctx.arbiterOwnerByUniverse.get('NIFTY'), 'UPSTOX_REST', 'award refresh still ran after a failed heartbeat');
    ok('heartbeat failure and award refresh are isolated from each other');
  }

  // ── 5. A timed-out lease write is not recorded as delivered ───────────────
  {
    const ctx = beatCtx({ leases: { upsert: () => never() } });
    const t0 = Date.now();
    await FeedArbitrationService.prototype.beat.call(ctx, 'FYERS_WS', {
      priority: 0, universes: ['NIFTY'], enabled: true, credentialsOk: true, lastTickAt: new Date(),
    });
    const dt = Date.now() - t0;
    assert.ok(dt >= 250 && dt < 3_000, `beat() returns within the bound (took ${dt}ms)`);
    assert.equal(ctx.lastHeartbeatMs.has('FYERS_WS'), false, 'a timed-out write must not count as delivered');
    assert.equal(ctx.lastState.has('FYERS_WS'), false, 'no state is recorded for a failed write');
    ok('timed-out lease write is not recorded as delivered (next poll retries)');
  }

  // ── 6. A successful write still records the beat ──────────────────────────
  {
    const rows = [];
    const ctx = beatCtx({ leases: { upsert: async (row) => { rows.push(row); } } });
    await FeedArbitrationService.prototype.beat.call(ctx, 'FYERS_WS', {
      priority: 0, universes: ['NIFTY'], enabled: true, credentialsOk: true, lastTickAt: new Date(),
    });
    assert.equal(rows.length, 1, 'the lease row is written');
    assert.equal(rows[0].feedName, 'FYERS_WS');
    assert.equal(ctx.lastHeartbeatMs.has('FYERS_WS'), true, 'a delivered beat is recorded');
    assert.equal(ctx.lastState.get('FYERS_WS'), 'ACTIVE');
    ok('a delivered beat is recorded and refreshes the lease');
  }

  if (prevPoll === undefined) delete process.env.FEED_OWNERSHIP_POLL_MS; else process.env.FEED_OWNERSHIP_POLL_MS = prevPoll;
  clearInterval(keepAlive);
  console.log(`\n${pass} checks passed, 0 failed`);
}

main().catch((e) => { console.error(`\nFAILED: ${e.message}`); process.exit(1); });
