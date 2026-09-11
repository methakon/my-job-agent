#!/usr/bin/env node
/**
 * MySQL pool reliability regression tests (authorised 2026-09-11 fix).
 *
 * Measured failure: the SSH tunnel to the one Oracle Cloud MySQL drops
 * connections silently, so a pool can hold a black-holed socket. Queries
 * assigned to that socket never return, and with the default configuration the
 * socket is never recognised as dead — the FYERS producer's lease-heartbeat
 * writes froze behind it for minutes while tick writes kept succeeding on the
 * healthy members of the SAME pool.
 *
 * What must hold:
 *  1. The production TypeORM config carries mysql2's OWN pool/connection
 *     reliability options — keepalive with an explicit delay, and a `maxIdle`
 *     that arms mysql2's idle reaper — and does NOT touch the pool size.
 *  2. Those options survive TypeORM's option merge into the object it hands to
 *     mysql2's `createPool`, and mysql2 parses them into its real pool config
 *     with the idle reaper actually armed.
 *  3. Without the tuning the reaper is NOT armed (so the fix is load-bearing,
 *     not decoration), and no invented/unsupported option is used.
 *  4. A failing/black-holed pooled connection is DISCARDED and REPLACED: the
 *     query fails (it cannot hang forever), keepalive was applied to the
 *     socket, the dead connection leaves the pool, and the next query opens a
 *     fresh one.
 *  5. A lease path behind a dead connection cannot freeze provider liveness:
 *     the heartbeat keeps advancing across successive poll cycles, and the
 *     app-side heartbeat flush still completes (bounded) and writes its lease.
 *
 * Pure/offline: no database is required. The only socket used is a local
 * black-hole TCP server on 127.0.0.1 that never sends a handshake.
 */
const assert = require('assert');
const net = require('net');

const { mysqlConfig, mysqlPoolTuning } = require('../dist/shared/db.config');
const { sessionStorePoolOptions } = require('../dist/session/mysql-session.store');
const dataSource = require('../dist/datasource').default;
const { FeedArbitrationService } = require('../dist/trading/unified-market-data/feed-arbitration.service');
const { FnoMarketDataService } = require('../dist/trading/fno-market-data.service');
const { DataSource } = require('typeorm');
const { MysqlDriver } = require('typeorm/driver/mysql/MysqlDriver');
const mysql2 = require('mysql2');
const mysql2p = require('mysql2/promise');

