/**
 * Event Surprise — Surprise/Novelty Engine
 *
 * PURE: No clock, no I/O, no DB, no network, no randomness.
 * Deterministic: same inputs → same outputs.
 *
 * CRITICAL PRINCIPLE: magnitude ≠ surprise.
 * - Large event matching expectations = LOW surprise.
 * - Small unexpected event = HIGH surprise.
 * - Surprise measures deviation from what was expected, not size.
 */

import { ForecastDistribution } from './event-types';

// ── Surprise Input ───────────────────────────────────────────────────────────

/** Input parameters for surprise calculation. */
export interface SurpriseInput {
  /** Actual realized value (e.g., CPI 0.5% vs expected 0.3%). */
  readonly actual: number;
  /** What the consensus expected at decision time. */
  readonly consensusAtDecisionTime: number;
  /** Previous value (for revision detection). */
  readonly previous: number;
  /** Whether this is a revision to a prior release. */
  readonly revision: boolean;
  /** Forecast distribution before the event. */
  readonly forecastDistribution: ForecastDistribution;
}

// ── Surprise Output ──────────────────────────────────────────────────────────

/** Output of surprise calculation. */
export interface SurpriseResult {
  /** Raw surprise: actual minus consensus. Can be positive or negative. */
  readonly rawSurprise: number;
  /** Standardized surprise: raw surprise / expected move. */
  readonly standardizedSurprise: number;
  /** Percentile rank of this surprise in historical distribution (0-100). */
  readonly surprisePercentile: number;
  /** Direction of surprise: POSITIVE, NEGATIVE, or NEUTRAL. */
  readonly surpriseDirection: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL';
  /** Revision surprise: how much this revision deviates from original. */
  readonly revisionSurprise: number;
  /** Forecast dispersion: how spread out the forecast distribution was. */
  readonly forecastDispersion: number;
  /** Novelty score: how new/unprecedented this surprise is (0-1). */
  readonly noveltyScore: number;
  /** Change in market-implied probability after the surprise. */
  readonly marketImpliedProbabilityChange: number;
  /** Pre-event positioning indicator: how much the market moved before. */
  readonly preEventPositioning: number;
}

// ── Surprise Calculation ─────────────────────────────────────────────────────

/**
 * Calculate surprise metrics for an event.
 *
 * PURE: Yes. Deterministic: Yes.
 *
 * Key insight: surprise is about DEVIATION FROM EXPECTATIONS, not
 * about the SIZE of the event. A 50bp rate cut when 50bp was expected
 * has ZERO surprise. A 25bp cut when 0bp was expected is HIGH surprise.
 *
 * @param input - Actual value, consensus, previous, and forecast distribution.
 * @returns Comprehensive surprise metrics.
 */
export function calculateSurprise(input: SurpriseInput): SurpriseResult {
  const {
    actual,
    consensusAtDecisionTime,
    previous,
    revision,
    forecastDistribution: dist,
  } = input;

  // ── Raw Surprise ─────────────────────────────────────────────────────────
  const rawSurprise = actual - consensusAtDecisionTime;

  // ── Expected Move from Forecast Distribution ─────────────────────────────
  const expectedMove = calculateExpectedMove(dist);

  // ── Standardized Surprise ────────────────────────────────────────────────
  const standardizedSurprise = expectedMove > 0
    ? rawSurprise / expectedMove
    : 0;

  // ── Surprise Percentile ──────────────────────────────────────────────────
  const surprisePercentile = standardizedToPercentile(standardizedSurprise);

  // ── Surprise Direction ───────────────────────────────────────────────────
  const surpriseDirection: SurpriseResult['surpriseDirection'] =
    Math.abs(rawSurprise) < 0.001
      ? 'NEUTRAL'
      : rawSurprise > 0
        ? 'POSITIVE'
        : 'NEGATIVE';

  // ── Revision Surprise ────────────────────────────────────────────────────
  const revisionSurprise = revision
    ? Math.abs(actual - previous)
    : 0;

  // ── Forecast Dispersion ──────────────────────────────────────────────────
  const forecastDispersion = calculateForecastDispersion(dist);

  // ── Novelty Score ────────────────────────────────────────────────────────
  const noveltyScore = calculateNoveltyScore(
    standardizedSurprise,
    forecastDispersion,
    revision,
    dist,
  );

  // ── Market Implied Probability Change ────────────────────────────────────
  const marketImpliedProbabilityChange = calculateImpliedProbChange(
    rawSurprise,
    dist,
  );

  // ── Pre-Event Positioning ────────────────────────────────────────────────
  const preEventPositioning = estimatePreEventPositioning(dist);

  return {
    rawSurprise,
    standardizedSurprise,
    surprisePercentile,
    surpriseDirection,
    revisionSurprise,
    forecastDispersion,
    noveltyScore,
    marketImpliedProbabilityChange,
    preEventPositioning,
  };
}

