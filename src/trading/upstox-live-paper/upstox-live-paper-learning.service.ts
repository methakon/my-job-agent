import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, Repository } from 'typeorm';
import { HorizonOutcome, labelOutcomes } from '../pattern-engine/pattern-features';
import { UpstoxLivePaperCandidate } from './upstox-live-paper-candidate.entity';
import { UpstoxLivePaperOptionQuote } from './upstox-live-paper-option-quote.entity';
import { ENTRY_STRATEGY_VERSION } from './upstox-live-paper-entry-policy';
import { RISK_POLICY_VERSION } from './paper-risk';

/** One candidate as the strategy saw it, ready to be journalled. */
export interface CandidateRecord {
  portfolioId: string;
  sessionDate: string;
  strategyVersion?: string;
  riskPolicyVersion?: string;
  contractSymbol: string;
  underlying: string;
  expiry?: string | null;
  strike?: number | null;
  optionType?: string | null;
  spot?: number | null;
  /** Premium at evaluation. */
  premium: number;
  bid?: number | null;
  ask?: number | null;
  spreadPct?: number | null;
  volume?: number | null;
  openInterest?: number | null;
  oiChange?: number | null;
  iv?: number | null;
  delta?: number | null;
  gamma?: number | null;
  theta?: number | null;
  vega?: number | null;
  optionAtr?: number | null;
  underlyingAtr?: number | null;
  tickAgeMs?: number | null;
  /** Every entry feature score, as computed by the shared feature engine. */
  scores?: Record<string, unknown> | null;
  thresholds?: Record<string, unknown> | null;
  qualified: boolean;
  /** Intended side ('BUY_CE'/'BUY_PE') or 'NO_TRADE'. */
  decision?: string | null;
  refusals?: string[] | null;
  notes?: string[] | null;
  entryState?: string | null;
  patternType?: string | null;
  confidence?: number | null;
  reversalScore?: number | null;
  /** Hypothetical (or planned) levels — journalled even when it never traded. */
  plannedEntry?: number | null;
  plannedStop?: number | null;
  plannedTarget?: number | null;
  plannedRewardRisk?: number | null;
  plannedRisk?: number | null;
  plannedRiskPct?: number | null;
  lots?: number | null;
  lotSize?: number | null;
  configuredCapital?: number | null;
  riskBase?: number | null;
}

/**
 * The learning journal.
 *
 * The GATE 0 clarification is explicit: record EVERY candidate — executed and
 * NO-TRADE alike — with all entry feature scores, the hypothetical entry/stop/
 * target, the 5/10/15/30/60-minute outcome, MFE/MAE, the max favourable and
 * adverse price actually printed, and a classification, so the entry and exit
 * policies can be compared statistically later. A rejected candidate is the most
 * informative row in the table: it is the only way to tell a good filter from a
 * missed winner.
 *
 * Nothing here ever rewrites a past measurement: labels are filled in once the
 * tape reaches the horizon (HorizonOutcome.covered) and are not extrapolated.
 */
@Injectable()
export class UpstoxLivePaperLearningService {
  private readonly logger = new Logger(UpstoxLivePaperLearningService.name);

  constructor(
    @InjectRepository(UpstoxLivePaperCandidate) private readonly candidates: Repository<UpstoxLivePaperCandidate>,
    @InjectRepository(UpstoxLivePaperOptionQuote) private readonly quotes: Repository<UpstoxLivePaperOptionQuote>,
  ) {}

