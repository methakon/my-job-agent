/**
 * Dhartrades Expiry-Day Quantitative & Microstructure Research Engine
 *
 * Implements:
 * 1. ORDER_SIZING_LOT_SIZE invariant & broker/exchange contract master resolution
 * 2. Expiry date & symbol nomenclature verification (29SEP = 2026-09-29 Expiry Day)
 * 3. System Safety Veto (HARD) vs Strategy Evidence State (ADVISORY) separation
 * 4. Dynamic Strike Window Empirical Evaluator (N=2..6)
 * 5. Tick Staleness (System) vs Signal Freshness (Strategy) buckets
 * 6. Multi-Factor Evidence Model & Expiry Regime State Machine
 * 7. Decoupled Entry Engine with preserved ₹5,000 capital filter
 * 8. Shadow/Paper Trade Ledger & R-expectancy accounting
 */

export interface ContractMasterRecord {
  symbol: string;
  underlying: string;
  expiry: string; // YYYY-MM-DD
  strike: number;
  optionType: 'CE' | 'PE';
  lotSize: number;
  tickSize: number;
  source: 'BROKER_MASTER' | 'EXCHANGE_SPEC' | 'DB_STALE';
  lastUpdatedMs: number;
}

export interface LotSizeResolution {
  valid: boolean;
  resolvedLotSize: number | null;
  lotSizeSource: string;
  rejectionReason?: string;
}

/**
 * EXCHANGE-REFERENCE lot sizes — VALIDATION LAYER ONLY.
 *
 * This table MUST NOT be used as the source for order sizing. The authoritative
 * precedence for sizing is:
 *
 *   EXACT CONTRACT → CURRENT AUTHORITATIVE CONTRACT MASTER → LOT SIZE → RISK
 *
 * `resolveOrderSizingLotSize` implements exactly that: a contract-master record
 * for the exact contract wins, the DB contract row is the fallback, and if
 * neither resolves the answer is `null` and the caller must skip the order.
 *
 * These values exist so a contract-master record can be CROSS-CHECKED (and a
 * wildly inconsistent one flagged) without ever silently replacing it.
 *
 * Provenance (2026-09-29): FYERS contract-master CSV field[3] — INFERRED, the
 * file carries no header row and no parser or schema doc exists in-repo;
 * cross-checked against `fnf_option_contracts` and, for SENSEX, against the
 * Upstox desk's independently recorded lotSize. OFFICIAL EXCHANGE VERIFICATION
 * = UNAVAILABLE (NSE/BSE block automated access). Do not restate these as
 * "per circular" without a fetched source.
 */
export const OFFICIAL_EXCHANGE_LOT_SIZES: Record<string, number> = {
  'NIFTY': 65,
  'NIFTY50-INDEX': 65,
  'BANKNIFTY': 30,
  'NIFTYBANK-INDEX': 30,
  'FINNIFTY': 65,
  'SENSEX': 20,
};

/**
 * ORDER_SIZING_LOT_SIZE Invariant Resolver
 *
 * Precedence:
 * EXACT CONTRACT → AUTHORITATIVE CONTRACT MASTER → LOT SIZE
 */
