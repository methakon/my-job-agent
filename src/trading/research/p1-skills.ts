/**
 * ITEM 143 — P1 skills: profile/failed auction, CVD/absorption, IV-RV/surface, GEX, cross-market lead-lag.
 *
 * doneWhen: "can run in research/shadow mode."
 *
 * PURE: no clock, no I/O, no DB, no network, no randomness.
 * RESEARCH / SHADOW ONLY: nothing in production imports this module.
 *
 * This module provides the P1 skill implementations that are research-only.
 * Some skills (IV-RV, IV-Surface, GEX) already exist in src/trading/options/.
 * This module adds: profile/failed auction, CVD/absorption, cross-market lead-lag.
 */

// ── Types ─────────────────────────────────────────────────────────────

export const P1_SKILLS_VERSION = 'p1skills-v1';

// ── Profile / Failed Auction ──────────────────────────────────────────

export interface ProfileAuctionInput {
  /** High of the initial balance (first hour). */
  readonly ibHigh: number;
  /** Low of the initial balance. */
  readonly ibLow: number;
  /** Session high so far. */
  readonly sessionHigh: number;
  /** Session low so far. */
  readonly sessionLow: number;
  /** Point of control (highest volume price). */
  readonly poc: number;
  /** Current price. */
  readonly currentPrice: number;
  /** Number of rotations (oscillations between VAH and VAL). */
  readonly rotationCount: number;
}

export type AuctionOutcome =
  | 'NORMAL_RANGE'        // Session staying within initial balance
  | 'FAILED_HIGH_AUCTION' // Attempted breakout above IB failed
  | 'FAILED_LOW_AUCTION'  // Attempted breakout below IB failed
  | 'TREND_EXTENSION_UP'  // Broke IB high and continued
  | 'TREND_EXTENSION_DOWN'// Broke IB low and continued
  | 'DOUBLE_distribution'; // Two distinct value areas

export interface FailedAuctionResult {
  readonly outcome: AuctionOutcome;
  /** Did price attempt to auction above/below IB and fail? */
  readonly attemptedBreakout: 'NONE' | 'UP' | 'DOWN';
  /** Did price close back inside the IB after attempting? */
  readonly closedInside: boolean;
  /** Rotation count: higher = more balanced / failed. */
  readonly rotations: number;
}

/**
 * Detect failed auction / profile structure outcome.
 *
 * A "failed auction" occurs when price attempts to move the auction outside
 * the initial balance but fails and returns inside. This is a strong signal
 * of range-bound conditions.
 *
 * Deterministic: same inputs → same outcome, always.
 */
export function assessProfileAuction(input: ProfileAuctionInput): FailedAuctionResult {
  const { ibHigh, ibLow, sessionHigh, sessionLow, currentPrice, rotationCount } = input;
  const ibRange = ibHigh - ibLow;

  if (ibRange <= 0) {
    return { outcome: 'NORMAL_RANGE', attemptedBreakout: 'NONE', closedInside: true, rotations: rotationCount };
  }

  const brokeHigh = sessionHigh > ibHigh;
  const brokeLow = sessionLow < ibLow;
  const insideNow = currentPrice >= ibLow && currentPrice <= ibHigh;

  let attemptedBreakout: FailedAuctionResult['attemptedBreakout'] = 'NONE';
  if (brokeHigh && brokeLow) {
    // Both sides attempted — double distribution or failed both
    attemptedBreakout = sessionHigh - ibHigh > ibLow - sessionLow ? 'UP' : 'DOWN';
  } else if (brokeHigh) {
    attemptedBreakout = 'UP';
  } else if (brokeLow) {
    attemptedBreakout = 'DOWN';
  }

  let outcome: AuctionOutcome;
  if (brokeHigh && brokeLow) {
    outcome = 'DOUBLE_distribution';
  } else if (brokeHigh && !insideNow) {
    outcome = 'TREND_EXTENSION_UP';
  } else if (brokeLow && !insideNow) {
    outcome = 'TREND_EXTENSION_DOWN';
  } else if (brokeHigh && insideNow) {
    outcome = 'FAILED_HIGH_AUCTION';
  } else if (brokeLow && insideNow) {
    outcome = 'FAILED_LOW_AUCTION';
  } else {
    outcome = 'NORMAL_RANGE';
  }

  return { outcome, attemptedBreakout, closedInside: insideNow, rotations: rotationCount };
}