  async record(input: CandidateRecord): Promise<UpstoxLivePaperCandidate> {
    return this.candidates.save(this.candidates.create({
      portfolioId: input.portfolioId,
      sessionDate: input.sessionDate,
      strategyVersion: input.strategyVersion ?? ENTRY_STRATEGY_VERSION,
      riskPolicyVersion: input.riskPolicyVersion ?? RISK_POLICY_VERSION,
      contractSymbol: input.contractSymbol,
      underlying: input.underlying,
      expiry: input.expiry ?? null,
      strike: input.strike ?? null,
      optionType: (input.optionType as 'CE' | 'PE' | null) ?? null,
      spot: input.spot ?? null,
      ltp: input.premium,
      bid: input.bid ?? null,
      ask: input.ask ?? null,
      spreadPct: input.spreadPct ?? null,
      volume: input.volume === null || input.volume === undefined ? null : String(Math.trunc(input.volume)),
      openInterest: input.openInterest === null || input.openInterest === undefined ? null : String(Math.trunc(input.openInterest)),
      oiChange: input.oiChange === null || input.oiChange === undefined ? null : String(Math.trunc(input.oiChange)),
      iv: input.iv ?? null,
      delta: input.delta ?? null,
      gamma: input.gamma ?? null,
      theta: input.theta ?? null,
      vega: input.vega ?? null,
      optionAtr: input.optionAtr ?? null,
      underlyingAtr: input.underlyingAtr ?? null,
      tickAgeMs: input.tickAgeMs ?? null,
      scores: input.scores ?? null,
      thresholds: input.thresholds ?? null,
      qualified: input.qualified,
      executed: false,
      decision: input.decision ?? (input.qualified ? 'QUALIFIED' : 'NO_TRADE'),
      refusals: input.refusals ?? null,
      notes: input.notes ?? null,
      entryState: input.entryState ?? null,
      patternType: input.patternType ?? null,
      confidence: input.confidence ?? 0,
      reversalScore: input.reversalScore ?? 0,
      plannedEntry: input.plannedEntry ?? input.premium,
      plannedStop: input.plannedStop ?? null,
      plannedTarget: input.plannedTarget ?? null,
      plannedRewardRisk: input.plannedRewardRisk ?? null,
      plannedRisk: input.plannedRisk ?? null,
      plannedRiskPct: input.plannedRiskPct ?? null,
      lots: input.lots ?? null,
      lotSize: input.lotSize ?? null,
      configuredCapital: input.configuredCapital ?? null,
      riskBase: input.riskBase ?? null,
      classification: 'PENDING',
      outcomeStatus: 'PENDING',
    }));
  }

  /** Link the candidate to the trade it produced, with the actual fill. */
  async markEntered(candidateId: string, input: { tradeId: string; entryPrice: number; entryTs?: Date; decision?: string }): Promise<void> {
    await this.candidates.update(candidateId, {
      executed: true,
      tradeId: input.tradeId,
      entryPrice: input.entryPrice,
      entryTs: input.entryTs ?? new Date(),
      decision: input.decision ?? undefined,
    });
  }

  /**
   * Mark-to-market excursion. Called on every tick for a live position so MFE/MAE
   * reflect the prices that actually printed — never an assumed path.
   */
  async updateExcursion(candidateId: string, price: number): Promise<void> {
    if (!(price > 0)) return;
    const row = await this.candidates.findOne({ where: { id: candidateId } });
    if (!row) return;
    const ref = Number(row.entryPrice ?? row.ltp);
    if (!(ref > 0)) return;

    const best = Math.max(Number(row.maxFavourablePrice ?? 0) || ref, price);
    const worst = Math.min(Number(row.maxAdversePrice ?? 0) || ref, price);
    await this.candidates.update(candidateId, {
      maxFavourablePrice: best,
      maxAdversePrice: worst,
      mfe: best - ref,
      mae: worst - ref,
      mfePct: (best - ref) / ref,
      maePct: (worst - ref) / ref,
      outcomeStatus: row.outcomeStatus === 'PENDING' ? 'PARTIAL' : row.outcomeStatus,
    });
  }

  /** Record the exit that actually happened (executed rows only). */
  async markExit(candidateId: string, input: { exitPrice: number; exitTs?: Date; exitReason: string }): Promise<void> {
    await this.candidates.update(candidateId, {
      exitPrice: input.exitPrice,
      exitTs: input.exitTs ?? new Date(),
      exitReason: input.exitReason,
    });
  }

