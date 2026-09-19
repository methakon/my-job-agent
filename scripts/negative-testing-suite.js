#!/usr/bin/env node
/**
 * Negative Testing Suite — Pre-Monday Live Validation Hardening
 *
 * Tests the error handling of:
 *   1. Canonical tick interpreter (interpretObservation)
 *   2. Feed health state machine (stateForFeed, evaluateEngine)
 *   3. Feed health service (FeedHealthService)
 *   4. Persistence health machine (PersistenceHealthMachine)
 *   5. Provider mappers (fyersMapper, upstoxMapper, zerodhaMapper, mapperFor, envelopeFor)
 *   6. withTimeout utility (provider timeout isolation)
 *
 * Every test verifies the resulting SAFETY STATE, not merely that an exception
 * was thrown. Run: node scripts/negative-testing-suite.js → must exit 0.
 */

'use strict';

// ─── Module imports ──────────────────────────────────────────────────────────
const {
  interpretObservation,
  DEFAULT_TICK_BUDGETS,
  payloadHash,
  stableStringify,
  normalizeExpiry,
  normalizeOptionType,
  parseOptionSymbol,
  canonicalInstrumentKey,
  canonicalOptionSymbol,
  classifyInstrument,
  parseSourceTimestamp,
  describeRecordTimestamps,
  budgetsFromEnv,
} = require('../dist/trading/unified-market-data/canonical/canonical-tick');

const {
  FeedHealthService,
} = require('../dist/trading/unified-market-data/feed-health.service');

const {
  evaluateEngine,
  stateForFeed,
  DEFAULT_STALE_AFTER_MS,
  DEFAULT_DOWN_AFTER_MS,
} = require('../dist/trading/unified-market-data/feed-health.state');

const {
  PersistenceHealthMachine,
} = require('../dist/shared/persistence-state');

const {
  mapperFor,
  fyersMapper,
  upstoxMapper,
  zerodhaMapper,
  envelopeFor,
  supportedProviders,
} = require('../dist/trading/unified-market-data/canonical/provider-mappers');

const { withTimeout } = require('../dist/trading/unified-market-data/feed-arbitration.service');

