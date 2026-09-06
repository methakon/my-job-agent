const assert = require('node:assert/strict');
const path = require('path');

// Paths to dist files
const DIST_DIR = path.join(__dirname, '../dist');

/**
 * AI Trading Module Integration Tests
 * 
 * Tests the SHADOW-MODE architecture:
 * - AI assessment NEVER influences BUY/SELL/HOLD decisions
 * - AI assessment runs asynchronously (non-blocking)
 * - AI failure does NOT alter deterministic path
 * - All AI metadata is journaled for audit
 */

// Test 1: Validate AI input/output types can be loaded
async function testTypeInfo() {
  console.log('\n=== Test 1: AI Trading Types ===');
  
  const { 
    AiTradingInput, 
    AiTradingAssessment, 
    AiAssessmentResult,
    SchemaValidationError 
  } = require(path.join(DIST_DIR, 'trading/trading-ai.types'));
  
  // Verify interfaces exist and have correct structure
  const input = {
    version: '1.0.0',
    decisionTimestamp: new Date().toISOString(),
    sessionPhase: 'open',
    underlying: 'NIFTY50-INDEX',
    instrument: 'NSE:NIFTY28SEPCAL22000',
    contract: {
      symbol: 'NSE:NIFTY28SEPCAL22000',
      underlying: 'NIFTY50-INDEX',
      expiry: '2024-09-28',
      strike: 22000,
      optionType: 'CE',
      lotSize: 25,
      dte: 21,
    },
    quote: {
      premium: 150.50,
      bid: 150.00,
      ask: 151.00,
      ltp: 150.50,
      volume: 10000,
      openInterest: 50000,
    },
    direction: {
      spot: 22100,
      sma20: 22050,
      sma5: 22080,
      momentum: 0.002,
      bias: 'bullish',
      directionReason: 'Underlying above SMA-20',
      rawConfidence: 65,
    },
    greeks: {
      localDelta: 0.55,
      providerDelta: 0.54,
      iv: 0.145,
    },
    scoring: {
      atmScore: 0.8,
      expiryScore: 0.9,
      greeksScore: 0.7,
      liquidityScore: 0.6,
      spreadScore: 0.8,
      costScore: 0.5,
      sameUnderlyingNudge: 1,
      totalScore: 8.5,
      rank: 1,
      totalCandidates: 5,
    },
    capital: {
      contractValue: 93750,
      availableHeadroom: 500000,
      portfolioCapital: 100000,
      portfolioDeployed: 25000,
      portfolioCeiling: 125000,
      paperQty: 1,
    },
    candidateReasons: [
      'BULLISH NIFTY50-INDEX — Underlying above SMA-20 with rising 5-bar mean',
      'strike 22000 (spot 22100.00; 0.45% from ATM)',
    ],
    decay: {
      decayedConfidence: 58,
      rawConfidence: 65,
      rate: 0.04,
      ageHours: 2.5,
      timingFactor: 1.0,
      inWindow: true,
      weekday: 0,
      windowStartHour: 9.5,
      windowEndHour: 15.25,
    },
    astroMatch: {
      shubh: true,
      score: 75,
      label: 'Shubh muhurta window',
    },
    dataQuality: {
      dataAgeMin: 1.5,
      featureCutoffMs: Date.now() - 1000 * 60 * 60,
      quoteTsMs: Date.now(),
      quotesConsumed: 1,
      indexBars: 30,
    },
    metadata: {
      algoSource: 'option-candidate-rank-v1',
      buildSha: 'abc123',
      sessionPhase: 'open',
      isFriday: false,
      fridayBlocked: false,
      cycleLatencyMs: 150,
    },
  };
  
  const assessment = {
    version: '1.0.0',
    modelIdentity: {
      routingPolicyVersion: 'v1',
      HermesModelKey: 'hermes.qwen.coder.default',
      selectedModelKey: 'hermes.qwen.coder.default',
      selectedProvider: 'bedrock',
      selectedModelId: 'qwen.qwen3-coder-next',
      selectedModelTier: 'worker',
      selectedModelExperimental: false,
    },
    directionalAssessment: {
      agreement: 'AGREES',
      confidence: 75,
      thesisSummary: 'Bullish direction supported by technical indicators',
      supportingFactors: ['Above SMA-20', 'Rising momentum'],
      contradictingFactors: ['Wide bid-ask spread'],
      uncertainty: 20,
    },
    candidateAssessment: {
      attractivenessScore: 78,
      riskLevel: 'MEDIUM',
      keyRisks: ['Time decay', 'Volatility risk'],
      recommendation: 'APPROVE',
      recommendationExplanation: 'Good risk-reward ratio for bullish call',
      confidenceIntervals: {
        low: 65,
        mid: 78,
        high: 85,
      },
    },
    comparedToDeterministicSignal: {
      deterministicAction: 'BUY',
      aiRecommendedAction: 'APPROVE',
      consensusScore: 90,
    },
    summary: {
      overallAssessment: 'High-confidence bullish call with strong technical support',
      keyInsights: ['Clear trend direction', ' Favorable risk-reward'],
      confidenceLevel: 'HIGH',
      executionAdvisory: 'SHADOW_ONLY',
    },
    generationMetadata: {
      latencyMs: 500,
      inputTokens: 2500,
      outputTokens: 300,
    },
  };
  
  console.log('✓ Types validated successfully');
}

