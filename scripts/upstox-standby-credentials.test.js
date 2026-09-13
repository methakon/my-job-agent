#!/usr/bin/env node
/**
 * Upstox REST producer — credential measurement while STANDBY.
 *
 * Acceptance criteria being proven:
 *  1. A STANDBY feed still measures its credentials, so the arbiter's
 *     credentialsOk gate can actually be satisfied (the deadlock: a feed that
 *     only measures credentials while ACTIVE can never become ACTIVE).
 *  2. Credential measurement performs NO broker call and NO OAuth refresh.
 *  3. Standing by performs NO broker poll (no wasted API budget).
 *  4. With a valid token the arbiter then awards the feed its UNCONTESTED
 *     universe, and the feed becomes ACTIVE and polls its own universe.
 *  5. With a missing/expired token credentials stay false and the failure is
 *     reported as AUTH_REQUIRED — never a fabricated "credentialed".
 *  6. A credentialed, FRESH standby becomes the eligible failover owner when the
 *     preferred provider is DOWN (and loses it again when it recovers).
 *
 * Offline: fake repositories + fake token service, no DB, no network.
 * DIST_ROOT selects the compiled output (default ../dist).
 */
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DIST = process.env.DIST_ROOT || path.join(ROOT, 'dist');

const svcMod = require(path.join(DIST, 'trading/upstox-live-paper/upstox-live-paper-market.service.js'));
const { UpstoxLivePaperMarketService } = svcMod;
const {
  decideOwnership, ownedUniverses, DEFAULT_FEED_STALE_AFTER_MS, DEFAULT_FEED_DOWN_AFTER_MS,
} = require(path.join(DIST, 'trading/unified-market-data/feed-arbitration.state.js'));

const FEED = 'UPSTOX_REST';
const ARB_OPTS = {
  mode: 'universe',
  staleAfterMs: DEFAULT_FEED_STALE_AFTER_MS,
  downAfterMs: DEFAULT_FEED_DOWN_AFTER_MS,
};

let pass = 0;
const ok = (label) => { pass++; console.log(`  ${pass} ${label} ok`); };

/** Fresh service + captured registration, with stubs; `token` controls auth. */
function makeService(opts = {}) {
  const calls = { fetch: [], beats: [], refresh: 0, decisions: 0 };
  let registration = null;

  const config = {
    paperOnly: true,
    safetyLockActive: true,
    liveApiKey: 'api-key',
    liveApiSecret: 'secret',
    liveAccessToken: '',
    liveCredentialsPresent: true,
    liveInstruments: ['BSE_INDEX|SENSEX', 'NSE_INDEX|Nifty 50'],
    liveUniverseMap: { 'NSE_INDEX|Nifty 50': 'NIFTY' },
    livePreferTodayExpiry: true,
    staleQuoteMaxAgeMs: 15_000,
    defaultSlippageBps: 20,
    abnormalSpreadPctThreshold: 15,
  };

  const tokenService = {
    getValidUpstoxAccessToken: async () => {
      if (opts.tokenError) throw new Error(opts.tokenError);
      return { token: 'tok', clientId: 'cid', expiresAt: new Date(Date.now() + 3_600_000) };
    },
    completeAuthorization: async () => { calls.refresh++; throw new Error('OAuth refresh must not run from the poll'); },
  };

  const decisions = opts.decisions ?? [
    { universe: 'NIFTY', owner: 'FYERS_WS', standby: [FEED], ranked: ['FYERS_WS', FEED], reason: 'fresh' },
    { universe: 'SENSEX', owner: null, standby: [], ranked: [], reason: 'no enabled feed covers SENSEX — new trading paused' },
  ];

  const arbitration = {
    register: (r) => { registration = r; },
    priorityFor: (_n, fallback) => fallback,
    decisions: async () => { calls.decisions++; return decisions; },
    beat: async (name, patch) => { calls.beats.push({ name, patch }); },
  };

  const svc = new UpstoxLivePaperMarketService(
    config,
    { createQueryBuilder: () => ({ insert: () => ({ values: () => ({ orIgnore: () => ({ execute: async () => ({}) }) }) }) }) },
    { createQueryBuilder: () => ({ insert: () => ({ values: () => ({ orIgnore: () => ({ execute: async () => ({}) }) }) }) }) },
    { registerFeed: () => {} },
    tokenService,
    arbitration,
    { duplicateCount: () => 0, sharedQuote: async () => null },
    { ingestMessage: async () => ({ persisted: false, accepted: 0, rejected: 0, withheld: 0 }) },
  );
  svc.logger = { log: () => {}, warn: () => {}, error: () => {}, debug: () => {}, verbose: () => {} };

  const originalFetch = global.fetch;
  global.fetch = async (url) => { calls.fetch.push(String(url)); throw new Error('EGRESS_BLOCKED'); };
  return { svc, calls, registration: () => registration, restore: () => { global.fetch = originalFetch; } };
}

/** FeedCandidate built from the service's OWN arbiter registration. */
function candidate(reg, overrides = {}) {
  return {
    name: reg.name,
    priority: reg.priority,
    enabled: reg.enabled(),
    credentialsOk: reg.credentialsOk(),
    universes: reg.universes,
    ageMs: null,
    ...overrides,
  };
}

const FRESH_FYERS = { name: 'FYERS_WS', priority: 0, enabled: true, credentialsOk: true, universes: ['NIFTY', 'BANKNIFTY'], ageMs: 1_000 };

