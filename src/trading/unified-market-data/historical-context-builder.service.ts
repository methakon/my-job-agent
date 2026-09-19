
import { Injectable, Logger } from '@nestjs/common';
import { HistoricalResearchService, HistoryWindow } from './historical-research.service';
import {
  HistoricalAnalyticsService,
  VolatilityResult,
  TrendResult,
  PremiumStats,
  SpreadStats,
  VolumeStats,
  SessionEffectResult,
} from './historical-analytics.service';
import { UnifiedMarketDataService } from './unified-market-data.service';
import { AdaptationCandidate } from '../research/adaptation-candidate.entity';

/**
 * Combines CURRENT market state with PRECOMPUTED HISTORICAL context
 * into a single ResearchContext object for the trading hot path.
 *
 * CRITICAL CONSTRAINTS:
 * - Historical data must NOT be queried per-tick.
 * - This builder uses CACHED precomputed context (set during off-hours).
 * - During trading hours, the hot path calls getResearchContext()
 *   which returns the precomputed context — no DB queries.
 * - The builder's computeHistoricalContext() runs OFF-HOURS ONLY.
 *
 * The resulting ResearchContext is versioned, timestamped, and validated
 * before the next session uses it.
 */

// ── Types ─────────────────────────────────────────────────────────────

export interface CurrentMarketState {
  /** Latest option quotes (all tracked instruments). */
  latestQuotes: Map<string, any>;
  /** Latest index snapshot. */
  latestSnapshot: any;
  /** Current bid-ask spread. */
  currentSpread: number | null;
  /** Current liquidity (volume). */
  currentLiquidity: number | null;
  /** Current option chain state (CE/PE/ATM). */
  optionChainState: {
    atmStrike: number | null;
    cePremium: number | null;
    pePremium: number | null;
    skew: number | null;
    totalPremium: number | null;
  };
}

export interface HistoricalResearchContext {
  /** Recent volatility regime (from historical snapshots). */
  volatility: VolatilityResult;
  /** Historical trend (from historical snapshots). */
  trend: TrendResult;
  /** Historical premium behavior (from historical quotes). */
  premiumBehavior: PremiumStats;
  /** Historical spread behavior. */
  spreadBehavior: SpreadStats;
  /** Historical volume behavior. */
  volumeBehavior: VolumeStats;
  /** Session effects (hourly patterns). */
  sessionEffects: SessionEffectResult;
  /** Detected regime (e.g. TREND_UP, HIGH_VOL_DOWN, RANGE). */
  regime: string;
  /** Window analyzed. */
  window: { start: Date; end: Date };
  /** Sample count used. */
  totalDataPoints: number;
  /** Computation timestamp. */
  computedAt: Date;
  /** Whether context is stale (> 24h old). */
  isStale: boolean;
}

export interface PatternStatistics {
  /** Pattern signal frequency. */
  frequency: Record<string, number>;
  /** Pattern win rates by outcome. */
  winRates: Record<string, number>;
  /** Outcome distribution. */
  outcomeDistribution: Record<string, number>;
  /** Sample counts. */
  sampleCounts: Record<string, number>;
  computedAt: Date;
}

export interface StrategyPerformance {
  /** Overall performance metrics. */
  overall: { winRate: number; expectancy: number; netPnl: number; tradeCount: number };
  /** Performance by decay algo. */
  byAlgo: Record<string, { winRate: number; expectancy: number; count: number }>;
  /** Performance by day of week. */
  byDayOfWeek: Record<number, { winRate: number; expectancy: number; count: number }>;
  /** Performance by regime. */
  byRegime: Record<string, { winRate: number; expectancy: number; count: number }>;
  computedAt: Date;
}

export interface ApprovedAdaptationContext {
  /** Active decay parameters. */
  decayRate: number;
  /** Active timing window. */
  timingWindowMinutes: number;
  /** Active confidence threshold. */
  confidenceThreshold: number;
  /** Additional active params. */
  additionalParams: Record<string, any>;
  /** Candidate history count. */
  totalActivated: number;
  lastActivatedAt: Date | null;
}

export interface ResearchContext {
  /** Current market snapshot. */
  current: CurrentMarketState;
  /** Historical research context (precomputed off-hours). */
  historical: HistoricalResearchContext;
  /** Pattern statistics (precomputed off-hours). */
  patterns: PatternStatistics;
  /** Strategy performance (precomputed off-hours). */
  performance: StrategyPerformance;
  /** Active approved adaptations. */
  adaptations: ApprovedAdaptationContext;
  /** Context version (incremented each off-hours compute). */
  version: number;
  /** When this context was computed. */
  computedAt: Date;
  /** Whether the context is considered fresh for trading. */
  isFresh: boolean;
}

// ── Service ───────────────────────────────────────────────────────────

@Injectable()
export class HistoricalContextBuilderService {
  private readonly logger = new Logger(HistoricalContextBuilderService.name);