let pass = 0;
const ok = (label) => { pass++; console.log(`  ${pass} ${label} ok`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const never = () => new Promise(() => {});

/** Stop mysql2's unref-less idle-reaper timer so this process can exit. */
const disarmReaper = (core) => {
  if (core && core._removeIdleTimeoutConnectionsTimer) clearTimeout(core._removeIdleTimeoutConnectionsTimer);
};

/** A TCP server that accepts connections and then never speaks MySQL. */
async function blackHoleServer() {
  let connections = 0;
  const sockets = new Set();
  const server = net.createServer((socket) => {
    connections += 1;
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    server,
    port: server.address().port,
    count: () => connections,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** Fake `this` for FeedArbitrationService, resolved through the real prototype. */
const arbitrationCtx = (over = {}) => Object.assign(Object.create(FeedArbitrationService.prototype), {
  enabled: true,
  mode: 'universe',
  staleAfterMs: 3_000,
  downAfterMs: 8_000,
  leaseTtlMs: 90_000,
  heartbeatMs: 15_000,
  dbTimeoutMs: 250,
  cache: null,
  cacheMs: 2_000,
  lastHeartbeatMs: new Map(),
  lastState: new Map(),
  lastFailOpenWarnMs: 0,
  host: 'test-host',
  local: new Map(),
  logger: { log: () => {}, warn: () => {} },
  leases: { find: async () => [], upsert: async () => {} },
  ...over,
});

/** Fake `this` for the FYERS arbiter ownership watch (compiled TS private). */
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

async function main() {
  console.log('mysql pool reliability (black-holed socket) regression tests\n');
  const realSetKeepAlive = net.Socket.prototype.setKeepAlive;
  // withTimeout's timers are unref'd (they must never delay shutdown in a
  // service), and a hung lease promise holds nothing — so the harness keeps the
  // event loop alive the way a real service's sockets do.
  const keepAlive = setInterval(() => {}, 1_000);

  // ── 1. Production config carries the driver-supported tuning ──────────────
  {
    const tuning = mysqlPoolTuning();
    assert.deepEqual(
      tuning,
      { enableKeepAlive: true, keepAliveInitialDelay: 10_000, maxIdle: 2, idleTimeout: 30_000 },
      'the tuning is exactly the four mysql2-supported options',
    );
    const opts = mysqlConfig('myjob_agent');
    assert.deepEqual(opts.extra, tuning, 'the runtime TypeORM config passes the tuning through `extra`');
    assert.equal(opts.poolSize, undefined, 'the pool SIZE is not set (mysql2 default 10 is unchanged)');
    assert.deepEqual(dataSource.options.extra, tuning, 'the CLI/migration DataSource carries the same tuning');
    const session = sessionStorePoolOptions();
    assert.equal(session.enableKeepAlive, true);
    assert.equal(session.keepAliveInitialDelay, 10_000);
    assert.equal(session.maxIdle, 2);
    assert.equal(session.idleTimeout, 30_000);
    assert.equal(session.connectionLimit, 4, 'the session pool size is unchanged');
    assert.ok(session.maxIdle < session.connectionLimit, 'maxIdle < connectionLimit so mysql2 arms its reaper');
    ok('production configs (runtime, migrations, sessions) carry keepalive + bounded idle reaping, sizes unchanged');
  }

  // ── 2. TypeORM → mysql2: the options reach the real pool ──────────────────
  {
    const opts = { ...mysqlConfig('myjob_agent') };
    const driver = new MysqlDriver(new DataSource(opts));
    driver.loadDependencies();
    // The exact object TypeORM hands to mysql2's createPool (MysqlDriver line ~1056).
    const connOpts = driver.createConnectionOptions(opts, opts);
    assert.equal(connOpts.enableKeepAlive, true, 'TypeORM forwards enableKeepAlive into the pool options');
    assert.equal(connOpts.keepAliveInitialDelay, 10_000);
    assert.equal(connOpts.maxIdle, 2);
    assert.equal(connOpts.idleTimeout, 30_000);
    assert.equal(connOpts.connectionLimit, undefined, 'TypeORM passes no pool-size override');

    const core = mysql2.createPool({ ...connOpts, host: '127.0.0.1', port: 1, user: 'u', database: 'd' });
    // mysql2 keeps connection-level options under `config.connectionConfig`.
    assert.equal(core.config.connectionConfig.enableKeepAlive, true);
    assert.equal(core.config.connectionConfig.keepAliveInitialDelay, 10_000);
    assert.equal(core.config.maxIdle, 2);
    assert.equal(core.config.idleTimeout, 30_000);
    assert.equal(core.config.connectionLimit, 10, 'mysql2 default pool size, untouched by the tuning');
    assert.ok(core._removeIdleTimeoutConnectionsTimer, 'mysql2 armed its idle-connection reaper');
    disarmReaper(core);
    await new Promise((resolve) => core.end(resolve));
    ok('mysql2 parses the tuning into its real pool config and arms the idle reaper (no invented options)');
  }

  // ── 3. Baseline: without the tuning the reaper is dead weight/ABSENT ──────
  {
    const untuned = mysql2.createPool({ host: '127.0.0.1', port: 1, user: 'u', database: 'd' });
    assert.equal(untuned.config.connectionConfig.enableKeepAlive, true, 'mysql2 enables keepalive by default…');
    assert.equal(untuned.config.connectionConfig.keepAliveInitialDelay, undefined, '…but with no explicit delay (the fix adds 10s)');
    assert.equal(untuned.config.maxIdle, untuned.config.connectionLimit, 'maxIdle defaults to connectionLimit…');
    assert.equal(untuned._removeIdleTimeoutConnectionsTimer, undefined, '…so the idle reaper is never armed');
    await new Promise((resolve) => untuned.end(resolve));
    ok('the fix is load-bearing: reaping is off until maxIdle is set below the pool size');
  }

  // ── 4. Black-holed socket: discarded and replaced, keepalive applied ──────
  {
    const hole = await blackHoleServer();
    const keepAliveCalls = [];
    net.Socket.prototype.setKeepAlive = function (enable, delay) {
      keepAliveCalls.push({ enable, delay });
      return realSetKeepAlive.call(this, enable, delay);
    };
    const pool = mysql2p.createPool({
      ...mysqlPoolTuning(),
      host: '127.0.0.1',
      port: hole.port,
      user: 'u',
      database: 'd',
      connectTimeout: 600,
      connectionLimit: 2,
    });
    try {
      const t0 = Date.now();
      let firstError;
      try { await pool.query('SELECT 1'); } catch (error) { firstError = error; }
      const firstMs = Date.now() - t0;
      assert.ok(firstError, 'a query on a dead/black-holed connection must fail, not hang forever');
      assert.ok(firstMs < 5_000, `the failure is bounded (took ${firstMs}ms)`);
      assert.ok(
        keepAliveCalls.some((call) => call.enable === true && call.delay === 10_000),
        'keepalive was applied to the driver socket with the configured 10s initial delay',
      );
      assert.equal(pool.pool._allConnections.length, 0, 'the dead connection is discarded from the pool');
      assert.equal(hole.count(), 1, 'one socket was opened for the failed attempt');

      let secondError;
      try { await pool.query('SELECT 1'); } catch (error) { secondError = error; }
      assert.ok(secondError, 'the retry also fails while the peer is black-holed');
      assert.equal(hole.count(), 2, 'the next query opened a FRESH socket instead of reusing the dead one');
    } finally {
      net.Socket.prototype.setKeepAlive = realSetKeepAlive;
      await pool.end();
      await hole.close();
    }
    ok('a black-holed pooled connection is detected, discarded and replaced (never reused)');
  }

  // ── 5. Provider liveness cannot freeze behind a dead connection ───────────
  {
    // (a) the FYERS ownership watch: the lease read never returns, yet the
    //     heartbeat must advance on EVERY poll cycle, not just once. The poll
    //     interval has a 5s floor, so this costs ~2 cycles of wall clock.
    const beats = [];
    const ctx = watchCtx({
      arbitration: { beat: async (name, patch) => { beats.push({ name, patch, at: Date.now() }); }, decisions: () => never() },
    });
    const prevPoll = process.env.FEED_OWNERSHIP_POLL_MS;
    process.env.FEED_OWNERSHIP_POLL_MS = '5000';
    FnoMarketDataService.prototype.startArbiterOwnershipWatch.call(ctx);
    await sleep(10_600);
    clearInterval(ctx.arbiterPollTimer);
    if (prevPoll === undefined) delete process.env.FEED_OWNERSHIP_POLL_MS; else process.env.FEED_OWNERSHIP_POLL_MS = prevPoll;
    assert.ok(beats.length >= 3, `the heartbeat keeps advancing behind a dead lease connection (${beats.length} beats)`);
    assert.ok(beats.every((b) => b.name === 'FYERS_WS' && b.patch.state === 'ACTIVE'));
    assert.ok(beats.at(-1).at - beats[0].at >= 5_000, 'successive beats are a poll interval apart, not one-off');
    assert.equal(ctx.arbiterDecisionAt, null, 'no ownership is invented from a hung read');

    // (b) the app-side heartbeat flush must complete within the bound and still
    //     write its lease, cycle after cycle, even though the lease READ hangs.
    const rows = [];
    const app = arbitrationCtx({
      // The real loop beats once per FEED_HEARTBEAT_MS; 0 makes every cycle write
      // so three cycles prove three heartbeats (state unchanged would otherwise
      // throttle the repeat).
      heartbeatMs: 0,
      local: new Map([['FYERS_WS', {
        name: 'FYERS_WS', priority: 0, universes: ['NIFTY'],
        enabled: () => true, credentialsOk: () => true, ageMs: () => 1_000,
      }]]),
      leases: { find: () => never(), upsert: async (row) => { rows.push(row); } },
    });
    for (let cycle = 1; cycle <= 3; cycle++) {
      const t0 = Date.now();
      await FeedArbitrationService.prototype.flushHeartbeats.call(app);
      const dt = Date.now() - t0;
      assert.ok(dt < 2_000, `cycle ${cycle} flush is bounded by the lease timeout (took ${dt}ms)`);
      assert.equal(rows.length, cycle, `cycle ${cycle} still wrote its lease while the read hung`);
    }
    assert.equal(rows.filter((r) => r.feedName === 'FYERS_WS').length, 3);
    assert.equal(app.lastHeartbeatMs.has('FYERS_WS'), true, 'a delivered beat is recorded');
    ok('heartbeat keeps advancing and the lease write lands, cycle after cycle, while the connection is dead');
  }

  clearInterval(keepAlive);
  console.log(`\n${pass} checks passed, 0 failed`);
}

main().catch((error) => {
  console.error(`\nFAILED: ${error.message}`);
  if (process.env.DB_POOL_TEST_TRACE) console.error(error.stack);
  process.exit(1);
});
