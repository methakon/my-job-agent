#!/usr/bin/env node
/**
 * PORTED FEATURE ENGINE — pattern/feature computation.
 *
 * Logic ported from /home/swarna-sekhar-dhar/projects/cpp-trading-agent
 *   src/trading/pattern-engine/pattern-features.ts
 * That project was READ ONLY. No file there was modified. This is a
 * reimplementation of its arithmetic, not a copy of its code.
 *
 * Pure functions only: no DB, no clock, no network. Every timestamp is a
 * parameter, which is what makes these testable and replayable.
 *
 * ── Deviations from the source, each deliberate ──────────────────────────
 * 1. ATR is a simple mean of true ranges (as the source computes it). The
 *    source's module comment calls it "Wilder-style", which it is not, and a
 *    second implementation in their repo disagrees with it. We implement what
 *    the code does and say so.
 * 2. consolidation and chain are computed and reported, but carry ZERO weight
 *    in the confidence sum in the source. We keep that weight table EXACTLY as
 *    it is, because changing a weight changes the model's behaviour and that
 *    is a decision for the operator, not a port. They remain available to the
 *    entry policy as gates.
 * 3. `ivChangePct` is hard-coded null in the source because no IV history is
 *    stored. We do the same rather than inventing a history we do not have.
 * 4. The source's breakout classification ternary is dead (both branches return
 *    the same class). We implement the effective behaviour.
 *
 * Everything else — the sub-score formulas, the 9 reversal weights summing to
 * 1.00, the confidence weights summing to 1.00, the penalty ladder, the entry
 * state cascade — is carried across faithfully.
 */
'use strict';

const C = require('./expiry-day-core');

// ── primitives ──────────────────────────────────────────────────────────
const clamp01 = (v) => Math.max(0, Math.min(1, Number(v)));
const isFiniteNum = (v) => Number.isFinite(Number(v));
const num = (v, fallback = null) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
const median = (arr) => {
  const a = arr.filter((x) => Number.isFinite(Number(x))).map(Number).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};
const stdev = (arr) => {
  const a = arr.filter((x) => Number.isFinite(Number(x))).map(Number);
  if (a.length < 2) return null;
  const mean = a.reduce((s, x) => s + x, 0) / a.length;
  const v = a.reduce((s, x) => s + (x - mean) ** 2, 0) / (a.length - 1);
  return Math.sqrt(v);
};
const ma = (values, period) => {
  if (!Array.isArray(values) || values.length < period) return null;
  const w = values.slice(-period);
  return w.reduce((s, x) => s + x, 0) / w.length;
};

/** Bucket ticks into candles. Ticks with no time or a non-positive price are dropped. */
function bucketCandles(ticks, bucketMs = 300_000) {
  const map = new Map();
  for (const t of ticks ?? []) {
    const ts = Number(t?.ts ?? t?.at ?? t?.timestamp);
    const price = Number(t?.price ?? t?.ltp ?? t?.close);
    if (!Number.isFinite(ts) || !Number.isFinite(price) || price <= 0) continue;
    const key = Math.floor(ts / bucketMs) * bucketMs;
    const existing = map.get(key);
    if (!existing) {
      map.set(key, { ts: key, open: price, high: price, low: price, close: price, volume: Number(t?.volume) || 0 });
    } else {
      existing.high = Math.max(existing.high, price);
      existing.low = Math.min(existing.low, price);
      existing.close = price;
      existing.volume += Number(t?.volume) || 0;
    }
  }
  return [...map.values()].sort((a, b) => a.ts - b.ts);
}

/**
 * ATR as the source computes it: a simple mean of true ranges over `period`
 * bars. This is NOT Wilder smoothing and the source's own comment is wrong
 * about that; we reproduce the arithmetic, not the description.
 */