// ── CVD / Absorption ──────────────────────────────────────────────────

export interface AbsorptionInput {
  /** Cumulative volume delta (buy − sell) at a price level. */
  readonly cvdAtLevel: number;
  /** Volume at that price level. */
  readonly volumeAtLevel: number;
  /** Price direction at that level (positive = up). */
  readonly priceMove: number;
  /** Whether large lots dominated. */
  readonly largeLotDominated: boolean;
}

export type AbsorptionSignal =
  | 'ABSORPTION_BUY'   // Selling absorbed by passive buying
  | 'ABSORPTION_SELL'  // Buying absorbed by passive selling
  | 'NO_ABSORPTION'    // Normal flow, no absorption detected
  | 'INSUFFICIENT_DATA';

/**
 * Detect absorption: a condition where large volume at a price level
 * absorbs aggressive orders without significant price movement.
 *
 * Absorption buy: large selling volume absorbed by passive buying → CVD deeply negative
 * but price doesn't drop. Absorption sell: mirror image.
 *
 * Deterministic: same inputs → same signal, always.
 */
export function detectAbsorption(input: AbsorptionInput): AbsorptionSignal {
  const { cvdAtLevel, volumeAtLevel, priceMove, largeLotDominated } = input;

  if (volumeAtLevel <= 0 || !Number.isFinite(cvdAtLevel)) {
    return 'INSUFFICIENT_DATA';
  }

  // Absorption requires high volume and large lots
  if (!largeLotDominated) return 'NO_ABSORPTION';

  // Significant volume but minimal price move = absorption
  const volumePerPoint = volumeAtLevel / (Math.abs(priceMove) || 1);
  if (volumePerPoint < 100) return 'NO_ABSORPTION'; // heuristic: needs concentration

  // CVD direction tells us which side absorbed
  if (cvdAtLevel < -volumeAtLevel * 0.3) {
    // Heavy selling absorbed (buy absorption)
    return 'ABSORPTION_BUY';
  }
  if (cvdAtLevel > volumeAtLevel * 0.3) {
    // Heavy buying absorbed (sell absorption)
    return 'ABSORPTION_SELL';
  }

  return 'NO_ABSORPTION';
}

// ── Cross-Market Lead-Lag ─────────────────────────────────────────────

export interface CrossMarketTick {
  /** Market identifier (e.g. 'NIFTY50', 'BANKNIFTY', 'SPX'). */
  readonly market: string;
  /** Epoch-ms timestamp. */
  readonly tsMs: number;
  /** Price change from previous tick (percentage or points). */
  readonly delta: number;
}

export interface LeadLagResult {
  /** Which market led the move. */
  readonly leader: string;
  /** Which market lagged. */
  readonly lagger: string;
  /** Lag in milliseconds. */
  readonly lagMs: number;
  /** Correlation of the lead-lag relationship (0-1). */
  readonly correlation: number;
  /** Confidence in the lead-lag detection. */
  readonly confidence: number;
}

/**
 * Detect lead-lag relationship between two markets.
 *
 * Uses time-delayed cross-correlation to identify which market
 * consistently leads price moves and which lags.
 *
 * Deterministic: same inputs → same result, always.
 */
