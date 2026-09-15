#!/usr/bin/env node
/**
 * Row 877 — the paper desk's common-store chain source (the pure half).
 *
 * Proves: the desk's OWN rows win while fresh; a stale/empty own chain falls back to
 * the common store; a foreign row keeps its TRUE producer; ABSENCE IS PRESERVED
 * (a field the provider did not send stays null, never 0); and nothing is invented.
 *
 * [A] contract: version, closed reason vocabulary, spec
 * [B] source decision (all five reasons)
 * [C] unified row → chain row mapping, absence preserved, bad rows refused
 * [D] nearest expiry
 * [E] ATM legs / chain legs
 * [F] purity
 */
const fs = require('fs');
const path = require('path');
const REPO = path.join(__dirname, '..');

const M = require(path.join(REPO, 'dist', 'trading', 'upstox-live-paper', 'upstox-live-paper-common-chain'));
const SRC = path.join(REPO, 'src', 'trading', 'upstox-live-paper', 'upstox-live-paper-common-chain.ts');

let pass = 0;
const failures = [];
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; console.log(`  PASS ${name}`); }
  else { failures.push(name); console.log(`  FAIL ${name}${extra ? ' :: ' + extra : ''}`); }
};
const eq = (name, actual, expected) => ok(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`);

const row = (over = {}) => ({
  instrumentKey: 'BSE:SENSEX26SEP74200CE', underlying: 'SENSEX', expiry: '2026-09-26', strike: '74200.0000',
  optionType: 'CE', ltp: '1030.0000', bid: '985.0000', ask: '994.8000', bidQty: 75, askQty: 50,
  volume: null, oi: null, changeOi: null, iv: '11.02', delta: null, gamma: null, theta: null, vega: null,
  source: 'FYERS_LIVE', ts: '2026-09-15 10:43:40', receivedTimestamp: '2026-09-15 10:43:41', ...over,
});
const NOW = Date.parse('2026-09-15T11:00:00+05:30');

// ── [A] ─────────────────────────────────────────────────────────────────────
console.log('\n[A] contract');
{
  eq('version', M.COMMON_CHAIN_VERSION, 'commonchain-v1');
  eq('closed reason vocabulary', [...M.CHAIN_SOURCE_REASONS], ['OWN_FRESH', 'OWN_STALE_COMMON_FRESH', 'OWN_STALE_NO_COMMON', 'OWN_EMPTY_COMMON_FRESH', 'OWN_EMPTY_NO_COMMON']);
  eq('the spec documents every reason', M.COMMON_CHAIN_SPEC.reasons, [...M.CHAIN_SOURCE_REASONS]);
  eq('sources are pinned', [...M.CHAIN_SOURCES], ['OWN', 'COMMON', 'NONE']);
  ok('the spec states OWN precedence, absence and provenance', ['precedence', 'absence', 'provenance'].every((k) => typeof M.COMMON_CHAIN_SPEC[k] === 'string' && M.COMMON_CHAIN_SPEC[k].length > 0));
}

// ── [B] ─────────────────────────────────────────────────────────────────────
console.log('\n[B] source decision');
{
  const d = (o) => M.chainSourceDecision({ ownRows: 0, ownNewestTsMs: null, commonRows: 0, nowMs: NOW, maxAgeMs: 45_000, ...o });
  eq('fresh own chain wins', [d({ ownRows: 5, ownNewestTsMs: NOW - 1_000 }).source, d({ ownRows: 5, ownNewestTsMs: NOW - 1_000 }).reason], ['OWN', 'OWN_FRESH']);
  eq('stale own + fresh common ⇒ COMMON', [d({ ownRows: 5, ownNewestTsMs: NOW - 3 * 86_400_000, commonRows: 9 }).source, d({ ownRows: 5, ownNewestTsMs: NOW - 3 * 86_400_000, commonRows: 9 }).reason], ['COMMON', 'OWN_STALE_COMMON_FRESH']);
  eq('empty own + fresh common ⇒ COMMON', d({ ownRows: 0, commonRows: 9 }).reason, 'OWN_EMPTY_COMMON_FRESH');
  eq('stale own + no common ⇒ NONE', d({ ownRows: 5, ownNewestTsMs: NOW - 3 * 86_400_000 }).reason, 'OWN_STALE_NO_COMMON');
  eq('empty own + no common ⇒ NONE', d({}).reason, 'OWN_EMPTY_NO_COMMON');
  eq('an own row exactly at the budget boundary counts as fresh', d({ ownRows: 1, ownNewestTsMs: NOW - 45_000 }).source, 'OWN');
  eq('one ms past the boundary is not fresh', d({ ownRows: 1, ownNewestTsMs: NOW - 45_001, commonRows: 1 }).source, 'COMMON');
  const stale = d({ ownRows: 3, ownNewestTsMs: NOW - 60_000 });
  eq('the decision reports the measured own age', stale.ownAgeMs, 60_000);
}

// ── [C] ─────────────────────────────────────────────────────────────────────
console.log('\n[C] mapping and absence');
{
  const r = M.commonChainRowFromUnified(row());
  eq('the contract symbol is the key tail', r.contractSymbol, 'SENSEX26SEP74200CE');
  eq('prices are numbers', [r.ltp, r.bid, r.ask, r.strike], [1030, 985, 994.8, 74200]);
  eq('the true producer is carried through untouched', r.source, 'FYERS_LIVE');
  eq('ABSENCE IS PRESERVED: a provider-absent volume/oi stays null, never 0', [r.volume, r.oi, r.changeOi, r.delta], [null, null, null, null]);
  eq('the arrival timestamp is preferred over the provider one', r.ts.toISOString().slice(0, 19), new Date('2026-09-15T10:43:41+05:30').toISOString().slice(0, 19));
  ok('no price field is ever coerced to a number when absent', M.PRICE_FIELDS.every((f) => M.commonChainRowFromUnified(row({ [f]: null }))[f] === null));

  const piped = M.commonChainRowFromUnified(row({ instrumentKey: 'NSE_FO|NIFTY26SEP23000PE', optionType: 'PE' }));
  eq('a piped broker key also maps', [piped.contractSymbol, piped.optionType], ['NIFTY26SEP23000PE', 'PE']);

  for (const [name, over] of Object.entries({ 'no symbol': { instrumentKey: '' }, 'no expiry': { expiry: null }, 'no strike': { strike: null }, 'no right': { optionType: null }, 'bad right': { optionType: 'XX' } })) {
    eq(`a row with ${name} is refused, not invented`, M.commonChainRowFromUnified(row(over)), null);
  }
  eq('a batch drops only the unusable rows', M.commonChainRowsFromUnified([row(), row({ strike: null }), row({ instrumentKey: 'BSE:SENSEX26SEP74300PE' })]).length, 2);
}

// ── [D] ─────────────────────────────────────────────────────────────────────
console.log('\n[D] nearest expiry');
{
  const rows = M.commonChainRowsFromUnified([row({ expiry: '2026-09-26' }), row({ expiry: '2026-09-18' }), row({ expiry: '2026-09-12' })]);
  eq('only expiries at/after today, nearest first', M.nearestExpiry(rows, '2026-09-15'), '2026-09-18');
  eq('today itself is allowed', M.nearestExpiry(rows, '2026-09-18'), '2026-09-18');
  eq('all expired ⇒ null (never a past expiry)', M.nearestExpiry(rows, '2026-10-01'), null);
}

// ── [E] ─────────────────────────────────────────────────────────────────────
console.log('\n[E] legs');
{
  const rows = M.commonChainRowsFromUnified([
    row(),
    row({ instrumentKey: 'BSE:SENSEX26SEP74200PE', optionType: 'PE', ltp: '532.1000', oi: '1200', volume: '340' }),
    row({ instrumentKey: 'BSE:SENSEX26SEP74300CE', strike: '74300.0000', ltp: '0' }),
    row({ instrumentKey: 'BSE:SENSEX26SEP75000CE', strike: '75000.0000', expiry: '2026-10-01' }),
  ]);
  const legs = M.commonRowsToAtmLegs(rows, '2026-09-26');
  eq('only this expiry and a positive premium', legs.map((l) => l.contractSymbol), ['SENSEX26SEP74200CE', 'SENSEX26SEP74200PE']);
  eq('legs preserve an absent oi/volume as null', [legs[0].oi, legs[0].volume], [null, null]);
  eq('a present oi/volume is carried', [legs[1].oi, legs[1].volume], [1200, 340]);
  const chain = M.commonRowsToChainLegs(rows, '2026-09-26', new Set([74200]));
  eq('the chain leg is scoped to the ATM strike', chain.map((c) => [c.strike, c.optionType]), [[74200, 'CE'], [74200, 'PE']]);
}

// ── [F] ─────────────────────────────────────────────────────────────────────
console.log('\n[F] purity');
{
  const code = fs.readFileSync(SRC, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  ok('no clock read (nowMs is passed in)', !/Date\.now\(\)/.test(code));
  ok('no randomness', !/Math\.random/.test(code));
  ok('no DB/HTTP/model client', !/mysql|fetch\(|axios|http\.|openai|anthropic|claude/i.test(code));
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) { console.log('FAILED:'); failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
process.exit(0);