function atr(candles, period = 14) {
  const c = candles ?? [];
  if (c.length < 2) return null;
  const window = c.slice(-(Math.max(2, period) + 1));
  let sum = 0; let n = 0;
  for (let i = 1; i < window.length; i += 1) {
    const prevClose = window[i - 1].close;
    const tr = Math.max(
      window[i].high - window[i].low,
      Math.abs(window[i].high - prevClose),
      Math.abs(window[i].low - prevClose),
    );
    if (Number.isFinite(tr)) { sum += tr; n += 1; }
  }
  return n > 0 ? sum / n : null;
}

const THRESHOLDS = {
  consolidationMinCandles: 6,
  consolidationMaxRangeAtr: 2.5,
  consolidationMaxAtrPct: 0.9,
  lookbackBars: 24,
  reversalMinScore: 0.55,
  breakoutMaxExtensionAtr: 1.8,
  overextendedAtr: 3.0,
  minConfidence: 0.60,
  minConfidenceUnconfirmed: 0.78,
  maxSpreadPct: 0.02,
  maxTickAgeMs: 15_000,
  minTopDepth: 1,
  volumeExpansionRatio: 1.5,
  allowExtendedEntries: false,
};

// ── 1. consolidation ────────────────────────────────────────────────────
/**
 * Ported. One structural note carried across verbatim: the window scan BREAKS
 * at the first over-budget window rather than continuing, so a compression run
 * longer than the ATR budget terminates early. That is the source's behaviour
 * and it is load-bearing for how `rangeHigh`/`rangeLow` come out.
 */
function detectConsolidation(candles, thresholds = {}) {
  const t = { ...THRESHOLDS, ...thresholds };
  const empty = {
    detected: false, startIndex: null, windowBars: 0, rangeHigh: null, rangeLow: null,
    rangeWidthAtr: null, atrPct: null, failedBreakouts: 0, volumeContractionRatio: null,
    score: 0,
    parts: { range: 0, atr: 0, duration: 0, failure: 0, volume: 0 },
  };
  const c = candles ?? [];
  if (c.length < t.consolidationMinCandles) return { ...empty, atrValue: atr(c), atrPct: atr(c) && c.length ? atr(c) / c[c.length - 1].close : null };

  const atrValue = atr(c);
  const lastClose = c[c.length - 1].close;
  const atrPct = atrValue && lastClose > 0 ? atrValue / lastClose : null;

  let bestStart = null;
  for (let start = c.length - t.consolidationMinCandles; start >= 0; start -= 1) {
    const window = c.slice(start);
    const width = Math.max(...window.map((b) => b.high)) - Math.min(...window.map((b) => b.low));
    const widthAtr = atrValue > 0 ? width / atrValue : null;
    if (widthAtr !== null && widthAtr > t.consolidationMaxRangeAtr) break;  // source behaviour
    bestStart = start;
  }
  if (bestStart === null) return { ...empty, atrValue, atrPct };

  const window = c.slice(bestStart);
  const rangeHigh = Math.max(...window.map((b) => b.high));
  const rangeLow = Math.min(...window.map((b) => b.low));
  const rangeWidth = rangeHigh - rangeLow;
  const rangeWidthAtr = atrValue > 0 ? rangeWidth / atrValue : null;

  let failedBreakouts = 0;
  const scanFrom = Math.max(0, bestStart - t.lookbackBars);
  for (let i = scanFrom; i < c.length; i += 1) {
    if (c[i].high > rangeHigh && c[i].close < rangeHigh) failedBreakouts += 1;
    else if (c[i].low < rangeLow && c[i].close > rangeLow) failedBreakouts += 1;  // else-if: max 1 per bar
  }

  const prior = c.slice(Math.max(0, bestStart - t.lookbackBars), bestStart).map((b) => b.volume).filter((v) => v > 0);
  const priorMedian = median(prior);
  const windowMedian = median(window.map((b) => b.volume).filter((v) => v > 0));
  const volumeContractionRatio = (priorMedian && windowMedian) ? windowMedian / priorMedian : null;

  const parts = {
    range: clamp01(rangeWidthAtr === null ? 0.5 : 1 - rangeWidthAtr / t.consolidationMaxRangeAtr),
    atr: clamp01(atrPct === null ? 0.5 : 1 - atrPct / t.consolidationMaxAtrPct),
    duration: clamp01(window.length / 12),
    failure: clamp01(failedBreakouts / 2),
    volume: clamp01(volumeContractionRatio === null ? 0.5 : 1 - volumeContractionRatio / 1.5),
  };

  return {
    detected: c.length >= t.consolidationMinCandles
      && (rangeWidthAtr === null || rangeWidthAtr <= t.consolidationMaxRangeAtr)
      && (atrPct === null || atrPct <= t.consolidationMaxAtrPct),
    startIndex: bestStart,
    windowBars: window.length,
    rangeHigh, rangeLow, rangeWidthAtr, atrPct,
    atrValue,
    failedBreakouts,
    volumeContractionRatio,
    parts,
    score: clamp01((parts.range + parts.atr + parts.duration + parts.failure + parts.volume) / 5),
  };
}

