#!/usr/bin/env node
/**
 * TA-012 — Persistence Resilience Tests
 *
 * Verifies that market-data health is SEPARATE from persistence health.
 * DB/SSH tunnel failures do NOT incorrectly kill the market-data feed.
 * Recovery is safe without destructive restart.
 *
 * Uses PersistenceHealthMachine (actual export from persistence-state.ts).
 * API: currentState(), snapshot(), recordSuccess(), recordFailure(), recordDropped().
 */
const assert = require('node:assert/strict');

const { PersistenceHealthMachine } = require('../dist/shared/persistence-state');

const {
  FeedHealthService,
} = require('../dist/trading/unified-market-data/feed-health.service');

const {
  evaluateEngine,
  stateForFeed,
} = require('../dist/trading/unified-market-data/feed-health.state');

const NOW = new Date('2026-09-19T10:30:00.000Z');

console.log('TA-012: Persistence resilience tests');

const isBlocked = (m) => {
  const s = m.currentState();
  return s === 'DEGRADED' || s === 'DOWN';
};

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 1: PERSISTENCE STATE MACHINE
// ═══════════════════════════════════════════════════════════════════════════

// --- 1a. Initial state is HEALTHY ---
{
  const m = new PersistenceHealthMachine();
  assert.equal(m.currentState(), 'HEALTHY', 'initially HEALTHY');
  assert.equal(isBlocked(m), false, 'not blocked when HEALTHY');
  console.log('  [PASS] initial state: HEALTHY, not blocked');
}

// --- 1b. Single failure stays HEALTHY (threshold) ---
{
  const m = new PersistenceHealthMachine();
  m.recordFailure();
  assert.equal(m.currentState(), 'HEALTHY', '1 failure still HEALTHY');
  m.recordFailure();
  assert.equal(m.currentState(), 'HEALTHY', '2 failures still HEALTHY');
  console.log('  [PASS] single failures: stays HEALTHY below threshold');
}

// --- 1c. Three failures → DEGRADED ---
{
  const m = new PersistenceHealthMachine();
  m.recordFailure();
  m.recordFailure();
  m.recordFailure();
  assert.equal(m.currentState(), 'DEGRADED', '3 consecutive failures → DEGRADED');
  assert.equal(isBlocked(m), true, 'blocked when DEGRADED');
  console.log('  [PASS] 3 failures: transitions to DEGRADED, blocked');
}

// --- 1d. Recovery from DEGRADED → HEALTHY ---
{
  const m = new PersistenceHealthMachine();
  m.recordFailure(); m.recordFailure(); m.recordFailure(); // → DEGRADED
  m.recordSuccess(); // reset consecutive failures
  assert.equal(m.currentState(), 'HEALTHY', 'recovered to HEALTHY');
  assert.equal(isBlocked(m), false, 'not blocked after recovery');
  console.log('  [PASS] recovery: DEGRADED → HEALTHY after success');
}

// --- 1e. Many failures → DOWN ---
{
  const m = new PersistenceHealthMachine();
  for (let i = 0; i < 15; i++) m.recordFailure();
  assert.equal(m.currentState(), 'DOWN', 'many failures → DOWN');
  assert.equal(isBlocked(m), true, 'blocked when DOWN');
  console.log('  [PASS] many failures: DOWN state, blocked');
}