// ── Internal Helpers ─────────────────────────────────────────────────────────

/**
 * Calculate the expected move from the forecast distribution.
 * Uses the interquartile range (p75 - p25) as a robust measure.
 */
function calculateExpectedMove(dist: ForecastDistribution): number {
  if (dist.moveQuantiles.length >= 3) {
    const q75 = dist.moveQuantiles[dist.moveQuantiles.length - 2] ?? dist.moveQuantiles[dist.moveQuantiles.length - 1];
    const q25 = dist.moveQuantiles[1] ?? dist.moveQuantiles[0];
    return Math.abs(q75 - q25) / 2;
  }
  return dist.abstainProbability > 0
    ? (1 - dist.abstainProbability) * 50
    : 50;
}

/**
 * Calculate forecast dispersion: how spread out is the distribution.
 * Higher dispersion = more uncertainty = events are less predictable.
 */
function calculateForecastDispersion(dist: ForecastDistribution): number {
  if (dist.moveQuantiles.length >= 3) {
    const q90 = dist.moveQuantiles[dist.moveQuantiles.length - 1];
    const q10 = dist.moveQuantiles[0];
    return q90 - q10;
  }
  const probSpread = Math.abs(dist.pUp - dist.pDown);
  return (1 - probSpread) * 100;
}

/**
 * Convert standardized surprise to a percentile using the error function
 * approximation (normal distribution CDF). Abramowitz & Stegun method.
 */
function standardizedToPercentile(z: number): number {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);

  return 50 * (1 + sign * y);
}

/**
 * Calculate novelty score. High novelty when:
 * - Large standardized surprise relative to forecast confidence
 * - Low forecast dispersion (we were confident but wrong)
 * - NOT a revision (revisions are less novel)
 */
function calculateNoveltyScore(
  standardizedSurprise: number,
  forecastDispersion: number,
  revision: boolean,
  dist: ForecastDistribution,
): number {
  let novelty = 0;

  // Surprise magnitude contribution (abs standardized surprise, capped)
  novelty += Math.min(Math.abs(standardizedSurprise) / 3, 1) * 0.4;

  // Low dispersion + high surprise = very novel (we were confident but wrong)
  const dispersionFactor = forecastDispersion > 0
    ? Math.max(0, 1 - forecastDispersion / 200)
    : 0.5;
  novelty += dispersionFactor * Math.min(Math.abs(standardizedSurprise) / 2, 1) * 0.3;

  // Abstain probability: if model was uncertain, the surprise is less novel
  novelty += (1 - dist.abstainProbability) * 0.2;

  // Revisions are less novel
  if (revision) {
    novelty *= 0.6;
  }

  return Math.min(Math.max(novelty, 0), 1);
}

/**
 * Calculate market implied probability change.
 * Measures how much the "surprise" shifts the probability balance.
 */
function calculateImpliedProbChange(
  rawSurprise: number,
  dist: ForecastDistribution,
): number {
  const forecastBias = dist.pUp - dist.pDown;
  const actualDirection = rawSurprise > 0 ? 1 : rawSurprise < 0 ? -1 : 0;
  const directionAlignment = forecastBias * actualDirection;

  return -directionAlignment * Math.min(Math.abs(rawSurprise) / 100, 1);
}

/**
 * Estimate pre-event positioning from the forecast distribution.
 * High abstain probability + tight distribution = market is positioned
 * for a specific outcome (less uncertainty = more positioning).
 */
function estimatePreEventPositioning(dist: ForecastDistribution): number {
  const imbalance = Math.abs(dist.pUp - dist.pDown);
  const confidence = 1 - dist.abstainProbability;
  return imbalance * confidence;
}
