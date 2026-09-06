/**
 * Trading AI assessment types.
 * 
 * SHADOW-MODE ARCHITECTURE:
 * - AI provides ASSESSMENT/ADVICE only
 * - Deterministic engine produces BUY/SELL signals
 * - AI cannot influence execution in any way
 * - AI failure must not alter deterministic path
 */

/** Strict enum for execution advisory - never modifiable */
export type ExecutionAdvisory = 'SHADOW_ONLY' | 'REVIEW_REQUIRED' | 'ENHANCEMENT_SUGGESTED';

/** Strict enum for agreement level */
export type AgreementLevel = 'AGREES' | 'DISAGREES' | 'NEUTRAL';

/** Strict enum for risk level */
export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH';

/** Strict enum for recommendation */
export type Recommendation = 'APPROVE' | 'REJECT' | 'REVIEW';

/** Strict enum for confidence level */
export type ConfidenceLevel = 'HIGH' | 'MEDIUM' | 'LOW';

/** Strict enum for deterministic action (never created by AI) */
export type DeterministicAction = 'BUY' | 'SELL' | 'HOLD' | null;

/**
 * Routing metadata from AiRoutingService.
 * Used to overwrite any LLM-provided model identity.
 */
export interface AiRoutingMetadata {
  routingPolicyVersion: string;
  HermesModelKey: string;
  selectedModelKey: string;
  selectedProvider: string;
  selectedModelId: string;
  selectedModelTier: string;
  selectedModelExperimental: boolean;
}

/**
 * AI input payload for trading assessment.
 * Point-in-time, audit-friendly snapshot of trading state.
 * 
 * CRITICAL: All values must be derived from deterministic signal data.
 * NO synthetic placeholder values allowed.
 */
export interface AiTradingInput {
  /**
   * Assessment version for schema evolution tracking.
   * Must be exactly '1.0.0'.
   */
  version: '1.0.0';

  /**
   * Timestamp of the decision cycle (IST-naive like market snapshots).
   * Preserves point-in-time replay.
   */
  decisionTimestamp: string;

  /**
   * Session phase: pre-open | open | post-close | holiday | closed
   */
  sessionPhase: string;

  /**
   * Underlying token (upper case).
   */
  underlying: string;

  /**
   * Instrument symbol (option contract).
   */
  instrument: string;

  /**
   * Option contract details.
   * DTE calculated from decision timestamp + expiry (point-in-time).
   */
  contract: {
    symbol: string;
    underlying: string;
    expiry: string; // ISO date string YYYY-MM-DD
    strike: number;
    optionType: 'CE' | 'PE';
    lotSize: number; // Must be actual from contract registry
    dte: number; // Calculated from asOf + expiry, NOT from new Date()
  };

  /**
   * Quote data at decision time (point-in-time snapshot).
   * ALL fields must be actual market data, never synthetic.
   */
  quote: {
    premium: number; // Actual premium from journal/candidates
    bid?: number | null; // Actual bid, may be null
    ask?: number | null; // Actual ask, may be null
    ltp?: number; // Actual LTP, may be absent
    bidAskSpreadPct?: number | null; // Derived from actual bid/ask
    volume?: number; // Actual volume, may be absent
    openInterest?: number; // Actual OI, may be absent
    oiChange?: number | null; // Actual OI change, may be absent
    impliedVolatility?: number | null; // Actual IV, may be absent
    delta?: number | null; // Actual delta, may be absent
    provider?: string; // Actual provider name
    quoteAgeMin?: number; // Derived from quote timestamp vs decision timestamp
  };

  /**
   * Direction analysis from index snapshots.
   * Must be actual computed direction from deterministic engine.
   */
  direction: {
    spot: number; // Actual spot from index snapshot
    sma20: number; // Actual SMA-20 from index bars
    sma5: number; // Actual SMA-5 from index bars
    momentum: number | null; // Actual momentum calculation
    bias: 'bullish' | 'bearish' | 'range' | null; // Actual detected bias
    directionReason: string; // Actual reason from deterministic engine
    rawConfidence: number; // Actual confidence from deterministic signal
  };