export function detectLeadLag(
  ticksA: readonly CrossMarketTick[],
  ticksB: readonly CrossMarketTick[],
  maxLagMs: number = 5 * 60_000, // 5 minutes default
): LeadLagResult | null {
  if (ticksA.length < 10 || ticksB.length < 10) return null;

  // Find overlapping time range
  const aStart = ticksA[0].tsMs;
  const aEnd = ticksA[ticksA.length - 1].tsMs;
  const bStart = ticksB[0].tsMs;
  const bEnd = ticksB[ticksB.length - 1].tsMs;
  const overlapStart = Math.max(aStart, bStart);
  const overlapEnd = Math.min(aEnd, bEnd);
  if (overlapEnd - overlapStart < maxLagMs * 2) return null;

  // Bucket into 1-minute intervals
  const bucketMs = 60_000;
  const bucketA = new Map<number, number>();
  const bucketB = new Map<number, number>();

  for (const t of ticksA) {
    const key = Math.floor((t.tsMs - overlapStart) / bucketMs);
    bucketA.set(key, (bucketA.get(key) ?? 0) + t.delta);
  }
  for (const t of ticksB) {
    const key = Math.floor((t.tsMs - overlapStart) / bucketMs);
    bucketB.set(key, (bucketB.get(key) ?? 0) + t.delta);
  }

  // Test lagged correlation: does A lead B by lag buckets? Does B lead A?
  const maxLagBuckets = Math.ceil(maxLagMs / bucketMs);
  const allKeys = Array.from(new Set([...Array.from(bucketA.keys()), ...Array.from(bucketB.keys())])).sort((a, b) => a - b);

  let bestCorrAtoB = -1;
  let bestLagAtoB = 0;
  let bestCorrBtoA = -1;
  let bestLagBtoA = 0;

  for (let lag = 0; lag <= maxLagBuckets; lag++) {
    const corrAB = laggedCorrelation(bucketA, bucketB, allKeys, lag);
    const corrBA = laggedCorrelation(bucketB, bucketA, allKeys, lag);
    if (corrAB > bestCorrAtoB) { bestCorrAtoB = corrAB; bestLagAtoB = lag; }
    if (corrBA > bestCorrBtoA) { bestCorrBtoA = corrBA; bestLagBtoA = lag; }
  }

  const marketA = ticksA[0].market;
  const marketB = ticksB[0].market;

  if (bestCorrAtoB > bestCorrBtoA && bestLagAtoB > 0) {
    return {
      leader: marketA, lagger: marketB,
      lagMs: bestLagAtoB * bucketMs,
      correlation: bestCorrAtoB,
      confidence: Math.min(1, bestCorrAtoB * (allKeys.length / 30)),
    };
  }
  if (bestCorrBtoA > bestCorrAtoB && bestLagBtoA > 0) {
    return {
      leader: marketB, lagger: marketA,
      lagMs: bestLagBtoA * bucketMs,
      correlation: bestCorrBtoA,
      confidence: Math.min(1, bestCorrBtoA * (allKeys.length / 30)),
    };
  }

  return null; // No clear lead-lag detected
}

/** Compute Pearson correlation between two bucketed series with a time lag. */
function laggedCorrelation(
  a: Map<number, number>, b: Map<number, number>,
  keys: readonly number[], lag: number,
): number {
  const pairs: [number, number][] = [];
  for (const k of keys) {
    const va = a.get(k);
    const vb = b.get(k + lag);
    if (va !== undefined && vb !== undefined) pairs.push([va, vb]);
  }
  if (pairs.length < 5) return 0;
  return pearson(pairs);
}

function pearson(pairs: readonly [number, number][]): number {
  const n = pairs.length;
  let sx = 0, sy = 0, sxy = 0, sx2 = 0, sy2 = 0;
  for (const [x, y] of pairs) {
    sx += x; sy += y; sxy += x * y; sx2 += x * x; sy2 += y * y;
  }
  const denom = Math.sqrt((n * sx2 - sx * sx) * (n * sy2 - sy * sy));
  return denom > 0 ? (n * sxy - sx * sy) / denom : 0;
}