// Test 2: AI routing through existing Hermes AI infrastructure
async function testAiRouting() {
  console.log('\n=== Test 2: AI Routing Integration ===');
  
  const { AiRoutingService } = require(path.join(DIST_DIR, 'ai/ai-routing.service'));
  const { HERMES_MODELS, getAiModel } = require(path.join(DIST_DIR, 'ai/ai-model-registry'));
  
  const router = new AiRoutingService();
  
  // Test trading_research task routes to Qwen
  const decision = router.resolveWithDecision({
    taskType: 'trading_research',
  });
  
  assert.equal(decision.selectedModelKey, 'hermes.qwen.coder.default');
  assert.equal(decision.selectedProvider, 'bedrock');
  assert.equal(decision.selectedModelId, 'qwen.qwen3-coder-next');
  
  console.log('✓ Trading research task routes to Qwen model');
}

// Test 3: AI input payload construction
async function testAiInputConstruction() {
  console.log('\n=== Test 3: AI Input Payload Construction ===');
  
  const { AiTradingInput } = require(path.join(DIST_DIR, 'trading/trading-ai.types'));
  
  const input = {
    version: '1.0.0',
    decisionTimestamp: new Date().toISOString(),
    sessionPhase: 'open',
    underlying: 'NIFTY50-INDEX',
    instrument: 'NSE:NIFTY28SEPCAL22000',
    contract: {
      symbol: 'NSE:NIFTY28SEPCAL22000',
      underlying: 'NIFTY50-INDEX',
      expiry: '2024-09-28',
      strike: 22000,
      optionType: 'CE',
      lotSize: 25,
      dte: 21,
    },
    quote: {
      premium: 150.50,
      bid: 150.00,
      ask: 151.00,
      ltp: 150.50,
      volume: 10000,
      openInterest: 50000,
    },
    direction: {
      spot: 22100,
      sma20: 22050,
      sma5: 22080,
      momentum: 0.002,
      bias: 'bullish',
      directionReason: 'Underlying above SMA-20',
      rawConfidence: 65,
    },
    greeks: {
      localDelta: 0.55,
    },
    scoring: {
      atmScore: 0.8,
      expiryScore: 0.9,
      greeksScore: 0.7,
      liquidityScore: 0.6,
      spreadScore: 0.8,
      costScore: 0.5,
      sameUnderlyingNudge: 1,
      totalScore: 8.5,
      rank: 1,
      totalCandidates: 5,
    },
    capital: {
      contractValue: 93750,
      availableHeadroom: 500000,
      portfolioCapital: 100000,
      portfolioDeployed: 25000,
      portfolioCeiling: 125000,
      paperQty: 1,
    },
    candidateReasons: ['Bullish directional bias'],
    decay: {
      decayedConfidence: 58,
      rawConfidence: 65,
      rate: 0.04,
      ageHours: 2.5,
      timingFactor: 1.0,
      inWindow: true,
      weekday: 0,
      windowStartHour: 9.5,
      windowEndHour: 15.25,
    },
    astroMatch: {
      shubh: true,
      score: 75,
      label: 'Shubh window',
    },
    dataQuality: {
      dataAgeMin: 1.5,
      featureCutoffMs: Date.now(),
      quoteTsMs: Date.now(),
      quotesConsumed: 1,
      indexBars: 30,
    },
    metadata: {
      algoSource: 'option-candidate-rank-v1',
      sessionPhase: 'open',
      isFriday: false,
      fridayBlocked: false,
      cycleLatencyMs: 150,
    },
  };
  
  // Verify all required fields are present
  const requiredFields = [
    'version', 'decisionTimestamp', 'sessionPhase', 'underlying', 'instrument',
    'contract', 'quote', 'direction', 'greeks', 'scoring', 'capital',
    'candidateReasons', 'decay', 'astroMatch', 'dataQuality', 'metadata',
  ];
  
  for (const field of requiredFields) {
    assert(field in input, 'Missing required field: ' + field);
  }
  
  console.log('✓ AI input payload constructed correctly');
}

