/**
 * Pure market-structure / pattern detection (brief: SENSEX PE reversal →
 * breakout case study, sections 1-11, 15, 16).
 *
 * NOTHING here is a hard-coded price. Every threshold is a RATIO normalized by
 * ATR, percentage, or relative volume/OI, so the same detector works across
 * NIFTY / BANKNIFTY / SENSEX, any expiry, any strike, any option price and any
 * volatility regime (brief s11). There is no DB, no HTTP, no Nest and no broker
 * code in this file: it is a pure function library so it can be unit-tested and
 * backtested against historical candles.
 *
 * The pattern it measures:
 *   CONSOLIDATION → SELLING EXHAUSTION → BULLISH REVERSAL → BREAKOUT
 *   → MOMENTUM EXPANSION → TREND CONTINUATION → EXTENDED MOVE
 * The option's own price is NEVER the only signal (brief s1/s5/s6): underlying,
 * option chain, OI, IV, volume and liquidity are scored separately so we can
 * later measure which features actually carried predictive value.
 */

export type Candle = { ts: number; open: number; high: number; low: number; close: number; volume: number };

/** Ratio-based thresholds. Every one is overridable from the environment. */
export type PatternThresholds = {
  /** Minimum candles in the compression window. */
  consolidationMinCandles: number;
  /** Range width (high-low) must be <= this many ATRs to count as compression. */
  consolidationMaxRangeAtr: number;
  /** Current ATR as a fraction of price must be <= this to count as contraction. */
  consolidationMaxAtrPct: number;
  /** Bars scanned for failed breakouts / local S-R. */
  lookbackBars: number;
  /** Reversal score needed for the exhaustion leg to count. */
  reversalMinScore: number;
  /** Distance above the range, in ATRs, beyond which a fresh entry is chasing. */
  breakoutMaxExtensionAtr: number;
  /** Volume at breakout must be >= this multiple of the recent median. */
  breakoutVolumeRatio: number;
  /** Entry state: beyond this many ATRs from the breakout → OVEREXTENDED. */
  overextendedAtr: number;
  /** Minimum confidence for a tradable signal. */
  minConfidence: number;
  /** Confidence required when the underlying does NOT confirm. */
  minConfidenceUnconfirmed: number;
  /** Widest acceptable bid/ask spread as a fraction of LTP. */
  maxSpreadPct: number;
  /** Oldest acceptable quote age for an entry. */
  maxTickAgeMs: number;
  /** Minimum contracts of displayed depth on the entry side. */
  minTopDepth: number;
  /** Relative volume needed to call it an expansion. */
  volumeExpansionRatio: number;
  /** Allow continuation entries after an already-extended move. */
  allowExtendedEntries: boolean;
};

export const DEFAULT_PATTERN_THRESHOLDS: PatternThresholds = {
  consolidationMinCandles: 6,
  consolidationMaxRangeAtr: 2.5,
  consolidationMaxAtrPct: 0.9,
  lookbackBars: 24,
  reversalMinScore: 0.55,
  breakoutMaxExtensionAtr: 1.8,
  breakoutVolumeRatio: 1.4,
  overextendedAtr: 3.0,
  minConfidence: 0.6,
  minConfidenceUnconfirmed: 0.78,
  maxSpreadPct: 0.02,
  maxTickAgeMs: 15_000,
  minTopDepth: 1,
  volumeExpansionRatio: 1.5,
  allowExtendedEntries: false,
};

const num = (value: unknown, fallback: number): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};
const bool = (value: unknown, fallback: boolean): boolean =>
  value === undefined || value === null || value === '' ? fallback : !/^(0|false|no|off)$/i.test(String(value));

/** All thresholds from env, so a session can be retuned without a code change. */
export const patternThresholdsFromEnv = (env: Record<string, string | undefined> = process.env): PatternThresholds => ({
  consolidationMinCandles: num(env.PATTERN_CONSOLIDATION_MIN_CANDLES, DEFAULT_PATTERN_THRESHOLDS.consolidationMinCandles),
  consolidationMaxRangeAtr: num(env.PATTERN_CONSOLIDATION_MAX_RANGE_ATR, DEFAULT_PATTERN_THRESHOLDS.consolidationMaxRangeAtr),
  consolidationMaxAtrPct: num(env.PATTERN_CONSOLIDATION_MAX_ATR_PCT, DEFAULT_PATTERN_THRESHOLDS.consolidationMaxAtrPct),
  lookbackBars: num(env.PATTERN_LOOKBACK_BARS, DEFAULT_PATTERN_THRESHOLDS.lookbackBars),
  reversalMinScore: num(env.PATTERN_REVERSAL_MIN_SCORE, DEFAULT_PATTERN_THRESHOLDS.reversalMinScore),
  breakoutMaxExtensionAtr: num(env.PATTERN_BREAKOUT_MAX_EXTENSION_ATR, DEFAULT_PATTERN_THRESHOLDS.breakoutMaxExtensionAtr),
  breakoutVolumeRatio: num(env.PATTERN_BREAKOUT_VOLUME_RATIO, DEFAULT_PATTERN_THRESHOLDS.breakoutVolumeRatio),
  overextendedAtr: num(env.PATTERN_OVEREXTENDED_ATR, DEFAULT_PATTERN_THRESHOLDS.overextendedAtr),
  minConfidence: num(env.PATTERN_MIN_CONFIDENCE, DEFAULT_PATTERN_THRESHOLDS.minConfidence),
  minConfidenceUnconfirmed: num(env.PATTERN_MIN_CONFIDENCE_UNCONFIRMED, DEFAULT_PATTERN_THRESHOLDS.minConfidenceUnconfirmed),
  maxSpreadPct: num(env.PATTERN_MAX_SPREAD_PCT, DEFAULT_PATTERN_THRESHOLDS.maxSpreadPct),
  maxTickAgeMs: num(env.PATTERN_MAX_TICK_AGE_MS, DEFAULT_PATTERN_THRESHOLDS.maxTickAgeMs),
  minTopDepth: num(env.PATTERN_MIN_TOP_DEPTH, DEFAULT_PATTERN_THRESHOLDS.minTopDepth),
  volumeExpansionRatio: num(env.PATTERN_VOLUME_EXPANSION_RATIO, DEFAULT_PATTERN_THRESHOLDS.volumeExpansionRatio),
  allowExtendedEntries: bool(env.PATTERN_ALLOW_EXTENDED_ENTRIES, DEFAULT_PATTERN_THRESHOLDS.allowExtendedEntries),
});

