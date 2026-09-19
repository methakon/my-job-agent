/**
 * Event Intelligence System — Core Types
 *
 * All TypeScript interfaces, type aliases, and constants for the event
 * intelligence runtime. Every other file in this directory imports from here.
 *
 * PAPER TRADING ONLY: This system generates PAPER_CANDIDATE / ABSTAIN verdicts.
 * It never places real orders or executes trades.
 *
 * SAFETY: Event is evidence, not decision. NEVER reduce to bullish/bearish.
 * Forecast outputs are distributions, not call/put/sell signals.
 */

// ── Event Ontology ───────────────────────────────────────────────────────────

/** Canonical event categories. Each event has exactly one ontology. */
export type EventOntology =
  | 'MACRO'
  | 'CENTRAL_BANK'
  | 'GEOPOLITICAL'
  | 'COMMODITIES'
  | 'FINANCIAL_SYSTEM'
  | 'INDIA'
  | 'MICROSTRUCTURE';

// ── Event Lifecycle ──────────────────────────────────────────────────────────

/** Lifecycle states an event can occupy as new evidence arrives. */
export type EventLifecycle =
  | 'SCHEDULED'
  | 'RUMOR'
  | 'PRELIMINARY'
  | 'OFFICIAL'
  | 'REVISED'
  | 'DENIED'
  | 'CONFIRMED'
  | 'RESOLVED'
  | 'RETRACTED';

// ── Source Tiers ─────────────────────────────────────────────────────────────

/**
 * Source reliability tiers. Tier 1 is highest confidence.
 * Source tier affects how quickly we act on information and how
 * much corroboration is needed.
 */
export type SourceTier =
  | 'TIER1_AUTHORITATIVE'
  | 'TIER2_MARKET_DATA'
  | 'TIER3_STRUCTURED_MACRO'
  | 'TIER4_GENERAL_DISCOVERY';

// ── Error Classifications ────────────────────────────────────────────────────

/**
 * Re-export error classifications for event-intel consumers.
 * Mirrors shared/error-classifications.ts — kept as constants
 * to avoid cross-directory imports at runtime.
 */
export const EVENT_ERROR_CLASSIFICATION = {
  EXPECTED_HANDLED: 'EXPECTED_HANDLED',
  RECOVERED: 'RECOVERED',
  RETRYING: 'RETRYING',
  DEGRADED: 'DEGRADED',
  BLOCK_NEW_ENTRIES: 'BLOCK_NEW_ENTRIES',
  UNHANDLED_EXCEPTION: 'UNHANDLED_EXCEPTION',
  FATAL_STARTUP: 'FATAL_STARTUP',
} as const;

export type EventErrorClassification =
  typeof EVENT_ERROR_CLASSIFICATION[keyof typeof EVENT_ERROR_CLASSIFICATION];

// ── Raw Record ───────────────────────────────────────────────────────────────

/**
 * A single observation from a single source. Raw records are immutable
 * and never modified — they are the ground truth for audit/corroboration.
 */
export interface EventRawRecord {
  /** Unique identifier for this specific raw observation. */
  readonly sourceId: string;
  /** Human-readable source name (e.g., "Reuters", "Bloomberg"). */
  readonly sourceName: string;
  /** Source reliability tier. */
  readonly sourceTier: SourceTier;
  /** URL or reference to the original source. */
  readonly sourceUrl: string;
  /** When the source published this information. */
  readonly sourcePublishedAt: number;
  /** When the source last updated this information (0 if never updated). */
  readonly sourceUpdatedAt: number;
  /** When this system received the raw record. */
  readonly receivedAt: number;
  /** When this system finished processing the raw record. */
  readonly processedAt: number;
  /** Headline or title of the event. */
  readonly title: string;
  /** Full body text or summary. */
  readonly body: string;
  /** Source-type classification (e.g., "press_release", "social_media", "data_release"). */
  readonly sourceType: string;
  /** ISO 639-1 language code. */
  readonly language: string;
  /** Deterministic hash of the raw payload for deduplication. */
  readonly rawPayloadHash: string;
  /** Semantic fingerprint for merging similar events. */
  readonly eventFingerprint: string;
}

