#!/usr/bin/env node
/**
 * Tests for the expiry EXIT MONITOR — the full paper position lifecycle.
 * Maps 1:1 to the required properties.
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'expiry-exit-'));
process.env.EXPIRY_LEDGER_DIR = TMP;
process.env.EXPIRY_EXIT_DIR = TMP;
process.env.EXPIRY_PAPER_CAPITAL = '5000';

const L = require('./expiry-paper-ledger');
const M = require('./expiry-exit-monitor');

let passed = 0; let failed = 0; const failures = [];
const queue = [];
/**
 * Collect tests and run them SEQUENTIALLY. The previous synchronous harness
 * called fn() without awaiting, so every async lifecycle test escaped: failures
 * surfaced as unhandled rejections AFTER the summary had already printed, and a
 * genuinely failing test could still be reported as passing.
 */
function test(name, fn) { queue.push({ name, fn }); }
function group(n) { console.log(`\n${n}`); }
async function runAll() {
  for (const { name, fn } of queue) {
    try { await fn(); console.log(`  ok   ${name}`); passed += 1; }
    catch (e) { console.log(`  FAIL ${name}\n       ${String(e.message).split('\n').join('\n       ')}`); failed += 1; failures.push(name); }
  }
}

const CONTRACT = { symbol: 'NSE:NIFTY26SEP22800CE', underlying: 'NIFTY50-INDEX', expiry: '2026-09-29', lotSize: 65 };
/** Age an open position so the min-hold observation window has elapsed. */
function ageBy(p, minutes) {
  const st = L.loadState();
  const pos = st.openPositions.find((x) => x.id === p.id);
  if (pos?.entry) pos.entry.entryIstMs = Date.now() - minutes * 60_000;
  L.saveState(st);
  return p;
}
const openPos = (over = {}) => L.openPaperPosition({
  ...CONTRACT, key: 'TREND|A_ORB_VWAP', regime: 'TREND', setup: 'A_ORB_VWAP', dte: 0,
  premium: 20, entryAsk: 20, stopPremium: 16, liveDataAvailable: true, view: 'BULLISH', agreementShare: 0.65, ...over,
});

/** Fresh, empty ledger. Each lifecycle test is independent — no shared state. */
function resetLedger(initialCapital = 5000) {
  fs.writeFileSync(path.join(TMP, 'learning-state.json'), JSON.stringify({
    modelVersion: 'expiry-paper-learning/v1', initialCapital,
    realizedGross: 0, realizedCharges: 0, realizedNet: 0, unrealizedNet: 0,
    openPositions: [], outcomes: [], posteriors: {},
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  }));
}

const snap = (o = {}) => ({
  ltp: 21, bid: 20.9, ask: 21.1, spreadPctOfMid: 0.95, volume: 500, openInterest: 1000,
  spot: 22800, regime: 'TREND', agreementShare: 0.66, freshnessBucket: 'FRESH', dataAgeMs: 800,
  minutesToClose: 180, ...o,
});

console.log('expiry exit monitor tests');

// ── 1, 3, 4: detection, HOLD, EXIT ────────────────────────────────────
group('monitor: detection, HOLD and EXIT decisions');
test('1. an open paper position is detected by the monitor', async () => {
  resetLedger(); openPos();
  const r = await M.monitor({ quoteFor: async () => snap() });
  assert.equal(r.openAtStart, 1);
  assert.equal(r.processed, 1);
});
test('3. dynamic decision can HOLD', async () => {
  resetLedger(); ageBy(openPos(), 5);
  const r = await M.monitor({ quoteFor: async () => snap() });
  assert.equal(r.decisions[0].action, 'HOLD');
  assert.equal(r.exits, 0);
  assert.equal(L.loadState().openPositions.length, 1, 'a HOLD must not close anything');
});
test('4. dynamic decision can EXIT (structural boundary)', async () => {
  resetLedger(); ageBy(openPos(), 5);
  const r = await M.monitor({ quoteFor: async () => snap({ ltp: 15, bid: 14.8, ask: 15.2 }) });
  assert.equal(r.decisions[0].action, 'EXIT');
  assert.equal(r.decisions[0].reason, M.EXIT_REASON.STOP);
  assert.equal(L.loadState().openPositions.length, 0, 'the position must be gone');
});
test('2. structural loss boundary triggers exactly at/under the stop', () => {
  const p = { entryAsk: 20, stopPremium: 16, mfePremium: 20, entry: { regime: 'TREND', agreementShare: 0.65, dte: 0 } };
  const at = M.decideExit({ position: p, ctx: { premium: 16, bid: 15.9, ask: 16.1, freshnessBucket: 'FRESH', regime: 'TREND', agreementShare: 0.65, minutesToClose: 200, heldMinutes: 10 } });
  assert.equal(at.action, 'EXIT');
  assert.equal(at.reason, 'STOP');
});