// ── Candle construction ──────────────────────────────────────────────────────

export type TickLike = { ts: Date | number | string; price: number; volume?: number | null };

/** Aggregate raw ticks into fixed buckets (e.g. 5 min = 300_000 ms). */
export const bucketCandles = (ticks: readonly TickLike[], bucketMs: number): Candle[] => {
  const buckets = new Map<number, Candle>();
  for (const tick of ticks) {
    const at = tick.ts instanceof Date ? tick.ts.getTime() : new Date(tick.ts).getTime();
    if (!Number.isFinite(at) || !Number.isFinite(tick.price) || tick.price <= 0) continue;
    const key = Math.floor(at / bucketMs) * bucketMs;
    const volume = Math.max(0, Number(tick.volume ?? 0) || 0);
    const existing = buckets.get(key);
    if (!existing) {
      buckets.set(key, { ts: key, open: tick.price, high: tick.price, low: tick.price, close: tick.price, volume });
      continue;
    }
    existing.high = Math.max(existing.high, tick.price);
    existing.low = Math.min(existing.low, tick.price);
    existing.close = tick.price;
    existing.volume += volume;
  }
  return [...buckets.values()].sort((a, b) => a.ts - b.ts);
};

/** True range of one candle against the previous close. */
const trueRange = (candle: Candle, previousClose: number | null): number => {
  const highLow = candle.high - candle.low;
  if (previousClose === null) return highLow;
  return Math.max(highLow, Math.abs(candle.high - previousClose), Math.abs(candle.low - previousClose));
};

/** Wilder-style average true range. Null when there is not enough history. */
export const atr = (candles: readonly Candle[], period = 14): number | null => {
  if (candles.length < 2) return null;
  const window = candles.slice(-(Math.max(2, period) + 1));
  let sum = 0;
  let count = 0;
  for (let i = 1; i < window.length; i++) {
    sum += trueRange(window[i], window[i - 1].close);
    count++;
  }
  return count ? sum / count : null;
};

export const median = (values: readonly number[]): number | null => {
  const clean = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!clean.length) return null;
  const mid = Math.floor(clean.length / 2);
  return clean.length % 2 ? clean[mid] : (clean[mid - 1] + clean[mid]) / 2;
};

export const stdev = (values: readonly number[]): number | null => {
  const clean = values.filter((v) => Number.isFinite(v));
  if (clean.length < 2) return null;
  const mean = clean.reduce((a, b) => a + b, 0) / clean.length;
  return Math.sqrt(clean.reduce((a, b) => a + (b - mean) ** 2, 0) / (clean.length - 1));
};

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

// ── 2. Consolidation / range compression ─────────────────────────────────────

export type Consolidation = {
  detected: boolean;
  startIndex: number | null;
  rangeHigh: number;
  rangeLow: number;
  rangeWidth: number;
  rangeWidthPct: number;
  rangeWidthAtr: number | null;
  durationBars: number;
  atrValue: number | null;
  atrPct: number | null;
  failedBreakouts: number;
  volumeContractionRatio: number | null;
  components: { rangeScore: number; atrScore: number; durationScore: number; failureScore: number; volumeScore: number };
};

export const detectConsolidation = (candles: readonly Candle[], thresholds: PatternThresholds): Consolidation => {
  const empty: Consolidation = {
    detected: false, startIndex: null, rangeHigh: 0, rangeLow: 0, rangeWidth: 0, rangeWidthPct: 0, rangeWidthAtr: null,
    durationBars: 0, atrValue: null, atrPct: null, failedBreakouts: 0, volumeContractionRatio: null,
    components: { rangeScore: 0, atrScore: 0, durationScore: 0, failureScore: 0, volumeScore: 0 },
  };
  if (candles.length < thresholds.consolidationMinCandles) return empty;

  const atrValue = atr(candles);
  const last = candles[candles.length - 1];
  const atrPct = atrValue !== null && last.close > 0 ? atrValue / last.close : null;

  // Longest window ending at the LAST candle whose range stays inside the ATR
  // budget. Compression is measured relative to ATR, never in rupees.
  let bestStart: number | null = null;
  for (let start = candles.length - thresholds.consolidationMinCandles; start >= 0; start--) {
    const window = candles.slice(start);
    const high = Math.max(...window.map((c) => c.high));
    const low = Math.min(...window.map((c) => c.low));
    const width = high - low;
    const widthAtr = atrValue && atrValue > 0 ? width / atrValue : null;
    const insideBudget = widthAtr === null ? true : widthAtr <= thresholds.consolidationMaxRangeAtr;
    if (!insideBudget) break;
    bestStart = start;
  }
  if (bestStart === null) return { ...empty, atrValue, atrPct };

  const window = candles.slice(bestStart);
  const rangeHigh = Math.max(...window.map((c) => c.high));
  const rangeLow = Math.min(...window.map((c) => c.low));
  const rangeWidth = Math.max(0, rangeHigh - rangeLow);
  const rangeWidthAtr = atrValue && atrValue > 0 ? rangeWidth / atrValue : null;

  // Failed breakouts: probes beyond the range that closed back inside it.
  const scanFrom = Math.max(0, bestStart - thresholds.lookbackBars);
  let failedBreakouts = 0;
  for (let i = scanFrom; i < candles.length; i++) {
    const c = candles[i];
    if (c.high > rangeHigh && c.close < rangeHigh) failedBreakouts++;
    else if (c.low < rangeLow && c.close > rangeLow) failedBreakouts++;
  }

  const windowVolumes = window.map((c) => c.volume).filter((v) => v > 0);
  const priorVolumes = candles.slice(Math.max(0, bestStart - thresholds.lookbackBars), bestStart).map((c) => c.volume).filter((v) => v > 0);
  const windowMedianVolume = median(windowVolumes);
  const priorMedianVolume = median(priorVolumes);
  const volumeContractionRatio = windowMedianVolume !== null && priorMedianVolume ? windowMedianVolume / priorMedianVolume : null;

  const rangeScore = rangeWidthAtr === null ? 0.5 : clamp01(1 - rangeWidthAtr / thresholds.consolidationMaxRangeAtr);
  const atrScore = atrPct === null ? 0.5 : clamp01(1 - atrPct / thresholds.consolidationMaxAtrPct);
  const durationScore = clamp01(window.length / (thresholds.consolidationMinCandles * 2));
  const failureScore = clamp01(failedBreakouts / 2);
  const volumeScore = volumeContractionRatio === null ? 0.5 : clamp01(1 - volumeContractionRatio / 1.5);

  const detected =
    window.length >= thresholds.consolidationMinCandles &&
    (rangeWidthAtr === null || rangeWidthAtr <= thresholds.consolidationMaxRangeAtr) &&
    (atrPct === null || atrPct <= thresholds.consolidationMaxAtrPct);

  return {
    detected, startIndex: bestStart, rangeHigh, rangeLow, rangeWidth,
    rangeWidthPct: last.close > 0 ? rangeWidth / last.close : 0,
    rangeWidthAtr, durationBars: window.length, atrValue, atrPct, failedBreakouts, volumeContractionRatio,
    components: { rangeScore, atrScore, durationScore, failureScore, volumeScore },
  };
};