// ── Event Evidence ───────────────────────────────────────────────────────────

/** Evidence attached to a specific event version. */
export interface EventEvidence {
  /** The raw record that constitutes this evidence. */
  readonly rawRecord: EventRawRecord;
  /** When this evidence was added. */
  readonly addedAtMs: number;
  /** Source reliability at time of addition. */
  readonly sourceTier: SourceTier;
  /** Any extracted features from this evidence. */
  readonly extractedFeatures?: EventFeatures;
}

// ── Event Version ────────────────────────────────────────────────────────────

/** Immutable event version. Versions are append-only; old versions are preserved. */
export interface EventVersion {
  /** Version number (1-based, monotonically increasing). */
  readonly version: number;
  /** All evidence contributing to this version. */
  readonly evidence: readonly EventEvidence[];
  /** Timestamp when this version was created. */
  readonly createdAtMs: number;
  /** Snapshot of lifecycle at this version. */
  readonly lifecycle: EventLifecycle;
  /** Human-readable reason for this version's creation. */
  readonly reasonCode: string;
}

// ── Event ────────────────────────────────────────────────────────────────────

/** Canonical event entity. Immutable core; versions append over time. */
export interface Event {
  /** Canonical event ID — stable across versions. */
  readonly id: string;
  /** Event classification. */
  readonly ontology: EventOntology;
  /** Current lifecycle state. */
  readonly lifecycle: EventLifecycle;
  /** Append-only version history. */
  readonly versions: readonly EventVersion[];
  /** Current state in the event state machine. */
  readonly currentState: EventStateMachineState;
  /** When the event was first detected. */
  readonly detectedAtMs: number;
  /** When the event last updated. */
  readonly lastUpdatedAtMs: number;
}

// ── Event State Machine ──────────────────────────────────────────────────────

/**
 * State machine states for event lifecycle tracking.
 * S0 → S1 → S2 → S4 → S5 is the normal path.
 * S3 (contradiction) can branch from S1 or S2.
 * S6 (retracted) is terminal.
 * S0B (pre-event positioning) is a special pre-schedule state.
 * S7 (market closed) suspends processing until next session.
 */
export type EventStateMachineState =
  | 'S0_DETECTED'
  | 'S0B_PRE_EVENT_POSITIONING'
  | 'S1_INITIAL_SHOCK'
  | 'S2_CROSS_ASSET_CONFIRMED'
  | 'S3_CONTRADICTION'
  | 'S4_ASSIMILATED'
  | 'S5_FOLLOW_UP'
  | 'S6_RETRACTED_OR_INVALIDATED'
  | 'S7_MARKET_CLOSED_PENDING_NEXT_SESSION';

