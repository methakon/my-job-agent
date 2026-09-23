#!/usr/bin/env node
/**
 * Token supervisor — deterministic unit tests (no DB, no network).
 *
 * Covers:
 *  - FYERS state transitions: VALID / EXPIRING / REFRESHING / AUTH_REQUIRED / INVALID
 *  - FYERS refresh automation: success, failure, bounded retries (no storm),
 *    suppression reset when the stored token changes
 *  - missing PIN => AUTH_REQUIRED with ZERO refresh attempts (regression)
 *  - Upstox: VALID / EXPIRING / AUTH_REQUIRED, AWAITING_APPROVAL persistence
 *    across a process restart, duplicate-request prevention
 *  - initiation gate OFF by default (P3 stopped until the notifier URL is confirmed)
 *  - redacted logging (no token material ever appears in log lines)
 *  - timer lifecycle (bootstrap tick executes; destroy clears the timer)
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

let pass = 0;
let fail = 0;
const ok = (name) => { pass++; console.log(`  ✅ ${name}`); };
const bad = (name, err) => { fail++; console.log(`  ❌ ${name}\n     ${err && err.message ? err.message : err}`); };
const ta = async (name, fn) => { try { await fn(); ok(name); } catch (err) { bad(name, err); } };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, timeoutMs = 2000, stepMs = 15) => {
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
const DIST_AGENT = path.join(ROOT, 'dist', 'trading-agent');
if (!fs.existsSync(path.join(DIST_AGENT, 'token-supervisor.service.js'))) {
  console.error('✘ dist/trading-agent/token-supervisor.service.js missing — cannot run tests');
  process.exit(1);
}
const { TokenSupervisorService } = require(path.join(DIST_AGENT, 'token-supervisor.service.js'));

// ── fixtures / stubs ─────────────────────────────────────────────────────────
const HOUR = 3600_000;
const MIN = 60_000;
const T0 = new Date('2026-09-23T06:30:00+05:30');

process.env.UPSTOX_LIVE_API_KEY = process.env.UPSTOX_LIVE_API_KEY || 'TEST-UPSTOX-CLIENT-ID';

const makeTokens = (opts = {}) => {
  const stub = {
    calls: { refresh: 0 },
    async getRefreshStatus() { return opts.refresh ?? { hasRefreshToken: true, hasPin: true }; },
    async getActiveTokenInfo(provider) { return (opts.info ?? {})[provider] ?? null; },
    async getCurrentToken(provider) { return (opts.rows ?? {})[provider] ?? null; },
    async refreshAccessToken() {
      stub.calls.refresh += 1;
      if (opts.onRefresh) opts.onRefresh();
      // `stub.refreshOk` lets a test flip the outcome mid-scenario.
      return stub.refreshOk ?? opts.refreshOk ?? true;
    },
  };
  return stub;
};

const makeMarkerRepo = (rows = []) => ({
  rows,
  create(obj) { return { ...obj, id: `marker-${rows.length + 1}`, createdAt: new Date() }; },
  async save(entity) { rows.unshift(entity); return entity; },
  async find({ where, order } = {}) {
    let result = rows.slice();
    if (where?.broker) result = result.filter((r) => r.broker === where.broker);
    if (where?.status) result = result.filter((r) => r.status === where.status);
    if (order?.createdAt === 'DESC') result = result.reverse();
    return result;
  },
});

const captureLogs = (svc) => {
  const lines = [];
  svc.logger = {
    log: (m) => lines.push(String(m)),
    warn: (m) => lines.push(String(m)),
    error: (m) => lines.push(String(m)),
  };
  return lines;
};

const spyClass = () =>
  class SpySupervisor extends TokenSupervisorService {
    constructor(tokens, markerRepo) {
      super(tokens, markerRepo);
      this.initiations = 0;
    }
    upstoxInitiationEnabled() { return true; }
    async initiateUpstoxTokenRequest(now) {
      this.initiations += 1;
      await this.markUpstoxRequestPending(now, new Date(now.getTime() + 5 * HOUR));
    }
  };

// ── tests ────────────────────────────────────────────────────────────────────
(async () => {
  console.log('\n▶ Token supervisor — deterministic states & actions\n');

  // S1. FYERS VALID
  await ta('S1. FYERS: fresh token is VALID; no refresh attempted; report shape ok', async () => {
    const tokens = makeTokens({ info: { fyers: { active: true, expiresAt: new Date(T0.getTime() + 20 * HOUR), refreshAvailable: true } } });
    const svc = new TokenSupervisorService(tokens, makeMarkerRepo());
    const report = await svc.tick(T0);
    assert.equal(report.fyers.state, 'VALID');
    assert.equal(tokens.calls.refresh, 0, 'no refresh for a fresh token');
    assert.ok(!Number.isNaN(new Date(report.checkedAt).getTime()), 'checkedAt is an ISO timestamp');
    assert.equal(report.upstox.provider, 'upstox');
  });

  // S2. FYERS EXPIRING, no refresh token stored
  await ta('S2. FYERS: expiring token without a stored refresh token stays EXPIRING, no calls', async () => {
    const tokens = makeTokens({
      info: { fyers: { active: true, expiresAt: new Date(T0.getTime() + 10 * MIN), refreshAvailable: false } },
      refresh: { hasRefreshToken: false, hasPin: true },
    });
    const svc = new TokenSupervisorService(tokens, makeMarkerRepo());
    const report = await svc.tick(T0);
    assert.equal(report.fyers.state, 'EXPIRING');
    assert.equal(tokens.calls.refresh, 0);
  });

  // S3. FYERS EXPIRING, no PIN
  await ta('S3. FYERS: expiring token without PIN stays EXPIRING, no calls', async () => {
    const tokens = makeTokens({
      info: { fyers: { active: true, expiresAt: new Date(T0.getTime() + 10 * MIN), refreshAvailable: true } },
      refresh: { hasRefreshToken: true, hasPin: false },
    });
    const svc = new TokenSupervisorService(tokens, makeMarkerRepo());
    const report = await svc.tick(T0);
    assert.equal(report.fyers.state, 'EXPIRING');
    assert.equal(tokens.calls.refresh, 0);
  });

  // S4. Missing PIN => AUTH_REQUIRED, never retried (no retry storm)
  await ta('S4. FYERS: missing PIN => AUTH_REQUIRED with ZERO attempts across repeated ticks', async () => {
    const tokens = makeTokens({
      info: { fyers: { active: true, expiresAt: new Date(T0.getTime() - 5 * MIN), refreshAvailable: true } },
      refresh: { hasRefreshToken: true, hasPin: false },
    });
    const svc = new TokenSupervisorService(tokens, makeMarkerRepo());
    const r1 = await svc.tick(T0);
    const r2 = await svc.tick(new Date(T0.getTime() + 30 * MIN));
    const r3 = await svc.tick(new Date(T0.getTime() + 60 * MIN));
    assert.equal(r1.fyers.state, 'AUTH_REQUIRED');
    assert.equal(r2.fyers.state, 'AUTH_REQUIRED');
    assert.equal(r3.fyers.state, 'AUTH_REQUIRED');
    assert.equal(tokens.calls.refresh, 0, 'PIN missing must never trigger a refresh attempt');
  });

  // S5. Refresh success + no duplicate on immediate re-tick
  await ta('S5. FYERS: refresh success rotates to VALID; immediate re-tick performs no duplicate refresh', async () => {
    const info = { fyers: { active: true, expiresAt: new Date(T0.getTime() - 5 * MIN), refreshAvailable: true } };
    const tokens = makeTokens({
      info,
      rows: { fyers: { id: 'r1', accessTokenEncrypted: 'enc:one' } },
      refreshOk: true,
      onRefresh: () => { info.fyers.expiresAt = new Date(T0.getTime() + 25 * HOUR); },
    });
    const svc = new TokenSupervisorService(tokens, makeMarkerRepo());
    const r1 = await svc.tick(T0);
    assert.equal(r1.fyers.state, 'VALID');
    assert.equal(tokens.calls.refresh, 1);
    const r2 = await svc.tick(new Date(T0.getTime() + 1 * MIN));
    assert.equal(r2.fyers.state, 'VALID');
    assert.equal(tokens.calls.refresh, 1, 'no duplicate refresh inside the cooldown window');
  });

  // S6. Bounded retries on failure (no storm), then suppression
  await ta('S6. FYERS: failed refreshes are bounded (2 attempts max per token content)', async () => {
    const tokens = makeTokens({
      info: { fyers: { active: true, expiresAt: new Date(T0.getTime() - 5 * MIN), refreshAvailable: true } },
      rows: { fyers: { id: 'r1', accessTokenEncrypted: 'enc:one' } },
      refreshOk: false,
    });
    const svc = new TokenSupervisorService(tokens, makeMarkerRepo());
    const r1 = await svc.tick(T0);
    assert.equal(r1.fyers.state, 'REFRESHING');
    assert.equal(tokens.calls.refresh, 1);
    const r2 = await svc.tick(new Date(T0.getTime() + 16 * MIN));
    assert.equal(r2.fyers.state, 'REFRESHING');
    assert.equal(tokens.calls.refresh, 2);
    const r3 = await svc.tick(new Date(T0.getTime() + 45 * MIN));
    assert.equal(r3.fyers.state, 'AUTH_REQUIRED', 'after repeated failures the supervisor stops retrying');
    const r4 = await svc.tick(new Date(T0.getTime() + 90 * MIN));
    assert.equal(r4.fyers.state, 'AUTH_REQUIRED');
    assert.equal(tokens.calls.refresh, 2, 'attempts are bounded — no retry storm');
  });

  // S7. Suppression is lifted when the stored token content changes
  await ta('S7. FYERS: new stored token content resets failure suppression and is refreshed', async () => {
    const rows = { fyers: { id: 'r1', accessTokenEncrypted: 'enc:one' } };
    const tokens = makeTokens({
      info: { fyers: { active: true, expiresAt: new Date(T0.getTime() - 5 * MIN), refreshAvailable: true } },
      rows,
      refreshOk: false,
    });
    const svc = new TokenSupervisorService(tokens, makeMarkerRepo());
    await svc.tick(T0);
    await svc.tick(new Date(T0.getTime() + 16 * MIN));
    await svc.tick(new Date(T0.getTime() + 45 * MIN)); // suppressed
    assert.equal(tokens.calls.refresh, 2);

    rows.fyers = { id: 'r2', accessTokenEncrypted: 'enc:two' }; // fresh login landed
    tokens.refreshOk = true;
    const r = await svc.tick(new Date(T0.getTime() + 100 * MIN));
    assert.equal(r.fyers.state, 'VALID');
    assert.equal(tokens.calls.refresh, 3, 'the new token content lifted the suppression and was refreshed');
  });

  // S8. FYERS INVALID
  await ta('S8. FYERS: active row with no derivable expiry is INVALID', async () => {
    const tokens = makeTokens({ info: { fyers: { active: true, expiresAt: null, refreshAvailable: true } } });
    const svc = new TokenSupervisorService(tokens, makeMarkerRepo());
    const r = await svc.tick(T0);
    assert.equal(r.fyers.state, 'INVALID');
    assert.equal(tokens.calls.refresh, 0);
  });

  // S9. FYERS AUTH_REQUIRED (no row)
  await ta('S9. FYERS: no token row is AUTH_REQUIRED', async () => {
    const tokens = makeTokens({ info: {} });
    const svc = new TokenSupervisorService(tokens, makeMarkerRepo());
    const r = await svc.tick(T0);
    assert.equal(r.fyers.state, 'AUTH_REQUIRED');
    assert.equal(tokens.calls.refresh, 0);
  });

  // S10. Upstox basic states
  await ta('S10. Upstox: VALID / EXPIRING / AUTH_REQUIRED transitions', async () => {
    const valid = makeTokens({ info: { upstox: { active: true, expiresAt: new Date(T0.getTime() + 6 * HOUR), refreshAvailable: false } } });
    const svcValid = new TokenSupervisorService(valid, makeMarkerRepo());
    assert.equal((await svcValid.tick(T0)).upstox.state, 'VALID');

    const exp = makeTokens({ info: { upstox: { active: true, expiresAt: new Date(T0.getTime() + 10 * MIN), refreshAvailable: false } } });
    const svcExp = new TokenSupervisorService(exp, makeMarkerRepo());
    assert.equal((await svcExp.tick(T0)).upstox.state, 'EXPIRING');

    const none = makeTokens({ info: {} });
    const markers = makeMarkerRepo();
    const svcNone = new TokenSupervisorService(none, markers);
    assert.equal((await svcNone.tick(T0)).upstox.state, 'AUTH_REQUIRED');
    assert.equal(markers.rows.length, 0, 'gate OFF must not write any marker');
  });

  // S11. AWAITING_APPROVAL persistence across restart + duplicate prevention
  await ta('S11. Upstox: request initiated once; AWAITING_APPROVAL survives restart; no duplicates', async () => {
    const Spy = spyClass();
    const markers = makeMarkerRepo();
    const tokens1 = makeTokens({ info: {} });
    const spy1 = new Spy(tokens1, markers);
    const r1 = await spy1.tick(T0);
    assert.equal(r1.upstox.state, 'AWAITING_APPROVAL', 'initiated request reports AWAITING_APPROVAL');
    assert.equal(spy1.initiations, 1, 'exactly one initiation');
    assert.equal(markers.rows.length, 1, 'durable marker row written');
    assert.equal(markers.rows[0].status, 'AWAITING_APPROVAL');
    assert.equal(markers.rows[0].accessTokenEncrypted, null, 'marker carries no token material');

    const r2 = await spy1.tick(new Date(T0.getTime() + 1 * MIN));
    assert.equal(r2.upstox.state, 'AWAITING_APPROVAL');
    assert.equal(spy1.initiations, 1, 'no duplicate request while one is pending');

    // Simulated process restart: a FRESH instance on the SAME durable store.
    const tokens2 = makeTokens({ info: {} });
    const spy2 = new Spy(tokens2, markers);
    const r3 = await spy2.tick(new Date(T0.getTime() + 2 * MIN));
    assert.equal(r3.upstox.state, 'AWAITING_APPROVAL', 'AWAITING_APPROVAL survived the restart');
    assert.equal(spy2.initiations, 0, 'restart must not re-issue a pending request');
    assert.equal(markers.rows.length, 1);
  });

  // S12. Gate OFF (default) can never initiate
  await ta('S12. Upstox: default gate OFF — no initiation, no marker, no throw', async () => {
    const tokens = makeTokens({ info: {} });
    const markers = makeMarkerRepo();
    const svc = new TokenSupervisorService(tokens, markers); // base class: initiate would throw if reached
    const r = await svc.tick(T0);
    assert.equal(r.upstox.state, 'AUTH_REQUIRED');
    assert.equal(markers.rows.length, 0);
  });

  // S13. Redacted logging
  await ta('S13. No token material ever appears in supervisor log lines', async () => {
    const SECRET_FYERS = 'SECRET-FYERS-ACCESS-AAA';
    const SECRET_UPSTOX = 'SECRET-UPSTOX-TOKEN-BBB';
    const tokens = makeTokens({
      info: {
        fyers: { active: true, expiresAt: new Date(T0.getTime() - 5 * MIN), refreshAvailable: true },
        upstox: { active: true, expiresAt: new Date(T0.getTime() - 5 * MIN), refreshAvailable: false },
      },
      rows: { fyers: { id: 'r1', accessTokenEncrypted: `enc:${SECRET_FYERS}` } },
      refreshOk: false,
    });
    const svc = new TokenSupervisorService(tokens, makeMarkerRepo());
    const lines = captureLogs(svc);
    await svc.tick(T0);
    await svc.tick(new Date(T0.getTime() + 30 * MIN));
    assert.ok(lines.length > 0, 'state changes are logged');
    const joined = lines.join('\n');
    assert.ok(!joined.includes(SECRET_FYERS), 'FYERS token material must never be logged');
    assert.ok(!joined.includes(SECRET_UPSTOX), 'Upstox token material must never be logged');
    assert.ok(joined.includes('[TOKEN-SUPERVISOR]'), 'log lines are tagged');
  });

  // S14. Timer lifecycle
  await ta('S14. Timer lifecycle: bootstrap check runs on init; destroy clears the timer', async () => {
    const tokens = makeTokens({ info: { fyers: { active: true, expiresAt: new Date(Date.now() + 20 * HOUR), refreshAvailable: true } } });
    const svc = new TokenSupervisorService(tokens, makeMarkerRepo());
    const lines = captureLogs(svc);
    await svc.onModuleInit();
    assert.ok(svc.timer, 'periodic timer armed');
    assert.ok(await waitFor(() => lines.length > 0), 'bootstrap tick executed (state logged)');
    svc.onModuleDestroy();
    assert.equal(svc.timer, null, 'timer cleared on destroy');
  });

  // ── summary ──────────────────────────────────────────────────────────────
  console.log(`\n${pass + fail} tests: ${pass} passed, ${fail} failed\n`);
  if (fail > 0) process.exit(1);
})();