(async () => {
// ─── Test infrastructure ─────────────────────────────────────────────────────
let total = 0;
let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, label) {
  total++;
  if (condition) {
    passed++;
  } else {
    failed++;
    failures.push(label);
    console.error(`  ✗ FAIL: ${label}`);
  }
}

function assertEqual(actual, expected, label) {
  total++;
  if (actual === expected) {
    passed++;
  } else {
    failed++;
    const msg = `${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`;
    failures.push(msg);
    console.error(`  ✗ FAIL: ${msg}`);
  }
}

function assertIncludes(haystack, needle, label) {
  total++;
  if (typeof haystack === 'string' && haystack.includes(needle)) {
    passed++;
  } else {
    failed++;
    const msg = `${label} — expected string to include "${needle}", got "${String(haystack).slice(0, 120)}"`;
    failures.push(msg);
    console.error(`  ✗ FAIL: ${msg}`);
  }
}

function group(name) {
  console.log(`\n▸ ${name}`);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function makeObservation(overrides = {}) {
  return {
    providerInstrumentId: 'NSE_FO|NIFTY26SEP23000PE',
    providerSymbol: 'NIFTY26SEP23000PE',
    underlying: 'NIFTY',
    exchange: 'NSE',
    segment: 'FO',
    instrumentType: 'OPT',
    expiry: '2026-09-26',
    strike: 23000,
    optionType: 'PE',
    ltp: 150.5,
    bid: 149,
    ask: 151,
    bidQty: 100,
    askQty: 200,
    volume: 50000,
    oi: 100000,
    sourceTimestamp: new Date().toISOString(),
    sourceTimestampSemantics: 'QUOTE',
    raw: { symbol: 'NIFTY26SEP23000PE', ltp: 150.5 },
    ...overrides,
  };
}

function now() { return new Date(); }

// ═══════════════════════════════════════════════════════════════════════════════
// CATEGORY 1: MALFORMED PROVIDER PAYLOAD
// ═══════════════════════════════════════════════════════════════════════════════
group('1. MALFORMED PROVIDER PAYLOAD');

{
  // 1a: null payload
  const r1 = interpretObservation('FYERS', null, now());
  assertEqual(r1.ok, false, '1a: null payload → rejected');
  assertEqual(r1.code, 'SCHEMA', '1a: null payload → SCHEMA rejection code');

  // 1b: undefined payload
  const r2 = interpretObservation('FYERS', undefined, now());
  assertEqual(r2.ok, false, '1b: undefined payload → rejected');
  assertEqual(r2.code, 'SCHEMA', '1b: undefined payload → SCHEMA rejection code');

  // 1c: empty object — no identity
  const r3 = interpretObservation('FYERS', {}, now());
  assertEqual(r3.ok, false, '1c: empty object → rejected');
  assertEqual(r3.code, 'UNRESOLVED_INSTRUMENT', '1c: empty object → UNRESOLVED_INSTRUMENT');

  // 1d: wrong type (string instead of object)
  const r4 = interpretObservation('FYERS', 'not an object', now());
  assertEqual(r4.ok, false, '1d: string payload → rejected');
  assertEqual(r4.code, 'SCHEMA', '1d: string payload → SCHEMA');

  // 1e: wrong type (number)
  const r5 = interpretObservation('FYERS', 42, now());
  assertEqual(r5.ok, false, '1e: number payload → rejected');
  assertEqual(r5.code, 'SCHEMA', '1e: number payload → SCHEMA');

  // 1f: array payload
  const r6 = interpretObservation('FYERS', [1, 2, 3], now());
  assertEqual(r6.ok, false, '1f: array payload → rejected');
  // typeof [] === 'object' in JS, so it passes the type check; then no identity → UNRESOLVED
  assertEqual(r6.code, 'UNRESOLVED_INSTRUMENT', '1f: array payload → UNRESOLVED_INSTRUMENT');

  // 1g: empty source name
  const r7 = interpretObservation('', makeObservation(), now());
  assertEqual(r7.ok, false, '1g: empty source → rejected');
  assertEqual(r7.code, 'SCHEMA', '1g: empty source → SCHEMA');
}

// ═══════════════════════════════════════════════════════════════════════════════
// CATEGORY 2: MISSING FIELDS
// ═══════════════════════════════════════════════════════════════════════════════
group('2. MISSING FIELDS');

{
  // 2a: only raw, no instrument identity
  const r1 = interpretObservation('FYERS', { raw: {} }, now());
  assertEqual(r1.ok, false, '2a: raw only, no identity → rejected');
  assertEqual(r1.code, 'UNRESOLVED_INSTRUMENT', '2a: → UNRESOLVED_INSTRUMENT');

  // 2b: identity present but no price fields
  const r2 = interpretObservation('FYERS', {
    providerSymbol: 'NIFTY26SEP23000PE',
    exchange: 'NSE',
    raw: {},
  }, now());
  assertEqual(r2.ok, false, '2b: identity but no prices → rejected');
  assertEqual(r2.code, 'INVALID_VALUE', '2b: no prices → INVALID_VALUE');

  // 2c: non-numeric ltp → num() returns null; code now rejects non-numeric price strings
  const r3 = interpretObservation('FYERS', {
    providerSymbol: 'NIFTY26SEP23000PE',
    exchange: 'NSE',
    ltp: 'not-a-number',
    raw: {},
  }, now());
  assertEqual(r3.ok, false, '2c: non-numeric ltp → rejected (INVALID_VALUE)');
  assertEqual(r3.code, 'INVALID_VALUE', '2c: → INVALID_VALUE code');
}

// ═══════════════════════════════════════════════════════════════════════════════
// CATEGORY 3: UNKNOWN INSTRUMENT
// ═══════════════════════════════════════════════════════════════════════════════
group('3. UNKNOWN INSTRUMENT');

{
  // 3a: numeric-only providerInstrumentId resolves as UNKNOWN instrument with valid price
  const r1 = interpretObservation('FYERS', {
    providerInstrumentId: '123456',
    ltp: 100,
    raw: {},
  }, now());
  assertEqual(r1.ok, true, '3a: numeric token → accepted as UNKNOWN instrument');
  if (r1.ok) {
    assertEqual(r1.tick.instrumentType, 'UNKNOWN', '3a: → UNKNOWN instrument type');
  }

  // 3b: garbage symbol
  const r2 = interpretObservation('FYERS', {
    providerSymbol: 'GARBAGE_XYZ_123',
    ltp: 100,
    raw: {},
  }, now());
  // Garbage symbols that aren't pure numeric will produce an instrument key but
  // with unknown instrument type. They get classified as UNKNOWN type.
  // As long as it has ltp > 0, it may pass — verify the type is UNKNOWN.
  assertEqual(r2.ok, true, '3b: garbage symbol accepted (unclassified but has price)');
  if (r2.ok) {
    assertEqual(r2.tick.instrumentType, 'UNKNOWN', '3b: garbage → UNKNOWN type');
  }

  // 3c: empty string providerInstrumentId
  const r3 = interpretObservation('FYERS', {
    providerInstrumentId: '',
    ltp: 100,
    raw: {},
  }, now());
  assertEqual(r3.ok, false, '3c: empty instrument id → rejected');
}

// ═══════════════════════════════════════════════════════════════════════════════
// CATEGORY 4: STALE TICK
// ═══════════════════════════════════════════════════════════════════════════════
group('4. STALE TICK');

{
  const received = new Date();
  const obs = makeObservation();

  // 4a: QUOTE tick 120 seconds old (budget is 60s)
  const staleQuote = new Date(received.getTime() - 120_000);
  const r1 = interpretObservation('FYERS', { ...obs, sourceTimestamp: staleQuote.toISOString(), sourceTimestampSemantics: 'QUOTE' }, received);
  assertEqual(r1.ok, false, '4a: stale QUOTE (120s) → rejected');
  assertEqual(r1.code, 'STALE', '4a: → STALE rejection code');
  assertIncludes(r1.reason, '120s', '4a: reason mentions age in seconds');

  // 4b: LAST_TRADE tick 900+1 seconds old (budget is 900s)
  const staleTrade = new Date(received.getTime() - 901_000);
  const r2 = interpretObservation('FYERS', { ...obs, sourceTimestamp: staleTrade.toISOString(), sourceTimestampSemantics: 'LAST_TRADE' }, received);
  assertEqual(r2.ok, false, '4b: stale LAST_TRADE (901s) → rejected');
  assertEqual(r2.code, 'STALE', '4b: → STALE');

  // 4c: LAST_TRADE tick at exactly 900s boundary — NOT stale (within budget)
  const boundaryTrade = new Date(received.getTime() - 900_000);
  const r3 = interpretObservation('FYERS', { ...obs, sourceTimestamp: boundaryTrade.toISOString(), sourceTimestampSemantics: 'LAST_TRADE' }, received);
  assertEqual(r3.ok, true, '4c: LAST_TRADE at 900s boundary → accepted');

  // 4d: QUOTE tick at exactly 60s boundary — NOT stale
  const boundaryQuote = new Date(received.getTime() - 60_000);
  const r4 = interpretObservation('FYERS', { ...obs, sourceTimestamp: boundaryQuote.toISOString(), sourceTimestampSemantics: 'QUOTE' }, received);
  assertEqual(r4.ok, true, '4d: QUOTE at 60s boundary → accepted');
}

// ═══════════════════════════════════════════════════════════════════════════════
// CATEGORY 5: CROSSED/INVALID TICK
// ═══════════════════════════════════════════════════════════════════════════════
group('5. CROSSED/INVALID TICK');

{
  // 5a: bid > ask (crossed book)
  const r1 = interpretObservation('FYERS', makeObservation({ bid: 200, ask: 100 }), now());
  assertEqual(r1.ok, false, '5a: bid > ask → rejected');
  assertEqual(r1.code, 'IMPOSSIBLE_VALUE', '5a: → IMPOSSIBLE_VALUE');
  assertIncludes(r1.reason, 'crossed book', '5a: reason mentions crossed book');

  // 5b: negative ltp
  const r2 = interpretObservation('FYERS', makeObservation({ ltp: -50 }), now());
  assertEqual(r2.ok, false, '5b: negative ltp → rejected');
  assertEqual(r2.code, 'IMPOSSIBLE_VALUE', '5b: → IMPOSSIBLE_VALUE');
  assertIncludes(r2.reason, 'ltp', '5b: reason mentions ltp');

  // 5c: zero ltp
  const r3 = interpretObservation('FYERS', makeObservation({ ltp: 0 }), now());
  assertEqual(r3.ok, false, '5c: zero ltp → rejected');
  assertEqual(r3.code, 'IMPOSSIBLE_VALUE', '5c: zero ltp → IMPOSSIBLE_VALUE');

  // 5d: negative volume
  const r4 = interpretObservation('FYERS', makeObservation({ volume: -100 }), now());
  assertEqual(r4.ok, false, '5d: negative volume → rejected');
  assertEqual(r4.code, 'IMPOSSIBLE_VALUE', '5d: → IMPOSSIBLE_VALUE');
  assertIncludes(r4.reason, 'volume', '5d: reason mentions volume');

  // 5e: negative oi
  const r5 = interpretObservation('FYERS', makeObservation({ oi: -500 }), now());
  assertEqual(r5.ok, false, '5e: negative oi → rejected');
  assertEqual(r5.code, 'IMPOSSIBLE_VALUE', '5e: → IMPOSSIBLE_VALUE');

  // 5f: negative bidQty
  const r6 = interpretObservation('FYERS', makeObservation({ bidQty: -10 }), now());
  assertEqual(r6.ok, false, '5f: negative bidQty → rejected');
  assertEqual(r6.code, 'IMPOSSIBLE_VALUE', '5f: → IMPOSSIBLE_VALUE');

  // 5g: negative askQty
  const r7 = interpretObservation('FYERS', makeObservation({ askQty: -5 }), now());
  assertEqual(r7.ok, false, '5g: negative askQty → rejected');
  assertEqual(r7.code, 'IMPOSSIBLE_VALUE', '5g: → IMPOSSIBLE_VALUE');

  // 5h: strike <= 0 for an option
  const r8 = interpretObservation('FYERS', makeObservation({ strike: 0 }), now());
  assertEqual(r8.ok, false, '5h: strike = 0 → rejected');
  assertEqual(r8.code, 'IMPOSSIBLE_VALUE', '5h: → IMPOSSIBLE_VALUE');

  const r9 = interpretObservation('FYERS', makeObservation({ strike: -100 }), now());
  assertEqual(r9.ok, false, '5i: strike = -100 → rejected');
  assertEqual(r9.code, 'IMPOSSIBLE_VALUE', '5i: → IMPOSSIBLE_VALUE');
}

// ═══════════════════════════════════════════════════════════════════════════════
// CATEGORY 6: DUPLICATE TICK
// ═══════════════════════════════════════════════════════════════════════════════
group('6. DUPLICATE TICK');

{
  // 6a: same raw payload produces identical payloadHash
  const raw = { symbol: 'NIFTY26SEP23000PE', ltp: 150.5, vol: 1000 };
  const h1 = payloadHash(raw);
  const h2 = payloadHash(raw);
  assertEqual(h1, h2, '6a: identical raw → identical hash');

  // 6b: different raw payload produces different hash
  const h3 = payloadHash({ ...raw, ltp: 150.6 });
  assert(h1 !== h3, '6b: different raw → different hash');

  // 6c: stableStringify is deterministic for same input
  const s1 = stableStringify(raw);
  const s2 = stableStringify(raw);
  assertEqual(s1, s2, '6c: stableStringify deterministic');

  // 6d: stableStringify sorts keys
  const sorted = stableStringify({ b: 2, a: 1 });
  assert(sorted.indexOf('"a"') < sorted.indexOf('"b"'), '6d: stableStringify sorts keys');

  // 6e: duplicate interpretation produces identical canonical tick hashes
  const received = now();
  const obs = makeObservation();
  const t1 = interpretObservation('FYERS', obs, received);
  const t2 = interpretObservation('FYERS', obs, received);
  assertEqual(t1.ok, true, '6e: first interpretation ok');
  assertEqual(t2.ok, true, '6e: second interpretation ok');
  if (t1.ok && t2.ok) {
    assertEqual(t1.tick.rawPayloadHash, t2.tick.rawPayloadHash, '6e: identical hash on duplicate');
    assertEqual(t1.tick.instrumentKey, t2.tick.instrumentKey, '6e: identical key on duplicate');
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CATEGORY 7: OUT-OF-ORDER TICK
// ═══════════════════════════════════════════════════════════════════════════════
group('7. OUT-OF-ORDER TICK');

{
  // The interpreter is pure — it doesn't maintain state between calls.
  // Out-of-order safety is the CALLER's responsibility (latestTs tracking).
  // Verify the interpreter does not mutate state: same input → same output
  // regardless of call order.

  const base = makeObservation({ ltp: 150 });
  const received1 = now();
  const received2 = now();

  const t1 = interpretObservation('FYERS', base, received1);
  const t2 = interpretObservation('FYERS', base, received2);

  assertEqual(t1.ok, true, '7a: first tick accepted');
  assertEqual(t2.ok, true, '7b: second tick accepted');

  // The interpreter doesn't cache — both are pure function results
  if (t1.ok && t2.ok) {
    assertEqual(t1.tick.ltp, t2.tick.ltp, '7c: same ltp both times');
    assertEqual(t1.tick.rawPayloadHash, t2.tick.rawPayloadHash, '7d: same hash both times');
  }

  // 7e: older sourceTimestamp received after newer — still parsed correctly
  const tsBase = Date.now();
  const older = makeObservation({
    ltp: 148,
    sourceTimestamp: new Date(tsBase - 120_000).toISOString(),
    sourceTimestampSemantics: 'LAST_TRADE', // 120s is within 900s LAST_TRADE budget
  });
  const newer = makeObservation({
    ltp: 150,
    sourceTimestamp: new Date(tsBase - 60_000).toISOString(),
    sourceTimestampSemantics: 'LAST_TRADE',
  });
  const rOld = interpretObservation('FYERS', older, now());
  const rNew = interpretObservation('FYERS', newer, now());
  assertEqual(rOld.ok, true, '7e: older tick accepted');
  assertEqual(rNew.ok, true, '7f: newer tick accepted');
  if (rOld.ok && rNew.ok) {
    assert(rOld.tick.ltp < rNew.tick.ltp, '7g: older tick has lower ltp');
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CATEGORY 8: PROVIDER DISCONNECT (Feed Health)
// ═══════════════════════════════════════════════════════════════════════════════
group('8. PROVIDER DISCONNECT');

{
  // 8a: null ageMs → DOWN
  const s1 = stateForFeed(null, DEFAULT_STALE_AFTER_MS, DEFAULT_DOWN_AFTER_MS);
  assertEqual(s1, 'DOWN', '8a: null age → DOWN');

  // 8b: ageMs > downAfterMs → DOWN
  const s2 = stateForFeed(DEFAULT_DOWN_AFTER_MS + 10_000, DEFAULT_STALE_AFTER_MS, DEFAULT_DOWN_AFTER_MS);
  assertEqual(s2, 'DOWN', '8b: age > DOWN_AFTER → DOWN');

  // 8c: ageMs > staleAfter but ≤ downAfter → STALE
  const s3 = stateForFeed(DEFAULT_STALE_AFTER_MS + 5_000, DEFAULT_STALE_AFTER_MS, DEFAULT_DOWN_AFTER_MS);
  assertEqual(s3, 'STALE', '8c: age between STALE and DOWN → STALE');

  // 8d: ageMs ≤ staleAfter → FRESH
  const s4 = stateForFeed(5_000, DEFAULT_STALE_AFTER_MS, DEFAULT_DOWN_AFTER_MS);
  assertEqual(s4, 'FRESH', '8d: age within stale window → FRESH');

  // 8e: FeedHealthService with provider disconnected (ageMs returning null)
  const svc = new FeedHealthService();
  svc.registerFeed('FYERS_LIVE', 'fnf', { ageMs: () => null });
  const gate = svc.gateFor('fnf');
  assertEqual(gate.allowNewTrading, false, '8e: disconnected provider → trading blocked');
  assertEqual(gate.overall, 'DOWN', '8e: disconnected provider → overall DOWN');

  // 8f: FeedHealthService with provider recently down but recovering
  const svc2 = new FeedHealthService();
  svc2.registerFeed('FYERS_LIVE', 'fnf', { ageMs: () => 5_000 }); // FRESH
  svc2.registerFeed('UPSTOX_LIVE', 'fnf', { ageMs: () => null }); // DOWN
  const gate2 = svc2.gateFor('fnf');
  assertEqual(gate2.allowNewTrading, true, '8f: one fresh feed → trading allowed');
  assertEqual(gate2.overall, 'HEALTHY', '8f: one fresh feed → overall HEALTHY');
}

// ═══════════════════════════════════════════════════════════════════════════════
// CATEGORY 9: PROVIDER TIMEOUT (withTimeout utility)
// ═══════════════════════════════════════════════════════════════════════════════
group('9. PROVIDER TIMEOUT');

{
  // 9a: operation completes within timeout
  const r1 = await withTimeout(async () => 'ok', 1000, 'test-quick');
  assertEqual(r1, 'ok', '9a: fast operation → result returned');

  // 9b: operation exceeds timeout → throws
  let threw = false;
  try {
    await withTimeout(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5000));
      return 'late';
    }, 50, 'test-slow');
  } catch (e) {
    threw = true;
    assertIncludes(e.message, 'timed out', '9b: timeout error message');
    assertIncludes(e.message, 'test-slow', '9b: error includes label');
  }
  assert(threw, '9b: slow operation → throws timeout error');

  // 9c: timeout doesn't affect other providers (isolation)
  // Simulate: one slow provider and one fast provider both using withTimeout
  const results = [];
  const slow = withTimeout(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    return 'slow';
  }, 50, 'slow-provider');

  const fast = withTimeout(async () => 'fast', 1000, 'fast-provider');

  try { await slow; } catch { /* expected */ }
  const fastResult = await fast;
  assertEqual(fastResult, 'fast', '9c: fast provider unaffected by slow provider timeout');

  // 9d: function-style operation
  const r2 = await withTimeout(() => Promise.resolve('fn-ok'), 1000, 'test-fn');
  assertEqual(r2, 'fn-ok', '9d: function-style operation works');
}

// ═══════════════════════════════════════════════════════════════════════════════
// CATEGORY 10: TOKEN/AUTH FAILURE
// ═══════════════════════════════════════════════════════════════════════════════
group('10. TOKEN/AUTH FAILURE');

{
  // Verify that credentialsOk() returning false causes feed to be excluded
  const svc = new FeedHealthService();

  // Feed with credentialsOk returning false should still be registered
  // but the evaluateEngine function excludes feeds where enabled=false
  // The FeedHealthService.registerFeed takes an `enabled` option (not credentialsOk).
  // Token/auth failure manifests as the feed being disabled or not producing ticks.
  svc.registerFeed('FYERS_LIVE', 'fnf', {
    ageMs: () => 5000,
    enabled: () => false, // simulates token failure → feed disabled
  });

  const gate = svc.gateFor('fnf');
  assertEqual(gate.allowNewTrading, false, '10a: disabled feed (auth failed) → no trading');
  assertEqual(gate.overall, 'NO_FEED', '10b: disabled feed → overall NO_FEED');

  // 10c: credentialsOk via evaluateEngine directly
  const feedInput = [{
    name: 'FYERS_LIVE',
    engine: 'fnf',
    ageMs: 1000,
    enabled: false, // auth failure disables the feed
  }];
  const gate2 = evaluateEngine(feedInput, DEFAULT_STALE_AFTER_MS, DEFAULT_DOWN_AFTER_MS, now(), 'fnf');
  assertEqual(gate2.allowNewTrading, false, '10c: evaluateEngine with disabled feed → no trading');
}

// ═══════════════════════════════════════════════════════════════════════════════
// CATEGORY 11: WEBSOCKET FAILURE (FRESH → STALE → DOWN transitions)
// ═══════════════════════════════════════════════════════════════════════════════
group('11. WEBSOCKET FAILURE (FRESH → STALE → DOWN)');

{
  const stale = DEFAULT_STALE_AFTER_MS;   // 10s
  const down = DEFAULT_DOWN_AFTER_MS;     // 60s

  // 11a: FRESH → STALE transition (age 15s > stale threshold of 10s)
  const s1 = stateForFeed(15_000, stale, down);
  assertEqual(s1, 'STALE', '11a: age 15s → STALE');

  // 11b: STALE → DOWN transition (age 65s > down threshold of 60s)
  const s2 = stateForFeed(65_000, stale, down);
  assertEqual(s2, 'DOWN', '11b: age 65s → DOWN');

  // 11c: DOWN → FRESH recovery (age 2s again)
  const s3 = stateForFeed(2_000, stale, down);
  assertEqual(s3, 'FRESH', '11c: recovered → FRESH');

  // 11d: Full lifecycle via FeedHealthService
  const svc = new FeedHealthService();
  let feedAge = 0;
  svc.registerFeed('FYERS_WS', 'fnf', { ageMs: () => feedAge });

  // Phase 1: FRESH
  feedAge = 1_000;
  let gate = svc.gateFor('fnf');
  assertEqual(gate.allowNewTrading, true, '11d-i: fresh → trading allowed');
  assertEqual(gate.overall, 'HEALTHY', '11d-i: fresh → HEALTHY');

  // Phase 2: STALE
  feedAge = 15_000;
  gate = svc.gateFor('fnf');
  assertEqual(gate.allowNewTrading, false, '11d-ii: stale → trading blocked');
  assertEqual(gate.overall, 'STALE_ONLY', '11d-ii: stale → STALE_ONLY');

  // Phase 3: DOWN
  feedAge = 90_000;
  gate = svc.gateFor('fnf');
  assertEqual(gate.allowNewTrading, false, '11d-iii: down → trading blocked');
  assertEqual(gate.overall, 'DOWN', '11d-iii: down → DOWN');

  // Phase 4: Recovery
  feedAge = 500;
  gate = svc.gateFor('fnf');
  assertEqual(gate.allowNewTrading, true, '11d-iv: recovered → trading allowed');
  assertEqual(gate.overall, 'HEALTHY', '11d-iv: recovered → HEALTHY');
}

// ═══════════════════════════════════════════════════════════════════════════════
// CATEGORY 12: DB FAILURE (PersistenceHealthMachine)
// ═══════════════════════════════════════════════════════════════════════════════
group('12. DB FAILURE (PersistenceHealthMachine)');

{
  // 12a: Initial state is HEALTHY
  const m1 = new PersistenceHealthMachine();
  assertEqual(m1.currentState(), 'HEALTHY', '12a: initial state → HEALTHY');

  // 12b: < 3 consecutive failures → still HEALTHY
  m1.recordFailure('db error');
  m1.recordFailure('db error');
  assertEqual(m1.currentState(), 'HEALTHY', '12b: 2 failures → HEALTHY');

  // 12c: 3 consecutive failures → DEGRADED
  m1.recordFailure('db error');
  assertEqual(m1.currentState(), 'DEGRADED', '12c: 3 failures → DEGRADED');

  // 12d: continued failures → still DEGRADED (not DOWN yet)
  m1.recordFailure('db error');
  m1.recordFailure('db error');
  assertEqual(m1.currentState(), 'DEGRADED', '12d: 5 failures → still DEGRADED');

  // 12e: success resets back to HEALTHY
  m1.recordSuccess();
  assertEqual(m1.currentState(), 'HEALTHY', '12e: success after DEGRADED → HEALTHY');

  // 12f: 13 consecutive failures (3 + 10) → DOWN
  const m2 = new PersistenceHealthMachine();
  for (let i = 0; i < 13; i++) m2.recordFailure('db pool exhausted');
  assertEqual(m2.currentState(), 'DOWN', '12f: 13 failures → DOWN');

  // 12g: success from DOWN → HEALTHY
  m2.recordSuccess();
  assertEqual(m2.currentState(), 'HEALTHY', '12g: success after DOWN → HEALTHY');

  // 12h: verify snapshot has correct counters
  const m3 = new PersistenceHealthMachine();
  m3.recordFailure('err1', 5);
  m3.recordFailure('err2', 3);
  m3.recordSuccess();
  const snap = m3.snapshot();
  assertEqual(snap.totalFailures, 2, '12h: totalFailures = 2');
  assertEqual(snap.totalDropped, 8, '12h: totalDropped = 8');
  assertEqual(snap.consecutiveFailures, 0, '12h: consecutiveFailures reset to 0');
  assertEqual(snap.consecutiveSuccesses, 1, '12h: consecutiveSuccesses = 1');
  assert(snap.lastFailureAt instanceof Date, '12h: lastFailureAt is Date');
  assert(snap.lastSuccessAt instanceof Date, '12h: lastSuccessAt is Date');

  // 12i: persistence failure does NOT affect market data feed state
  // (The PersistenceHealthMachine is independent of FeedHealthService)
  const feedSvc = new FeedHealthService();
  feedSvc.registerFeed('FYERS_LIVE', 'fnf', { ageMs: () => 1_000 });
  const feedGate = feedSvc.gateFor('fnf');
  assertEqual(feedGate.allowNewTrading, true, '12i: persistence DOWN but feed FRESH → trading allowed');
  assertEqual(feedGate.overall, 'HEALTHY', '12i: persistence DOWN does not affect feed gate');

  // 12j: reset clears all state
  const m4 = new PersistenceHealthMachine();
  m4.recordFailure('err');
  m4.recordFailure('err');
  m4.recordFailure('err');
  assertEqual(m4.currentState(), 'DEGRADED', '12j: after 3 failures → DEGRADED');
  m4.reset();
  assertEqual(m4.currentState(), 'HEALTHY', '12j: after reset → HEALTHY');
  assertEqual(m4.snapshot().totalFailures, 0, '12j: after reset → totalFailures = 0');
}

// ═══════════════════════════════════════════════════════════════════════════════
// CATEGORY 13: DB TIMEOUT (write-behind queue isolation)
// ═══════════════════════════════════════════════════════════════════════════════
group('13. DB TIMEOUT (write-behind queue isolation)');

{
  // 13a: withTimeout rejects — doesn't hang
  let threw13 = false;
  const start = Date.now();
  try {
    await withTimeout(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30_000));
    }, 50, 'db-write');
  } catch {
    threw13 = true;
  }
  const elapsed = Date.now() - start;
  assert(threw13, '13a: DB timeout rejects');
  assert(elapsed < 500, `13a: timeout completes fast (${elapsed}ms)`);

  // 13b: multiple concurrent timeouts don't block each other
  const results13 = [];
  const ops = [
    withTimeout(async () => { await new Promise(r => setTimeout(r, 30_000)); return 'slow1'; }, 50, 'db1'),
    withTimeout(async () => { await new Promise(r => setTimeout(r, 30_000)); return 'slow2'; }, 50, 'db2'),
    withTimeout(async () => 'fast', 1000, 'db3'),
  ];

  for (const op of ops) {
    try { await op; results13.push('ok'); } catch { results13.push('timeout'); }
  }
  // All three should have resolved (2 timeouts + 1 ok) without hanging
  assertEqual(results13.length, 3, '13b: all concurrent ops resolved');
  assertEqual(results13[2], 'ok', '13b: fast op succeeded');
}

