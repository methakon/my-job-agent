#!/usr/bin/env node
/**
 * The FYERS expiry symbol has two forms and does NOT encode the expiry day.
 *
 * FYERS' own master proves both facts:
 *   26O06  -> 6 Oct 2026      (DDO0MM form: week and month repeat)
 *   26SEP  -> 29 Sep 2026     (DDMMM form, and the day is 29, not 26)
 *   26OCT  -> 27 Oct 2026     (DDMMM form, and the day is 27, not 26)
 *
 * Two bugs came from ignoring this:
 *   1. a [A-Z]{3}-only pattern silently dropped every 26O06 symbol, so the
 *      option universe was empty and nothing was subscribed;
 *   2. deriving a date from the code read "26" as the day of month, so every
 *      expiry was wrong. The authoritative date comes from FNO_OPTION_CONTRACTS
 *      (parsed by fnf-option-chain.configuredContracts), never from the symbol.
 */
'use strict';
const assert = require('node:assert/strict');

const optionSymbolPattern = /^(NSE|BSE):([A-Z0-9]+)(\d{2}(?:[A-Z]{3}|O\d{2}))(\d+)(CE|PE)$/;
const OLD_PATTERN = /^(NSE|BSE):([A-Z0-9]+)(\d{2}[A-Z]{3})(\d+)(CE|PE)$/;

/** Mirrors the service: identity from the symbol, date from contract metadata. */
function register(sym, meta) {
  const m = optionSymbolPattern.exec(sym);
  if (!m) return null;
  if (!meta?.expiry) return { symbol: sym, registered: false, reason: 'NO_CONTRACT_METADATA' };
  return {
    symbol: sym, registered: true,
    underlying: meta.underlying || m[2],
    expiry: meta.expiry,
    strike: Number(m[4]),
    optionType: m[5],
    lotSize: meta.lotSize,
  };
}

let pass = 0; let fail = 0;
const t = (name, fn) => { try { fn(); console.log(`  ok   ${name}`); pass += 1; } catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail += 1; } };

t('the old pattern rejected 26O06 — that was the empty-universe bug', () => {
  assert.equal(OLD_PATTERN.exec('NSE:NIFTY26O0622700CE'), null);
  assert.ok(optionSymbolPattern.exec('NSE:NIFTY26O0622700CE'));
});

t('DDO0MM form is accepted and dated from metadata', () => {
  const c = register('NSE:NIFTY26O0622700CE', { expiry: '2026-10-06', lotSize: 65, underlying: 'NIFTY50-INDEX' });
  assert.equal(c.registered, true);
  assert.equal(c.expiry, '2026-10-06');
  assert.equal(c.strike, 22700);
  assert.equal(c.lotSize, 65);
});

t('DDMMM form still accepted (26SEP) and NOT dated as 26 Sep', () => {
  const c = register('NSE:NIFTY26SEP22700CE', { expiry: '2026-09-29', lotSize: 65, underlying: 'NIFTY50-INDEX' });
  assert.equal(c.registered, true);
  // The whole point: 26SEP is the 29th, so a symbol-derived date would be wrong.
  assert.equal(c.expiry, '2026-09-29');
  assert.notEqual(c.expiry, '2026-09-26');
});

t('BSE SENSEX DDO0MM form accepted', () => {
  const c = register('BSE:SENSEX26O0172800CE', { expiry: '2026-10-01', lotSize: 20, underlying: 'SENSEX' });
  assert.equal(c.registered, true);
  assert.equal(c.expiry, '2026-10-01');
});

t('PE leg parses with the same metadata', () => {
  assert.equal(register('NSE:NIFTY26O0622700PE', { expiry: '2026-10-06', lotSize: 65 }).optionType, 'PE');
});

t('an index symbol is not an option', () => {
  assert.equal(register('NSE:NIFTY50-INDEX', { expiry: '2026-10-06' }), null);
});

t('a symbol with no metadata is skipped, never dated by guesswork', () => {
  const c = register('NSE:NIFTY26O0622700CE', null);
  assert.equal(c.registered, false);
  assert.equal(c.reason, 'NO_CONTRACT_METADATA');
  assert.equal(c.expiry, undefined);
});

t('both FYERS forms coexist in one subscription', () => {
  const syms = ['NSE:NIFTY26SEP22700CE', 'NSE:NIFTY26O0622700CE', 'NSE:BANKNIFTY26O0617800PE'];
  const meta = {
    'NSE:NIFTY26SEP22700CE': { expiry: '2026-09-29', lotSize: 65 },
    'NSE:NIFTY26O0622700CE': { expiry: '2026-10-06', lotSize: 65 },
    'NSE:BANKNIFTY26O0617800PE': { expiry: '2026-10-06', lotSize: 30 },
  };
  const out = syms.map((s) => register(s, meta[s]));
  assert.ok(out.every((c) => c.registered));
  assert.deepEqual(out.map((c) => c.expiry), ['2026-09-29', '2026-10-06', '2026-10-06']);
});

console.log(`\nfyers expiry-code handling: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
