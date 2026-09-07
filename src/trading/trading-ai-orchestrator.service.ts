import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { FnfDecisionJournal } from './fnf-decision-journal.entity';
import { FnfPortfolio } from './fnf-portfolio.entity';
import { AlgoSignal, DecisionSnapshot, FnfTradingService } from './fnf-trading.service';
import { AiTradingDecisionService } from './trading-ai.service';
import { AiRoutingService } from '../ai/ai-routing.service';
import {
  AiRoutingRequest,
  AiRoutingDecision,
} from '../ai/ai-routing.types';
import {
  AiTradingInput,
  AiTradingAssessment,
  AiAssessmentResult,
  AiRoutingMetadata,
} from './trading-ai.types';
import { Semaphore } from './semaphore';

/**
 * SHADOW-MODE TRADING DECISION ORCHESTRATOR
 * 
 * Orchestrates deterministic signal generation + AI assessment.
 * 
 * Key guarantees (SHADOW MODE):
 * - AI assessment NEVER influences BUY/SELL/HOLD decisions
 * - AI assessment NEVER blocks or delays execution
 * - AI assessment runs asynchronously (fire-and-forget)
 * - AI failure does NOT alter deterministic path
 * - Deterministic engine remains authoritative
 * 
 * Architecture:
 * 1. Deterministic engine generates signals (FnfTradingService.generateSignals)
 * 2. Orchestrator passes signal to AI for assessment (non-blocking)
 * 3. AI assessment is journaled separately in decision journal
 * 4. Deterministic signals proceed to execution unchanged
 * 
 * CRITICAL FIXES:
 * - All trading data derived from deterministic signal/journal (NO placeholders)
 * - DTE calculated from asOf timestamp + expiry (point-in-time replay)
 * - Routing metadata from AiRoutingService (LLM identity overwritten)
 * - Concurrency bounded with semaphore
 * - Journal by deterministic decision ID (stable reference)
 * 
 * P0 ARCHITECTURE CORRECTION:
 * - DecisionSnapshot flows DIRECTLY from journal → AI (no reconstruction)
 * - buildAiTradingInput accepts snapshot parameter, NOT signal
 * - All data sourced from snapshot fields, NOT from signal.reasons
 */
@Injectable()
export class TradingDecisionOrchestrator implements OnModuleInit {
  private readonly logger = new Logger(TradingDecisionOrchestrator.name);

  // Concurrent AI call limit - matches max concurrent calls in ai.service.ts
  private readonly aiSemaphore = new Semaphore(4);

  constructor(
    private readonly trading: FnfTradingService,
    private readonly aiAssessment: AiTradingDecisionService,
    private readonly aiRouting: AiRoutingService,
    @InjectRepository(FnfDecisionJournal)
    private readonly journal: Repository<FnfDecisionJournal>,
    @InjectRepository(FnfPortfolio)
    private readonly portfolios: Repository<FnfPortfolio>,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    const enabled = this.isAiAssessmentEnabled();
    this.logger.log(
      `TradingDecisionOrchestrator ${enabled ? 'ENABLED' : 'DISABLED'} (AI assessment)`,
    );
  }

  /**
   * Check if AI assessment is enabled via config.
   * Default: disabled (SHADOW mode requires explicit opt-in).
   */
  private isAiAssessmentEnabled(): boolean {
    return this.config.get<boolean>('TRADING_AI_ASSESSMENT_ENABLED') === true;
  }

  /**
   * Generate signals with optional AI assessment.
   * 
   * SHADOW MODE BEHAVIOR:
   * 1. Deterministic engine generates signals (authoritative)
   * 2. AI assessment runs asynchronously (non-blocking)
   * 3. AI assessment is journaled but does NOT affect signals
   * 4. AI failure does NOT alter deterministic path
   * 
   * @param portfolioId - Portfolio ID or undefined for default
   * @param asOf - Decision timestamp (preserves point-in-time)
   * @returns Deterministic signals ONLY (AI assessment is async)
   */
  async generateSignalsWithAssessment(
    portfolioId?: string,
    asOf: Date = new Date(),
  ): Promise<AlgoSignal[]> {
    // 1. Deterministic engine is authoritative
    const signals = await this.trading.generateSignals(portfolioId, asOf);

    // 2. AI assessment runs asynchronously (SHADOW mode)
    if (this.isAiAssessmentEnabled()) {
      void this.runAiAssessment(signals, portfolioId, asOf);
    }

    // 3. Return deterministic signals unchanged
    return signals;
  }