// ── 5: the boundary is never widened ───────────────────────────────────
group('monitor: the loss boundary is immutable');
test('5. no exit widens the original loss boundary', () => {
  const p = { entryAsk: 20, stopPremium: 16, mfePremium: 20, entry: { regime: 'TREND', agreementShare: 0.65, dte: 0 } };
  // A drawdown must still exit at the ORIGINAL stop, not a relaxed one.
  const d = M.decideExit({ position: p, ctx: { premium: 15, bid: 14.9, ask: 15.1, freshnessBucket: 'FRESH', regime: 'TREND', agreementShare: 0.65, minutesToClose: 200, heldMinutes: 5 } });
  assert.equal(d.reason, 'STOP');
  assert.equal(p.stopPremium, 16, 'the boundary itself must be untouched by the decision');
  // The decision must not carry any *proposed* boundary change. A message may
  // mention the word (it documents that the boundary is never widened), so the
  // check is structural: no replacement/proposed stop is emitted.
  assert.equal(d.newStopPremium ?? null, null, 'an exit must never propose a different boundary');
  assert.equal(d.proposedStopPremium ?? null, null);
});

// ── 6, 7, 8: economics ─────────────────────────────────────────────────
group('monitor: net economics on exit');
test('6/7/8. exit produces correct gross, charges and NET P&L', async () => {
  resetLedger(); const rec = ageBy(openPos({ key: 'ECON|test' }), 5);
  const r = await M.monitor({ quoteFor: async () => snap({ ltp: 30, bid: 29.9, ask: 30.1, minutesToClose: 5 }) });
  const closed = r.results.find((x) => x.closed && x.closed.economics)?.closed;
  assert.ok(closed, 'the position must have closed');
  const e = closed.economics;
  assert.ok(Math.abs(e.grossPnl - (29.9 - 20) * 65) < 0.01, `gross ${e.grossPnl} != ${(29.9 - 20) * 65}`);
  assert.ok(e.totalCharges > 0, 'charges must be applied');
  assert.equal(e.netPnl, Number((e.grossPnl - e.totalCharges).toFixed(2)));
  assert.ok(e.stt > 0, 'STT must be present');
});