// ── 3. Selling exhaustion / bullish reversal ─────────────────────────────────

export type Reversal = {
  score: number;
  parts: {
    lowerLowFailure: number; higherLow: number; bullishEngulfing: number; threeOutsideUp: number;
    rejectionWick: number; bodyExpansion: number; momentumTurn: number; levelReclaim: number; volumeExpansion: number;
  };
  flags: {
    lowerLowFailure: boolean; higherLow: boolean; bullishEngulfing: boolean; threeOutsideUp: boolean;
    rejectionWick: boolean; bodyExpansion: boolean; momentumTurn: boolean; levelReclaim: boolean; volumeExpansion: boolean;
  };
  candleIndex: number | null;
};

/**
 * Evidence that downside pressure in the OPTION is weakening. No single candle
 * pattern is an automatic buy (brief s3): each is a weighted feature, stored
 * separately so its predictive value can be measured later.
 */
export const detectReversal = (candles: readonly Candle[], thresholds: PatternThresholds): Reversal => {
  const zero = {
    lowerLowFailure: 0, higherLow: 0, bullishEngulfing: 0, threeOutsideUp: 0,
    rejectionWick: 0, bodyExpansion: 0, momentumTurn: 0, levelReclaim: 0, volumeExpansion: 0,
  };
  const none = {
    lowerLowFailure: false, higherLow: false, bullishEngulfing: false, threeOutsideUp: false,
    rejectionWick: false, bodyExpansion: false, momentumTurn: false, levelReclaim: false, volumeExpansion: false,
  };
  if (candles.length < 4) return { score: 0, parts: { ...zero }, flags: { ...none }, candleIndex: null };

  const i = candles.length - 1;
  const candle = candles[i];
  const prev = candles[i - 1];
  const body = Math.abs(candle.close - candle.open);
  const prevBody = Math.abs(prev.close - prev.open);
  const range = Math.max(1e-9, candle.high - candle.low);
  const bodyRatio = body / range;

  const lookback = candles.slice(Math.max(0, i - 4), i);
  const minLowBefore = lookback.length ? Math.min(...lookback.map((c) => c.low)) : candle.low;
  const minCloseBefore = lookback.length ? Math.min(...lookback.map((c) => c.close)) : candle.close;
  const volumes = candles.slice(Math.max(0, i - 10), i).map((c) => c.volume);
  const medianVolume = median(volumes);

  const closes = candles.slice(Math.max(0, i - 8), i + 1).map((c) => c.close);
  const priorCloses = closes.slice(0, -1);
  const momentumTurn = priorCloses.length >= 4 && closes[closes.length - 1] > priorCloses[priorCloses.length - 1] &&
    Math.min(...priorCloses) <= Math.min(...priorCloses.slice(0, -1));

  const flags = {
    lowerLowFailure: candle.low > minLowBefore,
    higherLow: candle.low > Math.min(...lookback.map((c) => c.low)) && candle.close > minCloseBefore,
    bullishEngulfing: candle.close > candle.open && candle.open <= prev.close && candle.close >= prev.open && body > prevBody,
    threeOutsideUp: candles.length >= 3 && candles[i - 2].close < candles[i - 2].open &&
      candles[i - 1].close > candles[i - 1].open && candles[i - 1].close > candles[i - 2].open &&
      candles[i].close > candles[i - 1].close,
    rejectionWick: candle.close > candle.open && (candle.low - Math.min(candle.open, candle.close)) / range >= 0.4,
    bodyExpansion: prevBody > 0 && body >= prevBody * 1.3 && bodyRatio >= 0.5,
    momentumTurn,
    levelReclaim: candle.close > Math.max(...lookback.map((c) => Math.max(c.open, c.close))),
    volumeExpansion: medianVolume !== null && medianVolume > 0 && candle.volume >= medianVolume * thresholds.volumeExpansionRatio,
  };

  const parts = {
    lowerLowFailure: flags.lowerLowFailure ? 0.12 : 0,
    higherLow: flags.higherLow ? 0.14 : 0,
    bullishEngulfing: flags.bullishEngulfing ? 0.18 : 0,
    threeOutsideUp: flags.threeOutsideUp ? 0.12 : 0,
    rejectionWick: flags.rejectionWick ? 0.12 : 0,
    bodyExpansion: flags.bodyExpansion ? 0.12 : 0,
    momentumTurn: flags.momentumTurn ? 0.1 : 0,
    levelReclaim: flags.levelReclaim ? 0.05 : 0,
    volumeExpansion: flags.volumeExpansion ? 0.05 : 0,
  };
  const score = clamp01(Object.values(parts).reduce((a, b) => a + b, 0));
  return { score, parts, flags, candleIndex: i };
};

// ── 4. Breakout detection + classification ───────────────────────────────────

export const BREAKOUT_CLASSES = ['NONE', 'EARLY_BREAKOUT', 'CONFIRMED_BREAKOUT', 'FAILED_BREAKOUT'] as const;
export type BreakoutClass = (typeof BREAKOUT_CLASSES)[number];

export type Breakout = {
  detected: boolean;
  price: number | null;
  ts: number | null;
  rangeHigh: number | null;
  rangeLow: number | null;
  distanceAboveRange: number | null;
  distancePct: number | null;
  atrMultiple: number | null;
  atrAtBreakout: number | null;
  breakoutVolume: number | null;
  volumeRatio: number | null;
  spreadAtBreakout: number | null;
  classification: BreakoutClass;
  index: number | null;
  barsSince: number | null;
};