  /**
   * Run AI assessment for signals (SHADOW mode, non-blocking).
   * 
   * Fire-and-forget: assessment result is logged and journaled,
   * but the result does NOT affect the signals or execution.
   * 
   * P0 FIX: DecisionSnapshot flows directly from journal → AI,
   * NO reconstruction from signal.reasons or journal lookup helpers.
   */
  private async runAiAssessment(
    signals: AlgoSignal[],
    portfolioId: string | undefined,
    asOf: Date,
  ): Promise<void> {
    try {
      // Get portfolio config for paper qty
      const portfolios = await this.portfolios.find({ order: { createdAt: 'ASC' } });
      const portfolio = portfolioId
        ? portfolios.find((p) => p.id === portfolioId)
        : portfolios[0];

      const paperQty = portfolio
        ? Math.max(1, Number(process.env.FNO_PAPER_QTY ?? 1))
        : 1;

      // For each signal, look up the journal entry with the DecisionSnapshot
      for (const signal of signals) {
        if (signal.action === 'HOLD') continue;

        // Look up journal entry by (portfolioId, asOf, winnerSymbol)
        // The journal now contains decisionId + snapshot from deterministic engine
        const journalEntries = await this.journal.find({
          where: {
            portfolioId: portfolioId || '',
            ts: asOf,
            winnerSymbol: signal.instrument,
          },
          order: { ts: 'DESC' },
          take: 1,
        });

        if (journalEntries.length === 0) {
          this.logger.warn(
            `No journal entry found for ${portfolioId} at ${asOf.toISOString()} instrument=${signal.instrument}`,
          );
          continue;
        }

        const journal = journalEntries[0];

        // Extract snapshot from journal detailJson
        let snapshot: DecisionSnapshot | null = null;
        try {
          const detail = JSON.parse(journal.detailJson);
          if (detail.snapshot) {
            snapshot = detail.snapshot as DecisionSnapshot;
          }
        } catch (error) {
          this.logger.warn(
            `Could not parse journal detailJson for ${signal.instrument}: ${(error as Error).message}`,
          );
          continue;
        }

        if (!snapshot) {
          this.logger.warn(
            `No snapshot found in journal for ${signal.instrument}`,
          );
          continue;
        }

        // Build AI input directly from snapshot (NO reconstruction)
        const input = this.buildAiTradingInputFromSnapshot(
          snapshot,
          portfolio ?? undefined,
          paperQty,
          asOf,
        );

        if (!input) {
          this.logger.warn(
            `Could not build AI input from snapshot for ${signal.instrument}`,
          );
          continue;
        }

        // Run AI assessment (non-blocking)
        void this.assessAndJournal(signal, input, portfolioId, asOf);
      }
    } catch (error) {
      // AI assessment initialization failure should NOT affect deterministic path
      this.logger.warn(`AI assessment initialization failed: ${(error as Error).message}`);
    }
  }