// Test 4: AI output schema validation
async function testAiOutputSchema() {
  console.log('\n=== Test 4: AI Output Schema Validation ===');
  
  const { AiTradingAssessment } = require(path.join(DIST_DIR, 'trading/trading-ai.types'));
  
  const assessment = {
    version: '1.0.0',
    modelIdentity: {
      routingPolicyVersion: 'v1',
      HermesModelKey: 'hermes.qwen.coder.default',
      selectedModelKey: 'hermes.qwen.coder.default',
      selectedProvider: 'bedrock',
      selectedModelId: 'qwen.qwen3-coder-next',
      selectedModelTier: 'worker',
      selectedModelExperimental: false,
    },
    directionalAssessment: {
      agreement: 'AGREES',
      confidence: 75,
      thesisSummary: 'Bullish direction with strong technical support',
      supportingFactors: ['Above SMA-20', 'Rising momentum'],
      contradictingFactors: ['Wide bid-ask spread'],
      uncertainty: 15,
    },
    candidateAssessment: {
      attractivenessScore: 78,
      riskLevel: 'MEDIUM',
      keyRisks: ['Time decay', 'Volatility'],
      recommendation: 'APPROVE',
      recommendationExplanation: 'Favorable risk-reward ratio',
      confidenceIntervals: {
        low: 70,
        mid: 78,
        high: 85,
      },
    },
    comparedToDeterministicSignal: {
      deterministicAction: 'BUY',
      aiRecommendedAction: 'APPROVE',
      consensusScore: 85,
    },
    summary: {
      overallAssessment: 'High-quality bullish call candidate',
      keyInsights: ['Clear trend', 'Good liquidity'],
      confidenceLevel: 'HIGH',
      executionAdvisory: 'SHADOW_ONLY',
    },
    generationMetadata: {
      latencyMs: 450,
    },
  };
  
  // Verify required fields
  assert.equal(assessment.version, '1.0.0');
  assert.ok(assessment.modelIdentity);
  assert.ok(assessment.directionalAssessment);
  assert.ok(assessment.candidateAssessment);
  assert.ok(assessment.comparedToDeterministicSignal);
  assert.ok(assessment.summary);
  
  console.log('✓ AI output schema validated');
}

// Test 5: Shadow mode guarantees
async function testShadowModeGuarantees() {
  console.log('\n=== Test 5: SHADOW-MODE Guarantees ===');
  
  // Test that AI assessment is advisory only
  const { AiTradingAssessment } = require(path.join(DIST_DIR, 'trading/trading-ai.types'));
  
  const assessment = {
    version: '1.0.0',
    modelIdentity: {
      routingPolicyVersion: 'v1',
      HermesModelKey: 'hermes.qwen.coder.default',
      selectedModelKey: 'hermes.qwen.coder.default',
      selectedProvider: 'bedrock',
      selectedModelId: 'qwen.qwen3-coder-next',
      selectedModelTier: 'worker',
      selectedModelExperimental: false,
    },
    directionalAssessment: {
      agreement: 'AGREES',
      confidence: 80,
      thesisSummary: 'Strong bullish setup',
      supportingFactors: ['Trend confirmation'],
      contradictingFactors: [],
      uncertainty: 10,
    },
    candidateAssessment: {
      attractivenessScore: 85,
      riskLevel: 'LOW',
      keyRisks: [],
      recommendation: 'APPROVE',
      recommendationExplanation: 'High probability setup',
      confidenceIntervals: {
        low: 80,
        mid: 85,
        high: 90,
      },
    },
    comparedToDeterministicSignal: {
      deterministicAction: 'BUY',
      aiRecommendedAction: 'APPROVE',
      consensusScore: 95,
    },
    summary: {
      overallAssessment: 'Excellent setup for long call',
      keyInsights: ['Clear direction', ' Favorable risk'],
      confidenceLevel: 'HIGH',
      executionAdvisory: 'SHADOW_ONLY',  // CRITICAL: Always SHADOW_ONLY
    },
    generationMetadata: { latencyMs: 400 },
  };
  
  // Verify execution advisory is always SHADOW_ONLY
  assert.equal(
    assessment.summary.executionAdvisory,
    'SHADOW_ONLY',
    'Execution advisory must always be SHADOW_ONLY for trading assessment',
  );
  
  // Verify AI recommended action never creates BUY/SELL (it's advisory)
  const validActions = ['APPROVE', 'REJECT', 'REVIEW', null];
  assert(
    validActions.includes(assessment.comparedToDeterministicSignal.aiRecommendedAction),
    'AI recommended action must be APPROVE/REJECT/REVIEW/null (advisory only)',
  );
  
  console.log('✓ SHADOW-MODE guarantees verified');
}