// ── 2. reversal / exhaustion ────────────────────────────────────────────
const REVERSAL_WEIGHTS = {
  lowerLowFailure: 0.12,
  higherLow: 0.14,
  bullishEngulfing: 0.18,
  threeOutsideUp: 0.12,
  rejectionWick: 0.12,
  bodyExpansion: 0.12,
  momentumTurn: 0.10,
  levelReclaim: 0.05,
  volumeExpansion: 0.05,
};   // sums to exactly 1.00, as in the source

function detectReversal(candles, thresholds = {}) {
  const t = { ...THRESHOLDS, ...thresholds };
  const c = candles ?? [];
  if (c.length < 4) return { score: 0, parts: {}, flags: {}, candleIndex: c.length - 1 };

  const i = c.length - 1;
  const candle = c[i];
  const prev = c[i - 1];
  const body = Math.abs(candle.close - candle.open);
  const prevBody = Math.abs(prev.close - prev.open);
  const range = Math.max(1e-9, candle.high - candle.low);
  const bodyRatio = body / range;

  const lookback = c.slice(Math.max(0, i - 4), i);
  const minLowBefore = Math.min(...lookback.map((b) => b.low));
  const minCloseBefore = Math.min(...lookback.map((b) => b.close));
  const medianVolume = median(c.slice(Math.max(0, i - 10), i).map((b) => b.volume));
  const closes = c.slice(Math.max(0, i - 8), i + 1);
  const priorCloses = closes.slice(0, -1);

  const flags = {
    lowerLowFailure: candle.low > minLowBefore,
    higherLow: candle.low > Math.min(...lookback.map((b) => b.low)) && candle.close > minCloseBefore,
    bullishEngulfing: candle.close > candle.open && candle.open <= prev.close
      && candle.close >= prev.open && body > prevBody,
    threeOutsideUp: closes.length >= 3
      && closes[closes.length - 3].close < closes[closes.length - 3].open
      && closes[closes.length - 2].close > closes[closes.length - 2].open
      && closes[closes.length - 2].close > closes[closes.length - 3].open
      && closes[closes.length - 1].close > closes[closes.length - 2].close,
    rejectionWick: candle.close > candle.open
      && (candle.low - Math.min(candle.open, candle.close)) / range >= 0.4,
    bodyExpansion: prevBody > 0 && body >= prevBody * 1.3 && bodyRatio >= 0.5,
    momentumTurn: priorCloses.length >= 4
      && closes[closes.length - 1] > priorCloses[priorCloses.length - 1]
      && Math.min(...priorCloses) <= Math.min(...priorCloses.slice(0, -1)),
    levelReclaim: candle.close > Math.max(...lookback.map((b) => Math.max(b.open, b.close))),
    volumeExpansion: medianVolume > 0 && candle.volume >= medianVolume * t.volumeExpansionRatio,
  };

  let sum = 0;
  const parts = {};
  for (const [k, w] of Object.entries(REVERSAL_WEIGHTS)) {
    parts[k] = flags[k] ? w : 0;
    sum += parts[k];
  }
  return { score: clamp01(sum), parts, flags, candleIndex: i };
}