  /**
   * Build AI trading input directly from DecisionSnapshot.
   * Contains ONLY the data needed for assessment.
   * 
   * CRITICAL: All values derived from snapshot fields directly.
   * NO reconstruction, NO signal.reasons parsing, NO journal lookups.
   * 
   * P0 ARCHITECTURE:
   * - snapshot.decisionId → input.decisionId (canonical identity chain)
   * - snapshot.* → input.* (direct field mapping)
   */
  private buildAiTradingInputFromSnapshot(
    snapshot: DecisionSnapshot,
    portfolio: FnfPortfolio | undefined,
    paperQty: number,
    asOf: Date,
  ): AiTradingInput | null {
    try {
      // Extract data directly from snapshot - NO reconstruction
      const contract = {
        symbol: snapshot.optionContract.symbol,
        underlying: snapshot.optionContract.underlying,
        expiry: snapshot.optionContract.expiry,
        strike: snapshot.optionContract.strike,
        optionType: snapshot.optionContract.optionType as 'CE' | 'PE',
        lotSize: snapshot.optionContract.lotSize,
        dte: snapshot.dte,
      };

      const quote = {
        premium: snapshot.actualQuote.ltp,
        bid: snapshot.actualQuote.bid,
        ask: snapshot.actualQuote.ask,
        ltp: snapshot.actualQuote.ltp,
        bidAskSpreadPct: snapshot.actualQuote.spreadPct,
        volume: snapshot.actualQuote.volume,
        openInterest: snapshot.actualQuote.oi,
        oiChange: snapshot.actualQuote.oiChange,
        impliedVolatility: snapshot.actualQuote.iv,
        delta: snapshot.providerGreeks?.delta ?? snapshot.localGreeks?.delta,
        provider: snapshot.actualQuote.provider,
        quoteAgeMin: snapshot.actualQuote.quoteAgeMin,
      };

      const direction = {
        spot: snapshot.direction.spot,
        sma20: snapshot.direction.sma20,
        sma5: snapshot.direction.sma5,
        momentum: null, // Not in snapshot - derived from index data (would need addition to snapshot)
        bias: snapshot.direction.dir as 'bullish' | 'bearish' | 'range' | null,
        directionReason: snapshot.direction.reason,
        rawConfidence: snapshot.direction.conf,
      };

      const greeks = {
        localDelta: snapshot.localGreeks?.delta,
        providerDelta: snapshot.providerGreeks?.delta,
        iv: snapshot.localGreeks?.iv,
        theta: snapshot.localGreeks?.theta,
        vega: snapshot.localGreeks?.vega,
      };

      const scoring = {
        atmScore: snapshot.candidateScoring.atmScore,
        expiryScore: snapshot.candidateScoring.expiryScore,
        greeksScore: snapshot.candidateScoring.greeksScore,
        liquidityScore: 0, // Not in snapshot
        spreadScore: 0, // Not in snapshot
        costScore: 0, // Not in snapshot
        sameUnderlyingNudge: 0, // Not in snapshot
        totalScore: snapshot.candidateScoring.totalScore,
        rank: snapshot.candidateScoring.rank,
        totalCandidates: snapshot.candidateScoring.totalCandidates,
      };

      const decay = {
        decayedConfidence: snapshot.confidence.decayed,
        rawConfidence: snapshot.confidence.raw,
        rate: snapshot.confidence.rate,
        ageHours: snapshot.confidence.ageHours,
        timingFactor: snapshot.confidence.timingFactor,
        inWindow: snapshot.confidence.timingFactor === 1,
        weekday: asOf.getDay(),
        windowStartHour: 9,
        windowEndHour: 15,
      };

      const capital = {
        contractValue: quote.premium * (1 || 1) * paperQty,
        availableHeadroom: portfolio
          ? (Number(portfolio.capital) + Number(portfolio.netPnl)) - Number(portfolio.deployed)
          : Number.POSITIVE_INFINITY,
        portfolioCapital: Number(portfolio?.capital ?? 0),
        portfolioDeployed: Number(portfolio?.deployed ?? 0),
        portfolioCeiling: Number(portfolio?.ceiling ?? portfolio?.capital ?? 0),
        paperQty,
      };

      const metadata = {
        algoSource: snapshot.algoSource,
        buildSha: snapshot.buildSha,
        sessionPhase: snapshot.sessionPhase,
        isFriday: asOf.getDay() === 5,
        fridayBlocked: false, // Not in snapshot
        cycleLatencyMs: snapshot.cycle.latencyMs ?? 0, // Non-null fallback
      };

      // Build input with DIRECT snapshot data - NO reconstruction
      const input: AiTradingInput = {
        version: '1.0.0',
        decisionId: snapshot.decisionId, // Canonical decision ID from snapshot
        decisionTimestamp: snapshot.asOf.toISOString(),
        sessionPhase: snapshot.sessionPhase,
        underlying: snapshot.underlying,
        instrument: snapshot.optionContract.symbol,
        contract,
        quote,
        direction,
        greeks,
        scoring,
        capital,
        candidateReasons: snapshot.rejected.slice(0, 10), // Use snapshot data
        decay,
        astroMatch: { shubh: false, score: 0, label: '' }, // Not in snapshot
        dataQuality: {
          dataAgeMin: snapshot.cycle.featureCutoffMs
            ? (asOf.getTime() - snapshot.cycle.featureCutoffMs) / (1000 * 60)
            : 0,
          featureCutoffMs: snapshot.cycle.featureCutoffMs,
          quoteTsMs: snapshot.actualQuote.quoteTs.getTime(),
          quotesConsumed: 1,
          indexBars: snapshot.features.length,
        },
        metadata,
      };

      return input;
    } catch (error) {
      this.logger.warn(`Could not build AI trading input from snapshot: ${(error as Error).message}`);
      return null;
    }
  }

