#!/usr/bin/env node
/**
 * Pre-cleared desk instructions (session auto-start) — tests.
 *
 * Pure rules: no DB, no network, no clock. Verifies the two things that matter
 * for an unattended entry:
 *   1. WHEN it may act (session window, once per session, one-shot vs recurring), and
 *   2. WHEN IT MUST REFUSE — a missing lot size, a missing cap, a missing price or
 *      a too-expensive lot must skip the order with a reason. Never a guessed
 *      number, never a rounded-up size, never a hard-coded constant.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const R = require('../dist/trading/upstox-live-paper/upstox-live-paper-instruction.rules');
const {
  istDateOf, istMinutesOfDay, withinSessionWindow, isInstructionDue, isOptionContract, planInstruction,
  SESSION_OPEN_MINUTES, SESSION_LAST_ENTRY_MINUTES,
} = R;

const SRC = path.join(__dirname, '..', 'src', 'trading', 'upstox-live-paper');

console.log('pre-cleared instruction tests');

const TODAY = '2026-09-10';
const base = (over = {}) => ({
  enabled: true, side: 'BUY', instrument: 'SENSEX26102286000PE', underlying: 'SENSEX',
  lots: null, lotSize: null, maxCapital: 5000, sessionDate: null, lastExecutedSession: null, ...over,
});
const input = (over = {}) => ({ todayIst: TODAY, universes: ['SENSEX'], lotSize: 10, lotSizeSource: 'broker-contract-master', premium: 100, ...over });

// ── 1. IST clock (the market's calendar, not the host's) ─────────────────────
{
  const open0515 = Date.UTC(2026, 8, 10, 3, 45);   // 09:15 IST
  assert.equal(istMinutesOfDay(open0515), SESSION_OPEN_MINUTES, '09:15 IST is the open minute');
  assert.equal(istDateOf(open0515), '2026-09-10', 'IST date of the open');
  assert.equal(istDateOf(Date.UTC(2026, 8, 10, 19, 0)), '2026-09-11', '19:00Z is already next day in IST');
  assert.equal(withinSessionWindow(open0515), true, 'open is inside the window');
  assert.equal(withinSessionWindow(Date.UTC(2026, 8, 10, 3, 44)), false, '09:14 IST is not');
  assert.equal(withinSessionWindow(Date.UTC(2026, 8, 10, 9, 50)), true, '15:20 IST is the last entry minute');
  assert.equal(withinSessionWindow(Date.UTC(2026, 8, 10, 9, 51)), false, '15:21 IST is past it');
  assert.ok(istMinutesOfDay(Date.UTC(2026, 8, 10, 19, 0)) < SESSION_OPEN_MINUTES, 'midnight IST is outside');
}
console.log('  1 IST session clock ok');

// ── 2. Due-ness: armed, once per session, one-shot expires ────────────────────
{
  assert.equal(isInstructionDue(base(), TODAY), true, 'armed recurring instruction is due');
  assert.equal(isInstructionDue(base({ enabled: false }), TODAY), false, 'disabled is not due');
  assert.equal(isInstructionDue(base({ lastExecutedSession: TODAY }), TODAY), false, 'already fired today → not due again');
  assert.equal(isInstructionDue(base({ lastExecutedSession: '2026-09-09' }), TODAY), true, 'yesterday does not block today');
  assert.equal(isInstructionDue(base({ sessionDate: TODAY }), TODAY), true, 'one-shot for today is due');
  assert.equal(isInstructionDue(base({ sessionDate: '2026-10-01' }), TODAY), false, 'one-shot for a future date is not due');
  assert.equal(isInstructionDue(base({ sessionDate: '2026-09-01' }), TODAY), false, 'an expired one-shot never fires');
  assert.equal(isOptionContract('SENSEX26102286000PE'), true, 'PE contract');
  assert.equal(isOptionContract('BSE_INDEX|SENSEX'), false, 'index is not a contract');
}
console.log('  2 due-ness ok');

// ── 3. Refusals: every missing input skips WITH A REASON ─────────────────────
{
  const cases = [
    [{ instrument: 'BSE_INDEX|SENSEX' }, input(), /does not end in CE\/PE/, 'non-option instrument refused'],
    [{ underlying: 'NIFTY' }, input(), /does not trade NIFTY/, 'universe the desk does not trade refused'],
    [{}, input({ lotSize: null }), /no lot size/, 'missing lot size refused'],
    [{}, input({ premium: null }), /no traded premium/, 'missing price refused'],
    [{}, input({ premium: 0 }), /no traded premium/, 'zero price refused'],
    [{ maxCapital: null }, input(), /no maxCapital/, 'missing capital cap refused'],
    [{ maxCapital: 500 }, input({ premium: 100, lotSize: 10 }), /exceeds the per-position cap/, 'one lot over the cap refused'],
    [{ enabled: false }, input(), /disabled/, 'disabled refused'],
    [{ sessionDate: '2026-09-09' }, input(), /one-shot instruction is for/, 'stale one-shot refused'],
    [{ lastExecutedSession: TODAY }, input(), /already executed for session/, 'second fire in a session refused'],
  ];
  for (const [over, inp, rx, label] of cases) {
    const plan = planInstruction(base(over), inp);
    assert.equal(plan.execute, false, `${label}: must not execute`);
    assert.ok(rx.test(plan.skipped), `${label}: reason must match ${rx} (got: ${plan.skipped})`);
    assert.ok(typeof plan.skipped === 'string' && plan.skipped.length > 10, `${label}: reason must be human-readable`);
  }
}
console.log('  3 refusals ok');

// ── 4. Sizing: the ₹5,000 cap is a FILTER on lots, derived from the live premium ─
{
  const plan = planInstruction(base(), input({ premium: 100, lotSize: 10 }));
  assert.equal(plan.execute, true, 'a fully specified instruction executes');
  assert.equal(plan.lots, 5, '₹5,000 / (₹100 × 10) = 5 lots');
  assert.equal(plan.units, 50, 'units = lots × lot size');
  assert.equal(plan.outlay, 5000, 'outlay = units × premium');
  assert.equal(plan.capitalCap, 5000);
  assert.ok(plan.outlay <= plan.capitalCap, 'never exceeds the cap');

  // A cheaper premium buys MORE lots but still inside the cap — the cap is the
  // filter, the contract is the operator's choice.
  const cheaper = planInstruction(base(), input({ premium: 25, lotSize: 10 }));
  assert.equal(cheaper.lots, 20, '20 lots fit at ₹25 premium');
  assert.equal(cheaper.outlay, 5000, 'cap still binding');

  // Explicit lots are honoured AND still validated against the cap.
  const explicit = planInstruction(base({ lots: 2 }), input({ premium: 100, lotSize: 10 }));
  assert.equal(explicit.lots, 2);
  assert.equal(explicit.outlay, 2000, 'explicit lots respect the cap and under-use it');
  const tooBig = planInstruction(base({ lots: 9 }), input({ premium: 100, lotSize: 10 }));
  assert.equal(tooBig.execute, false, 'explicit lots over the cap are refused, not trimmed silently');
  assert.ok(/exceeds the per-position cap/.test(tooBig.skipped));

  // The cap is an absolute rupee FILTER (unlike the detector's ratio rules), so a
  // 100x cheaper premium buys exactly 100x the lots — and both stay inside the cap.
  const small = planInstruction(base(), input({ premium: 0.5, lotSize: 10 }));
  const large = planInstruction(base(), input({ premium: 50, lotSize: 10 }));
  assert.equal(small.lots, large.lots * 100, 'lot count scales inversely with the premium');
  assert.ok(small.outlay <= 5000 && large.outlay <= 5000, 'both stay inside the cap');
}
console.log('  4 sizing/cap filter ok');

// ── 5. No hard-coded trading constants in the rules ──────────────────────────
{
  const rulesSrc = fs.readFileSync(path.join(SRC, 'upstox-live-paper-instruction.rules.ts'), 'utf8');
  assert.ok(!/5000|5_000/.test(rulesSrc), 'the rules module holds no rupee cap of its own');
  assert.ok(rulesSrc.includes('SESSION_OPEN_MINUTES') && rulesSrc.includes('SESSION_LAST_ENTRY_MINUTES'), 'session window is explicit, not implicit');
  // Strip comments, then require that the ONLY multi-digit literals in the rules
  // are unit conversions. Everything else a decision depends on is an input.
  const noComments = rulesSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const literals = noComments.match(/\b\d[\d_]*(?:\.\d+)?\b/g) ?? [];
  // Time units are not trading constants: ms in an hour / minute / second, and the
  // seconds in a day. A rupee cap, a lot size or a threshold still fails this.
  const TIME_UNITS = /^(?:3_?600_?000|60_?000|1_?000|86_?400_?000)$/;
  const suspicious = literals.filter((s) => s.replace(/[_.]/g, '').length >= 3 && !TIME_UNITS.test(s));
  assert.equal(suspicious.length, 0, `unexpected numeric constants in the rules: ${suspicious.join(', ')}`);
  assert.ok(!/\blotSize\s*=\s*\d/.test(noComments), 'no hard-coded lot size');
  assert.ok(rulesSrc.includes('never guessed'), 'the refusal rule states why it refuses');
}
console.log('  5 no hard-coded trading constants ok');

// ── 6. Source-level wiring: the auto-start is real and gated ─────────────────
{
  const serviceSrc = fs.readFileSync(path.join(SRC, 'upstox-live-paper-instruction.service.ts'), 'utf8');
  assert.ok(/@Cron\('\*\/5 9-15 \* \* 1-5'/.test(serviceSrc), 'a weekday session cron exists');
  assert.ok(serviceSrc.includes('withinSessionWindow'), 'the cron is guarded by the explicit session window');
  assert.ok(serviceSrc.includes('autoTradeEnabled'), 'the runner requires the portfolio auto-trade flag');
  assert.ok(serviceSrc.includes('lastExecutedSession'), 'the once-per-session guard is enforced');
  assert.ok(serviceSrc.includes('lotSizeFor'), 'lot size comes from the resolver (instruction → env → broker master)');
  assert.ok(serviceSrc.includes('previewEntry'), 'sizing uses a live fill-side premium');
  assert.ok(!/PATTERN_LOT_SIZE\s*\?\?/.test(serviceSrc), 'no hand-set lot size fallback in the runner');

  const entitySrc = fs.readFileSync(path.join(SRC, 'upstox-live-paper-instruction.entity.ts'), 'utf8');
  assert.ok(entitySrc.includes("'upstox_live_paper_instructions'"), 'own table (isolation from FNF and sandbox)');
  assert.ok(entitySrc.includes('lastExecutedSession') && entitySrc.includes('maxCapital'), 'the guard and the cap are persisted');

  const deskSrc = fs.readFileSync(path.join(SRC, 'upstox-live-paper.service.ts'), 'utf8');
  assert.ok(deskSrc.includes('broker-contract-master'), 'the desk resolves lot size from the broker contract master');
  assert.ok(!/lotSize\s*=\s*\d+;/.test(deskSrc), 'no hard-coded lot size in the desk service');
}
console.log('  6 auto-start wiring ok');

console.log('pre-cleared instruction tests: all ok');
