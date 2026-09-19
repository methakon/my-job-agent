/**
 * ITEM 121 — Reject strategies whose edge disappears under execution degradation.
 *
 * doneWhen: "Module classifies strategies as robust or fragile under cost/latency stress."
 *
 * PINNED SEMantics (edgerobust-v1)
 *   Evaluates whether a strategy's edge survives pessimistic execution assumptions.
 *   Classifies strategies as ROBUST or FRAGILE based on stressed performance.
 *
 * PURE: no clock, no I/O, no DB, no network, no AI, no randomness.
 * RESEARCH / SHADOW ONLY.
 */

export const EDGE_ROBUSTNESS_VERSION = 'edgerobust-v1';

export type RobustnessVerdict = 'ROBUST' | 'FRAGILE' | 'UNDECIDABLE';
export type EdgeRobustnessStatus = 'OK' | 'UNAVAILABLE' | 'DISABLED';

export interface StrategyPerformance {
  readonly strategyId: string;
  readonly strategyName: string;
  readonly baseSharpe: number;
  readonly baseWinRate: number;
  readonly baseAvgPnl: number;
  readonly baseMaxDrawdown: number;
  /** Number of trades in the evaluation window. */
  readonly sampleSize: number;
}

export interface DegradedPerformance {
  readonly strategyId: string;
  readonly stressedSharpe: number;
  readonly stressedWinRate: number;
  readonly stressedAvgPnl: number;
  readonly stressedMaxDrawdown: number;
  readonly costMultiplier: number;
  readonly addedLatencyMs: number;
  readonly addedSlippageBps: number;
}

export interface EdgeRobustnessConfig {
  readonly enabled: boolean;
  /** Minimum Sharpe ratio to be considered having an edge at all. */
  readonly minBaseSharpe: number;
  /** Minimum fraction of base Sharpe that stressed Sharpe must retain. */
  readonly minSharpeRetention: number;
  /** Minimum PnL retention under stress. */
  readonly minPnlRetention: number;
}

export const DEFAULT_EDGE_ROBUSTNESS_CONFIG: EdgeRobustnessConfig = {
  enabled: true,
  minBaseSharpe: 0.5,
  minSharpeRetention: 0.3,
  minPnlRetention: 0.0,
};

export interface StrategyRobustnessResult {
  readonly strategyId: string;
  readonly strategyName: string;
  readonly verdict: RobustnessVerdict;
  readonly baseSharpe: number;
  readonly stressedSharpe: number;
  readonly sharpeRetention: number | null;
  readonly baseAvgPnl: number;
  readonly stressedAvgPnl: number;
  readonly pnlRetention: number | null;
  readonly rejectionReasons: readonly string[];
}

export interface EdgeRobustnessReport {
  readonly version: string;
  readonly status: EdgeRobustnessStatus;
  readonly config: EdgeRobustnessConfig;
  readonly strategies: readonly StrategyRobustnessResult[];
  readonly robustCount: number;
  readonly fragileCount: number;
  readonly undecidableCount: number;
  readonly reviewerSummary: string;
}

/**
 * Evaluate edge robustness for a single strategy.
 */
function evaluateStrategy(
  base: StrategyPerformance,
  degraded: DegradedPerformance,
  config: EdgeRobustnessConfig,
): StrategyRobustnessResult {
  const rejectionReasons: string[] = [];

  // Check if base edge even exists
  if (base.baseSharpe < config.minBaseSharpe) {
    rejectionReasons.push(
      `Base Sharpe ${base.baseSharpe.toFixed(2)} below minimum ${config.minBaseSharpe}`,
    );
  }

  // Check sample size
  if (base.sampleSize < 30) {
    rejectionReasons.push(`Sample size ${base.sampleSize} too small for reliable assessment`);
  }

  // Sharpe retention
  const sharpeRetention =
    base.baseSharpe !== 0 ? degraded.stressedSharpe / base.baseSharpe : null;
  if (sharpeRetention !== null && sharpeRetention < config.minSharpeRetention) {
    rejectionReasons.push(
      `Sharpe retention ${(sharpeRetention * 100).toFixed(1)}% below ${(config.minSharpeRetention * 100).toFixed(1)}% threshold`,
    );
  }

  // PnL retention
  const pnlRetention =
    base.baseAvgPnl !== 0 ? degraded.stressedAvgPnl / base.baseAvgPnl : null;
  if (pnlRetention !== null && pnlRetention < config.minPnlRetention) {
    rejectionReasons.push(
      `PnL retention ${(pnlRetention * 100).toFixed(1)}% below ${(config.minPnlRetention * 100).toFixed(1)}% threshold`,
    );
  }

  // Stressed Sharpe must be positive
  if (degraded.stressedSharpe <= 0) {
    rejectionReasons.push(`Stressed Sharpe ${degraded.stressedSharpe.toFixed(2)} is non-positive`);
  }

  let verdict: RobustnessVerdict;
  if (rejectionReasons.length > 0) {
    verdict = 'FRAGILE';
  } else if (sharpeRetention !== null && pnlRetention !== null) {
    verdict = 'ROBUST';
  } else {
    verdict = 'UNDECIDABLE';
  }

  return {
    strategyId: base.strategyId,
    strategyName: base.strategyName,
    verdict,
    baseSharpe: base.baseSharpe,
    stressedSharpe: degraded.stressedSharpe,
    sharpeRetention: sharpeRetention !== null ? Number(sharpeRetention.toFixed(6)) : null,
    baseAvgPnl: base.baseAvgPnl,
    stressedAvgPnl: degraded.stressedAvgPnl,
    pnlRetention: pnlRetention !== null ? Number(pnlRetention.toFixed(6)) : null,
    rejectionReasons,
  };
}

/**
 * Evaluate edge robustness for multiple strategies.
 */
export function computeEdgeRobustness(
  strategies: readonly { base: StrategyPerformance; degraded: DegradedPerformance }[],
  config: Partial<EdgeRobustnessConfig> = {},
): EdgeRobustnessReport {
  const cfg = { ...DEFAULT_EDGE_ROBUSTNESS_CONFIG, ...config };

  if (!cfg.enabled) {
    return {
      version: EDGE_ROBUSTNESS_VERSION,
      status: 'DISABLED',
      config: cfg,
      strategies: [],
      robustCount: 0,
      fragileCount: 0,
      undecidableCount: 0,
      reviewerSummary: `${EDGE_ROBUSTNESS_VERSION}: disabled`,
    };
  }

  if (strategies.length === 0) {
    return {
      version: EDGE_ROBUSTNESS_VERSION,
      status: 'UNAVAILABLE',
      config: cfg,
      strategies: [],
      robustCount: 0,
      fragileCount: 0,
      undecidableCount: 0,
      reviewerSummary: `${EDGE_ROBUSTNESS_VERSION}: no strategies provided`,
    };
  }

  const results = strategies.map((s) => evaluateStrategy(s.base, s.degraded, cfg));

  const robustCount = results.filter((r) => r.verdict === 'ROBUST').length;
  const fragileCount = results.filter((r) => r.verdict === 'FRAGILE').length;
  const undecidableCount = results.filter((r) => r.verdict === 'UNDECIDABLE').length;

  return {
    version: EDGE_ROBUSTNESS_VERSION,
    status: 'OK',
    config: cfg,
    strategies: results,
    robustCount,
    fragileCount,
    undecidableCount,
    reviewerSummary: [
      `${EDGE_ROBUSTNESS_VERSION}: ${results.length} strategies,`,
      `${robustCount} robust, ${fragileCount} fragile, ${undecidableCount} undecidable`,
    ].join(' '),
  };
}