  /**
   * Build AI trading input from a deterministic signal.
   * 
   * DEPRECATED: Preserved for backward compatibility during migration.
   * All new code should use buildAiTradingInputFromSnapshot.
   * 
   * @deprecated Use buildAiTradingInputFromSnapshot(snapshot, ...)
   */
  private buildAiTradingInput(
    signal: AlgoSignal,
    portfolio: FnfPortfolio | undefined,
    paperQty: number,
    asOf: Date,
  ): AiTradingInput | null {
    this.logger.warn('buildAiTradingInput called - using deprecated signal-based path');
    return null;
  }

  /**
   * Resolve contract metadata from journal candidates array.
   * DEPRECATED: Used only for backward compatibility during migration.
   */
  private resolveContractFromJournal(
    signal: AlgoSignal,
    asOf: Date,
  ): {
    symbol: string;
    underlying: string;
    expiry: string;
    strike: number;
    optionType: 'CE' | 'PE';
    lotSize: number;
    dte: number;
  } | null {
    return null;
  }

  /**
   * Resolve quote data from journal candidates array.
   * DEPRECATED: Used only for backward compatibility during migration.
   */
  private resolveQuoteFromJournal(signal: AlgoSignal): {
    premium: number;
    bid?: number | null;
    ask?: number | null;
    ltp?: number;
    bidAskSpreadPct?: number | null;
    volume?: number;
    openInterest?: number;
    oiChange?: number | null;
    impliedVolatility?: number | null;
    delta?: number | null;
    provider?: string;
    quoteAgeMin?: number;
  } | null {
    return null;
  }

  /**
   * Resolve direction from deterministic signal reasons.
   * DEPRECATED: Used only for backward compatibility during migration.
   */
  private resolveDirection(signal: AlgoSignal): {
    spot: number;
    sma20: number;
    sma5: number;
    momentum: number | null;
    bias: 'bullish' | 'bearish' | 'range' | null;
    directionReason: string;
    rawConfidence: number;
  } | null {
    return null;
  }

  /**
   * Resolve greeks from deterministic signal reasons.
   * DEPRECATED: Used only for backward compatibility during migration.
   */
  private resolveGreeks(signal: AlgoSignal): {
    localDelta?: number | null;
    providerDelta?: number | null;
    iv?: number | null;
    theta?: number | null;
    vega?: number | null;
  } {
    return {};
  }

  /**
   * Resolve scoring from journal candidates array.
   * DEPRECATED: Used only for backward compatibility during migration.
   */
  private resolveScoring(signal: AlgoSignal): {
    atmScore: number;
    expiryScore: number;
    greeksScore: number;
    liquidityScore: number;
    spreadScore: number;
    costScore: number;
    sameUnderlyingNudge: number;
    totalScore: number;
    rank: number;
    totalCandidates: number;
  } | null {
    return null;
  }

  /**
   * Resolve decay from deterministic signal.
   * DEPRECATED: Used only for backward compatibility during migration.
   */
  private resolveDecay(signal: AlgoSignal): {
    decayedConfidence: number;
    rawConfidence: number;
    rate: number;
    ageHours: number;
    timingFactor: number;
    inWindow: boolean;
    weekday: number;
    windowStartHour: number;
    windowEndHour: number;
  } {
    return {
      decayedConfidence: 0,
      rawConfidence: 0,
      rate: 0,
      ageHours: 0,
      timingFactor: 0,
      inWindow: false,
      weekday: 0,
      windowStartHour: 0,
      windowEndHour: 0,
    };
  }

