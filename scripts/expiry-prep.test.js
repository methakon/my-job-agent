#!/usr/bin/env node
/**
 * Deterministic tests for scripts/expiry-prep.js — pure helpers only
 * (no DB, no network, no file-system side effects).
 */
'use strict';
const assert = require('node:assert/strict');
const {
  pickNearestExpiry, selectStrikes, pcr, maxPain, oiWalls, atmStraddle,
  buildUniverseForUnderlying, parseMasterRows,
  isoDay,
} = require('./expiry-prep');

let passed = 0; let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok ${name}`); passed += 1; }
  catch (e) { console.log(`  FAIL ${name}: ${e.message}`); failed += 1; }
}

console.log('expiry-prep tests\n');

// ── pickNearestExpiry ─────────────────────────────────────────────────────
test('pickNearestExpiry: next on-or-after today', () => {
  assert.equal(pickNearestExpiry(['2026-09-24', '2026-10-01', '2026-10-08'], '2026-09-28'), '2026-10-01');
});
test('pickNearestExpiry: inclusive of today', () => {
  assert.equal(pickNearestExpiry(['2026-09-29', '2026-10-06'], '2026-09-29'), '2026-09-29');
});
test('pickNearestExpiry: none left → null', () => {
  assert.equal(pickNearestExpiry(['2026-09-24'], '2026-09-28'), null);
});

// ── selectStrikes ─────────────────────────────────────────────────────────
const strikes = [100, 110, 120, 130, 140, 150, 160];
test('selectStrikes: nearest 5 around 138 (width 2)', () => {
  assert.deepEqual(selectStrikes(strikes, 138, 2), [120, 130, 140, 150, 160]);
});
test('selectStrikes: clamps at the low edge', () => {
  assert.deepEqual(selectStrikes(strikes, 90, 2), [100, 110, 120, 130, 140]);
});
test('selectStrikes: unsorted + duplicates tolerated', () => {
  assert.deepEqual(selectStrikes([140, 100, 120, 120, 130], 131, 1), [120, 130, 140]);
});

// ── pcr / maxPain / oiWalls ───────────────────────────────────────────────
test('pcr: ratio and null denominator', () => {
  assert.equal(pcr(100, 80), 0.8);
  assert.equal(pcr(0, 80), null);
});
test('maxPain: pull toward the strike with the heaviest total OI', () => {
  const chain = [
    { strike: 100, ceOi: 10, peOi: 10 },
    { strike: 110, ceOi: 500, peOi: 60 },
    { strike: 120, ceOi: 50, peOi: 500 },
  ];
  // settling at 110: CE(100) ITM 10*10; PE(120) ITM 10*500 → 5010
  // settling at 120: CE(100) 20*10 + CE(110) 10*500 → 5200; settling at 100: PE(110) 10*60 + PE(120) 20*500 → 10600
  assert.equal(maxPain(chain).strike, 110);
});
test('maxPain: empty chain → null', () => {
  assert.equal(maxPain([]), null);
});
test('oiWalls: heaviest CE and PE strike', () => {
  const w = oiWalls([
    { strike: 100, ceOi: 5, peOi: 900 },
    { strike: 110, ceOi: 700, peOi: 60 },
  ]);
  assert.equal(w.callWall.strike, 110);
  assert.equal(w.putWall.strike, 100);
});

// ── atmStraddle ───────────────────────────────────────────────────────────
test('atmStraddle: nearest two-sided strike to spot', () => {
  const s = atmStraddle([
    { strike: 100, ceLtp: 4, peLtp: 3 },
    { strike: 110, ceLtp: 2.5, peLtp: 6 },
    { strike: 120, ceLtp: 1, peLtp: 9 },
  ], 113);
  assert.equal(s.strike, 110);
  assert.equal(s.premium, 8.5);
});
test('atmStraddle: skips one-legged rows', () => {
  const s = atmStraddle([
    { strike: 100, ceLtp: 4, peLtp: 0 },
    { strike: 110, ceLtp: 2.5, peLtp: 6 },
  ], 105);
  assert.equal(s.strike, 110);
});

// ── buildUniverseForUnderlying ────────────────────────────────────────────
function mk(symbol, name, expiry, strike, type, lot = 65) {
  return { symbol, underlyingName: name, underlying: name === 'NIFTY' ? 'NIFTY50-INDEX' : name, expiry, strike, optionType: type, lotSize: lot, tickSize: 0.05, name: `${name} ${strike} ${type}` };
}
const fixture = [
  mk('NSE:NIFTY26SEP9900CE', 'NIFTY', '2026-09-29', 9900, 'CE'),
  mk('NSE:NIFTY26SEP9900PE', 'NIFTY', '2026-09-29', 9900, 'PE'),
  mk('NSE:NIFTY26SEP10000CE', 'NIFTY', '2026-09-29', 10000, 'CE'),
  mk('NSE:NIFTY26SEP10000PE', 'NIFTY', '2026-09-29', 10000, 'PE'),
  mk('NSE:NIFTY26SEP10100CE', 'NIFTY', '2026-09-29', 10100, 'CE'),
  mk('NSE:NIFTY26SEP10100PE', 'NIFTY', '2026-09-29', 10100, 'PE'),
  // wrong expiry — must be ignored (nearest future expiry is 09-29)
  mk('NSE:NIFTY26OCT10000CE', 'NIFTY', '2026-10-27', 10000, 'CE'),
  mk('NSE:NIFTY26OCT10000PE', 'NIFTY', '2026-10-27', 10000, 'PE'),
  // one-legged strike — must be ignored
  mk('NSE:NIFTY26SEP10200CE', 'NIFTY', '2026-09-29', 10200, 'CE'),
];
test('buildUniverse: picks nearest expiry, two-sided strikes, ATM±width', () => {
  const u = buildUniverseForUnderlying(fixture, 'NIFTY', 10040, 1, '2026-09-28');
  assert.equal(u.expiry, '2026-09-29');
  assert.deepEqual(u.strikes, [9900, 10000, 10100]);
  assert.equal(u.contracts.length, 6);
  assert.ok(u.contracts.every((c) => c.expiry === '2026-09-29' && c.lotSize === 65));
  assert.ok(u.symbols.includes('NSE:NIFTY26SEP10000CE'));
});
test('buildUniverse: unknown underlying → null', () => {
  assert.equal(buildUniverseForUnderlying(fixture, 'BANKNIFTY', 10000, 1, '2026-09-28'), null);
});

// ── parseMasterRows ───────────────────────────────────────────────────────
test('parseMasterRows: extracts option rows from the broker master format', () => {
  const csv = [
    '101126092973895,NIFTY 29 Sep 26 22800 CE,14,65,0.05,,0915-1540|1815-1915:,2026-09-25,1790676600,NSE:NIFTY26SEP22800CE,10,11,73895,NIFTY,26000,22800.0,',
    '101126092968390,BANKNIFTY 29 Sep 26 FUT,11,30,0.2,,0915-1540|1815-1915:,2026-09-25,1790676600,NSE:BANKNIFTY26SEPFUT,10,11,68390,BANKNIFTY,26009,-1.0,XX,',
  ].join('\n');
  const rows = parseMasterRows(csv);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].symbol, 'NSE:NIFTY26SEP22800CE');
  assert.equal(rows[0].expiry, new Date(1790676600 * 1000).toISOString().slice(0, 10));
  assert.equal(rows[0].strike, 22800);
  assert.equal(rows[0].underlying, 'NIFTY50-INDEX');
  assert.equal(rows[0].lotSize, 65);
});

// ── Regression: DATE columns must never be string-sliced ──────────────
console.log('\nDATE column normalisation');
test('isoDay formats a JS Date from mysql2 as YYYY-MM-DD, not "Tue Sep 29"', () => {
  // mysql2 returns DATE columns as Date objects in local time.
  assert.equal(isoDay(new Date(2026, 8, 29)), '2026-09-29');
});
test('isoDay passes through an ISO string unchanged', () => {
  assert.equal(isoDay('2026-09-29'), '2026-09-29');
  assert.equal(isoDay('2026-09-29 00:00:00'), '2026-09-29');
});
test('isoDay returns null for junk rather than a corrupt date', () => {
  assert.equal(isoDay(null), null);
  assert.equal(isoDay(undefined), null);
  assert.equal(isoDay('not-a-date'), null);
});
test('a Date expiry never produces a two-token "Tue Sep 29" registry value', () => {
  const bad = isoDay(new Date(2026, 8, 29));
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(bad), `registry expiry must be ISO, got "${bad}"`);
  assert.equal(bad.split(' ').length, 1);
});
console.log(`\nexpiry-prep: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
