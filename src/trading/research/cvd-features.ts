/**
 * ITEM 58 — CVD slope and aggressive-trade imbalance.
 *
 * doneWhen: "same inputs produce same result in replay."
 *
 * PURE: no clock, no I/O, no DB, no network, no randomness.
 * RESEARCH / SHADOW ONLY: nothing in production imports this module.
 *
 * CVD (Cumulative Volume Delta): running sum of (buyVolume − sellVolume)
 * across a time window. The slope of CVD measures whether aggressive
 * buyers or sellers are accelerating.
 *
 * Aggressive-trade imbalance: ratio of large-lot aggressor trades
 * (market orders hitting the opposite side) to passive trades.
 */

// ── Types ─────────────────────────────────────────────────────────────

export const CVD_FEATURES_VERSION = 'cvdfeat-v1';

export interface TickData {
  /** Epoch-ms timestamp. */
  readonly tsMs: number;
  /** Last traded price. */
  readonly ltp: number;
  /** Volume at this tick. */
  readonly volume: number;
  /** Aggressor side: 'BUY' = hit the ask (aggressive buy), 'SELL' = hit the bid. */
  readonly aggressorSide: 'BUY' | 'SELL';
  /** Trade size in lots/shares. */
  readonly tradeSize: number;
}

export type RefusalReason = 'NO_TICKS' | 'INSUFFICIENT_TICKS' | 'SINGLE_DIRECTION';
const no = (reason: RefusalReason) => ({ ok: false as const, reason });

export interface CvdSlope {
  /** Linear regression slope of CVD over the window (units: contracts per ms). */
  readonly slope: number;
  /** R² of the linear fit (goodness of fit). */
  readonly rSquared: number;
  /** Final CVD value (buyVol − sellVol). */
  readonly finalCvd: number;
  /** Whether CVD is monotonically increasing. */
  readonly monotonicUp: boolean;
  /** Whether CVD is monotonically decreasing. */
  readonly monotonicDown: boolean;
  /** Number of sign changes in CVD deltas. */
  readonly signChanges: number;
}

export interface AggressiveImbalance {
  /** Fraction of volume from aggressive buyers (buy-volume / total). */
  readonly aggressorBuyFraction: number;
  /** Fraction of volume from aggressive sellers. */
  readonly aggressorSellFraction: number;
  /** Ratio of buy aggression to sell aggression. */
  readonly buySellRatio: number;
  /** Fraction of large-lot trades that were aggressive buys. */
  readonly largeLotBuyFraction: number;
  /** Fraction of large-lot trades that were aggressive sells. */
  readonly largeLotSellFraction: number;
  /** Net aggression score: (aggressiveBuyVol − aggressiveSellVol) / totalVol. Range [-1, 1]. */
  readonly netAggression: number;
}

export type CvdResult = { ok: true; value: CvdSlope } | { ok: false; reason: RefusalReason };
export type AggrResult = { ok: true; value: AggressiveImbalance } | { ok: false; reason: RefusalReason };

// ── CVD Slope ─────────────────────────────────────────────────────────

/**
 * Compute CVD (Cumulative Volume Delta) slope via linear regression.
 *
 * The slope is the rate of change of the cumulative delta. A positive slope
 * means aggressive buying is accelerating; negative means aggressive selling.
 *
 * Deterministic: same tick sequence → same slope, always.
 */