// ── 9: capital release ─────────────────────────────────────────────────
group('monitor: capital accounting');
test('9. capital is released and the invariant holds after exit', async () => {
  resetLedger(); const rec = ageBy(openPos({ key: 'CAP|test' }), 5);
  const before = L.account(L.loadState());
  assert.ok(before.COMMITTED_CAPITAL > 0, 'entry must commit capital');
  await M.monitor({ quoteFor: async () => snap({ ltp: 30, bid: 29.9, ask: 30.1, minutesToClose: 5 }) });
  const after = L.account(L.loadState());
  assert.equal(after.COMMITTED_CAPITAL, 0, 'committed must return to zero');
  assert.equal(after.invariantHolds, true);
  assert.equal(after.AVAILABLE_CAPITAL, after.ACCOUNT_EQUITY);
});
test('9b. a single-lot REDUCE becomes an honest full exit, never a silent 0-lot', async () => {
  // The sizing path takes a 1-lot probe, so floor(1 x 50%) = 0. That must NOT
  // fall through to a partial close of zero lots, nor silently masquerade as a
  // reduce: the position exits fully and says why.
  resetLedger(); ageBy(openPos({ key: 'REDUCE1|test', premium: 20, entryAsk: 20, stopPremium: 10 }), 5);
  const r = await M.monitor({ quoteFor: async () => snap({ ltp: 20, bid: 19, ask: 21, spreadPctOfMid: 40, volume: 0 }) });
  const d = r.decisions[0];
  assert.equal(d.action, 'REDUCE', 'the DECISION is a reduce');
  // The execution result lives on the matching entry in `results`.
  const res = r.results.find((x) => x.id === d.id);
  assert.ok(res && res.closed, 'the reduce must execute somehow');
  assert.notEqual(res.closed.partial, true, 'it cannot be executed as a partial on one lot');
  assert.ok(/single-lot/.test(res.why || ''), 'the outcome must record why it exited fully');
  assert.equal(L.loadState().openPositions.length, 0);
  assert.ok(L.loadState().realizedNet !== 0, 'the realised P&L must be booked');
});
test('9c. a multi-lot REDUCE releases part of the capital and keeps the rest open', async () => {
  resetLedger();
  // Force a genuinely multi-lot position by pre-seeding it, since the sizing
  // path deliberately starts at one lot.
  const rec = ageBy(openPos({ key: 'REDUCE2|test', premium: 20, entryAsk: 20, stopPremium: 10 }), 5);
  const st = L.loadState();
  const p = st.openPositions.find((x) => x.id === rec.id);
  p.lots = 4; p.committedCapital = 4 * 20 * 65;
  L.saveState(st);
  const r = await M.monitor({ quoteFor: async () => snap({ ltp: 20, bid: 19, ask: 21, spreadPctOfMid: 40, volume: 0 }) });
  const still = L.loadState().openPositions.find((x) => x.id === rec.id);
  assert.ok(still, 'a partial close must leave a remaining position');
  assert.equal(still.lots, 2, 'half the lots remain');
  assert.ok(still.committedCapital < 4 * 20 * 65, 'partial close must release capital');
  assert.ok(L.loadState().realizedNet !== 0, 'partial close realises P&L');
});

// ── 10: no learning before an actual close ─────────────────────────────
group('monitor: the accounting rule — no learning before close');
test('10. posterior updates ONLY after an actual close', async () => {
  resetLedger(); const rec = ageBy(openPos({ key: 'LEARN|test' }), 5);
  const bucketBefore = L.loadState().posteriors['LEARN|test'];
  assert.ok(!bucketBefore, 'no posterior before any close');
  // Mark repeatedly with a large unrealized gain — it must NOT train the model.
  for (let i = 0; i < 5; i += 1) {
    await M.monitor({ quoteFor: async () => snap({ ltp: 60, bid: 59.9, ask: 60.1 }) });
  }
  const mid = L.loadState();
  assert.ok(!mid.posteriors['LEARN|test'], 'an OPEN position must never update the posterior');
  assert.ok(mid.outcomes.length === 0, 'an open position is not an outcome');
  assert.ok(mid.unrealizedNet > 0, 'unrealized P&L is still reported');
  const st = L.loadState().openPositions.find((x) => x.id === rec.id);
  assert.ok(st.mfePremium >= 60, 'MFE must track the unrealized high');
});

// ── 11, 12: wins and losses both train ────────────────────────────────
group('monitor: losses and wins are both training data');
test('11. a losing trade updates learning correctly', async () => {
  resetLedger(); ageBy(openPos({ key: 'LOSE|test' }), 5);
  await M.monitor({ quoteFor: async () => snap({ ltp: 14, bid: 13.8, ask: 14.2 }) });
  const s = L.loadState();
  const p = s.posteriors['LOSE|test'];
  assert.ok(p && p.n === 1);
  assert.equal(p.beta, 2, 'a loss raises beta');
  assert.equal(p.alpha, 1, 'a loss does not raise alpha');
});
test('12. a winning trade updates learning correctly', async () => {
  resetLedger(); ageBy(openPos({ key: 'WIN|test' }), 5);
  await M.monitor({ quoteFor: async () => snap({ ltp: 40, bid: 39.9, ask: 40.1, minutesToClose: 3 }) });
  const p = L.loadState().posteriors['WIN|test'];
  assert.ok(p && p.n === 1);
  assert.equal(p.alpha, 2, 'a win raises alpha');
  assert.equal(p.beta, 1);
});

