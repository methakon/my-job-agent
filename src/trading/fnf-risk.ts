/**
 * FNF Risk Engine — standalone risk primitives for the FNF paper desk.
 *
 * Pure functions: no DB, no network, no order placement.
 * Deterministic: same inputs → same outputs.
 */

// ── Types ───────────────────────────────────────────────────────────────────

export interface FnfRiskPolicy {
  riskPctPerTrade: number;       // e.g. 1.0 = 1%
  maxPortfolioRiskPct: number;   // e.g. 3.0 = 3% max total risk
  maxDailyLossPct: number;       // e.g. 3.0
  maxDrawdownPct: number;        // e.g. 10.0
  slippageBufferPct: number;     // e.g. 0.15 = 15%
  defaultStopPct: number;        // e.g. 0.25 = 25%
  minVolume: number;
  maxSpreadPct: number;
  maxStaleMin: number;
  minConfidence: number;
  minDelta: number;
  maxDelta: number;
  minDte: number;
  maxExposurePct: number;
  maxOpenPositions: number;
}

export interface PortfolioSnapshot {
  ceiling?: number;
  capital: number;
  deployed: number;
  netPnl: number;
  unrealisedPnl: number;
  peakEquity: number;
  sessionStartEquity: number;
  openPositionCount: number;
}

export interface FnfRiskSnapshot {
  equity: number;
  riskBudget: number;            // equity * riskPctPerTrade / 100
  maxRiskPerTrade: number;
  headroom: number;              // ceiling - deployed
  sessionLoss: number;           // sessionStartEquity - equity
  sessionLossBudget: number;
  drawdown: number;              // peakEquity - equity
  drawdownBudget: number;
  exposureUsedPct: number;
  openPositionCount: number;
}

export interface StopResult {
  stopPrice: number;
  stopPerUnit: number;
  targetPrice: number;
  source: 'atr' | 'percentage';
}

export interface SizeRequest {
  snapshot: FnfRiskSnapshot;
  premium: number;
  lotSize: number;
  stopPerUnit: number;
  requestedLots?: number;
}

export interface SizeResult {
  allowed: boolean;
  lots: number;
  quantity: number;
  riskPerLot: number;
  effectiveRiskPerUnit: number;
  plannedRisk: number;
  plannedRiskPct: number;
  outlayPerLot: number;
  totalOutlay: number;
  refusals: string[];
}

export enum RiskLevel {
  NONE = 'NONE',
  LOW = 'LOW',
  MEDIUM = 'MEDIUM',
  HIGH = 'HIGH',
  CRITICAL = 'CRITICAL',
}

export interface AuthorizeInput {
  premium: number;
  lotSize: number;
  stopPerUnit: number;
  lots: number;
  quoteAgeMin: number;
  maxStaleMin: number;
  spreadPct: number;
  volume: number;
  minVolume: number;
  maxSpreadPct: number;
  delta: number;
  minDelta: number;
  maxDelta: number;
  dte: number;
  minDte: number;
  confidence: number;
  minConfidence: number;
}

// ── Policy ──────────────────────────────────────────────────────────────────

export function fnfRiskPolicyFromEnv(): FnfRiskPolicy {
  return {
    riskPctPerTrade: Number(process.env.FNF_RISK_PCT_PER_TRADE ?? '1.0'),
    maxPortfolioRiskPct: Number(process.env.FNF_MAX_PORTFOLIO_RISK_PCT ?? '3.0'),
    maxDailyLossPct: Number(process.env.FNF_MAX_DAILY_LOSS_PCT ?? '3.0'),
    maxDrawdownPct: Number(process.env.FNF_MAX_DRAWDOWN_PCT ?? '10.0'),
    slippageBufferPct: Number(process.env.FNF_SLIPPAGE_BUFFER_PCT ?? '0.15'),
    defaultStopPct: Number(process.env.FNF_DEFAULT_STOP_PCT ?? '0.25'),
    minVolume: Number(process.env.FNF_MIN_VOLUME ?? '100'),
    maxSpreadPct: Number(process.env.FNF_MAX_SPREAD_PCT ?? '3.0'),
    maxStaleMin: Number(process.env.FNF_MAX_STALE_MIN ?? '5'),
    minConfidence: Number(process.env.FNF_MIN_CONFIDENCE ?? '50'),
    minDelta: Number(process.env.FNF_MIN_DELTA ?? '0.1'),
    maxDelta: Number(process.env.FNF_MAX_DELTA ?? '0.5'),
    minDte: Number(process.env.FNF_MIN_DTE ?? '1'),
    maxExposurePct: Number(process.env.FNF_MAX_EXPOSURE_PCT ?? '25.0'),
    maxOpenPositions: Number(process.env.FNF_MAX_OPEN_POSITIONS ?? '5'),
  };
}

