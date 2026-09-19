
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ResearchResult } from './research-result.entity';
import { AdaptationCandidate } from './adaptation-candidate.entity';
import { HistoricalResearchService } from '../unified-market-data/historical-research.service';
import { HistoricalAnalyticsService, FullAnalyticsResult } from '../unified-market-data/historical-analytics.service';
import { HistoricalContextBuilderService } from '../unified-market-data/historical-context-builder.service';
import { ValidationEngineService, TradeRecord } from './validation-engine.service';
import { AdaptationEngineService } from './adaptation-engine.service';
import { UnifiedMarketDataService } from '../unified-market-data/unified-market-data.service';
import { v4 as uuid } from 'uuid';

/**
 * Off-Hours Research Worker — runs after market close (16:00+ IST).
 *
 * Orchestrates the full post-market analysis pipeline:
 * 1. Identify completed trading session
 * 2. Collect today's trade outcomes
 * 3. Collect today's market observations
 * 4. Compare against historical regimes
 * 5. Analyze pattern outcomes
 * 6. Evaluate current decay calibration
 * 7. Calculate strategy-level metrics
 * 8. Identify candidate improvements
 * 9. Store research result
 * 10. Produce deterministic research report
 * 11. Assemble next-session context
 *
 * OUTPUT is STORED in research_results table — not merely logged.
 */

// ── Types ─────────────────────────────────────────────────────────────

export interface SessionTradeSummary {
  totalTrades: number;
  winners: number;
  losers: number;
  winRate: number;
  netPnl: number;
  avgPnl: number;
  byAlgo: Record<string, { count: number; winRate: number; netPnl: number }>;
}

export interface ResearchReport {
  sessionId: string;
  sessionDate: string;
  underlying: string;
  tradeSummary: SessionTradeSummary;
  marketRegime: string;
  patternAnalysis: Record<string, any>;
  decayCalibrationEvaluation: Record<string, any>;
  strategyMetrics: Record<string, any>;
  candidateImprovements: string[];
  researchResultId: string;
  computedAt: Date;
}

// ── Service ───────────────────────────────────────────────────────────

@Injectable()
export class OffHoursResearchService {
  private readonly logger = new Logger(OffHoursResearchService.name);

  /** Whether research is currently running. */
  private researchRunning = false;

  constructor(
    @InjectRepository(ResearchResult)
    private readonly researchResults: Repository<ResearchResult>,
    @InjectRepository(AdaptationCandidate)
    private readonly candidates: Repository<AdaptationCandidate>,
    private readonly historicalResearch: HistoricalResearchService,
    private readonly analytics: HistoricalAnalyticsService,
    private readonly contextBuilder: HistoricalContextBuilderService,
    private readonly validationEngine: ValidationEngineService,
    private readonly adaptationEngine: AdaptationEngineService,
    private readonly unifiedData: UnifiedMarketDataService,
  ) {}

  // ── Main entry point ────────────────────────────────────────────────

