#!/usr/bin/env node
/**
 * FYERS feed recovery — watcher arm-order + socket-rebuild regression tests.
 *
 * The REAL FnoMarketDataService runs in-process against:
 *  - a fake `fyers-api-v3` SDK injected via Module._load (nothing in
 *    node_modules is touched),
 *  - stubbed collaborator services,
 *  - a stubbed ProviderTokenService whose stored token the test mutates.
 *
 * Proves:
 *  R1. A SYNCHRONOUS connect failure still leaves the retry watcher armed
 *      (the arm-order regression: watcher must be armed BEFORE connect).
 *  R2. The next watcher tick rebuilds the socket — no process restart.
 *  R3. A fresh DB token rebuilds the socket (old socket closed first).
 *  R4. No rebuild churn while the token is unchanged and connected.
 *  R5. onModuleDestroy clears the timers.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { execSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

let pass = 0;
let fail = 0;
const ok = (name) => { pass++; console.log(`  ✅ ${name}`); };
const bad = (name, err) => { fail++; console.log(`  ❌ ${name}\n     ${err && err.message ? err.message : err}`); };
const ta = async (name, fn) => { try { await fn(); ok(name); } catch (err) { bad(name, err); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, timeoutMs = 3000, stepMs = 15) => {
  const t0 = Date.now();
  for (;;) {
    if (await fn()) return true;
    if (Date.now() - t0 > timeoutMs) return false;
    await sleep(stepMs);
  }
};

// ── build ────────────────────────────────────────────────────────────────────
console.log('▶ building module (tsc) …');
try { execSync('npm run build', { cwd: ROOT, stdio: 'pipe', timeout: 240_000 }); } catch { /* dist presence asserted below */ }
const DIST = path.join(ROOT, 'dist', 'trading', 'fno-market-data.service.js');
if (!fs.existsSync(DIST)) {
  console.error('✘ dist/trading/fno-market-data.service.js missing — cannot run tests');
  process.exit(1);
}