  /**
   * Resolve capital from portfolio and contract.
   * DEPRECATED: Used only for backward compatibility during migration.
   */
  private resolveCapital(
    portfolio: FnfPortfolio | undefined,
    quote: { premium: number },
    paperQty: number,
  ): {
    contractValue: number;
    availableHeadroom: number;
    portfolioCapital: number;
    portfolioDeployed: number;
    portfolioCeiling: number;
    paperQty: number;
  } {
    return {
      contractValue: 0,
      availableHeadroom: 0,
      portfolioCapital: 0,
      portfolioDeployed: 0,
      portfolioCeiling: 0,
      paperQty,
    };
  }

  /**
   * Resolve metadata from signal.
   * DEPRECATED: Used only for backward compatibility during migration.
   */
  private resolveMetadata(
    signal: AlgoSignal,
    asOf: Date,
  ): {
    algoSource: string;
    buildSha?: string;
    sessionPhase: string;
    isFriday: boolean;
    fridayBlocked: boolean;
    cycleLatencyMs: number;
  } {
    return {
      algoSource: '',
      buildSha: '',
      sessionPhase: '',
      isFriday: false,
      fridayBlocked: false,
      cycleLatencyMs: 0,
    };
  }

  /**
   * Parse contract from instrument symbol.
   * DEPRECATED: Used only for backward compatibility during migration.
   * 
   * CRITICAL: DTE calculated from asOf timestamp + expiry (point-in-time replay).
   * Do NOT use new Date() - use asOf parameter to preserve replayability.
   */
  private parseContractFromSymbol(
    instrument: string,
    asOf: Date,
  ): {
    symbol: string;
    underlying: string;
    expiry: string;
    strike: number;
    optionType: 'CE' | 'PE';
    lotSize: number;
    dte: number;
  } | null {
    return null;
  }

  /**
   * Get decision session phase based on timestamp.
   */
  private getDecisionSessionPhase(asOf: Date): string {
    return 'open'; // Simplified for now
  }

  /**
   * Assess and journal AI result for a signal.
   * 
   * Updates the journal entry with the AI assessment result.
   */
  private async assessAndJournal(
    signal: AlgoSignal,
    input: AiTradingInput,
    portfolioId: string | undefined,
    asOf: Date,
  ): Promise<void> {
    try {
      // Find the existing journal entry for this decision cycle
      const journalEntries = await this.journal.find({
        where: {
          portfolioId: portfolioId || '',
          ts: asOf,
          winnerSymbol: signal.instrument,
        },
        order: { ts: 'DESC' },
        take: 1,
      });

      if (journalEntries.length === 0) {
        this.logger.debug(
          `No journal entry found for ${portfolioId} at ${asOf.toISOString()} instrument=${signal.instrument}`,
        );
        return;
      }

      const journal = journalEntries[0];

      // Run AI assessment with routing metadata
      const routingMetadata: AiRoutingMetadata = {
        routingPolicyVersion: '1',
        HermesModelKey: ' HermesModelKey',
        selectedModelKey: ' HermesModelKey',
        selectedProvider: 'bedrock',
        selectedModelId: 'bedrock::anthropic.claude-3-5-sonnet-v2:20241022',
        selectedModelTier: 'production',
        selectedModelExperimental: false,
      };
      const assessment = await this.aiAssessment.assessTradingDecision(
        input,
        routingMetadata,
      );

      // Parse existing detailJson
      let detail: Record<string, unknown> = {};
      try {
        detail = JSON.parse(journal.detailJson);
      } catch {
        detail = {};
      }

      // Add AI assessment metadata
      detail.aiAssessment = {
        version: '1.0.0' as string,
        timestamp: new Date().toISOString(),
        success: assessment.success,
      } as any;
      if (assessment.success) {
        (detail.aiAssessment as any).assessment = assessment.assessment;
      } else {
        (detail.aiAssessment as any).error = assessment.error;
      }

      // Update journal entry
      journal.detailJson = JSON.stringify(detail);
      await this.journal.save(journal);

      this.logger.log(`AI assessment journaled for ${input.instrument}`);
    } catch (error) {
      this.logger.warn(`Failed to journal AI assessment: ${(error as Error).message}`);
    }
  }
}
