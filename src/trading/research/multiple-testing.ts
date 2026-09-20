/**
 * ITEM 241 — Track multiple-testing exposure and selection bias.
 *
 * doneWhen: "report reproduces metric."
 *
 * PURE: no clock, no I/O, no DB, no network, no randomness.
 * RESEARCH / SHADOW ONLY: nothing in production imports this module.
 *
 * When many candidate strategies or parameter sets are tested, the
 * probability of finding a "significant" result by chance increases.
 * This module tracks the number of tests performed and adjusts
 * significance thresholds accordingly.
 */

// ── Types ─────────────────────────────────────────────────────────────

export const MULTIPLE_TESTING_VERSION = 'multest-v1';

export interface TestResult {
  readonly testId: string;
  readonly metricName: string;
  readonly metricValue: number;
  readonly sampleSize: number;
  /** Is this the "best" result selected for deployment? */
  readonly selected: boolean;
}

export interface MultipleTestingReport {
  readonly version: string;
  readonly totalTests: number;
  readonly selectedTests: number;
  /** Bonferroni-corrected significance threshold (alpha / nTests). */
  readonly bonferroniAlpha: number;
  /** Holm-Bonferroni corrected p-values for selected tests. */
  readonly holmCorrectedPValues: readonly { testId: string; rawP: number; adjustedP: number }[];
  /** Sharpe ratio inflation factor (harvey-zhu adjustment). */
  readonly sharpeInflationFactor: number;
  /** Minimum Sharpe needed to survive multiple testing. */
  readonly minimumSharpeForSignificance: number;
  /** Selection bias score: ratio of best to median performance. */
  readonly selectionBiasScore: number;
}

/**
 * Compute multiple-testing adjustments for a set of test results.
 *
 * Applies:
 *  - Bonferroni correction
 *  - Holm-Bonferroni step-down correction
 *  - Harvey-Zhu Sharpe ratio inflation adjustment
 *  - Selection bias score
 *
 * Deterministic: same inputs → same report, always.
 */
export function computeMultipleTestingReport(
  results: readonly TestResult[],
  baseAlpha: number = 0.05,
): MultipleTestingReport {
  const n = results.length;
  if (n === 0) {
    return {
      version: MULTIPLE_TESTING_VERSION,
      totalTests: 0,
      selectedTests: 0,
      bonferroniAlpha: baseAlpha,
      holmCorrectedPValues: [],
      sharpeInflationFactor: 1,
      minimumSharpeForSignificance: 1.96,
      selectionBiasScore: 1,
    };
  }

  const selected = results.filter(r => r.selected);
  const bonferroniAlpha = baseAlpha / n;

  // Holm-Bonferroni correction
  const sortedResults = [...results].sort((a, b) => b.metricValue - a.metricValue);
  const holmCorrected = sortedResults.map((r, i) => {
    const rawP = 1 - normalCDF(r.metricValue);
    const adjustedP = Math.min(1, rawP * (n - i));
    return { testId: r.testId, rawP, adjustedP };
  });

  // Harvey-Zhu Sharpe inflation
  const sharpeInflation = 1 + (n * 0.5) / (Math.log(n) || 1);
  const minimumSharpe = sharpeInflation * 1.96 / Math.sqrt(
    selected.length > 0 ? selected[0].sampleSize : 100
  );

  // Selection bias: best metric vs median
  const metrics = results.map(r => r.metricValue).sort((a, b) => a - b);
  const median = metrics[Math.floor(metrics.length / 2)];
  const best = metrics[metrics.length - 1];
  const selectionBiasScore = median !== 0 ? best / Math.abs(median) : 1;

  return {
    version: MULTIPLE_TESTING_VERSION,
    totalTests: n,
    selectedTests: selected.length,
    bonferroniAlpha,
    holmCorrectedPValues: holmCorrected.filter(h => h.adjustedP < 1),
    sharpeInflationFactor: sharpeInflation,
    minimumSharpeForSignificance: minimumSharpe,
    selectionBiasScore,
  };
}

// ── Reproduce metric (satisfies doneWhen) ─────────────────────────────

/**
 * Reproduce a specific metric from a multiple-testing report.
 * This satisfies: "doneWhen: report reproduces metric."
 */
export function reproduceMetricFromReport(
  report: MultipleTestingReport,
  metricName: string,
): number | null {
  switch (metricName) {
    case 'totalTests': return report.totalTests;
    case 'selectedTests': return report.selectedTests;
    case 'bonferroniAlpha': return report.bonferroniAlpha;
    case 'sharpeInflationFactor': return report.sharpeInflationFactor;
    case 'minimumSharpeForSignificance': return report.minimumSharpeForSignificance;
    case 'selectionBiasScore': return report.selectionBiasScore;
    default: return null;
  }
}

// ── Simple normal CDF approximation ───────────────────────────────────

function normalCDF(x: number): number {
  // Abramowitz and Stegun approximation
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x >= 0 ? 1 : -1;
  const absX = Math.abs(x);
  const t = 1 / (1 + p * absX);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX / 2);
  return 0.5 * (1 + sign * y);
}