(async () => {
  console.log('\n▶ FYERS feed recovery — arm order + rebuild\n');

  // ── fake FYERS SDK ─────────────────────────────────────────────────────────
  const sockets = [];
  let getInstanceCalls = 0;
  let failFirstConnect = true;
  const makeFakeSocket = () => {
    const handlers = {};
    return {
      connectCalls: 0,
      subscribeCalls: 0,
      closed: 0,
      on(event, cb) { handlers[event] = cb; return this; },
      connect() { this.connectCalls += 1; if (handlers.connect) handlers.connect(); },
      subscribe() { this.subscribeCalls += 1; },
      mode() {},
      autoreconnect() {},
      close() { this.closed += 1; },
    };
  };
  const fakeSdk = {
    fyersDataSocket: {
      getInstance: () => {
        getInstanceCalls += 1;
        if (failFirstConnect) {
          failFirstConnect = false;
          throw new Error('simulated synchronous socket init failure');
        }
        const s = makeFakeSocket();
        sockets.push(s);
        return s;
      },
    },
  };
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'fyers-api-v3') return fakeSdk;
    return originalLoad.call(this, request, parent, isMain);
  };

  // ── env: this test process is the feed OWNER (same selection rule as app) ──
  const envKeys = ['FNO_FEED_OWNER', 'FNO_MARKET_DATA_ENABLED', 'FNO_MARKET_DATA_PROVIDER', 'FNO_MARKET_DATA_SYMBOLS', 'FYERS_APP_ID', 'FYERS_RETRY_MS', 'FYERS_ACCESS_TOKEN'];
  const envBackup = {};
  for (const k of envKeys) envBackup[k] = process.env[k];
  process.env.FNO_FEED_OWNER = 'app';
  process.env.FNO_MARKET_DATA_ENABLED = 'true';
  process.env.FNO_MARKET_DATA_PROVIDER = 'fyers';
  process.env.FNO_MARKET_DATA_SYMBOLS = 'NSE:NIFTY50-INDEX';
  process.env.FYERS_APP_ID = 'TESTAPP-100';
  process.env.FYERS_RETRY_MS = '60000';
  delete process.env.FYERS_ACCESS_TOKEN;

  const { FnoMarketDataService } = require(DIST);

  // ── stubbed collaborators ──────────────────────────────────────────────────
  let currentToken = 'unit-token-one';
  const fyersTokens = {
    getActiveAccessToken: async () => currentToken,
    getCurrentToken: async () => null,
    getRefreshStatus: async () => ({ hasRefreshToken: false, hasPin: false }),
    getActiveTokenInfo: async () => null,
  };
  const optionChain = { configuredContracts: () => [], upsertContract: async () => {} };
  const unified = { storeFreshness: async () => ({ lastTs: null }) };
  const feedHealth = { registerFeed: () => {} };
  const arbitration = { register: () => {}, priorityFor: () => 1, beat: async () => {}, decisions: async () => [] };
  const interpreter = {
    enqueueMessage: () => {},
    metrics: () => ({
      accepted: 0, persisted: 0, rejected: 0, rejectionsByCode: {}, withheld: 0, ignored: 0,
      latency: { p50Ms: null, p95Ms: null, latencyBudgetExceeded: 0 }, lastSample: null,
    }),
  };

  try {
    const svc = new FnoMarketDataService({}, optionChain, fyersTokens, unified, feedHealth, arbitration, interpreter);
    svc.fyersRetryMs = 40; // test speed (JS view of the private field)

    await ta('R1. sync connect failure: watcher armed BEFORE the connect attempt (regression)', async () => {
      await svc.onModuleInit();
      assert.ok(svc.fyersRetryTimer, 'retry watcher must be armed even when connect throws synchronously');
      assert.equal(getInstanceCalls, 1, 'first connect attempt was made');
      assert.equal(svc.status().connected, false);
      assert.match(String(svc.status().lastError), /simulated/, 'the sync failure was recorded');
    });

    await ta('R2. self-heal: next watcher tick rebuilds the socket — no restart', async () => {
      assert.ok(await waitFor(() => svc.status().connected === true && getInstanceCalls >= 2), 'watcher rebuilt the socket');
      assert.ok(sockets.length >= 1 && sockets[0].connectCalls === 1, 'a socket instance was connected');
      assert.equal(sockets[0].subscribeCalls, 1, 'symbols were subscribed on connect');
    });

    await ta('R3. fresh token rebuilds the socket without a restart', async () => {
      currentToken = 'unit-token-two';
      assert.ok(await waitFor(() => getInstanceCalls >= 3 && svc.status().connected === true), 'new token rebuilt and reconnected');
      assert.ok(sockets.length >= 2, 'a second socket instance was created for the new token');
      assert.ok(sockets[0].closed >= 1, 'the previous socket was closed before the rebuild');
    });

    await ta('R4. no rebuild churn while the token is unchanged and connected', async () => {
      const before = getInstanceCalls;
      await sleep(200);
      assert.equal(getInstanceCalls, before, 'watcher must not rebuild on unchanged tokens');
      assert.equal(svc.status().connected, true);
    });

    await ta('R5. destroy clears the timers', async () => {
      svc.onModuleDestroy();
      assert.equal(svc.fyersRetryTimer, null);
      assert.equal(svc.canonicalSummaryTimer, null);
    });
  } finally {
    Module._load = originalLoad;
    for (const k of envKeys) {
      if (envBackup[k] === undefined) delete process.env[k];
      else process.env[k] = envBackup[k];
    }
  }

  console.log(`\n${pass + fail} tests: ${pass} passed, ${fail} failed\n`);
  if (fail > 0) process.exit(1);
})().catch((err) => {
  console.error('test harness crashed:', err);
  process.exit(1);
});
