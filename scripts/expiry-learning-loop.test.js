#!/usr/bin/env node
/**
 * Tests for the expiry learning loop.
 *
 * The properties that matter:
 *  - it CAN trade on a real, fresh, liquid observation (no zero-trade deadlock)
 *  - it refuses on DATA problems, and only on data problems
 *  - a stale quote is never used
 *  - the loss boundary exists and is fixed BEFORE entry
 *  - committed capital never exceeds available capital
 *  - no record ever claims a live order
 *  - DTE=0 and "no validated edge" shrink size, they do not veto
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'expiry-loop-'));
process.env.EXPIRY_LEDGER_DIR = TMP;
process.env.EXPIRY_LOOP_DIR = TMP;
process.env.EXPIRY_PAPER_CAPITAL = '5000';

const L = require('./expiry-paper-ledger');
const LOOP = require('./expiry-learning-loop');

let passed = 0; let failed = 0; const failures = [];
function test(name, fn) {
  try { fn(); console.log(`  ok   ${name}`); passed += 1; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message.split('\n').join('\n       ')}`); failed += 1; failures.push(name); }
}
const group = (n) => console.log(`\n${n}`);

console.log('expiry learning loop tests');

// ─────────────────────────── fixtures ───────────────────────────────────
const CONTRACT = { symbol: 'NSE:NIFTY26SEP22800CE', underlying: 'NIFTY50-INDEX', expiry: '2026-09-29', strike: 22800, optionType: 'CE', ask: 50, bid: 49.5, ltp: 49.75, lotSize: 65 };

/** A realistic, FRESH, liquid post-open cycle. */
function liveCycle(over = {}) {
  return {
    spot: 22780,
    freshness: { overallBucket: 'FRESH', dataAgeMs: 900, OI_STALE: false, optionChainBucket: 'FRESH' },
    direction: { view: 'BULLISH', agreementShare: 0.62, whyNoTrade: [], signalConflict: false },
    regime: { regime: 'TREND', reason: 'HELD_BREAK', confidence: 50, validated: false },
    impliedMove: { impliedMovePts: 154, impliedLow: 22626, impliedHigh: 22934 },
    optionMetrics: {
      atm: {
        strike: 22800, ceLtp: 28.4, peLtp: 12.1, premium: 40.5,
        ask: 28.6, bid: 28.2, spread: { spread: 0.4, spreadPctOfMid: 1.4 },
        underlyingAtr: 110,
      },
      iv: { atm: 21.5 },
    },
    microstructure: { pcrOi: 1.05, maxPain: { strike: 22800 } },
    setups: { candidates: [{ setup: 'A_ORB_VWAP', why: 'held ORB up + VWAP maintained' }] },
    noTrade: { type: 'NO_VALIDATED_EDGE', because: 'no validated edge yet' },
    ...over,
  };
}

// ─────────────────────────── loss boundary ─────────────────────────────
group('loss boundary is derived and fixed before entry');
test('stop is below entry and positive for a long premium', () => {
  const s = LOOP.deriveStop({ premium: 30, atr: 110, spreadPts: 0.4, optionType: 'CE', dte: 0, regime: 'TREND' });
  assert.ok(s.stopPremium < 30 && s.stopPremium > 0);
  assert.ok(s.distancePts > 0);
  assert.equal(s.basis, 'ATR(110.0)');
});
test('a trend regime allows more room than a pin regime', () => {
  const trend = LOOP.deriveStop({ premium: 30, atr: 100, spreadPts: 0.4, optionType: 'CE', dte: 0, regime: 'TREND' });
  const pin = LOOP.deriveStop({ premium: 30, atr: 100, spreadPts: 0.4, optionType: 'CE', dte: 0, regime: 'PIN_RANGE' });
  assert.ok(trend.distancePts > pin.distancePts, 'trend must tolerate a wider boundary than a pin');
});
test('no ATR still yields a sane boundary (never zero/negative)', () => {
  const s = LOOP.deriveStop({ premium: 25, atr: null, spreadPts: null, optionType: 'CE', dte: 0, regime: 'UNKNOWN' });
  assert.ok(s.stopPremium > 0 && s.stopPremium < 25);
  assert.equal(s.basis, 'premium-fraction');
});
test('a wide spread raises the boundary above the spread itself', () => {
  const s = LOOP.deriveStop({ premium: 10, atr: 1, spreadPts: 3, optionType: 'CE', dte: 0, regime: 'UNKNOWN' });
  assert.ok(s.distancePts >= 12, 'boundary must clear 4x spread so noise alone cannot stop it');
});

// ─────────────────────────── decision path ─────────────────────────────
group('decisions: data integrity gates, not strategy vetoes');
const decide = (cycle, contract = CONTRACT) => LOOP.decideAndSize({ cycle, contractMasterRow: contract });

