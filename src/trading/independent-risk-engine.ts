/**
 * Independent Risk Engine — standalone risk primitives independent of the paper desk.
 *
 * Covers: consecutive-loss tracking, volatility shutdowns, kill switch,
 * PAPER/SHADOW/MICRO-LIVE/LIVE state machine, duplicate order protection.
 *
 * Pure functions: no DB, no network, no order placement.
 * Deterministic: same inputs → same outputs.
 */

// ── Types ───────────────────────────────────────────────────────────────────

export type ExecutionMode = 'PAPER' | 'SHADOW' | 'MICRO_LIVE' | 'LIVE';

export interface ExecutionModeConfig {
  mode: ExecutionMode;
  requiresGateGreen: boolean;
  maxDailyLossPct: number;
  maxConsecutiveLosses: number;
  maxConsecutiveLossPct: number;
  volatilityShutdownAtrMultiple: number;
  duplicateOrderWindowMs: number;
}

export interface PositionRecord {
  id: string;
  symbol: string;
  pnl: number;
  closedAtMs: number;
  mode: ExecutionMode;
}

export interface KillSwitchState {
  active: boolean;
  activatedAtMs: number;
  reason: string;
}

export interface DuplicateOrderRecord {
  orderId: string;
  symbol: string;
  side: string;
  placedAtMs: number;
}

export interface OrderRequest {
  orderId: string;
  symbol: string;
  side: string;
  placedAtMs: number;
}

export interface ConsecutiveLossResult {
  count: number;
  lossPct: number;
  exceeded: boolean;
}

export interface VolatilityShutdownResult {
  shouldShutdown: boolean;
  atrMultiple: number;
  currentAtr: number;
  baselineAtr: number;
  reason: string;
}

export interface DuplicateOrderCheckResult {
  allowed: boolean;
  reason: string;
}

export interface StateTransitionResult {
  allowed: boolean;
  from: ExecutionMode;
  to: ExecutionMode;
  reason: string;
}

// ── Consecutive Loss Tracking ────────────────────────────────────────────────

export function countConsecutiveLosses(
  recentPositions: PositionRecord[],
  maxCount: number = 3,
  maxLossPct: number = 5.0,
  equity: number = 100000,
): ConsecutiveLossResult {
  const sorted = [...recentPositions].sort(
    (a, b) => b.closedAtMs - a.closedAtMs,
  );
  let count = 0;
  let totalLoss = 0;

  for (const pos of sorted) {
    if (pos.pnl < 0) {
      count++;
      totalLoss += Math.abs(pos.pnl);
    } else {
      break;
    }
  }

  const lossPct = equity > 0 ? (totalLoss / equity) * 100 : 0;

  return {
    count,
    lossPct,
    exceeded: count >= maxCount || lossPct >= maxLossPct,
  };
}

// ── Volatility Shutdown ─────────────────────────────────────────────────────

export function checkVolatilityShutdown(
  currentAtr: number,
  baselineAtr: number,
  threshold: number = 2.0,
): VolatilityShutdownResult {
  const atrMultiple = baselineAtr > 0 ? currentAtr / baselineAtr : 0;
  const shouldShutdown = atrMultiple >= threshold && baselineAtr > 0;

  return {
    shouldShutdown,
    atrMultiple,
    currentAtr,
    baselineAtr,
    reason: shouldShutdown
      ? `ATR ${atrMultiple.toFixed(2)}x baseline exceeds ${threshold}x threshold`
      : `ATR ${atrMultiple.toFixed(2)}x within acceptable range`,
  };
}

// ── Kill Switch ──────────────────────────────────────────────────────────────

