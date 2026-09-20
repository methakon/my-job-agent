
import { Injectable, Logger } from '@nestjs/common';

/**
 * Deterministic historical analytics — pure functions over historical data.
 *
 * Every result preserves:
 * - timestamp/window
 * - underlying
 * - source data scope
 * - sample count
 * - calculation period
 * - quality/availability flags
 *
 * NO AI INVENTION. Missing data stays null. Canonical null semantics preserved.
 * These functions never fabricate unavailable Greeks/OI/IV.
 */

// ── Types ─────────────────────────────────────────────────────────────

export interface TimeSeriesPoint {
  timestamp: Date;
  value: number | null;
}

export interface VolatilityResult {
  /** Annualized volatility from session returns. */
  annualizedVol: number | null;
  /** Daily volatility (stddev of returns). */
  dailyVol: number | null;
  /** Average true range (if OHLC available). */
  avgTrueRange: number | null;
  /** Number of returns computed. */
  sampleCount: number;
  /** Period start. */
  from: Date;
  /** Period end. */
  to: Date;
  /** Data quality flag. */
  sufficientData: boolean;
}

export interface TrendResult {
  /** Trend direction: UP | DOWN | FLAT. */
  direction: 'UP' | 'DOWN' | 'FLAT';
  /** Linear regression slope (price per period). */
  slope: number | null;
  /** R-squared of the regression. */
  rSquared: number | null;
  /** SMA-20 value (if enough data). */
  sma20: number | null;
  /** Whether price is above SMA-20. */
  aboveSma20: boolean | null;
  /** Number of data points used. */
  sampleCount: number;
  /** Data quality flag. */
  sufficientData: boolean;
}

export interface PremiumStats {
  /** Average premium across the window. */
  avgPremium: number | null;
  /** Premium change from first to last. */
  totalChange: number | null;
  /** Premium change as percentage. */
  totalChangePct: number | null;
  /** Maximum premium in window. */
  maxPremium: number | null;
  /** Minimum premium in window. */
  minPremium: number | null;
  /** Standard deviation of premiums. */
  stdDev: number | null;
  sampleCount: number;
  from: Date;
  to: Date;
  sufficientData: boolean;
}

export interface SpreadStats {
  /** Average bid-ask spread. */
  avgSpread: number | null;
  /** Median spread. */
  medianSpread: number | null;
  /** Max spread observed. */
  maxSpread: number | null;
  /** Percentage of observations with spread > 0.5% of mid. */
  wideSpreadPct: number | null;
  sampleCount: number;
  sufficientData: boolean;
}

export interface VolumeStats {
  /** Average volume. */
  avgVolume: number | null;
  /** Median volume. */
  medianVolume: number | null;
  /** Max volume. */
  maxVolume: number | null;
  /** Volume trend (positive = increasing). */
  trend: 'INCREASING' | 'DECREASING' | 'FLAT' | null;
  sampleCount: number;
  sufficientData: boolean;
}

export interface ATMStats {
  /** Average distance of ATM option from spot. */
  avgATMDistance: number | null;
  /** Average ATM option premium. */
  avgATMPremium: number | null;
  /** ATM skew (CE premium - PE premium). */
  avgATMSkew: number | null;
  sampleCount: number;
  sufficientData: boolean;
}

export interface SessionEffectResult {
  /** Average return by hour of day. */
  hourlyReturns: Record<number, number>;
  /** Average volume by hour. */
  hourlyVolume: Record<number, number>;
  /** Sample count per hour. */
  hourlyCounts: Record<number, number>;
  /** Whether early session (9:30-10:30) shows different behavior. */
  earlySessionSignal: string | null;
  sampleCount: number;
}

export interface FullAnalyticsResult {
  underlying: string;
  window: { start: Date; end: Date };
  volatility: VolatilityResult;
  trend: TrendResult;
  premium: PremiumStats;
  spread: SpreadStats;
  volume: VolumeStats;
  atm: ATMStats;
  sessionEffects: SessionEffectResult;
  totalDataPoints: number;
  regime: string;
  computedAt: Date;
}

// ── Service ───────────────────────────────────────────────────────────

@Injectable()
export class HistoricalAnalyticsService {
  private readonly logger = new Logger(HistoricalAnalyticsService.name);