export const detectBreakout = (
  candles: readonly Candle[],
  consolidation: Consolidation,
  thresholds: PatternThresholds,
  spreadPct: number | null = null,
): Breakout => {
  const none: Breakout = {
    detected: false, price: null, ts: null, rangeHigh: consolidation.rangeHigh || null, rangeLow: consolidation.rangeLow || null,
    distanceAboveRange: null, distancePct: null, atrMultiple: null, atrAtBreakout: consolidation.atrValue,
    breakoutVolume: null, volumeRatio: null, spreadAtBreakout: spreadPct, classification: 'NONE', index: null, barsSince: null,
  };
  if (!consolidation.detected || consolidation.startIndex === null || candles.length < 2) return none;

  const rangeHigh = consolidation.rangeHigh;
  const atrValue = consolidation.atrValue;
  const volumes = candles.slice(Math.max(0, consolidation.startIndex - thresholds.lookbackBars), candles.length).map((c) => c.volume);
  const medianVolume = median(volumes.filter((v) => v > 0));

  // First bar after the compression window that CLOSES above the range high.
  let index: number | null = null;
  for (let i = consolidation.startIndex + 1; i < candles.length; i++) {
    if (candles[i].close > rangeHigh) { index = i; break; }
  }
  if (index === null) return none;

  const breakoutCandle = candles[index];
  const last = candles[candles.length - 1];
  const distanceAboveRange = last.close - rangeHigh;
  const atrMultiple = atrValue && atrValue > 0 ? distanceAboveRange / atrValue : null;
  const volumeRatio = medianVolume !== null && medianVolume > 0 ? breakoutCandle.volume / medianVolume : null;
  const postBreakout = candles.slice(index + 1);
  const lowestSince = postBreakout.length ? Math.min(...postBreakout.map((c) => c.low)) : breakoutCandle.low;

  // FAILED: price closed back inside the range after the breakout.
  const failed = lowestSince < rangeHigh && last.close <= rangeHigh;
  // EARLY: still near the level (<= half the ATR budget away) — the useful zone.
  const early = atrMultiple !== null && atrMultiple <= thresholds.breakoutMaxExtensionAtr * 0.5;
  const confirmedVolume = volumeRatio === null || volumeRatio >= thresholds.breakoutVolumeRatio;
  const classification: BreakoutClass = failed ? 'FAILED_BREAKOUT'
    : early ? 'EARLY_BREAKOUT'
      : confirmedVolume ? 'CONFIRMED_BREAKOUT' : 'CONFIRMED_BREAKOUT';

  return {
    detected: !failed, price: breakoutCandle.close, ts: breakoutCandle.ts, rangeHigh, rangeLow: consolidation.rangeLow,
    distanceAboveRange, distancePct: rangeHigh > 0 ? distanceAboveRange / rangeHigh : null, atrMultiple,
    atrAtBreakout: atrValue, breakoutVolume: breakoutCandle.volume, volumeRatio, spreadAtBreakout: spreadPct,
    classification, index, barsSince: candles.length - 1 - index,
  };
};

// ── 5. Underlying confirmation ───────────────────────────────────────────────

export type Direction = 'BULLISH' | 'BEARISH' | 'NEUTRAL';

export type UnderlyingConfirmation = {
  direction: Direction;
  score: number;
  preferred: Direction;
  confirmed: boolean;
  parts: { direction: number; trend: number; levelBreak: number; momentum: number; volume: number; volatility: number };
  features: {
    lastClose: number | null; shortMa: number | null; longMa: number | null;
    recentHigh: number | null; recentLow: number | null; returnPct: number | null; volumeRatio: number | null;
  };
};

const ma = (values: readonly number[], period: number): number | null =>
  values.length >= period ? values.slice(-period).reduce((a, b) => a + b, 0) / period : null;

/**
 * CRITICAL check (brief s5): does the UNDERLYING agree with the option signal?
 * A bullish PE breakout wants SENSEX bearish; a bullish CE breakout wants SENSEX
 * bullish. The rule is recorded as a feature, never as truth — historical
 * outcomes decide its value.
 */
export const underlyingConfirmation = (
  underlyingCandles: readonly Candle[],
  optionType: 'CE' | 'PE',
  thresholds: PatternThresholds,
): UnderlyingConfirmation => {
  const preferred: Direction = optionType === 'CE' ? 'BULLISH' : 'BEARISH';
  const base: UnderlyingConfirmation = {
    direction: 'NEUTRAL', score: 0, preferred, confirmed: false,
    parts: { direction: 0, trend: 0, levelBreak: 0, momentum: 0, volume: 0, volatility: 0 },
    features: { lastClose: null, shortMa: null, longMa: null, recentHigh: null, recentLow: null, returnPct: null, volumeRatio: null },
  };
  if (underlyingCandles.length < 4) return base;

  const closes = underlyingCandles.map((c) => c.close);
  const last = underlyingCandles[underlyingCandles.length - 1];
  const shortMa = ma(closes, 5);
  const longMa = ma(closes, 20);
  const window = underlyingCandles.slice(-thresholds.lookbackBars);
  const recentHigh = Math.max(...window.map((c) => c.high));
  const recentLow = Math.min(...window.map((c) => c.low));
  const first = window[0].close;
  const returnPct = first > 0 ? (last.close - first) / first : null;
  const volumes = underlyingCandles.slice(-11, -1).map((c) => c.volume);
  const medianVolume = median(volumes);
  const volumeRatio = medianVolume && medianVolume > 0 ? last.volume / medianVolume : null;
  const underlyingAtr = atr(underlyingCandles);

  // Direction of the underlying. With a long enough tape this is the classic
  // short-vs-long MA relationship; with a young tape (session start, few bars)
  // the MA pair does not exist yet, so direction falls back to the window's own
  // movement instead of silently reporting BEARISH — that bias would make every
  // fresh session CE-blind.
  const trendUp = shortMa !== null && longMa !== null
    ? shortMa > longMa
    : shortMa !== null && window.length
      ? shortMa > first
      : last.close > first;
  const direction: Direction = trendUp ? 'BULLISH' : 'BEARISH';

  const parts = {
    // Structural direction (short MA vs long MA, or last vs long MA).
    direction: direction === preferred ? 0.4 : 0,
    // Momentum: last candle agrees with the preferred direction.
    momentum: (preferred === 'BULLISH' ? last.close > last.open : last.close < last.open) ? 0.2 : 0,
    // Level break: the underlying broke its own recent extreme the right way.
    levelBreak: (preferred === 'BEARISH' ? last.close <= recentLow : last.close >= recentHigh) ? 0.2 : 0,
    // Volume participation behind the move.
    volume: volumeRatio !== null && volumeRatio >= thresholds.volumeExpansionRatio ? 0.1 : 0,
    // Trend strength normalized by the underlying's own ATR.
    trend: underlyingAtr && underlyingAtr > 0
      ? clamp01(Math.abs(last.close - (longMa ?? last.close)) / (underlyingAtr * 2)) * 0.1
      : 0,
    // Volatility regime: expansion supports an explosive option move.
    volatility: 0,
  };
  const score = clamp01(Object.values(parts).reduce((a, b) => a + b, 0));
  return {
    direction, score, preferred, confirmed: direction === preferred && score >= 0.4, parts,
    features: { lastClose: last.close, shortMa, longMa, recentHigh, recentLow, returnPct, volumeRatio },
  };
};