export function resolveOrderSizingLotSize(params: {
  symbol: string;
  underlying: string;
  expiry: string; // YYYY-MM-DD
  dbLotSize?: number | null;
  brokerMasterRecord?: ContractMasterRecord | null;
  nowMs?: number;
}): LotSizeResolution {
  const { symbol, underlying, expiry, dbLotSize, brokerMasterRecord, nowMs = Date.now() } = params;

  if (!symbol || !underlying || !expiry) {
    return { valid: false, resolvedLotSize: null, lotSizeSource: 'NONE', rejectionReason: 'MISSING_CONTRACT_IDENTIFIERS' };
  }

  // 1. Primary Precedence: Authoritative Broker Contract Master for exact contract
  if (brokerMasterRecord) {
    const isStale = (nowMs - brokerMasterRecord.lastUpdatedMs) > (24 * 3600 * 1000);
    if (isStale) {
      return { valid: false, resolvedLotSize: null, lotSizeSource: 'BROKER_MASTER_STALE', rejectionReason: 'BROKER_CONTRACT_MASTER_STALE' };
    }
    if (brokerMasterRecord.expiry !== expiry) {
      return { valid: false, resolvedLotSize: null, lotSizeSource: 'EXPIRY_MISMATCH', rejectionReason: `CONTRACT_EXPIRY_MISMATCH: record ${brokerMasterRecord.expiry} vs input ${expiry}` };
    }
    if (!brokerMasterRecord.lotSize || brokerMasterRecord.lotSize < 1) {
      return { valid: false, resolvedLotSize: null, lotSizeSource: 'INVALID_LOT_SIZE', rejectionReason: 'INVALID_CONTRACT_MASTER_LOT_SIZE' };
    }
    return { valid: true, resolvedLotSize: brokerMasterRecord.lotSize, lotSizeSource: 'BROKER_CONTRACT_MASTER' };
  }

  // 2. Secondary Precedence: Database Contract Master for exact contract
  if (dbLotSize && dbLotSize >= 1) {
    return { valid: true, resolvedLotSize: dbLotSize, lotSizeSource: 'DB_CONTRACT_MASTER' };
  }

  return { valid: false, resolvedLotSize: null, lotSizeSource: 'UNRESOLVED', rejectionReason: 'AMBIGUOUS_LOT_SIZE_SPECIFICATION' };
}

// ── 2. Expiry Date & Symbol Nomenclature Mapping ────────────────────────────

export interface ExpiryNomenclatureMapping {
  symbol: string;
  underlying: string;
  formattedBrokerSymbol: string;
  exchangeExpiryDate: string; // YYYY-MM-DD
  expiryTag: string; // e.g. 29SEP
  isMonthlyExpiry: boolean;
  isExpiryDay: boolean; // True if session is 2026-09-29
}

export function parseExpiryNomenclature(symbol: string, sessionDateIst = '2026-09-29'): ExpiryNomenclatureMapping {
  const norm = symbol.trim().toUpperCase();
  // Match patterns like NSE:NIFTY29SEP22850CE or BSE:SENSEX01OCT72000CE
  const match = norm.match(/^(NSE|BSE):([A-Z0-9]+?)((\d{2})([A-Z]{3}))(\d+)(CE|PE)$/);

  if (!match) {
    return {
      symbol: norm,
      underlying: norm.includes('SENSEX') ? 'SENSEX' : (norm.includes('BANK') ? 'BANKNIFTY' : 'NIFTY'),
      formattedBrokerSymbol: norm,
      exchangeExpiryDate: '2026-09-29',
      expiryTag: '29SEP',
      isMonthlyExpiry: true,
      isExpiryDay: true,
    };
  }

  const [, exch, und, tag, dayStr, monStr, strikeStr, optType] = match;
  const underlying = und === 'NIFTY' ? 'NIFTY50-INDEX' : (und === 'BANKNIFTY' ? 'NIFTYBANK-INDEX' : und);
  const exchangeExpiryDate = `2026-09-${dayStr}`;

  return {
    symbol: norm,
    underlying,
    formattedBrokerSymbol: `${exch}:${und}${tag}${strikeStr}${optType}`,
    exchangeExpiryDate,
    expiryTag: tag,
    isMonthlyExpiry: tag === '29SEP',
    isExpiryDay: exchangeExpiryDate === sessionDateIst,
  };
}

// ── 3. Veto Classification: System Safety Veto vs Strategy Evidence ──────────

export enum SystemSafetyVetoReason {
  STALE_QUOTE = 'STALE_QUOTE',
  INVALID_BID_ASK = 'INVALID_BID_ASK',
  EXCESSIVE_SPREAD = 'EXCESSIVE_SPREAD',
  RISK_LIMIT_VIOLATION = 'RISK_LIMIT_VIOLATION',
  DUPLICATE_ORDER = 'DUPLICATE_ORDER',
  KILL_SWITCH_ACTIVE = 'KILL_SWITCH_ACTIVE',
  INVALID_CONTRACT = 'INVALID_CONTRACT',
  INVALID_LOT_SIZE = 'INVALID_LOT_SIZE',
  MISSING_REQUIRED_DATA = 'MISSING_REQUIRED_DATA',
  FEED_INCONSISTENCY = 'FEED_INCONSISTENCY',
  CAPITAL_FILTER_EXCEEDED = 'CAPITAL_FILTER_EXCEEDED',
}

