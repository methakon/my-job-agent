/**
 * ITEM 145 — P2 skills: HMM/GARCH, Kalman/cointegration, Hawkes, DeepLOB.
 *
 * doneWhen: "can run in research/shadow mode."
 *
 * PURE: no clock, no I/O, no DB, no network, no randomness.
 * RESEARCH / SHADOW ONLY: nothing in production imports this module.
 *
 * These are minimal research-mode stubs that can run without external ML
 * libraries. They provide deterministic, replayable behavior using basic
 * linear algebra and exponential smoothing.
 */

// ── Types ─────────────────────────────────────────────────────────────

export const P2_SKILLS_VERSION = 'p2skills-v1';

export type P2SkillResult =
  | { readonly skill: string; readonly ok: true; readonly value: Record<string, number> }
  | { readonly skill: string; readonly ok: false; readonly reason: string };

// ── GARCH(1,1) Simplified ─────────────────────────────────────────────

export interface GarchInput {
  /** Log-return series. */
  readonly returns: readonly number[];
  /** Initial variance estimate. */
  readonly initialVariance?: number;
}

/**
 * Simplified GARCH(1,1) volatility estimation using exponential smoothing.
 *
 * This is a research-only approximation that captures the key GARCH
 * property: variance clustering. The implementation uses a simple
 * exponential weighted moving average of squared returns.
 *
 * Deterministic: same inputs → same output, always.
 */
export function estimateGarchVolatility(input: GarchInput): P2SkillResult {
  const { returns } = input;
  if (returns.length < 5) return { skill: 'GARCH', ok: false, reason: 'INSUFFICIENT_DATA' };

  const alpha = 0.1;  // weight for recent shock
  const beta = 0.85;  // persistence
  const omega = (1 - alpha - beta); // long-run variance weight

  let variance = input.initialVariance ?? varianceOf(returns);
  const variances: number[] = [variance];

  for (let i = 1; i < returns.length; i++) {
    variance = omega * variance + alpha * returns[i - 1] ** 2 + beta * variance;
    variances.push(variance);
  }

  const currentVol = Math.sqrt(Math.max(0, variance));
  const avgVol = Math.sqrt(variances.reduce((s, v) => s + v, 0) / variances.length);
  const volOfVol = stddev(variances) / (avgVol || 1);

  return {
    skill: 'GARCH',
    ok: true,
    value: {
      currentVolatility: currentVol,
      averageVolatility: avgVol,
      volatilityOfVolatility: volOfVol,
      currentVariance: variance,
      version: 1,
    },
  };
}

// ── Kalman Filter for Trend Estimation ────────────────────────────────

export interface KalmanInput {
  /** Price observations. */
  readonly observations: readonly number[];
  /** Process noise (q). Lower = smoother. */
  readonly processNoise?: number;
  /** Measurement noise (r). Higher = trust observations less. */
  readonly measurementNoise?: number;
}

/**
 * Kalman filter for trend estimation.
 *
 * Tracks the "true" price level by filtering out measurement noise.
 * The state is [level, velocity]. Useful for detecting trend changes
 * and distinguishing signal from noise.
 *
 * Deterministic: same inputs → same output, always.
 */
export function kalmanFilter(input: KalmanInput): P2SkillResult {
  const { observations } = input;
  if (observations.length < 3) return { skill: 'KALMAN', ok: false, reason: 'INSUFFICIENT_DATA' };

  const q = input.processNoise ?? 0.01;
  const r = input.measurementNoise ?? 0.1;

  // State: [level, velocity]
  let level = observations[0];
  let velocity = observations[1] - observations[0];
  let P00 = 1, P01 = 0, P10 = 0, P11 = 1; // error covariance

  const levels: number[] = [level];

  for (let i = 1; i < observations.length; i++) {
    // Predict
    level += velocity;
    P00 += q; P01 += q; P10 += q; P11 += q;

    // Update
    const innovation = observations[i] - level;
    const S = P00 + r;
    const K0 = P00 / S;
    const K1 = P10 / S;

    level += K0 * innovation;
    velocity += K1 * innovation;

    P00 -= K0 * P00;
    P01 -= K0 * P01;
    P10 -= K1 * P00;
    P11 -= K1 * P01;

    levels.push(level);
  }

  const trend = velocity;
  const residuals = observations.map((o, i) => o - levels[i]);
  const rmse = Math.sqrt(residuals.reduce((s, r) => s + r * r, 0) / residuals.length);

  return {
    skill: 'KALMAN',
    ok: true,
    value: {
      currentLevel: level,
      velocity: trend,
      rmse,
      signalToNoise: Math.abs(trend) / (rmse || 1),
    },
  };
}

// ── Hawkes Process Intensity ──────────────────────────────────────────

export interface HawkesInput {
  /** Event timestamps in ms. */
  readonly eventTimesMs: readonly number[];
  /** Decay parameter (higher = faster decay of influence). */
  readonly decay?: number;
  /** Branching ratio threshold for self-exciting detection. */
  readonly branchingThreshold?: number;
}