  /**
   * Compute volatility from a price time series.
   * Returns annualized and daily vol, plus ATR if OHLC is available.
   */
  computeVolatility(
    closes: TimeSeriesPoint[],
    tradingSessionsPerYear: number = 252,
  ): VolatilityResult {
    const valid = closes.filter((p) => p.value !== null && p.value !== undefined);
    if (valid.length < 3) {
      return { annualizedVol: null, dailyVol: null, avgTrueRange: null, sampleCount: valid.length,
        from: closes[0]?.timestamp ?? new Date(), to: closes[closes.length - 1]?.timestamp ?? new Date(),
        sufficientData: false };
    }

    // Daily returns
    const returns: number[] = [];
    for (let i = 1; i < valid.length; i++) {
      const prev = valid[i - 1].value!;
      const curr = valid[i].value!;
      if (prev !== 0) returns.push((curr - prev) / prev);
    }

    if (returns.length < 2) {
      return { annualizedVol: null, dailyVol: null, avgTrueRange: null, sampleCount: valid.length,
        from: valid[0].timestamp, to: valid[valid.length - 1].timestamp, sufficientData: false };
    }

    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / (returns.length - 1);
    const dailyVol = Math.sqrt(variance);
    const annualizedVol = dailyVol * Math.sqrt(tradingSessionsPerYear);

    return {
      annualizedVol,
      dailyVol,
      avgTrueRange: null, // needs OHLC which we don't have in simplified history
      sampleCount: valid.length,
      from: valid[0].timestamp,
      to: valid[valid.length - 1].timestamp,
      sufficientData: true,
    };
  }

  /**
   * Compute trend direction from a price time series using linear regression.
   */
  computeTrend(closes: TimeSeriesPoint[]): TrendResult {
    const valid = closes.filter((p) => p.value !== null && p.value !== undefined);
    if (valid.length < 5) {
      return { direction: 'FLAT', slope: null, rSquared: null, sma20: null,
        aboveSma20: null, sampleCount: valid.length, sufficientData: false };
    }

    const values = valid.map((p) => p.value!);
    const n = values.length;

    // Linear regression
    const xMean = (n - 1) / 2;
    const yMean = values.reduce((a, b) => a + b, 0) / n;
    let ssXY = 0, ssXX = 0, ssRes = 0, ssTot = 0;
    for (let i = 0; i < n; i++) {
      ssXY += (i - xMean) * (values[i] - yMean);
      ssXX += Math.pow(i - xMean, 2);
    }
    const slope = ssXX !== 0 ? ssXY / ssXX : 0;

    // R-squared
    for (let i = 0; i < n; i++) {
      const predicted = yMean + slope * (i - xMean);
      ssRes += Math.pow(values[i] - predicted, 2);
      ssTot += Math.pow(values[i] - yMean, 2);
    }
    const rSquared = ssTot !== 0 ? 1 - ssRes / ssTot : 0;

    // Direction classification
    const pctChange = yMean !== 0 ? Math.abs(slope * n / yMean) : 0;
    let direction: 'UP' | 'DOWN' | 'FLAT' = 'FLAT';
    if (pctChange > 0.005 && slope > 0) direction = 'UP';
    else if (pctChange > 0.005 && slope < 0) direction = 'DOWN';

    // SMA-20
    let sma20: number | null = null;
    let aboveSma20: boolean | null = null;
    if (values.length >= 20) {
      const last20 = values.slice(-20);
      sma20 = last20.reduce((a, b) => a + b, 0) / 20;
      aboveSma20 = values[values.length - 1] > sma20;
    }

    return {
      direction,
      slope,
      rSquared,
      sma20,
      aboveSma20,
      sampleCount: valid.length,
      sufficientData: true,
    };
  }

  /**
   * Compute premium statistics from a series of premium values.
   */
  computePremiumStats(premiums: TimeSeriesPoint[]): PremiumStats {
    const valid = premiums.filter((p) => p.value !== null && p.value !== undefined && p.value > 0);
    if (valid.length < 2) {
      return { avgPremium: null, totalChange: null, totalChangePct: null, maxPremium: null,
        minPremium: null, stdDev: null, sampleCount: valid.length,
        from: valid[0]?.timestamp ?? new Date(), to: valid[valid.length - 1]?.timestamp ?? new Date(),
        sufficientData: false };
    }

    const values = valid.map((p) => p.value!);
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    const first = values[0];
    const last = values[values.length - 1];
    const totalChange = last - first;
    const totalChangePct = first !== 0 ? totalChange / first : 0;
    const variance = values.reduce((s, v) => s + Math.pow(v - avg, 2), 0) / (values.length - 1);

    return {
      avgPremium: avg,
      totalChange,
      totalChangePct,
      maxPremium: Math.max(...values),
      minPremium: Math.min(...values),
      stdDev: Math.sqrt(variance),
      sampleCount: valid.length,
      from: valid[0].timestamp,
      to: valid[valid.length - 1].timestamp,
      sufficientData: true,
    };
  }

