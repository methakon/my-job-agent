#!/usr/bin/env node
/**
 * Deterministic canonical row id (approved prerequisite for replay-safe batch persistence).
 *
 * Operator decision (2026-09-12): "Implement the deterministic canonical ID prerequisite first.
 * No DDL/schema migration. It must make batch persistence replay-safe and prevent duplicate
 * economic ticks."
 *
 * Sections:
 *   [A] determinism + normalisation (instants agree, order does not matter)
 *   [B] distinctness: price / contract / source / timestamp differences produce different ids
 *   [C] duplicate ECONOMIC tick -> identical id (this is what makes replay safe)
 *   [D] provenance: FYERS and UPSTOX copies stay distinct rows
 *   [E] refusals: a weak identity returns null instead of a guessable id
 *   [F] no-DDL shape: v5 uuid, fits the existing varchar(36) PK, collision sanity
 *   [G] purity + writer wiring (the per-process sequence counter is NOT part of identity)
 */
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const R = require(path.join(REPO, 'dist', 'trading', 'unified-market-data', 'canonical-row-id'));

let passed = 0, failed = 0;
const ok = (name, cond, extra) => {
  if (cond) { passed += 1; console.log(`  PASS ${name}`); }
  else { failed += 1; console.log(`  FAIL ${name}${extra !== undefined ? ` :: ${extra}` : ''}`); }
};
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

const TS = new Date('2026-09-11T10:15:30.000Z');
const base = {
  source: 'FYERS',
  instrumentKey: 'NSE:NIFTY26SEP23000PE',
  sourceTimestamp: TS,
  content: { ltp: 75.15, bid: 75.0, ask: 75.3, volume: 1200, oi: 45000 },
};

console.log('\n[A] determinism and normalisation');
{
  const a = R.canonicalRowId(base);
  const b = R.canonicalRowId({ ...base });
  eq('the same identity produces the same id', a, b);
  eq('...and the id is stable across repeated calls', [a, a, a].every((x) => x === a), true);
  eq('an identical instant given as a Date and as an ISO string agree', R.canonicalRowId({ ...base, sourceTimestamp: TS.toISOString() }), a);
  eq('identity is order-independent (content key order does not matter)', R.canonicalRowId({ ...base, content: { oi: 45000, volume: 1200, ask: 75.3, bid: 75.0, ltp: 75.15 } }), a);
  eq('case/whitespace normalisation: source and key are folded', R.canonicalRowId({ ...base, source: ' fyers ', instrumentKey: ' nse:nifty26sep23000pe ' }), a);
  ok('the tuple is exposed for audit', typeof R.canonicalRowIdSource(base) === 'string' && R.canonicalRowIdSource(base).startsWith('rowid-v1|FYERS|NSE:NIFTY26SEP23000PE|'));
}

console.log('\n[B] distinctness — different economic facts must not collide');
{
  const a = R.canonicalRowId(base);
  ok('a different price is a different id', R.canonicalRowId({ ...base, content: { ...base.content, ltp: 75.2 } }) !== a);
  ok('a different bid is a different id', R.canonicalRowId({ ...base, content: { ...base.content, bid: 75.05 } }) !== a);
  ok('a different contract is a different id', R.canonicalRowId({ ...base, instrumentKey: 'NSE:NIFTY26SEP23100PE' }) !== a);
  ok('a different second is a different id', R.canonicalRowId({ ...base, sourceTimestamp: new Date(TS.getTime() + 1000) }) !== a);
  ok('a different expiry is a different id', R.canonicalRowId({ ...base, instrumentKey: 'NSE:NIFTY26OCT23000PE' }) !== a);
  ok('a different source is a different id (provenance preserved)', R.canonicalRowId({ ...base, source: 'UPSTOX' }) !== a);
  ok('an intra-second difference is a different id (ms precision kept)', R.canonicalRowId({ ...base, sourceTimestamp: new Date(TS.getTime() + 250) }) !== a);
}