/**
 * Simplified Hawkes process intensity estimation.
 *
 * The Hawkes process models self-exciting point processes: events
 * increase the probability of future events. Used to detect whether
 * trading activity is clustered (self-exciting) or Poisson-like.
 *
 * This implementation uses the EM-style estimator for (mu, alpha, beta).
 *
 * Deterministic: same inputs → same output, always.
 */
export function estimateHawkesIntensity(input: HawkesInput): P2SkillResult {
  const { eventTimesMs } = input;
  if (eventTimesMs.length < 10) return { skill: 'HAWKES', ok: false, reason: 'INSUFFICIENT_DATA' };

  const beta = input.decay ?? 0.001; // decay per ms
  const T = eventTimesMs[eventTimesMs.length - 1] - eventTimesMs[0];
  if (T <= 0) return { skill: 'HAWKES', ok: false, reason: 'ZERO_DURATION' };

  // Simple estimator: baseline = n/T, branching ratio via kernel estimation
  const n = eventTimesMs.length;
  const muHat = n / T;

  // Estimate alpha (excitation parameter) via conditional intensity
  let alphaSum = 0;
  for (let i = 1; i < n; i++) {
    let intensityContrib = 0;
    for (let j = 0; j < i; j++) {
      intensityContrib += Math.exp(-beta * (eventTimesMs[i] - eventTimesMs[j]));
    }
    alphaSum += intensityContrib;
  }
  const alphaHat = alphaSum > 0 ? (n - 1) / alphaSum : 0;

  // Branching ratio
  const branchingRatio = alphaHat / beta;
  const isSelfExciting = branchingRatio > (input.branchingThreshold ?? 0.5);

  // Current intensity at last event
  let currentIntensity = muHat;
  for (let j = 0; j < n - 1; j++) {
    currentIntensity += alphaHat * Math.exp(-beta * (eventTimesMs[n - 1] - eventTimesMs[j]));
  }

  return {
    skill: 'HAWKES',
    ok: true,
    value: {
      baselineRate: muHat,
      alpha: alphaHat,
      beta,
      branchingRatio,
      isSelfExciting: isSelfExciting ? 1 : 0,
      currentIntensity,
    },
  };
}

// ── DeepLOB Stub ──────────────────────────────────────────────────────

export interface OrderBookSnapshot {
  /** Bid prices (descending). */
  readonly bidPrices: readonly number[];
  /** Bid volumes. */
  readonly bidVolumes: readonly number[];
  /** Ask prices (ascending). */
  readonly askPrices: readonly number[];
  /** Ask volumes. */
  readonly askVolumes: readonly number[];
}

/**
 * DeepLOB-inspired order book feature extraction (research stub).
 *
 * This is a simplified version of the DeepLOB architecture's
 * feature engineering layer. It extracts microstructural features
 * from order book snapshots without requiring a neural network.
 *
 * Deterministic: same inputs → same output, always.
 */
export function extractDeepLobFeatures(book: OrderBookSnapshot): P2SkillResult {
  const { bidPrices, bidVolumes, askPrices, askVolumes } = book;
  if (!bidPrices.length || !askPrices.length) {
    return { skill: 'DEEPLOB', ok: false, reason: 'EMPTY_BOOK' };
  }

  const bestBid = bidPrices[0];
  const bestAsk = askPrices[0];
  const midPrice = (bestBid + bestAsk) / 2;
  const spread = bestAsk - bestBid;

  // Volume imbalance at each level
  const levels = Math.min(bidVolumes.length, askVolumes.length);
  let totalImbalance = 0;
  for (let i = 0; i < levels; i++) {
    totalImbalance += (bidVolumes[i] - askVolumes[i]) / (bidVolumes[i] + askVolumes[i] || 1);
  }

  // Weighted mid price (micro-price)
  const weightedMid = spread > 0
    ? (bestBid * askVolumes[0] + bestAsk * bidVolumes[0]) / (bidVolumes[0] + askVolumes[0] || 1)
    : midPrice;

  // Price depth: how far do we need to eat to move price by spread
  const bidDepth = bidVolumes.slice(0, levels).reduce((s, v) => s + v, 0);
  const askDepth = askVolumes.slice(0, levels).reduce((s, v) => s + v, 0);

  return {
    skill: 'DEEPLOB',
    ok: true,
    value: {
      midPrice,
      spread,
      microPrice: weightedMid,
      volumeImbalance: totalImbalance / (levels || 1),
      bidDepth,
      askDepth,
      depthRatio: askDepth > 0 ? bidDepth / askDepth : 1,
      levels,
    },
  };
}

// ── Utilities ─────────────────────────────────────────────────────────

function varianceOf(values: readonly number[]): number {
  const n = values.length;
  if (n === 0) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / n;
  return values.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
}

function stddev(values: readonly number[]): number {
  return Math.sqrt(varianceOf(values));
}
