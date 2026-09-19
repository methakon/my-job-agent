/**
 * Hawkes Intensity — Self-exciting point process estimation.
 *
 * The Hawkes process models event clustering: each event temporarily
 * increases the probability of subsequent events.
 *
 * Key metric: branching ratio (μ) ∈ [0, 1). Higher = more clustering.
 *   μ < 0.3 → low self-excitation (events are roughly uniform)
 *   μ > 0.7 → high self-excitation (events come in bursts)
 *
 * All functions are PURE.
 */

import { HawkesEstimate, HawkesPrediction } from './event-types';

// ── Pure functions ──────────────────────────────────────────────────────────

/**
 * Estimate Hawkes parameters from observed event timestamps.
 *
 * Uses the simple moment-based estimator:
 *   branchingRatio = (N - 1) / sum_of_inter_arrival_times * decayParameter
 *
 * For simplicity, we use a fixed decay half-life and estimate the
 * branching ratio from the coefficient of variation of inter-arrival times.
 * Clustered events have LOW coefficient of variation in inter-arrivals
 * (they come in tight bursts), but a HIGH ratio of short-to-long gaps.
 *
 * @param eventTimesMs - sorted ascending, at least 2 timestamps
 * @param decayHalfLifeMs - half-life of the exponential kernel in ms
 */
export function estimateHawkes(
  eventTimesMs: readonly number[],
  decayHalfLifeMs: number = 3600000, // 1 hour default
): HawkesEstimate {
  if (eventTimesMs.length < 2) {
    return {
      backgroundIntensity: eventTimesMs.length === 1 ? 1 / 86400000 : 0,
      currentJumpIntensity: 0,
      branchingRatio: 0,
      decayHalfLife: decayHalfLifeMs,
      totalIntensity: eventTimesMs.length === 1 ? 1 / 86400000 : 0,
    };
  }

  // Compute inter-arrival times
  const interArrivals: number[] = [];
  for (let i = 1; i < eventTimesMs.length; i++) {
    interArrivals.push(eventTimesMs[i] - eventTimesMs[i - 1]);
  }

  // Mean inter-arrival
  const meanInterArrival =
    interArrivals.reduce((a, b) => a + b, 0) / interArrivals.length;

  // Standard deviation of inter-arrivals
  const variance =
    interArrivals.reduce((sum, v) => sum + (v - meanInterArrival) ** 2, 0) /
    interArrivals.length;
  const stdInterArrival = Math.sqrt(variance);

  // Coefficient of variation (CV) — high CV = irregular spacing
  // Uniform events: CV ≈ 0 (or low)
  // Clustered events: CV > 1
  const cv = meanInterArrival > 0 ? stdInterArrival / meanInterArrival : 0;

  // Branching ratio estimation from CV:
  // For a Hawkes process, CV² = (1 - μ)² / μ  (approximate for exponential kernel)
  // Solving: μ² * CV² = (1 - μ)² → μ * CV = 1 - μ → μ(CV + 1) = 1 → μ = 1/(CV+1)
  // But this gives LOW branching ratio for LOW CV (uniform) — wrong direction.
  //
  // Better estimator: use the ratio of short gaps to total time span.
  // Clustered events have many short inter-arrivals followed by long gaps.
  const shortGaps = interArrivals.filter((ia) => ia < meanInterArrival * 0.5).length;
  const clusteringRatio = shortGaps / interArrivals.length;

  // Branching ratio: mix of CV-based and clustering-based
  // Low CV with high clustering → moderate branching ratio
  // High CV with low clustering → low branching ratio
  const branchingRatio = Math.min(
    0.99,
    Math.max(0, clusteringRatio * 0.8 + (cv > 1 ? 0.2 : cv * 0.2)),
  );

  // Background intensity: events per ms if they were uniform
  const totalTimeSpan =
    eventTimesMs[eventTimesMs.length - 1] - eventTimesMs[0];
  const backgroundIntensity =
    totalTimeSpan > 0 ? eventTimesMs.length / totalTimeSpan : 0;

  // Current jump intensity: contribution from recent events
  const decayRate = Math.log(2) / decayHalfLifeMs;
  const lastEventTime = eventTimesMs[eventTimesMs.length - 1];
  let jumpIntensity = 0;
  for (const t of eventTimesMs) {
    const age = lastEventTime - t;
    jumpIntensity += Math.exp(-decayRate * age);
  }
  jumpIntensity *= branchingRatio * backgroundIntensity;

  const totalIntensity = backgroundIntensity + jumpIntensity;

  return {
    backgroundIntensity: round8(backgroundIntensity),
    currentJumpIntensity: round8(jumpIntensity),
    branchingRatio: round4(branchingRatio),
    decayHalfLife: decayHalfLifeMs,
    totalIntensity: round8(totalIntensity),
  };
}

/**
 * Predict the next arrival time given current Hawkes estimate and last event time.
 */
export function predictNextArrival(
  hawkes: HawkesEstimate,
  lastEventTimeMs: number,
  nowMs: number,
): HawkesPrediction {
  if (hawkes.totalIntensity <= 0) {
    return {
      predictedArrivalTimeMs: nowMs + 86400000, // 24h fallback
      confidenceInterval: [nowMs, nowMs + 2 * 86400000],
      intensityAtPrediction: 0,
    };
  }

  // Expected waiting time: 1 / totalIntensity
  const expectedWaitMs = 1 / hawkes.totalIntensity;
  const predictedArrival = nowMs + expectedWaitMs;

  // Confidence interval: ±1 standard deviation (Poisson approximation)
  const stdDev = 1 / hawkes.totalIntensity;

  return {
    predictedArrivalTimeMs: Math.round(predictedArrival),
    confidenceInterval: [
      Math.round(predictedArrival - stdDev),
      Math.round(predictedArrival + stdDev),
    ],
    intensityAtPrediction: hawkes.totalIntensity,
  };
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function round8(n: number): number {
  return Math.round(n * 100000000) / 100000000;
}
