#!/usr/bin/env node
/**
 * Common-feed source selection + read-path failover tests (brief s2/s4/s6/s12).
 *
 * What must hold:
 *  1. ONE active producer per instrument universe — two feeds never price the
 *     same instrument, and neither desk is starved of a universe it alone covers.
 *  2. FYERS' arbiter coverage is OPTION-ONLY: its SENSEX *index* subscription
 *     must not claim the SENSEX *option* universe (that would hand the universe
 *     to the primary and stop the desk that actually polls it).
 *  3. A producer that goes DOWN fails over to the standby and fails back when it
 *     recovers; no eligible producer means "pause", never a duplicate price.
 *  4. The FnF engine's chain read consumes the COMMON store when its own feed has
 *     nothing fresh, keeps per-row provenance, resolves a foreign instrument key
 *     to THIS desk's registered contract symbol, and never lets an OLDER shared
 *     observation displace a NEWER local one.
 */
const assert = require('assert');
const A = require('../dist/trading/unified-market-data/feed-arbitration.state');
const {
  FnfOptionChainService,
  sharedQuoteToChainRow,
  symbolKey,
  contractMatchKey,
} = require('../dist/trading/fnf-option-chain.service');

const OPTIONS = { staleAfterMs: 10_000, downAfterMs: 60_000, mode: 'universe' };
const feed = (over) => ({
  name: 'F', priority: 1, enabled: true, credentialsOk: true, universes: [], ageMs: 1_000, ...over,
});

let pass = 0;
const ok = (label) => { pass++; console.log(`  ${pass} ${label} ok`); };

const FYERS_SYMBOLS = [
  'NSE:NIFTY50-INDEX', 'NSE:NIFTYBANK-INDEX', 'NSE:SENSEX-INDEX',
  'NSE:NIFTY26SEP23900CE', 'NSE:BANKNIFTY26SEP58500CE',
];

const now = () => Date.now();
const chainRow = (over = {}) => ({
  id: 'local-1', contractSymbol: 'NSE:NIFTY26SEP23900CE', underlying: 'NIFTY', expiry: '2026-09-26',
  strike: 23900, optionType: 'CE', ltp: 100, bid: 99.95, ask: 100.05, volume: 5, openInterest: 7,
  impliedVolatility: null, delta: null, gamma: null, theta: null, vega: null, provider: 'fyers',
  ts: new Date(now() - 120_000), ...over,
});
const sharedRow = (instrumentKey, ltp, ageMs, over = {}) => ({
  instrumentKey, underlying: 'NIFTY', expiry: '2026-09-26', strike: 23900, optionType: 'CE',
  ltp, bid: ltp - 0.05, ask: ltp + 0.05, oi: 111, iv: 0.21, volume: 12,
  source: 'UPSTOX_LIVE', receivedTimestamp: new Date(now() - ageMs), ts: new Date(now() - ageMs),
  dataQuality: 'GOOD', ...over,
});

const REGISTERED = [
  { symbol: 'NSE:NIFTY26SEP23900CE', underlying: 'NIFTY', expiry: '2026-09-26', strike: 23900, optionType: 'CE' },
  { symbol: 'NSE:NIFTY26SEP24000CE', underlying: 'NIFTY', expiry: '2026-09-26', strike: 24000, optionType: 'CE' },
];

/** Fake `this` for the private read-path method (compiled TS keeps it on the prototype). */
const chainCtx = (over = {}) => ({
  sharedFallbackEnabled: true,
  sharedFallbackAfterMs: 60_000,
  sharedFallbackMaxAgeMs: 60_000,
  contractsCache: { at: now(), rows: REGISTERED },
  contractsCacheMs: 300_000,
  sharedFallbackLogAt: now(),
  logger: { log: () => {}, warn: () => {} },
  registeredContracts: async () => REGISTERED,
  unified: { sharedQuotesForUnderlying: async () => [] },
  ...over,
});
const withSharedQuotes = FnfOptionChainService.prototype.withSharedQuotes;