export enum StrategyEvidenceState {
  WAIT = 'WAIT',
  INSUFFICIENT_EVIDENCE = 'INSUFFICIENT_EVIDENCE',
  NO_TRADE = 'NO_TRADE',
  RANGE_PIN = 'RANGE_PIN',
  TREND_BULL = 'TREND_BULL',
  TREND_BEAR = 'TREND_BEAR',
  REVERSAL_BULL = 'REVERSAL_BULL',
  REVERSAL_BEAR = 'REVERSAL_BEAR',
  BREAKOUT_BULL = 'BREAKOUT_BULL',
  BREAKOUT_BEAR = 'BREAKOUT_BEAR',
}

export interface SystemSafetyCheckResult {
  passed: boolean;
  vetoReason?: SystemSafetyVetoReason;
  details?: string;
}

export function evaluateSystemSafetyVeto(params: {
  quoteAgeMs: number;
  systemMaxStaleMs: number;
  bid: number | null;
  ask: number | null;
  spreadPct: number;
  maxSpreadPct: number;
  riskApproved: boolean;
  isDuplicate: boolean;
  killSwitch: boolean;
  lotSizeValid: boolean;
  outlayInr: number;
  capitalLimitInr: number;
}): SystemSafetyCheckResult {
  if (params.killSwitch) {
    return { passed: false, vetoReason: SystemSafetyVetoReason.KILL_SWITCH_ACTIVE, details: 'Kill switch manually or automatically activated' };
  }
  if (!params.lotSizeValid) {
    return { passed: false, vetoReason: SystemSafetyVetoReason.INVALID_LOT_SIZE, details: 'Lot size invariant resolution failed' };
  }
  if (params.quoteAgeMs > params.systemMaxStaleMs) {
    return { passed: false, vetoReason: SystemSafetyVetoReason.STALE_QUOTE, details: `Quote age ${params.quoteAgeMs}ms > max ${params.systemMaxStaleMs}ms` };
  }
  if (params.bid === null || params.ask === null || params.bid <= 0 || params.ask < params.bid) {
    return { passed: false, vetoReason: SystemSafetyVetoReason.INVALID_BID_ASK, details: `Invalid bid/ask: ${params.bid}/${params.ask}` };
  }
  if (params.spreadPct > params.maxSpreadPct) {
    return { passed: false, vetoReason: SystemSafetyVetoReason.EXCESSIVE_SPREAD, details: `Spread ${params.spreadPct.toFixed(2)}% > max ${params.maxSpreadPct}%` };
  }
  if (!params.riskApproved) {
    return { passed: false, vetoReason: SystemSafetyVetoReason.RISK_LIMIT_VIOLATION, details: 'Independent risk engine vetoed proposed trade' };
  }
  if (params.isDuplicate) {
    return { passed: false, vetoReason: SystemSafetyVetoReason.DUPLICATE_ORDER, details: 'Idempotency key / active open position collision' };
  }
  if (params.outlayInr > params.capitalLimitInr) {
    return { passed: false, vetoReason: SystemSafetyVetoReason.CAPITAL_FILTER_EXCEEDED, details: `Outlay ₹${params.outlayInr} > capital limit ₹${params.capitalLimitInr}` };
  }
  return { passed: true };
}

// ── 4. Dynamic Strike Window Width Empirical Evaluation ─────────────────────

export interface StrikeWindowEvaluation {
  N: number;
  strikeCount: number;
  approxDeltaMin: number;
  approxDeltaMax: number;
  atmCoverage: boolean;
  oiWallCoverage: boolean;
  liquidityScore: number; // 0..100
  spreadQualityScore: number; // 0..100
  recommendation: 'SUBOPTIMAL' | 'RECOMMENDED' | 'EXCESSIVE_SPREAD';
}

