#!/usr/bin/env node
/**
 * Feed-arbitration tests (brief s2/s6): one ACTIVE producer per universe, and a
 * regression guard for the universe-parsing bug that made a desk register zero
 * universes and stand down against nobody (it stopped polling its own feed).
 */
const assert = require('assert');
const A = require('../dist/trading/unified-market-data/feed-arbitration.state');

const OPTIONS = { staleAfterMs: 10_000, downAfterMs: 60_000, mode: 'universe' };
/** decideOwnership(universes, feeds, options) — universes are what we ask about. */
const decide = (feeds, universes) => A.decideOwnership(universes, feeds, OPTIONS);
const feed = (over) => ({
  name: 'F', priority: 1, enabled: true, credentialsOk: true, universes: [], ageMs: 1_000, ...over,
});
let pass = 0;
const ok = (label) => { pass++; console.log(`  ${pass} ${label} ok`); };

console.log('feed-arbitration tests\n');

// ── 1. Universe parsing accepts BOTH config shapes ──────────────────────────
{
  assert.deepEqual(A.trackedUniversesFromSymbols(['BSE_INDEX|SENSEX']), ['SENSEX'],
    'an index key must yield a trackable universe');
  assert.deepEqual(A.trackedUniversesFromSymbols(['NIFTY26SEP23900CE']), ['NIFTY'],
    'an option contract key must yield its underlying');
  assert.deepEqual(A.trackedUniversesFromSymbols(['BSE_INDEX|SENSEX', 'NIFTY26SEP23900CE', 'NSE_INDEX|Nifty 50']),
    ['NIFTY', 'NIFTY50', 'SENSEX'], 'both shapes mix and sort');
  // The strict parser stays strict: an index snapshot is NOT option coverage.
  assert.deepEqual(A.optionUniversesFromSymbols(['BSE_INDEX|SENSEX']), []);
  assert.deepEqual(A.trackedUniversesFromSymbols([]), []);
  assert.deepEqual(A.trackedUniversesFromSymbols(['', '  ']), []);
  ok('universe parsing (index + contract keys)');
}

// ── 2. A sole candidate owns its universe (no starvation) ───────────────────
{
  const decisions = decide([feed({ name: 'UPSTOX_REST', universes: ['SENSEX'] })], ['SENSEX']);
  const sensex = decisions.find((d) => d.universe === 'SENSEX');
  assert.ok(sensex, 'the universe appears in the decisions');
  assert.equal(sensex.owner, 'UPSTOX_REST');
  assert.deepEqual(A.ownedUniverses('UPSTOX_REST', ['SENSEX'], decisions), ['SENSEX']);
  ok('sole producer owns its universe');
}

// ── 3. Priority decides when two feeds overlap ──────────────────────────────
{
  const decisions = decide([
    feed({ name: 'FYERS_WS', priority: 0, universes: ['NIFTY', 'BANKNIFTY'] }),
    feed({ name: 'UPSTOX_REST', priority: 1, universes: ['NIFTY', 'BANKNIFTY'] }),
  ], ['NIFTY', 'BANKNIFTY']);
  for (const d of decisions) {
    assert.equal(d.owner, 'FYERS_WS', `${d.universe} goes to the primary`);
    assert.deepEqual(d.standby, ['UPSTOX_REST']);
  }
  assert.deepEqual(A.ownedUniverses('UPSTOX_REST', ['NIFTY'], decisions), [], 'the standby owns nothing');
  assert.equal(A.mayProduce('UPSTOX_REST', ['NIFTY'], decisions), false);
  assert.equal(A.mayProduce('FYERS_WS', ['NIFTY'], decisions), true);
  ok('priority decides overlapping universes');
}

// ── 4. Non-overlapping universes: BOTH stay active ───────────────────────────
{
  const decisions = decide([
    feed({ name: 'FYERS_WS', priority: 0, universes: ['NIFTY', 'BANKNIFTY'] }),
    feed({ name: 'UPSTOX_REST', priority: 1, universes: ['SENSEX'] }),
  ], ['NIFTY', 'BANKNIFTY', 'SENSEX']);
  assert.deepEqual(A.ownedUniverses('FYERS_WS', ['NIFTY', 'BANKNIFTY', 'SENSEX'], decisions), ['BANKNIFTY', 'NIFTY']);
  assert.deepEqual(A.ownedUniverses('UPSTOX_REST', ['NIFTY', 'SENSEX'], decisions), ['SENSEX'],
    'the secondary keeps the universe the primary cannot price');
  ok('per-universe ownership, not a global winner-takes-all');
}

// ── 5. A dead primary yields the universe to the standby ────────────────────
{
  const decisions = decide([
    feed({ name: 'FYERS_WS', priority: 0, universes: ['NIFTY'], ageMs: 10 * 60_000 }),
    feed({ name: 'UPSTOX_REST', priority: 1, universes: ['NIFTY'], ageMs: 1_000 }),
  ], ['NIFTY']);
  assert.equal(decisions.find((d) => d.universe === 'NIFTY').owner, 'UPSTOX_REST',
    'a DOWN primary must not keep ownership');
  ok('failover from a dead primary');
}

// ── 6. A disabled / credential-less feed is never elected ──────────────────
{
  const decisions = decide([
    feed({ name: 'FYERS_WS', priority: 0, enabled: false, universes: ['NIFTY'] }),
    feed({ name: 'UPSTOX_REST', priority: 1, credentialsOk: false, universes: ['NIFTY'] }),
  ], ['NIFTY']);
  const nifty = decisions.find((d) => d.universe === 'NIFTY');
  assert.equal(nifty.owner, null, 'no eligible producer → pause rather than duplicate');
  assert.ok(nifty.reason.length > 0, 'the pause explains itself');
  assert.deepEqual(A.unownedUniverses(decisions), ['NIFTY']);
  ok('ineligible feeds are never elected');
}

// ── 7. Same priority resolves deterministically ────────────────────────────
{
  const to = (names) => decide(names.map((n) => feed({ name: n, universes: ['NIFTY'] })), ['NIFTY'])
    .find((d) => d.universe === 'NIFTY').owner;
  const first = to(['ZB_FEED', 'AA_FEED']);
  const second = to(['AA_FEED', 'ZB_FEED']);
  assert.equal(first, second, 'input order must not change the owner');
  assert.equal(first, 'AA_FEED', 'ties resolve by name');
  ok('deterministic tie-break');
}

// ── 8. The wildcard feed covers everything, and only one feed produces ─────
{
  const decisions = decide([
    feed({ name: 'FYERS_WS', priority: 0, universes: [A.ANY_UNIVERSE] }),
    feed({ name: 'UPSTOX_REST', priority: 1, universes: ['SENSEX'] }),
  ], ['SENSEX']);
  const producers = decisions.filter((d) => d.owner).map((d) => d.owner);
  assert.deepEqual(producers, ['FYERS_WS'], 'one active producer for the covered universe');
  ok('wildcard coverage + single active producer');
}

console.log('feed-arbitration tests passed');