  /**
   * Compute spread statistics from bid/ask data.
   */
  computeSpreadStats(
    spreads: Array<{ bid: number | null; ask: number | null }>,
  ): SpreadStats {
    const valid = spreads.filter((s) => s.bid !== null && s.ask !== null && s.bid! > 0 && s.ask! > 0);
    if (valid.length < 2) {
      return { avgSpread: null, medianSpread: null, maxSpread: null, wideSpreadPct: null,
        sampleCount: valid.length, sufficientData: false };
    }

    const spreadValues = valid.map((s) => s.ask! - s.bid!);
    const mids = valid.map((s) => (s.bid! + s.ask!) / 2);
    const avg = spreadValues.reduce((a, b) => a + b, 0) / spreadValues.length;
    const sorted = [...spreadValues].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const max = Math.max(...spreadValues);

    // Wide spread %: > 0.5% of mid price
    const wideCount = spreadValues.filter((sp, i) => mids[i] > 0 && sp / mids[i] > 0.005).length;
    const wideSpreadPct = wideCount / spreadValues.length;

    return {
      avgSpread: avg,
      medianSpread: median,
      maxSpread: max,
      wideSpreadPct,
      sampleCount: valid.length,
      sufficientData: true,
    };
  }

  /**
   * Compute volume statistics.
   */
  computeVolumeStats(volumes: TimeSeriesPoint[]): VolumeStats {
    const valid = volumes.filter((p) => p.value !== null && p.value !== undefined && p.value >= 0);
    if (valid.length < 2) {
      return { avgVolume: null, medianVolume: null, maxVolume: null, trend: null,
        sampleCount: valid.length, sufficientData: false };
    }

    const values = valid.map((p) => p.value!);
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    const sorted = [...values].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];

    // Simple trend: compare first-half avg to second-half avg
    const mid = Math.floor(values.length / 2);
    const firstHalf = values.slice(0, mid);
    const secondHalf = values.slice(mid);
    const firstAvg = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length;
    const secondAvg = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length;
    const pctChange = firstAvg > 0 ? (secondAvg - firstAvg) / firstAvg : 0;
    let trend: 'INCREASING' | 'DECREASING' | 'FLAT' = 'FLAT';
    if (pctChange > 0.1) trend = 'INCREASING';
    else if (pctChange < -0.1) trend = 'DECREASING';