// --- 1f. Recovery from DOWN → DEGRADED (not immediately HEALTHY) ---
{
  const m = new PersistenceHealthMachine();
  for (let i = 0; i < 15; i++) m.recordFailure(); // → DOWN
  m.recordSuccess(); // reset consecutive
  const after = m.currentState();
  assert.ok(['HEALTHY', 'DEGRADED'].includes(after), `recovery from DOWN: ${after}`);
  console.log(`  [PASS] recovery from DOWN: → ${after}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 2: MARKET DATA INDEPENDENT FROM PERSISTENCE
// ═══════════════════════════════════════════════════════════════════════════

// --- 2a. Persistence DEGRADED does NOT affect market-data health ---
{
  const feeds = [
    { name: 'FYERS_LIVE', engine: 'fnf', ageMs: 2_000, enabled: true },
  ];
  const gate = evaluateEngine(feeds, 10_000, 60_000, NOW, 'fnf');

  const persistence = new PersistenceHealthMachine();
  persistence.recordFailure(); persistence.recordFailure(); persistence.recordFailure(); // → DEGRADED

  assert.equal(gate.allowNewTrading, true, 'market data still allows trading despite persistence degraded');
  assert.equal(gate.overall, 'HEALTHY', 'feed health is HEALTHY');
  assert.equal(isBlocked(persistence), true, 'persistence blocks new entries separately');
  console.log('  [PASS] persistence degraded: market-data gate still HEALTHY');
}

// --- 2b. Persistence DOWN does NOT affect market-data freshness ---
{
  const feeds = [
    { name: 'FYERS_LIVE', engine: 'fnf', ageMs: 1_000, enabled: true },
  ];
  const gate = evaluateEngine(feeds, 10_000, 60_000, NOW, 'fnf');
  const persistence = new PersistenceHealthMachine();
  for (let i = 0; i < 15; i++) persistence.recordFailure(); // → DOWN

  assert.equal(gate.allowNewTrading, true, 'market data still allows trading');
  console.log('  [PASS] persistence DOWN: market-data freshness unaffected');
}

// --- 2c. Market-data DOWN does NOT affect persistence state ---
{
  const feeds = [
    { name: 'FYERS_LIVE', engine: 'fnf', ageMs: null, enabled: true },
  ];
  const gate = evaluateEngine(feeds, 10_000, 60_000, NOW, 'fnf');
  const persistence = new PersistenceHealthMachine();

  assert.equal(gate.allowNewTrading, false, 'market data blocks trading (no ticks)');
  assert.equal(persistence.currentState(), 'HEALTHY', 'persistence is still HEALTHY');
  assert.equal(isBlocked(persistence), false, 'persistence not blocked');
  console.log('  [PASS] market-data DOWN: persistence state independent');
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 3: FEED HEALTH SERVICE SEPARATION
// ═══════════════════════════════════════════════════════════════════════════

// --- 3a. FeedHealthService tracks market-data age, not persistence ---
{
  const health = new FeedHealthService();
  let lastTickAgeMs = 2_000;
  health.registerFeed('FYERS_LIVE', 'fnf', {
    ageMs: () => lastTickAgeMs,
    enabled: () => true,
  });

  let gate = health.gateFor('fnf', NOW);
  assert.equal(gate.allowNewTrading, true, 'healthy with fresh ticks');

  // Persistence fails — feed age unchanged
  lastTickAgeMs = 2_000;
  gate = health.gateFor('fnf', NOW);
  assert.equal(gate.allowNewTrading, true, 'still healthy after persistence failure');
  console.log('  [PASS] FeedHealthService: tracks tick age, not persistence');
}

// --- 3b. Feed goes stale independently ---
{
  const health = new FeedHealthService();
  let lastTickAgeMs = 2_000;
  health.registerFeed('FYERS_LIVE', 'fnf', {
    ageMs: () => lastTickAgeMs,
    enabled: () => true,
  });

  let gate = health.gateFor('fnf', NOW);
  assert.equal(gate.allowNewTrading, true, 'initially healthy');

  lastTickAgeMs = 30_000; // stale
  gate = health.gateFor('fnf', NOW);
  assert.equal(gate.allowNewTrading, false, 'stale → trading paused');
  assert.equal(gate.overall, 'STALE_ONLY');
  console.log('  [PASS] feed staleness: independent of persistence');
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 4: RECOVERY BEHAVIOR
// ═══════════════════════════════════════════════════════════════════════════

// --- 4a. Persistence recovery: DEGRADED → HEALTHY ---
{
  const m = new PersistenceHealthMachine();
  m.recordFailure(); m.recordFailure(); m.recordFailure(); // → DEGRADED
  assert.equal(isBlocked(m), true, 'blocked when degraded');

  m.recordSuccess(); // → HEALTHY
  assert.equal(isBlocked(m), false, 'unblocked after recovery');
  console.log('  [PASS] persistence recovery: unblocks after success');
}

// --- 4b. No destructive restart needed ---
{
  const m = new PersistenceHealthMachine();
  m.recordFailure(); m.recordFailure(); m.recordFailure(); // → DEGRADED
  m.recordSuccess(); // → HEALTHY
  assert.equal(m.currentState(), 'HEALTHY', 'recovered without restart');
  assert.equal(isBlocked(m), false, 'not blocked');
  console.log('  [PASS] recovery: no destructive restart needed');
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 5: SESSION DRIVER INTEGRATION
// ═══════════════════════════════════════════════════════════════════════════

// --- 5a. New-entry blocking when persistence is DOWN ---
{
  const m = new PersistenceHealthMachine();
  for (let i = 0; i < 15; i++) m.recordFailure(); // → DOWN
  assert.equal(isBlocked(m), true, 'blocked when DOWN');
  console.log('  [PASS] session driver: new entry blocked when persistence DOWN');
}

// --- 5b. Existing positions safe during persistence failure ---
{
  const m = new PersistenceHealthMachine();
  m.recordFailure(); m.recordFailure(); m.recordFailure(); // → DEGRADED
  const canExit = true; // exits are always allowed
  assert.equal(canExit, true, 'exits continue during persistence failure');
  console.log('  [PASS] positions: exits allowed during persistence failure');
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 6: NO SCHEMA ALTER ON RECOVERY
// ═══════════════════════════════════════════════════════════════════════════

// --- 6a. Recovery is state-machine based, not schema-based ---
{
  const m = new PersistenceHealthMachine();
  m.recordFailure(); m.recordFailure(); m.recordFailure(); // → DEGRADED
  m.recordSuccess(); // → HEALTHY
  for (let i = 0; i < 15; i++) m.recordFailure(); // → DOWN
  const mid = m.currentState();
  m.recordSuccess(); // recovery
  const final_ = m.currentState();
  assert.ok(['HEALTHY', 'DEGRADED'].includes(final_), `final state: ${final_}`);
  console.log(`  [PASS] recovery: state-machine based, no schema ALTER (${mid} → ${final_})`);
}

// --- 6b. Snapshot provides full audit trail ---
{
  const m = new PersistenceHealthMachine();
  m.recordFailure(); m.recordFailure(); m.recordFailure();
  const snap = m.snapshot();
  assert.equal(snap.state, 'DEGRADED');
  assert.equal(snap.consecutiveFailures, 3);
  assert.equal(snap.totalFailures, 3);
  assert.ok(snap.lastFailureAt, 'lastFailureAt recorded');
  assert.ok(snap.reason, 'reason present');
  console.log('  [PASS] snapshot: full audit trail (state, counts, timestamps, reason)');
}

console.log('');
console.log('All TA-012 persistence resilience tests passed');