// ── 3. breakout ─────────────────────────────────────────────────────────
function detectBreakout(candles, consolidation, thresholds = {}) {
  const t = { ...THRESHOLDS, ...thresholds };
  const none = {
    detected: false, classification: 'NONE', index: null, atrMultiple: null,
    volumeRatio: null, distanceAboveRange: null, distancePct: null, barsSince: null,
  };
  const c = candles ?? [];
  if (!consolidation?.detected || consolidation.startIndex === null || c.length < 2) return none;

  const { rangeHigh, startIndex } = consolidation;
  const atrValue = consolidation.atrValue ?? atr(c);
  let index = null;
  for (let i = startIndex + 1; i < c.length; i += 1) {
    if (c[i].close > rangeHigh) { index = i; break; }
  }
  if (index === null) return none;

  const last = c[c.length - 1];
  const distanceAboveRange = last.close - rangeHigh;
  const atrMultiple = atrValue > 0 ? distanceAboveRange / atrValue : null;
  const volWindow = c.slice(Math.max(0, startIndex - t.lookbackBars)).map((b) => b.volume).filter((v) => v > 0);
  const medianVolume = median(volWindow);
  const breakoutCandle = c[index];
  const volumeRatio = medianVolume ? breakoutCandle.volume / medianVolume : null;
  const lowestSince = c.slice(index + 1).length
    ? Math.min(...c.slice(index + 1).map((b) => b.low))
    : breakoutCandle.low;

  const failed = lowestSince < rangeHigh && last.close <= rangeHigh;
  const early = atrMultiple !== null && atrMultiple <= t.breakoutMaxExtensionAtr * 0.5;
  const classification = failed ? 'FAILED_BREAKOUT' : early ? 'EARLY_BREAKOUT' : 'CONFIRMED_BREAKOUT';

  return {
    detected: !failed,
    classification,
    index,
    // Carried for the entry policy: the structural stop needs the level the
    // breakout cleared. Not returned by the source, which is why its own stop
    // lookup silently fell back to volatility.
    rangeHigh,
    rangeLow: consolidation.rangeLow,
    atrMultiple,
    volumeRatio,
    distanceAboveRange,
    distancePct: rangeHigh > 0 ? distanceAboveRange / rangeHigh : null,
    barsSince: c.length - 1 - index,
  };
}

// ── 4. underlying confirmation ──────────────────────────────────────────
function underlyingConfirmation(underlyingCandles, optionType, thresholds = {}) {
  const t = { ...THRESHOLDS, ...thresholds };
  const c = underlyingCandles ?? [];
  const preferred = optionType === 'CE' ? 'BULLISH' : 'BEARISH';
  if (c.length < 4) {
    return { direction: 'NEUTRAL', score: 0, confirmed: false, parts: {}, shortMa: null, longMa: null };
  }

  const closes = c.map((b) => b.close);
  const last = c[c.length - 1];
  const shortMa = ma(closes, 5);
  const longMa = ma(closes, 20);
  const window = c.slice(-t.lookbackBars);
  const underlyingAtr = atr(c);

  // Explicit young-tape fallback chain, carried across verbatim: without it a
  // fresh session has no long MA and every CE looks unconfirmed.
  const trendUp = (shortMa && longMa) ? shortMa > longMa
    : (shortMa && window.length) ? shortMa > window[0].close
      : last.close > window[0].close;
  const direction = trendUp ? 'BULLISH' : 'BEARISH';

  const recentHigh = Math.max(...window.map((b) => b.high));
  const recentLow = Math.min(...window.map((b) => b.low));
  const medianVolume = median(c.slice(-11, -1).map((b) => b.volume).filter((v) => v > 0));
  const volumeRatio = medianVolume ? last.volume / medianVolume : null;

  const parts = {
    direction: direction === preferred ? 0.40 : 0,
    momentum: (preferred === 'BULLISH' ? last.close > last.open : last.close < last.open) ? 0.20 : 0,
    levelBreak: (preferred === 'BULLISH' ? last.close >= recentHigh : last.close <= recentLow) ? 0.20 : 0,
    volume: volumeRatio !== null && volumeRatio >= 1.5 ? 0.10 : 0,
    trend: clamp01(Math.abs(last.close - (longMa ?? last.close)) / (underlyingAtr * 2)) * 0.10,
    volatility: 0,   // permanently 0 in the source; preserved rather than invented
  };

  const score = clamp01(Object.values(parts).reduce((a, b) => a + b, 0));
  return {
    direction, score, shortMa, longMa, recentHigh, recentLow, volumeRatio,
    underlyingAtr, parts,
    // Note: the direction part alone is exactly 0.40, so `confirmed` reduces to
    // direction === preferred. That is the source's behaviour, kept as-is.
    confirmed: direction === preferred && score >= 0.4,
  };
}