export function evaluateKillSwitch(
  current: KillSwitchState,
  triggerConditions: {
    sessionLossPct?: number;
    drawdownPct?: number;
    consecutiveLosses?: number;
    dataQualityScore?: number;
  },
  nowMs: number,
): KillSwitchState {
  if (current.active) return current;

  const reasons: string[] = [];

  if (triggerConditions.sessionLossPct !== undefined && triggerConditions.sessionLossPct >= 5) {
    reasons.push(`session_loss ${triggerConditions.sessionLossPct}% >= 5%`);
  }
  if (triggerConditions.drawdownPct !== undefined && triggerConditions.drawdownPct >= 10) {
    reasons.push(`drawdown ${triggerConditions.drawdownPct}% >= 10%`);
  }
  if (triggerConditions.consecutiveLosses !== undefined && triggerConditions.consecutiveLosses >= 3) {
    reasons.push(`consecutive_losses ${triggerConditions.consecutiveLosses} >= 3`);
  }
  if (triggerConditions.dataQualityScore !== undefined && triggerConditions.dataQualityScore < 0.5) {
    reasons.push(`data_quality ${triggerConditions.dataQualityScore} < 0.5`);
  }

  if (reasons.length > 0) {
    return {
      active: true,
      activatedAtMs: nowMs,
      reason: reasons.join('; '),
    };
  }

  return current;
}

// ── Duplicate Order Protection ───────────────────────────────────────────────

export function checkDuplicateOrder(
  request: OrderRequest,
  recentOrders: DuplicateOrderRecord[],
  windowMs: number = 30_000,
): DuplicateOrderCheckResult {
  const cutoff = request.placedAtMs - windowMs;
  const duplicates = recentOrders.filter(
    (o) =>
      o.symbol === request.symbol &&
      o.side === request.side &&
      o.placedAtMs >= cutoff &&
      o.orderId !== request.orderId,
  );

  if (duplicates.length > 0) {
    return {
      allowed: false,
      reason: `${duplicates.length} similar order(s) for ${request.symbol} ${request.side} within ${windowMs / 1000}s`,
    };
  }

  return { allowed: true, reason: 'no duplicate detected' };
}

// ── Execution Mode State Machine ─────────────────────────────────────────────

export const MODE_ORDER: ExecutionMode[] = ['PAPER', 'SHADOW', 'MICRO_LIVE', 'LIVE'];

export function canTransition(
  from: ExecutionMode,
  to: ExecutionMode,
  gatesGreen: boolean,
): StateTransitionResult {
  const fromIdx = MODE_ORDER.indexOf(from);
  const toIdx = MODE_ORDER.indexOf(to);

  if (fromIdx === -1 || toIdx === -1) {
    return { allowed: false, from, to, reason: 'invalid mode' };
  }

  // Allow same mode (no-op)
  if (from === to) {
    return { allowed: true, from, to, reason: 'same mode (no-op)' };
  }

  // Only forward transitions (no demotion without explicit reset)
  if (toIdx < fromIdx) {
    return { allowed: false, from, to, reason: 'backward transition not allowed without explicit reset' };
  }

  // MICRO_LIVE and LIVE require all gates GREEN
  if ((to === 'MICRO_LIVE' || to === 'LIVE') && !gatesGreen) {
    return {
      allowed: false,
      from,
      to,
      reason: `${to} requires all safety gates to be GREEN`,
    };
  }

  // PAPER → SHADOW always allowed
  if (from === 'PAPER' && to === 'SHADOW') {
    return { allowed: true, from, to, reason: 'PAPER → SHADOW always allowed' };
  }

  // SHADOW → MICRO_LIVE requires gates
  if (from === 'SHADOW' && to === 'MICRO_LIVE' && !gatesGreen) {
    return {
      allowed: false,
      from,
      to,
      reason: 'MICRO_LIVE requires all safety gates to be GREEN',
    };
  }

  // All other forward transitions allowed
  return { allowed: true, from, to, reason: `forward transition ${from} → ${to}` };
}

// ── Composite Safety Check ──────────────────────────────────────────────────

export interface SafetyCheckInput {
  currentMode: ExecutionMode;
  request: OrderRequest;
  recentOrders: DuplicateOrderRecord[];
  recentPositions: PositionRecord[];
  currentAtr: number;
  baselineAtr: number;
  killSwitch: KillSwitchState;
  nowMs: number;
  equity: number;
  sessionLossPct: number;
  drawdownPct: number;
  gatesGreen: boolean;
}

export interface SafetyCheckResult {
  allowed: boolean;
  refusals: string[];
  riskLevel: 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
}