// ── Risk Snapshot ───────────────────────────────────────────────────────────

export function fnfRiskSnapshot(
  portfolio: PortfolioSnapshot,
  policy: FnfRiskPolicy,
): FnfRiskSnapshot {
  const equity = portfolio.capital + portfolio.netPnl + portfolio.unrealisedPnl;
  const riskBudget = equity * (policy.riskPctPerTrade / 100);
  const headroom = portfolio.capital - portfolio.deployed;
  const sessionLoss = portfolio.sessionStartEquity - equity;
  const sessionLossBudget = portfolio.sessionStartEquity * (policy.maxDailyLossPct / 100);
  const drawdown = portfolio.peakEquity - equity;
  const drawdownBudget = portfolio.peakEquity * (policy.maxDrawdownPct / 100);
  const exposureUsedPct = portfolio.deployed > 0
    ? (portfolio.deployed / equity) * 100
    : 0;

  return {
    equity,
    riskBudget,
    maxRiskPerTrade: riskBudget,
    headroom,
    sessionLoss,
    sessionLossBudget,
    drawdown,
    drawdownBudget,
    exposureUsedPct,
    openPositionCount: portfolio.openPositionCount,
  };
}

// ── Stop Determination ──────────────────────────────────────────────────────

export function fnfDetermineStop(
  entryPrice: number,
  atrStopPct: number | null,
  fallbackPct: number | null,
  targetMultiplier: number = 1.5,
  policy?: FnfRiskPolicy,
): StopResult {
  const defaultStop = policy?.defaultStopPct ?? 0.25;
  const minStopPct = 0.08;

  let stopPct: number;
  let source: 'atr' | 'percentage';

  if (atrStopPct !== null && atrStopPct > 0) {
    stopPct = Math.max(atrStopPct, minStopPct);
    source = 'atr';
  } else {
    stopPct = fallbackPct ?? defaultStop;
    source = 'percentage';
  }

  const stopPrice = entryPrice * (1 - stopPct);
  const stopPerUnit = entryPrice - stopPrice;
  const targetPrice = entryPrice * targetMultiplier;

  return { stopPrice, stopPerUnit, targetPrice, source };
}

// ── Position Sizing ─────────────────────────────────────────────────────────