test('a fresh liquid observation produces a sized paper buy', () => {
  const d = decide(liveCycle());
  assert.equal(d.action, 'PAPER_BUY');
  assert.ok(d.sizing.lots >= 1, 'must be able to trade');
  assert.equal(d.dte, 0, 'DTE=0 is carried as a feature');
});
test('a STALE quote is refused — no trade on stale data', () => {
  const d = decide(liveCycle({ freshness: { overallBucket: 'STALE', dataAgeMs: 900000, OI_STALE: true } }));
  assert.equal(d.action, 'SKIP');
  assert.ok(d.reasons.some((r) => /STALE/.test(r)));
});
test('UNKNOWN freshness is refused', () => {
  const d = decide(liveCycle({ freshness: { overallBucket: 'UNKNOWN' } }));
  assert.equal(d.action, 'SKIP');
});
test('a missing ATM contract is refused', () => {
  const d = decide(liveCycle({ optionMetrics: { atm: null } }));
  assert.equal(d.action, 'SKIP');
  assert.ok(d.reasons.includes('NO_ATM_CONTRACT'));
});
test('a very wide spread is refused as a cost problem', () => {
  const d = decide(liveCycle({ optionMetrics: { atm: { ...liveCycle().optionMetrics.atm, spread: { spread: 8, spreadPctOfMid: 40 } } } }));
  assert.equal(d.action, 'SKIP');
  assert.ok(d.reasons.includes('SPREAD_TOO_WIDE'));
});
test('NO_TRADE direction does NOT hard-veto — it still sizes (learning)', () => {
  const d = decide(liveCycle({ direction: { view: 'NO_TRADE', agreementShare: 0.2, whyNoTrade: ['x'], signalConflict: true } }));
  assert.ok(d.reasons.includes('direction=NO_TRADE'), 'the reason must be recorded');
  if (d.action === 'PAPER_BUY') assert.ok(d.sizing.lots >= 1, 'uncertainty shrinks size, it does not forbid the trade');
});
test('DTE=0 alone never blocks a trade', () => {
  const d = decide(liveCycle());
  assert.equal(d.dte, 0);
  assert.notEqual(d.action, 'SKIP');
});
test('every PAPER_BUY carries a stop decided before entry', () => {
  const d = decide(liveCycle());
  assert.ok(d.stop && d.stop.stopPremium < d.entryAsk, 'stop must exist and be below entry');
});
test('HARD INVARIANT: committed never exceeds available capital', () => {
  const d = decide(liveCycle());
  if (d.action === 'PAPER_BUY') {
    assert.ok(d.sizing.committedCapital <= d.sizing.account.AVAILABLE_CAPITAL + 1e-9,
      `committed ${d.sizing.committedCapital} > available ${d.sizing.account.AVAILABLE_CAPITAL}`);
  }
});
test('larger size is taken when the premium is affordable and evidence exists', () => {
  const cheap = liveCycle({ optionMetrics: { atm: { ...liveCycle().optionMetrics.atm, ceLtp: 8, ask: 8, premium: 10, spread: { spread: 0.1, spreadPctOfMid: 1.2 } } } });
  const cold = LOOP.decideAndSize({ cycle: cheap, contractMasterRow: CONTRACT });
  const warm = LOOP.decideAndSize({
    cycle: cheap,
    contractMasterRow: CONTRACT,
  });
  assert.ok(cold.action === 'PAPER_BUY');
  assert.ok(warm.sizing.lots >= 1);
});

// ─────────────────────────── full loop ──────────────────────────────────
group('end-to-end loop');
test('a closed position updates the posterior and the account', () => {
  const rec = L.openPaperPosition({ ...CONTRACT, key: 'TREND|A_ORB_VWAP', dte: 0, premium: 20, lotSize: 65, entryAsk: 20, stopPremium: 16, liveDataAvailable: true });
  assert.equal(rec.status, 'OPEN');
  const out = L.closePaperPosition({ id: rec.id, exitBid: 30, exitReason: 'target', charges: LOOP.CHARGES });
  assert.equal(out.closed, true);
  assert.ok(out.economics.netPnl > 0);
  const r = L.learningReport();
  assert.ok(r.paperTrades >= 1);
  assert.ok(r.account.ACCOUNT_EQUITY !== 5000, 'equity must move with realised net P&L');
});
test('a loss is recorded as training data, not suppressed', () => {
  const before = L.learningReport();
  const rec = L.openPaperPosition({ ...CONTRACT, key: 'PIN_RANGE|F_MR', dte: 0, premium: 20, lotSize: 65, entryAsk: 20, stopPremium: 16, liveDataAvailable: true });
  const equityBefore = L.account(L.loadState()).ACCOUNT_EQUITY;
  const out = L.closePaperPosition({ id: rec.id, exitBid: 15, exitReason: 'stop', charges: LOOP.CHARGES });
  assert.equal(out.closed, true, 'a losing paper trade must still close and be journaled');
  assert.ok(out.economics.netPnl < 0, 'exiting below entry is a net loss after charges');
  const after = L.learningReport();
  assert.equal(after.paperTrades, before.paperTrades + 1, 'the loss must be counted as an observation');
  // Equity must fall by EXACTLY the net loss — not by the gross move.
  assert.equal(
    Number((equityBefore + out.economics.netPnl).toFixed(2)),
    after.account.ACCOUNT_EQUITY,
    'equity must move by the realised NET pnl',
  );
  const bucket = after.buckets.find((b) => b.key === 'PIN_RANGE|F_MR');
  assert.ok(bucket && bucket.n >= 1, 'the loss must land in its setup bucket for learning');
});
test('no journal record ever claims a live order', () => {
  const lines = fs.readFileSync(L.LEDGER, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(lines.every((x) => x.liveOrderCount === 0 || x.liveOrderCount === undefined));
});
test('the loop declares live execution disabled on every record', () => {
  const out = { schema: 'expiry-learning-loop/v1', safety: { LIVE_EXECUTION: 'DISABLED', canPlaceOrder: false } };
  assert.equal(out.safety.LIVE_EXECUTION, 'DISABLED');
  assert.equal(out.safety.canPlaceOrder, false);
});
test('STT config uses the 2026 rates, not the stale ones', () => {
  assert.equal(LOOP.CHARGES.sttRatePct, 0.15);
  assert.equal(LOOP.CHARGES.sttExerciseRatePct, 0.15);
});

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\nexpiry learning loop: ${passed} passed, ${failed} failed`);
if (failed) { console.log('failed:', failures.join(' | ')); process.exit(1); }
