#!/usr/bin/env node
/**
 * Proves the real .env FNO_OPTION_CONTRACTS parses into correct contracts, and
 * that the option-symbol pattern in fno-market-data.service.ts accepts every
 * symbol it will actually receive.
 */
'use strict';
const fs = require('fs');
const assert = require('node:assert/strict');

const ENV = '/home/swarna-sekhar-dhar/projects/my-job-agent/.env';
const text = fs.readFileSync(ENV, 'utf8');
const line = text.split('\n').find((l) => l.startsWith('FNO_OPTION_CONTRACTS='));
assert.ok(line, 'FNO_OPTION_CONTRACTS must exist in .env');
let raw = line.slice('FNO_OPTION_CONTRACTS='.length).trim();
// .env wraps the value in double quotes
if (raw.startsWith('"') && raw.endsWith('"')) raw = raw.slice(1, -1);

const contracts = JSON.parse(raw);
console.log(`  parsed ${contracts.length} contracts from .env`);

const pat = /^(NSE|BSE):([A-Z0-9]+)(\d{2}(?:[A-Z]{3}|O\d{2}))(\d+)(CE|PE)$/;
let matched = 0;
for (const c of contracts) {
  assert.ok(pat.exec(c.symbol), `option pattern must match ${c.symbol}`);
  assert.match(c.expiry, /^20\d\d-\d\d-\d\d$/, `${c.symbol} needs an ISO expiry`);
  matched += 1;
}
console.log(`  all ${matched} symbols match the option pattern`);

const expiries = new Set(contracts.map((c) => c.expiry));
console.log(`  expiries present: ${[...expiries].join(', ')}`);
assert.deepEqual([...expiries], ['2026-10-06'], 'subscription must target one expiry');

// The FYERS code does not encode the day: 26O06 is 6 Oct, and the metadata
// must carry the real date, never a date derived from the symbol.
const atm = contracts.find((c) => c.symbol === 'NSE:NIFTY26O0622700CE');
assert.ok(atm, 'ATM 22700 CE must be present');
assert.equal(atm.strike, 22700);
assert.equal(atm.lotSize, 65);
assert.equal(atm.expiry, '2026-10-06');
console.log(`  ATM NSE:NIFTY26O0622700CE -> strike ${atm.strike}, expiry ${atm.expiry}, lot ${atm.lotSize}`);

const symLine = text.split('\n').find((l) => l.startsWith('FNO_MARKET_DATA_SYMBOLS=')).slice('FNO_MARKET_DATA_SYMBOLS='.length).trim().replace(/^"|"$/g, '');
const syms = symLine.split(',').filter(Boolean);
const opts = syms.filter((s) => pat.exec(s));
console.log(`  subscription: ${syms.length} symbols, ${opts.length} options, indices: ${syms.length - opts.length}`);
for (const c of contracts) {
  assert.ok(syms.includes(c.symbol), `${c.symbol} has metadata but is not subscribed`);
}
console.log('  every contract is also subscribed  OK');
console.log('\nenv contract/subscription alignment: PASS');