// ── 5. chain confirmation ───────────────────────────────────────────────
function chainConfirmation(legs, spot, thresholds = {}) {
  const t = { ...THRESHOLDS, ...thresholds };
  const rows = (legs ?? []).filter((l) => Number.isFinite(Number(l.oi)));
  let ceOi = 0; let peOi = 0; let ceChangeOi = 0; let peChangeOi = 0;
  for (const l of rows) {
    const oi = Number(l.oi) || 0;
    const ch = Number(l.changeOi) || 0;
    if (l.optionType === 'CE') { ceOi += oi; ceChangeOi += ch; }
    else { peOi += oi; peChangeOi += ch; }
  }
  const pcr = ceOi > 0 ? peOi / ceOi : null;

  const strikes = rows.map((l) => Number(l.strike)).filter(Number.isFinite).sort((a, b) => a - b);
  const atmStrike = spot && strikes.length
    ? strikes.reduce((best, k) => (Math.abs(k - spot) < Math.abs(best - spot) ? k : best), strikes[strikes.length >> 1])
    : (strikes.length ? strikes[strikes.length >> 1] : null);

  const bothSides = rows.filter((l) => Number(l.bid) > 0 && Number(l.ask) > 0 && Number(l.ask) > Number(l.bid));
  const ivs = rows.map((l) => Number(l.iv)).filter(Number.isFinite);
  const ivDispersion = stdev(ivs);

  const parts = {
    oiShift: 0.5,        // per-leg OI shift needs two legs; left neutral, not invented
    pcrShift: 0.5,
    // NOTE: the source names this "volumeSpread" but it counts TWO-SIDED
    // QUOTES, not volume. Kept honest in the name here.
    twoSided: bothSides.length >= 4 ? 1 : clamp01(bothSides.length / 4),
    ivSpread: ivs.length >= 2 ? clamp01(1 - ivDispersion / 0.5) : 0.5,
  };
  const score = clamp01((parts.oiShift + parts.pcrShift + parts.twoSided + parts.ivSpread) / 4);
  return { score, supporting: score >= 0.5, pcr, atmStrike, bothSidedCount: bothSides.length, parts };
}

