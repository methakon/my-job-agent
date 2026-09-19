/**
 * OFI (Order Flow Imbalance) — event-based queue depth changes.
 *
 * OFI captures the net directional pressure by comparing changes in bid/ask
 * depth over consecutive snapshots. When bid depth increases or ask depth
 * decreases, it signals buying pressure; the reverse signals selling pressure.
 *
 * Formula per price level i:
 *   ΔBidDepth_i = bidQty_now_i - bidQty_prev_i
 *   ΔAskDepth_i = askQty_now_i - askQty_prev_i
 *   OFI_contribution_i = ΔBidDepth_i - ΔAskDepth_i
 *
 * OFI = Σ_i OFI_contribution_i across all tracked levels.
 *
 * Normalized: OFI_norm = clamp(OFI / maxExpectedOFI, -1, 1)
 *
 * PURE: no I/O, no DB, no clock. All state is explicit.
 */

export const OFI_VERSION = 'ofi-v1';

export type PriceLevel = {
  price: number;
  qty: number;
};

export type OrderBookSnapshot = {
  instrumentKey: string;
  timestamp: number;
  bids: PriceLevel[];
  asks: PriceLevel[];
};

export type OfiResult = {
  value: number;         // normalized [-1, 1]
  raw: number;           // unnormalized aggregate
  netBuyVolume: number;  // total bid-side depth change (positive = added)
  netSellVolume: number; // total ask-side depth change (positive = added)
  levelContributions: { price: number; contribution: number }[];
  window: number;        // number of snapshots used
  invalidReason?: string;
};

/**
 * Compute OFI from a sequence of order book snapshots.
 * Requires at least 2 snapshots (previous + current).
 * Only the top `maxLevels` price levels from each side are considered.
 *
 * @param history  ordered snapshots (oldest → newest)
 * @param maxLevels  top N price levels per side to track (default: 5)
 * @param maxExpected  normalization denominator (default: 1000 contracts)
 */
export function computeOfi(
  history: OrderBookSnapshot[],
  maxLevels: number = 5,
  maxExpected: number = 1000,
): OfiResult {
  const INVALID: OfiResult = {
    value: 0,
    raw: 0,
    netBuyVolume: 0,
    netSellVolume: 0,
    levelContributions: [],
    window: 0,
    invalidReason: 'INSUFFICIENT_SNAPSHOTS',
  };

  if (history.length < 2) return INVALID;

  const prev = history[history.length - 2];
  const curr = history[history.length - 1];

  if (prev.instrumentKey !== curr.instrumentKey) {
    return { ...INVALID, invalidReason: 'INSTRUMENT_MISMATCH' };
  }

  // Build price→qty maps for top N levels (bids: highest first; asks: lowest first)
  const bidMapPrev = buildLevelMap(prev.bids, maxLevels);
  const bidMapCurr = buildLevelMap(curr.bids, maxLevels);
  const askMapPrev = buildLevelMap(prev.asks, maxLevels);
  const askMapCurr = buildLevelMap(curr.asks, maxLevels);

  // Collect all unique prices across all 4 maps
  const allPrices = new Set<number>();
  const maps = [bidMapPrev, bidMapCurr, askMapPrev, askMapCurr];
  for (const m of maps) {
    Array.from(m.keys()).forEach(p => allPrices.add(p));
  }

  let totalContribution = 0;
  let totalBidChange = 0;
  let totalAskChange = 0;
  const contributions: { price: number; contribution: number }[] = [];

  const allPricesArray = Array.from(allPrices);
  for (const price of allPricesArray) {
    const bidDelta = (bidMapCurr.get(price) ?? 0) - (bidMapPrev.get(price) ?? 0);
    const askDelta = (askMapCurr.get(price) ?? 0) - (askMapPrev.get(price) ?? 0);
    const contribution = bidDelta - askDelta;
    totalContribution += contribution;
    totalBidChange += bidDelta;
    totalAskChange += askDelta;
    if (contribution !== 0) {
      contributions.push({ price, contribution });
    }
  }

  // Normalize to [-1, 1]
  const normalized = clamp(totalContribution / maxExpected, -1, 1);

  return {
    value: normalized,
    raw: totalContribution,
    netBuyVolume: totalBidChange,
    netSellVolume: totalAskChange,
    levelContributions: contributions,
    window: history.length,
  };
}

/**
 * Compute OFI delta between exactly two snapshots (previous → current).
 * Convenience wrapper for streaming/event-based use.
 */
export function computeOfiDelta(
  prev: OrderBookSnapshot,
  curr: OrderBookSnapshot,
  maxLevels: number = 5,
  maxExpected: number = 1000,
): OfiResult {
  return computeOfi([prev, curr], maxLevels, maxExpected);
}

// ── Helpers ──

function buildLevelMap(levels: PriceLevel[], maxN: number): Map<number, number> {
  const m = new Map<number, number>();
  // Bids should be sorted descending, asks ascending — but take first N regardless
  const sorted = [...levels].sort((a, b) => b.price - a.price); // descending
  for (const l of sorted.slice(0, maxN)) {
    m.set(l.price, l.qty);
  }
  return m;
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}