export function compositeSafetyCheck(input: SafetyCheckInput): SafetyCheckResult {
  const refusals: string[] = [];

  // Kill switch
  const ks = evaluateKillSwitch(
    input.killSwitch,
    {
      sessionLossPct: input.sessionLossPct,
      drawdownPct: input.drawdownPct,
    },
    input.nowMs,
  );
  if (ks.active) {
    refusals.push(`kill_switch_active: ${ks.reason}`);
  }

  // Consecutive loss
  const cl = countConsecutiveLosses(input.recentPositions, 3, 5.0, input.equity);
  if (cl.exceeded) {
    refusals.push(`consecutive_loss: ${cl.count} losses, ${cl.lossPct.toFixed(1)}% of equity`);
  }

  // Volatility shutdown
  const vs = checkVolatilityShutdown(input.currentAtr, input.baselineAtr, 2.0);
  if (vs.shouldShutdown) {
    refusals.push(`volatility_shutdown: ${vs.reason}`);
  }

  // Duplicate order
  const dq = checkDuplicateOrder(input.request, input.recentOrders, 30_000);
  if (!dq.allowed) {
    refusals.push(`duplicate_order: ${dq.reason}`);
  }

  // Mode gate
  if (input.currentMode === 'LIVE' && !input.gatesGreen) {
    refusals.push('LIVE_mode_without_GREEN_gates');
  }

  // Risk level
  let riskLevel: SafetyCheckResult['riskLevel'] = 'NONE';
  if (refusals.length > 0) riskLevel = 'CRITICAL';
  else if (cl.count >= 2) riskLevel = 'HIGH';
  else if (cl.count >= 1) riskLevel = 'MEDIUM';
  else if (input.sessionLossPct >= 1) riskLevel = 'LOW';

  return {
    allowed: refusals.length === 0,
    refusals,
    riskLevel,
  };
}

// ── Per-Trade Risk Limit ─────────────────────────────────────────────────

export interface PerTradeLimitInput {
  readonly orderId: string;
  readonly symbol: string;
  readonly quantity: number;
  readonly price: number;
  readonly equity: number;
  readonly maxRiskPerTradePct: number; // default 2%
}

export interface PerTradeLimitResult {
  allowed: boolean;
  riskPct: number;
  reason: string;
}

export function checkPerTradeLimit(input: PerTradeLimitInput): PerTradeLimitResult {
  const notionalValue = input.quantity * input.price;
  const riskPct = input.equity > 0 ? (notionalValue / input.equity) * 100 : 100;

  if (riskPct > input.maxRiskPerTradePct) {
    return {
      allowed: false,
      riskPct,
      reason: `Per-trade risk ${riskPct.toFixed(2)}% exceeds ${input.maxRiskPerTradePct}% limit`,
    };
  }

  return { allowed: true, riskPct, reason: `Per-trade risk ${riskPct.toFixed(2)}% within limit` };
}

// ── Concentration Limit ──────────────────────────────────────────────────

export interface ConcentrationLimitInput {
  readonly symbol: string;
  readonly quantity: number;
  readonly price: number;
  readonly existingExposure: Record<string, number>; // symbol → notional
  readonly equity: number;
  readonly maxConcentrationPct: number; // default 25%
}

export interface ConcentrationLimitResult {
  allowed: boolean;
  concentrationPct: number;
  reason: string;
}

export function checkConcentrationLimit(input: ConcentrationLimitInput): ConcentrationLimitResult {
  const newNotional = input.quantity * input.price;
  const existingNotional = input.existingExposure[input.symbol] ?? 0;
  const totalSymbolExposure = existingNotional + newNotional;
  const concentrationPct = input.equity > 0 ? (totalSymbolExposure / input.equity) * 100 : 100;

  if (concentrationPct > input.maxConcentrationPct) {
    return {
      allowed: false,
      concentrationPct,
      reason: `Concentration ${concentrationPct.toFixed(2)}% exceeds ${input.maxConcentrationPct}% limit for ${input.symbol}`,
    };
  }

  return { allowed: true, concentrationPct, reason: `Concentration ${concentrationPct.toFixed(2)}% within limit` };
}

// ── Drawdown Check ───────────────────────────────────────────────────────

export interface DrawdownCheckInput {
  readonly peakEquity: number;
  readonly currentEquity: number;
  readonly maxDrawdownPct: number; // default 10%
}

export interface DrawdownCheckResult {
  exceeded: boolean;
  drawdownPct: number;
  reason: string;
}

