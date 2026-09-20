/**
 * MLOFI (Multi-Level Order Flow Imbalance) — weighted OFI across N price levels.
 *
 * MLOFI extends OFI by computing imbalance at each of the top N price levels
 * and weighting closer-to-midprice levels more heavily using exponential decay.
 *
 * Formula per level i (0 = best bid/ask, i+1 = next level away):
 *   weight_i = exp(-λ * i)        where λ = decayRate (default: 0.5)
 *   OFI_i = ΔBidDepth_i - ΔAskDepth_i
 *   MLOFI = Σ(w_i * OFI_i) / Σ(w_i)
 *
 * The denominator normalizes so the result is in [-1, 1].
 *
 * PURE: no I/O, no DB, no clock.
 */

import { OrderBookSnapshot, PriceLevel } from './ofi';
import { computeOfiDelta } from './ofi';

export const MLOFI_VERSION = 'mlofi-v1';

export type MlofiResult = {
  value: number;           // normalized [-1, 1]
  rawWeightedSum: number;
  totalWeight: number;
  levelDetails: {
    level: number;
    ofiContribution: number;
    weight: number;
    weightedContribution: number;
  }[];
  numLevels: number;
  decayRate: number;
  window: number;
  invalidReason?: string;
};

/**
 * Compute MLOFI from consecutive order book snapshots.
 *
 * @param prev       previous snapshot
 * @param curr       current snapshot
 * @param numLevels  how many price levels deep to compute (default: 5)
 * @param decayRate  exponential decay factor λ (default: 0.5)
 */
export function computeMlofi(
  prev: OrderBookSnapshot,
  curr: OrderBookSnapshot,
  numLevels: number = 5,
  decayRate: number = 0.5,
): MlofiResult {
  const INVALID: MlofiResult = {
    value: 0,
    rawWeightedSum: 0,
    totalWeight: 0,
    levelDetails: [],
    numLevels,
    decayRate,
    window: 0,
    invalidReason: 'INSTRUMENT_MISMATCH',
  };

  if (prev.instrumentKey !== curr.instrumentKey) return INVALID;

  // Build sorted level maps: bids descending (best first), asks ascending (best first)
  const bidsPrev = sortLevels(prev.bids, 'desc').slice(0, numLevels);
  const bidsCurr = sortLevels(curr.bids, 'desc').slice(0, numLevels);
  const asksPrev = sortLevels(prev.asks, 'asc').slice(0, numLevels);
  const asksCurr = sortLevels(curr.asks, 'asc').slice(0, numLevels);

  let weightedSum = 0;
  let totalWeight = 0;
  const details: MlofiResult['levelDetails'] = [];

  for (let i = 0; i < numLevels; i++) {
    const weight = Math.exp(-decayRate * i);
    const bidDelta = safeQty(bidsCurr, i) - safeQty(bidsPrev, i);
    const askDelta = safeQty(asksCurr, i) - safeQty(asksPrev, i);
    const ofiAtLevel = bidDelta - askDelta;

    weightedSum += weight * ofiAtLevel;
    totalWeight += weight;

    if (ofiAtLevel !== 0) {
      details.push({
        level: i,
        ofiContribution: ofiAtLevel,
        weight,
        weightedContribution: weight * ofiAtLevel,
      });
    }
  }

  // Normalize: divide by total weight and a per-level expected max
  // Use 500 contracts per level as expected max for normalization
  const perLevelMax = 500;
  const normalized = totalWeight > 0
    ? clamp(weightedSum / (totalWeight * perLevelMax), -1, 1)
    : 0;

  return {
    value: normalized,
    rawWeightedSum: weightedSum,
    totalWeight,
    levelDetails: details,
    numLevels,
    decayRate,
    window: 2,
  };
}

/**
 * Compute MLOFI over a history of snapshots (uses last two).
 */
export function computeMlofiFromHistory(
  history: OrderBookSnapshot[],
  numLevels: number = 5,
  decayRate: number = 0.5,
): MlofiResult {
  if (history.length < 2) {
    return {
      value: 0,
      rawWeightedSum: 0,
      totalWeight: 0,
      levelDetails: [],
      numLevels,
      decayRate,
      window: 0,
      invalidReason: 'INSUFFICIENT_SNAPSHOTS',
    };
  }
  return computeMlofi(history[history.length - 2], history[history.length - 1], numLevels, decayRate);
}

// ── Helpers ──

function sortLevels(levels: PriceLevel[], dir: 'asc' | 'desc'): PriceLevel[] {
  const sorted = [...levels].sort((a, b) => dir === 'asc' ? a.price - b.price : b.price - a.price);
  return sorted;
}

function safeQty(levels: PriceLevel[], index: number): number {
  return index < levels.length ? levels[index].qty : 0;
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}