  /**
   * Greeks computed locally (BSM) + provider cross-check.
   * Must be actual computed greeks, not defaults.
   */
  greeks: {
    localDelta?: number | null; // Actual BSM delta
    providerDelta?: number | null; // Provider delta from MDS
    iv?: number | null; // Actual implied volatility
    theta?: number | null; // Actual theta
    vega?: number | null; // Actual vega
  };

  /**
   * Score components (weighted sum determines winner).
   * Must be actual scores from deterministic ranking.
   */
  scoring: {
    atmScore: number; // 0-1, actual score from deterministic engine
    expiryScore: number; // 0-1, actual score from deterministic engine
    greeksScore: number; // 0-1, actual score from deterministic engine
    liquidityScore: number; // 0-1, actual score from deterministic engine
    spreadScore: number; // 0-1, actual score from deterministic engine
    costScore: number; // 0-1, actual score from deterministic engine
    sameUnderlyingNudge: number; // 0 or 1, actual nudge
    totalScore: number; // Sum of weighted scores
    rank: number; // 1 = winner, >1 = runner-up (from deterministic ranking)
    totalCandidates: number; // Total candidates from deterministic engine
  };

  /**
   * Capital/affordability information.
   * Must be actual portfolio state at decision time.
   */
  capital: {
    contractValue: number; // premium * lotSize * quantity
    availableHeadroom: number; // portfolioCapital + netPnl - portfolioDeployed
    portfolioCapital: number; // Actual capital from portfolio
    portfolioDeployed: number; // Actual deployed from portfolio
    portfolioCeiling: number; // Actual ceiling from portfolio
    paperQty: number; // Actual paper trading quantity
  };

  /**
   * Rejection reasons for rejected candidates (if any).
   * Actual rejections from deterministic engine.
   */
  rejections?: string[];

  /**
   * Reasons for this specific candidate.
   * Actual reasons from deterministic signal.
   */
  candidateReasons: string[];

  /**
   * Decay information applied to confidence.
   * Actual decay values from deterministic engine.
   */
  decay: {
    decayedConfidence: number; // Actual from deterministic signal
    rawConfidence: number; // Actual from deterministic signal
    rate: number; // Actual decay rate
    ageHours: number; // Actual age in hours
    timingFactor: number; // Actual timing factor (0-1 or >1)
    inWindow: boolean; // Actual window check
    weekday: number; // 0-6 (Sunday-Saturday)
    windowStartHour: number; // Actual window
    windowEndHour: number; // Actual window
  };

  /**
   * Astro match information.
   * Actual astro match from deterministic engine.
   */
  astroMatch: {
    shubh: boolean; // Actual shubh status
    score: number; // Actual astro score (0-100)
    label: string; // Actual label from astro service
  };

  /**
   * Data freshness and quality indicators.
   * Actual data quality metrics from deterministic engine.
   * 
   * CRITICAL: No synthetic placeholders allowed.
   */
  dataQuality: {
    dataAgeMin: number; // Actual data age in minutes (0 or positive finite)
    featureCutoffMs: number | null; // Actual cutoff timestamp or null
    quoteTsMs: number; // Actual quote timestamp
    quotesConsumed: number; // Actual count from deterministic engine
    indexBars: number; // Actual count from deterministic engine
  };

  /**
   * Decision metadata.
   * Actual metadata from deterministic engine.
   */
  metadata: {
    algoSource: string; // Actual algorithm source
    buildSha?: string; // Actual build SHA or undefined
    sessionPhase: string; // Actual session phase
    isFriday: boolean; // Actual day of week
    fridayBlocked: boolean; // Actual Friday block status
    cycleLatencyMs: number; // Actual cycle latency (positive finite)
  };
}

/**
 * AI assessment output schema.
 * Strictly typed response from the model.
 * 
 * CRITICAL: All values must be validated strictly.
 * Unknown/malformed values must cause fail-closed.
 */