  /** Cached precomputed context — set during off-hours, read during trading. */
  private cachedContext: ResearchContext | null = null;
  /** Context version counter. */
  private contextVersion = 0;

  constructor(
    private readonly historicalResearch: HistoricalResearchService,
    private readonly analytics: HistoricalAnalyticsService,
    private readonly unifiedData: UnifiedMarketDataService,
  ) {}

  // ── Hot-path method (trading hours) ─────────────────────────────────

  /**
   * Get the current research context.
   * Returns the precomputed cached context — NO database queries.
   * Returns null if no context has been computed yet.
   */
  getResearchContext(): ResearchContext | null {
    return this.cachedContext;
  }

  /**
   * Build current market state from the live cache.
   * This is cheap — reads only from in-memory maps.
   */
  getCurrentMarketState(): CurrentMarketState {
    const latestQuotes = this.unifiedData.listLatestQuotes();
    const latestSnapshot = this.unifiedData.listLatestSnapshots();

    // Build quote map
    const quoteMap = new Map<string, any>();
    for (const q of latestQuotes) {
      quoteMap.set(q.instrumentKey, q);
    }

    // Get NIFTY snapshot (or first available)
    const niftySnapshot = latestSnapshot.find((s) => s.symbol?.includes('NIFTY')) ?? latestSnapshot[0] ?? null;

    // Option chain state from ATM quotes
    const atmQuotes = latestQuotes.filter((q) => {
      if (!q.instrumentKey || !niftySnapshot) return false;
      const ltp = Number(niftySnapshot.ltp ?? 0);
      const strike = Number(q.strike ?? 0);
      return Math.abs(strike - ltp) < ltp * 0.02; // within 2% of ATM
    });

    const ceATM = atmQuotes.find((q) => q.optionType === 'CE');
    const peATM = atmQuotes.find((q) => q.optionType === 'PE');
    const cePremium = ceATM ? Number(ceATM.ltp ?? 0) : null;
    const pePremium = peATM ? Number(peATM.ltp ?? 0) : null;

    return {
      latestQuotes: quoteMap,
      latestSnapshot: niftySnapshot,
      currentSpread: this.computeCurrentSpread(latestQuotes),
      currentLiquidity: this.computeCurrentLiquidity(latestQuotes),
      optionChainState: {
        atmStrike: ceATM?.strike ?? peATM?.strike ?? null,
        cePremium,
        pePremium,
        skew: cePremium !== null && pePremium !== null ? cePremium - pePremium : null,
        totalPremium: cePremium !== null && pePremium !== null ? cePremium + pePremium : null,
      },
    };
  }

  private computeCurrentSpread(quotes: any[]): number | null {
    const spreads = quotes
      .filter((q) => q.bid != null && q.ask != null && Number(q.bid) > 0 && Number(q.ask) > 0)
      .map((q) => Number(q.ask) - Number(q.bid));
    return spreads.length > 0 ? spreads.reduce((a, b) => a + b, 0) / spreads.length : null;
  }

  private computeCurrentLiquidity(quotes: any[]): number | null {
    const volumes = quotes.map((q) => Number(q.volume ?? 0)).filter((v) => v > 0);
    return volumes.length > 0 ? volumes.reduce((a, b) => a + b, 0) / volumes.length : null;
  }

  // ── Off-hours computation (MUST NOT be called during trading) ───────

  /**
   * Compute historical context from history tables.
   * Call this OFF-HOURS ONLY (after 16:00 IST, before next session).
   */
  async computeHistoricalContext(underlying: string, daysBack: number = 20): Promise<HistoricalResearchContext> {
    const now = new Date();
    const window = this.historicalResearch.buildWindow(now, daysBack);

    // Fetch historical data
    const [quotes, snapshots] = await Promise.all([
      this.historicalResearch.getQuoteWindow(window, { underlying, limit: 5000 }),
      this.historicalResearch.getSnapshotWindow(window, { limit: 5000 }),
    ]);

    // Convert to time series for analytics
    const closes = snapshots
      .filter((s) => s.ltp != null && Number(s.ltp) > 0)
      .map((s) => ({ timestamp: s.receivedTimestamp, value: Number(s.ltp) }));

    const premiums = quotes
      .filter((q) => q.ltp != null && Number(q.ltp) > 0)
      .map((q) => ({ timestamp: q.receivedTimestamp, value: Number(q.ltp) }));

    const spreads = quotes
      .filter((q) => q.bid != null && q.ask != null && Number(q.bid) > 0 && Number(q.ask) > 0)
      .map((q) => ({ bid: Number(q.bid), ask: Number(q.ask) }));

    const volumes = quotes
      .filter((q) => q.volume != null && Number(q.volume) >= 0)
      .map((q) => ({ timestamp: q.receivedTimestamp, value: Number(q.volume) }));

    // ATM CE/PE premiums (separate streams)
    const cePremiums = quotes
      .filter((q) => q.optionType === 'CE' && q.ltp != null && Number(q.ltp) > 0)
      .map((q) => ({ timestamp: q.receivedTimestamp, value: Number(q.ltp) }));

    const pePremiums = quotes
      .filter((q) => q.optionType === 'PE' && q.ltp != null && Number(q.ltp) > 0)
      .map((q) => ({ timestamp: q.receivedTimestamp, value: Number(q.ltp) }));

    const spotPrices = snapshots
      .filter((s) => s.ltp != null && Number(s.ltp) > 0)
      .map((s) => ({ timestamp: s.receivedTimestamp, value: Number(s.ltp) }));

    // Run analytics
    const result = this.analytics.runFullAnalytics({
      underlying,
      closes,
      premiums,
      spreads,
      volumes,
      spotPrices,
      cePremiums,
      pePremiums,
      windowStart: window.start,
      windowEnd: window.end,
    });

    const age = now.getTime() - result.computedAt.getTime();
    const isStale = age > 24 * 60 * 60 * 1000; // > 24 hours

    return {
      volatility: result.volatility,
      trend: result.trend,
      premiumBehavior: result.premium,
      spreadBehavior: result.spread,
      volumeBehavior: result.volume,
      sessionEffects: result.sessionEffects,
      regime: result.regime,
      window: result.window,
      totalDataPoints: result.totalDataPoints,
      computedAt: result.computedAt,
      isStale,
    };
  }