/** Valid state transitions. From → Set of allowed To states. */
export const VALID_TRANSITIONS: ReadonlyMap<EventStateMachineState, ReadonlySet<EventStateMachineState>> =
  new Map<EventStateMachineState, ReadonlySet<EventStateMachineState>>([
    ['S0_DETECTED', new Set(['S0B_PRE_EVENT_POSITIONING', 'S1_INITIAL_SHOCK', 'S6_RETRACTED_OR_INVALIDATED', 'S7_MARKET_CLOSED_PENDING_NEXT_SESSION'])],
    ['S0B_PRE_EVENT_POSITIONING', new Set(['S1_INITIAL_SHOCK', 'S6_RETRACTED_OR_INVALIDATED', 'S7_MARKET_CLOSED_PENDING_NEXT_SESSION'])],
    ['S1_INITIAL_SHOCK', new Set(['S2_CROSS_ASSET_CONFIRMED', 'S3_CONTRADICTION', 'S4_ASSIMILATED', 'S6_RETRACTED_OR_INVALIDATED', 'S7_MARKET_CLOSED_PENDING_NEXT_SESSION'])],
    ['S2_CROSS_ASSET_CONFIRMED', new Set(['S4_ASSIMILATED', 'S3_CONTRADICTION', 'S5_FOLLOW_UP', 'S6_RETRACTED_OR_INVALIDATED', 'S7_MARKET_CLOSED_PENDING_NEXT_SESSION'])],
    ['S3_CONTRADICTION', new Set(['S1_INITIAL_SHOCK', 'S2_CROSS_ASSET_CONFIRMED', 'S4_ASSIMILATED', 'S6_RETRACTED_OR_INVALIDATED', 'S7_MARKET_CLOSED_PENDING_NEXT_SESSION'])],
    ['S4_ASSIMILATED', new Set(['S5_FOLLOW_UP', 'S6_RETRACTED_OR_INVALIDATED', 'S7_MARKET_CLOSED_PENDING_NEXT_SESSION'])],
    ['S5_FOLLOW_UP', new Set(['S6_RETRACTED_OR_INVALIDATED', 'S7_MARKET_CLOSED_PENDING_NEXT_SESSION'])],
    ['S6_RETRACTED_OR_INVALIDATED', new Set([])], // terminal
    ['S7_MARKET_CLOSED_PENDING_NEXT_SESSION', new Set(['S0_DETECTED', 'S1_INITIAL_SHOCK', 'S2_CROSS_ASSET_CONFIRMED', 'S4_ASSIMILATED', 'S6_RETRACTED_OR_INVALIDATED'])],
  ]);

/** Triggers that cause state transitions. */
export type StateTransitionTrigger =
  | 'EVIDENCE_RECEIVED'
  | 'CROSS_ASSET_CONFIRMED'
  | 'CROSS_ASSET_FAILED'
  | 'CONTRADICTION_DETECTED'
  | 'CONTRADICTION_RESOLVED'
  | 'RETRACTION_RECEIVED'
  | 'MARKET_CLOSED'
  | 'MARKET_OPENED'
  | 'TIME_DECAY'
  | 'MANUAL_OVERRIDE';

/** Result of a state transition. */
export interface StateTransitionResult {
  readonly newState: EventStateMachineState;
  readonly previousState: EventStateMachineState;
  readonly timestamp: number;
  readonly reasonCode: string;
  readonly featureHash: string;
  readonly trigger: StateTransitionTrigger;
  readonly evidenceVersion: number;
}

// ── Cross-Asset Transmission ─────────────────────────────────────────────────

/** Nodes in the cross-asset transmission graph. */
export type TransmissionNode =
  | 'USD_DXY'
  | 'US_RATES'
  | 'INDIA_RATES'
  | 'INR'
  | 'CRUDE'
  | 'GOLD'
  | 'GLOBAL_EQUITY'
  | 'ASIAN_EQUITY'
  | 'NIFTY'
  | 'BANKNIFTY'
  | 'FUTURES'
  | 'OPTION_SURFACE';

/** Data availability status for a transmission node. */
export type DataAvailability =
  | 'SOURCE_AVAILABLE'
  | 'SOURCE_STALE'
  | 'SOURCE_UNAVAILABLE'
  | 'MARKET_CLOSED';

/** A directed edge in the transmission graph. */
export interface TransmissionEdge {
  readonly from: TransmissionNode;
  readonly to: TransmissionNode;
  /** Lead/lag in milliseconds (positive = from leads to). */
  readonly leadLag: number;
  /** Rolling correlation coefficient. */
  readonly rollingCorrelation: number;
  /** Event-specific sensitivity multiplier. */
  readonly eventSpecificSensitivity: number;
  /** Direction sign: 1 = same direction, -1 = inverse. */
  readonly sign: 1 | -1;
  /** Confidence in this edge (0-1). */
  readonly confidence: number;
  /** Market regime when this edge was calculated. */
  readonly regime: string;
  /** Exponential time decay (half-life in seconds). */
  readonly timeDecay: number;
}

/** Full transmission graph state. */
export interface TransmissionGraph {
  readonly edges: readonly TransmissionEdge[];
  readonly nodeAvailability: ReadonlyMap<TransmissionNode, DataAvailability>;
  readonly regime: string;
  readonly calculatedAtMs: number;
}

