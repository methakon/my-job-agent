/**
 * P0 Features — core quantitative features for pattern detection.
 *
 * Implements: GapPct, GapATR, VWAP, ATR, RelativeVolume, ORB, Breadth.
 * All functions are PURE: no I/O, no DB, no side effects.
 *
 * References:
 *   - Gap analysis: opening gap vs ATR normalization
 *   - VWAP: standard volume-weighted average price
 *   - ATR: Wilder's Average True Range
 *   - RelativeVolume: volume ratio vs N-period average
 *   - ORB: Opening Range Breakout (first N minutes high/low)
 *   - Breadth: advance/decline ratio for market breadth
 */

export type Bar = {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type Tick = {
  ts: number;
  price: number;
  volume: number;
};

export type GapResult = {
  gapPct: number;        // percentage gap
  gapATR: number;        // gap normalized by ATR (dimensionless)
  direction: 'UP' | 'DOWN' | 'FLAT';
};

export type VwapResult = {
  vwap: number;
  cumulativeVolume: number;
  cumulativeVolumePrice: number;
};

export type AtrResult = {
  atr: number;
  period: number;
  trueRanges: number[];
};

export type OrbResult = {
  orbHigh: number;
  orbLow: number;
  rangeSize: number;
  upperBand: number;     // orbHigh (breakout level)
  lowerBand: number;     // orbLow (breakdown level)
  barsInOR: number;      // how many bars fell within the opening range window
};

export type BreadthResult = {
  advancing: number;
  declining: number;
  unchanged: number;
  ratio: number;           // advancing / declining (0 if declining === 0)
  advanceDeclineLine: number; // cumulative A-D line value
  normalized: number;      // (advancing - declining) / total  ∈ [-1, 1]
};

// ─────────────────────────────────────────────────────────────────────
// 1. GAP PCT & GAP ATR
// ─────────────────────────────────────────────────────────────────────

/**
 * Compute opening gap as a percentage and normalized by ATR.
 * @param currentOpen   today's opening price
 * @param previousClose yesterday's closing price
 * @param atr           current ATR value (use computeAtr if needed)
 */
export function computeGap(
  currentOpen: number,
  previousClose: number,
  atr: number,
): GapResult {
  if (previousClose <= 0 || !isFinite(previousClose)) {
    return { gapPct: 0, gapATR: 0, direction: 'FLAT' };
  }

  const gapPct = ((currentOpen - previousClose) / previousClose) * 100;
  const gapATR = atr > 0 && isFinite(atr) ? ((currentOpen - previousClose) / atr) : 0;

  const direction: GapResult['direction'] =
    Math.abs(gapPct) < 0.01 ? 'FLAT' : gapPct > 0 ? 'UP' : 'DOWN';

  return { gapPct, gapATR, direction };
}

// ─────────────────────────────────────────────────────────────────────
// 2. VWAP (Volume-Weighted Average Price)
// ─────────────────────────────────────────────────────────────────────

/**
 * Compute VWAP from tick data (or bars, using typical price).
 * For bars, uses (high + low + close) / 3 as the representative price.
 */
export function computeVwap(ticks: Tick[]): VwapResult {
  if (ticks.length === 0) {
    return { vwap: 0, cumulativeVolume: 0, cumulativeVolumePrice: 0 };
  }

  let cumVP = 0;
  let cumV = 0;

  for (const t of ticks) {
    if (t.volume > 0 && isFinite(t.price) && isFinite(t.volume)) {
      cumVP += t.price * t.volume;
      cumV += t.volume;
    }
  }

  return {
    vwap: cumV > 0 ? cumVP / cumV : 0,
    cumulativeVolume: cumV,
    cumulativeVolumePrice: cumVP,
  };
}

/**
 * Compute intraday VWAP from bars (uses typical price as proxy for tick price).
 */
export function computeVwapFromBars(bars: Bar[]): VwapResult {
  const ticks: Tick[] = bars.map(b => ({
    ts: b.ts,
    price: (b.high + b.low + b.close) / 3,
    volume: b.volume,
  }));
  return computeVwap(ticks);
}

// ─────────────────────────────────────────────────────────────────────
// 3. ATR (Average True Range) — Wilder's smoothing
// ─────────────────────────────────────────────────────────────────────

/**
 * Compute ATR using Wilder's smoothing method.
 * @param bars    OHLCV bars in chronological order
 * @param period  ATR period (default: 14)
 */
export function computeAtr(bars: Bar[], period: number = 14): AtrResult {
  if (bars.length < 2) {
    return { atr: 0, period, trueRanges: [] };
  }

  const trueRanges: number[] = [];

  for (let i = 1; i < bars.length; i++) {
    const high = bars[i].high;
    const low = bars[i].low;
    const prevClose = bars[i - 1].close;
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    trueRanges.push(tr);
  }

  if (trueRanges.length < period) {
    // Not enough data for full ATR — use simple average of available TRs
    const avg = trueRanges.reduce((a, b) => a + b, 0) / trueRanges.length;
    return { atr: avg, period, trueRanges };
  }

  // Wilder's smoothing: first ATR is simple average, then smoothed
  let atr = trueRanges.slice(0, period).reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < trueRanges.length; i++) {
    atr = (atr * (period - 1) + trueRanges[i]) / period;
  }

  return { atr, period, trueRanges };
}