(async () => {
  // ── 1 & 2 & 3: STANDBY measures credentials with no broker call, no refresh
  {
    const t = makeService();
    assert.equal(t.registration().credentialsOk(), false, 'uncredentialed before any cycle');
    const out = await t.svc.fetchOptionChain();
    assert.deepEqual(out, { fetched: 0, errors: [] }, 'standby returns no fetch');
    assert.equal(t.calls.fetch.length, 0, 'standby must not touch the broker');           // 3
    assert.equal(t.calls.refresh, 0, 'standby must not refresh OAuth');                    // 2
    assert.equal(t.registration().credentialsOk(), true, 'standby measured credentials');  // 1
    assert.equal(t.registration().universes.includes('SENSEX'), true, 'registers SENSEX');
    assert.equal(t.svc.status().restLastError, null, 'valid token leaves no error');
    ok('STANDBY measures credentials with zero broker calls and zero OAuth refresh');
    t.restore();
  }

  // ── 4: the deadlock and its resolution, using the real arbiter
  {
    const dead = makeService();
    const locked = candidate(dead.registration(), { ageMs: null });      // never polled ⇒ DOWN
    assert.equal(decideOwnership(['SENSEX'], [FRESH_FYERS, locked], ARB_OPTS)[0].owner, null,
      'uncredentialed feed gets NO universe — even one nobody contests (the deadlock)');
    dead.restore();

    const fixed = makeService();
    await fixed.svc.fetchOptionChain();                                   // measures credentials
    const credited = candidate(fixed.registration(), { ageMs: 1_000 });
    assert.equal(decideOwnership(['SENSEX'], [FRESH_FYERS, credited], ARB_OPTS)[0].owner, FEED,
      'credentialed feed is awarded its uncontested universe');
    ok('uncredentialed ⇒ no universe awarded; credentialed ⇒ awarded + fails over');
    fixed.restore();
  }

  // ── 4b: once the arbiter awards it the universe, the desk polls (ACTIVE)
  {
    const t = makeService({
      decisions: [{ universe: 'SENSEX', owner: FEED, standby: [], ranked: [FEED], reason: 'awarded' }],
    });
    const out = await t.svc.fetchOptionChain();
    const lastBeat = t.calls.beats[t.calls.beats.length - 1];
    assert.equal(lastBeat.patch.state, 'ACTIVE', 'desk leaves STANDBY once awarded a universe');
    assert.equal(lastBeat.patch.universes.includes('SENSEX'), true, 'publishes the universe it now owns');
    assert.equal(t.calls.fetch.length > 0, true, 'ACTIVE path polls its own universe');
    assert.equal(out.fetched, 0, 'no fabricated quotes when the broker call fails');
    assert.equal(out.errors.length > 0, true, 'broker failure reported, not hidden');
    for (const url of t.calls.fetch) {
      assert.match(url, /^https:\/\/api\.upstox\.com\/v2\//, `only market-data host used: ${url}`);
      assert.doesNotMatch(url, /order/i, 'no order endpoint is ever called from the poll');
    }
    assert.equal(t.registration().credentialsOk(), true, 'credentials still measured');
    ok('awarded universe ⇒ desk polls it; failures counted; no order endpoint touched');
    t.restore();
  }

  // ── 5: expired/missing token stays uncredentialed and says AUTH_REQUIRED
  {
    const t = makeService({ tokenError: 'Upstox LIVE access token TOKEN_EXPIRED — AUTH_REQUIRED' });
    const out = await t.svc.fetchOptionChain();
    assert.deepEqual(out, { fetched: 0, errors: [] });
    assert.equal(t.registration().credentialsOk(), false, 'expired token ⇒ NOT credentialed');
    assert.match(String(t.svc.status().restLastError), /AUTH_REQUIRED/, 'reports AUTH_REQUIRED');
    assert.match(String(t.svc.status().restLastError), /\/api\/upstox\/token\/init/, 'tells the operator where to log in');
    assert.equal(t.calls.fetch.length, 0, 'no broker call without credentials');
    assert.equal(decideOwnership(['SENSEX'], [FRESH_FYERS, candidate(t.registration(), { ageMs: 1_000 })], ARB_OPTS)[0].owner, null,
      'unexpired credentials are required — nothing is fabricated');
    ok('expired token ⇒ credentialsOk=false + AUTH_REQUIRED + operator hint');
    t.restore();
  }

  // ── 6: failover / failback eligibility of the credited standby
  {
    const t = makeService();
    await t.svc.fetchOptionChain();
    const upstox = candidate(t.registration(), { ageMs: 2_000 });                 // FRESH on its own universe
    const fyersDown = { ...FRESH_FYERS, ageMs: null };                            // provider outage
    assert.equal(decideOwnership(['NIFTY'], [fyersDown, upstox], ARB_OPTS)[0].owner, FEED,
      'FYERS DOWN ⇒ credentialed FRESH Upstox takes over');
    const fyersBack = { ...FRESH_FYERS, ageMs: 500 };                             // recovered, FRESH
    assert.equal(decideOwnership(['NIFTY'], [fyersBack, upstox], ARB_OPTS)[0].owner, 'FYERS_WS',
      'FYERS FRESH ⇒ priority 0 fails back');
    assert.equal(decideOwnership(['NIFTY'], [fyersBack, upstox], ARB_OPTS).length, 1, 'exactly one owner');
    ok('credentialed standby is the eligible failover owner, and fails back on recovery');
    t.restore();
  }

  console.log(`\nupstox-standby-credentials: ${pass} passed, 0 failed`);
})().catch((err) => {
  console.error(`\nFAILED: ${err.message}`);
  process.exit(1);
});