// ── Option Chain Features ────────────────────────────────────────────────────

/** Spot and futures data. */
export interface SpotFuturesFeatures {
  readonly spot: number;
  readonly futures: number;
  readonly basis: number;
  readonly returns1d: number;
  readonly gapPct: number;
  readonly momentum5d: number;
  readonly vwapDistancePct: number;
  readonly realizedVolatility: number;
  readonly futuresVolume: number;
  readonly futuresOI: number;
}

/** Implied volatility features. */
export interface IVFeatures {
  readonly atmIV: number;
  readonly ivByStrike: ReadonlyMap<number, number>;
  readonly ivByExpiry: ReadonlyMap<string, number>;
  readonly ivPercentile: number;
  readonly ivRank: number;
  readonly eventPremium: number;
  readonly ivChange1d: number;
}

/** Skew features. */
export interface SkewFeatures {
  readonly twentyFiveDeltaRR: number;
  readonly putCallSkew: number;
  readonly skewChange1d: number;
}

/** Term structure features. */
export interface TermStructureFeatures {
  readonly frontIV: number;
  readonly backIV: number;
  readonly slope: number;
  readonly curvature: number;
  readonly eventExpiryPremium: number;
}

/** Greeks features. */
export interface GreeksFeatures {
  readonly delta: number;
  readonly gamma: number;
  readonly vega: number;
  readonly theta: number;
  readonly vanna: number | null;
  readonly volga: number | null;
  readonly charm: number | null;
}

/** Options flow features. */
export interface FlowFeatures {
  readonly totalVolume: number;
  readonly oiChange: number;
  readonly volumeToOIRatio: number;
  readonly callPutImbalance: number;
}

/** Liquidity features. */
export interface LiquidityFeatures {
  readonly bidAskSpreadPct: number;
  readonly depth: number;
  readonly staleQuoteCount: number;
  readonly executionStress: number;
}

/** Structures (straddle, strangle, expected move). */
export interface StructureFeatures {
  readonly atmStraddle: number;
  readonly strangle: number;
  readonly expectedMove: number;
  readonly breakEvenMove: number;
}

/** Aggregated option chain features. */
export interface OptionChainFeatures {
  readonly spotFutures: SpotFuturesFeatures;
  readonly iv: IVFeatures;
  readonly skew: SkewFeatures;
  readonly termStructure: TermStructureFeatures;
  readonly greeks: GreeksFeatures;
  readonly flow: FlowFeatures;
  readonly liquidity: LiquidityFeatures;
  readonly structures: StructureFeatures;
}

// ── Forecast Distribution ────────────────────────────────────────────────────

/**
 * Forecast probability distribution for an event.
 * NEVER output only CALL/PUT/BUY/SELL — always a distribution.
 * The abstain probability reflects uncertainty; when high, the system
 * should NOT trade.
 */
export interface ForecastDistribution {
  /** Probability of up move. */
  readonly pUp: number;
  /** Probability of down move. */
  readonly pDown: number;
  /** Probability of flat/no significant move. */
  readonly pFlat: number;
  /** Move size quantiles [p10, p25, p50, p75, p90] in index points. */
  readonly moveQuantiles: readonly number[];
  /** Time-to-peak quantiles [p25, p50, p75] in minutes. */
  readonly timeToPeakQuantiles: readonly number[];
  /** Probability the move persists through end of session. */
  readonly persistenceProbability: number;
  /** IV change quantiles [p10, p25, p50, p75, p90] in percentage points. */
  readonly ivChangeQuantiles: readonly number[];
  /** Probability of significant IV crush post-event. */
  readonly ivCrushProbability: number;
  /** Expected change in skew (25-delta risk reversal). */
  readonly skewChange: number;
  /** Expected change in term structure slope. */
  readonly termStructureChange: number;
  /** Probability of liquidity stress during event window. */
  readonly liquidityStressProbability: number;
  /**
   * Probability the system should abstain (not trade).
   * HIGH abstain = event too uncertain, data insufficient,
   * or model confidence too low.
   */
  readonly abstainProbability: number;
}