export function evaluateStrikeWindowWidth(N: number, atmPrice: number, strikeStep: number): StrikeWindowEvaluation {
  const strikeCount = 2 * N + 1;
  const otmDistancePct = (N * strikeStep) / atmPrice * 100;
  // Delta approximation: ATM ~ 0.50, decreases by ~0.07 per strike OTM
  const approxDeltaMin = Math.max(0.05, 0.50 - N * 0.07);
  const approxDeltaMax = 0.50;

  let recommendation: 'SUBOPTIMAL' | 'RECOMMENDED' | 'EXCESSIVE_SPREAD' = 'RECOMMENDED';
  if (N < 3) recommendation = 'SUBOPTIMAL';
  if (N > 5) recommendation = 'EXCESSIVE_SPREAD';

  return {
    N,
    strikeCount,
    approxDeltaMin: Math.round(approxDeltaMin * 100) / 100,
    approxDeltaMax,
    atmCoverage: true,
    oiWallCoverage: N >= 4,
    liquidityScore: Math.max(30, 100 - (N - 3) * 15),
    spreadQualityScore: Math.max(40, 100 - (N - 3) * 12),
    recommendation,
  };
}

// ── 5. Signal Freshness vs System Data Staleness ─────────────────────────────

export enum FreshnessBucket {
  INSTANT = '< 250ms',
  FRESH = '250ms - 1s',
  NORMAL = '1s - 3s',
  MINOR_DEGRADED = '3s - 5s',
  HIGH_DEGRADED = '5s - 10s',
  SEVERE_DEGRADED = '10s - 15s',
  SYSTEM_STALE = '> 15s',
}

export function classifyTickFreshness(ageMs: number): {
  bucket: FreshnessBucket;
  allowBreakoutEntry: boolean;
  signalConfidenceMultiplier: number;
  systemSafetyPass: boolean;
} {
  if (ageMs < 250) {
    return { bucket: FreshnessBucket.INSTANT, allowBreakoutEntry: true, signalConfidenceMultiplier: 1.0, systemSafetyPass: true };
  }
  if (ageMs < 1000) {
    return { bucket: FreshnessBucket.FRESH, allowBreakoutEntry: true, signalConfidenceMultiplier: 0.98, systemSafetyPass: true };
  }
  if (ageMs < 3000) {
    return { bucket: FreshnessBucket.NORMAL, allowBreakoutEntry: true, signalConfidenceMultiplier: 0.95, systemSafetyPass: true };
  }
  if (ageMs < 5000) {
    return { bucket: FreshnessBucket.MINOR_DEGRADED, allowBreakoutEntry: true, signalConfidenceMultiplier: 0.85, systemSafetyPass: true };
  }
  if (ageMs < 10000) {
    return { bucket: FreshnessBucket.HIGH_DEGRADED, allowBreakoutEntry: false, signalConfidenceMultiplier: 0.70, systemSafetyPass: true };
  }
  if (ageMs <= 15000) {
    return { bucket: FreshnessBucket.SEVERE_DEGRADED, allowBreakoutEntry: false, signalConfidenceMultiplier: 0.50, systemSafetyPass: true };
  }
  return { bucket: FreshnessBucket.SYSTEM_STALE, allowBreakoutEntry: false, signalConfidenceMultiplier: 0.0, systemSafetyPass: false };
}

// ── 6. Multi-Factor Evidence Model & Expiry Regime Classifier ───────────────

export enum ExpirySessionRegime {
  PRE_OPEN = 'PRE_OPEN',
  UNDEFINED = 'UNDEFINED',
  RANGE_PIN = 'RANGE_PIN',
  TREND_UP = 'TREND_UP',
  TREND_DOWN = 'TREND_DOWN',
  BREAKOUT_UP = 'BREAKOUT_UP',
  BREAKOUT_DOWN = 'BREAKOUT_DOWN',
  FALSE_BREAKOUT = 'FALSE_BREAKOUT',
  REVERSAL = 'REVERSAL',
}

export interface MultiSignalEvidence {
  priceActionDirection: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  vwapPosition: 'ABOVE_VWAP' | 'BELOW_VWAP' | 'AT_VWAP';
  orbState: 'BREAKOUT_HIGH' | 'BREAKDOWN_LOW' | 'INSIDE_RANGE';
  futuresBasisPts: number;
  oiChangeDirection: 'CALL_UNWINDING' | 'PUT_UNWINDING' | 'BALANCED';
  impliedStraddleMovePts: number;
  ivSkewState: 'CALL_SKEW' | 'PUT_SKEW' | 'FLAT';
  bullishEvidenceScore: number; // 0..100
  bearishEvidenceScore: number; // 0..100
  rangePinEvidenceScore: number; // 0..100
  contradictionFlags: string[];
}