export function checkDrawdown(input: DrawdownCheckInput): DrawdownCheckResult {
  const drawdownPct = input.peakEquity > 0
    ? ((input.peakEquity - input.currentEquity) / input.peakEquity) * 100
    : 0;

  if (drawdownPct >= input.maxDrawdownPct) {
    return {
      exceeded: true,
      drawdownPct,
      reason: `Drawdown ${drawdownPct.toFixed(2)}% exceeds ${input.maxDrawdownPct}% limit`,
    };
  }

  return { exceeded: false, drawdownPct, reason: `Drawdown ${drawdownPct.toFixed(2)}% within limit` };
}

// ── Data Quality Shutdown ────────────────────────────────────────────────

export interface DataQualityInput {
  readonly symbol: string;
  readonly lastQuoteAgeMs: number;
  readonly quoteAgeThresholdMs: number; // default 5000
  readonly spreadBps: number;
  readonly maxSpreadBps: number; // default 50
  readonly dataQualityScore: number; // 0..1
  readonly minDataQualityScore: number; // default 0.5
}

export interface DataQualityResult {
  shouldShutdown: boolean;
  reasons: string[];
}

export function checkDataQuality(input: DataQualityInput): DataQualityResult {
  const reasons: string[] = [];

  if (input.lastQuoteAgeMs > input.quoteAgeThresholdMs) {
    reasons.push(`Quote age ${input.lastQuoteAgeMs}ms exceeds ${input.quoteAgeThresholdMs}ms threshold for ${input.symbol}`);
  }
  if (input.spreadBps > input.maxSpreadBps) {
    reasons.push(`Spread ${input.spreadBps}bps exceeds ${input.maxSpreadBps}bps max for ${input.symbol}`);
  }
  if (input.dataQualityScore < input.minDataQualityScore) {
    reasons.push(`Data quality ${input.dataQualityScore} below ${input.minDataQualityScore} threshold for ${input.symbol}`);
  }

  return { shouldShutdown: reasons.length > 0, reasons };
}

// ── Contract-Specific Controls ───────────────────────────────────────────

export interface ContractControlInput {
  readonly symbol: string;
  readonly expiry: string;
  readonly dte: number; // days to expiry
  readonly lotSize: number;
  readonly requestedQuantity: number;
  readonly maxDte: number; // default 45
  readonly minDte: number; // default 1
  readonly allowedStrategies: string[];
  readonly requestedStrategy: string;
}

export interface ContractControlResult {
  allowed: boolean;
  reasons: string[];
}

export function checkContractControls(input: ContractControlInput): ContractControlResult {
  const reasons: string[] = [];

  if (input.dte > input.maxDte) {
    reasons.push(`DTE ${input.dte} exceeds max ${input.maxDte} for ${input.symbol}`);
  }
  if (input.dte < input.minDte) {
    reasons.push(`DTE ${input.dte} below min ${input.minDte} for ${input.symbol}`);
  }
  if (input.lotSize > 0 && input.requestedQuantity % input.lotSize !== 0) {
    reasons.push(`Quantity ${input.requestedQuantity} not a multiple of lot size ${input.lotSize} for ${input.symbol}`);
  }
  if (input.allowedStrategies.length > 0 && !input.allowedStrategies.includes(input.requestedStrategy)) {
    reasons.push(`Strategy '${input.requestedStrategy}' not allowed for ${input.symbol} (allowed: ${input.allowedStrategies.join(', ')})`);
  }

  return { allowed: reasons.length === 0, reasons };
}

// ── Scenario Risk with Greeks ────────────────────────────────────────────

export interface ScenarioRiskInput {
  readonly symbol: string;
  readonly delta: number;
  readonly gamma: number;
  readonly vega: number;
  readonly theta: number;
  readonly quantity: number;
  readonly underlyingMovePct: number;
  readonly volChangePct: number;
  readonly maxScenarioLoss: number;
}

export interface ScenarioRiskResult {
  withinLimits: boolean;
  estimatedPnl: number;
  deltaPnl: number;
  gammaPnl: number;
  vegaPnl: number;
  thetaPnl: number;
  reason: string;
}