// ── Prediction Record ────────────────────────────────────────────────────────

/** Immutable prediction record. Created once per event per decision point. */
export interface PredictionRecord {
  /** Unique prediction ID. */
  readonly predictionId: string;
  /** The event this prediction is about. */
  readonly eventId: string;
  /** Event version this prediction was based on. */
  readonly evidenceVersion: number;
  /** The forecast distribution at prediction time. */
  readonly forecastDistribution: ForecastDistribution;
  /** Event state machine state at prediction time. */
  readonly eventState: EventStateMachineState;
  /** Option chain features at prediction time. */
  readonly optionFeatures: OptionChainFeatures;
  /** Transmission graph state at prediction time. */
  readonly transmissionGraph: TransmissionGraph;
  /** Timestamp of prediction. */
  readonly predictedAtMs: number;
  /** Decision: PAPER_CANDIDATE or ABSTAIN. */
  readonly decision: 'PAPER_CANDIDATE' | 'ABSTAIN';
  /** Confidence score (0-1). */
  readonly confidence: number;
  /** Specific paper candidate details (only if decision = PAPER_CANDIDATE). */
  readonly paperCandidate?: PaperCandidateDetails;
  /** Reason for abstention (only if decision = ABSTAIN). */
  readonly abstainReason?: string;
  /** Hash of the feature set used for this prediction. */
  readonly featureHash: string;
}

/** Details of a paper trading candidate. */
export interface PaperCandidateDetails {
  /** Strategy type (e.g., "LONG_STRADDLE", "SHORT_STRANGLE"). */
  readonly strategy: string;
  /** Target underlying (e.g., "NIFTY", "BANKNIFTY"). */
  readonly underlying: string;
  /** Specific option contracts. */
  readonly contracts: readonly string[];
  /** Entry timing preference. */
  readonly entryTiming: 'PRE_EVENT' | 'POST_EVENT_MOVE' | 'WAIT_AND_SEE';
  /** Maximum time to hold. */
  readonly maxHoldMinutes: number;
  /** Risk parameters. */
  readonly riskParams: {
    readonly maxLoss: number;
    readonly targetProfit: number;
    readonly stopLoss: number;
  };
}

// ── Event Outcome ────────────────────────────────────────────────────────────

/** Actual outcome of an event, recorded after resolution. */
export interface EventOutcome {
  /** The event this outcome is for. */
  readonly eventId: string;
  /** When the outcome was recorded. */
  readonly recordedAtMs: number;
  /** Actual spot move (index points). */
  readonly actualSpotMove: number;
  /** Actual IV change (percentage points). */
  readonly actualIVChange: number;
  /** Whether the event was retracted/denied. */
  readonly retracted: boolean;
  /** Official status at resolution. */
  readonly lifecycleAtResolution: EventLifecycle;
  /** Outcome source. */
  readonly outcomeSource: string;
  /** Post-event market state description. */
  readonly postEventState: string;
}

// ── Event Counterfactual ─────────────────────────────────────────────────────

/** Records what would have happened under different assumptions. */
export interface EventCounterfactual {
  /** The prediction this counterfactual is about. */
  readonly predictionId: string;
  /** What the forecast predicted. */
  readonly predictedDistribution: ForecastDistribution;
  /** What actually happened. */
  readonly outcome: EventOutcome;
  /** Forecast Brier score (lower = better calibration). */
  readonly brierScore: number;
  /** Whether direction was correct. */
  readonly directionCorrect: boolean;
  /** Whether magnitude was within prediction interval. */
  readonly magnitudeWithinInterval: boolean;
  /** Whether abstaining was the right call. */
  readonly abstainWasCorrect: boolean;
  /** Counterfactual PnL if paper candidate was taken. */
  readonly counterfactualPnl: number;
  /** IV crush impact on the trade. */
  readonly ivCrushImpact: number;
}