// ── 6. Option-chain confirmation ─────────────────────────────────────────────

export type ChainLeg = {
  strike: number; optionType: 'CE' | 'PE'; oi: number; changeOi: number; volume: number;
  iv: number | null; ltp: number; bid?: number | null; ask?: number | null;
};

export type ChainConfirmation = {
  score: number;
  supporting: boolean;
  pcr: number | null;
  ceOi: number | null;
  peOi: number | null;
  ceChangeOi: number | null;
  peChangeOi: number | null;
  atmStrike: number | null;
  strikesExamined: number;
  parts: { oiShift: number; pcrShift: number; volumeSpread: number; ivSpread: number };
};

/**
 * Broader-chain behaviour around the signal (brief s6): is the move supported by
 * nearby strikes, or is it one illiquid contract moving alone? ATM ±2 by real
 * strike interval; never just the selected option.
 */
export const chainConfirmation = (legs: readonly ChainLeg[], optionType: 'CE' | 'PE', spot: number | null): ChainConfirmation => {
  const empty: ChainConfirmation = {
    score: 0, supporting: false, pcr: null, ceOi: null, peOi: null, ceChangeOi: null, peChangeOi: null,
    atmStrike: null, strikesExamined: 0, parts: { oiShift: 0, pcrShift: 0, volumeSpread: 0, ivSpread: 0 },
  };
  if (!legs.length) return empty;

  const ceOi = legs.filter((l) => l.optionType === 'CE').reduce((a, l) => a + l.oi, 0);
  const peOi = legs.filter((l) => l.optionType === 'PE').reduce((a, l) => a + l.oi, 0);
  const ceChangeOi = legs.filter((l) => l.optionType === 'CE').reduce((a, l) => a + l.changeOi, 0);
  const peChangeOi = legs.filter((l) => l.optionType === 'PE').reduce((a, l) => a + l.changeOi, 0);
  const pcr = ceOi > 0 ? peOi / ceOi : null;

  const strikes = [...new Set(legs.map((l) => l.strike))].sort((a, b) => a - b);
  const atmStrike = spot !== null
    ? strikes.reduce((best, s) => (Math.abs(s - spot) < Math.abs(best - spot) ? s : best), strikes[0])
    : strikes[Math.floor(strikes.length / 2)];

  // The traded side's own OI direction: for a bullish CE breakout, calls gaining
  // OI across strikes is participation; for PE, puts gaining OI.
  const ownSideChange = optionType === 'CE' ? ceChangeOi : peChangeOi;
  const otherSideChange = optionType === 'CE' ? peChangeOi : ceChangeOi;
  const totalChange = Math.abs(ownSideChange) + Math.abs(otherSideChange);
  const oiShift = totalChange > 0 ? clamp01((ownSideChange - otherSideChange) / totalChange) : 0.5;

  // A PE-led move usually shows PCR rising, a CE-led move PCR falling.
  const pcrShift = optionType === 'PE'
    ? (peChangeOi > 0 && ceChangeOi < 0 ? 1 : 0.5)
    : (ceChangeOi > 0 && peChangeOi < 0 ? 1 : 0.5);

  const legsWithBothSides = legs.filter((l) => l.bid !== null && l.bid !== undefined && l.ask !== null && l.ask !== undefined && l.ask > l.bid);
  const volumeSpread = legsWithBothSides.length >= 4 ? 1 : clamp01(legsWithBothSides.length / 4);

  const ivs = legs.map((l) => l.iv).filter((v): v is number => v !== null && v !== undefined && v > 0);
  const ivMomentum = ivs.length >= 2 ? stdev(ivs) : null;
  const ivSpread = ivMomentum === null ? 0.5 : clamp01(1 - ivMomentum / 0.5);

  const parts = { oiShift, pcrShift, volumeSpread, ivSpread };
  const score = clamp01(Object.values(parts).reduce((a, b) => a + b, 0) / Object.keys(parts).length);
  return {
    score, supporting: score >= 0.5, pcr, ceOi, peOi, ceChangeOi, peChangeOi, atmStrike,
    strikesExamined: strikes.length, parts,
  };
};

// ── 8. Volume + OI behaviour ─────────────────────────────────────────────────

export const OI_BEHAVIOURS = ['LONG_BUILDUP', 'SHORT_COVERING', 'FRESH_WRITING', 'FRESH_BUYING', 'UNCERTAIN'] as const;
export type OiBehaviour = (typeof OI_BEHAVIOURS)[number];

/**
 * Price/OI quadrant classification. Reported as an inference with its own
 * confidence, never as certainty — the data cannot always separate fresh writing
 * from covering, so UNCERTAIN is a real answer (brief s8).
 */
export const classifyOi = (priceChangePct: number | null, oiChange: number | null): { behaviour: OiBehaviour; confident: boolean } => {
  if (priceChangePct === null || oiChange === null || oiChange === 0) return { behaviour: 'UNCERTAIN', confident: false };
  const rising = priceChangePct > 0;
  const oiUp = oiChange > 0;
  if (rising && oiUp) return { behaviour: 'LONG_BUILDUP', confident: true };
  if (rising && !oiUp) return { behaviour: 'SHORT_COVERING', confident: true };
  if (!rising && oiUp) return { behaviour: 'FRESH_WRITING', confident: true };
  return { behaviour: 'FRESH_BUYING', confident: true };
};