console.log('\n[C] duplicate ECONOMIC tick collapses to one id (replay safety)');
{
  const first = R.canonicalRowId(base);
  const replay = R.canonicalRowId({ ...base, providerPayloadHash: undefined });
  eq('the same tick persisted twice yields ONE primary key', first, replay);
  const withHash = R.canonicalRowId({ ...base, providerPayloadHash: 'A1B2C3' });
  eq('a provider payload hash is folded (case-insensitively) and deterministic', withHash, R.canonicalRowId({ ...base, providerPayloadHash: 'a1b2c3' }));
  ok('the payload hash participates in identity', withHash !== first);
}

console.log('\n[D] refusals — a weak identity must not mint a guessable id');
{
  eq('no source -> null', R.canonicalRowId({ ...base, source: '' }), null);
  eq('no instrument key -> null', R.canonicalRowId({ ...base, instrumentKey: '' }), null);
  eq('no economic content and no payload hash -> null', R.canonicalRowId({ ...base, content: {}, providerPayloadHash: null }), null);
  eq('content present but all non-finite -> null', R.canonicalRowId({ ...base, content: { ltp: NaN, bid: Infinity, ask: null } }), null);
  eq('no timestamp and no payload hash -> null', R.canonicalRowId({ ...base, sourceTimestamp: null, content: { ltp: 1 } }), null);
  ok('a payload hash alone is enough (interpreter already identified it)', R.canonicalRowId({ ...base, sourceTimestamp: null, content: {}, providerPayloadHash: 'deadbeef' }) !== null);
  ok('non-finite content values are ignored, not stringified as "null"', R.canonicalRowId({ ...base, content: { ltp: 75.15, bid: NaN } }) === R.canonicalRowId({ ...base, content: { ltp: 75.15 } }));
}

console.log('\n[E] no-DDL shape and collision sanity');
{
  const id = R.canonicalRowId(base);
  eq('the id is 36 characters (fits the existing varchar(36) PK)', id.length, 36);
  ok('it is a v5 uuid (version nibble + RFC variant)', R.CANONICAL_ROW_ID_RE.test(id), id);
  ok('isDeterministicRowId accepts it', R.isDeterministicRowId(id) === true);
  ok('...and rejects a random v4 uuid', R.isDeterministicRowId('9f8e7d6c-1a2b-4c3d-8e4f-5a6b7c8d9e0f') === false);
  const seen = new Map();
  let collisions = 0;
  for (let i = 0; i < 20000; i += 1) {
    const v = R.canonicalRowId({ ...base, sourceTimestamp: new Date(TS.getTime() + i), content: { ...base.content, ltp: 75.15 + i / 1000 } });
    if (seen.has(v)) collisions += 1; else seen.set(v, i);
  }
  eq('20,000 distinct ticks produce 20,000 distinct ids', [seen.size, collisions], [20000, 0]);
  eq('the namespace and version are pinned constants', [R.CANONICAL_ROW_ID_NAMESPACE.length, R.CANONICAL_ROW_ID_VERSION], [36, 'rowid-v1']);
}

console.log('\n[F] purity and writer wiring');
{
  const src = fs.readFileSync(path.join(REPO, 'src', 'trading', 'unified-market-data', 'canonical-row-id.ts'), 'utf8');
  // strip prose first: comments legitimately mention the words we are scanning for
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  ok('no clock read (instants are passed in)', !/Date\.now\(\)|new Date\(/.test(code));
  ok('no randomness (uuid v4 would break replay safety)', !/v4|randomUUID|Math\.random/.test(code));
  ok('no DB or network access', !/mysql|redis|fetch\(|axios|http\./i.test(code));
  ok('no AI/model client', !/openai|anthropic|bedrock|\bgpt-|claude/i.test(code));
  ok('the per-process sequence counter is NOT part of the identity', !/sequenceNumber/.test(code));

  const writer = fs.readFileSync(path.join(REPO, 'src', 'trading', 'unified-market-data', 'unified-market-data.service.ts'), 'utf8');
  eq('the canonical writer derives ids for BOTH quotes and snapshots', (writer.match(/id: canonicalRowId\(\{/g) || []).length, 2);
  ok('the writer passes no sequence counter into the identity', !/canonicalRowId\(\{[\s\S]{0,400}sequenceNumber/.test(writer));
  ok('...and a weak identity still falls back to the generator (?? undefined)', (writer.match(/\}\) \?\? undefined,/g) || []).length === 2);
}

console.log(`\ncanonical-row-id: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