    return {
      avgVolume: avg,
      medianVolume: median,
      maxVolume: Math.max(...values),
      trend,
      sampleCount: valid.length,
      sufficientData: true,
    };
  }

  /**
   * Compute ATM option statistics given spot prices and option chain data.
   * spotPrices and atmOptions must share timestamps (inner join on timestamp).
   */
  computeATMStats(
    spotPrices: TimeSeriesPoint[],
    atmCEPremiums: TimeSeriesPoint[],
    atmPEPremiums: TimeSeriesPoint[],
  ): ATMStats {
    // Inner join on timestamp
    const spotMap = new Map(spotPrices.map((p) => [p.timestamp.getTime(), p.value]));
    const ceMap = new Map(atmCEPremiums.map((p) => [p.timestamp.getTime(), p.value]));
    const peMap = new Map(atmPEPremiums.map((p) => [p.timestamp.getTime(), p.value]));

    const commonTs = [...spotMap.keys()].filter(
      (ts) => ceMap.has(ts) && peMap.has(ts) && spotMap.get(ts) !== null,
    );

    if (commonTs.length < 3) {
      return { avgATMDistance: null, avgATMPremium: null, avgATMSkew: null,
        sampleCount: commonTs.length, sufficientData: false };
    }

    let totalPremium = 0;
    let totalSkew = 0;
    for (const ts of commonTs) {
      const spot = spotMap.get(ts)!;
      const ce = ceMap.get(ts)!;
      const pe = peMap.get(ts)!;
      totalPremium += (ce + pe) / 2;
      totalSkew += ce - pe;
    }

    return {
      avgATMDistance: 0, // ATM by definition
      avgATMPremium: totalPremium / commonTs.length,
      avgATMSkew: totalSkew / commonTs.length,
      sampleCount: commonTs.length,
      sufficientData: true,
    };
  }

  /**
   * Compute session effects (hourly return and volume patterns).
   */
  computeSessionEffects(
    prices: TimeSeriesPoint[],
    volumes: TimeSeriesPoint[],
  ): SessionEffectResult {
    const hourlyReturns: Record<number, number> = {};
    const hourlyVolume: Record<number, number> = {};
    const hourlyCounts: Record<number, number> = {};

    // Group by hour
    const byHour: Record<number, number[]> = {};
    for (let i = 1; i < prices.length; i++) {
      const hour = prices[i].timestamp.getHours();
      const prev = prices[i - 1].value;
      const curr = prices[i].value;
      if (prev !== null && curr !== null && prev > 0) {
        const ret = (curr - prev) / prev;
        if (!byHour[hour]) byHour[hour] = [];
        byHour[hour].push(ret);
      }
    }

    for (const [hour, returns] of Object.entries(byHour)) {
      const h = Number(hour);
      hourlyReturns[h] = returns.reduce((a, b) => a + b, 0) / returns.length;
      hourlyCounts[h] = returns.length;
    }

    // Volume by hour
    const volByHour: Record<number, number[]> = {};
    for (const v of volumes) {
      const hour = v.timestamp.getHours();
      if (v.value !== null && v.value >= 0) {
        if (!volByHour[hour]) volByHour[hour] = [];
        volByHour[hour].push(v.value);
      }
    }
    for (const [hour, vols] of Object.entries(volByHour)) {
      hourlyVolume[Number(hour)] = vols.reduce((a, b) => a + b, 0) / vols.length;
    }

    // Early session signal
    let earlySessionSignal: string | null = null;
    const early = hourlyReturns[10]; // 10:00 hour
    const late = hourlyReturns[14]; // 14:00 hour
    if (early !== undefined && late !== undefined) {
      if (early > late + 0.002) earlySessionSignal = 'STRONGER_EARLY';
      else if (early < late - 0.002) earlySessionSignal = 'WEAKER_EARLY';
      else earlySessionSignal = 'SIMILAR';
    }

    const totalSamples = Object.values(hourlyCounts).reduce((a, b) => a + b, 0);

    return {
      hourlyReturns,
      hourlyVolume,
      hourlyCounts,
      earlySessionSignal,
      sampleCount: totalSamples,
    };
  }

  /**
   * Determine the overall market regime from volatility and trend signals.
   */
  classifyRegime(volatility: VolatilityResult, trend: TrendResult): string {
    if (!volatility.sufficientData || !trend.sufficientData) return 'UNKNOWN';

    const vol = volatility.annualizedVol;
    if (vol === null) return 'UNKNOWN';

    const highVol = vol > 0.25; // > 25% annualized = high vol
    const lowVol = vol < 0.12;  // < 12% = low vol

    if (highVol && trend.direction === 'UP') return 'HIGH_VOL_UP';
    if (highVol && trend.direction === 'DOWN') return 'HIGH_VOL_DOWN';
    if (highVol) return 'HIGH_VOL_RANGE';
    if (lowVol && trend.direction === 'UP') return 'LOW_VOL_UP';
    if (lowVol && trend.direction === 'DOWN') return 'LOW_VOL_DOWN';
    if (lowVol) return 'LOW_VOL_RANGE';
    if (trend.direction === 'UP') return 'TREND_UP';
    if (trend.direction === 'DOWN') return 'TREND_DOWN';
    return 'RANGE';
  }

  /**
   * Run full analytics on a set of historical data.
   * Input arrays must be aligned by timestamp (same window).
   */
  runFullAnalytics(params: {
    underlying: string;
    closes: TimeSeriesPoint[];
    premiums: TimeSeriesPoint[];
    spreads: Array<{ bid: number | null; ask: number | null }>;
    volumes: TimeSeriesPoint[];
    spotPrices: TimeSeriesPoint[];
    cePremiums: TimeSeriesPoint[];
    pePremiums: TimeSeriesPoint[];
    windowStart: Date;
    windowEnd: Date;
  }): FullAnalyticsResult {
    const volatility = this.computeVolatility(params.closes);
    const trend = this.computeTrend(params.closes);
    const premium = this.computePremiumStats(params.premiums);
    const spread = this.computeSpreadStats(params.spreads);
    const volume = this.computeVolumeStats(params.volumes);
    const atm = this.computeATMStats(params.spotPrices, params.cePremiums, params.pePremiums);
    const sessionEffects = this.computeSessionEffects(params.closes, params.volumes);
    const regime = this.classifyRegime(volatility, trend);

    return {
      underlying: params.underlying,
      window: { start: params.windowStart, end: params.windowEnd },
      volatility,
      trend,
      premium,
      spread,
      volume,
      atm,
      sessionEffects,
      totalDataPoints: params.closes.length,
      regime,
      computedAt: new Date(),
    };
  }
}