// ── 13: end of session ─────────────────────────────────────────────────
group('monitor: end-of-session handling');
test('13. end-of-session positions exit explicitly with END_OF_SESSION/TIME label', async () => {
  resetLedger(); ageBy(openPos({ key: 'EOS|test' }), 5);
  const r = await M.monitor({ quoteFor: async () => snap({ ltp: 22, bid: 21.9, ask: 22.1, minutesToClose: 5 }) });
  const d = r.decisions[0];
  assert.equal(d.action, 'EXIT');
  assert.ok([M.EXIT_REASON.TIME_EXPIRY_EFFECT, M.EXIT_REASON.END_OF_SESSION].includes(d.reason));
  assert.equal(L.loadState().openPositions.length, 0, 'nothing may silently carry past the close');
});

// ── 14: duplicate exit impossible ─────────────────────────────────────
group('monitor: idempotency');
test('14. a duplicate exit cannot occur', async () => {
  resetLedger(); const rec = ageBy(openPos({ key: 'DUP|test' }), 5);
  const q = async () => snap({ ltp: 10, bid: 9.8, ask: 10.2 });
  const r1 = await M.monitor({ quoteFor: q });
  const r2 = await M.monitor({ quoteFor: q });
  assert.equal(r1.exits, 1);
  assert.equal(r2.exits, 0, 'a closed position cannot be closed again');
  assert.equal(r2.openAtStart, 0);
  const outcomes = L.loadState().outcomes.filter((o) => o.id === rec.id);
  assert.equal(outcomes.length, 1, 'exactly one outcome per position');
});