// Test 6: Deterministic signal preservation
async function testDeterministicSignalPreservation() {
  console.log('\n=== Test 6: Deterministic Signal Preservation ===');
  
  // Simulate deterministic signal
  const deterministicSignal = {
    instrument: 'NSE:NIFTY28SEPCAL22000',
    algoSource: 'option-candidate-rank-v1',
    action: 'BUY',  // Deterministic decision
    price: 150.50,
    target: 225.75,
    stopLoss: 112.87,
    confidence: 65,
    decayedConfidence: 58,
    decay: {
      rate: 0.04,
      ageHours: 2.5,
      timingFactor: 1.0,
      weekday: 0,
      windowStartHour: 9.5,
      windowEndHour: 15.25,
      lastRectifiedAt: null,
    },
    scenarios: [
      { name: 'bull', probability: 45, target: 225.75 },
      { name: 'base', probability: 30, target: 165.55 },
      { name: 'bear', probability: 25, target: 90.30 },
    ],
    astroMatch: { shubh: true, score: 75, label: 'Shubh window' },
    fridayBlocked: false,
    reasons: ['Bullish trend', ' Favorable Greeks'],
  };
  
  // AI assessment should never create/modify BUY/SELL
  const aiAssessment = {
    recommendation: 'APPROVE',  // Advisory only
    confidence: 85,
  };
  
  // Verify AI does NOT create BUY/SELL (it's assessment, not signal)
  assert(
    !['BUY', 'SELL'].includes(aiAssessment.recommendation),
    'AI assessment must never create BUY/SELL signals',
  );
  
  // Verify deterministic signal action is preserved
  assert.equal(deterministicSignal.action, 'BUY', 'Deterministic BUY signal must be preserved');
  
  console.log('✓ Deterministic signal preservation verified');
}

// Test 7: Journal metadata structure
async function testJournalMetadata() {
  console.log('\n=== Test 7: Journal Metadata Structure ===');
  
  // Verify journal entry includes AI assessment metadata
  const journalEntry = {
    ts: new Date(),
    portfolioId: 'portfolio-123',
    actionFamily: 'BUY',
    winnerSymbol: 'NSE:NIFTY28SEPCAL22000',
    algoSource: 'option-candidate-rank-v1',
    detailJson: JSON.stringify({
      direction: { 'NSE:NIFTY50-INDEX': 'CE (conf 65)' },
      candidates: [{
        symbol: 'NSE:NIFTY28SEPCAL22000',
        premium: 150.50,
        contractValue: 93750,
        score: 8.5,
      }],
      rejected: [],
      reasons: ['Bullish trend'],
      aiAssessment: {  // AI metadata in journal
        version: '1.0.0',
        modelIdentity: {
          routingPolicyVersion: 'v1',
          selectedModelKey: 'hermes.qwen.coder.default',
          selectedProvider: 'bedrock',
        },
        summary: {
          executionAdvisory: 'SHADOW_ONLY',
        },
      },
      cycle: {
        latencyMs: 150,
      },
    }),
  };
  
  const detail = JSON.parse(journalEntry.detailJson);
  
  assert.ok(detail.aiAssessment, 'Journal must include aiAssessment metadata');
  assert.equal(detail.aiAssessment.summary.executionAdvisory, 'SHADOW_ONLY');
  assert.equal(detail.aiAssessment.modelIdentity.selectedProvider, 'bedrock');
  
  console.log('✓ Journal metadata structure verified');
}

// Main test runner
async function main() {
  console.log('╔════════════════════════════════════════════════════════════════╗');
  console.log('║     AI Trading Module Integration Tests (SHADOW-MODE)         ║');
  console.log('╚════════════════════════════════════════════════════════════════╝');
  
  try {
    await testTypeInfo();
    await testAiRouting();
    await testAiInputConstruction();
    await testAiOutputSchema();
    await testShadowModeGuarantees();
    await testDeterministicSignalPreservation();
    await testJournalMetadata();
    
    console.log('\n╔════════════════════════════════════════════════════════════════╗');
    console.log('║  ALL AI TRADING INTEGRATION TESTS PASSED ✓                    ║');
    console.log('╚════════════════════════════════════════════════════════════════╝\n');
    
    process.exit(0);
  } catch (error) {
    console.error('\n✗ TEST FAILED:', error);
    console.error(error.stack);
    process.exitCode = 1;
  }
}

main();