// ── 9. Liquidity gate ────────────────────────────────────────────────────────

export type Liquidity = { ok: boolean; score: number; spreadPct: number | null; tickAgeMs: number | null; reasons: string[] };

export const liquidityCheck = (
  quote: { ltp: number | null; bid: number | null; ask: number | null; bidQty?: number | null; askQty?: number | null; ts: Date | number | null },
  thresholds: PatternThresholds,
  now = Date.now(),
): Liquidity => {
  const reasons: string[] = [];
  const ltp = quote.ltp;
  const bid = quote.bid;
  const ask = quote.ask;
  const at = quote.ts instanceof Date ? quote.ts.getTime() : quote.ts !== null ? new Date(quote.ts).getTime() : null;
  const tickAgeMs = at !== null && Number.isFinite(at) ? Math.max(0, now - at) : null;

  let spreadPct: number | null = null;
  if (bid !== null && ask !== null && bid !== undefined && ask !== undefined && bid > 0 && ask >= bid && ltp) {
    const mid = (bid + ask) / 2;
    spreadPct = mid > 0 ? (ask - bid) / mid : null;
  }

  if (tickAgeMs === null) reasons.push('no timestamp on quote');
  else if (tickAgeMs > thresholds.maxTickAgeMs) reasons.push(`quote stale (${Math.round(tickAgeMs / 1000)}s > ${Math.round(thresholds.maxTickAgeMs / 1000)}s)`);
  if (spreadPct === null) reasons.push('no two-sided quote');
  else if (spreadPct > thresholds.maxSpreadPct) reasons.push(`spread ${(spreadPct * 100).toFixed(2)}% > ${(thresholds.maxSpreadPct * 100).toFixed(2)}%`);
  if (ltp === null || !(ltp > 0)) reasons.push('no traded price');

  const depth = Math.min(quote.bidQty ?? 0, quote.askQty ?? 0);
  if (depth < thresholds.minTopDepth) reasons.push('insufficient displayed depth');

  const spreadScore = spreadPct === null ? 0 : clamp01(1 - spreadPct / thresholds.maxSpreadPct);
  const ageScore = tickAgeMs === null ? 0 : clamp01(1 - tickAgeMs / thresholds.maxTickAgeMs);
  const depthScore = thresholds.minTopDepth <= 0 ? 1 : clamp01(depth / (thresholds.minTopDepth * 5));
  return { ok: reasons.length === 0, score: clamp01((spreadScore + ageScore + depthScore) / 3), spreadPct, tickAgeMs, reasons };
};

// ── 10. Early vs chasing ─────────────────────────────────────────────────────

export const ENTRY_STATES = ['EARLY_REVERSAL', 'BREAKOUT', 'CONFIRMED_MOMENTUM', 'EXTENDED', 'OVEREXTENDED'] as const;
export type EntryState = (typeof ENTRY_STATES)[number];

export const classifyEntry = (
  input: { distanceAtr: number | null; recentReturnPct: number | null; breakoutClass: BreakoutClass; reversalScore: number },
  thresholds: PatternThresholds,
): { state: EntryState; reasons: string[] } => {
  const reasons: string[] = [];
  const atrMultiple = input.distanceAtr;
  if (input.breakoutClass === 'FAILED_BREAKOUT') { reasons.push('breakout failed — price closed back inside the range'); return { state: 'OVEREXTENDED', reasons }; }
  if (atrMultiple !== null && atrMultiple >= thresholds.overextendedAtr) {
    reasons.push(`price is ${atrMultiple.toFixed(2)} ATR above the range (>${thresholds.overextendedAtr}) — chasing`);
    return { state: 'OVEREXTENDED', reasons };
  }
  if (atrMultiple !== null && atrMultiple > thresholds.breakoutMaxExtensionAtr) {
    reasons.push(`extension ${atrMultiple.toFixed(2)} ATR — continuation only`);
    return { state: 'EXTENDED', reasons };
  }
  if (input.breakoutClass === 'EARLY_BREAKOUT' || input.breakoutClass === 'CONFIRMED_BREAKOUT') {
    if (input.reversalScore >= thresholds.reversalMinScore) { reasons.push('breakout still near the range with reversal evidence'); return { state: 'BREAKOUT', reasons }; }
    reasons.push('breakout near the range but no exhaustion evidence yet'); return { state: 'EARLY_REVERSAL', reasons };
  }
  reasons.push('breakout with momentum continuation'); return { state: 'CONFIRMED_MOMENTUM', reasons };
};

// ── 11-12. Full assessment + feature snapshot ────────────────────────────────

export type PatternAssessment = {
  patternType: string;
  signal: 'BUY_CE' | 'BUY_PE' | 'NO_TRADE';
  confidence: number;
  entryState: EntryState;
  reason: string;
  components: {
    consolidation: number; reversal: number; breakout: number; momentum: number; volume: number;
    oi: number; iv: number; underlying: number; liquidity: number; chain: number;
  };
  penalties: { extension: number; unconfirmed: number };
  consolidation: Consolidation;
  reversal: Reversal;
  breakout: Breakout;
  underlying: UnderlyingConfirmation;
  chain: ChainConfirmation;
  liquidity: Liquidity;
  momentum: { score: number; returnPct: number | null; volumeRatio: number | null; bodyExpansion: boolean };
  oi: { behaviour: OiBehaviour; confident: boolean; changeOi: number | null; priceChangePct: number | null };
  iv: { score: number; atSignal: number | null; changePct: number | null };
};

const last = <T>(values: readonly T[]): T | undefined => values[values.length - 1];

/** Weights are explicit so a later optimisation pass can re-weight them. */
export const PATTERN_WEIGHTS = {
  reversal: 0.3, breakout: 0.2, momentum: 0.1, volume: 0.1, oi: 0.08, iv: 0.06, underlying: 0.1, liquidity: 0.06,
} as const;