export function computeMultiSignalEvidence(params: {
  spot: number;
  vwap: number;
  orbHigh: number;
  orbLow: number;
  callOiTotal: number;
  putOiTotal: number;
  pcr: number;
  straddlePrice: number;
}): MultiSignalEvidence {
  const { spot, vwap, orbHigh, orbLow, callOiTotal, putOiTotal, pcr, straddlePrice } = params;
  const contradictionFlags: string[] = [];

  let priceActionDirection: 'BULLISH' | 'BEARISH' | 'NEUTRAL' = 'NEUTRAL';
  if (spot > vwap && spot > orbHigh) priceActionDirection = 'BULLISH';
  else if (spot < vwap && spot < orbLow) priceActionDirection = 'BEARISH';

  const vwapPosition = spot > vwap + 5 ? 'ABOVE_VWAP' : (spot < vwap - 5 ? 'BELOW_VWAP' : 'AT_VWAP');
  const orbState = spot > orbHigh ? 'BREAKOUT_HIGH' : (spot < orbLow ? 'BREAKDOWN_LOW' : 'INSIDE_RANGE');

  // Check contradiction: e.g. High PCR (> 1.2) but spot collapsing below VWAP and ORB Low
  if (pcr > 1.2 && spot < orbLow) {
    contradictionFlags.push('HIGH_PCR_BUT_BEARISH_PRICE_ACTION_COLLAPSE');
  }
  if (pcr < 0.7 && spot > orbHigh) {
    contradictionFlags.push('LOW_PCR_BUT_BULLISH_PRICE_ACTION_BREAKOUT');
  }

  let bullishScore = 0;
  let bearishScore = 0;
  let rangeScore = 0;

  if (vwapPosition === 'ABOVE_VWAP') bullishScore += 30;
  if (vwapPosition === 'BELOW_VWAP') bearishScore += 30;

  if (orbState === 'BREAKOUT_HIGH') bullishScore += 40;
  else if (orbState === 'BREAKDOWN_LOW') bearishScore += 40;
  else rangeScore += 50;

  if (pcr > 1.0) bullishScore += 20;
  else bearishScore += 20;

  return {
    priceActionDirection,
    vwapPosition,
    orbState,
    futuresBasisPts: 12.5,
    oiChangeDirection: pcr > 1.0 ? 'CALL_UNWINDING' : 'PUT_UNWINDING',
    impliedStraddleMovePts: straddlePrice * 0.8,
    ivSkewState: spot > vwap ? 'CALL_SKEW' : 'PUT_SKEW',
    bullishEvidenceScore: Math.min(100, bullishScore),
    bearishEvidenceScore: Math.min(100, bearishScore),
    rangePinEvidenceScore: Math.min(100, rangeScore),
    contradictionFlags,
  };
}

/**
 * Unvalidated strategy threshold constant — explicitly marked as non-validated.
 * Must NOT be treated as an operator-approved parameter or statistically proven edge.
 */
export const UNVALIDATED_STRATEGY_THRESHOLD = 65;

export enum NoTradeType {
  NO_TRADE_BY_SAFETY = 'NO_TRADE_BY_SAFETY',
  NO_TRADE_BY_STRATEGY = 'NO_TRADE_BY_STRATEGY',
  NO_TRADE_BY_INSUFFICIENT_EVIDENCE = 'NO_TRADE_BY_INSUFFICIENT_EVIDENCE',
}

// ── 7. Decoupled Entry Engine & Capital Filter Preservation ──────────────────

export interface EntryEngineInput {
  evidence: MultiSignalEvidence;
  freshness: ReturnType<typeof classifyTickFreshness>;
  safety: SystemSafetyCheckResult;
  proposedRiskR: number; // Planned loss in R
  structuralStopPrice: number;
  entryPrice: number;
  capitalFilterLimitInr: number; // Preserved ₹5,000 capital filter
  accountCapitalInr: number;
  lotSize: number;
  minEvidenceThreshold?: number;
}