  /**
   * Run the full off-hours research pipeline.
   * Call once after market close (16:00+ IST).
   * Idempotent — will skip if already running.
   */
  async runDailyResearch(
    underlying: string,
    sessionDate: string,
    trades: TradeRecord[],
  ): Promise<ResearchReport> {
    if (this.researchRunning) {
      this.logger.warn('Research already running — skipping duplicate call');
      throw new Error('Research already running');
    }

    this.researchRunning = true;
    const startTime = Date.now();

    try {
      this.logger.log(`=== OFF-HOURS RESEARCH START: ${sessionDate} | ${underlying} ===`);

      // Step 1-2: Trade outcomes summary
      const tradeSummary = this.summarizeTrades(trades);
      this.logger.log(`Trades: ${tradeSummary.totalTrades} total, ${tradeSummary.winners} winners, PnL: ${tradeSummary.netPnl.toFixed(2)}`);

      // Step 3: Historical market analysis
      const window = this.historicalResearch.buildWindow(new Date(), 20);
      const [quoteAggs, snapshotAggs, quoteCount, snapshotCount] = await Promise.all([
        this.historicalResearch.getQuoteAggregates(window, underlying),
        this.historicalResearch.getSnapshotAggregates(window),
        this.historicalResearch.countQuotes(window, underlying),
        this.historicalResearch.countSnapshots(window),
      ]);

      this.logger.log(`Historical data: ${quoteCount} quotes, ${snapshotCount} snapshots`);

      // Step 4: Compute analytics
      let regime = 'UNKNOWN';
      let analyticsResult: FullAnalyticsResult | null = null;

      if (snapshotCount > 10) {
        const ctx = await this.contextBuilder.computeHistoricalContext(underlying, 20);
        regime = ctx.regime;
        analyticsResult = {
          underlying,
          window: ctx.window,
          volatility: ctx.volatility,
          trend: ctx.trend,
          premium: ctx.premiumBehavior,
          spread: ctx.spreadBehavior,
          volume: ctx.volumeBehavior,
          atm: { avgATMDistance: null, avgATMPremium: null, avgATMSkew: null, sampleCount: 0, sufficientData: false },
          sessionEffects: ctx.sessionEffects,
          totalDataPoints: ctx.totalDataPoints,
          regime: ctx.regime,
          computedAt: ctx.computedAt,
        };
        this.logger.log(`Regime: ${regime}, data points: ${ctx.totalDataPoints}`);
      } else {
        this.logger.warn('Insufficient snapshot data for regime analysis');
      }

      // Step 5: Pattern analysis (placeholder — populated when pattern integration added)
      const patternAnalysis = {
        status: 'PENDING_INTEGRATION',
        message: 'Pattern engine integration scheduled for L3',
      };

      // Step 6: Decay calibration evaluation
      const decayEval = this.evaluateDecayCalibration(trades);
      this.logger.log(`Decay evaluation: ${JSON.stringify(decayEval)}`);

      // Step 7: Strategy metrics
      const strategyMetrics = this.computeDetailedStrategyMetrics(trades, regime);

      // Step 8: Candidate improvements
      const candidates = this.identifyCandidateImprovements(
        tradeSummary, decayEval, strategyMetrics, regime, sessionDate,
      );
      this.logger.log(`Candidates identified: ${candidates.length}`);

      // Step 9: Store research result
      const researchResult = this.researchResults.create({
        sessionDate,
        underlying,
        sampleCount: tradeSummary.totalTrades,
        metrics: {
          tradeSummary,
          decayEvaluation: decayEval,
          strategyMetrics,
          quoteAggregates: quoteAggs.length,
          snapshotAggregates: snapshotAggs.length,
        },
        detectedRegime: regime,
        patterns: patternAnalysis,
        candidateChanges: candidates,
        baselineMetrics: strategyMetrics,
        candidateMetrics: null,
        validationStatus: 'PROPOSED',
        researchVersion: 1,
      });

      const saved = await this.researchResults.save(researchResult);

      // Step 10: Propose adaptation candidates (if any)
      for (const candidate of candidates) {
        try {
          await this.adaptationEngine.propose({
            paramName: candidate.paramName,
            paramCategory: candidate.category,
            oldValue: candidate.currentValue,
            proposedValue: candidate.proposedValue,
            reason: candidate.reason,
            evidenceIds: [saved.id],
            researchResultId: saved.id,
          });
        } catch (err) {
          this.logger.warn(`Candidate proposal blocked: ${candidate.paramName} — ${err}`);
        }
      }

      // Step 11: Assemble next-session context
      const activeCandidates = await this.candidates.find({
        where: { status: 'ACTIVE' },
      });
      await this.contextBuilder.assembleContext(underlying, activeCandidates);

      const duration = Date.now() - startTime;

      this.logger.log(
        `=== OFF-HOURS RESEARCH COMPLETE: ${sessionDate} | ` +
        `${duration}ms | regime=${regime} | ` +
        `candidates=${candidates.length} | researchId=${saved.id} ===`,
      );

      return {
        sessionId: saved.id,
        sessionDate,
        underlying,
        tradeSummary,
        marketRegime: regime,
        patternAnalysis,
        decayCalibrationEvaluation: decayEval,
        strategyMetrics,
        candidateImprovements: candidates.map((c) => `${c.paramName}: ${c.reason}`),
        researchResultId: saved.id,
        computedAt: new Date(),
      };
    } finally {
      this.researchRunning = false;
    }
  }

