#!/usr/bin/env node
/**
 * Dedicated feed-arbitration lease connection (authorised option (b), 2026-09-11).
 *
 * Measured failure being fixed: on the SHARED application pool the arbiter's lease
 * read/write timed out (8 s bound) while that same pool kept serving ~48 market-data
 * inserts/s, so the FYERS provider's heartbeat froze for minutes and the other
 * process kept treating it as dead. The control path must be isolated, bounded and
 * recoverable — and must never make ownership look fresh when it is not.
 *
 * What must hold:
 *  1. ONE dedicated connection serves lease reads/writes, reused across operations
 *     (not the application pool, not a connection per operation).
 *  2. A failed/timed-out WRITE is bounded, is NOT recorded as delivered, does not
 *     refresh the stored heartbeat, and recycles/destroys the connection.
 *  3. A failed/timed-out READ is bounded, fails OPEN (local producers keep their
 *     award) and recycles the connection — never inventing a lease candidate.
 *  4. Connection recovery: after a failure the next operation opens a FRESH
 *     connection and succeeds (both a dead-socket failure and a connect failure).
 *  5. Stale-lease expiry still decides ownership: a lease whose heartbeat is older
 *     than the TTL loses its universe; once fresh it takes it back (failover /
 *     controlled-failback semantics preserved, exactly one owner per universe).
 *  6. Connect is bounded: the real factory gives up on its own connectTimeout
 *     against a peer that never completes the handshake.
 *
 * Offline: the arbiter runs against a fake lease table; only check 6 opens a socket,
 * and only to a local black-hole TCP server.
 */
const assert = require('assert');
const net = require('net');

const { DedicatedLeaseStore, DEFAULT_LEASE_CONNECT_TIMEOUT_MS, defaultLeaseConnectionFactory } =
  require('../dist/trading/unified-market-data/lease-connection.store');
const { FeedArbitrationService } = require('../dist/trading/unified-market-data/feed-arbitration.service');

