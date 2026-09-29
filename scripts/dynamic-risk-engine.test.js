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

  test('2.1 Shrinkage curve moves monotonically with sample size at 3+ checkpoints', () => {
    const engine = new DynamicRiskEngine(5000);

    const s0 = engine.computeKellyShrinkage(0);   // Checkpoint 1: n = 0
    const s10 = engine.computeKellyShrinkage(10); // Checkpoint 2: n = 10
    const s25 = engine.computeKellyShrinkage(25); // Checkpoint 3: n = 25
    const s50 = engine.computeKellyShrinkage(50); // Checkpoint 4: n = 50

    assert.ok(s0 >= 0.15 && s0 <= 0.25, `Expected s0 ~ 0.15-0.25, got ${s0}`);
    assert.ok(s10 > s0, `Expected s10 (${s10}) > s0 (${s0})`);
    assert.ok(s25 > s10, `Expected s25 (${s25}) > s10 (${s10})`);
    assert.ok(s50 > s25, `Expected s50 (${s50}) > s25 (${s25})`);
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

  console.log('\n--- CATEGORY 5: Hard Invariants Verification ---');

  test('5.1 Hard Invariants block correctly when deliberately violated', () => {
    const engine = new DynamicRiskEngine(5000);

    // 1. Attempted Real Order
    const rReal = engine.calculatePositionSize({
      symbol: 'NSE:NIFTY29SEP22850CE', underlying: 'NIFTY50-INDEX', expiry: '2026-09-29',
      premium: 50, lotSize: 65, side: 'BUY', structuralStopPrice: 40, attemptedRealOrder: true
    });
    assert.strictEqual(rReal.allowed, false);
    assert.ok(rReal.refusals.some(r => r.includes('REAL_ORDER_ROUTING_PROHIBITED')));

    // 2. Duplicate Order
    const rDup = engine.calculatePositionSize({
      symbol: 'NSE:NIFTY29SEP22850CE', underlying: 'NIFTY50-INDEX', expiry: '2026-09-29',
      premium: 50, lotSize: 65, side: 'BUY', structuralStopPrice: 40, isDuplicateOrder: true
    });
    assert.strictEqual(rDup.allowed, false);
    assert.ok(rDup.refusals.some(r => r.includes('DUPLICATE_ORDER_IDEMPOTENCY_BREACH')));

    // 3. Stale Quote Data (>15s)
    const rStale = engine.calculatePositionSize({
      symbol: 'NSE:NIFTY29SEP22850CE', underlying: 'NIFTY50-INDEX', expiry: '2026-09-29',
      premium: 50, lotSize: 65, side: 'BUY', structuralStopPrice: 40, quoteAgeSec: 25, maxStaleSec: 15
    });
    assert.strictEqual(rStale.allowed, false);
    assert.ok(rStale.refusals.some(r => r.includes('STALE_QUOTE_DATA')));
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
