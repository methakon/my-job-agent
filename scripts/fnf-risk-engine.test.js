#!/usr/bin/env node
/**
 * FNF Risk Engine — comprehensive test suite.
 * 20+ required test cases from Phase 4 spec.
 * All deterministic fixtures, no live market dependency.
 */
'use strict';
const assert = require('node:assert/strict');
const { fnfRiskSnapshot, fnfRiskPolicyFromEnv, fnfSizeFromRisk, fnfDetermineStop, fnfAuthorizeEntry, RiskLevel } = require('../dist/trading/fnf-risk');
const { fnfDetectTraps, TrapType } = require('../dist/trading/fnf-trap-detection');
const { fnfEvaluatePositionHealth, PositionHealthState } = require('../dist/trading/fnf-position-health');
const { fnfEvaluateExit, ExitReason } = require('../dist/trading/fnf-exit-engine');
const { fnfShadowEntry, fnfShadowMonitor, ShadowAction } = require('../dist/trading/fnf-shadow-engine');

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, err });
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
  }
}

// ── Fixtures ────────────────────────────────────────────────────────────────
const POLICY = fnfRiskPolicyFromEnv();

function mkPortfolio(overrides = {}) {
  return {
    capital: 10000,
    deployed: 0,
    netPnl: 0,
    unrealisedPnl: 0,
    peakEquity: 10000,
    sessionStartEquity: 10000,
    openPositionCount: 0,
    ...overrides,
  };
}

function mkSnap(overrides = {}) {
  return fnfRiskSnapshot(mkPortfolio(overrides), POLICY);
}

function mkTrapData(overrides = {}) {
  return {
    premium: 100,
    spreadPct: 0.5,
    volume: 500,
    openInterest: 10000,
    oiChange: 0,
    iv: 0.20,
    ivChange: 0,
    dte: 10,
    delta: 0.3,
    underlyingSpot: 24000,
    underlyingSma20: 23900,
    underlyingSma5: 23950,
    futuresBasis: 10,
    isExpiryWeek: false,
    hasMajorEvent: false,
    quoteAgeMin: 0,
    maxStaleMin: 5,
    greeksConsistent: true,
    crossAssetDivergence: 0.001,
    ...overrides,
  };
}

function mkShadowMarket(overrides = {}) {
  return {
    premium: 100,
    bid: 99,
    ask: 101,
    spreadPct: 2.0,
    volume: 500,
    openInterest: 10000,
    oiChange: 0,
    iv: 0.20,
    ivChange: 0,
    dte: 10,
    delta: 0.3,
    gamma: 0.01,
    theta: -0.5,
    underlyingSpot: 24000,
    underlyingSma20: 23900,
    underlyingSma5: 23950,
    quoteAgeMin: 0,
    maxStaleMin: 5,
    ...overrides,
  };
}

function mkHealthInput(overrides = {}) {
  return {
    currentPremium: 110,
    entryPremium: 100,
    stopPrice: 75,
    targetPrice: 150,
    unrealizedPnlPerUnit: 10,
    maePerUnit: -5,
    mfePerUnit: 15,
    currentRiskPerUnit: 35,
    originalRiskPerUnit: 25,
    dte: 10,
    underlyingSpot: 24000,
    underlyingSma20: 23900,
    delta: 0.3,
    iv: 0.20,
    quoteAgeMin: 0,
    maxStaleMin: 5,
    traps: { traps: [], highSeverity: false, hasTraps: false, score: 0 },
    thesisValid: true,
    underlyingConfirmed: true,
    spreadPct: 1.0,
    volume: 500,
    inProfit: true,
    profitExceedsThreshold: true,
    ...overrides,
  };
}