let pass = 0;
const ok = (label) => { pass++; console.log(`  ${pass} ${label} ok`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const never = () => new Promise(() => {});

/** Fake lease table + fake connections ('ok' | 'hang' | 'fail'). */
function fakeDb(modes = []) {
  const state = {
    rows: new Map(),
    opens: 0,
    destroyed: 0,
    graceful: 0,
    connections: [],
  };
  const makeConnection = (mode) => {
    const connection = {
      mode,
      destroyed: false,
      async query(sql) {
        if (mode === 'hang') return never();
        if (mode === 'fail') throw new Error('ECONNRESET (simulated dead lease socket)');
        assert.match(sql, /SELECT/i, 'only the lease SELECT is issued on this connection');
        return [[...state.rows.values()], []];
      },
      async execute(sql, params) {
        if (mode === 'hang') return never();
        if (mode === 'fail') throw new Error('ECONNRESET (simulated dead lease socket)');
        assert.match(sql, /INSERT INTO market_data_feed_leases/i, 'only the lease upsert is issued on this connection');
        state.rows.set(params[0], {
          feedName: params[0], priority: params[1], universes: params[2], enabled: params[3],
          credentialsOk: params[4], state: params[5], host: params[6], pid: params[7],
          lastTickAt: params[8], heartbeatAt: params[9], note: params[10], updatedAt: params[11],
        });
        return [{ affectedRows: 1 }, []];
      },
      destroy() { this.destroyed = true; state.destroyed += 1; },
      async end() { state.graceful += 1; },
    };
    state.connections.push(connection);
    return connection;
  };
  return {
    state,
    factory: () => { state.opens += 1; return Promise.resolve(makeConnection(modes.shift() ?? 'ok')); },
    // A factory whose CONNECT itself fails the first time (no socket is ever made).
    connects: () => {
      let calls = 0;
      return () => {
        calls += 1;
        if (calls === 1) return Promise.reject(new Error('connect ETIMEDOUT (simulated)'));
        state.opens += 1;
        return Promise.resolve(makeConnection(modes.shift() ?? 'ok'));
      };
    },
  };
}

/** Arbiter warnings are collected so a silent catch cannot hide a failure. */
const warns = [];

/** Real arbiter, fake transport (resolved through the production prototype). */
const ctx = (leaseStore, over = {}) => Object.assign(Object.create(FeedArbitrationService.prototype), {
  enabled: true,
  mode: 'universe',
  staleAfterMs: 10_000,
  downAfterMs: 60_000,
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
  logger: { log: () => {}, warn: (message) => { warns.push(String(message)); } },
  leases: leaseStore,
  ...over,
});

const registration = (name, priority, universes, ageMs) => ({
  name, priority, universes, enabled: () => true, credentialsOk: () => true, ageMs: () => ageMs,
});

const beat = (context, feedName, extra = {}) => FeedArbitrationService.prototype.beat.call(context, feedName, {
  state: 'ACTIVE', universes: ['NIFTY', 'BANKNIFTY'], priority: 0, credentialsOk: true,
  lastTickAt: new Date(), force: true, ...extra,
});

async function main() {
  console.log('dedicated feed-arbitration lease connection tests\n');
  // withTimeout timers are unref'd (a service must never be delayed by them) and a
  // hung lease promise holds nothing — the harness keeps the loop alive itself.
  const keepAlive = setInterval(() => {}, 1_000);

  // ── 1. ONE dedicated connection, reused ───────────────────────────────────
  {
    const db = fakeDb();
    const store = new DedicatedLeaseStore(db.factory);
    const context = ctx(store, {
      local: new Map([['FYERS_WS', registration('FYERS_WS', 0, ['NIFTY', 'BANKNIFTY'], 500)]]),
    });
    const before = Date.now();
    await beat(context, 'FYERS_WS');
    assert.equal(db.state.opens, 1, 'exactly one dedicated connection is opened');
    assert.equal(context.lastHeartbeatMs.has('FYERS_WS'), true, 'a delivered beat is recorded');

    const rows = await store.find();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].feedName, 'FYERS_WS');
    assert.equal(rows[0].enabled, true, 'tinyint comes back as a boolean');
    assert.equal(rows[0].state, 'ACTIVE');
    assert.equal(rows[0].universes, 'NIFTY,BANKNIFTY');
    const hbAge = Date.now() - new Date(rows[0].heartbeatAt).getTime();
    assert.ok(hbAge >= 0 && hbAge < 5_000, `heartbeat is fresh (${hbAge}ms)`);
    assert.ok(new Date(rows[0].heartbeatAt).getTime() >= before - 1_000);

    await beat(context, 'FYERS_WS');
    await store.find();
    assert.equal(db.state.opens, 1, 'later reads/writes reuse the SAME connection (no per-op acquire)');
    assert.equal(store.stats.recycles, 0, 'no recycle on the healthy path');
    ok('one dedicated connection carries lease writes and reads, and is reused');
  }

  // ── 2. Failed/timed-out WRITE: bounded, not delivered, no false renewal ────
  {
    const db = fakeDb(['hang']);
    const store = new DedicatedLeaseStore(db.factory);
    const context = ctx(store, {
      local: new Map([['FYERS_WS', registration('FYERS_WS', 0, ['NIFTY', 'BANKNIFTY'], 500)]]),
    });
    // Seed a lease that is already 80 s old (still inside the 90 s TTL). It is
    // written straight into the fake table: this check is about the WRITE path.
    const staleAt = new Date(Date.now() - 80_000);
    db.state.rows.set('FYERS_WS', {
      feedName: 'FYERS_WS', priority: 0, universes: 'NIFTY,BANKNIFTY', enabled: 1, credentialsOk: 1,
      state: 'ACTIVE', host: 'test-host', pid: 1, lastTickAt: staleAt, heartbeatAt: staleAt, note: null, updatedAt: staleAt,
    });

    const t0 = Date.now();
    await beat(context, 'FYERS_WS');
    const dt = Date.now() - t0;
    assert.ok(dt >= 200 && dt < 2_000, `the write is bounded by the lease timeout (took ${dt}ms)`);
    assert.equal(context.lastHeartbeatMs.has('FYERS_WS'), false, 'a timed-out write is NOT recorded as delivered');
    assert.equal(db.state.rows.get('FYERS_WS').heartbeatAt.getTime(), staleAt.getTime(),
      'the stored heartbeat is untouched — a failed renewal never makes a lease look fresh');
    assert.equal(store.stats.recycles, 1, 'the transport is recycled on the timeout');
    assert.equal(db.state.destroyed, 1, 'the wedged connection is destroyed, never reused');
    ok('a hung lease write is bounded, is not delivered, and cannot renew a lease');
  }

  // ── 3. Failed READ: bounded, fails OPEN, recycled, no invented candidate ───
  {
    const db = fakeDb(['fail']);
    const store = new DedicatedLeaseStore(db.factory);
    db.state.rows.set('FYERS_WS', {
      feedName: 'FYERS_WS', priority: 0, universes: 'NIFTY,BANKNIFTY', enabled: 1, credentialsOk: 1,
      state: 'ACTIVE', host: 'other-host', pid: 2, lastTickAt: new Date(), heartbeatAt: new Date(), note: null, updatedAt: new Date(),
    });
    const context = ctx(store, {
      local: new Map([['UPSTOX_REST', registration('UPSTOX_REST', 1, ['NIFTY', 'SENSEX'], 2_000)]]),
    });
    const t0 = Date.now();
    const decisions = await FeedArbitrationService.prototype.decisions.call(context);
    const dt = Date.now() - t0;
    assert.ok(dt < 2_000, `the read failure is bounded (took ${dt}ms)`);
    const nifty = decisions.find((d) => d.universe === 'NIFTY');
    assert.equal(nifty.owner, 'UPSTOX_REST', 'a dead lease read fails OPEN for the local producer');
    assert.equal(store.stats.recycles, 1, 'the transport is recycled after the failed read');
    assert.equal(db.state.destroyed, 1, 'the failing connection is destroyed');
    ok('a failed lease read is bounded, fails OPEN and never invents a lease candidate');
  }

  // ── 4. Connection recovery: the next operation gets a FRESH connection ────
  {
    const db = fakeDb(['fail', 'ok']);
    const store = new DedicatedLeaseStore(db.factory);
    const context = ctx(store, {
      local: new Map([['FYERS_WS', registration('FYERS_WS', 0, ['NIFTY', 'BANKNIFTY'], 500)]]),
    });
    await beat(context, 'FYERS_WS');
    assert.equal(context.lastHeartbeatMs.has('FYERS_WS'), false, 'first attempt fails');
    assert.equal(db.state.opens, 1);
    assert.equal(db.state.destroyed, 1, 'dead socket destroyed');
    await beat(context, 'FYERS_WS');
    assert.equal(db.state.opens, 2, 'the retry opened a FRESH dedicated connection');
    assert.equal(context.lastHeartbeatMs.has('FYERS_WS'), true, 'and it renewed the lease');
    assert.equal((await store.find())[0].feedName, 'FYERS_WS');

    // A connect failure (no socket at all) must recover the same way.
    const db2 = fakeDb(['ok']);
    const store2 = new DedicatedLeaseStore(db2.connects());
    const context2 = ctx(store2, {
      local: new Map([['FYERS_WS', registration('FYERS_WS', 0, ['NIFTY', 'BANKNIFTY'], 500)]]),
    });
    const t0 = Date.now();
    await beat(context2, 'FYERS_WS');
    assert.ok(Date.now() - t0 < 2_000, 'a failed connect is bounded by the operation timeout');
    assert.equal(context2.lastHeartbeatMs.has('FYERS_WS'), false, 'nothing is delivered on a failed connect');
    await beat(context2, 'FYERS_WS');
    assert.equal(context2.lastHeartbeatMs.has('FYERS_WS'), true, 'the next attempt reconnects and succeeds');
    assert.equal(store2.stats.recycles, 1, 'exactly one recycle for the failed connect');
    ok('connection recovery: a fresh connection is opened and the lease is renewed');
  }

  // ── 5. Stale-lease expiry still owns the decision ─────────────────────────
  {
    const db = fakeDb();
    const store = new DedicatedLeaseStore(db.factory);
    const context = ctx(store, {
      local: new Map([['UPSTOX_REST', registration('UPSTOX_REST', 1, ['NIFTY', 'SENSEX'], 2_000)]]),
    });
    const stamp = (ageMs) => {
      const at = new Date(Date.now() - ageMs);
      db.state.rows.set('FYERS_WS', {
        feedName: 'FYERS_WS', priority: 0, universes: 'NIFTY,BANKNIFTY', enabled: 1, credentialsOk: 1,
        state: 'ACTIVE', host: 'agent-host', pid: 9, lastTickAt: at, heartbeatAt: at, note: null, updatedAt: at,
      });
      context.cache = null; // decisions are cached for 2 s
    };

    const stale = await (async () => { stamp(200_000); return FeedArbitrationService.prototype.decisions.call(context); })();
    const staleNifty = stale.find((d) => d.universe === 'NIFTY');
    assert.equal(staleNifty.owner, 'UPSTOX_REST', 'a lease past its TTL loses the universe (no stale ownership)');
    assert.match(staleNifty.reason, /priority 1/, 'the surviving feed owns it on its own merits');
    assert.equal(staleNifty.standby.includes('FYERS_WS'), false, 'an expired lease is not even a standby candidate');

    stamp(5_000);
    const fresh = await FeedArbitrationService.prototype.decisions.call(context);
    const freshNifty = fresh.find((d) => d.universe === 'NIFTY');
    assert.equal(freshNifty.owner, 'FYERS_WS', 'once fresh again the priority-0 feed takes the universe back');
    assert.deepEqual(freshNifty.standby, ['UPSTOX_REST'], 'exactly one owner; the other feeds stand by');
    assert.equal(new Set(fresh.map((d) => d.universe)).size, fresh.length, 'one decision per universe');

    const status = await FeedArbitrationService.prototype.status.call(context);
    const fyers = status.candidates.find((c) => c.name === 'FYERS_WS');
    assert.equal(fyers.leaseFresh, true, 'a fresh lease is marked fresh');
    stamp(200_000);
    const statusStale = await FeedArbitrationService.prototype.status.call(context);
    assert.equal(statusStale.candidates.find((c) => c.name === 'FYERS_WS').leaseFresh, false,
      'an expired lease is reported as not fresh');
    ok('stale leases lose ownership by TTL; fresh leases take it back (priority semantics intact)');
  }

  // ── 6. Connect is bounded (real factory, black-hole peer) ─────────────────
  {
    const sockets = new Set();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('error', () => {});
      socket.on('close', () => sockets.delete(socket));
      // never send a MySQL handshake
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const prev = { port: process.env.MYSQL_PORT, timeout: process.env.FEED_LEASE_CONNECT_TIMEOUT_MS };
    process.env.MYSQL_PORT = String(server.address().port);
    process.env.FEED_LEASE_CONNECT_TIMEOUT_MS = '600';
    const t0 = Date.now();
    let error;
    try { await defaultLeaseConnectionFactory(); } catch (e) { error = e; }
    const dt = Date.now() - t0;
    if (prev.port === undefined) delete process.env.MYSQL_PORT; else process.env.MYSQL_PORT = prev.port;
    if (prev.timeout === undefined) delete process.env.FEED_LEASE_CONNECT_TIMEOUT_MS; else process.env.FEED_LEASE_CONNECT_TIMEOUT_MS = prev.timeout;
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    assert.ok(error, 'a peer that never finishes the handshake must fail, not hang');
    assert.ok(dt >= 400 && dt < 5_000, `the connect is bounded by its own timeout (took ${dt}ms)`);
    assert.ok(DEFAULT_LEASE_CONNECT_TIMEOUT_MS > 0 && Number.isFinite(DEFAULT_LEASE_CONNECT_TIMEOUT_MS));
    ok('the dedicated connection has a bounded connect timeout of its own');
  }

  clearInterval(keepAlive);
  console.log(`\n${pass} checks passed, 0 failed`);
}

main().catch((error) => {
  console.error(`\nFAILED: ${error.message}`);
  if (warns.length) console.error(`arbiter warnings: ${warns.slice(-3).join(' | ')}`);
  if (process.env.LEASE_TEST_TRACE) console.error(error.stack);
  process.exit(1);
});