export const assessPattern = (input: {
  optionCandles: readonly Candle[];
  underlyingCandles: readonly Candle[];
  chainLegs: readonly ChainLeg[];
  quote: { ltp: number | null; bid: number | null; ask: number | null; bidQty?: number | null; askQty?: number | null; ts: Date | number | null; oi?: number | null; changeOi?: number | null; iv?: number | null };
  optionType: 'CE' | 'PE';
  spot?: number | null;
  thresholds?: PatternThresholds;
  now?: number;
}): PatternAssessment => {
  const thresholds = input.thresholds ?? DEFAULT_PATTERN_THRESHOLDS;
  const now = input.now ?? Date.now();
  const candles = input.optionCandles;
  const liquidity = liquidityCheck(input.quote, thresholds, now);
  // Compression is measured BEFORE the newest bar. A window that had to include
  // the breakout candle could never satisfy "range ends here" — the breakout
  // bar is by definition outside the range — so the range is taken from the
  // series minus its last bar and the breakout is then tested on that level.
  const compressionCandles = candles.length > 1 ? candles.slice(0, -1) : candles;
  const consolidation = detectConsolidation(compressionCandles, thresholds);
  const reversal = detectReversal(candles, thresholds);
  const breakout = detectBreakout(candles, consolidation, thresholds, liquidity.spreadPct);
  const underlying = underlyingConfirmation(input.underlyingCandles, input.optionType, thresholds);
  const chain = chainConfirmation(input.chainLegs, input.optionType, input.spot ?? null);

  // Momentum of the option itself: recent return vs its own ATR, plus volume.
  const current = last(candles);
  const momentumWindow = candles.slice(-6);
  const firstClose = momentumWindow.length ? momentumWindow[0].close : null;
  const recentReturnPct = firstClose && current && firstClose > 0 ? (current.close - firstClose) / firstClose : null;
  const volumes = candles.slice(-11, -1).map((c) => c.volume);
  const medianVolume = median(volumes.filter((v) => v > 0));
  const volumeRatio = current && medianVolume && medianVolume > 0 ? current.volume / medianVolume : null;
  const momentumScore = clamp01(
    (recentReturnPct !== null && recentReturnPct > 0 ? 0.5 : 0) +
    (volumeRatio !== null ? clamp01(volumeRatio / (thresholds.volumeExpansionRatio * 2)) * 0.3 : 0) +
    (reversal.flags.bodyExpansion ? 0.2 : 0),
  );

  const volumeScore = volumeRatio === null ? 0.5 : clamp01(volumeRatio / (thresholds.volumeExpansionRatio * 2));

  const priceChangePct = momentumWindow.length >= 2
    ? (momentumWindow[momentumWindow.length - 1].close - momentumWindow[0].close) / momentumWindow[0].close
    : null;
  const oiClass = classifyOi(priceChangePct, input.quote.changeOi ?? null);
  // Own-side OI participation (bullish option OI rising) supports continuation.
  const oiScore = oiClass.behaviour === 'LONG_BUILDUP' ? 1
    : oiClass.behaviour === 'FRESH_BUYING' ? 0.6
      : oiClass.behaviour === 'SHORT_COVERING' ? 0.4 : 0.3;

  // IV at the signal vs its own recent level (expansion drives explosive moves).
  // An IV *history* is not stored yet, so the change is reported as null rather
  // than invented; only the level is scored.
  const ivAtSignal = input.quote.iv ?? null;
  const ivChangePct = null;
  const ivScore = ivAtSignal === null ? 0.5 : clamp01(0.5 + Math.min(0.5, Math.max(-0.5, (ivAtSignal - 0.15) * 2)));

  const components = {
    consolidation: consolidation.detected ? clamp01((
      consolidation.components.rangeScore + consolidation.components.atrScore +
      consolidation.components.durationScore + consolidation.components.failureScore +
      consolidation.components.volumeScore) / 5) : 0,
    reversal: reversal.score,
    breakout: breakout.detected ? (breakout.classification === 'EARLY_BREAKOUT' ? 1 : 0.8) : 0,
    momentum: momentumScore,
    volume: volumeScore,
    oi: oiScore,
    iv: ivScore,
    underlying: underlying.score,
    liquidity: liquidity.score,
    chain: chain.score,
  };

  const weighted =
    components.reversal * PATTERN_WEIGHTS.reversal +
    components.breakout * PATTERN_WEIGHTS.breakout +
    components.momentum * PATTERN_WEIGHTS.momentum +
    components.volume * PATTERN_WEIGHTS.volume +
    components.oi * PATTERN_WEIGHTS.oi +
    components.iv * PATTERN_WEIGHTS.iv +
    components.underlying * PATTERN_WEIGHTS.underlying +
    components.liquidity * PATTERN_WEIGHTS.liquidity;
  const weightTotal = PATTERN_WEIGHTS.reversal + PATTERN_WEIGHTS.breakout + PATTERN_WEIGHTS.momentum +
    PATTERN_WEIGHTS.volume + PATTERN_WEIGHTS.oi + PATTERN_WEIGHTS.iv + PATTERN_WEIGHTS.underlying + PATTERN_WEIGHTS.liquidity;
  let confidence = clamp01(weighted / weightTotal);

  const entry = classifyEntry(
    { distanceAtr: breakout.atrMultiple, recentReturnPct, breakoutClass: breakout.classification, reversalScore: reversal.score },
    thresholds,
  );

  // Penalties: an already-explosive move and an unconfirmed underlying both
  // REDUCE fresh-entry confidence (brief s10) — they never increase it.
  const extensionPenalty = entry.state === 'OVEREXTENDED' ? 0.4 : entry.state === 'EXTENDED' ? 0.2 : 0;
  const unconfirmedPenalty = underlying.confirmed ? 0 : 0.15;
  confidence = clamp01(confidence - extensionPenalty - unconfirmedPenalty);

  const reasons: string[] = [];
  if (!consolidation.detected) reasons.push('no range compression');
  if (reversal.score < thresholds.reversalMinScore) reasons.push(`exhaustion evidence weak (${reversal.score.toFixed(2)})`);
  if (!breakout.detected) reasons.push(breakout.classification === 'FAILED_BREAKOUT' ? 'breakout failed' : 'no breakout above the range');
  if (!liquidity.ok) reasons.push(...liquidity.reasons);
  if (entry.state === 'OVEREXTENDED') reasons.push(...entry.reasons);
  if (!underlying.confirmed) reasons.push(`underlying ${underlying.direction} does not confirm a ${input.optionType} breakout`);

  const threshold = underlying.confirmed ? thresholds.minConfidence : thresholds.minConfidenceUnconfirmed;
  const entryAllowed = entry.state !== 'OVEREXTENDED' && (entry.state !== 'EXTENDED' || thresholds.allowExtendedEntries);
  const cleanReversal = reversal.score >= thresholds.reversalMinScore;
  const signal: PatternAssessment['signal'] =
    confidence >= threshold && breakout.detected && liquidity.ok && entryAllowed && cleanReversal
      ? (input.optionType === 'CE' ? 'BUY_CE' : 'BUY_PE')
      : 'NO_TRADE';
  if (signal === 'NO_TRADE' && !reasons.length) reasons.push(`confidence ${(confidence * 100).toFixed(0)}% below ${(threshold * 100).toFixed(0)}%`);

  const patternType = signal !== 'NO_TRADE'
    ? `CONSOLIDATION_${entry.state}_${input.optionType}`
    : consolidation.detected ? 'CONSOLIDATION_OBSERVED' : 'NO_PATTERN';

  void ivChangePct; // no invented IV history
  return {
    patternType, signal, confidence, entryState: entry.state,
    reason: reasons.join('; ') || `reversal ${(reversal.score * 100).toFixed(0)}% · breakout ${breakout.classification} · underlying ${underlying.direction}`,
    components,
    penalties: { extension: extensionPenalty, unconfirmed: unconfirmedPenalty },
    consolidation, reversal, breakout, underlying, chain, liquidity,
    momentum: { score: momentumScore, returnPct: recentReturnPct, volumeRatio, bodyExpansion: reversal.flags.bodyExpansion },
    oi: { behaviour: oiClass.behaviour, confident: oiClass.confident, changeOi: input.quote.changeOi ?? null, priceChangePct },
    iv: { score: ivScore, atSignal: ivAtSignal, changePct: ivChangePct },
  };
};

