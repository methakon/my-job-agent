#!/usr/bin/env node
/**
 * Tests for the expiry paper learning ledger.
 *
 * The properties that matter most:
 *  - COLD START MUST BE ABLE TO TRADE (no permanent zero-trade deadlock)
 *  - "no validated edge" must shrink size, NOT veto the trade
 *  - DTE=0 must be a market-state feature, NOT a veto
 *  - committed capital can NEVER exceed available capital
 *  - net P&L is after realistic charges, and STT uses the 2026 rates
 *  - every position has a loss boundary decided before entry
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

let passed = 0; let failed = 0; const failures = [];
function test(name, fn) {
  try { fn(); console.log(`  ok   ${name}`); passed += 1; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message.split('\n').join('\n       ')}`); failed += 1; failures.push(name); }
}
const group = (n) => console.log(`\n${n}`);

// Isolated scratch dir per run.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'expiry-ledger-'));
process.env.EXPIRY_LEDGER_DIR = TMP;
process.env.EXPIRY_PAPER_CAPITAL = '5000';
const L = require('./expiry-paper-ledger');

const CHARGES = {
  brokeragePerLot: 20, sttRatePct: 0.15, sttExerciseRatePct: 0.15,
  exchangeFeePct: 0.05, gstRatePct: 18, stampDutyRatePct: 0.003,
};

console.log('expiry paper learning ledger tests');

// ─────────────────────────── mode ladder ─────────────────────────────────
group('learning mode is evidence-driven');
test('cold start is EXPLORATION, not a refusal', () => {
  const m = L.learningModeFor({ n: 0, alpha: 1, beta: 1 });
  assert.equal(m.mode, L.MODE.EXPLORATION);
});
test('thin evidence is CALIBRATION with a wide posterior', () => {
  const m = L.learningModeFor({ n: 12, alpha: 7, beta: 5 });
  assert.equal(m.mode, L.MODE.CALIBRATION);
});
test('tight favourable posterior becomes ADAPTIVE_SIZING', () => {
  const m = L.learningModeFor({ n: 40, alpha: 26, beta: 14 });
  assert.equal(m.mode, L.MODE.ADAPTIVE_SIZING);
});
test('a bad posterior returns to CALIBRATION, never EXPLOITATION', () => {
  const m = L.learningModeFor({ n: 50, alpha: 20, beta: 30 });
  assert.notEqual(m.mode, L.MODE.EXPLOITATION);
});
test('every mode explains itself (auditable)', () => {
  for (const n of [0, 12, 40, 60]) {
    const m = L.learningModeFor({ n, alpha: n / 2 + 1, beta: n / 2 + 1 });
    assert.ok(m.why && m.why.length > 5, 'mode must state a reason');
  }
});

// ─────────────────────────── net economics ─────────────────────────────
group('net economics (STT at Finance Act 2026 rates)');
test('a winning round trip is net of every charge', () => {
  const e = L.netPnl({ entryPremium: 100, exitPremium: 120, lotSize: 65, lots: 1, charges: CHARGES });
  assert.equal(e.quantity, 65);
  assert.equal(e.grossPnl, 1300);            // (120-100)*65
  assert.ok(e.totalCharges > 0);
  assert.ok(e.netPnl < e.grossPnl, 'net must be below gross');
  assert.equal(e.netPnl, Number((1300 - e.totalCharges).toFixed(2)));
});
test('STT is charged on the SELL premium at 0.15%', () => {
  const e = L.netPnl({ entryPremium: 100, exitPremium: 120, lotSize: 65, lots: 1, charges: CHARGES });
  const expectedStt = Number((120 * 65 * 0.0015).toFixed(2));
  assert.equal(e.stt, expectedStt);
});
test('exercise/settlement STT uses the INTRINSIC base, not the premium', () => {
  const e = L.netPnl({ entryPremium: 100, exitPremium: 120, lotSize: 65, lots: 1, intrinsicExit: 65 * 50, charges: CHARGES });
  const expectedStt = Number(((65 * 50) * 0.0015).toFixed(2));
  assert.equal(e.stt, expectedStt, 'STT base must be intrinsic value on exercise');
});
test('charges are itemised so the objective is auditable', () => {
  const e = L.netPnl({ entryPremium: 50, exitPremium: 40, lotSize: 65, lots: 1, charges: CHARGES });
  for (const k of ['brokerage', 'exchangeFee', 'gst', 'stampDuty', 'stt', 'totalCharges']) {
    assert.ok(k in e, `missing charge line ${k}`);
  }
  const sum = e.brokerage + e.exchangeFee + e.gst + e.stampDuty + e.stt;
  assert.ok(Math.abs(sum - e.totalCharges) < 0.02, 'charges must sum to the total');
});

// ─────────────────────────── sizing ─────────────────────────────────────
group('sizing: dynamic, and cold start CAN trade');
// A ₹100 premium × lot 65 = ₹6,500 exceeds the ₹5,000 paper account, so the
// learning-path tests use an affordable contract. The unaffordable case gets
// its own test below so both paths are covered honestly.
const baseArgs = { key: 'PIN_RANGE|F_ATM', premium: 30, lotSize: 65, entryAsk: 30, stopPremium: 24, liveDataAvailable: true };

test('cold start with zero history returns a TRADE, not a refusal', () => {
  const s = L.sizePaperPosition({ state: L.loadState(), ...baseArgs, uncertainty: 0.9 });
  assert.equal(s.mode, L.MODE.EXPLORATION);
  assert.equal(s.allowed, true, 'exploration must be able to trade');
  assert.ok(s.lots >= 1, 'at least one lot must be committed in exploration');
});
test('an unaffordable lot is refused for MONEY, never for lack of evidence', () => {
  // 1 NIFTY lot at a ₹100 premium = ₹6,500 > ₹5,000 available.
  const s = L.sizePaperPosition({ state: L.loadState(), key: 'X|Y', premium: 100, lotSize: 65, entryAsk: 100, stopPremium: 80, liveDataAvailable: true });
  assert.equal(s.allowed, false);
  assert.ok(s.reason.includes('ONE_LOT_UNAFFORDABLE'));
  assert.equal(s.mode, L.MODE.EXPLORATION, 'exploration mode is still willing — the blocker is money');
  assert.match(s.note, /NOT on lack of evidence/);
});
test('size grows with accumulated evidence', () => {
  // Use a premium where MULTIPLE lots are affordable, so the difference
  // between a 1-lot exploration probe and an evidence-sized position is
  // observable. (With one lot affordable, every mode floors at 1 by design.)
  const args = { key: 'PIN_RANGE|F_ATM', premium: 8, lotSize: 65, entryAsk: 8, stopPremium: 6, liveDataAvailable: true };
  const cold = L.sizePaperPosition({ state: L.loadState(), ...args });
  const warm = L.sizePaperPosition({
    state: { ...L.loadState(), posteriors: { 'PIN_RANGE|F_ATM': { alpha: 40, beta: 10, wins: [], losses: [], n: 48 } } },
    ...args,
  });
  assert.ok(cold.lots >= 1, 'cold start must be able to trade');
  assert.ok(warm.lots > cold.lots, `size must grow with evidence (cold=${cold.lots} warm=${warm.lots})`);
});
test('missing live data is a DATA-INTEGRITY refusal, not a strategy veto', () => {
  const s = L.sizePaperPosition({ state: L.loadState(), ...baseArgs, liveDataAvailable: false });
  assert.equal(s.allowed, false);
  assert.ok(s.reason.includes('NO_LIVE_DATA'));
});
test('no loss boundary is refused (measured outcomes require a boundary)', () => {
  const s = L.sizePaperPosition({ state: L.loadState(), ...baseArgs, stopPremium: 0 });
  assert.equal(s.allowed, false);
  assert.ok(s.reason.includes('NO_LOSS_BOUNDARY'));
});
test('a stop ABOVE entry is refused (nonsensical boundary)', () => {
  const s = L.sizePaperPosition({ state: L.loadState(), ...baseArgs, stopPremium: 120 });
  assert.equal(s.allowed, false);
});
test('invalid contract (premium or lot <= 0) is refused', () => {
  assert.equal(L.sizePaperPosition({ state: L.loadState(), ...baseArgs, premium: 0 }).allowed, false);
  assert.equal(L.sizePaperPosition({ state: L.loadState(), ...baseArgs, lotSize: 0 }).allowed, false);
});
test('HARD INVARIANT: committed never exceeds available capital', () => {
  const state = { ...L.loadState(), initialCapital: 1000, realizedNet: 0, openPositions: [] };
  const s = L.sizePaperPosition({ state, ...baseArgs });
  if (s.allowed) {
    assert.ok(s.committedCapital <= s.account.AVAILABLE_CAPITAL + 1e-9,
      `committed ${s.committedCapital} > available ${s.account.AVAILABLE_CAPITAL}`);
  } else {
    // Refused ⇒ nothing may be committed at all.
    assert.equal(s.lots, 0);
  }
  assert.equal(s.account.invariantHolds, true);
});
test('HARD INVARIANT: a thin account is refused, never overspent', () => {
  // ₹1,000 available cannot buy a 1-lot ₹1,950 probe.
  const state = { ...L.loadState(), initialCapital: 1000, realizedNet: 0, openPositions: [] };
  const s = L.sizePaperPosition({ state, ...baseArgs });
  assert.equal(s.allowed, false);
  assert.ok(s.reason.includes('ONE_LOT_UNAFFORDABLE'));
  assert.equal(s.lots, 0, 'no overspend is permitted under any mode');
});
test('DTE=0 is recorded as a feature, never used as a veto', () => {
  const rec = L.openPaperPosition({ ...baseArgs, symbol: 'NSE:NIFTY26SEP22800CE', underlying: 'NIFTY', expiry: '2026-09-29', dte: 0 });
  assert.equal(rec.dte, 0, 'dte=0 must be carried on the record');
  assert.equal(rec.status, 'OPEN', 'dte=0 must not block a paper entry');
  L.closePaperPosition({ id: rec.id, exitBid: 90, exitReason: 'test', charges: CHARGES });
});

// ─────────────────────────── lifecycle ──────────────────────────────────
group('open → close → posterior update');
test('a closed trade is journaled with net P&L and an R multiple', () => {
  const rec = L.openPaperPosition({ ...baseArgs, symbol: 'SYM1', key: 'TREND|A_OBB', dte: 0 });
  assert.equal(rec.liveOrderCount, 0, 'no order may ever be counted');
  const out = L.closePaperPosition({ id: rec.id, exitBid: 115, exitReason: 'target', charges: CHARGES });
  assert.equal(out.closed, true);
  assert.ok(out.economics.netPnl > 0, 'a 15-point winner must be net positive');
  assert.ok(out.rMultiple > 0);
  assert.ok(out.modeAfter, 'post-close mode must be reported');
});
test('the posterior updates on NET outcome and is queryable', () => {
  const st = L.loadState();
  const p = st.posteriors['TREND|A_OBB'];
  assert.ok(p, 'posterior bucket must exist');
  assert.equal(p.n, 1);
  assert.ok(p.alpha > 1, 'a net win must raise alpha');
});
test('a net LOSS lowers the posterior (fees are what make it a loss)', () => {
  const rec = L.openPaperPosition({ ...baseArgs, symbol: 'SYM2', key: 'TREND|A_OBB', premium: 100, entryAsk: 100, stopPremium: 95 });
  const out = L.closePaperPosition({ id: rec.id, exitBid: 96, exitReason: 'stop', charges: CHARGES });
  assert.ok(out.economics.netPnl < 0, 'a tiny gross gain must still be a net loss after charges');
  const p = L.loadState().posteriors['TREND|A_OBB'];
  assert.equal(p.beta, 2, 'the loss must raise beta, not alpha');
});
test('capital evolves from ACTUAL net results', () => {
  const before = L.account(L.loadState());
  const rec = L.openPaperPosition({ ...baseArgs, symbol: 'SYM3', key: 'RANGE|F_MR', premium: 50, entryAsk: 50, stopPremium: 40 });
  const out = L.closePaperPosition({ id: rec.id, exitBid: 70, exitReason: 'target', charges: CHARGES });
  const after = L.account(L.loadState());
  assert.equal(after.ACCOUNT_EQUITY, Number((before.ACCOUNT_EQUITY + out.economics.netPnl).toFixed(2)),
    'equity must move by the realised NET pnl, nothing else');
});
test('closing an unknown position is refused, not silently created', () => {
  assert.equal(L.closePaperPosition({ id: 'nope', exitBid: 1, charges: CHARGES }).closed, false);
});
test('committed capital drops back to zero after closing', () => {
  L.closePaperPosition({ id: L.loadState().openPositions[0]?.id ?? 'x', exitBid: 1, charges: CHARGES });
  assert.equal(L.account(L.loadState()).COMMITTED_CAPITAL, 0);
});

// ─────────────────────────── report ─────────────────────────────────────
group('learning report');
test('report exposes capital, mode, and the integrity invariants', () => {
  const r = L.learningReport();
  for (const k of ['modelVersion', 'account', 'realizedNet', 'paperTrades', 'buckets', 'overallMode', 'dataIntegrity']) {
    assert.ok(k in r, `missing ${k}`);
  }
  assert.equal(r.account.invariantHolds, true);
  assert.equal(r.invariant, 'TOTAL_COMMITTED <= AVAILABLE_CAPITAL');
});
test('report never claims a live order happened', () => {
  const r = L.learningReport();
  assert.ok(!('liveOrders' in r) || r.liveOrders === 0);
  const lines = fs.readFileSync(L.LEDGER, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(lines.every((x) => x.liveOrderCount === 0 || x.liveOrderCount === undefined), 'no record may claim a live order');
});

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\nexpiry paper ledger: ${passed} passed, ${failed} failed`);
if (failed) { console.log('failed:', failures.join(' | ')); process.exit(1); }