  /** The candidate that produced a trade — the trade's own risk record. */
  async findByTradeId(tradeId: string): Promise<UpstoxLivePaperCandidate | null> {
    return this.candidates.findOne({ where: { tradeId } });
  }

  /** Candidates still waiting on a label (post-exit horizons not yet reachable). */
  async pendingLabelling(limit = 50): Promise<UpstoxLivePaperCandidate[]> {
    return this.candidates.find({
      where: { outcomeStatus: 'PENDING' },
      order: { evaluatedAt: 'ASC' },
      take: Math.min(500, Math.max(1, limit)),
    });
  }

  /** Post-exit labelling for one candidate. */
  async labelOutcomeFor(candidateId: string, options: { hoursBack?: number } = {}): Promise<UpstoxLivePaperCandidate | null> {
    const row = await this.candidates.findOne({ where: { id: candidateId } });
    return row ? this.labelWithQuotes(row, options.hoursBack ?? 3) : null;
  }

  /** Label every unlabelled candidate of a session (journal back-fill). */
  async labelSession(portfolioId: string, sessionDate: string): Promise<number> {
    const rows = await this.candidates.find({ where: { portfolioId, sessionDate }, order: { evaluatedAt: 'ASC' } });
    let labelled = 0;
    for (const row of rows) {
      if (row.outcomeStatus === 'COMPLETE') continue;
      const updated = await this.labelWithQuotes(row, 6);
      if (updated) labelled += 1;
    }
    return labelled;
  }

  private async labelWithQuotes(row: UpstoxLivePaperCandidate, hoursBack: number): Promise<UpstoxLivePaperCandidate | null> {
    const anchorTs = row.entryTs ?? row.evaluatedAt;
    const anchorPrice = Number(row.entryPrice ?? row.ltp);
    if (!(anchorPrice > 0) || !anchorTs) return null;

    const from = new Date(anchorTs.getTime() - 60_000);
    const to = new Date(anchorTs.getTime() + (hoursBack * 60 + 60) * 60_000);
    const ticks = await this.quotes.find({
      where: { contractSymbol: row.contractSymbol, ts: Between(from, to) },
      order: { ts: 'ASC' },
    });
    if (!ticks.length) return null;

    const series = ticks.map((t) => ({ ts: t.ts, price: Number(t.ltp) }));
    const horizons: HorizonOutcome[] = labelOutcomes({
      entryPrice: anchorPrice,
      entryTs: anchorTs.getTime(),
      futureTicks: series,
      targetPct: row.plannedTarget ? (Number(row.plannedTarget) - anchorPrice) / anchorPrice : null,
      stopPct: row.plannedStop ? (Number(row.plannedStop) - anchorPrice) / anchorPrice : null,
    });

    // Post-exit window: strictly after the exit — for a candidate that never
    // traded, "post-exit" means "after the decision".
    const exitAnchor = row.exitTs ?? anchorTs;
    const exitPrice = Number(row.exitPrice ?? 0) || anchorPrice;
    const after = series.filter((t) => t.ts.getTime() > exitAnchor.getTime());
    let peakAfterExit: number | null = null;
    let troughAfterExit: number | null = null;
    for (const t of after) {
      peakAfterExit = peakAfterExit === null ? t.price : Math.max(peakAfterExit, t.price);
      troughAfterExit = troughAfterExit === null ? t.price : Math.min(troughAfterExit, t.price);
    }
    const missedOpportunityPct = peakAfterExit !== null && exitPrice > 0 ? (peakAfterExit - exitPrice) / exitPrice : null;

    const tracked = series.filter((t) => t.ts.getTime() >= anchorTs.getTime());
    const maxFav = Math.max(...(tracked.length ? tracked.map((t) => t.price) : [anchorPrice]), anchorPrice);
    const minAdv = Math.min(...(tracked.length ? tracked.map((t) => t.price) : [anchorPrice]), anchorPrice);

    const classification = this.classify({
      executed: !!Number(row.executed),
      entryPrice: anchorPrice,
      exitPrice: row.exitPrice === null ? null : Number(row.exitPrice),
      maxFavourablePct: (maxFav - anchorPrice) / anchorPrice,
      maxAdversePct: (minAdv - anchorPrice) / anchorPrice,
      missedOpportunityPct,
      plannedTarget: row.plannedTarget === null ? null : Number(row.plannedTarget),
      plannedStop: row.plannedStop === null ? null : Number(row.plannedStop),
    });

    const allCovered = horizons.length > 0 && horizons.every((h) => h.covered);
    const forward: Record<string, unknown> = {};
    for (const h of horizons) {
      forward[String(h.horizonMinutes)] = {
        pct: h.returnPct,
        maxFavourablePct: h.maxFavourablePct,
        maxAdversePct: h.maxAdversePct,
        label: h.label,
        covered: h.covered,
      };
    }

    return this.candidates.save({
      ...row,
      mfe: maxFav - anchorPrice,
      mae: minAdv - anchorPrice,
      mfePct: (maxFav - anchorPrice) / anchorPrice,
      maePct: (minAdv - anchorPrice) / anchorPrice,
      maxFavourablePrice: maxFav,
      maxAdversePrice: minAdv,
      peakAfterExit,
      missedOpportunityPct,
      // postExitOutcomes is measured from the exit; forwardOutcomes from the
      // decision — they answer different questions and must not be conflated.
      postExitOutcomes: peakAfterExit === null ? null : { peakAfterExit, troughAfterExit, missedOpportunityPct },
      forwardOutcomes: forward,
      classification,
      outcomeStatus: allCovered ? 'COMPLETE' : 'PARTIAL',
      labelledAt: new Date(),
    });
  }