export interface AiTradingAssessment {
  /**
   * Assessment schema version.
   * Must be exactly '1.0.0'.
   */
  version: '1.0.0';

  /**
   * Model identity for audit trail.
   * Derived from routing metadata, NOT from LLM response.
   * LLM may be queried but identity is overwritten from trusted source.
   */
  modelIdentity: {
    routingPolicyVersion: string; // From AiRoutingService
    HermesModelKey: string; // From AiRoutingService
    selectedModelKey: string; // From AiRoutingService
    selectedProvider: string; // From AiRoutingService
    selectedModelId: string; // From AiRoutingService
    selectedModelTier: string; // From AiRoutingService
    selectedModelExperimental: boolean; // From AiRoutingService
  };

  /**
   * Directional assessment.
   * All fields required and validated.
   */
  directionalAssessment: {
    agreement: AgreementLevel; // Must be one of: AGREES, DISAGREES, NEUTRAL
    confidence: number; // 0-100, finite
    thesisSummary: string; // Non-empty string
    supportingFactors: string[]; // Array of strings (non-empty allowed)
    contradictingFactors: string[]; // Array of strings (non-empty allowed)
    uncertainty: number; // 0-100, finite
  };

  /**
   * Candidate-specific assessment.
   * All fields required and validated.
   */
  candidateAssessment: {
    attractivenessScore: number; // 0-100, finite
    riskLevel: RiskLevel; // Must be one of: LOW, MEDIUM, HIGH
    keyRisks: string[]; // Array of strings
    recommendation: Recommendation; // Must be one of: APPROVE, REJECT, REVIEW
    recommendationExplanation: string; // Non-empty string
    confidenceIntervals: {
      low: number; // 0-100, finite, must be <= mid
      mid: number; // 0-100, finite, must be >= low and <= high
      high: number; // 0-100, finite, must be >= mid
    };
  };

  /**
   * Comparison with deterministic signal.
   * 
   * CRITICAL: AI NEVER generates BUY/SELL - only assesses deterministic decision.
   */
  comparedToDeterministicSignal: {
    deterministicAction: DeterministicAction; //from deterministic engine (BUY/SELL/HOLD/null)
    aiRecommendedAction: Recommendation | null; // From AI: APPROVE/REJECT/REVIEW/null
    disagreementReason?: string; // Optional explanation if AI disagrees
    consensusScore?: number; // 0-100, optional
  };

  /**
   * Executive summary for journal audit.
   * All fields required.
   */
  summary: {
    overallAssessment: string; // Non-empty string
    keyInsights: string[]; // Array of strings
    warnings?: string[]; // Optional array of warning strings
    confidenceLevel: ConfidenceLevel; // Must be one of: HIGH, MEDIUM, LOW
    executionAdvisory: ExecutionAdvisory; // Must be one of: SHADOW_ONLY, REVIEW_REQUIRED, ENHANCEMENT_SUGGESTED
  };

  /**
   * Generation metadata for latency/cost tracking.
   * Optional but validated if present.
   */
  generationMetadata?: {
    inputTokens?: number; // Positive integer or undefined
    outputTokens?: number; // Positive integer or undefined
    latencyMs: number; // Positive finite number
    estimatedInputCost?: number | null; // Non-negative finite or null
    estimatedOutputCost?: number | null; // Non-negative finite or null
    estimatedTotalCost?: number | null; // Non-negative finite or null
  };
}

/**
 * Schema validation error for AI output.
 */
export interface SchemaValidationError {
  field: string; // Dot-notation path to field (e.g., 'modelIdentity.selectedModelKey')
  message: string;
  expected?: string; // Expected type/value
  actual?: string; // Actual value received
}

/**
 * Result of AI assessment (success or failure).
 * 
 * CRITICAL: Fail-closed - invalid assessment is always an error.
 */
export type AiAssessmentResult =
  | { success: true; assessment: AiTradingAssessment }
  | { success: false; error: string; details?: Record<string, unknown> };