async function main() {
  console.log('common-feed source selection + failover tests\n');

  // ── 1. FYERS arbitrated coverage is option-only ────────────────────────────
  {
    const universes = A.optionUniversesFromSymbols(FYERS_SYMBOLS);
    assert.deepEqual(universes, ['BANKNIFTY', 'NIFTY'],
      'index subscriptions must not become option coverage');
    assert.ok(!universes.includes('SENSEX'),
      'FYERS must NOT claim the SENSEX option universe it does not subscribe');
    ok('FYERS coverage = option underlyings only (SENSEX option universe left to Upstox)');
  }

  // ── 2. Complementary universes: both feeds ACTIVE, nobody starved ──────────
  {
    const feeds = [
      feed({ name: 'FYERS_WS', priority: 0, universes: ['NIFTY', 'BANKNIFTY'], ageMs: 1_000 }),
      feed({ name: 'UPSTOX_REST', priority: 1, universes: ['SENSEX'], ageMs: 2_000 }),
    ];
    const decisions = A.decideOwnership(['NIFTY', 'BANKNIFTY', 'SENSEX'], feeds, OPTIONS);
    const ownerOf = (u) => decisions.find((d) => d.universe === u)?.owner;
    assert.equal(ownerOf('NIFTY'), 'FYERS_WS');
    assert.equal(ownerOf('BANKNIFTY'), 'FYERS_WS');
    assert.equal(ownerOf('SENSEX'), 'UPSTOX_REST');
    assert.deepEqual(A.activeFeedNames(decisions), ['FYERS_WS', 'UPSTOX_REST']);
    assert.equal(A.unownedUniverses(decisions).length, 0);
    ok('both producers stay ACTIVE on their own instruments (no starvation either way)');
  }

  // ── 3. Failover when the primary goes DOWN, failback when it recovers ──────
  {
    const bothCoverNifty = (fyersAge) => [
      feed({ name: 'FYERS_WS', priority: 0, universes: ['NIFTY'], ageMs: fyersAge }),
      feed({ name: 'UPSTOX_REST', priority: 1, universes: ['NIFTY', 'SENSEX'], ageMs: 2_000 }),
    ];
    const down = A.decideOwnership(['NIFTY'], bothCoverNifty(null), OPTIONS)[0];
    assert.equal(down.owner, 'UPSTOX_REST', 'a DOWN primary must release the universe');
    assert.match(down.reason, /failed over/);
    assert.deepEqual(down.standby, ['FYERS_WS']);
    const downAge = A.decideOwnership(['NIFTY'], bothCoverNifty(600_000), OPTIONS)[0];
    assert.equal(downAge.owner, 'UPSTOX_REST', 'a primary 10 min silent is DOWN, not preferred');
    const back = A.decideOwnership(['NIFTY'], bothCoverNifty(1_000), OPTIONS)[0];
    assert.equal(back.owner, 'FYERS_WS', 'a recovered primary takes its universe back');
    assert.equal(A.mayProduce('UPSTOX_REST', ['NIFTY'], [back]), false,
      'the standby must not produce for a universe the primary owns');
    ok('DOWN primary → standby owns; recovery → controlled failback');
  }

  // ── 4. No eligible producer = pause, never a duplicated price ──────────────
  {
    const decisions = A.decideOwnership(['NIFTY'], [
      feed({ name: 'FYERS_WS', priority: 0, universes: ['NIFTY'], credentialsOk: false }),
      feed({ name: 'UPSTOX_REST', priority: 1, universes: ['NIFTY'], enabled: false }),
    ], OPTIONS);
    assert.equal(decisions[0].owner, null, 'no eligible feed → no owner');
    assert.match(decisions[0].reason, /no enabled feed covers/);
    ok('nobody eligible → owner null with a reason (pause, no invented prices)');
  }

  // ── 5. Key handling across producers ──────────────────────────────────────
  {
    assert.equal(symbolKey('NSE:NIFTY26SEP23900CE'), 'NIFTY26SEP23900CE');
    assert.equal(symbolKey('BSE_INDEX|SENSEX26SEP74000PE'), 'SENSEX26SEP74000PE');
    assert.equal(symbolKey('NSE_FO|44444'), '44444', 'a bare token key stays itself');
    assert.equal(symbolKey(''), '');
    assert.equal(contractMatchKey(REGISTERED[0]), 'NIFTY|2026-09-26|23900|CE');
    assert.equal(contractMatchKey({ underlying: 'NIFTY', expiry: '2026-09-26T05:30:00Z', strike: '23900.0000', optionType: 'ce' }),
      'NIFTY|2026-09-26|23900|CE', 'metadata matches across value shapes');
    assert.equal(contractMatchKey({ underlying: 'NIFTY' }), '', 'incomplete metadata is never matched');
    ok('instrument keys + contract metadata normalise across broker conventions');
  }

  // ── 6. Shared observation mapped into the chain shape, provenance intact ───
  {
    const row = sharedQuoteToChainRow(sharedRow('NSE:NIFTY26SEP23900CE', 123.45, 500), 'NSE:NIFTY26SEP23900CE');
    assert.equal(row.provider, 'UPSTOX_LIVE', 'the TRUE producer travels with the row');
    assert.equal(row.contractSymbol, 'NSE:NIFTY26SEP23900CE');
    assert.equal(row.ltp, 123.45);
    assert.equal(row.openInterest, 111, 'unified oi → chain openInterest');
    assert.equal(row.impliedVolatility, 0.21, 'unified iv → chain impliedVolatility');
    assert.equal(row.optionType, 'CE');
    const ts = new Date(row.ts).getTime();
    assert.ok(Math.abs(now() - 500 - ts) < 3_000, 'chain ts comes from the store receive time');
    const derived = sharedQuoteToChainRow(sharedRow('BSE_INDEX|SENSEX26SEP74000PE', 42, 500, { optionType: 'PE' }));
    assert.equal(derived.contractSymbol, 'SENSEX26SEP74000PE', 'symbol derived from the key tail');
    const nulls = sharedQuoteToChainRow({ instrumentKey: 'NSE:NIFTY26SEP23900CE', underlying: 'NIFTY', ltp: 10, source: 'UPSTOX_LIVE' }, 'NSE:NIFTY26SEP23900CE');
    assert.equal(nulls.bid, null, 'an absent bid stays absent — never fabricated');
    assert.equal(nulls.impliedVolatility, null);
    ok('shared row mapped with provenance + no invented values');
  }

  // ── 7. Local row wins unless the shared observation is strictly newer ──────
  {
    const ctx = chainCtx({ unified: { sharedQuotesForUnderlying: async () => [sharedRow('NSE:NIFTY26SEP23900CE', 120, 1_000)] } });
    const staleLocal = [chainRow({ ts: new Date(now() - 300_000) })];
    const superseded = await withSharedQuotes.call(ctx, staleLocal, { underlying: 'NIFTY', latestOnly: true, limit: 10 });
    assert.equal(superseded.length, 1);
    assert.equal(superseded[0].ltp, 120, 'a stale local quote is superseded by the live shared one');
    assert.equal(superseded[0].provider, 'UPSTOX_LIVE');

    const freshLocal = [chainRow({ ts: new Date(now() - 1_000), ltp: 101 })];
    const kept = await withSharedQuotes.call(ctx, freshLocal, { underlying: 'NIFTY', latestOnly: true, limit: 10 });
    assert.equal(kept[0].ltp, 101, 'our own fresh quote is NOT displaced by an older shared one');
    assert.equal(kept[0].provider, 'fyers');
    assert.equal(kept[0].id, 'local-1');
    ok('fresher wins; a local producer is never overwritten by older foreign data');
  }

  // ── 8. No query at all while the local feed is fresh (zero extra cost) ─────
  {
    let calls = 0;
    const ctx = chainCtx({ unified: { sharedQuotesForUnderlying: async () => { calls++; return []; } } });
    const rows = [chainRow({ ts: new Date(now() - 1_000) })];
    const same = await withSharedQuotes.call(ctx, rows, { underlying: 'NIFTY', latestOnly: true, limit: 10 });
    assert.equal(calls, 0, 'no shared read when the local producer is fresh');
    assert.equal(same, rows, 'the local array is returned untouched');
    ok('fresh local feed → no shared-store query at all');
  }

  // ── 9. Full failover, including a foreign (token) instrument key ──────────
  {
    const ctx = chainCtx({
      unified: {
        sharedQuotesForUnderlying: async () => [
          // Upstox-style token key: identity comes from metadata, not the key.
          sharedRow('NSE_FO|44444', 120, 1_000),
          sharedRow('NSE:NIFTY26SEP24000CE', 90, 1_000, { strike: 24000 }),
          // An instrument this desk does NOT trade must never be introduced.
          sharedRow('NSE_FO|55555', 70, 1_000, { strike: 25000 }),
        ],
      },
    });
    const served = await withSharedQuotes.call(ctx, [], { latestOnly: true, limit: 10 });
    assert.equal(served.length, 2, 'only registered instruments are introduced');
    const symbols = served.map((r) => r.contractSymbol).sort();
    assert.deepEqual(symbols, ['NSE:NIFTY26SEP23900CE', 'NSE:NIFTY26SEP24000CE'],
      'a foreign observation is presented under THIS desk\u2019s registered symbol');
    assert.ok(served.every((r) => r.provider === 'UPSTOX_LIVE'), 'provenance kept');
    const matched = served.find((r) => r.contractSymbol === 'NSE:NIFTY26SEP23900CE');
    assert.equal(matched.ltp, 120, 'token-key row matched by underlying/expiry/strike/right');

    const named = await withSharedQuotes.call(ctx, [], { symbol: 'NIFTY26SEP24000CE', latestOnly: true, limit: 10 });
    assert.equal(named.length, 1, 'a named-symbol read returns only that instrument');
    assert.equal(named[0].contractSymbol, 'NSE:NIFTY26SEP24000CE');
    ok('full failover fills registered contracts; foreign keys resolve; named reads stay narrow');
  }

  // ── 10. History reads and the kill switch are never touched ───────────────
  {
    let calls = 0;
    const ctx = chainCtx({ unified: { sharedQuotesForUnderlying: async () => { calls++; return []; } } });
    const rows = [chainRow()];
    const history = await withSharedQuotes.call(ctx, rows, { latestOnly: false, limit: 10 });
    assert.equal(history, rows, 'latest=false (history) reads stay local');
    const off = chainCtx({
      sharedFallbackEnabled: false,
      unified: { sharedQuotesForUnderlying: async () => { calls++; return []; } },
    });
    const offRows = await withSharedQuotes.call(off, rows, { underlying: 'NIFTY', latestOnly: true, limit: 10 });
    assert.equal(offRows, rows);
    assert.equal(calls, 0, 'FNO_SHARED_QUOTE_FALLBACK=false keeps the read path purely local');
    ok('history reads untouched; kill switch honoured');
  }

  // ── 11. Opt-in universe alias makes NIFTY a two-producer universe ─────────
  {
    const { parseUniverseMap, universeForInstrument } = require('../dist/trading/upstox-live-paper/upstox-live-paper.config');
    const map = parseUniverseMap('NSE_INDEX|Nifty 50=NIFTY');
    assert.deepEqual(map, { 'NSE_INDEX|Nifty 50': 'NIFTY' }, 'key -> universe alias parsed');
    assert.deepEqual(parseUniverseMap(''), {}, 'no env value = no aliases (behaviour unchanged)');
    assert.equal(universeForInstrument('NSE_INDEX|Nifty 50', map), 'NIFTY', 'alias wins over the derived label');
    assert.equal(universeForInstrument('NSE_INDEX|Nifty 50', {}), 'NIFTY50', 'without the map the derived label is unchanged');
    assert.equal(universeForInstrument('BSE_INDEX|SENSEX', map), 'SENSEX', 'unmapped keys are unaffected');
    // With the alias BOTH feeds cover NIFTY — the premise of an outage demo.
    const feeds = [
      feed({ name: 'FYERS_WS', priority: 0, universes: A.optionUniversesFromSymbols(FYERS_SYMBOLS), ageMs: 1_000 }),
      feed({ name: 'UPSTOX_REST', priority: 1, universes: ['SENSEX', universeForInstrument('NSE_INDEX|Nifty 50', map)], ageMs: 2_000 }),
    ];
    const normal = A.decideOwnership(['NIFTY', 'BANKNIFTY', 'SENSEX'], feeds, OPTIONS);
    assert.equal(normal.find((d) => d.universe === 'NIFTY').owner, 'FYERS_WS', 'primary owns NIFTY while healthy');
    assert.deepEqual(normal.find((d) => d.universe === 'NIFTY').standby, ['UPSTOX_REST']);
    assert.equal(normal.find((d) => d.universe === 'SENSEX').owner, 'UPSTOX_REST', 'SENSEX stays with its only producer');
    const during = feeds.map((f) => (f.name === 'FYERS_WS' ? { ...f, ageMs: null } : f));
    const outage = A.decideOwnership(['NIFTY'], during, OPTIONS)[0];
    assert.equal(outage.owner, 'UPSTOX_REST', 'a FYERS outage hands NIFTY to the standby');
    assert.deepEqual(outage.standby, ['FYERS_WS']);
    const recovered = A.decideOwnership(['NIFTY'], feeds, OPTIONS)[0];
    assert.equal(recovered.owner, 'FYERS_WS', 'and control returns when FYERS recovers');
    ok('opt-in universe alias gives NIFTY two producers (failover + failback become possible)');
  }

  console.log(`\n${pass} checks passed, 0 failed`);
}

main().catch((error) => {
  console.error(`\nFAILED: ${error.message}`);
  process.exit(1);
});