  /**
   * Turn a candidate's measurements into a learning label. Deliberately
   * conservative: a rejection that would have worked is a MISSED_WINNER, but a
   * rejection that would have stopped out is a GOOD_FILTER — the journal must be
   * able to defend both outcomes of the same gate.
   */
  classify(input: {
    executed: boolean;
    entryPrice: number;
    exitPrice: number | null;
    maxFavourablePct: number;
    maxAdversePct: number;
    missedOpportunityPct: number | null;
    plannedTarget: number | null;
    plannedStop: number | null;
  }): string {
    const targetPct = input.plannedTarget ? (input.plannedTarget - input.entryPrice) / input.entryPrice : 0.2;
    const stopPct = input.plannedStop ? Math.abs((input.plannedStop - input.entryPrice) / input.entryPrice) : 0.1;

    if (!input.executed) {
      // A rejected candidate: did the gate save money or cost money?
      if (input.maxFavourablePct >= targetPct && input.maxAdversePct > -stopPct) return 'MISSED_WINNER';
      if (input.maxAdversePct <= -stopPct && input.maxFavourablePct < targetPct) return 'GOOD_FILTER';
      return 'NEUTRAL_REJECTION';
    }

    const reachedTarget = input.maxFavourablePct >= targetPct;
    const stoppedOut = input.maxAdversePct <= -stopPct;
    if (input.exitPrice === null) return 'OPEN';
    if (reachedTarget && stoppedOut) {
      // Both barriers were touched; the order is unknowable from aggregates
      // alone — report it as ambiguous rather than guessing.
      return 'AMBIGUOUS_PATH';
    }
    if (stoppedOut) return 'STOPPED';
    if (reachedTarget && input.missedOpportunityPct !== null && input.missedOpportunityPct > 0.2) return 'PREMATURE_EXIT';
    if (input.maxFavourablePct < targetPct * 0.25) return 'FALSE_BREAKOUT';
    if (reachedTarget) return 'TARGET_HIT';
    return 'NEUTRAL';
  }

