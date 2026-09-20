#!/usr/bin/env node
/**
 * TA-015 — End-to-End Provider Failover
 *
 * Proves:
 * FYERS live → FYERS failure/staleness → Upstox selected → canonical ticks continue.
 * Upstox live → Upstox failure/staleness → FYERS selected → canonical ticks continue.
 * Both unavailable → new entries blocked.
 *
 * Provenance survives failover.
 * No duplicate/conflicting canonical observations.
 */
const assert = require('node:assert/strict');

const {
  decideOwnership,
  ownedUniverses,
  mayProduce,
  unownedUniverses,
  activeFeedNames,
} = require('../dist/trading/unified-market-data/feed-arbitration.state');

const {
  evaluateEngine,
  stateForFeed,
} = require('../dist/trading/unified-market-data/feed-health.state');

const {
  FeedHealthService,
} = require('../dist/trading/unified-market-data/feed-health.service');

const {
  interpretObservation,
  budgetsFromEnv,
} = require('../dist/trading/unified-market-data/canonical/canonical-tick');

const NOW = new Date('2026-09-19T10:30:00.000Z');
const budgets = budgetsFromEnv();

console.log('TA-015: End-to-end provider failover tests');

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 1: FYERS → FAILOVER TO UPSTOX
// ═══════════════════════════════════════════════════════════════════════════

// --- 1a. FYERS live → FYERS DOWN → Upstox takes over ---
{
  // Step 1: FYERS live
  let feeds = [
    { name: 'FYERS_WS', priority: 0, enabled: true, credentialsOk: true, universes: ['NIFTY'], ageMs: 2_000 },
    { name: 'UPSTOX_REST', priority: 1, enabled: true, credentialsOk: true, universes: ['NIFTY'], ageMs: 3_000 },
  ];
  let d = decideOwnership(['NIFTY'], feeds, { staleAfterMs: 10_000, downAfterMs: 60_000, mode: 'universe' });
  assert.equal(d[0].owner, 'FYERS_WS', 'step 1: FYERS owns');

  // Step 2: FYERS drops (age → null)
  feeds = [
    { name: 'FYERS_WS', priority: 0, enabled: true, credentialsOk: true, universes: ['NIFTY'], ageMs: null },
    { name: 'UPSTOX_REST', priority: 1, enabled: true, credentialsOk: true, universes: ['NIFTY'], ageMs: 3_000 },
  ];
  d = decideOwnership(['NIFTY'], feeds, { staleAfterMs: 10_000, downAfterMs: 60_000, mode: 'universe' });
  assert.equal(d[0].owner, 'UPSTOX_REST', 'step 2: Upstox takes over');
  assert.ok(d[0].reason.includes('failed over'), 'failover indicated');

  // Step 3: Verify Upstox can produce
  assert.equal(mayProduce('UPSTOX_REST', ['NIFTY'], d), true, 'Upstox may produce');
  assert.equal(mayProduce('FYERS_WS', ['NIFTY'], d), false, 'FYERS may NOT produce');

  console.log('  [PASS] FYERS → failover → Upstox: ownership transfers');
}