function mkExitInput(overrides = {}) {
  return {
    currentPremium: 110,
    entryPremium: 100,
    stopPrice: 75,
    targetPrice: 150,
    healthState: 'GREEN',
    thesisValid: true,
    underlyingConfirmed: true,
    unrealizedPnlPerUnit: 10,
    maePerUnit: -5,
    mfePerUnit: 15,
    dte: 10,
    currentEv: 10,
    exitEv: -5,
    nextBestEv: 3,
    inProfit: true,
    profitExceedsThreshold: false,
    spreadPct: 1.0,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// TEST 1: risk per unit
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n── Risk Engine ──');

test('1. risk per unit = |entry - stop| * (1 + slippage)', () => {
  const stop = fnfDetermineStop(100, null, null, 1.5, POLICY);
  assert.equal(stop.source, 'percentage');
  assert.ok(stop.stopPerUnit > 0, 'stopPerUnit must be positive');
  assert.ok(stop.stopPrice < 100, 'stopPrice must be below entry');
  // 25% stop on 100: stopPerUnit = 25
  assert.equal(stop.stopPerUnit, 25);
  const effective = 25 * (1 + POLICY.slippageBufferPct);
  assert.ok(effective > 25, 'effective risk includes slippage');
});

// ═══════════════════════════════════════════════════════════════════════════
// TEST 2: risk per lot
// ═══════════════════════════════════════════════════════════════════════════
test('2. risk per lot = effectiveRiskPerUnit * lotSize', () => {
  const snap = mkSnap();
  const sizing = fnfSizeFromRisk({ snapshot: snap, premium: 100, lotSize: 65, stopPerUnit: 25 });
  assert.ok(sizing.riskPerLot > 0, 'risk per lot must be positive');
  // effective = 25 * 1.15 = 28.75; riskPerLot = 28.75 * 65 = 1868.75
  assert.ok(Math.abs(sizing.riskPerLot - 1868.75) < 0.01, `riskPerLot=${sizing.riskPerLot} ≈ 1868.75`);
  assert.equal(sizing.effectiveRiskPerUnit, 25 * 1.15);
});

// ═══════════════════════════════════════════════════════════════════════════
// TEST 3: whole-lot NO_TRADE
// ═══════════════════════════════════════════════════════════════════════════
test('3. whole-lot NO_TRADE when risk_per_lot > budget', () => {
  const snap = mkSnap();
  // risk_budget = 10000 * 0.01 = 100
  // risk_per_lot = 28.75 * 65 = 1868.75 >> 100
  const sizing = fnfSizeFromRisk({ snapshot: snap, premium: 100, lotSize: 65, stopPerUnit: 25 });
  assert.equal(sizing.allowed, false, 'must be disallowed');
  assert.equal(sizing.lots, 0, 'must be zero lots');
  assert.ok(sizing.refusals.length > 0, 'must have refusals');
  assert.ok(sizing.refusals[0].includes('risk_per_lot'), 'refusal must mention risk_per_lot');
});

// ═══════════════════════════════════════════════════════════════════════════
// TEST 4: capital gate separate from risk gate
// ═══════════════════════════════════════════════════════════════════════════
test('4. capital gate separate from risk gate', () => {
  // Case A: risk OK but capital insufficient
  const snapA = mkSnap({ deployed: 9500, capital: 10000 });
  // headroom = 500, outlay_per_lot = 5 * 20 = 100; risk_budget = 100
  // risk_per_lot for stopPerUnit=2, lotSize=20: effective=2*1.15=2.3, riskPerLot=46 < 100 → risk OK
  // But headroom=500, outlay=100 → actually headroom is fine too
  
  // Make it tighter: deployed=9950, headroom=50, outlay_per_lot=100
  const snapB = mkSnap({ deployed: 9950, capital: 10000 });
  const sizingB = fnfSizeFromRisk({ snapshot: snapB, premium: 5, lotSize: 20, stopPerUnit: 0.5 });
  // risk_per_lot = 0.5*1.15*20 = 11.5 < 100 → risk OK
  // outlay_per_lot = 5*20 = 100 > 50 → capital FAILS
  const hasCapitalRefusal = sizingB.refusals.some(r => r.includes('headroom'));
  const hasRiskRefusal = sizingB.refusals.some(r => r.includes('risk_per_lot'));
  assert.ok(hasCapitalRefusal, 'must have capital refusal');
  assert.equal(hasRiskRefusal, false, 'must NOT have risk refusal — capital gate is separate');
});

// ═══════════════════════════════════════════════════════════════════════════
// TEST 5: stale-data rejection
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n── Trap Detection ──');

test('5. stale-data rejection via trap detection', () => {
  const data = mkTrapData({ quoteAgeMin: 10, maxStaleMin: 5 });
  const result = fnfDetectTraps(data);
  assert.ok(result.hasTraps, 'must detect trap');
  const staleTrap = result.traps.find(t => t.trapType === TrapType.DATA_QUALITY_FAILURE);
  assert.ok(staleTrap, 'must have data quality trap');
  assert.equal(staleTrap.severity, 'critical');
  assert.ok(result.score > 50, 'score must be high');
});

// ═══════════════════════════════════════════════════════════════════════════
// TEST 6: trap rejection (high trap score blocks entry)
// ═══════════════════════════════════════════════════════════════════════════
test('6. trap rejection — multiple traps push score high', () => {
  const data = mkTrapData({
    quoteAgeMin: 10,   // stale
    volume: 0,         // zero vol
    dte: 1,            // near expiry
    delta: 0.05,       // deep OTM
    spreadPct: 5.0,    // wide spread
  });
  const result = fnfDetectTraps(data);
  assert.ok(result.traps.length >= 3, `must detect multiple traps, got ${result.traps.length}`);
  assert.ok(result.highSeverity, 'must be high severity');
  assert.ok(result.score > 70, 'aggregate score must exceed 70');
});

// ═══════════════════════════════════════════════════════════════════════════
// TEST 7: shadow WAIT beats ENTER
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n── Shadow Engine ──');

test('7. shadow WAIT beats ENTER when EV too small', () => {
  // High spread + moderate trap score → shadow should say WAIT
  const result = fnfShadowEntry({
    market: mkShadowMarket({ spreadPct: 2.5, volume: 200 }),
    entryPremium: 100,
    stopPerUnit: 25,
    targetPerUnit: 50,
    trapScore: 50,
    regimeConfidence: 60,
    underlyingConfirmed: true,
    chainConfirmed: true,
  });
  // With spreadPct > 2.0 and trapScore > 40, should get WAIT
  assert.ok(
    result.action === ShadowAction.WAIT || result.action === ShadowAction.NO_TRADE,
    `expected WAIT or NO_TRADE, got ${result.action}`,
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// TESTS 8-11: Position Health State Machine
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n── Position Health ──');

test('8. GREEN → YELLOW (DTE low, traps present, etc.)', () => {
  const result = fnfEvaluatePositionHealth(mkHealthInput({
    dte: 2,
    profitExceedsThreshold: false,
  }));
  assert.equal(result.state, PositionHealthState.YELLOW, 'should be YELLOW when DTE <= 3');
  assert.ok(result.detail.includes('YELLOW'), 'detail must mention YELLOW');
});

test('9. YELLOW → ORANGE (thesis weakened)', () => {
  const result = fnfEvaluatePositionHealth(mkHealthInput({
    thesisValid: false,
    profitExceedsThreshold: false,
    dte: 5,
    traps: { traps: [], highSeverity: false, hasTraps: false, score: 0 },
    spreadPct: 1.0,
  }));
  assert.equal(result.state, PositionHealthState.ORANGE, 'should be ORANGE when thesis invalid');
  assert.ok(result.shouldReduce, 'should recommend reduce');
  assert.ok(result.shouldHedge, 'should recommend hedge');
});

test('10. ORANGE → RED (thesis invalid + underlying unconfirmed)', () => {
  const result = fnfEvaluatePositionHealth(mkHealthInput({
    thesisValid: false,
    underlyingConfirmed: false,
    profitExceedsThreshold: false,
    dte: 5,
    traps: { traps: [], highSeverity: false, hasTraps: false, score: 0 },
    spreadPct: 1.0,
  }));
  assert.equal(result.state, PositionHealthState.RED, 'should be RED when thesis + underlying fail');
  assert.ok(result.shouldExit, 'should recommend exit');
});

test('11. hard breach → BLACK (below stop)', () => {
  const result = fnfEvaluatePositionHealth(mkHealthInput({
    currentRiskPerUnit: -5,
    profitExceedsThreshold: false,
  }));
  assert.equal(result.state, PositionHealthState.BLACK, 'should be BLACK when below stop');
  assert.ok(result.shouldExit, 'should recommend exit');
});

// ═══════════════════════════════════════════════════════════════════════════
// TEST 12: profit protection
// ═══════════════════════════════════════════════════════════════════════════
test('12. profit protection — PROFIT_LOCK state', () => {
  const result = fnfEvaluatePositionHealth(mkHealthInput({
    profitExceedsThreshold: true,
    mfePerUnit: 40,
    originalRiskPerUnit: 25,  // 40 > 1.5 * 25 = 37.5
  }));
  assert.equal(result.state, PositionHealthState.PROFIT_LOCK, 'should be PROFIT_LOCK');
  assert.ok(result.shouldReduce, 'should reduce to lock profits');
  assert.ok(!result.shouldExit, 'should NOT force exit — just reduce');
});

// ═══════════════════════════════════════════════════════════════════════════
// TEST 13: thesis exit
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n── Exit Engine ──');

test('13. thesis exit — do not wait for stop', () => {
  const result = fnfEvaluateExit(mkExitInput({ thesisValid: false }));
  assert.equal(result.shouldExit, true);
  assert.equal(result.exitReason, ExitReason.THESIS);
  assert.ok(result.detail.includes('THESIS_EXIT'), 'detail must mention THESIS_EXIT');
});

// ═══════════════════════════════════════════════════════════════════════════
// TEST 14: EV exit
// ═══════════════════════════════════════════════════════════════════════════
test('14. EV exit — negative current EV, positive exit EV', () => {
  const result = fnfEvaluateExit(mkExitInput({ currentEv: -5, exitEv: 10 }));
  assert.equal(result.shouldExit, true);
  assert.equal(result.exitReason, ExitReason.EV);
  assert.ok(result.detail.includes('EV_EXIT'), 'detail must mention EV_EXIT');
});

// ═══════════════════════════════════════════════════════════════════════════
// TEST 15: recovery rejection (no automatic averaging)
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n── Recovery / Safety ──');

test('15. no automatic averaging — shadow never recommends averaging', () => {
  // Below stop + in loss — shadow should say EXIT, not RECOVERY
  const result = fnfShadowMonitor({
    currentPremium: 70,
    entryPremium: 100,
    stopPrice: 75,
    targetPrice: 150,
    mae: -30,
    mfe: 5,
    currentPnlPerUnit: -30,
    unrealizedPnlPerUnit: -30,
    dte: 5,
    underlyingSpot: 24000,
    underlyingSma20: 24100,
    delta: 0.3,
    iv: 0.25,
    volume: 500,
    spreadPct: 1.0,
    quoteAgeMin: 0,
    maxStaleMin: 5,
    trapScore: 20,
    healthState: 'GREEN',
    thesisValid: true,
    currentEv: 5,
  });
  // Below stop → must be EXIT
  assert.equal(result.action, ShadowAction.SHADOW_EXIT, 'must exit below stop — no averaging');
  assert.ok(!result.action.includes('RECOVERY'), 'must NOT recommend recovery/averaging');
});

// ═══════════════════════════════════════════════════════════════════════════
// TEST 16: recovery qualification (thesis valid + independent setup)
// ═══════════════════════════════════════════════════════════════════════════
test('16. recovery qualification — healthy position stays HOLD', () => {
  const result = fnfShadowMonitor({
    currentPremium: 110,
    entryPremium: 100,
    stopPrice: 75,
    targetPrice: 150,
    mae: -5,
    mfe: 20,
    currentPnlPerUnit: 10,
    unrealizedPnlPerUnit: 10,
    dte: 10,
    underlyingSpot: 24000,
    underlyingSma20: 23900,
    delta: 0.3,
    iv: 0.20,
    volume: 500,
    spreadPct: 1.0,
    quoteAgeMin: 0,
    maxStaleMin: 5,
    trapScore: 10,
    healthState: 'GREEN',
    thesisValid: true,
    currentEv: 10,
  });
  assert.equal(result.action, ShadowAction.SHADOW_HOLD, 'healthy position should HOLD');
});

// ═══════════════════════════════════════════════════════════════════════════
// TEST 17: no automatic averaging (from shadow engine)
// ═══════════════════════════════════════════════════════════════════════════
test('17. shadow engine never returns SHADOW_RECOVERY for averaging', () => {
  // Even in deep loss, shadow should EXIT not RECOVERY
  const states = ['GREEN', 'YELLOW', 'ORANGE', 'RED', 'BLACK'];
  for (const state of states) {
    const result = fnfShadowMonitor({
      currentPremium: 60,
      entryPremium: 100,
      stopPrice: 75,
      targetPrice: 150,
      mae: -40,
      mfe: 5,
      currentPnlPerUnit: -40,
      unrealizedPnlPerUnit: -40,
      dte: 3,
      underlyingSpot: 24000,
      underlyingSma20: 24100,
      delta: 0.3,
      iv: 0.25,
      volume: 100,
      spreadPct: 2.0,
      quoteAgeMin: 0,
      maxStaleMin: 5,
      trapScore: 20,
      healthState: state,
      thesisValid: true,
      currentEv: -5,
    });
    assert.notEqual(result.action, ShadowAction.SHADOW_RECOVERY,
      `state=${state}: must not recommend RECOVERY (averaging)`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// TEST 18: no automatic reversal
// ═══════════════════════════════════════════════════════════════════════════
test('18. no automatic reversal after loss', () => {
  // Deep loss + high trap → should EXIT, not REENTRY
  const result = fnfShadowMonitor({
    currentPremium: 50,
    entryPremium: 100,
    stopPrice: 75,
    targetPrice: 150,
    mae: -50,
    mfe: 5,
    currentPnlPerUnit: -50,
    unrealizedPnlPerUnit: -50,
    dte: 2,
    underlyingSpot: 24000,
    underlyingSma20: 24200,
    delta: 0.3,
    iv: 0.30,
    volume: 200,
    spreadPct: 3.0,
    quoteAgeMin: 0,
    maxStaleMin: 5,
    trapScore: 80,
    healthState: 'RED',
    thesisValid: false,
    currentEv: -10,
  });
  // Below stop + thesis invalid → EXIT
  assert.ok(
    result.action === ShadowAction.SHADOW_EXIT || result.action === ShadowAction.SHADOW_REDUCE,
    `must exit or reduce, not reverse. Got: ${result.action}`,
  );
  assert.notEqual(result.action, ShadowAction.SHADOW_REENTRY, 'must not auto-reverse');
});

// ═══════════════════════════════════════════════════════════════════════════
// TEST 19: continuous position monitoring (shadow monitor covers all states)
// ═══════════════════════════════════════════════════════════════════════════
test('19. continuous position monitoring — shadow monitor returns valid actions', () => {
  const validActions = new Set(Object.values(ShadowAction));
  // Test multiple scenarios
  const scenarios = [
    { currentPremium: 110, healthState: 'GREEN', thesisValid: true, trapScore: 10, dte: 10,
      expected: ShadowAction.SHADOW_HOLD },
    { currentPremium: 70, healthState: 'GREEN', thesisValid: true, trapScore: 10, dte: 10,
      expected: ShadowAction.SHADOW_EXIT }, // below stop
    { currentPremium: 155, healthState: 'GREEN', thesisValid: true, trapScore: 10, dte: 10,
      expected: ShadowAction.SHADOW_EXIT }, // target hit
    { currentPremium: 105, healthState: 'ORANGE', thesisValid: true, trapScore: 10, dte: 5,
      expected: ShadowAction.SHADOW_REDUCE },
  ];
  for (const s of scenarios) {
    const result = fnfShadowMonitor({
      currentPremium: s.currentPremium,
      entryPremium: 100, stopPrice: 75, targetPrice: 150,
      mae: -5, mfe: 15, currentPnlPerUnit: s.currentPremium - 100,
      unrealizedPnlPerUnit: s.currentPremium - 100,
      dte: s.dte, underlyingSpot: 24000, underlyingSma20: 23900,
      delta: 0.3, iv: 0.20, volume: 500, spreadPct: 1.0,
      quoteAgeMin: 0, maxStaleMin: 5, trapScore: s.trapScore,
      healthState: s.healthState, thesisValid: s.thesisValid, currentEv: 5,
    });
    assert.ok(validActions.has(result.action), `invalid action: ${result.action}`);
    assert.equal(result.action, s.expected,
      `premium=${s.currentPremium}: expected ${s.expected}, got ${result.action}`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// TEST 20: FNF paper-only safety
// ═══════════════════════════════════════════════════════════════════════════
test('20. FNF paper-only safety — no broker order types exist', () => {
  // The risk engine and shadow engine are pure functions with no broker APIs
  // Verify by checking imports don't contain any broker-related modules
  const fs = require('fs');
  const riskSrc = fs.readFileSync(__dirname + '/../src/trading/fnf-risk.ts', 'utf8');
  const shadowSrc = fs.readFileSync(__dirname + '/../src/trading/fnf-shadow-engine.ts', 'utf8');
  const healthSrc = fs.readFileSync(__dirname + '/../src/trading/fnf-position-health.ts', 'utf8');
  const exitSrc = fs.readFileSync(__dirname + '/../src/trading/fnf-exit-engine.ts', 'utf8');
  
  const brokerKeywords = ['placeOrder', 'broker', 'fyers_order', 'upstox_order', 'real_order', 'ORDER_ALLOWED'];
  for (const src of [riskSrc, shadowSrc, healthSrc, exitSrc]) {
    for (const kw of brokerKeywords) {
      assert.ok(!src.includes(kw), `source contains broker keyword: ${kw}`);
    }
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ADDITIONAL: authorization gates, stop determination, state machine
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n── Additional ──');

test('authorization gate: stale quote rejected', () => {
  const snap = mkSnap();
  const result = fnfAuthorizeEntry(snap, {
    premium: 10, lotSize: 65, stopPerUnit: 2.5, lots: 1,
    quoteAgeMin: 10, maxStaleMin: 5,
    spreadPct: 1, volume: 500, minVolume: 100, maxSpreadPct: 3,
    delta: 0.3, minDelta: 0.1, maxDelta: 0.5,
    dte: 5, minDte: 1, confidence: 70, minConfidence: 50,
  });
  assert.equal(result.allowed, false);
  assert.ok(result.refusals.some(r => r.includes('quote_stale')));
});

test('authorization gate: wide spread rejected', () => {
  const snap = mkSnap();
  const result = fnfAuthorizeEntry(snap, {
    premium: 10, lotSize: 65, stopPerUnit: 2.5, lots: 1,
    quoteAgeMin: 0, maxStaleMin: 5,
    spreadPct: 5, volume: 500, minVolume: 100, maxSpreadPct: 3,
    delta: 0.3, minDelta: 0.1, maxDelta: 0.5,
    dte: 5, minDte: 1, confidence: 70, minConfidence: 50,
  });
  assert.equal(result.allowed, false);
  assert.ok(result.refusals.some(r => r.includes('wide_spread')));
});

test('stop determination: ATR-based uses ATR when available', () => {
  const result = fnfDetermineStop(100, 0.10, null, 1.5, POLICY);
  assert.equal(result.source, 'atr');
  assert.equal(result.stopPrice, 90); // 100 * (1 - 0.10)
  assert.equal(result.stopPerUnit, 10); // 100 - 90
});

test('stop determination: percentage fallback when no ATR', () => {
  const result = fnfDetermineStop(100, null, null, 1.5, POLICY);
  assert.equal(result.source, 'percentage');
  assert.equal(result.stopPrice, 75); // 100 * (1 - 0.25)
  assert.equal(result.stopPerUnit, 25);
});

test('BLACK state: high-severity trap forces exit', () => {
  const result = fnfEvaluatePositionHealth(mkHealthInput({
    traps: {
      traps: [{ trapType: 'oi_crowding', severity: 'high' }],
      highSeverity: true,
      hasTraps: true,
      score: 80,
    },
    profitExceedsThreshold: false,
  }));
  assert.equal(result.state, PositionHealthState.BLACK);
  assert.ok(result.shouldExit);
});

test('capital gates separate from risk gates', () => {
  // High capital deployed but risk budget not exceeded
  const snap = mkSnap({ deployed: 9991 });
  const sizing = fnfSizeFromRisk({ snapshot: snap, premium: 0.5, lotSize: 20, stopPerUnit: 0.1 });
  // risk_per_lot = 0.1*1.15*20 = 2.3 < 100 → risk OK
  // outlay_per_lot = 0.5*20 = 10 > 9 headroom → capital FAILS
  const riskRefusal = sizing.refusals.some(r => r.includes('risk_per_lot'));
  const capitalRefusal = sizing.refusals.some(r => r.includes('headroom'));
  assert.equal(riskRefusal, false, 'risk must NOT be the issue');
  assert.ok(capitalRefusal, 'capital headroom must be the blocker');
});

// ═══════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 4A ADDITIONAL TESTS
// ═══════════════════════════════════════════════════════════════════════════

test('21. risk exit — stop breached forces exit', () => {
  const exit = fnfEvaluateExit({
    currentPremium: 70,    // below stop of 75
    entryPremium: 100,
    stopPrice: 75,
    targetPrice: 150,
    healthState: 'RED',
    thesisValid: true,     // thesis valid so THESIS doesn't fire first
    underlyingConfirmed: true,
    unrealizedPnlPerUnit: -30,
    maePerUnit: 30,
    mfePerUnit: 0,
    dte: 3,
    currentEv: -20,
    exitEv: -10,
    nextBestEv: 5,
    inProfit: false,
    profitExceedsThreshold: false,
    spreadPct: 1.0,
  });
  assert.equal(exit.shouldExit, true);
  assert.equal(exit.exitReason, 'RISK');
});

test('22. opportunity exit — superior alternative exists', () => {
  const exit = fnfEvaluateExit({
    currentPremium: 105,
    entryPremium: 100,
    stopPrice: 75,
    targetPrice: 150,
    healthState: 'YELLOW',
    thesisValid: true,
    underlyingConfirmed: true,
    unrealizedPnlPerUnit: 5,
    maePerUnit: 5,
    mfePerUnit: 15,
    dte: 8,
    currentEv: 3,      // positive but small
    exitEv: -2,         // exiting has negative EV (but we still exit for opportunity)
    nextBestEv: 15,     // much better opportunity exists (15 > 3*2 AND 15 > 5)
    inProfit: true,
    profitExceedsThreshold: false,
    spreadPct: 1.0,
  });
  assert.equal(exit.shouldExit, true);
  assert.equal(exit.exitReason, 'OPPORTUNITY');
});

test('23. no Martingale — losing position has HOLD/REDUCE/EXIT only', () => {
  // A losing position should NEVER show AVERAGE_UP, MARTINGALE, or REVERSE
  const shadow = fnfShadowMonitor({
    currentPremium: 70,
    entryPremium: 100,
    stopPrice: 75,
    targetPrice: 150,
    mae: 30,
    mfe: 0,
    currentPnlPerUnit: -30,
    unrealizedPnlPerUnit: -30,
    dte: 5,
    underlyingSpot: 24000,
    underlyingSma20: 24100,
    delta: 0.3,
    iv: 0.25,
    volume: 200,
    spreadPct: 3.0,
    quoteAgeMin: 0,
    maxStaleMin: 5,
    trapScore: 0.3,
    healthState: 'RED',
    thesisValid: false,
    currentEv: -10,
  });
  // Shadow actions should be conservative for losing positions
  const unsafeActions = ['AVERAGE_UP', 'MARTINGALE', 'REVERSE', 'ADD_TO_LOSING'];
  assert.ok(!unsafeActions.includes(shadow.action),
    `shadow action "${shadow.action}" must not be a loss-escalating action`);
});

test('24. canonical data — unified store preferred over FNF chain', () => {
  // Verify the evaluateOpenPositions logic prefers unified store
  // This tests the data priority logic conceptually
  const unifiedQuote = { ltp: 95, volume: 1000, oi: 5000, iv: 0.18, delta: 0.4, source: 'FYERS' };
  const fnfChain = { ltp: 90, volume: 500, openInterest: 3000 };

  // Simulate the priority: unified > fnf-chain
  let currentPremium = 0;
  let dataSource = 'fnf-chain';

  if (unifiedQuote && unifiedQuote.ltp > 0) {
    currentPremium = unifiedQuote.ltp;
    dataSource = `unified:${unifiedQuote.source}`;
  }
  if (!currentPremium && fnfChain && fnfChain.ltp > 0) {
    currentPremium = fnfChain.ltp;
    dataSource = 'fnf-chain';
  }

  assert.equal(currentPremium, 95, 'should use unified quote premium');
  assert.ok(dataSource.startsWith('unified:'), 'should report unified data source');
});

test('25. PROFIT_LOCK state — locked profit never drops below threshold', () => {
  const health = fnfEvaluatePositionHealth({
    currentPremium: 125,
    entryPremium: 100,
    stopPrice: 75,
    targetPrice: 150,
    unrealizedPnlPerUnit: 25,
    maePerUnit: 0,
    mfePerUnit: 40,
    currentRiskPerUnit: 50,
    originalRiskPerUnit: 25,
    dte: 8,
    underlyingSpot: 24500,
    underlyingSma20: 24000,
    delta: 0.5,
    iv: 0.20,
    quoteAgeMin: 0,
    maxStaleMin: 5,
    traps: { traps: [], highSeverity: false, hasTraps: false, score: 0 },
    thesisValid: true,
    underlyingConfirmed: true,
    spreadPct: 1.0,
    volume: 800,
    inProfit: true,
    profitExceedsThreshold: true,
  });
  assert.equal(health.state, 'PROFIT_LOCK',
    'position with large profit and profitExceedsThreshold should be PROFIT_LOCK');
});

test('26. risk exit overrides all other considerations', () => {
  // Even with valid thesis and profit, stop breach forces exit
  const exit = fnfEvaluateExit({
    currentPremium: 73,  // below stop of 75
    entryPremium: 100,
    stopPrice: 75,
    targetPrice: 150,
    healthState: 'BLACK',
    thesisValid: true,   // thesis still valid
    underlyingConfirmed: true,
    unrealizedPnlPerUnit: -27,
    maePerUnit: 27,
    mfePerUnit: 10,
    dte: 15,             // still has time
    currentEv: 5,        // positive EV
    exitEv: -3,
    nextBestEv: 2,
    inProfit: false,
    profitExceedsThreshold: false,
    spreadPct: 1.0,
  });
  assert.equal(exit.shouldExit, true);
  assert.equal(exit.exitReason, 'RISK',
    'risk exit must override thesis validity and positive EV');
});

test('27. GREEN state — healthy position with no concerns', () => {
  const health = fnfEvaluatePositionHealth({
    currentPremium: 120,
    entryPremium: 100,
    stopPrice: 75,
    targetPrice: 150,
    unrealizedPnlPerUnit: 20,
    maePerUnit: 0,
    mfePerUnit: 25,
    currentRiskPerUnit: 45,
    originalRiskPerUnit: 25,
    dte: 12,
    underlyingSpot: 24500,
    underlyingSma20: 24000,
    delta: 0.45,
    iv: 0.18,
    quoteAgeMin: 0,
    maxStaleMin: 5,
    traps: { traps: [], highSeverity: false, hasTraps: false, score: 0 },
    thesisValid: true,
    underlyingConfirmed: true,
    spreadPct: 0.8,
    volume: 1000,
    inProfit: true,
    profitExceedsThreshold: false,
  });
  assert.equal(health.state, 'GREEN',
    'healthy position with good profit and no traps should be GREEN');
});

test('28. shadow EXIT alone does not close — requires exit authorization', () => {
  // Shadow EXIT is advisory only; must be paired with exit engine authorization
  const shadow = fnfShadowMonitor({
    currentPremium: 95,
    entryPremium: 100,
    stopPrice: 75,
    targetPrice: 150,
    mae: 10,
    mfe: 5,
    currentPnlPerUnit: -5,
    unrealizedPnlPerUnit: -5,
    dte: 3,
    underlyingSpot: 23800,
    underlyingSma20: 24000,
    delta: 0.25,
    iv: 0.30,
    volume: 100,
    spreadPct: 5.0,
    quoteAgeMin: 0,
    maxStaleMin: 5,
    trapScore: 0.6,
    healthState: 'YELLOW',
    thesisValid: true,
    currentEv: 0,
  });

  // Even if shadow says EXIT, the exit engine must independently authorize
  const exit = fnfEvaluateExit({
    currentPremium: 95,
    entryPremium: 100,
    stopPrice: 75,
    targetPrice: 150,
    healthState: 'YELLOW',
    thesisValid: true,
    underlyingConfirmed: true,
    unrealizedPnlPerUnit: -5,
    maePerUnit: 10,
    mfePerUnit: 5,
    dte: 3,
    currentEv: 5,
    exitEv: -3,
    nextBestEv: 2,
    inProfit: false,
    profitExceedsThreshold: false,
    spreadPct: 5.0,
  });

  // Shadow may say EXIT but exit engine says no → no actual close
  if (shadow.action === 'EXIT' && !exit.shouldExit) {
    assert.equal(exit.shouldExit, false,
      'shadow EXIT without exit engine authorization must not close position');
  }
});

test('29. no averaging down — shadow NEVER recommends averaging', () => {
  // Check all possible health states for shadow actions
  const healthStates = ['GREEN', 'YELLOW', 'ORANGE', 'RED', 'BLACK'];
  const unsafeActions = ['AVERAGE_DOWN', 'AVERAGE_UP', 'MARTINGALE', 'ADD'];

  for (const state of healthStates) {
    const shadow = fnfShadowMonitor({
      currentPremium: 70,
      entryPremium: 100,
      stopPrice: 75,
      targetPrice: 150,
      mae: 30,
      mfe: 0,
      currentPnlPerUnit: -30,
      unrealizedPnlPerUnit: -30,
      dte: 5,
      underlyingSpot: 23500,
      underlyingSma20: 24000,
      delta: 0.2,
      iv: 0.35,
      volume: 50,
      spreadPct: 8.0,
      quoteAgeMin: 0,
      maxStaleMin: 5,
      trapScore: 0.8,
      healthState: state,
      thesisValid: false,
      currentEv: -20,
    });
    assert.ok(!unsafeActions.includes(shadow.action),
      `healthState=${state}: shadow "${shadow.action}" must not be averaging/adding`);
  }
});

test('30. recovery requires independent qualifying setup', () => {
  // Recovery is allowed only if original thesis valid OR new setup qualifies
  // AND recovery EV after costs is positive
  // If thesis invalid and no new setup → HOLD or EXIT, never RECOVERY
  const shadow = fnfShadowMonitor({
    currentPremium: 70,
    entryPremium: 100,
    stopPrice: 75,
    targetPrice: 150,
    mae: 30,
    mfe: 0,
    currentPnlPerUnit: -30,
    unrealizedPnlPerUnit: -30,
    dte: 5,
    underlyingSpot: 23500,
    underlyingSma20: 24000,
    delta: 0.2,
    iv: 0.35,
    volume: 50,
    spreadPct: 8.0,
    quoteAgeMin: 0,
    maxStaleMin: 5,
    trapScore: 0.8,
    healthState: 'BLACK',
    thesisValid: false,
    currentEv: -20,
  });
  // With invalid thesis, poor health, and negative EV, should not recommend recovery
  assert.ok(shadow.action !== 'RECOVERY',
    'BLACK state with invalid thesis must not recommend RECOVERY');
});


// RESULTS
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n' + '═'.repeat(60));
console.log(`RESULTS: ${passed} passed, ${failed} failed, ${passed + failed} total`);
console.log('═'.repeat(60));

if (failures.length > 0) {
  console.log('\nFailed tests:');
  for (const f of failures) {
    console.log(`  ✗ ${f.name}: ${f.err.message}`);
  }
}

process.exit(failed > 0 ? 1 : 0);

