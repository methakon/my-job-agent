/**
 * Comprehensive Expiry-Day Quantitative & Microstructure Test Suite
 */

const assert = require('assert');
const path = require('path');

// Compile check & requirement tests
async function runExpiryResearchSuite() {
  console.log('===================================================================');
  console.log('⚡ [DHARTRADES EXPIRY-DAY RESEARCH SUITE] RUNNING AUDIT & INVARIANT TESTS');
  console.log('===================================================================');

  // Load ts-node or compiled dist module
  let engine;
  try {
    engine = require('../dist/trading/expiry-research/expiry-research-engine');
  } catch (err) {
    console.log('Building NestJS dist for test suite...');
    require('child_process').execSync('npm run build', { cwd: path.resolve(__dirname, '..'), stdio: 'inherit' });
    engine = require('../dist/trading/expiry-research/expiry-research-engine');
  }

  const {
    resolveOrderSizingLotSize,
    parseExpiryNomenclature,
    evaluateSystemSafetyVeto,
    evaluateStrikeWindowWidth,
    classifyTickFreshness,
    computeMultiSignalEvidence,
    evaluateDecoupledEntryEngine,
    SystemSafetyVetoReason,
    FreshnessBucket,
    OFFICIAL_EXCHANGE_LOT_SIZES,
  } = engine;

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
      console.error(`     ${err.message}`);
    }
  }

  console.log('\n--- CATEGORY 1: Contract Master & ORDER_SIZING_LOT_SIZE Invariant ---');

  test('1.1 Exchange-reference lot sizes (VALIDATION LAYER ONLY — not the sizing source)', () => {
    // These are reference values for cross-checking. The authoritative lot size
    // for sizing is the exact contract's record in the contract master (see
    // resolveOrderSizingLotSize precedence), never this table.
    // Provenance: FYERS contract master CSV (field[3], INFERRED — the file has no
    // header row), cross-checked against the DB registry and, for SENSEX, against
    // the Upstox desk's independently recorded lotSize. Official NSE/BSE circular
    // verification was UNAVAILABLE at the time of writing (exchange blocks
    // automated access) — do not describe these as "per circular" without a source.
    assert.strictEqual(OFFICIAL_EXCHANGE_LOT_SIZES['NIFTY'], 25);
    assert.strictEqual(OFFICIAL_EXCHANGE_LOT_SIZES['NIFTY50-INDEX'], 25);
    assert.strictEqual(OFFICIAL_EXCHANGE_LOT_SIZES['BANKNIFTY'], 15);
    assert.strictEqual(OFFICIAL_EXCHANGE_LOT_SIZES['NIFTYBANK-INDEX'], 15);
    assert.strictEqual(OFFICIAL_EXCHANGE_LOT_SIZES['SENSEX'], 20);
  });

  test('1.2 Exact Contract resolves lot size directly from Authoritative Broker Master', () => {
    const res = resolveOrderSizingLotSize({
      symbol: 'BSE:SENSEX01OCT72000CE',
      underlying: 'SENSEX',
      expiry: '2026-10-01',
      brokerMasterRecord: {
        symbol: 'BSE:SENSEX01OCT72000CE',
        underlying: 'SENSEX',
        expiry: '2026-10-01',
        strike: 72000,
        optionType: 'CE',
        lotSize: 20, // SENSEX lot size per the contract master (weekly + monthly alike)
        tickSize: 0.05,
        source: 'BROKER_MASTER',
        lastUpdatedMs: Date.now(),
      },
    });
    assert.strictEqual(res.valid, true);
    assert.strictEqual(res.resolvedLotSize, 20);
    assert.strictEqual(res.lotSizeSource, 'BROKER_CONTRACT_MASTER');
  });

  test('1.2b Lot size comes from the contract master, never from an underlying-level constant', () => {
    // A broker master that DISAGREES with the exchange-reference table must
    // still win: the exact contract record is the authority. The old defect
    // rejected the broker value instead (BROKER_EXCHANGE_DISAGREEMENT).
    const brokerSays = 99;
    const res = resolveOrderSizingLotSize({
      symbol: 'NSE:NIFTY26SEP22800CE',
      underlying: 'NIFTY50-INDEX',
      expiry: '2026-09-29',
      brokerMasterRecord: {
        symbol: 'NSE:NIFTY26SEP22800CE',
        underlying: 'NIFTY50-INDEX',
        expiry: '2026-09-29',
        strike: 22800,
        optionType: 'CE',
        lotSize: brokerSays,
        tickSize: 0.05,
        source: 'BROKER_MASTER',
        lastUpdatedMs: Date.now(),
      },
    });
    assert.strictEqual(res.valid, true, 'a contract-master value must not be rejected');
    assert.strictEqual(res.resolvedLotSize, brokerSays);
    assert.strictEqual(res.lotSizeSource, 'BROKER_CONTRACT_MASTER');
  });

  test('1.2c The reference table alone never resolves a lot size', () => {
    // No contract-master record, no DB value → unresolved. An underlying with a
    // reference entry must NOT be enough to size an order.
    const res = resolveOrderSizingLotSize({
      symbol: 'NSE:NIFTY26SEP22800CE',
      underlying: 'NIFTY50-INDEX',
      expiry: '2026-09-29',
    });
    assert.strictEqual(res.valid, false);
    assert.strictEqual(res.resolvedLotSize, null);
    assert.strictEqual(res.lotSizeSource, 'UNRESOLVED');
  });

  test('1.3 Database Contract Master resolves lot size for exact contract when present', () => {
    const res = resolveOrderSizingLotSize({
      symbol: 'NSE:BANKNIFTY29SEP56500PE',
      underlying: 'NIFTYBANK-INDEX',
      expiry: '2026-09-29',
      dbLotSize: 30,
    });
    assert.strictEqual(res.valid, true);
    assert.strictEqual(res.resolvedLotSize, 30);
    assert.strictEqual(res.lotSizeSource, 'DB_CONTRACT_MASTER');
  });

  test('1.4 Expiry Mismatch between Broker Master and Input is Rejected', () => {
    const res = resolveOrderSizingLotSize({
      symbol: 'NSE:NIFTY29SEP22850CE',
      underlying: 'NIFTY50-INDEX',
      expiry: '2026-09-29',
      brokerMasterRecord: {
        symbol: 'NSE:NIFTY29SEP22850CE',
        underlying: 'NIFTY50-INDEX',
        expiry: '2026-10-29', // Mismatched expiry
        strike: 22850,
        optionType: 'CE',
        lotSize: 65,
        tickSize: 0.05,
        source: 'BROKER_MASTER',
        lastUpdatedMs: Date.now(),
      },
    });
    assert.strictEqual(res.valid, false);
    assert.strictEqual(res.resolvedLotSize, null);
    assert.ok(res.rejectionReason.includes('CONTRACT_EXPIRY_MISMATCH'));
  });

  test('1.5 Stale Broker Master (>24h) is Rejected', () => {
    const res = resolveOrderSizingLotSize({
      symbol: 'NSE:NIFTY29SEP22850CE',
      underlying: 'NIFTY50-INDEX',
      expiry: '2026-09-29',
      brokerMasterRecord: {
        symbol: 'NSE:NIFTY29SEP22850CE',
        underlying: 'NIFTY50-INDEX',
        expiry: '2026-09-29',
        strike: 22850,
        optionType: 'CE',
        lotSize: 65,
        tickSize: 0.05,
        source: 'BROKER_MASTER',
        lastUpdatedMs: Date.now() - (25 * 3600 * 1000), // 25 hours old
      },
    });
    assert.strictEqual(res.valid, false);
    assert.strictEqual(res.resolvedLotSize, null);
    assert.ok(res.rejectionReason.includes('BROKER_CONTRACT_MASTER_STALE'));
  });

  test('1.6 Symbol / Expiry Ambiguity (Missing or Unmatched Identifiers) is Rejected', () => {
    const res = resolveOrderSizingLotSize({
      symbol: '',
      underlying: 'NIFTY50-INDEX',
      expiry: '2026-09-29',
    });
    assert.strictEqual(res.valid, false);
    assert.strictEqual(res.resolvedLotSize, null);
    assert.strictEqual(res.rejectionReason, 'MISSING_CONTRACT_IDENTIFIERS');
  });

  console.log('\n--- CATEGORY 2: Expiry Nomenclature & Symbol Format Audit ---');

  test('2.1 Parse 29SEP Contract Nomenclature', () => {
    const res = parseExpiryNomenclature('NSE:NIFTY29SEP22850CE', '2026-09-29');
    assert.strictEqual(res.underlying, 'NIFTY50-INDEX');
    assert.strictEqual(res.exchangeExpiryDate, '2026-09-29');
    assert.strictEqual(res.expiryTag, '29SEP');
    assert.strictEqual(res.isExpiryDay, true);
    assert.strictEqual(res.isMonthlyExpiry, true);
  });

  console.log('\n--- CATEGORY 3: System Safety Veto vs Strategy Evidence State ---');

  test('3.1 System Safety Veto Triggers HARD Block on Stale Quote (>15s)', () => {
    const safety = evaluateSystemSafetyVeto({
      quoteAgeMs: 18000,
      systemMaxStaleMs: 15000,
      bid: 100,
      ask: 101,
      spreadPct: 1.0,
      maxSpreadPct: 2.0,
      riskApproved: true,
      isDuplicate: false,
      killSwitch: false,
      lotSizeValid: true,
      outlayInr: 2500,
      capitalLimitInr: 5000,
    });
    assert.strictEqual(safety.passed, false);
    assert.strictEqual(safety.vetoReason, SystemSafetyVetoReason.STALE_QUOTE);
  });

  test('3.2 System Safety Veto Triggers HARD Block on Outlay > Capital Filter (₹5,000)', () => {
    const safety = evaluateSystemSafetyVeto({
      quoteAgeMs: 500,
      systemMaxStaleMs: 15000,
      bid: 250,
      ask: 255,
      spreadPct: 1.9,
      maxSpreadPct: 2.0,
      riskApproved: true,
      isDuplicate: false,
      killSwitch: false,
      lotSizeValid: true,
      outlayInr: 6375, // 25 * 255 = 6,375 > 5,000
      capitalLimitInr: 5000,
    });
    assert.strictEqual(safety.passed, false);
    assert.strictEqual(safety.vetoReason, SystemSafetyVetoReason.CAPITAL_FILTER_EXCEEDED);
  });

  test('3.3 Explicit Distinction Between SYSTEM_SAFETY_VETO and UNVALIDATED_STRATEGY_THRESHOLD', () => {
    const { NoTradeType, evaluateDecoupledEntryEngine, UNVALIDATED_STRATEGY_THRESHOLD } = engine;
    const safetyPass = evaluateSystemSafetyVeto({
      quoteAgeMs: 200,
      systemMaxStaleMs: 15000,
      bid: 100,
      ask: 102,
      spreadPct: 1.5,
      maxSpreadPct: 2.0,
      riskApproved: true,
      isDuplicate: false,
      killSwitch: false,
      lotSizeValid: true,
      outlayInr: 2550,
      capitalLimitInr: 5000,
    });
    const freshnessPass = classifyTickFreshness(200);

    // Scenario A: Insufficient evidence score (50 < 65 UNVALIDATED_STRATEGY_THRESHOLD)
    const lowEvidence = computeMultiSignalEvidence({
      spot: 22800,
      vwap: 22800,
      orbHigh: 22850,
      orbLow: 22750,
      callOiTotal: 1000000,
      putOiTotal: 1000000,
      pcr: 1.0,
      straddlePrice: 150,
    });
    const decisionA = evaluateDecoupledEntryEngine({
      evidence: lowEvidence,
      freshness: freshnessPass,
      safety: safetyPass,
      proposedRiskR: 1.0,
      structuralStopPrice: 85,
      entryPrice: 102,
      capitalFilterLimitInr: 5000,
      accountCapitalInr: 10000,
      lotSize: 25,
      minEvidenceThreshold: UNVALIDATED_STRATEGY_THRESHOLD,
    });
    assert.strictEqual(decisionA.allowEntry, false);
    assert.strictEqual(decisionA.noTradeType, NoTradeType.NO_TRADE_BY_INSUFFICIENT_EVIDENCE);
    assert.ok(decisionA.rejectionReason.includes('UNVALIDATED_STRATEGY_THRESHOLD_NOT_MET'));

    // Scenario B: Safety Veto failure (Stale quote)
    const safetyFail = evaluateSystemSafetyVeto({
      quoteAgeMs: 18000,
      systemMaxStaleMs: 15000,
      bid: 100,
      ask: 102,
      spreadPct: 1.5,
      maxSpreadPct: 2.0,
      riskApproved: true,
      isDuplicate: false,
      killSwitch: false,
      lotSizeValid: true,
      outlayInr: 2550,
      capitalLimitInr: 5000,
    });
    const decisionB = evaluateDecoupledEntryEngine({
      evidence: lowEvidence,
      freshness: freshnessPass,
      safety: safetyFail,
      proposedRiskR: 1.0,
      structuralStopPrice: 85,
      entryPrice: 102,
      capitalFilterLimitInr: 5000,
      accountCapitalInr: 10000,
      lotSize: 25,
    });
    assert.strictEqual(decisionB.allowEntry, false);
    assert.strictEqual(decisionB.noTradeType, NoTradeType.NO_TRADE_BY_SAFETY);
    assert.ok(decisionB.rejectionReason.includes('SAFETY_VETO'));
  });

  console.log('\n--- CATEGORY 4: Strike Window Width Empirical Evaluation (N=2..6) ---');

  test('4.1 Strike Window Evaluation Identifies N=5 as Optimal Delta/Liquidity Balance', () => {
    const evalN2 = evaluateStrikeWindowWidth(2, 22800, 50);
    const evalN5 = evaluateStrikeWindowWidth(5, 22800, 50);
    const evalN6 = evaluateStrikeWindowWidth(6, 22800, 50);

    assert.strictEqual(evalN2.recommendation, 'SUBOPTIMAL');
    assert.strictEqual(evalN5.recommendation, 'RECOMMENDED');
    assert.strictEqual(evalN6.recommendation, 'EXCESSIVE_SPREAD');
    assert.strictEqual(evalN5.strikeCount, 11); // 2 * 5 + 1
  });

  console.log('\n--- CATEGORY 5: Tick Staleness vs Signal Freshness Buckets ---');

  test('5.1 Freshness Buckets Correctly Distinguish Instant vs High Degraded', () => {
    const instant = classifyTickFreshness(150);
    const degraded = classifyTickFreshness(8000);
    const stale = classifyTickFreshness(16000);

    assert.strictEqual(instant.bucket, FreshnessBucket.INSTANT);
    assert.strictEqual(instant.allowBreakoutEntry, true);

    assert.strictEqual(degraded.bucket, FreshnessBucket.HIGH_DEGRADED);
    assert.strictEqual(degraded.allowBreakoutEntry, false);

    assert.strictEqual(stale.bucket, FreshnessBucket.SYSTEM_STALE);
    assert.strictEqual(stale.systemSafetyPass, false);
  });

  console.log('\n--- CATEGORY 6: Multi-Signal Evidence Model & Contradiction Detection ---');

  test('6.1 Contradiction Detection Flags High PCR during Price Breakdown', () => {
    const evidence = computeMultiSignalEvidence({
      spot: 22700,
      vwap: 22800,
      orbHigh: 22850,
      orbLow: 22750,
      callOiTotal: 1000000,
      putOiTotal: 1500000,
      pcr: 1.5, // High PCR
      straddlePrice: 150,
    });
    assert.ok(evidence.contradictionFlags.includes('HIGH_PCR_BUT_BEARISH_PRICE_ACTION_COLLAPSE'));
    assert.strictEqual(evidence.priceActionDirection, 'BEARISH');
  });

  console.log('\n--- CATEGORY 7: Decoupled Entry Engine & Capital Filter Preservation ---');

  test('7.1 Entry Engine Approves Valid Sized Trade within ₹5,000 Capital Limit', () => {
    const safety = evaluateSystemSafetyVeto({
      quoteAgeMs: 200,
      systemMaxStaleMs: 15000,
      bid: 100,
      ask: 102,
      spreadPct: 1.5,
      maxSpreadPct: 2.0,
      riskApproved: true,
      isDuplicate: false,
      killSwitch: false,
      lotSizeValid: true,
      outlayInr: 2550, // 25 * 102
      capitalLimitInr: 5000,
    });
    const freshness = classifyTickFreshness(200);
    const evidence = computeMultiSignalEvidence({
      spot: 22900,
      vwap: 22850,
      orbHigh: 22880,
      orbLow: 22800,
      callOiTotal: 1000000,
      putOiTotal: 1300000,
      pcr: 1.3,
      straddlePrice: 120,
    });

    const entry = evaluateDecoupledEntryEngine({
      evidence,
      freshness,
      safety,
      proposedRiskR: 1.0,
      structuralStopPrice: 85,
      entryPrice: 102,
      capitalFilterLimitInr: 5000,
      accountCapitalInr: 10000,
      lotSize: 25,
    });

    assert.strictEqual(entry.allowEntry, true);
    assert.strictEqual(entry.action, 'BUY_CE');
    assert.strictEqual(entry.tradeLots, 1);
    assert.strictEqual(entry.tradeUnits, 25);
    assert.strictEqual(entry.outlayInr, 2550);
  });

  console.log('===================================================================');
  console.log(`📊 [EXPIRY RESEARCH SUITE SUMMARY] Passed: ${passCount} / ${totalCount}`);
  console.log('===================================================================');

  if (passCount !== totalCount) {
    process.exit(1);
  }
}

runExpiryResearchSuite().catch(err => {
  console.error('Suite execution error:', err);
  process.exit(1);
});