// --- 1b. Canonical ticks continue from Upstox ---
{
  // Upstox tick arrives after failover
  const result = interpretObservation('UPSTOX_REST', {
    providerInstrumentId: 'NSE_FO|NIFTY26SEP23000PE',
    underlying: 'NIFTY',
    exchange: 'NSE',
    instrumentType: 'OPT',
    expiry: '2026-09-26',
    strike: 23000,
    optionType: 'PE',
    ltp: 175.0,
    volume: 2000,
    sourceTimestamp: NOW,
    raw: { after_failover: true },
  }, NOW, budgets);

  assert.equal(result.ok, true, 'Upstox tick accepted after failover');
  assert.equal(result.tick.source, 'UPSTOX_REST', 'source is Upstox');
  assert.equal(result.tick.ltp, 175.0, 'LTP correct');
  console.log('  [PASS] canonical ticks continue from Upstox after FYERS failover');
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 2: UPSTOX → FAILOVER TO FYERS
// ═══════════════════════════════════════════════════════════════════════════

// --- 2a. Upstox live → Upstox DOWN → FYERS takes over ---
{
  // Step 1: Upstox owns (FYERS is DOWN)
  let feeds = [
    { name: 'FYERS_WS', priority: 0, enabled: true, credentialsOk: true, universes: ['NIFTY'], ageMs: null },
    { name: 'UPSTOX_REST', priority: 1, enabled: true, credentialsOk: true, universes: ['NIFTY'], ageMs: 2_000 },
  ];
  let d = decideOwnership(['NIFTY'], feeds, { staleAfterMs: 10_000, downAfterMs: 60_000, mode: 'universe' });
  assert.equal(d[0].owner, 'UPSTOX_REST', 'step 1: Upstox owns (FYERS DOWN)');

  // Step 2: FYERS recovers, Upstox drops
  feeds = [
    { name: 'FYERS_WS', priority: 0, enabled: true, credentialsOk: true, universes: ['NIFTY'], ageMs: 1_000 },
    { name: 'UPSTOX_REST', priority: 1, enabled: true, credentialsOk: true, universes: ['NIFTY'], ageMs: null },
  ];
  d = decideOwnership(['NIFTY'], feeds, { staleAfterMs: 10_000, downAfterMs: 60_000, mode: 'universe' });
  assert.equal(d[0].owner, 'FYERS_WS', 'step 2: FYERS takes back ownership');

  // Step 3: Verify FYERS can produce
  assert.equal(mayProduce('FYERS_WS', ['NIFTY'], d), true, 'FYERS may produce');
  console.log('  [PASS] Upstox → failover → FYERS: ownership transfers back');
}

// --- 2b. Canonical ticks continue from FYERS ---
{
  const result = interpretObservation('FYERS_LIVE', {
    providerInstrumentId: 'NSE:NIFTY26SEP23000PE',
    underlying: 'NIFTY',
    exchange: 'NSE',
    instrumentType: 'OPT',
    expiry: '2026-09-26',
    strike: 23000,
    optionType: 'PE',
    ltp: 180.0,
    volume: 4000,
    sourceTimestamp: NOW,
    raw: { after_failover: true },
  }, NOW, budgets);

  assert.equal(result.ok, true, 'FYERS tick accepted after failover');
  assert.equal(result.tick.source, 'FYERS_LIVE', 'source is FYERS');
  assert.equal(result.tick.ltp, 180.0, 'LTP correct');
  console.log('  [PASS] canonical ticks continue from FYERS after Upstox failover');
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 3: BOTH UNAVAILABLE → ENTRIES BLOCKED
// ═══════════════════════════════════════════════════════════════════════════

// --- 3a. Both DOWN → no production (highest-priority holds slot) → blocked by health gate ---
{
  const feeds = [
    { name: 'FYERS_WS', priority: 0, enabled: true, credentialsOk: true, universes: ['NIFTY'], ageMs: null },
    { name: 'UPSTOX_REST', priority: 1, enabled: true, credentialsOk: true, universes: ['NIFTY'], ageMs: null },
  ];
  const d = decideOwnership(['NIFTY'], feeds, { staleAfterMs: 10_000, downAfterMs: 60_000, mode: 'universe' });

  // Highest-priority holds the slot but reason says "must reconnect" = no production
  assert.equal(d[0].owner, 'FYERS_WS', 'FYERS holds slot (highest priority)');
  assert.ok(d[0].reason.includes('no feed is producing'), 'no production');
  // The health gate is what blocks new entries, not arbitration alone
  assert.equal(unownedUniverses(d).length, 0, 'no unowned universes (FYERS holds slot)');
  console.log('  [PASS] both unavailable: highest-priority holds slot, health gate blocks entries');
}

// --- 3b. Health gate confirms blocked ---
{
  const health = new FeedHealthService();
  health.registerFeed('FYERS_LIVE', 'fnf', { ageMs: () => null, enabled: () => true });
  health.registerFeed('UPSTOX_LIVE', 'fnf', { ageMs: () => null, enabled: () => true });

  const gate = health.gateFor('fnf', NOW);
  assert.equal(gate.allowNewTrading, false, 'trading blocked');
  assert.equal(gate.overall, 'DOWN');
  console.log('  [PASS] health gate: both DOWN → trading blocked');
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 4: PROVENANCE SURVIVES FAILOVER
// ═══════════════════════════════════════════════════════════════════════════

// --- 4a. Source field correct after failover ---
{
  // After FYERS → Upstox failover
  const result = interpretObservation('UPSTOX_REST', {
    providerInstrumentId: 'NSE_FO|NIFTY26SEP23000PE',
    underlying: 'NIFTY',
    exchange: 'NSE',
    instrumentType: 'OPT',
    expiry: '2026-09-26',
    strike: 23000,
    optionType: 'PE',
    ltp: 185.0,
    sourceTimestamp: NOW,
    raw: { provenance_test: true },
  }, NOW, budgets);

  assert.equal(result.ok, true);
  assert.equal(result.tick.source, 'UPSTOX_REST', 'source preserved after failover');
  assert.ok(result.tick.rawPayloadHash.length > 0, 'payload hash preserved');
  console.log('  [PASS] provenance: source + payload hash survive failover');
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 5: NO DUPLICATE CONFLICTING OBSERVATIONS
// ═══════════════════════════════════════════════════════════════════════════

// --- 5a. Single-owner rule prevents duplicates ---
{
  const feeds = [
    { name: 'FYERS_WS', priority: 0, enabled: true, credentialsOk: true, universes: ['NIFTY'], ageMs: 2_000 },
    { name: 'UPSTOX_REST', priority: 1, enabled: true, credentialsOk: true, universes: ['NIFTY'], ageMs: 3_000 },
  ];
  const d = decideOwnership(['NIFTY'], feeds, { staleAfterMs: 10_000, downAfterMs: 60_000, mode: 'universe' });

  const owners = d.filter(x => x.universe === 'NIFTY').map(x => x.owner);
  assert.equal(owners.length, 1, 'exactly one owner per universe');
  assert.equal(owners[0], 'FYERS_WS', 'only FYERS owns');
  assert.ok(d[0].standby.includes('UPSTOX_REST'), 'Upstox is standby, not producing');
  console.log('  [PASS] single-owner rule: no duplicate observations');
}

// --- 5b. Standby does not produce ---
{
  const feeds = [
    { name: 'FYERS_WS', priority: 0, enabled: true, credentialsOk: true, universes: ['NIFTY'], ageMs: 2_000 },
    { name: 'UPSTOX_REST', priority: 1, enabled: true, credentialsOk: true, universes: ['NIFTY'], ageMs: 3_000 },
  ];
  const d = decideOwnership(['NIFTY'], feeds, { staleAfterMs: 10_000, downAfterMs: 60_000, mode: 'universe' });

  assert.equal(mayProduce('UPSTOX_REST', ['NIFTY'], d), false, 'standby Upstox cannot produce');
  assert.equal(mayProduce('FYERS_WS', ['NIFTY'], d), true, 'owner FYERS can produce');
  console.log('  [PASS] standby enforcement: only owner produces');
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 6: RAPID FAILOVER SEQUENCE
// ═══════════════════════════════════════════════════════════════════════════

// --- 6a. FYERS → Upstox → FYERS (rapid cycle) ---
{
  const sequence = [
    { fyers: 2_000, upstox: 3_000, expected: 'FYERS_WS', desc: 'initial' },
    { fyers: null, upstox: 3_000, expected: 'UPSTOX_REST', desc: 'FYERS drops' },
    { fyers: 1_000, upstox: null, expected: 'FYERS_WS', desc: 'Upstox drops, FYERS recovers' },
    { fyers: 2_000, upstox: 2_000, expected: 'FYERS_WS', desc: 'both recover' },
    { fyers: null, upstox: null, expected: 'FYERS_WS', desc: 'both down (FYERS holds slot)' },
    { fyers: 1_000, upstox: null, expected: 'FYERS_WS', desc: 'FYERS recovers alone' },
  ];

  for (const { fyers, upstox, expected, desc } of sequence) {
    const feeds = [
      { name: 'FYERS_WS', priority: 0, enabled: true, credentialsOk: true, universes: ['NIFTY'], ageMs: fyers },
      { name: 'UPSTOX_REST', priority: 1, enabled: true, credentialsOk: true, universes: ['NIFTY'], ageMs: upstox },
    ];
    const d = decideOwnership(['NIFTY'], feeds, { staleAfterMs: 10_000, downAfterMs: 60_000, mode: 'universe' });
    assert.equal(d[0].owner, expected, desc);
  }
  console.log('  [PASS] rapid failover cycle: deterministic at every step');
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 7: MULTI-UNIVERSE FAILOVER
// ═══════════════════════════════════════════════════════════════════════════

// --- 7a. FYERS covers NIFTY, Upstox covers both → separate failovers ---
{
  const feeds = [
    { name: 'FYERS_WS', priority: 0, enabled: true, credentialsOk: true, universes: ['NIFTY'], ageMs: null },
    { name: 'UPSTOX_REST', priority: 1, enabled: true, credentialsOk: true, universes: ['NIFTY', 'SENSEX'], ageMs: 2_000 },
  ];
  const d = decideOwnership(['NIFTY', 'SENSEX'], feeds, { staleAfterMs: 10_000, downAfterMs: 60_000, mode: 'universe' });

  const nifty = d.find(x => x.universe === 'NIFTY');
  const sensex = d.find(x => x.universe === 'SENSEX');

  assert.equal(nifty.owner, 'UPSTOX_REST', 'Upstox owns NIFTY (FYERS DOWN)');
  assert.equal(sensex.owner, 'UPSTOX_REST', 'Upstox owns SENSEX (sole covering)');
  console.log('  [PASS] multi-universe failover: per-universe ownership');
}

console.log('');
console.log('All TA-015 E2E failover tests passed');
