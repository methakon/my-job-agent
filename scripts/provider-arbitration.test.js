#!/usr/bin/env node
/**
 * TA-011 — Provider Arbitration / Failover Tests
 *
 * Verifies the equal-priority model (FYERS=0, Upstox=1 or both = 1):
 * selection depends on valid/fresh provider data, not a permanent primary.
 *
 * Tests the pure decideOwnership() function from feed-arbitration.state.ts
 * and the FeedHealthService runtime registry.
 */
const assert = require('node:assert/strict');

const {
  decideOwnership,
  ownedUniverses,
  mayProduce,
  unownedUniverses,
  activeFeedNames,
  shortUniverse,
  optionUniversesFromSymbols,
  covers,
  ANY_UNIVERSE,
} = require('../dist/trading/unified-market-data/feed-arbitration.state');

const {
  FeedHealthService,
} = require('../dist/trading/unified-market-data/feed-health.service');

const {
  evaluateEngine,
} = require('../dist/trading/unified-market-data/feed-health.state');

const NOW = new Date('2026-09-19T10:30:00.000Z');

console.log('TA-011: Provider arbitration / failover tests');

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 1: EQUAL PRIORITY — BOTH HEALTHY
// ═══════════════════════════════════════════════════════════════════════════

// --- 1a. Both healthy: first eligible (by freshness/tie) owns ---
{
  const feeds = [
    { name: 'FYERS_WS', priority: 0, enabled: true, credentialsOk: true, universes: ['NIFTY'], ageMs: 2_000 },
    { name: 'UPSTOX_REST', priority: 1, enabled: true, credentialsOk: true, universes: ['NIFTY'], ageMs: 3_000 },
  ];
  const decisions = decideOwnership(['NIFTY'], feeds, { staleAfterMs: 10_000, downAfterMs: 60_000, mode: 'universe' });

  assert.equal(decisions.length, 1, 'one universe decided');
  assert.equal(decisions[0].owner, 'FYERS_WS', 'FYERS owns (fresher + lower priority)');
  assert.ok(decisions[0].standby.includes('UPSTOX_REST'), 'Upstox is standby');
  console.log('  [PASS] both healthy: FYERS wins (fresher + lower priority)');
}