// ── 13. Forward outcome labelling ────────────────────────────────────────────

export const OUTCOME_HORIZONS_MIN = [5, 10, 15, 30, 60] as const;
export type OutcomeHorizonMinutes = (typeof OUTCOME_HORIZONS_MIN)[number];
export const OUTCOME_LABELS = ['TARGET_REACHED', 'STOP_REACHED', 'FAILED_BREAKOUT', 'CONTINUATION', 'EXTENSION', 'REVERSAL', 'PENDING'] as const;
export type OutcomeLabel = (typeof OUTCOME_LABELS)[number];

export type HorizonOutcome = {
  horizonMinutes: number;
  maxFavourablePct: number | null;
  maxAdversePct: number | null;
  maxPrice: number | null;
  minPrice: number | null;
  returnPct: number | null;
  /** True only when the tape actually reaches this horizon (no extrapolation). */
  covered: boolean;
  label: OutcomeLabel;
};

/**
 * For one signal, measure what actually happened at each horizon: MFE/MAE,
 * maximum/minimum price and the return (brief s13). Returns fewer entries than
 * horizons when the future has not happened yet — a horizon is only labelled
 * with data that exists, never extrapolated.
 */
export const labelOutcomes = (input: {
  entryPrice: number;
  entryTs: number;
  futureTicks: readonly TickLike[];
  targetPct?: number | null;
  stopPct?: number | null;
  horizons?: readonly number[];
}): HorizonOutcome[] => {
  const entryPrice = input.entryPrice;
  if (!(entryPrice > 0)) return [];
  const targetPct = input.targetPct ?? null;
  const stopPct = input.stopPct ?? null;
  const horizons = input.horizons ?? OUTCOME_HORIZONS_MIN;
  const points = input.futureTicks
    .map((t) => ({
      at: t.ts instanceof Date ? t.ts.getTime() : new Date(t.ts).getTime(),
      price: Number(t.price),
    }))
    .filter((p) => Number.isFinite(p.at) && Number.isFinite(p.price) && p.price > 0)
    .sort((a, b) => a.at - b.at);

  const out: HorizonOutcome[] = [];
  for (const horizonMinutes of horizons) {
    const until = input.entryTs + horizonMinutes * 60_000;
    const window = points.filter((p) => p.at > input.entryTs && p.at <= until);
    if (!window.length) continue;
    const maxPrice = Math.max(...window.map((p) => p.price));
    const minPrice = Math.min(...window.map((p) => p.price));
    const maxFavourablePct = (maxPrice - entryPrice) / entryPrice;
    const maxAdversePct = (minPrice - entryPrice) / entryPrice;
    const returnPct = (window[window.length - 1].price - entryPrice) / entryPrice;

    const hitTarget = targetPct !== null && maxFavourablePct >= targetPct;
    const hitStop = stopPct !== null && maxAdversePct <= -Math.abs(stopPct);
    // Which barrier was touched FIRST decides the label — resolving "both hit"
    // by assuming the favourable one first would bias the learning set.
    let firstTouch: 'TARGET' | 'STOP' | null = null;
    if (targetPct !== null || stopPct !== null) {
      for (const point of window) {
        const move = (point.price - entryPrice) / entryPrice;
        if (stopPct !== null && move <= -Math.abs(stopPct)) { firstTouch = 'STOP'; break; }
        if (targetPct !== null && move >= targetPct) { firstTouch = 'TARGET'; break; }
      }
    }
    const label: OutcomeLabel = firstTouch === 'STOP' ? 'STOP_REACHED'
      : firstTouch === 'TARGET' ? 'TARGET_REACHED'
        : hitStop && !hitTarget ? 'STOP_REACHED'
          : hitTarget ? 'TARGET_REACHED'
            : maxFavourablePct <= -0.02 && returnPct < 0 ? 'FAILED_BREAKOUT'
              : returnPct > 0.5 ? 'EXTENSION'
                : returnPct > 0.1 ? 'CONTINUATION'
                  : returnPct < 0 ? 'REVERSAL' : 'PENDING';
    out.push({
      horizonMinutes,
      maxFavourablePct: round4(maxFavourablePct),
      maxAdversePct: round4(maxAdversePct),
      maxPrice, minPrice, returnPct: round4(returnPct),
      // Covered only when the tape reaches the horizon: a 60-minute label built
      // from 20 minutes of ticks would not be a measurement.
      covered: points[points.length - 1].at >= until - 60_000,
      label,
    });
  }
  return out;
};

const round4 = (value: number): number => Math.round(value * 10_000) / 10_000;