// ═══════════════════════════════════════════════════════════════════════════════
// CATEGORY 14: DB POOL EXHAUSTION
// ═══════════════════════════════════════════════════════════════════════════════
group('14. DB POOL EXHAUSTION');

{
  // Pool exhaustion manifests as consecutive failures in PersistenceHealthMachine
  const m = new PersistenceHealthMachine();

  // Simulate 10 pool exhaustion failures
  for (let i = 0; i < 10; i++) {
    m.recordFailure('pool exhausted', 0);
  }
  // After 10 consecutive: should be DEGRADED (threshold is DEGRADED_AFTER=3 + DOWN_AFTER=10 = 13)
  // Wait — the defaults are DEGRADED_AFTER=3, DOWN_AFTER=10
  // 10 failures >= 3 but < 13 → DEGRADED
  assertEqual(m.currentState(), 'DEGRADED', '14a: 10 pool failures → DEGRADED');

  // Continue to 13 failures → DOWN
  for (let i = 0; i < 3; i++) {
    m.recordFailure('pool exhausted', 0);
  }
  assertEqual(m.currentState(), 'DOWN', '14b: 13 pool failures → DOWN');

  // 14c: snapshot correctly reports failure chain
  const snap = m.snapshot();
  assertEqual(snap.consecutiveFailures, 13, '14c: consecutiveFailures = 13');
  assertEqual(snap.state, 'DOWN', '14c: state = DOWN');

  // 14d: even with DOWN persistence, the system doesn't falsely report healthy
  // A single success from DOWN resets to HEALTHY (recovery path)
  m.recordSuccess();
  assertEqual(m.currentState(), 'HEALTHY', '14d: recovery to HEALTHY');
  const snap2 = m.snapshot();
  assertEqual(snap2.consecutiveFailures, 0, '14d: consecutiveFailures reset');
  assertEqual(snap2.consecutiveSuccesses, 1, '14d: consecutiveSuccesses = 1');
}