export function checkScenarioRisk(input: ScenarioRiskInput): ScenarioRiskResult {
  // Simplified Greeks-based P&L estimation
  const deltaPnl = input.delta * input.quantity * input.underlyingMovePct;
  const gammaPnl = 0.5 * input.gamma * input.quantity * input.underlyingMovePct * input.underlyingMovePct;
  const vegaPnl = input.vega * input.quantity * input.volChangePct;
  const thetaPnl = input.theta * input.quantity; // 1-day theta
  const estimatedPnl = deltaPnl + gammaPnl + vegaPnl + thetaPnl;

  if (estimatedPnl < -input.maxScenarioLoss) {
    return {
      withinLimits: false,
      estimatedPnl,
      deltaPnl,
      gammaPnl,
      vegaPnl,
      thetaPnl,
      reason: `Scenario loss ${estimatedPnl.toFixed(2)} exceeds max ${input.maxScenarioLoss} for ${input.symbol}`,
    };
  }

  return {
    withinLimits: true,
    estimatedPnl,
    deltaPnl,
    gammaPnl,
    vegaPnl,
    thetaPnl,
    reason: `Scenario P&L ${estimatedPnl.toFixed(2)} within limits for ${input.symbol}`,
  };
}

// ── ITEM 272: Emergency Kill Switch / Flatten Path ─────────────────────────

export type FlattenPriority = 'IMMEDIATE' | 'NEXT_CANDLE' | 'END_OF_SESSION';

export interface FlattenCommand {
  readonly targetSymbol: string;
  readonly priority: FlattenPriority;
  readonly reason: string;
  readonly triggeredAtMs: number;
  /** If true, cancel all pending orders for this symbol first. */
  readonly cancelPendingOrders: boolean;
}

export interface FlattenResult {
  readonly allowed: boolean;
  readonly symbol: string;
  readonly reason: string;
  readonly positionQuantity: number;
  readonly estimatedExitPrice: number | null;
  readonly estimatedSlippage: number;
}

/**
 * Emergency flatten: determine if a position can be flattened and estimate exit cost.
 * This is a PURE function — it does NOT place orders, it only computes the flatten plan.
 */
export function planEmergencyFlatten(
  command: FlattenCommand,
  currentPositions: readonly PositionRecord[],
  currentQuotes: Map<string, { bid: number | null; ask: number | null; ltp: number }>,
): FlattenResult {
  const pos = currentPositions.find((p) => p.symbol === command.targetSymbol);
  if (!pos) {
    return {
      allowed: false,
      symbol: command.targetSymbol,
      reason: `No position found for ${command.targetSymbol}`,
      positionQuantity: 0,
      estimatedExitPrice: null,
      estimatedSlippage: 0,
    };
  }

  const quote = currentQuotes.get(command.targetSymbol);
  if (!quote) {
    return {
      allowed: true,
      symbol: command.targetSymbol,
      reason: `Position exists but no quote available — must flatten at market`,
      positionQuantity: Math.abs(pos.pnl) > 0 ? 1 : 0, // simplified
      estimatedExitPrice: null,
      estimatedSlippage: 0,
    };
  }

  // Flatten: sell at bid (aggressive sell to exit a long) or buy at ask (exit a short)
  const exitPrice = pos.pnl >= 0 ? (quote.bid ?? quote.ltp) : (quote.ask ?? quote.ltp);
  const slippage = Math.abs(exitPrice - quote.ltp);

  return {
    allowed: true,
    symbol: command.targetSymbol,
    reason: `Emergency flatten: ${command.reason} at priority ${command.priority}`,
    positionQuantity: 1, // simplified for risk engine
    estimatedExitPrice: exitPrice,
    estimatedSlippage: slippage,
  };
}

/**
 * Evaluate whether the kill switch should trigger an emergency flatten.
 * Returns flatten commands for all positions if triggered.
 */
export function evaluateEmergencyFlatten(
  killSwitch: KillSwitchState,
  currentPositions: readonly PositionRecord[],
  nowMs: number,
): readonly FlattenCommand[] {
  if (!killSwitch.active) return [];

  return currentPositions.map((pos) => ({
    targetSymbol: pos.symbol,
    priority: 'IMMEDIATE' as FlattenPriority,
    reason: `Kill switch active: ${killSwitch.reason}`,
    triggeredAtMs: nowMs,
    cancelPendingOrders: true,
  }));
}