  /** The journal for one session, with the aggregates the operator reviews. */
  async sessionJournal(portfolioId: string, sessionDate: string): Promise<Record<string, unknown>> {
    const rows = await this.candidates.find({ where: { portfolioId, sessionDate }, order: { evaluatedAt: 'ASC' } });
    const executed = rows.filter((r) => !!Number(r.executed));
    const rejected = rows.filter((r) => !Number(r.executed));
    const byClass: Record<string, number> = {};
    for (const r of rows) byClass[r.classification] = (byClass[r.classification] ?? 0) + 1;
    const byRefusal: Record<string, number> = {};
    for (const r of rejected) {
      for (const reason of r.refusals ?? []) {
        const key = String(reason).split('—')[0].split('<')[0].trim().slice(0, 60);
        byRefusal[key] = (byRefusal[key] ?? 0) + 1;
      }
    }
    const mean = (xs: number[]): number | null => (xs.length ? Number((xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(4)) : null);

    return {
      portfolioId,
      sessionDate,
      strategyVersion: ENTRY_STRATEGY_VERSION,
      totals: { candidates: rows.length, executed: executed.length, rejected: rejected.length },
      classification: byClass,
      refusalReasons: byRefusal,
      executedStats: {
        meanMfePct: mean(executed.map((r) => Number(r.mfePct ?? 0))),
        meanMaePct: mean(executed.map((r) => Number(r.maePct ?? 0))),
        meanMissedOpportunityPct: mean(executed.map((r) => Number(r.missedOpportunityPct ?? 0))),
      },
      rejectedStats: {
        // The two numbers that justify or condemn the confidence gate.
        missedWinners: rejected.filter((r) => r.classification === 'MISSED_WINNER').length,
        goodFilters: rejected.filter((r) => r.classification === 'GOOD_FILTER').length,
        meanMfePct: mean(rejected.map((r) => Number(r.mfePct ?? 0))),
      },
      rows: rows.map((r) => ({
        id: r.id,
        evaluatedAt: r.evaluatedAt,
        contractSymbol: r.contractSymbol,
        optionType: r.optionType,
        strike: r.strike === null ? null : Number(r.strike),
        premium: Number(r.ltp),
        qualified: r.qualified,
        executed: !!Number(r.executed),
        confidence: Number(r.confidence),
        reversalScore: Number(r.reversalScore),
        entryState: r.entryState,
        scores: r.scores,
        refusals: r.refusals,
        plannedStop: r.plannedStop === null ? null : Number(r.plannedStop),
        plannedTarget: r.plannedTarget === null ? null : Number(r.plannedTarget),
        plannedRewardRisk: r.plannedRewardRisk === null ? null : Number(r.plannedRewardRisk),
        plannedRisk: r.plannedRisk === null ? null : Number(r.plannedRisk),
        plannedRiskPct: r.plannedRiskPct === null ? null : Number(r.plannedRiskPct),
        configuredCapital: r.configuredCapital === null ? null : Number(r.configuredCapital),
        entryPrice: r.entryPrice === null ? null : Number(r.entryPrice),
        exitPrice: r.exitPrice === null ? null : Number(r.exitPrice),
        exitReason: r.exitReason,
        mfePct: r.mfePct === null ? null : Number(r.mfePct),
        maePct: r.maePct === null ? null : Number(r.maePct),
        peakAfterExit: r.peakAfterExit === null ? null : Number(r.peakAfterExit),
        missedOpportunityPct: r.missedOpportunityPct === null ? null : Number(r.missedOpportunityPct),
        forwardOutcomes: r.forwardOutcomes,
        postExitOutcomes: r.postExitOutcomes,
        classification: r.classification,
        outcomeStatus: r.outcomeStatus,
      })),
    };
  }
}