  /**
   * Build pattern statistics from pattern engine data.
   * Reads pattern_signals table (off-hours).
   */
  async computePatternStatistics(): Promise<PatternStatistics> {
    // Placeholder — will be populated when pattern engine integration is added.
    // For now return empty stats with timestamp.
    return {
      frequency: {},
      winRates: {},
      outcomeDistribution: {},
      sampleCounts: {},
      computedAt: new Date(),
    };
  }

  /**
   * Build strategy performance from trade data.
   * Reads fnf_trades table (off-hours).
   */
  async computeStrategyPerformance(): Promise<StrategyPerformance> {
    // This will be populated from fnf_trades data in the off-hours worker.
    // For now return empty metrics.
    const empty = { winRate: 0, expectancy: 0, netPnl: 0, tradeCount: 0 };
    return {
      overall: empty,
      byAlgo: {},
      byDayOfWeek: {},
      byRegime: {},
      computedAt: new Date(),
    };
  }

  /**
   * Build adaptation context from active candidates.
   */
  async buildAdaptationContext(activeCandidates: AdaptationCandidate[]): Promise<ApprovedAdaptationContext> {
    let decayRate = 0.05;
    let timingWindowMinutes = 30;
    let confidenceThreshold = 0.5;
    const additionalParams: Record<string, any> = {};

    for (const c of activeCandidates) {
      switch (c.paramName) {
        case 'decayRate': decayRate = Number(c.proposedValue); break;
        case 'timingWindowMinutes': timingWindowMinutes = Number(c.proposedValue); break;
        case 'confidenceThreshold': confidenceThreshold = Number(c.proposedValue); break;
        default: additionalParams[c.paramName] = c.proposedValue; break;
      }
    }

    const activated = activeCandidates.filter((c) => c.activatedAt !== null);
    return {
      decayRate,
      timingWindowMinutes,
      confidenceThreshold,
      additionalParams,
      totalActivated: activeCandidates.length,
      lastActivatedAt: activated.length > 0
        ? new Date(Math.max(...activated.map((c) => c.activatedAt!.getTime())))
        : null,
    };
  }

  // ── Context assembly ────────────────────────────────────────────────

  /**
   * Full off-hours context assembly. Call this ONCE after market close.
   * Updates the cached context for next session consumption.
   */
  async assembleContext(
    underlying: string,
    activeCandidates: AdaptationCandidate[],
  ): Promise<ResearchContext> {
    const [historical, patterns, performance] = await Promise.all([
      this.computeHistoricalContext(underlying),
      this.computePatternStatistics(),
      this.computeStrategyPerformance(),
    ]);

    const adaptations = await this.buildAdaptationContext(activeCandidates);

    this.contextVersion++;
    const now = new Date();

    this.cachedContext = {
      current: this.getCurrentMarketState(), // will be empty off-hours, that's fine
      historical,
      patterns,
      performance,
      adaptations,
      version: this.contextVersion,
      computedAt: now,
      isFresh: true,
    };

    this.logger.log(
      `Context assembled v${this.contextVersion}: regime=${historical.regime}, ` +
      `dataPoints=${historical.totalDataPoints}, ` +
      `adaptations=${activeCandidates.length}`,
    );

    return this.cachedContext;
  }

  /** Get current context version (for health checks). */
  getContextVersion(): number {
    return this.contextVersion;
  }

  /** Force-invalidate cached context (e.g. on migration or error). */
  invalidateContext(): void {
    this.cachedContext = null;
    this.logger.warn('Context cache invalidated');
  }
}