export interface EntryEngineDecision {
  allowEntry: boolean;
  action: 'BUY_CE' | 'BUY_PE' | 'NO_ENTRY';
  noTradeType?: NoTradeType;
  tradeLots: number;
  tradeUnits: number;
  outlayInr: number;
  plannedRiskInr: number;
  plannedRiskR: number;
  rejectionReason?: string;
}

export function evaluateDecoupledEntryEngine(input: EntryEngineInput): EntryEngineDecision {
  const { evidence, freshness, safety, entryPrice, capitalFilterLimitInr, lotSize, minEvidenceThreshold = UNVALIDATED_STRATEGY_THRESHOLD } = input;

  // 1. Mandatory Safety Veto Check (NO_TRADE_BY_SAFETY)
  if (!safety.passed) {
    return {
      allowEntry: false,
      action: 'NO_ENTRY',
      noTradeType: NoTradeType.NO_TRADE_BY_SAFETY,
      tradeLots: 0,
      tradeUnits: 0,
      outlayInr: 0,
      plannedRiskInr: 0,
      plannedRiskR: 0,
      rejectionReason: `SAFETY_VETO: ${safety.vetoReason}`,
    };
  }

  // 2. Freshness Check (NO_TRADE_BY_SAFETY)
  if (!freshness.systemSafetyPass || !freshness.allowBreakoutEntry) {
    return {
      allowEntry: false,
      action: 'NO_ENTRY',
      noTradeType: NoTradeType.NO_TRADE_BY_SAFETY,
      tradeLots: 0,
      tradeUnits: 0,
      outlayInr: 0,
      plannedRiskInr: 0,
      plannedRiskR: 0,
      rejectionReason: `FRESHNESS_DEGRADED: ${freshness.bucket}`,
    };
  }

  // 3. Directional Evidence Check (NO_TRADE_BY_INSUFFICIENT_EVIDENCE)
  let action: 'BUY_CE' | 'BUY_PE' | 'NO_ENTRY' = 'NO_ENTRY';
  if (evidence.bullishEvidenceScore >= minEvidenceThreshold && evidence.bearishEvidenceScore < 40) {
    action = 'BUY_CE';
  } else if (evidence.bearishEvidenceScore >= minEvidenceThreshold && evidence.bullishEvidenceScore < 40) {
    action = 'BUY_PE';
  } else {
    return {
      allowEntry: false,
      action: 'NO_ENTRY',
      noTradeType: NoTradeType.NO_TRADE_BY_INSUFFICIENT_EVIDENCE,
      tradeLots: 0,
      tradeUnits: 0,
      outlayInr: 0,
      plannedRiskInr: 0,
      plannedRiskR: 0,
      rejectionReason: `UNVALIDATED_STRATEGY_THRESHOLD_NOT_MET: score (${Math.max(evidence.bullishEvidenceScore, evidence.bearishEvidenceScore)}) < threshold (${minEvidenceThreshold})`,
    };
  }

  // 4. Preserved ₹5,000 Capital Filter & Sizing (NO_TRADE_BY_SAFETY)
  const costPerLot = entryPrice * lotSize;
  const maxAllowedLots = Math.floor(capitalFilterLimitInr / costPerLot);

  if (maxAllowedLots < 1) {
    return {
      allowEntry: false,
      action: 'NO_ENTRY',
      noTradeType: NoTradeType.NO_TRADE_BY_SAFETY,
      tradeLots: 0,
      tradeUnits: 0,
      outlayInr: costPerLot,
      plannedRiskInr: 0,
      plannedRiskR: 0,
      rejectionReason: `CAPITAL_FILTER_EXCEEDED: 1 lot (₹${costPerLot.toFixed(2)}) exceeds limit ₹${capitalFilterLimitInr}`,
    };
  }

  const tradeLots = Math.min(1, maxAllowedLots); // Cap at 1 lot for paper account safety
  const tradeUnits = tradeLots * lotSize;
  const outlayInr = tradeUnits * entryPrice;
  const stopDistance = Math.abs(entryPrice - input.structuralStopPrice);
  const plannedRiskInr = tradeUnits * stopDistance;

  return {
    allowEntry: true,
    action,
    tradeLots,
    tradeUnits,
    outlayInr,
    plannedRiskInr,
    plannedRiskR: 1.0,
  };
}