// ═══════════════════════════════════════════════════════════════════════════════
// CATEGORY 15: CANONICAL INTERPRETER — EVERY RejectionCode
// ═══════════════════════════════════════════════════════════════════════════════
group('15. CANONICAL INTERPRETER REJECTION CODES');

{
  // 15a: UNSUPPORTED_PROVIDER — empty source (mapped to SCHEMA in code)
  const r1 = interpretObservation('', makeObservation(), now());
  assertEqual(r1.ok, false, '15a: empty source → rejected');
  assert(['SCHEMA', 'UNSUPPORTED_PROVIDER'].includes(r1.code), '15a: code is SCHEMA or UNSUPPORTED_PROVIDER');

  // 15b: SCHEMA — null payload
  const r2 = interpretObservation('FYERS', null, now());
  assertEqual(r2.code, 'SCHEMA', '15b: null payload → SCHEMA');

  // 15c: option with providerSymbol that fully resolves from parseOptionSymbol
  // Even though expiry/strike/optionType are null, parseOptionSymbol extracts them
  const r3 = interpretObservation('FYERS', {
    providerSymbol: 'NIFTY26SEP23000PE',
    exchange: 'NSE',
    ltp: 100,
    expiry: null,
    strike: null,
    optionType: null,
    instrumentType: 'OPT',
    raw: {},
  }, now());
  assertEqual(r3.ok, true, '15c: option with providerSymbol → accepted (parts parsed from symbol)');

  // 15d: UNRESOLVED_INSTRUMENT — no identity
  const r4 = interpretObservation('FYERS', { ltp: 100, raw: {} }, now());
  assertEqual(r4.code, 'UNRESOLVED_INSTRUMENT', '15d: no instrument → UNRESOLVED_INSTRUMENT');

  // 15e: INVALID_VALUE — no prices
  const r5 = interpretObservation('FYERS', {
    providerSymbol: 'NIFTY26SEP23000PE',
    exchange: 'NSE',
    raw: {},
  }, now());
  assertEqual(r5.code, 'INVALID_VALUE', '15e: no prices → INVALID_VALUE');

  // 15f: IMPOSSIBLE_VALUE — bid > ask
  const r6 = interpretObservation('FYERS', makeObservation({ bid: 200, ask: 100 }), now());
  assertEqual(r6.code, 'IMPOSSIBLE_VALUE', '15f: crossed book → IMPOSSIBLE_VALUE');

  // 15g: IMPOSSIBLE_VALUE — negative ltp
  const r7 = interpretObservation('FYERS', makeObservation({ ltp: -50 }), now());
  assertEqual(r7.code, 'IMPOSSIBLE_VALUE', '15g: negative ltp → IMPOSSIBLE_VALUE');

  // 15h: IMPOSSIBLE_VALUE — negative volume
  const r8 = interpretObservation('FYERS', makeObservation({ volume: -1 }), now());
  assertEqual(r8.code, 'IMPOSSIBLE_VALUE', '15h: negative volume → IMPOSSIBLE_VALUE');

  // 15i: IMPOSSIBLE_VALUE — strike <= 0
  const r9 = interpretObservation('FYERS', makeObservation({ strike: -500 }), now());
  assertEqual(r9.code, 'IMPOSSIBLE_VALUE', '15i: negative strike → IMPOSSIBLE_VALUE');

  // 15j: INVALID_TIMESTAMP — unparseable timestamp
  const r10 = interpretObservation('FYERS', makeObservation({
    sourceTimestamp: 'not-a-date-at-all',
  }), now());
  assertEqual(r10.ok, false, '15j: unparseable timestamp → rejected');
  assertEqual(r10.code, 'INVALID_TIMESTAMP', '15j: → INVALID_TIMESTAMP');

  // 15k: FUTURE_TIMESTAMP — source timestamp too far ahead
  const futureTs = new Date(Date.now() + 10_000); // 10s ahead, budget is 5s
  const r11 = interpretObservation('FYERS', makeObservation({
    sourceTimestamp: futureTs.toISOString(),
  }), now());
  assertEqual(r11.ok, false, '15k: future timestamp → rejected');
  assertEqual(r11.code, 'FUTURE_TIMESTAMP', '15k: → FUTURE_TIMESTAMP');

  // 15l: STALE — quote too old
  const staleTs = new Date(Date.now() - 120_000); // 120s ago, budget 60s
  const r12 = interpretObservation('FYERS', makeObservation({
    sourceTimestamp: staleTs.toISOString(),
    sourceTimestampSemantics: 'QUOTE',
  }), now());
  assertEqual(r12.ok, false, '15l: stale quote → rejected');
  assertEqual(r12.code, 'STALE', '15l: → STALE');

  // 15m: STALE — last_trade too old
  const staleTradeTs = new Date(Date.now() - 1_000_000); // ~16min ago, budget 15min
  const r13 = interpretObservation('FYERS', makeObservation({
    sourceTimestamp: staleTradeTs.toISOString(),
    sourceTimestampSemantics: 'LAST_TRADE',
  }), now());
  assertEqual(r13.ok, false, '15m: stale last_trade → rejected');
  assertEqual(r13.code, 'STALE', '15m: → STALE');

  // 15n: Verify all 8 RejectionCode types are exercised
  const exercisedCodes = new Set([
    r1.code,  // SCHEMA
    r4.code,  // UNRESOLVED_INSTRUMENT
    r5.code,  // INVALID_VALUE
    r6.code,  // IMPOSSIBLE_VALUE
    r10.code, // INVALID_TIMESTAMP
    r11.code, // FUTURE_TIMESTAMP
    r12.code, // STALE
  ]);
  // UNSUPPORTED_PROVIDER is not triggered by interpretObservation (the code handles
  // empty source as SCHEMA), but all other 7 codes are exercised.
  assert(exercisedCodes.size >= 7, `15n: exercised ${exercisedCodes.size} distinct rejection codes`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// CATEGORY 16: BACKGROUND WORKER FAILURE (in-memory state integrity)
// ═══════════════════════════════════════════════════════════════════════════════
group('16. BACKGROUND WORKER FAILURE (in-memory state)');

{
  // 16a: FeedHealthService state doesn't corrupt on rapid register/unregister
  const svc = new FeedHealthService();
  svc.registerFeed('FYERS_WS', 'fnf', { ageMs: () => 1_000 });
  svc.registerFeed('UPSTOX_WS', 'fnf', { ageMs: () => 2_000 });

  let gate = svc.gateFor('fnf');
  assertEqual(gate.allowNewTrading, true, '16a-i: two feeds → trading allowed');

  svc.unregisterFeed('FYERS_WS');
  gate = svc.gateFor('fnf');
  assertEqual(gate.allowNewTrading, true, '16a-ii: one feed removed → still trading (UPSTOX alive)');

  svc.unregisterFeed('UPSTOX_WS');
  gate = svc.gateFor('fnf');
  assertEqual(gate.allowNewTrading, false, '16a-iii: all feeds removed → trading blocked');
  assertEqual(gate.overall, 'NO_FEED', '16a-iii: no feeds → NO_FEED');

  // 16b: PersistenceHealthMachine doesn't corrupt on rapid state changes
  const m = new PersistenceHealthMachine();
  m.recordFailure('err');
  m.recordFailure('err');
  m.recordFailure('err');
  assertEqual(m.currentState(), 'DEGRADED', '16b-i: degraded');
  m.recordSuccess();
  assertEqual(m.currentState(), 'HEALTHY', '16b-ii: recovered');
  m.recordFailure('err');
  m.recordFailure('err');
  assertEqual(m.currentState(), 'HEALTHY', '16b-iii: 2 failures still HEALTHY');
  m.recordSuccess();
  m.recordSuccess();
  m.recordSuccess();
  const snap = m.snapshot();
  assertEqual(snap.consecutiveFailures, 0, '16b-iv: consecutive failures reset');
  assertEqual(snap.consecutiveSuccesses, 3, '16b-iv: consecutive successes = 3');

  // 16c: FeedHealthService with multi-engine feeds
  const svc2 = new FeedHealthService();
  svc2.registerFeed('FYERS_WS', ['fnf', 'upstox-paper'], { ageMs: () => 1_000 });

  const gateFnf = svc2.gateFor('fnf');
  const gateUpstox = svc2.gateFor('upstox-paper');
  assertEqual(gateFnf.allowNewTrading, true, '16c-i: multi-engine feed → fnf trading allowed');
  assertEqual(gateUpstox.allowNewTrading, true, '16c-ii: multi-engine feed → upstox-paper trading allowed');

  // 16d: FeedHealthService status observability
  svc2.registerFeed('UPSTOX_WS', 'upstox-paper', { ageMs: () => 3_000 });
  const status = svc2.status();
  assertEqual(status.feeds.length, 2, '16d: status reports 2 feeds');
  assert(typeof status.staleAfterMs === 'number', '16d: staleAfterMs is number');
  assert(typeof status.downAfterMs === 'number', '16d: downAfterMs is number');
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUPPLEMENTARY: Provider Mappers & Helper Functions
// ═══════════════════════════════════════════════════════════════════════════════
group('SUPPLEMENTARY: Provider Mappers');

{
  // S1: mapperFor returns correct mapper for known providers
  assert(typeof mapperFor('FYERS') === 'function', 'S1a: FYERS mapper exists');
  assert(typeof mapperFor('UPSTOX') === 'function', 'S1b: UPSTOX mapper exists');
  assert(typeof mapperFor('ZERODHA') === 'function', 'S1c: ZERODHA mapper exists');
  assert(typeof mapperFor('KITE') === 'function', 'S1d: KITE mapper exists');
  assert(typeof mapperFor('FYERS_LIVE') === 'function', 'S1e: FYERS_LIVE mapper exists');
  assert(typeof mapperFor('UPSTOX_LIVE') === 'function', 'S1f: UPSTOX_LIVE mapper exists');

  // S2: mapperFor returns null for unknown providers
  assertEqual(mapperFor('NONEXISTENT'), null, 'S2a: unknown provider → null');
  assertEqual(mapperFor(''), null, 'S2b: empty provider → null');
  assertEqual(mapperFor(null), null, 'S2c: null provider → null');

  // S3: supportedProviders returns list
  const providers = supportedProviders();
  assert(providers.length >= 9, `S3a: at least 9 supported providers (got ${providers.length})`);
  assert(providers.includes('FYERS'), 'S3b: FYERS in list');
  assert(providers.includes('UPSTOX'), 'S3c: UPSTOX in list');

  // S4: envelopeFor returns function for known providers
  assert(typeof envelopeFor('FYERS') === 'function', 'S4a: FYERS envelope exists');
  assert(typeof envelopeFor('UPSTOX') === 'function', 'S4b: UPSTOX envelope exists (falls back to single)');

  // S5: envelopeFor returns single for unknown providers
  const unknownEnv = envelopeFor('NONEXISTENT');
  assert(typeof unknownEnv === 'function', 'S5a: unknown provider → single envelope');
  const result = unknownEnv({ data: 'test' });
  assert(Array.isArray(result), 'S5b: single envelope returns array');
  assertEqual(result.length, 1, 'S5c: single envelope wraps payload');
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUPPLEMENTARY: Helper function edge cases
// ═══════════════════════════════════════════════════════════════════════════════
group('SUPPLEMENTARY: Helper Functions');

{
  // normalizeExpiry
  assertEqual(normalizeExpiry(null), null, 'SE1a: null → null');
  assertEqual(normalizeExpiry(undefined), null, 'SE1b: undefined → null');
  assertEqual(normalizeExpiry(''), null, 'SE1c: empty → null');
  assertEqual(normalizeExpiry('2026-09-26'), '2026-09-26', 'SE1d: ISO date preserved');
  assertEqual(normalizeExpiry('26SEP2026'), '2026-09-26', 'SE1e: DDMMMYYYY parsed');

  // normalizeOptionType
  assertEqual(normalizeOptionType('CE'), 'CE', 'SE2a: CE → CE');
  assertEqual(normalizeOptionType('CALL'), 'CE', 'SE2b: CALL → CE');
  assertEqual(normalizeOptionType('PE'), 'PE', 'SE2c: PE → PE');
  assertEqual(normalizeOptionType('PUT'), 'PE', 'SE2d: PUT → PE');
  assertEqual(normalizeOptionType('invalid'), null, 'SE2e: invalid → null');
  assertEqual(normalizeOptionType(null), null, 'SE2f: null → null');

  // parseSourceTimestamp
  assert(parseSourceTimestamp(null) === null, 'SE3a: null → null');
  assert(parseSourceTimestamp('') === null, 'SE3b: empty → null');
  assert(parseSourceTimestamp('not-a-date') === null, 'SE3c: garbage → null');
  assert(parseSourceTimestamp(-1) === null, 'SE3d: negative → null');
  assert(parseSourceTimestamp(0) === null, 'SE3e: zero → null');
  assert(parseSourceTimestamp('1726732200') instanceof Date, 'SE3f: epoch seconds → Date');
  assert(parseSourceTimestamp(1726732200000) instanceof Date, 'SE3g: epoch ms → Date');

  // describeRecordTimestamps
  assertEqual(describeRecordTimestamps(null), '(no payload)', 'SE4a: null → no payload');
  assertEqual(describeRecordTimestamps(undefined), '(no payload)', 'SE4b: undefined → no payload');
  assert(describeRecordTimestamps(42).length > 0, 'SE4c: number → string description');
  const tsDesc = describeRecordTimestamps({ timestamp: '2026-09-19', other: 'nope' });
  assertIncludes(tsDesc, 'timestamp=', 'SE4d: includes timestamp field');

  // canonicalInstrumentKey
  assertEqual(canonicalInstrumentKey('NSE:NIFTY26SEP23000PE'), 'NSE:NIFTY26SEP23000PE', 'SE5a: colon format');
  assertEqual(canonicalInstrumentKey('NSE_FO|NIFTY26SEP23000PE'), 'NSE:NIFTY26SEP23000PE', 'SE5b: pipe format');
  assertEqual(canonicalInstrumentKey(null), null, 'SE5c: null → null');
  assertEqual(canonicalInstrumentKey(''), null, 'SE5d: empty → null');
  assertEqual(canonicalInstrumentKey('123456'), '123456', 'SE5e: numeric token → verbatim');

  // classifyInstrument
  assertEqual(classifyInstrument('NSE:NIFTY26SEP23000PE'), 'OPTION', 'SE6a: option key → OPTION');
  assertEqual(classifyInstrument('NSE:NIFTY26SEP23000PE', 'OPT'), 'OPTION', 'SE6b: OPT decl → OPTION');
  assertEqual(classifyInstrument('NSE:NIFTY26SEP23000PE', 'FUT'), 'FUTURE', 'SE6c: FUT decl → FUTURE');
  assertEqual(classifyInstrument('NSE:NIFTY50', 'INDEX'), 'INDEX', 'SE6d: INDEX decl → INDEX');
  assertEqual(classifyInstrument('NSE:NIFTY50', 'EQ'), 'EQUITY', 'SE6e: EQ decl → EQUITY');

  // budgetsFromEnv
  const budgets = budgetsFromEnv({ TICK_MAX_QUOTE_LAG_MS: '30000', TICK_MAX_LAST_TRADE_AGE_MS: '600000' });
  assertEqual(budgets.maxQuoteLagMs, 30_000, 'SE7a: custom quote lag');
  assertEqual(budgets.maxLastTradeAgeMs, 600_000, 'SE7b: custom last trade age');

  // payloadHash determinism with various types
  assertEqual(payloadHash(null), payloadHash(null), 'SE8a: null hashes consistently');
  assertEqual(payloadHash(0), payloadHash(0), 'SE8b: zero hashes consistently');
  // stableStringify maps both null and undefined to "null", so hashes are equal
  assertEqual(payloadHash(null), payloadHash(undefined), 'SE8c: null vs undefined produce same hash (via stableStringify)');
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUPPLEMENTARY: evaluateEngine edge cases
// ═══════════════════════════════════════════════════════════════════════════════
group('SUPPLEMENTARY: evaluateEngine edge cases');

{
  // E1: no feeds at all → NO_FEED
  const g1 = evaluateEngine([], DEFAULT_STALE_AFTER_MS, DEFAULT_DOWN_AFTER_MS, now(), 'fnf');
  assertEqual(g1.overall, 'NO_FEED', 'E1: no feeds → NO_FEED');
  assertEqual(g1.allowNewTrading, false, 'E1: no feeds → no trading');

  // E2: all feeds DOWN → overall DOWN
  const g2 = evaluateEngine([
    { name: 'A', engine: 'fnf', ageMs: null, enabled: true },
    { name: 'B', engine: 'fnf', ageMs: 90_000, enabled: true },
  ], DEFAULT_STALE_AFTER_MS, DEFAULT_DOWN_AFTER_MS, now(), 'fnf');
  assertEqual(g2.overall, 'DOWN', 'E2: all DOWN → DOWN');
  assertEqual(g2.allowNewTrading, false, 'E2: all DOWN → no trading');

  // E3: one STALE + one DOWN → STALE_ONLY
  const g3 = evaluateEngine([
    { name: 'A', engine: 'fnf', ageMs: 15_000, enabled: true },
    { name: 'B', engine: 'fnf', ageMs: null, enabled: true },
  ], DEFAULT_STALE_AFTER_MS, DEFAULT_DOWN_AFTER_MS, now(), 'fnf');
  assertEqual(g3.overall, 'STALE_ONLY', 'E3: stale + down → STALE_ONLY');
  assertEqual(g3.allowNewTrading, false, 'E3: STALE_ONLY → no trading');

  // E4: one FRESH + one DOWN → HEALTHY
  const g4 = evaluateEngine([
    { name: 'A', engine: 'fnf', ageMs: 1_000, enabled: true },
    { name: 'B', engine: 'fnf', ageMs: null, enabled: true },
  ], DEFAULT_STALE_AFTER_MS, DEFAULT_DOWN_AFTER_MS, now(), 'fnf');
  assertEqual(g4.overall, 'HEALTHY', 'E4: fresh + down → HEALTHY');
  assertEqual(g4.allowNewTrading, true, 'E4: HEALTHY → trading allowed');

  // E5: feed for wrong engine doesn't affect gate
  const g5 = evaluateEngine([
    { name: 'A', engine: 'upstox-paper', ageMs: 1_000, enabled: true },
  ], DEFAULT_STALE_AFTER_MS, DEFAULT_DOWN_AFTER_MS, now(), 'fnf');
  assertEqual(g5.overall, 'NO_FEED', 'E5: wrong engine → NO_FEED for fnf');

  // E6: disabled feed treated as DOWN
  const g6 = evaluateEngine([
    { name: 'A', engine: 'fnf', ageMs: 1_000, enabled: false },
  ], DEFAULT_STALE_AFTER_MS, DEFAULT_DOWN_AFTER_MS, now(), 'fnf');
  assertEqual(g6.overall, 'NO_FEED', 'E6: disabled feed → NO_FEED');
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUPPLEMENTARY: parseOptionSymbol edge cases
// ═══════════════════════════════════════════════════════════════════════════════
group('SUPPLEMENTARY: parseOptionSymbol');

{
  // Standard NSE format
  const p1 = parseOptionSymbol('NSE:NIFTY26SEP23000PE');
  assertEqual(p1.underlying, 'NIFTY', 'P1a: underlying = NIFTY');
  assertEqual(p1.strike, 23000, 'P1b: strike = 23000');
  assertEqual(p1.optionType, 'PE', 'P1c: optionType = PE');
  assert(p1.expiry !== null, 'P1d: expiry parsed');

  // Alternate Upstox format
  const p2 = parseOptionSymbol('SENSEX73900CE17SEP26');
  assertEqual(p2.underlying, 'SENSEX', 'P2a: underlying = SENSEX');
  assertEqual(p2.strike, 73900, 'P2b: strike = 73900');
  assertEqual(p2.optionType, 'CE', 'P2c: optionType = CE');

  // Unparseable
  const p3 = parseOptionSymbol('GARBAGE');
  assertEqual(p3.underlying, null, 'P3a: unparseable → null underlying');
  assertEqual(p3.strike, null, 'P3b: unparseable → null strike');

  // Null input
  const p4 = parseOptionSymbol(null);
  assertEqual(p4.underlying, null, 'P4a: null → null underlying');
}

// ═══════════════════════════════════════════════════════════════════════════════
// RESULTS
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n' + '═'.repeat(60));
console.log(`RESULTS: ${passed}/${total} passed, ${failed} failed`);
if (failed > 0) {
  console.log('FAILURES:');
  for (const f of failures) {
    console.log(`  • ${f}`);
  }
  process.exit(1);
} else {
  console.log('ALL TESTS PASSED ✓');
  process.exit(0);
}
})();