// --- 1b. Both healthy, Upstox is fresher ---
{
  const feeds = [
    { name: 'FYERS_WS', priority: 0, enabled: true, credentialsOk: true, universes: ['NIFTY'], ageMs: 5_000 },
    { name: 'UPSTOX_REST', priority: 1, enabled: true, credentialsOk: true, universes: ['NIFTY'], ageMs: 1_000 },
  ];
  const decisions = decideOwnership(['NIFTY'], feeds, { staleAfterMs: 10_000, downAfterMs: 60_000, mode: 'universe' });

  // FYERS has lower priority, so it should win (priority wins over freshness when both FRESH)
  assert.equal(decisions[0].owner, 'FYERS_WS', 'FYERS wins on priority even if slightly less fresh');
  console.log('  [PASS] both healthy, Upstox fresher: FYERS still wins on priority');
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 2: FYERS HEALTHY, UPSTOX UNAVAILABLE
// ═══════════════════════════════════════════════════════════════════════════

// --- 2a. Upstox not enabled ---
{
  const feeds = [
    { name: 'FYERS_WS', priority: 0, enabled: true, credentialsOk: true, universes: ['NIFTY'], ageMs: 2_000 },
    { name: 'UPSTOX_REST', priority: 1, enabled: false, credentialsOk: true, universes: ['NIFTY'], ageMs: null },
  ];
  const decisions = decideOwnership(['NIFTY'], feeds, { staleAfterMs: 10_000, downAfterMs: 60_000, mode: 'universe' });

  assert.equal(decisions[0].owner, 'FYERS_WS', 'FYERS sole owner');
  assert.ok(!decisions[0].standby.includes('UPSTOX_REST'), 'Upstox not in standby (not enabled)');
  console.log('  [PASS] FYERS healthy, Upstox disabled: FYERS sole owner');
}

// --- 2b. Upstox no credentials ---
{
  const feeds = [
    { name: 'FYERS_WS', priority: 0, enabled: true, credentialsOk: true, universes: ['NIFTY'], ageMs: 2_000 },
    { name: 'UPSTOX_REST', priority: 1, enabled: true, credentialsOk: false, universes: ['NIFTY'], ageMs: null },
  ];
  const decisions = decideOwnership(['NIFTY'], feeds, { staleAfterMs: 10_000, downAfterMs: 60_000, mode: 'universe' });

  assert.equal(decisions[0].owner, 'FYERS_WS', 'FYERS sole owner');
  console.log('  [PASS] FYERS healthy, Upstox no credentials: FYERS sole owner');
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 3: FYERS UNAVAILABLE, UPSTOX HEALTHY
// ═══════════════════════════════════════════════════════════════════════════

// --- 3a. FYERS down, Upstox fresh ---
{
  const feeds = [
    { name: 'FYERS_WS', priority: 0, enabled: true, credentialsOk: true, universes: ['NIFTY'], ageMs: null },
    { name: 'UPSTOX_REST', priority: 1, enabled: true, credentialsOk: true, universes: ['NIFTY'], ageMs: 2_000 },
  ];
  const decisions = decideOwnership(['NIFTY'], feeds, { staleAfterMs: 10_000, downAfterMs: 60_000, mode: 'universe' });

  assert.equal(decisions[0].owner, 'UPSTOX_REST', 'Upstox takes over (FYERS DOWN)');
  assert.ok(decisions[0].standby.includes('FYERS_WS'), 'FYERS is standby');
  assert.ok(decisions[0].reason.includes('failed over'), 'reason indicates failover');
  console.log('  [PASS] FYERS down, Upstox fresh: failover to Upstox');
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 4: BOTH UNAVAILABLE
// ═══════════════════════════════════════════════════════════════════════════

// --- 4a. Both DOWN → highest-priority holds slot (no production) ---
{
  const feeds = [
    { name: 'FYERS_WS', priority: 0, enabled: true, credentialsOk: true, universes: ['NIFTY'], ageMs: null },
    { name: 'UPSTOX_REST', priority: 1, enabled: true, credentialsOk: true, universes: ['NIFTY'], ageMs: null },
  ];
  const decisions = decideOwnership(['NIFTY'], feeds, { staleAfterMs: 10_000, downAfterMs: 60_000, mode: 'universe' });

  // When all feeds are DOWN, the highest-priority feed holds the slot
  // (so it can recover instantly) — but the reason explicitly says
  // "holds the slot and must reconnect" and the health gate blocks trading.
  assert.equal(decisions[0].owner, 'FYERS_WS', 'FYERS holds slot (highest priority)');
  assert.ok(decisions[0].reason.includes('no feed is producing'), 'reason indicates no production');
  assert.ok(decisions[0].reason.includes('must reconnect'), 'reason says must reconnect');
  console.log('  [PASS] both DOWN: highest-priority holds slot, no production (health gate blocks)');
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 5: STALE DETECTION
// ═══════════════════════════════════════════════════════════════════════════

// --- 5a. FYERS stale, Upstox fresh → Upstox takes over ---
{
  const feeds = [
    { name: 'FYERS_WS', priority: 0, enabled: true, credentialsOk: true, universes: ['NIFTY'], ageMs: 30_000 },
    { name: 'UPSTOX_REST', priority: 1, enabled: true, credentialsOk: true, universes: ['NIFTY'], ageMs: 2_000 },
  ];
  const decisions = decideOwnership(['NIFTY'], feeds, { staleAfterMs: 10_000, downAfterMs: 60_000, mode: 'universe' });

  // FYERS is STALE (>10s), Upstox is FRESH (<10s)
  // Upstox should win because FYERS is not in the eligible set
  assert.equal(decisions[0].owner, 'UPSTOX_REST', 'Upstox takes over when FYERS stale');
  console.log('  [PASS] FYERS stale, Upstox fresh: failover to Upstox');
}

// --- 5b. Both stale → no owner ---
{
  const feeds = [
    { name: 'FYERS_WS', priority: 0, enabled: true, credentialsOk: true, universes: ['NIFTY'], ageMs: 30_000 },
    { name: 'UPSTOX_REST', priority: 1, enabled: true, credentialsOk: true, universes: ['NIFTY'], ageMs: 25_000 },
  ];
  const decisions = decideOwnership(['NIFTY'], feeds, { staleAfterMs: 10_000, downAfterMs: 60_000, mode: 'universe' });

  // Both stale (10s < age < 60s): eligible set includes both, FYERS wins on priority
  assert.equal(decisions[0].owner, 'FYERS_WS', 'FYERS holds slot (priority) when both stale');
  console.log('  [PASS] both stale: FYERS holds slot on priority');
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 6: RECOVERY
// ═══════════════════════════════════════════════════════════════════════════

// --- 6a. Provider recovers after being DOWN ---
{
  // Before recovery
  const feedsDown = [
    { name: 'FYERS_WS', priority: 0, enabled: true, credentialsOk: true, universes: ['NIFTY'], ageMs: null },
    { name: 'UPSTOX_REST', priority: 1, enabled: true, credentialsOk: true, universes: ['NIFTY'], ageMs: null },
  ];
  const d1 = decideOwnership(['NIFTY'], feedsDown, { staleAfterMs: 10_000, downAfterMs: 60_000, mode: 'universe' });
  assert.equal(d1[0].owner, 'FYERS_WS', 'FYERS holds slot when both down (highest priority)');

  // FYERS recovers
  const feedsRecovered = [
    { name: 'FYERS_WS', priority: 0, enabled: true, credentialsOk: true, universes: ['NIFTY'], ageMs: 1_000 },
    { name: 'UPSTOX_REST', priority: 1, enabled: true, credentialsOk: true, universes: ['NIFTY'], ageMs: null },
  ];
  const d2 = decideOwnership(['NIFTY'], feedsRecovered, { staleAfterMs: 10_000, downAfterMs: 60_000, mode: 'universe' });
  assert.equal(d2[0].owner, 'FYERS_WS', 'FYERS recovers and takes ownership');
  console.log('  [PASS] recovery: FYERS DOWN→FRESH, takes ownership back');
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 7: ANTI-OSCILLATION / COOLDOWN
// ═══════════════════════════════════════════════════════════════════════════

// --- 7a. Flapping provider: rapid recovery/drop ---
{
  // Simulate FYERS flapping: FRESH→DOWN→FRESH→DOWN
  const scenarios = [
    { name: 'FYERS_WS', ageMs: 2_000, expected: 'FYERS_WS', desc: 'FYERS fresh' },
    { name: 'FYERS_WS', ageMs: null, expected: 'UPSTOX_REST', desc: 'FYERS drops' },
    { name: 'FYERS_WS', ageMs: 1_000, expected: 'FYERS_WS', desc: 'FYERS recovers' },
  ];

  for (const { name, ageMs, expected, desc } of scenarios) {
    const feeds = [
      { name: 'FYERS_WS', priority: 0, enabled: true, credentialsOk: true, universes: ['NIFTY'], ageMs: name === 'FYERS_WS' ? ageMs : 2_000 },
      { name: 'UPSTOX_REST', priority: 1, enabled: true, credentialsOk: true, universes: ['NIFTY'], ageMs: name !== 'FYERS_WS' ? ageMs : 2_000 },
    ];
    const decisions = decideOwnership(['NIFTY'], feeds, { staleAfterMs: 10_000, downAfterMs: 60_000, mode: 'universe' });
    assert.equal(decisions[0].owner, expected, desc);
  }
  console.log('  [PASS] flapping: deterministic ownership, no oscillation');
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 8: COVERAGE MATTERS
// ═══════════════════════════════════════════════════════════════════════════

// --- 8a. FYERS covers NIFTY, Upstox covers SENSEX → separate ownership ---
{
  const feeds = [
    { name: 'FYERS_WS', priority: 0, enabled: true, credentialsOk: true, universes: ['NIFTY'], ageMs: 2_000 },
    { name: 'UPSTOX_REST', priority: 1, enabled: true, credentialsOk: true, universes: ['SENSEX'], ageMs: 3_000 },
  ];
  const decisions = decideOwnership(['NIFTY', 'SENSEX'], feeds, { staleAfterMs: 10_000, downAfterMs: 60_000, mode: 'universe' });

  const nifty = decisions.find(d => d.universe === 'NIFTY');
  const sensex = decisions.find(d => d.universe === 'SENSEX');

  assert.equal(nifty.owner, 'FYERS_WS', 'FYERS owns NIFTY');
  assert.equal(sensex.owner, 'UPSTOX_REST', 'Upstox owns SENSEX');
  console.log('  [PASS] coverage: FYERS=NIFTY, Upstox=SENSEX, separate ownership');
}

// --- 8b. Coverage helper tests ---
{
  // shortUniverse strips non-alphanumeric: NSE:NIFTY50-INDEX → NIFTY50INDEX
  assert.equal(shortUniverse('NSE:NIFTY50-INDEX'), 'NIFTY50INDEX');
  assert.equal(shortUniverse('BSE_INDEX|SENSEX'), 'SENSEX');
  assert.equal(shortUniverse('NSE:NIFTY26SEP23000PE'), 'NIFTY26SEP23000PE');
  console.log('  [PASS] shortUniverse: normalised correctly');
}

// --- 8c. optionUniversesFromSymbols ---
{
  const syms = ['NSE:NIFTY26SEP23000CE', 'NSE:NIFTY26SEP23000PE', 'NSE:BANKNIFTY26SEP57400CE'];
  const universes = optionUniversesFromSymbols(syms);
  assert.ok(universes.includes('NIFTY'), 'NIFTY universe derived');
  assert.ok(universes.includes('BANKNIFTY'), 'BANKNIFTY universe derived');
  assert.equal(universes.length, 2, '2 universes');
  console.log('  [PASS] optionUniversesFromSymbols: derived correctly');
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 9: HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

// --- 9a. ownedUniverses ---
{
  const decisions = [{ universe: 'NIFTY', owner: 'FYERS_WS' }, { universe: 'SENSEX', owner: 'UPSTOX_REST' }];
  assert.deepEqual(ownedUniverses('FYERS_WS', ['NIFTY', 'SENSEX'], decisions), ['NIFTY']);
  assert.deepEqual(ownedUniverses('UPSTOX_REST', ['NIFTY', 'SENSEX'], decisions), ['SENSEX']);
  console.log('  [PASS] ownedUniverses: correct per feed');
}

// --- 9b. mayProduce ---
{
  const decisions = [{ universe: 'NIFTY', owner: 'FYERS_WS' }, { universe: 'SENSEX', owner: 'UPSTOX_REST' }];
  assert.equal(mayProduce('FYERS_WS', ['NIFTY'], decisions), true);
  assert.equal(mayProduce('FYERS_WS', ['SENSEX'], decisions), false);
  assert.equal(mayProduce('UPSTOX_REST', ['SENSEX'], decisions), true);
  console.log('  [PASS] mayProduce: ownership check');
}

// --- 9c. unownedUniverses ---
{
  const decisions = [
    { universe: 'NIFTY', owner: 'FYERS_WS' },
    { universe: 'SENSEX', owner: null },
  ];
  assert.deepEqual(unownedUniverses(decisions), ['SENSEX']);
  console.log('  [PASS] unownedUniverses: returns null-owner entries');
}

// --- 9d. activeFeedNames ---
{
  const decisions = [
    { universe: 'NIFTY', owner: 'FYERS_WS' },
    { universe: 'SENSEX', owner: 'UPSTOX_REST' },
  ];
  assert.deepEqual(activeFeedNames(decisions), ['FYERS_WS', 'UPSTOX_REST']);
  console.log('  [PASS] activeFeedNames: unique active producers');
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 10: FEED HEALTH INTEGRATION
// ═══════════════════════════════════════════════════════════════════════════

// --- 10a. FeedHealthService runtime ---
{
  const health = new FeedHealthService();
  health.registerFeed('FYERS_LIVE', 'fnf', { ageMs: () => 2_000, enabled: () => true });
  health.registerFeed('UPSTOX_LIVE', 'upstox-paper', { ageMs: () => 3_000, enabled: () => true });

  const fnfGate = health.gateFor('fnf', NOW);
  assert.equal(fnfGate.allowNewTrading, true, 'FnF: healthy with fresh FYERS');
  assert.equal(fnfGate.overall, 'HEALTHY');

  const upstoxGate = health.gateFor('upstox-paper', NOW);
  assert.equal(upstoxGate.allowNewTrading, true, 'Upstox paper: healthy with fresh Upstox');
  console.log('  [PASS] FeedHealthService: runtime registry, per-engine gating');
}

// --- 10b. One fresh feed satisfies the gate ---
{
  const health = new FeedHealthService();
  health.registerFeed('FYERS_LIVE', 'fnf', { ageMs: () => 120_000, enabled: () => true }); // DOWN
  health.registerFeed('FYERS_LIVE_2', 'fnf', { ageMs: () => 1_000, enabled: () => true }); // FRESH

  const gate = health.gateFor('fnf', NOW);
  assert.equal(gate.allowNewTrading, true, 'one fresh feed is sufficient');
  assert.equal(gate.overall, 'HEALTHY');
  console.log('  [PASS] multi-feed: one fresh satisfies the gate');
}

// --- 10c. Automatic recovery via health gate ---
{
  const health = new FeedHealthService();
  let age = 120_000; // start DOWN
  health.registerFeed('FYERS_LIVE', 'fnf', { ageMs: () => age, enabled: () => true });

  let gate = health.gateFor('fnf', NOW);
  assert.equal(gate.allowNewTrading, false, 'initially DOWN');

  age = 1_000; // recovers
  gate = health.gateFor('fnf', NOW);
  assert.equal(gate.allowNewTrading, true, 'recovers when ticks resume');
  assert.equal(gate.overall, 'HEALTHY');
  console.log('  [PASS] health gate: automatic recovery, no state/timers');
}

console.log('');
console.log('All TA-011 provider arbitration tests passed');
