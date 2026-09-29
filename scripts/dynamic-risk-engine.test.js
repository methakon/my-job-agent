/**
 * Comprehensive Unit & Integration Test Suite for Dynamic Bayesian Fractional-Kelly Risk Engine
 */

const assert = require('assert');
const path = require('path');

async function runDynamicRiskEngineTests() {
  console.log('===================================================================');
  console.log('⚡ [DHARTRADES DYNAMIC RISK ENGINE] RUNNING UNIT & INTEGRATION TESTS');
  console.log('===================================================================');

  let engineModule;
  try {
    engineModule = require('../dist/trading/dynamic-risk-engine');
  } catch (err) {
    console.log('Building NestJS dist for dynamic risk engine test suite...');
    require('child_process').execSync('npm run build', { cwd: path.resolve(__dirname, '..'), stdio: 'inherit' });
    engineModule = require('../dist/trading/dynamic-risk-engine');
  }

  const { DynamicRiskEngine } = engineModule;

  let passCount = 0;
  let totalCount = 0;

  function test(name, fn) {
    totalCount++;
    try {
      fn();
      console.log(`  ✅ PASS: ${name}`);
      passCount++;
    } catch (err) {
      console.error(`  ❌ FAIL: ${name}`);
      console.error(`     ${err.stack || err.message}`);
    }
  }

  console.log('\n--- CATEGORY 1: Hand-Calculated Kelly Fraction & Bayesian Update ---');

  test('1.1 Kelly fraction computed correctly from synthetic win/loss sequence', () => {
    const engine = new DynamicRiskEngine(5000);
    // Uninformative prior Beta(1,1) -> p_hat = 0.5
    const state0 = engine.getPosterior('TREND', 'BREAKOUT');
    assert.strictEqual(engine.computePHat(state0), 0.5);

    // Record synthetic trades: 6 wins (avg 2.0R), 4 losses (avg 1.0R)
    for (let i = 0; i < 6; i++) {
      engine.recordTradeOutcome({ regime: 'TREND', setupType: 'BREAKOUT', grossPnl: 200, premium: 100, lotSize: 65, lots: 1, side: 'BUY', outcomeR: 2.0 });
    }
    for (let i = 0; i < 4; i++) {
      engine.recordTradeOutcome({ regime: 'TREND', setupType: 'BREAKOUT', grossPnl: -100, premium: 100, lotSize: 65, lots: 1, side: 'BUY', outcomeR: -1.0 });
    }

    const state1 = engine.getPosterior('TREND', 'BREAKOUT');
    // alpha = 1 + 6 = 7, beta = 1 + 4 = 5 -> p_hat = 7/12 = 0.583333...
    const expectedPHat = 7 / 12;
    assert.ok(Math.abs(engine.computePHat(state1) - expectedPHat) < 1e-5, `Expected p_hat ~ ${expectedPHat}, got ${engine.computePHat(state1)}`);

    // b_hat = mean(wins) / mean(losses) = 2.0 / 1.0 = 2.0
    const bHat = engine.computeBHat(state1);
    assert.strictEqual(bHat, 2.0);

    // k_raw = p_hat - (1 - p_hat) / b_hat = 7/12 - (5/12)/2.0 = 7/12 - 5/24 = 9/24 = 0.375
    const kRawExpected = expectedPHat - (1 - expectedPHat) / bHat;
    assert.ok(Math.abs(kRawExpected - 0.375) < 1e-5, `Expected k_raw ~ 0.375, got ${kRawExpected}`);
  });

  console.log('\n--- CATEGORY 2: Kelly Shrinkage Curve Monotonicity ---');

  test('2.1 Shrinkage curve moves monotonically with sample size at 6 checkpoints', () => {
    const engine = new DynamicRiskEngine(5000);

    const checkPoints = [0, 5, 10, 25, 50, 100];
    const shrinkages = checkPoints.map(n => ({ n, val: engine.computeKellyShrinkage(n) }));

    console.log('     Shrinkage curve checkpoints:');
    shrinkages.forEach(cp => {
      console.log(`       n = ${String(cp.n).padStart(3, ' ')} trades -> shrinkage S(n) = ${cp.val.toFixed(4)}`);
    });

    const s0 = shrinkages[0].val;
    const s5 = shrinkages[1].val;
    const s10 = shrinkages[2].val;
    const s25 = shrinkages[3].val;
    const s50 = shrinkages[4].val;
    const s100 = shrinkages[5].val;

    assert.ok(s0 >= 0.15 && s0 <= 0.25, `Expected s0 ~ 0.15-0.25, got ${s0}`);
    assert.ok(s5 > s0, `Expected s5 (${s5}) > s0 (${s0})`);
    assert.ok(s10 > s5, `Expected s10 (${s10}) > s5 (${s5})`);
    assert.ok(s25 > s10, `Expected s25 (${s25}) > s10 (${s10})`);
    assert.ok(s50 > s25, `Expected s50 (${s50}) > s25 (${s25})`);
    assert.ok(s100 >= s50, `Expected s100 (${s100}) >= s50 (${s50})`);
  });

  console.log('\n--- CATEGORY 3: CAPITAL_IN_HAND Hard Ceiling & Portfolio Exposure ---');

  test('3.1 Position sizing never allows total notional to exceed CAPITAL_IN_HAND', () => {
    const engine = new DynamicRiskEngine(5000);
    const capitalInHand = engine.getCapitalInHand();

    // Size trade with existing open position of ₹3,500
    const res = engine.calculatePositionSize({
      symbol: 'NSE:NIFTY29SEP22850CE',
      underlying: 'NIFTY50-INDEX',
      expiry: '2026-09-29',
      premium: 100,
      lotSize: 65,
      openPositionsNotional: 3500, // ₹3,500 already deployed
      side: 'BUY',
      structuralStopPrice: 80,
    });

    // Outlay per lot = 100 * 65 = ₹6,500 > remaining headroom (₹1,500)
    assert.strictEqual(res.allowed, false);
    assert.ok(res.refusals.some(r => r.includes('AFFORDABILITY_NO_TRADE')));
    assert.strictEqual(res.positionNotional, 0);
  });

  test('3.2 Position sizing succeeds within CAPITAL_IN_HAND headroom', () => {
    const engine = new DynamicRiskEngine(10000);

    // Seed posterior to generate positive Kelly fraction
    for (let i = 0; i < 8; i++) {
      engine.recordTradeOutcome({ regime: 'DEFAULT', setupType: 'DEFAULT', grossPnl: 300, premium: 50, lotSize: 65, lots: 1, side: 'BUY', outcomeR: 2.0 });
    }

    const res = engine.calculatePositionSize({
      symbol: 'NSE:NIFTY29SEP22850CE',
      underlying: 'NIFTY50-INDEX',
      expiry: '2026-09-29',
      premium: 20, // Outlay = 20 * 65 = ₹1,300 < target notional ~ ₹2,108
      lotSize: 65,
      openPositionsNotional: 2000,
      side: 'BUY',
      structuralStopPrice: 15,
    });

    assert.strictEqual(res.allowed, true);
    assert.ok(res.positionNotional <= (10000 - 2000));
    assert.ok(res.lots >= 1);
  });

  console.log('\n--- CATEGORY 4: Independent Regime / Setup Posteriors ---');

  test('4.1 Confidence/regime posteriors update independently per bucket', () => {
    const engine = new DynamicRiskEngine(5000);

    // Trend Regime: 9 wins, 1 loss -> high p_hat
    for (let i = 0; i < 9; i++) {
      engine.recordTradeOutcome({ regime: 'TREND', setupType: 'BREAKOUT', grossPnl: 200, premium: 50, lotSize: 65, lots: 1, side: 'BUY', outcomeR: 2.0 });
    }
    engine.recordTradeOutcome({ regime: 'TREND', setupType: 'BREAKOUT', grossPnl: -100, premium: 50, lotSize: 65, lots: 1, side: 'BUY', outcomeR: -1.0 });

    // Range Regime: 1 win, 9 losses -> low p_hat
    engine.recordTradeOutcome({ regime: 'RANGE', setupType: 'MEAN_REVERSION', grossPnl: 100, premium: 50, lotSize: 65, lots: 1, side: 'BUY', outcomeR: 1.0 });
    for (let i = 0; i < 9; i++) {
      engine.recordTradeOutcome({ regime: 'RANGE', setupType: 'MEAN_REVERSION', grossPnl: -100, premium: 50, lotSize: 65, lots: 1, side: 'BUY', outcomeR: -1.0 });
    }

    const pTrend = engine.computePHat(engine.getPosterior('TREND', 'BREAKOUT'));
    const pRange = engine.computePHat(engine.getPosterior('RANGE', 'MEAN_REVERSION'));

    assert.ok(pTrend > 0.75, `Expected pTrend > 0.75, got ${pTrend}`);
    assert.ok(pRange < 0.25, `Expected pRange < 0.25, got ${pRange}`);
  });

  console.log('\n--- CATEGORY 5: Split Hard Safety Invariants (1 Test Per Invariant) ---');

  test('5.1 Paper-Only Invariant: attemptedRealOrder=true blocks with REAL_ORDER_ROUTING_PROHIBITED', () => {
    const engine = new DynamicRiskEngine(5000);
    const res = engine.calculatePositionSize({
      symbol: 'NSE:NIFTY29SEP22850CE', underlying: 'NIFTY50-INDEX', expiry: '2026-09-29',
      premium: 50, lotSize: 65, side: 'BUY', structuralStopPrice: 40, attemptedRealOrder: true
    });
    assert.strictEqual(res.allowed, false);
    assert.strictEqual(res.rejectionCategory, 'HARD_SAFETY_VETO');
    assert.ok(res.refusals.some(r => r.includes('REAL_ORDER_ROUTING_PROHIBITED')), 'Must include REAL_ORDER_ROUTING_PROHIBITED');
  });

  test('5.2 Idempotency Invariant: isDuplicateOrder=true blocks with DUPLICATE_ORDER_IDEMPOTENCY_BREACH', () => {
    const engine = new DynamicRiskEngine(5000);
    const res = engine.calculatePositionSize({
      symbol: 'NSE:NIFTY29SEP22850CE', underlying: 'NIFTY50-INDEX', expiry: '2026-09-29',
      premium: 50, lotSize: 65, side: 'BUY', structuralStopPrice: 40, isDuplicateOrder: true
    });
    assert.strictEqual(res.allowed, false);
    assert.strictEqual(res.rejectionCategory, 'HARD_SAFETY_VETO');
    assert.ok(res.refusals.some(r => r.includes('DUPLICATE_ORDER_IDEMPOTENCY_BREACH')), 'Must include DUPLICATE_ORDER_IDEMPOTENCY_BREACH');
  });

  test('5.3 Quote Freshness Invariant: quoteAgeSec > maxStaleSec blocks with STALE_QUOTE_DATA', () => {
    const engine = new DynamicRiskEngine(5000);
    const res = engine.calculatePositionSize({
      symbol: 'NSE:NIFTY29SEP22850CE', underlying: 'NIFTY50-INDEX', expiry: '2026-09-29',
      premium: 50, lotSize: 65, side: 'BUY', structuralStopPrice: 40, quoteAgeSec: 25, maxStaleSec: 15
    });
    assert.strictEqual(res.allowed, false);
    assert.strictEqual(res.rejectionCategory, 'HARD_SAFETY_VETO');
    assert.ok(res.refusals.some(r => r.includes('STALE_QUOTE_DATA')), 'Must include STALE_QUOTE_DATA');
  });

  test('5.4 Structural Stop Invariant: missing stopPrice & ATR blocks with STRUCTURAL_STOP_MISSING', () => {
    const engine = new DynamicRiskEngine(5000);
    const res = engine.calculatePositionSize({
      symbol: 'NSE:NIFTY29SEP22850CE', underlying: 'NIFTY50-INDEX', expiry: '2026-09-29',
      premium: 50, lotSize: 65, side: 'BUY'
    });
    assert.strictEqual(res.allowed, false);
    assert.strictEqual(res.rejectionCategory, 'HARD_SAFETY_VETO');
    assert.ok(res.refusals.some(r => r.includes('STRUCTURAL_STOP_MISSING')), 'Must include STRUCTURAL_STOP_MISSING');
  });

  test('5.5 Capital Ceiling Invariant: openPositionsNotional >= capitalInHand blocks with AFFORDABILITY_NO_TRADE', () => {
    const engine = new DynamicRiskEngine(5000);
    const res = engine.calculatePositionSize({
      symbol: 'NSE:NIFTY29SEP22850CE', underlying: 'NIFTY50-INDEX', expiry: '2026-09-29',
      premium: 20, lotSize: 65, side: 'BUY', structuralStopPrice: 15, openPositionsNotional: 5000
    });
    assert.strictEqual(res.allowed, false);
    assert.strictEqual(res.rejectionCategory, 'AFFORDABILITY_NO_TRADE');
    assert.ok(res.refusals.some(r => r.includes('AFFORDABILITY_NO_TRADE')), 'Must include AFFORDABILITY_NO_TRADE');
  });

  console.log('\n--- CATEGORY 6: Structural Stop Verification ---');

  test('6.1 No trade opens without a structural stop recorded at entry', () => {
    const engine = new DynamicRiskEngine(5000);

    // Missing structural stop AND missing ATR
    const rNoStop = engine.calculatePositionSize({
      symbol: 'NSE:NIFTY29SEP22850CE', underlying: 'NIFTY50-INDEX', expiry: '2026-09-29',
      premium: 50, lotSize: 65, side: 'BUY'
    });

    assert.strictEqual(rNoStop.allowed, false);
    assert.ok(rNoStop.refusals.some(r => r.includes('STRUCTURAL_STOP_MISSING')));
  });

  console.log('===================================================================');
  console.log(`📊 [DYNAMIC RISK SUITE SUMMARY] Passed: ${passCount} / ${totalCount}`);
  console.log('===================================================================');

  if (passCount !== totalCount) {
    process.exit(1);
  }
}

runDynamicRiskEngineTests().catch(err => {
  console.error(err);
  process.exit(1);
});
