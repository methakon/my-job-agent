/**
 * Event Forecast — Generates probability distributions for event outcomes.
 *
 * NEVER outputs only CALL/PUT/BUY/SELL — always a distribution.
 * High abstain probability means the system should NOT trade.
 *
 * All functions are PURE.
 */

import {
  ForecastDistribution,
  EventStateMachineState,
  OptionChainFeatures,
  Event,
} from './event-types';
import { SurpriseResult } from './event-surprise';

// ── Types ───────────────────────────────────────────────────────────────────

export interface ForecastInput {
  readonly event: Event;
  readonly surprise: SurpriseResult;
  readonly optionFeatures: OptionChainFeatures;
  readonly currentState: EventStateMachineState;
  readonly historicalMoveMean: number;
  readonly historicalMoveStd: number;
}

// ── Pure functions ──────────────────────────────────────────────────────────

/** Clamp a number to [0, 1]. */
function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/** Gaussian PDF approximation. */
function gaussianPdf(x: number, mean: number, std: number): number {
  if (std <= 0) return x === mean ? 1 : 0;
  const z = (x - mean) / std;
  return Math.exp(-0.5 * z * z) / (std * Math.sqrt(2 * Math.PI));
}

/**
 * Generate a forecast distribution from event features.
 *
 * The forecast is deterministic given the same inputs — no randomness.
 * Abstain probability increases with:
 *   - High surprise (uncertainty)
 *   - Contradiction state
 *   - Low liquidity
 *   - High IV (uncertainty premium already priced in)
 */
export function generateForecast(input: ForecastInput): ForecastDistribution {
  const { surprise, optionFeatures, currentState, historicalMoveMean, historicalMoveStd } = input;

  // Base probabilities from historical move distribution
  const std = historicalMoveStd > 0 ? historicalMoveStd : 1;
  const rawUp = gaussianPdf(1, historicalMoveMean, std) * std * 2;
  const rawDown = gaussianPdf(-1, historicalMoveMean, std) * std * 2;
  const rawFlat = Math.max(0, 1 - rawUp - rawDown);
  // Normalize so pUp + pDown + pFlat = 1 exactly
  const rawSum = rawUp + rawDown + rawFlat;
  const pUp = rawSum > 0 ? rawUp / rawSum : 1 / 3;
  const pDown = rawSum > 0 ? rawDown / rawSum : 1 / 3;
  const pFlat = rawSum > 0 ? rawFlat / rawSum : 1 / 3;

  // Move quantiles from historical distribution
  const moveQuantiles: number[] = [
    historicalMoveMean - 1.28 * std,
    historicalMoveMean - 0.67 * std,
    historicalMoveMean,
    historicalMoveMean + 0.67 * std,
    historicalMoveMean + 1.28 * std,
  ].map((v) => Math.round(v * 100) / 100);

  // Time-to-peak: higher surprise → faster peak
  const baseTime = 45; // minutes
  const timeFactor = Math.max(0.3, 1 - surprise.standardizedSurprise * 0.1);
  const timeToPeakQuantiles = [
    Math.round(baseTime * timeFactor * 0.5),
    Math.round(baseTime * timeFactor),
    Math.round(baseTime * timeFactor * 1.5),
  ];

  // Persistence: higher surprise → less persistence (reversal likely)
  const persistenceProbability = clamp01(0.5 - surprise.standardizedSurprise * 0.05);

  // IV change quantiles
  const ivChangeQuantiles = [
    -(optionFeatures.iv.atmIV * 0.1),
    -(optionFeatures.iv.atmIV * 0.05),
    0,
    optionFeatures.iv.atmIV * 0.05,
    optionFeatures.iv.atmIV * 0.1,
  ].map((v) => Math.round(v * 100) / 100);

  // IV crush probability: high for scheduled events with high IV
  const ivCrushProbability = clamp01(
    optionFeatures.iv.ivPercentile * 0.01 * 0.5 +
    (input.event.lifecycle === 'OFFICIAL' ? 0.2 : 0),
  );

  // Skew and term structure changes
  const skewChange = surprise.surpriseDirection === 'POSITIVE'
    ? -optionFeatures.skew.putCallSkew * 0.3
    : optionFeatures.skew.putCallSkew * 0.1;

  const termStructureChange = -optionFeatures.termStructure.slope * 0.2;

  // Liquidity stress: high during events
  const liquidityStressProbability = clamp01(
    0.3 + surprise.standardizedSurprise * 0.05 + optionFeatures.liquidity.executionStress * 0.2,
  );

  // Abstain probability: increases with uncertainty
  let abstainBase = 0.1; // baseline 10%
  if (currentState === 'S3_CONTRADICTION') abstainBase += 0.3;
  if (surprise.standardizedSurprise > 2) abstainBase += 0.2;
  if (optionFeatures.iv.atmIV > 25) abstainBase += 0.15;
  if (optionFeatures.liquidity.bidAskSpreadPct > 0.5) abstainBase += 0.1;
  const abstainProbability = clamp01(abstainBase);

  return {
    pUp: Math.round(clamp01(pUp) * 10000) / 10000,
    pDown: Math.round(clamp01(pDown) * 10000) / 10000,
    pFlat: Math.round(clamp01(pFlat) * 10000) / 10000,
    moveQuantiles: moveQuantiles as readonly number[],
    timeToPeakQuantiles: timeToPeakQuantiles as readonly number[],
    persistenceProbability: Math.round(persistenceProbability * 10000) / 10000,
    ivChangeQuantiles: ivChangeQuantiles as readonly number[],
    ivCrushProbability: Math.round(ivCrushProbability * 10000) / 10000,
    skewChange: Math.round(skewChange * 10000) / 10000,
    termStructureChange: Math.round(termStructureChange * 10000) / 10000,
    liquidityStressProbability: Math.round(liquidityStressProbability * 10000) / 10000,
    abstainProbability: Math.round(abstainProbability * 10000) / 10000,
  };
}

/**
 * Decide whether to emit PAPER_CANDIDATE or ABSTAIN based on the forecast.
 */
export function decideFromForecast(
  forecast: ForecastDistribution,
  abstainThreshold: number = 0.5,
): 'PAPER_CANDIDATE' | 'ABSTAIN' {
  return forecast.abstainProbability >= abstainThreshold ? 'ABSTAIN' : 'PAPER_CANDIDATE';
}