// ─────────────────────────────────────────────────────────────────────
// 4. RELATIVE VOLUME
// ─────────────────────────────────────────────────────────────────────

/**
 * Compute relative volume = current volume / average volume over N periods.
 * @param bars        OHLCV bars in chronological order
 * @param avgPeriod   lookback period for average (default: 20)
 */
export function computeRelativeVolume(bars: Bar[], avgPeriod: number = 20): number {
  if (bars.length < 2) return 0;

  const currentVol = bars[bars.length - 1].volume;
  const lookback = Math.min(avgPeriod, bars.length - 1);
  const recentBars = bars.slice(bars.length - 1 - lookback, bars.length - 1);

  const avgVol = recentBars.reduce((s, b) => s + b.volume, 0) / lookback;

  return avgVol > 0 ? currentVol / avgVol : 0;
}

// ─────────────────────────────────────────────────────────────────────
// 5. ORB (Opening Range Breakout)
// ─────────────────────────────────────────────────────────────────────

/**
 * Compute Opening Range Breakout levels from bars.
 * The opening range is defined by the first `orbMinutes` worth of bars
 * (or first N bars if no minute data).
 *
 * @param bars       OHLCV bars sorted by timestamp ascending
 * @param orbBars    number of bars in the opening range window (default: 5)
 */
export function computeOrb(bars: Bar[], orbBars: number = 5): OrbResult {
  if (bars.length === 0) {
    return { orbHigh: 0, orbLow: 0, rangeSize: 0, upperBand: 0, lowerBand: 0, barsInOR: 0 };
  }

  const orBars = bars.slice(0, Math.min(orbBars, bars.length));

  let orbHigh = -Infinity;
  let orbLow = Infinity;

  for (const b of orBars) {
    if (b.high > orbHigh) orbHigh = b.high;
    if (b.low < orbLow) orbLow = b.low;
  }

  if (!isFinite(orbHigh) || !isFinite(orbLow)) {
    return { orbHigh: 0, orbLow: 0, rangeSize: 0, upperBand: 0, lowerBand: 0, barsInOR: 0 };
  }

  return {
    orbHigh,
    orbLow,
    rangeSize: orbHigh - orbLow,
    upperBand: orbHigh,
    lowerBand: orbLow,
    barsInOR: orBars.length,
  };
}

// ─────────────────────────────────────────────────────────────────────
// 6. BREADTH (Advance/Decline)
// ─────────────────────────────────────────────────────────────────────

/**
 * Compute market breadth from a set of instruments' current and previous closes.
 * @param instruments  array of { currentClose, previousClose } per instrument
 */
export type BreadthInput = {
  currentClose: number;
  previousClose: number;
};

export function computeBreadth(instruments: BreadthInput[]): BreadthResult {
  const ZERO: BreadthResult = {
    advancing: 0,
    declining: 0,
    unchanged: 0,
    ratio: 0,
    advanceDeclineLine: 0,
    normalized: 0,
  };

  if (instruments.length === 0) return ZERO;

  let advancing = 0;
  let declining = 0;
  let unchanged = 0;

  for (const inst of instruments) {
    if (inst.previousClose <= 0) continue;
    const diff = inst.currentClose - inst.previousClose;
    if (diff > 0.001) advancing++;
    else if (diff < -0.001) declining++;
    else unchanged++;
  }

  const total = advancing + declining;
  const ratio = declining > 0 ? advancing / declining : advancing > 0 ? Infinity : 0;
  const allTotal = advancing + declining + unchanged;
  const normalized = allTotal > 0 ? (advancing - declining) / allTotal : 0;

  return {
    advancing,
    declining,
    unchanged,
    ratio: isFinite(ratio) ? ratio : 0,
    advanceDeclineLine: advancing - declining,
    normalized,
  };
}