// ── Event Error Attribution ──────────────────────────────────────────────────

/** Attributes errors in the event intelligence pipeline. */
export interface EventErrorAttribution {
  /** Error classification. */
  readonly classification: EventErrorClassification;
  /** Component where the error occurred. */
  readonly component: string;
  /** Operation that failed. */
  readonly operation: string;
  /** Error code. */
  readonly errorCode: string;
  /** Human-readable message. */
  readonly message: string;
  /** The event ID if applicable. */
  readonly eventId?: string;
  /** The raw record source ID if applicable. */
  readonly sourceId?: string;
  /** Whether the system recovered. */
  readonly recovered: boolean;
  /** Recovery action taken, if any. */
  readonly recoveryAction?: string;
  /** Latency in milliseconds if relevant. */
  readonly latencyMs?: number;
}

// ── Performance Latency ──────────────────────────────────────────────────────

/** Tracks end-to-end latency through the event intelligence pipeline. */
export interface PerformanceLatency {
  /** Time from source publication to system receipt (ms). */
  readonly ingestionLatencyMs: number;
  /** Time from receipt to classification (ms). */
  readonly classificationLatencyMs: number;
  /** Time from classification to feature extraction (ms). */
  readonly featureExtractionLatencyMs: number;
  /** Time from features to state transition (ms). */
  readonly stateTransitionLatencyMs: number;
  /** Time from state transition to forecast (ms). */
  readonly forecastLatencyMs: number;
  /** Time from forecast to decision (ms). */
  readonly decisionLatencyMs: number;
  /** Total end-to-end latency (ms). */
  readonly totalLatencyMs: number;
}

// ── Market Session State ─────────────────────────────────────────────────────

/** Tracks which markets are open/closed for transmission graph conditioning. */
export interface MarketSessionState {
  readonly nse: DataAvailability;
  readonly mcx: DataAvailability;
  readonly cme: DataAvailability;
  readonly lse: DataAvailability;
  readonly nyse: DataAvailability;
  readonly forex: DataAvailability;
  /** When NSE opened/closed. */
  readonly nseLastChangeMs: number;
  /** Current Indian market phase. */
  readonly indianMarketPhase: 'PRE_MARKET' | 'OPEN' | 'LUNCH_BREAK' | 'CLOSING' | 'CLOSED';
}

// ── Event Features ───────────────────────────────────────────────────────────

/** Extracted features from a raw event record. */
export interface EventFeatures {
  readonly eventType: string;
  readonly eventSubtype: string;
  readonly countries: readonly string[];
  readonly institutions: readonly string[];
  readonly companies: readonly string[];
  readonly assets: readonly string[];
  readonly action: string;
  readonly magnitude: number | null;
  readonly severity: number;
  readonly supplyDemandChannel: string | null;
  readonly scheduled: boolean;
  readonly officialStatus: EventLifecycle;
  readonly novelty: number;
  readonly sourceReliability: number;
  readonly contradictoryStatements: boolean;
  readonly transmissionPaths: readonly TransmissionPath[];
}

/** A single transmission path from event to market impact. */
export interface TransmissionPath {
  readonly from: TransmissionNode;
  readonly to: TransmissionNode;
  readonly expectedSign: 1 | -1;
  readonly expectedLagMs: number;
  readonly confidence: number;
}

// ── Source Adapter Interface ─────────────────────────────────────────────────

/** Interface for pluggable event data source adapters. */
export interface SourceAdapter {
  /** Unique source identifier. */
  readonly sourceId: string;
  /** Human-readable source name. */
  readonly sourceName: string;
  /** Source tier. */
  readonly sourceTier: SourceTier;

  /**
   * Fetch new events from this source.
   * @param sinceMs - Fetch events published after this timestamp.
   * @param limit - Maximum number of events to return.
   */
  fetchEvents(sinceMs: number, limit: number): Promise<readonly EventRawRecord[]>;