  // ── Trade summarization ─────────────────────────────────────────────

  private summarizeTrades(trades: TradeRecord[]): SessionTradeSummary {
    const closed = trades.filter((t) => t.closedAt !== null);
    const winners = closed.filter((t) => t.netPnl > 0);
    const losers = closed.filter((t) => t.netPnl <= 0);
    const netPnl = closed.reduce((s, t) => s + t.netPnl, 0);

    const byAlgo: Record<string, { count: number; winRate: number; netPnl: number }> = {};
    for (const t of closed) {
      const src = t.entrySource ?? 'unknown';
      if (!byAlgo[src]) byAlgo[src] = { count: 0, winRate: 0, netPnl: 0 };
      byAlgo[src].count++;
      byAlgo[src].netPnl += t.netPnl;
    }
    for (const [src, m] of Object.entries(byAlgo)) {
      const srcTrades = closed.filter((t) => t.entrySource === src);
      const srcWinners = srcTrades.filter((t) => t.netPnl > 0);
      m.winRate = srcTrades.length > 0 ? (srcWinners.length / srcTrades.length) * 100 : 0;
    }

    return {
      totalTrades: closed.length,
      winners: winners.length,
      losers: losers.length,
      winRate: closed.length > 0 ? (winners.length / closed.length) * 100 : 0,
      netPnl,
      avgPnl: closed.length > 0 ? netPnl / closed.length : 0,
      byAlgo,
    };
  }

  // ── Decay calibration evaluation ────────────────────────────────────

  private evaluateDecayCalibration(trades: TradeRecord[]): Record<string, any> {
    if (trades.length < 3) {
      return { status: 'INSUFFICIENT_DATA', tradeCount: trades.length };
    }

    // Check if recent trades suggest decay timing is too aggressive or too lax
    const closed = trades.filter((t) => t.closedAt !== null && t.closedAt !== undefined);
    if (closed.length < 3) {
      return { status: 'INSUFFICIENT_CLOSED_TRADES', closedCount: closed.length };
    }

    // Holding period analysis
    const holdingMinutes = closed.map((t) =>
      (t.closedAt!.getTime() - t.orderedAt.getTime()) / 60000,
    );
    const avgHolding = holdingMinutes.reduce((a, b) => a + b, 0) / holdingMinutes.length;

    // Short exits vs long exits
    const shortExits = holdingMinutes.filter((h) => h < 15).length;
    const longExits = holdingMinutes.filter((h) => h > 60).length;

    // Win rate by holding period
    const shortTrades = closed.filter((_, i) => holdingMinutes[i] < 15);
    const longTrades = closed.filter((_, i) => holdingMinutes[i] > 60);
    const shortWinRate = shortTrades.length > 0
      ? shortTrades.filter((t) => t.netPnl > 0).length / shortTrades.length * 100
      : null;
    const longWinRate = longTrades.length > 0
      ? longTrades.filter((t) => t.netPnl > 0).length / longTrades.length * 100
      : null;

    // Recommendation
    let recommendation = 'MAINTAIN';
    let paramName: string | null = null;
    let suggestedAdjustment: number | null = null;

    if (shortWinRate !== null && shortWinRate < 30 && shortExits > closed.length * 0.3) {
      recommendation = 'SLOW_DOWN';
      paramName = 'decayRate';
      suggestedAdjustment = -0.01; // reduce decay rate
    } else if (longWinRate !== null && longWinRate > 60 && longExits > closed.length * 0.3) {
      recommendation = 'SPEED_UP';
      paramName = 'decayRate';
      suggestedAdjustment = 0.01;
    }

    return {
      avgHoldingMinutes: avgHolding,
      shortExitCount: shortExits,
      longExitCount: longExits,
      shortWinRate,
      longWinRate,
      recommendation,
      paramName,
      suggestedAdjustment,
      tradeCount: closed.length,
    };
  }