// ── 6. liquidity — a hard gate ──────────────────────────────────────────
function liquidityCheck(quote, nowMs, thresholds = {}) {
  const t = { ...THRESHOLDS, ...thresholds };
  const reasons = [];
  const bid = num(quote?.bid);
  const ask = num(quote?.ask);
  const ltp = num(quote?.ltp);
  const quoteTs = num(quote?.ts ?? quote?.quoteTs);
  const tickAgeMs = quoteTs === null ? null : Math.max(0, nowMs - quoteTs);

  if (quoteTs === null) reasons.push('no timestamp on quote');
  if (tickAgeMs !== null && tickAgeMs > t.maxTickAgeMs) reasons.push(`tick age ${Math.round(tickAgeMs / 1000)}s > ${t.maxTickAgeMs / 1000}s`);
  if (!(bid > 0 && ask >= bid && ltp)) reasons.push('no two-sided quote');
  const spreadPct = (bid > 0 && ask >= bid && ltp) ? (ask - bid) / ((bid + ask) / 2) : null;
  if (spreadPct !== null && spreadPct > t.maxSpreadPct) reasons.push(`spread ${(spreadPct * 100).toFixed(2)}% > ${(t.maxSpreadPct * 100).toFixed(2)}%`);
  if (ltp === null || ltp <= 0) reasons.push('no traded price');
  const depth = Math.min(Number(quote?.bidQty ?? 0) || 0, Number(quote?.askQty ?? 0) || 0);
  if (depth < t.minTopDepth) reasons.push(`insufficient displayed depth (${depth})`);

  const score = clamp01((
    (spreadPct === null ? 0 : clamp01(1 - spreadPct / t.maxSpreadPct))
    + (tickAgeMs === null ? 0 : clamp01(1 - tickAgeMs / t.maxTickAgeMs))
    + (t.minTopDepth <= 0 ? 1 : clamp01(depth / (t.minTopDepth * 5)))
  ) / 3);

  return { ok: reasons.length === 0, reasons, tickAgeMs, spreadPct, depth, score };
}

// ── 7. OI classification ────────────────────────────────────────────────
function classifyOi(priceChangePct, oiChange) {
  if (oiChange === null || priceChangePct === null || oiChange === 0) return { label: 'UNCERTAIN', confident: false };
  const rising = priceChangePct > 0;
  const oiUp = oiChange > 0;
  if (rising && oiUp) return { label: 'LONG_BUILDUP', confident: true };
  if (rising && !oiUp) return { label: 'SHORT_COVERING', confident: true };
  if (!rising && oiUp) return { label: 'FRESH_WRITING', confident: true };
  return { label: 'FRESH_BUYING', confident: true };
}

// ── 8. entry state — ordered cascade, first match wins ──────────────────
function classifyEntry(breakout, thresholds = {}) {
  const t = { ...THRESHOLDS, ...thresholds };
  if (breakout.classification === 'FAILED_BREAKOUT') return { state: 'OVEREXTENDED', reason: 'breakout failed' };
  if (breakout.atrMultiple !== null && breakout.atrMultiple >= t.overextendedAtr) return { state: 'OVEREXTENDED', reason: 'chasing' };
  if (breakout.atrMultiple !== null && breakout.atrMultiple > t.breakoutMaxExtensionAtr) return { state: 'EXTENDED', reason: 'continuation only' };
  if (breakout.classification === 'EARLY_BREAKOUT' || breakout.classification === 'CONFIRMED_BREAKOUT') return { state: 'BREAKOUT', reason: 'breakout confirmed' };
  return { state: 'CONFIRMED_MOMENTUM', reason: 'no breakout structure' };
}

// ── 9. assembly ─────────────────────────────────────────────────────────
/** Weight table carried across EXACTLY as the source has it. */
const PATTERN_WEIGHTS = {
  reversal: 0.30,
  breakout: 0.20,
  momentum: 0.10,
  volume: 0.10,
  oi: 0.08,
  iv: 0.06,
  underlying: 0.10,
  liquidity: 0.06,
};