  /**
   * Fetch scheduled/future events (economic calendar, etc.).
   * @param fromMs - Start of window.
   * @param toMs - End of window.
   */
  fetchScheduledEvents(fromMs: number, toMs: number): Promise<readonly EventRawRecord[]>;

  /**
   * Fetch updates to previously seen events (revisions, corrections).
   * @param eventIds - IDs of events to check for updates.
   */
  fetchUpdates(eventIds: readonly string[]): Promise<readonly EventRawRecord[]>;

  /**
   * Return health status of this source adapter.
   */
  fetchSourceHealth(): Promise<SourceHealth>;
}

/** Source adapter health status. */
export interface SourceHealth {
  readonly sourceId: string;
  readonly healthy: boolean;
  readonly lastSuccessMs: number;
  readonly lastErrorMs: number;
  readonly errorRate: number;
  readonly averageLatencyMs: number;
  readonly description: string;
}

// ── Replay Fixture ───────────────────────────────────────────────────────────

/** Deterministic replay fixture for testing the event pipeline. */
export interface ReplayFixture {
  /** Fixture name. */
  readonly name: string;
  /** Input events in chronological order. */
  readonly events: readonly EventRawRecord[];
  /** Market data snapshots. */
  readonly marketData: readonly MarketDataSnapshot[];
  /** Expected outcomes at each pipeline stage. */
  readonly expectedOutcomes: readonly ExpectedOutcome[];
  /** Deterministic seed for any randomness. */
  readonly seed: string;
}

/** Market data snapshot at a point in time. */
export interface MarketDataSnapshot {
  readonly timestampMs: number;
  readonly optionFeatures: OptionChainFeatures;
  readonly transmissionGraph: TransmissionGraph;
}

/** Expected outcome at a pipeline stage for verification. */
export interface ExpectedOutcome {
  readonly stage: string;
  readonly eventId: string;
  readonly expectedState: EventStateMachineState;
  readonly expectedDecision: 'PAPER_CANDIDATE' | 'ABSTAIN';
  readonly tolerance?: number;
}

// ── Hawkes Process ───────────────────────────────────────────────────────────

/** Hawkes jump-intensity estimation result. */
export interface HawkesEstimate {
  readonly backgroundIntensity: number;
  readonly currentJumpIntensity: number;
  readonly branchingRatio: number;
  readonly decayHalfLife: number;
  readonly totalIntensity: number;
}

/** Hawkes next-arrival prediction. */
export interface HawkesPrediction {
  readonly predictedArrivalTimeMs: number;
  readonly confidenceInterval: readonly [number, number];
  readonly intensityAtPrediction: number;
}

// ── IV Crush ─────────────────────────────────────────────────────────────────

/** Input for IV crush measurement. */
export interface IVCrushInput {
  readonly preEventATMIV: number;
  readonly postEventATMIV: number;
  readonly actualSpotMove: number;
  readonly impliedMove: number;
  readonly thetaLoss: number;
  readonly spread: number;
  readonly slippage: number;
  readonly optionDelta: number;
  readonly optionVega: number;
  readonly positionSize: number;
}

/** IV crush measurement result. */
export interface IVCrushResult {
  /** Was the direction call correct? */
  readonly directionCorrect: boolean;
  /** Was the option trade profitable (P&L)? */
  readonly optionProfitable: boolean;
  /** Did IV crush overwhelm Delta gains? */
  readonly ivCrushOverwhelmedDelta: boolean;
  /** Did theta loss overwhelm the move? */
  readonly thetaOverwhelmedMove: boolean;
  /** Did spread and slippage destroy the edge? */
  readonly transactionCostsDestroyedEdge: boolean;
  /** Net P&L of the option trade. */
  readonly netPnl: number;
  /** Delta P&L component. */
  readonly deltaPnl: number;
  /** Vega P&L component (IV crush). */
  readonly vegaPnl: number;
  /** Theta P&L component. */
  readonly thetaPnl: number;
  /** Transaction cost component (spread + slippage). */
  readonly transactionCostPnl: number;
  /** Human-readable breakdown. */
  readonly breakdown: string;
}
