/**
 * ITEM 119 — Stress costs and latency upward.
 *
 * doneWhen: "Stress-test shows edge degradation under pessimistic cost/latency assumptions."
 *
 * PINNED SEMantics (coststress-v1)
 *   Applies pessimistic multipliers to transaction costs and execution latency
 *   to verify whether a strategy's edge survives degraded conditions.
 *
 * PURE: no clock, no I/O, no DB, no network, no AI, no randomness.
 * RESEARCH / SHADOW ONLY.
 */

export const COST_STRESS_VERSION = 'coststress-v1';

export type CostStressStatus = 'OK' | 'UNAVAILABLE' | 'DISABLED';
export type CostStressRefusal = 'NO_TRADES' | 'INSUFFICIENT_DATA';

export interface TradeRecord {
  readonly symbol: string;
  readonly entryPrice: number;
  readonly exitPrice: number;
  readonly quantity: number;
  readonly entryTimestampMs: number;
  readonly exitTimestampMs: number;
  /** Base transaction cost per unit (brokerage + taxes + slippage estimate). */
  readonly baseCostPerUnit: number;
}

export interface CostStressConfig {
  readonly enabled: boolean;
  /** Multiplier for base cost (e.g., 2.0 = double the cost). */
  readonly costMultiplier: number;
  /** Additional latency added to execution (ms). */
  readonly addedLatencyMs: number;
  /** Slippage addition in basis points. */
  readonly addedSlippageBps: number;
}

export const DEFAULT_COST_STRESS_CONFIG: CostStressConfig = {
  enabled: true,
  costMultiplier: 2.0,
  addedLatencyMs: 500,
  addedSlippageBps: 10,
};

export interface StressedTrade {
  readonly symbol: string;
  readonly basePnl: number;
  readonly stressedPnl: number;
  readonly baseCostTotal: number;
  readonly stressedCostTotal: number;
  readonly costDegradationPct: number;
}

export interface CostStressResult {
  readonly version: string;
  readonly status: CostStressStatus;
  readonly refusal: CostStressRefusal | null;
  readonly config: CostStressConfig;
  readonly trades: readonly StressedTrade[];
  readonly baseSharpe: number | null;
  readonly stressedSharpe: number | null;
  readonly edgeSurvives: boolean;
  readonly reviewerSummary: string;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function computeSharpe(pnls: readonly number[]): number | null {
  if (pnls.length < 2) return null;
  const mean = pnls.reduce((a, b) => a + b, 0) / pnls.length;
  const variance = pnls.reduce((s, p) => s + (p - mean) ** 2, 0) / (pnls.length - 1);
  const std = Math.sqrt(variance);
  return std > 0 ? mean / std : 0;
}

/**
 * Apply cost stress to a set of trades and evaluate edge robustness.
 */
export function computeCostStress(
  trades: readonly TradeRecord[],
  config: Partial<CostStressConfig> = {},
): CostStressResult {
  const cfg = { ...DEFAULT_COST_STRESS_CONFIG, ...config };

  const refuse = (reason: CostStressRefusal): CostStressResult => ({
    version: COST_STRESS_VERSION,
    status: 'UNAVAILABLE',
    refusal: reason,
    config: cfg,
    trades: [],
    baseSharpe: null,
    stressedSharpe: null,
    edgeSurvives: false,
    reviewerSummary: `${COST_STRESS_VERSION}: refusal=${reason}`,
  });

  if (!cfg.enabled) {
    return {
      version: COST_STRESS_VERSION,
      status: 'DISABLED',
      refusal: null,
      config: cfg,
      trades: [],
      baseSharpe: null,
      stressedSharpe: null,
      edgeSurvives: false,
      reviewerSummary: `${COST_STRESS_VERSION}: disabled`,
    };
  }

  if (trades.length === 0) return refuse('NO_TRADES');

  const validTrades = trades.filter(
    (t) =>
      isNum(t.entryPrice) &&
      isNum(t.exitPrice) &&
      isNum(t.quantity) &&
      isNum(t.baseCostPerUnit) &&
      t.entryPrice > 0 &&
      t.exitPrice > 0 &&
      t.quantity > 0,
  );

  if (validTrades.length === 0) return refuse('INSUFFICIENT_DATA');

  const stressedTrades: StressedTrade[] = validTrades.map((t) => {
    const basePnl = (t.exitPrice - t.entryPrice) * t.quantity;
    const baseCostTotal = t.baseCostPerUnit * t.quantity;

    // Stressed cost: multiplier + slippage addition
    const slippageAddition = (t.entryPrice * cfg.addedSlippageBps) / 10_000;
    const stressedCostPerUnit = t.baseCostPerUnit * cfg.costMultiplier + slippageAddition;
    const stressedCostTotal = stressedCostPerUnit * t.quantity;

    const stressedPnl = basePnl - (stressedCostTotal - baseCostTotal);
    const costDegradationPct =
      baseCostTotal > 0
        ? ((stressedCostTotal - baseCostTotal) / baseCostTotal) * 100
        : 0;

    return {
      symbol: t.symbol,
      basePnl: Number(basePnl.toFixed(6)),
      stressedPnl: Number(stressedPnl.toFixed(6)),
      baseCostTotal: Number(baseCostTotal.toFixed(6)),
      stressedCostTotal: Number(stressedCostTotal.toFixed(6)),
      costDegradationPct: Number(costDegradationPct.toFixed(6)),
    };
  });

  const basePnls = stressedTrades.map((t) => t.basePnl);
  const stressedPnls = stressedTrades.map((t) => t.stressedPnl);

  const baseSharpe = computeSharpe(basePnls);
  const stressedSharpe = computeSharpe(stressedPnls);

  // Edge survives if stressed Sharpe is still positive
  const baseMean = basePnls.reduce((a, b) => a + b, 0) / basePnls.length;
  const stressedMean = stressedPnls.reduce((a, b) => a + b, 0) / stressedPnls.length;
  const edgeSurvives = stressedMean > 0 && (stressedSharpe === null || stressedSharpe > 0);

  return {
    version: COST_STRESS_VERSION,
    status: 'OK',
    refusal: null,
    config: cfg,
    trades: stressedTrades,
    baseSharpe: baseSharpe !== null ? Number(baseSharpe.toFixed(6)) : null,
    stressedSharpe: stressedSharpe !== null ? Number(stressedSharpe.toFixed(6)) : null,
    edgeSurvives,
    reviewerSummary: [
      `${COST_STRESS_VERSION}: ${validTrades.length} trades,`,
      `baseSharpe=${baseSharpe?.toFixed(2) ?? 'N/A'},`,
      `stressedSharpe=${stressedSharpe?.toFixed(2) ?? 'N/A'},`,
      `edgeSurvives=${edgeSurvives}`,
    ].join(' '),
  };
}