  // ── Strategy metrics ────────────────────────────────────────────────

  private computeDetailedStrategyMetrics(
    trades: TradeRecord[],
    regime: string,
  ): Record<string, any> {
    if (trades.length < 2) return { status: 'INSUFFICIENT_DATA' };

    const closed = trades.filter((t) => t.closedAt !== null);
    const winners = closed.filter((t) => t.netPnl > 0);
    const netPnl = closed.reduce((s, t) => s + t.netPnl, 0);
    const winRate = closed.length > 0 ? (winners.length / closed.length) * 100 : 0;

    // Profit factor
    const grossWin = winners.reduce((s, t) => s + t.netPnl, 0);
    const grossLoss = Math.abs(closed.filter((t) => t.netPnl <= 0).reduce((s, t) => s + t.netPnl, 0));
    const profitFactor = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0;

    return {
      totalTrades: closed.length,
      winRate,
      netPnl,
      profitFactor,
      grossWin,
      grossLoss,
      regime,
      assessment: winRate >= 50 && profitFactor > 1 ? 'POSITIVE' :
                  winRate >= 40 ? 'NEUTRAL' : 'NEGATIVE',
    };
  }

  // ── Candidate identification ────────────────────────────────────────

  private identifyCandidateImprovements(
    tradeSummary: SessionTradeSummary,
    decayEval: Record<string, any>,
    strategyMetrics: Record<string, any>,
    regime: string,
    sessionDate: string,
  ): Array<{
    paramName: string;
    category: 'decay' | 'timing' | 'weight' | 'threshold' | 'scoring';
    currentValue: number;
    proposedValue: number;
    reason: string;
  }> {
    const candidates: Array<{
      paramName: string;
      category: 'decay' | 'timing' | 'weight' | 'threshold' | 'scoring';
      currentValue: number;
      proposedValue: number;
      reason: string;
    }> = [];

    // Decay rate adjustment
    if (decayEval.recommendation !== 'MAINTAIN' && decayEval.paramName && decayEval.suggestedAdjustment !== null) {
      candidates.push({
        paramName: decayEval.paramName,
        category: 'decay',
        currentValue: 0.05, // default — should be read from current calibration
        proposedValue: 0.05 + decayEval.suggestedAdjustment,
        reason: `Session ${sessionDate}: ${decayEval.recommendation} — ` +
                `avg holding ${Number(decayEval.avgHoldingMinutes)?.toFixed(0)}min, ` +
                `short WR ${Number(decayEval.shortWinRate)?.toFixed(0)}%, long WR ${Number(decayEval.longWinRate)?.toFixed(0)}%`,
      });
    }

    // Only propose if we have enough data
    if (tradeSummary.totalTrades >= 5) {
      // Win rate below threshold — tighten entry criteria
      if (tradeSummary.winRate < 40) {
        candidates.push({
          paramName: 'confidenceThreshold',
          category: 'threshold',
          currentValue: 0.5,
          proposedValue: 0.55,
          reason: `Win rate ${tradeSummary.winRate.toFixed(1)}% below 40% threshold — tighten entry`,
        });
      }
    }

    return candidates;
  }

  // ── Queries ─────────────────────────────────────────────────────────

  /** Get research results for a date range. */
  async getResults(sessionDate: string): Promise<ResearchResult[]> {
    return this.researchResults.find({
      where: { sessionDate },
      order: { createdAt: 'DESC' },
    });
  }

  /** Get latest research result. */
  async getLatestResult(): Promise<ResearchResult | null> {
    return this.researchResults.findOne({
      order: { createdAt: 'DESC' },
    });
  }

  /** Check if research is currently running. */
  isRunning(): boolean {
    return this.researchRunning;
  }
}
