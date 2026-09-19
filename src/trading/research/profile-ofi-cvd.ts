/**
 * ITEM 65 — Combine profile structure with OFI/CVD.
 *
 * doneWhen: "reviewer can determine what it does and replay/test demonstrates behavior."
 *
 * PURE: no clock, no I/O, no DB, no network, no randomness.
 * RESEARCH / SHADOW ONLY: nothing in production imports this module.
 *
 * Purpose: Combine the market profile structure (POC, VAH, VAL, IB range)
 * with Order Flow Imbalance (OFI) and CVD signals to produce a composite
 * conviction score. A profile level that aligns with OFI direction and
 * CVD slope receives higher conviction than one where they conflict.
 */

// ── Types ─────────────────────────────────────────────────────────────

export const PROFILE_OFI_CVD_VERSION = 'prof-ofi-cvd-v1';

export interface ProfileStructure {
  /** Point of Control: the strike/price with highest traded volume. */
  readonly poc: number;
  /** Value Area High: upper boundary of the 70% volume range. */
  readonly vah: number;
  /** Value Area Low: lower boundary of the 70% volume range. */
  readonly val: number;
  /** Initial Balance range (first hour high − first hour low). */
  readonly ibHigh: number;
  readonly ibLow: number;
  /** Session open price. */
  readonly open: number;
  /** Previous session POC. */
  readonly prevPoc: number | null;
}

export interface OfiSnapshot {
  /** Order Flow Imbalance: (buyFlow − sellFlow) / (buyFlow + sellFlow). Range [-1, 1]. */
  readonly ofi: number;
  /** Volume-weighted OFI (weighted by trade size). */
  readonly vwOfi: number;
  /** Delta OI at the current price level (positive = new longs). */
  readonly deltaOi: number;
}

export interface CvdSnapshot {
  /** CVD slope (contracts per ms). */
  readonly slope: number;
  /** Net aggression score [-1, 1]. */
  readonly netAggression: number;
}

export interface ProfileOfiCvdInput {
  readonly profile: ProfileStructure;
  readonly ofi: OfiSnapshot;
  readonly cvd: CvdSnapshot;
  /** Current price (spot or LTP). */
  readonly currentPrice: number;
}

export interface CompositeScore {
  /** Profile component: where is price relative to value area. */
  readonly profileScore: number;
  /** OFI component: order flow direction. */
  readonly ofiScore: number;
  /** CVD component: volume delta direction and aggression. */
  readonly cvdScore: number;
  /** Combined conviction [-1, 1]. */
  readonly combined: number;
  /** Classification. */
  readonly signal: 'BULLISH_CONVICTED' | 'BEARISH_CONVICTED' | 'BULLISH_WEAK' | 'BEARISH_WEAK' | 'NEUTRAL';
}

// ── Profile position scorer ───────────────────────────────────────────

/**
 * Score price position within the profile structure.
 * Returns [-1, 1]: positive = above value area (bullish), negative = below.
 */
function profilePositionScore(profile: ProfileStructure, price: number): number {
  const vaRange = profile.vah - profile.val;
  if (vaRange <= 0) return 0;

  if (price >= profile.vah) {
    // Above value area — bullish, score scales with distance
    const dist = (price - profile.vah) / vaRange;
    return Math.min(1, 0.5 + dist * 0.5);
  }
  if (price <= profile.val) {
    // Below value area — bearish
    const dist = (profile.val - price) / vaRange;
    return Math.max(-1, -0.5 - dist * 0.5);
  }

  // Inside value area — neutral, slightly directional based on POC proximity
  const pocRelative = (price - profile.poc) / vaRange;
  return pocRelative * 0.4; // [-0.2, 0.2]
}

// ── Core computation ──────────────────────────────────────────────────

/**
 * Compute composite conviction from profile + OFI + CVD.
 *
 * Each component is scored [-1, 1], then combined with weights:
 *   profile: 0.35, OFI: 0.35, CVD: 0.30
 *
 * Deterministic: same inputs → same score, always.
 */
export function computeProfileOfiCvdComposite(input: ProfileOfiCvdInput): CompositeScore {
  const { profile, ofi, cvd, currentPrice } = input;

  // Profile score
  const profileScore = profilePositionScore(profile, currentPrice);

  // OFI score: direct mapping, clamped
  const ofiScore = Math.max(-1, Math.min(1, ofi.vwOfi));

  // CVD score: combine slope direction with aggression
  const slopeSignal = cvd.slope > 0 ? 1 : cvd.slope < 0 ? -1 : 0;
  const aggressionSignal = cvd.netAggression;
  const cvdScore = Math.max(-1, Math.min(1, slopeSignal * 0.6 + aggressionSignal * 0.4));

  // Weighted combination
  const combined = profileScore * 0.35 + ofiScore * 0.35 + cvdScore * 0.30;

  // Classify
  let signal: CompositeScore['signal'];
  if (combined > 0.3) signal = 'BULLISH_CONVICTED';
  else if (combined > 0.1) signal = 'BULLISH_WEAK';
  else if (combined < -0.3) signal = 'BEARISH_CONVICTED';
  else if (combined < -0.1) signal = 'BEARISH_WEAK';
  else signal = 'NEUTRAL';

  return { profileScore, ofiScore, cvdScore, combined, signal };
}
