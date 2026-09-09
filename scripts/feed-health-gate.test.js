#!/usr/bin/env node
/**
 * Feed-health gate tests (brief s6/s8) — pure machine + runtime registry.
 * No DB, no network. Defaults: staleAfter 10s, downAfter 60s.
 */
const assert = require('node:assert/strict');

const { evaluateEngine, stateForFeed } = require('../dist/trading/unified-market-data/feed-health.state');
const { FeedHealthService } = require('../dist/trading/unified-market-data/feed-health.service');

const NOW = new Date('2026-09-10T10:00:00.000Z');
const feed = (name, engine, ageMs, enabled = true) => ({ name, engine, ageMs, enabled });
const gate = (feeds, stale = 10_000, down = 60_000, engine = 'fnf') =>
  evaluateEngine(feeds, stale, down, NOW, engine);

console.log('feed-health gate tests');

// ── 1. stateForFeed boundaries ──────────────────────────────────────────────
assert.equal(stateForFeed(0, 10_000, 60_000), 'FRESH');
assert.equal(stateForFeed(10_000, 10_000, 60_000), 'FRESH'); // <= stale = FRESH
assert.equal(stateForFeed(10_001, 10_000, 60_000), 'STALE');
assert.equal(stateForFeed(60_000, 10_000, 60_000), 'STALE');
assert.equal(stateForFeed(60_001, 10_000, 60_000), 'DOWN');
assert.equal(stateForFeed(null, 10_000, 60_000), 'DOWN'); // never connected

// ── 2. Healthy → allow new trading ──────────────────────────────────────────
let g = gate([feed('FYERS_LIVE', 'fnf', 2_000)]);
assert.equal(g.allowNewTrading, true);
assert.equal(g.overall, 'HEALTHY');
assert.equal(g.reason, 'fresh market data');

// ── 3. Stale only → pause ───────────────────────────────────────────────────
g = gate([feed('FYERS_LIVE', 'fnf', 30_000)]);
assert.equal(g.allowNewTrading, false);
assert.equal(g.overall, 'STALE_ONLY');

// ── 4. Down / never connected → pause ───────────────────────────────────────
g = gate([feed('FYERS_LIVE', 'fnf', null)]);
assert.equal(g.allowNewTrading, false);
assert.equal(g.overall, 'DOWN');
g = gate([feed('FYERS_LIVE', 'fnf', 120_000)]);
assert.equal(g.allowNewTrading, false);
assert.equal(g.overall, 'DOWN');

// ── 5. Multi-feed: one fresh suffices; engine-scoped ────────────────────────
g = gate([
  feed('FYERS_LIVE', 'fnf', 120_000),
  feed('UPSTOX_LIVE', 'upstox-paper', 3_000),
  feed('UPSTOX_LIVE2', 'upstox-paper', 200_000),
], 10_000, 60_000, 'upstox-paper');
assert.equal(g.allowNewTrading, true); // upstox engine has fresh UPSTOX_LIVE
assert.equal(g.feeds.length, 2); // only engine feeds listed

// FnF engine on the same registry has only its stale FYERS feed → paused
g = gate([
  feed('FYERS_LIVE', 'fnf', 120_000),
  feed('UPSTOX_LIVE', 'upstox-paper', 3_000),
], 10_000, 60_000, 'fnf');
assert.equal(g.allowNewTrading, false);
assert.equal(g.overall, 'DOWN');

// ── 6. Disabled feed never satisfies the gate ───────────────────────────────
g = gate([feed('FYERS_LIVE', 'fnf', 1_000, false)]);
assert.equal(g.allowNewTrading, false);
assert.equal(g.overall, 'NO_FEED');
assert.equal(g.reason, 'no market-data feed enabled for engine');

// ── 7. Automatic recovery (no timers/state) ─────────────────────────────────
g = gate([feed('FYERS_LIVE', 'fnf', 30_000)]);
assert.equal(g.allowNewTrading, false);
g = gate([feed('FYERS_LIVE', 'fnf', 1_000)]); // fresh ticks resumed
assert.equal(g.allowNewTrading, true);
assert.equal(g.overall, 'HEALTHY');

// ── 8. Runtime registry (FeedHealthService) ─────────────────────────────────
const health = new FeedHealthService();
health.registerFeed('FYERS_LIVE', 'fnf', { ageMs: () => 1_500, enabled: () => true });
health.registerFeed('UPSTOX_REST', 'upstox-paper', { ageMs: () => null }); // never ticked

const fnfGate = health.gateForFnf();
assert.equal(fnfGate.allowNewTrading, true);

const upstoxGate = health.gateFor('upstox-paper');
assert.equal(upstoxGate.allowNewTrading, false);
assert.equal(upstoxGate.overall, 'DOWN'); // null age = never connected

const st = health.status();
assert.equal(st.feeds.length, 2);
assert.ok(st.staleAfterMs >= 1_000);
assert.ok(st.downAfterMs > st.staleAfterMs);

// Unregister → engine has no feed → NO_FEED pause
health.unregisterFeed('FYERS_LIVE');
assert.equal(health.gateForFnf().overall, 'NO_FEED');

console.log('feed-health gate tests passed');