// ── 15: no live order ever ─────────────────────────────────────────────
group('monitor: safety');
test('15. no live order can ever be generated', async () => {
  resetLedger(); ageBy(openPos({ key: 'LIVE|test' }), 5);
  const r = await M.monitor({ quoteFor: async () => snap({ ltp: 5, bid: 4.9, ask: 5.1 }) });
  assert.equal(r.safety.canPlaceOrder, false);
  assert.equal(r.safety.LIVE_EXECUTION, 'DISABLED');
  const lines = fs.readFileSync(L.LEDGER, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(lines.every((x) => x.liveOrderCount === 0 || x.liveOrderCount === undefined));
});
test('15b. a stale quote never produces a fill', async () => {
  resetLedger(); ageBy(openPos({ key: 'STALE|test' }), 5);
  const r = await M.monitor({ quoteFor: async () => snap({ freshnessBucket: 'STALE', dataAgeMs: 900000 }) });
  assert.equal(r.decisions[0].action, 'HOLD');
  assert.ok(r.decisions[0].blockedBy);
  assert.equal(L.loadState().openPositions.length, 1, 'a stale quote must not close a position');
});
test('15c. a missing quote produces a HOLD, not a fabricated exit', async () => {
  resetLedger(); ageBy(openPos({ key: 'NOQUOTE|test' }), 5);
  const r = await M.monitor({ quoteFor: async () => null });
  assert.equal(r.decisions[0].action, 'HOLD');
  assert.equal(r.decisions[0].blockedBy, 'NO_LIVE_QUOTE');
  assert.equal(r.blockedNoQuote, 1);
  assert.equal(L.loadState().openPositions.length, 1);
});

// ── 17, 18: no reintroduced static limits ──────────────────────────────
group('monitor: no static limits reintroduced');
test('17. DTE=0 remains a feature, not a veto', () => {
  // Fresh state: earlier lifecycle tests deliberately spend capital, and the
  // sizing path is bounded by AVAILABLE_CAPITAL, so a shared ledger can make
  // an unrelated position unaffordable.
  resetLedger();
  openPos({ key: 'DTE0|test', dte: 0 });
  const p = L.loadState().openPositions.find((x) => x.key === 'DTE0|test');
  assert.ok(p, 'the DTE=0 position must be open for this check');
  assert.equal(p.entry.dte, 0);
  const d = M.decideExit({ position: p, ctx: { premium: 21, bid: 20.9, ask: 21.1, freshnessBucket: 'FRESH', regime: 'TREND', agreementShare: 0.65, minutesToClose: 200, heldMinutes: 5 } });
  assert.equal(d.action, 'HOLD', 'DTE=0 alone must not force an exit');
});
test('18. sizing remains bounded only by AVAILABLE_CAPITAL', () => {
  const state = L.loadState();
  const s = L.sizePaperPosition({ state, key: 'X', premium: 20, lotSize: 65, entryAsk: 20, stopPremium: 16, liveDataAvailable: true });
  if (s.allowed) assert.ok(s.committedCapital <= s.account.AVAILABLE_CAPITAL + 1e-9);
  const r = L.learningReport();
  assert.equal(r.invariant, 'TOTAL_COMMITTED <= AVAILABLE_CAPITAL');
  assert.equal(r.account.invariantHolds, true);
});

// ── Regression: unreported volume is not a liquidity signal ───────────
group('monitor: missing data is not an exit signal');
test('unreported volume (FYERS carries 0 on every tick) does NOT force an exit', async () => {
  resetLedger(); ageBy(openPos({ key: 'NOVOL|test' }), 5);
  // volume: null/0 with volumeReported false is exactly what FYERS delivers.
  const r = await M.monitor({
    quoteFor: async () => snap({ volume: 0, volumeReported: false }),
  });
  assert.equal(r.decisions[0].action, 'HOLD',
    'a feed that does not report volume must not be read as an untradeable contract');
  assert.equal(L.loadState().openPositions.length, 1, 'the position must stay open');
});
test('REPORTED zero volume still exits for liquidity', async () => {
  resetLedger(); ageBy(openPos({ key: 'VOL0|test' }), 5);
  const r = await M.monitor({
    quoteFor: async () => snap({ volume: 0, volumeReported: true }),
  });
  assert.equal(r.decisions[0].action, 'REDUCE');
  assert.equal(r.decisions[0].reason, M.EXIT_REASON.LIQUIDITY_DETERIORATION);
});
test('a wide spread is still honoured as liquidity evidence', async () => {
  resetLedger(); ageBy(openPos({ key: 'WIDE|test' }), 5);
  const r = await M.monitor({
    quoteFor: async () => snap({ ltp: 25, bid: 17, ask: 33, spreadPctOfMid: 64, volume: 0, volumeReported: false }),
  });
  assert.equal(r.decisions[0].action, 'REDUCE');
  assert.equal(r.decisions[0].reason, M.EXIT_REASON.LIQUIDITY_DETERIORATION);
});
test('a tight two-sided quote is treated as tradeable evidence', () => {
  const p = { entryAsk: 20, stopPremium: 16, mfePremium: 21, entry: { regime: 'TREND', agreementShare: 0.65, dte: 3 } };
  const d = M.decideExit({ position: p, ctx: {
    premium: 20.5, bid: 20.4, ask: 20.6, spreadPctOfMid: 0.98, freshnessBucket: 'FRESH',
    volume: 0, volumeReported: false, regime: 'TREND', agreementShare: 0.65,
    minutesToClose: 180, minutesSinceEntry: 10,
  } });
  assert.equal(d.action, 'HOLD');
  assert.notEqual(d.reason, M.EXIT_REASON.LIQUIDITY_DETERIORATION);
});

runAll().then(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\nexpiry exit monitor: ${passed} passed, ${failed} failed`);
  if (failed) { console.log('failed:', failures.join(' | ')); process.exit(1); }
});
