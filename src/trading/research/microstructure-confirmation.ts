/**
 * ITEM 46 — Microstructure confirmation for gap engine.
 *
 * doneWhen: "can run in research/shadow mode without changing production."
 *
 * PURE: no clock, no I/O, no DB, no network, no randomness.
 * RESEARCH / SHADOW ONLY: nothing in production imports this module.
 *
 * Purpose: After the event gate passes, confirm the gap move via
 * microstructure signals — volume profile, order-flow imbalance (OFI),
 * bid-ask spread dynamics, and trade aggressor imbalance.
 *
 * A gap that passes the event gate but fails microstructure confirmation
 * is a gap that looks good on headlines but lacks follow-through conviction.
 */

// ── Types ─────────────────────────────────────────────────────────────

export const MICRO_CONFIRM_VERSION = 'microconf-v1';

export interface MicrostructureSnapshot {
  /** Volume-weighted average price in the observation window. */
  readonly vwap: number;
  /** Total volume in the window. */
  readonly totalVolume: number;
  /** Volume on the buy (ask-hit) side. */
  readonly buyVolume: number;
  /** Volume on the sell (bid-hit) side. */
  readonly sellVolume: number;
  /** Average bid-ask spread in index points. */
  readonly avgSpread: number;
  /** Spread at the start of the window. */
  readonly initialSpread: number;
  /** Spread at the end of the window. */
  readonly finalSpread: number;
  /** Number of large trades (above sizeThreshold). */
  readonly largeTradeCount: number;
  /** Number of small trades (below sizeThreshold). */
  readonly smallTradeCount: number;
}

export interface MicroConfirmInput {
  /** The gap direction: positive = UP gap. */
  readonly gapSize: number;
  /** Open price of the session. */
  readonly open: number;
  /** VWAP reference (prev session VWAP or anchor). */
  readonly referenceVwap: number | null;
  /** Microstructure data in the early window. */
  readonly micro: MicrostructureSnapshot;
}

export interface MicroConfirmConfig {
  /** Minimum buy/sell ratio to confirm UP gap (default 1.2). */
  readonly buyRatioThreshold: number;
  /** Minimum sell/buy ratio to confirm DOWN gap (default 1.2). */
  readonly sellRatioThreshold: number;
  /** Maximum spread contraction ratio to confirm (final/initial, default 1.0 = no widening). */
  readonly maxSpreadWidening: number;
  /** Minimum volume to consider the snapshot valid. */
  readonly minVolume: number;
  /** Minimum large-trade fraction to confirm conviction (0-1). */
  readonly minLargeTradeFraction: number;
}

export const MICRO_CONFIRM_REFUSALS = [
  'NO_MICRO_DATA',
  'INSUFFICIENT_VOLUME',
  'VOLUME_IMBALANCE_CONTRADICTS',
  'SPREAD_WIDENING',
  'LACKS_LARGE_TRADE_CONVICTION',
] as const;
export type MicroConfirmRefusal = (typeof MICRO_CONFIRM_REFUSALS)[number];

export type MicroConfirmVerdict =
  | { readonly pass: true; readonly version: string; readonly signals: MicroSignals }
  | { readonly pass: false; readonly version: string; readonly reason: MicroConfirmRefusal };

export interface MicroSignals {
  readonly buySellRatio: number;
  readonly spreadTrend: 'CONTRACTING' | 'WIDENING' | 'FLAT';
  readonly largeTradeFraction: number;
  readonly vwapAlignment: 'WITH_GAP' | 'AGAINST_GAP' | 'NEUTRAL';
}

const DEFAULT_CONFIG: MicroConfirmConfig = {
  buyRatioThreshold: 1.2,
  sellRatioThreshold: 1.2,
  maxSpreadWidening: 1.0,
  minVolume: 100,
  minLargeTradeFraction: 0.15,
};

// ── Core gate ─────────────────────────────────────────────────────────

/**
 * Confirm a gap via microstructure signals.
 *
 * Checks:
 *  1. Volume exists and is sufficient.
 *  2. Buy/sell volume ratio aligns with gap direction.
 *  3. Spread is not widening (sign of institutional stepping back).
 *  4. Large-trade fraction shows conviction.
 *
 * PASS = all checks pass. FAIL = first failing check.
 * Deterministic: same inputs → same verdict, always.
 */
export function assessMicrostructureConfirmation(
  input: MicroConfirmInput,
  config: MicroConfirmConfig = DEFAULT_CONFIG,
): MicroConfirmVerdict {
  const { micro, gapSize } = input;

  // 1. Volume check
  if (micro.totalVolume < config.minVolume) {
    return { pass: false, version: MICRO_CONFIRM_VERSION, reason: 'INSUFFICIENT_VOLUME' };
  }

  // 2. Buy/sell ratio
  const buyRatio = micro.sellVolume > 0 ? micro.buyVolume / micro.sellVolume : Infinity;
  const sellRatio = micro.buyVolume > 0 ? micro.sellVolume / micro.buyVolume : Infinity;
  const isUpGap = gapSize > 0;

  if (isUpGap && buyRatio < config.buyRatioThreshold) {
    return { pass: false, version: MICRO_CONFIRM_VERSION, reason: 'VOLUME_IMBALANCE_CONTRADICTS' };
  }
  if (!isUpGap && gapSize < 0 && sellRatio < config.sellRatioThreshold) {
    return { pass: false, version: MICRO_CONFIRM_VERSION, reason: 'VOLUME_IMBALANCE_CONTRADICTS' };
  }

  // 3. Spread trend
  const spreadRatio = micro.initialSpread > 0 ? micro.finalSpread / micro.initialSpread : 1;
  if (spreadRatio > config.maxSpreadWidening) {
    return { pass: false, version: MICRO_CONFIRM_VERSION, reason: 'SPREAD_WIDENING' };
  }

  // 4. Large trade conviction
  const totalTrades = micro.largeTradeCount + micro.smallTradeCount;
  const largeFraction = totalTrades > 0 ? micro.largeTradeCount / totalTrades : 0;
  if (largeFraction < config.minLargeTradeFraction) {
    return { pass: false, version: MICRO_CONFIRM_VERSION, reason: 'LACKS_LARGE_TRADE_CONVICTION' };
  }

  // Build signal summary
  const spreadTrend: MicroSignals['spreadTrend'] =
    spreadRatio < 0.9 ? 'CONTRACTING' : spreadRatio > 1.1 ? 'WIDENING' : 'FLAT';

  let vwapAlignment: MicroSignals['vwapAlignment'] = 'NEUTRAL';
  if (input.referenceVwap !== null) {
    const vwapMoved = micro.vwap - input.referenceVwap;
    if (isUpGap && vwapMoved > 0) vwapAlignment = 'WITH_GAP';
    else if (!isUpGap && vwapMoved < 0) vwapAlignment = 'WITH_GAP';
    else if (vwapMoved !== 0) vwapAlignment = 'AGAINST_GAP';
  }

  return {
    pass: true,
    version: MICRO_CONFIRM_VERSION,
    signals: {
      buySellRatio: isUpGap ? buyRatio : sellRatio,
      spreadTrend,
      largeTradeFraction: largeFraction,
      vwapAlignment,
    },
  };
}