export function fnfSizeFromRisk(req: SizeRequest): SizeResult {
  const { snapshot, premium, lotSize, stopPerUnit, requestedLots } = req;
  const policy = fnfRiskPolicyFromEnv();

  const effectiveRiskPerUnit = stopPerUnit * (1 + policy.slippageBufferPct);
  const riskPerLot = effectiveRiskPerUnit * lotSize;
  const outlayPerLot = premium * lotSize;

  const refusals: string[] = [];

  // Risk budget check
  const riskLots = riskPerLot > 0
    ? Math.floor(snapshot.riskBudget / riskPerLot)
    : 0;

  if (riskPerLot > snapshot.riskBudget) {
    refusals.push(
      `risk_per_lot ${riskPerLot.toFixed(2)} exceeds risk_budget ${snapshot.riskBudget.toFixed(2)} (1% of ₹${snapshot.equity.toFixed(0)})`,
    );
  }

  // Capital headroom check
  const affordLots = outlayPerLot > 0
    ? Math.floor(snapshot.headroom / outlayPerLot)
    : 0;

  if (outlayPerLot > snapshot.headroom) {
    refusals.push(
      `outlay_per_lot ${outlayPerLot.toFixed(2)} exceeds headroom ${snapshot.headroom.toFixed(2)}`,
    );
  }

  // Max open positions check
  if (snapshot.openPositionCount >= policy.maxOpenPositions) {
    refusals.push(
      `open_positions ${snapshot.openPositionCount} >= max ${policy.maxOpenPositions}`,
    );
  }

  // Session loss check
  if (snapshot.sessionLoss > snapshot.sessionLossBudget) {
    refusals.push(
      `session_loss ${snapshot.sessionLoss.toFixed(2)} > budget ${snapshot.sessionLossBudget.toFixed(2)}`,
    );
  }

  // Drawdown check
  if (snapshot.drawdown > snapshot.drawdownBudget) {
    refusals.push(
      `drawdown ${snapshot.drawdown.toFixed(2)} > budget ${snapshot.drawdownBudget.toFixed(2)}`,
    );
  }

  // Determine lots
  let maxLots = Math.min(riskLots, affordLots);

  // If caller requested specific lots, check against that
  if (requestedLots !== undefined && requestedLots > 0) {
    if (requestedLots > riskLots) {
      refusals.push(
        `requested ${requestedLots} lots exceeds risk_lots ${riskLots}`,
      );
    }
    if (requestedLots > affordLots) {
      refusals.push(
        `requested ${requestedLots} lots exceeds afford_lots ${affordLots}`,
      );
    }
    maxLots = Math.min(maxLots, requestedLots);
  }

  const lots = Math.max(0, Math.floor(maxLots));
  const quantity = lots * lotSize;
  const plannedRisk = quantity * effectiveRiskPerUnit;
  const totalOutlay = quantity * premium;
  const plannedRiskPct = snapshot.equity > 0
    ? (plannedRisk / snapshot.equity) * 100
    : 0;

  return {
    allowed: lots > 0 && refusals.length === 0,
    lots,
    quantity,
    riskPerLot,
    effectiveRiskPerUnit,
    plannedRisk,
    plannedRiskPct,
    outlayPerLot,
    totalOutlay,
    refusals,
  };
}

// ── Full Authorization Gate ─────────────────────────────────────────────────

export function fnfAuthorizeEntry(
  snapshot: FnfRiskSnapshot,
  input: AuthorizeInput,
): { allowed: boolean; refusals: string[]; riskLevel: RiskLevel } {
  const refusals: string[] = [];

  // Data quality gates
  if (input.quoteAgeMin > input.maxStaleMin) {
    refusals.push(`quote_stale: age ${input.quoteAgeMin}min > max ${input.maxStaleMin}min`);
  }
  if (input.volume < input.minVolume) {
    refusals.push(`low_volume: ${input.volume} < min ${input.minVolume}`);
  }
  if (input.spreadPct > input.maxSpreadPct) {
    refusals.push(`wide_spread: ${input.spreadPct}% > max ${input.maxSpreadPct}%`);
  }

  // Greeks gates
  if (input.delta < input.minDelta) {
    refusals.push(`delta_too_low: ${input.delta} < min ${input.minDelta}`);
  }
  if (input.delta > input.maxDelta) {
    refusals.push(`delta_too_high: ${input.delta} > max ${input.maxDelta}`);
  }
  if (input.dte < input.minDte) {
    refusals.push(`dte_too_low: ${input.dte} < min ${input.minDte}`);
  }
  if (input.confidence < input.minConfidence) {
    refusals.push(`low_confidence: ${input.confidence} < min ${input.minConfidence}`);
  }

  // Risk sizing
  const sizing = fnfSizeFromRisk({
    snapshot,
    premium: input.premium,
    lotSize: input.lotSize,
    stopPerUnit: input.stopPerUnit,
    requestedLots: input.lots,
  });
  refusals.push(...sizing.refusals);

  // Risk level
  let riskLevel = RiskLevel.NONE;
  if (sizing.plannedRiskPct > 0) riskLevel = RiskLevel.LOW;
  if (sizing.plannedRiskPct > 0.5) riskLevel = RiskLevel.MEDIUM;
  if (sizing.plannedRiskPct > 1.0) riskLevel = RiskLevel.HIGH;
  if (sizing.plannedRiskPct > 2.0) riskLevel = RiskLevel.CRITICAL;

  return {
    allowed: refusals.length === 0 && sizing.allowed,
    refusals,
    riskLevel,
  };
}