export function computeCvdSlope(ticks: readonly TickData[]): CvdResult {
  if (!ticks.length) return no('NO_TICKS');
  if (ticks.length < 3) return no('INSUFFICIENT_TICKS');

  // Build CVD series
  const cvdPoints: { x: number; y: number }[] = [];
  let cumulative = 0;
  const startTs = ticks[0].tsMs;
  for (const t of ticks) {
    const delta = t.aggressorSide === 'BUY' ? t.volume : -t.volume;
    cumulative += delta;
    cvdPoints.push({ x: t.tsMs - startTs, y: cumulative });
  }

  // Linear regression
  const n = cvdPoints.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
  for (const p of cvdPoints) {
    sumX += p.x;
    sumY += p.y;
    sumXY += p.x * p.y;
    sumX2 += p.x * p.x;
    sumY2 += p.y * p.y;
  }
  const denom = n * sumX2 - sumX * sumX;
  const slope = denom !== 0 ? (n * sumXY - sumX * sumY) / denom : 0;
  const intercept = (sumY - slope * sumX) / n;

  // R²
  const meanY = sumY / n;
  let ssTot = 0, ssRes = 0;
  for (const p of cvdPoints) {
    ssTot += (p.y - meanY) ** 2;
    const predicted = slope * p.x + intercept;
    ssRes += (p.y - predicted) ** 2;
  }
  const rSquared = ssTot > 0 ? 1 - ssRes / ssTot : 1;

  // Monotonicity and sign changes
  let monotonicUp = true, monotonicDown = true, signChanges = 0;
  for (let i = 1; i < cvdPoints.length; i++) {
    const d = cvdPoints[i].y - cvdPoints[i - 1].y;
    if (d < 0) monotonicUp = false;
    if (d > 0) monotonicDown = false;
    if (i >= 2) {
      const prev = cvdPoints[i - 1].y - cvdPoints[i - 2].y;
      if ((prev > 0 && d < 0) || (prev < 0 && d > 0)) signChanges++;
    }
  }

  return { ok: true, value: { slope, rSquared, finalCvd: cumulative, monotonicUp, monotonicDown, signChanges } };
}

// ── Aggressive-trade imbalance ────────────────────────────────────────

/** Large-lot threshold: trades with tradeSize >= this are "large". */
const LARGE_LOT_THRESHOLD = 500;

/**
 * Compute aggressive-trade imbalance from tick data.
 *
 * Measures whether large aggressive orders dominate, indicating
 * institutional conviction behind the price move.
 *
 * Deterministic: same tick sequence → same imbalance, always.
 */
export function computeAggressiveImbalance(ticks: readonly TickData[]): AggrResult {
  if (!ticks.length) return no('NO_TICKS');

  let buyVol = 0, sellVol = 0;
  let largeBuyVol = 0, largeSellVol = 0;

  for (const t of ticks) {
    const vol = t.volume;
    if (t.aggressorSide === 'BUY') {
      buyVol += vol;
      if (t.tradeSize >= LARGE_LOT_THRESHOLD) largeBuyVol += vol;
    } else {
      sellVol += vol;
      if (t.tradeSize >= LARGE_LOT_THRESHOLD) largeSellVol += vol;
    }
  }

  const totalVol = buyVol + sellVol;
  if (totalVol === 0) return no('NO_TICKS');

  const largeTotal = largeBuyVol + largeSellVol;

  return {
    ok: true,
    value: {
      aggressorBuyFraction: buyVol / totalVol,
      aggressorSellFraction: sellVol / totalVol,
      buySellRatio: sellVol > 0 ? buyVol / sellVol : Infinity,
      largeLotBuyFraction: largeTotal > 0 ? largeBuyVol / largeTotal : 0.5,
      largeLotSellFraction: largeTotal > 0 ? largeSellVol / largeTotal : 0.5,
      netAggression: (buyVol - sellVol) / totalVol,
    },
  };
}

// ── Combined feature vector ───────────────────────────────────────────

export interface CvdAggrFeatures {
  readonly cvd: CvdSlope;
  readonly aggr: AggressiveImbalance;
  readonly version: string;
}

/**
 * Combined CVD slope + aggressive imbalance feature vector.
 * Returns both or refuses if either input is insufficient.
 */
export function computeCvdAggrFeatures(
  ticks: readonly TickData[],
): { ok: true; value: CvdAggrFeatures } | { ok: false; reason: RefusalReason } {
  const cvd = computeCvdSlope(ticks);
  if (!cvd.ok) return { ok: false, reason: (cvd as any).reason };
  const aggr = computeAggressiveImbalance(ticks);
  if (!aggr.ok) return { ok: false, reason: (aggr as any).reason };
  return { ok: true, value: { cvd: cvd.value, aggr: aggr.value, version: CVD_FEATURES_VERSION } };
}