function assessPattern({ optionCandles, underlyingCandles, optionType, quote, nowMs, legs = [], spot = null, thresholds = {} }) {
  const t = { ...THRESHOLDS, ...thresholds };
  const c = optionCandles ?? [];

  // The compression slice EXCLUDES the newest bar so the breakout bar is outside
  // the range by construction. Reversal and breakout use the full series.
  const consolidation = detectConsolidation(c.slice(0, -1), t);
  const breakout = detectBreakout(c, consolidation, t);
  const reversal = detectReversal(c, t);
  const underlying = underlyingConfirmation(underlyingCandles, optionType, t);
  const liquidity = liquidityCheck(quote, nowMs, t);
  const chain = chainConfirmation(legs, spot, t);

  const window = c.slice(-6);
  const firstClose = window.length ? window[0].close : null;
  const recentReturnPct = (window.length >= 2 && firstClose > 0)
    ? (c[c.length - 1].close - firstClose) / firstClose : null;
  const medianVolume = median(c.slice(-11, -1).map((b) => b.volume).filter((v) => v > 0));
  const volumeRatio = medianVolume ? c[c.length - 1].volume / medianVolume : null;
  const priceChangePct = recentReturnPct;

  const oi = classifyOi(priceChangePct, legs.length ? num(legs.find((l) => l.optionType === optionType)?.changeOi, null) : null);
  const oiScore = { LONG_BUILDUP: 1.0, FRESH_BUYING: 0.6, SHORT_COVERING: 0.4 }[oi.label] ?? 0.3;
  const iv = num(quote?.iv);
  const ivScore = iv === null ? 0.5 : clamp01(0.5 + Math.min(0.5, Math.max(-0.5, (iv - 0.15) * 2)));

  const components = {
    consolidation: consolidation.detected ? consolidation.score : 0,
    reversal: reversal.score,
    breakout: breakout.detected ? (breakout.classification === 'EARLY_BREAKOUT' ? 1.0 : 0.8) : 0,
    momentum: clamp01(
      (recentReturnPct !== null && recentReturnPct > 0 ? 0.5 : 0)
      + (volumeRatio !== null ? clamp01(volumeRatio / 3.0) * 0.3 : 0)
      + (reversal.flags.bodyExpansion ? 0.2 : 0),
    ),
    volume: volumeRatio === null ? 0.5 : clamp01(volumeRatio / 3.0),
    oi: oiScore,
    iv: ivScore,
    underlying: underlying.score,
    liquidity: liquidity.score,
    chain: chain.score,
  };

  const weightTotal = Object.values(PATTERN_WEIGHTS).reduce((a, b) => a + b, 0);
  let confidence = clamp01(Object.entries(PATTERN_WEIGHTS).reduce((s, [k, w]) => s + (components[k] ?? 0) * w, 0) / weightTotal);

  const entry = classifyEntry(breakout, t);
  const extensionPenalty = entry.state === 'OVEREXTENDED' ? 0.40 : entry.state === 'EXTENDED' ? 0.20 : 0;
  const unconfirmedPenalty = underlying.confirmed ? 0 : 0.15;
  confidence = clamp01(confidence - extensionPenalty - unconfirmedPenalty);

  const threshold = underlying.confirmed ? t.minConfidence : t.minConfidenceUnconfirmed;
  const entryAllowed = entry.state !== 'OVEREXTENDED'
    && (entry.state !== 'EXTENDED' || t.allowExtendedEntries);
  const cleanReversal = reversal.score >= t.reversalMinScore;

  const signal = (confidence >= threshold && breakout.detected && liquidity.ok && entryAllowed && cleanReversal)
    ? (optionType === 'CE' ? 'BUY_CE' : 'BUY_PE')
    : 'NO_TRADE';

  return {
    signal, confidence, entryState: entry.state, entryReason: entry.reason,
    components, weights: { ...PATTERN_WEIGHTS, weightTotal },
    penalties: { extension: extensionPenalty, unconfirmed: unconfirmedPenalty },
    consolidation, breakout, reversal, underlying, liquidity, chain, oi,
    momentum: { recentReturnPct, volumeRatio },
    threshold,
    patternType: signal !== 'NO_TRADE'
      ? `CONSOLIDATION_${entry.state}_${optionType}`
      : consolidation.detected ? 'CONSOLIDATION_OBSERVED' : 'NO_PATTERN',
  };
}

module.exports = {
  THRESHOLDS, PATTERN_WEIGHTS, REVERSAL_WEIGHTS,
  clamp01, median, stdev, ma, bucketCandles, atr,
  detectConsolidation, detectReversal, detectBreakout,
  underlyingConfirmation, chainConfirmation, liquidityCheck,
  classifyOi, classifyEntry, assessPattern,
};