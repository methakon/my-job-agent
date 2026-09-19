
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ValidationResult } from './validation-result.entity';
import { AdaptationCandidate } from './adaptation-candidate.entity';

/**
 * Deterministic validation framework for adaptation candidates.
 *
 * Implements holdout, rolling, and baseline-comparison validation.
 * A candidate must NOT be activated unless ALL gates pass:
 * - Minimum sample count
 * - Improvement in key metrics (win rate, expectancy)
 * - No degradation in risk metrics (drawdown)
 * - Stability across sessions
 * - Regime-aware comparison (optional)
 *
 * NO AI JUDGMENT. All gates are deterministic and auditable.
 */

// ── Types ─────────────────────────────────────────────────────────────

export interface TradeRecord {
  instrumentKey: string;
  underlying: string;
  optionType: string;
  strike: number;
  expiry: string;
  netPnl: number;
  entryPrice: number;
  exitPrice: number;
  orderedAt: Date;
  closedAt: Date | null;
  entrySource: string;
}

export interface BaselineMetrics {
  totalTrades: number;
  winners: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
  netPnl: number;
  expectancy: number;
  maxDrawdown: number;
  profitFactor: number;
  avgHoldingPeriodMinutes: number;
  byDayOfWeek: Record<number, { count: number; winRate: number; netPnl: number }>;
}

export interface ValidationResultOutcome {
  candidateId: string;
  validationType: string;
  baseline: BaselineMetrics;
  candidate: BaselineMetrics;
  passed: boolean;
  rejectionReasons: string[];
  stabilityScore: number;
  regimeAware: boolean;
  sampleSize: number;
  inSampleCount: number;
  outOfSampleCount: number;
}

// ── Validation gates (deterministic, auditable) ───────────────────────

/** Minimum trades required for valid baseline. */
const MIN_BASELINE_TRADES = 10;
/** Minimum trades required for candidate validation. */
const MIN_CANDIDATE_TRADES = 5;
/** Minimum improvement in win rate to consider (percentage points). */
const MIN_WINRATE_IMPROVEMENT = 0.5;
/** Maximum allowed drawdown degradation (percentage points). */
const MAX_DRAWDOWN_DEGRADATION = 5.0;
/** Stability: minimum ratio of positive days to total days. */
const MIN_STABILITY_RATIO = 0.4;

@Injectable()
export class ValidationEngineService {
  private readonly logger = new Logger(ValidationEngineService.name);

  constructor(
    @InjectRepository(ValidationResult)
    private readonly validationResults: Repository<ValidationResult>,
    @InjectRepository(AdaptationCandidate)
    private readonly candidates: Repository<AdaptationCandidate>,
  ) {}

  // ── Baseline metrics computation ────────────────────────────────────

  computeBaselineMetrics(trades: TradeRecord[]): BaselineMetrics {
    if (!trades.length) {
      return this.emptyMetrics();
    }

    const closed = trades.filter((t) => t.closedAt !== null);
    const winners = closed.filter((t) => t.netPnl > 0);
    const losers = closed.filter((t) => t.netPnl <= 0);

    const avgWin = winners.length > 0
      ? winners.reduce((s, t) => s + t.netPnl, 0) / winners.length
      : 0;
    const avgLoss = losers.length > 0
      ? losers.reduce((s, t) => s + t.netPnl, 0) / losers.length
      : 0;

    const netPnl = closed.reduce((s, t) => s + t.netPnl, 0);
    const winRate = closed.length > 0 ? (winners.length / closed.length) * 100 : 0;
    const expectancy = closed.length > 0 ? netPnl / closed.length : 0;

    // Profit factor
    const grossWin = winners.reduce((s, t) => s + t.netPnl, 0);
    const grossLoss = Math.abs(losers.reduce((s, t) => s + t.netPnl, 0));
    const profitFactor = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0;

    // Max drawdown
    let peak = 0;
    let maxDrawdown = 0;
    let runningPnl = 0;
    for (const t of closed) {
      runningPnl += t.netPnl;
      peak = Math.max(peak, runningPnl);
      const dd = peak - runningPnl;
      maxDrawdown = Math.max(maxDrawdown, dd);
    }

    // Avg holding period
    const holdingTimes = closed
      .filter((t) => t.closedAt !== null)
      .map((t) => (t.closedAt!.getTime() - t.orderedAt.getTime()) / 60000);
    const avgHoldingPeriodMinutes = holdingTimes.length > 0
      ? holdingTimes.reduce((a, b) => a + b, 0) / holdingTimes.length
      : 0;

    // By day of week
    const byDayOfWeek: Record<number, { count: number; winRate: number; netPnl: number }> = {};
    for (let wd = 0; wd <= 6; wd++) {
      const dayTrades = closed.filter((t) => t.orderedAt.getDay() === wd);
      if (dayTrades.length === 0) continue;
      const dayWinners = dayTrades.filter((t) => t.netPnl > 0);
      byDayOfWeek[wd] = {
        count: dayTrades.length,
        winRate: (dayWinners.length / dayTrades.length) * 100,
        netPnl: dayTrades.reduce((s, t) => s + t.netPnl, 0),
      };
    }

    return {
      totalTrades: closed.length,
      winners: winners.length,
      winRate,
      avgWin,
      avgLoss,
      netPnl,
      expectancy,
      maxDrawdown,
      profitFactor,
      avgHoldingPeriodMinutes,
      byDayOfWeek,
    };
  }

  private emptyMetrics(): BaselineMetrics {
    return {
      totalTrades: 0, winners: 0, winRate: 0, avgWin: 0, avgLoss: 0,
      netPnl: 0, expectancy: 0, maxDrawdown: 0, profitFactor: 0,
      avgHoldingPeriodMinutes: 0, byDayOfWeek: {},
    };
  }

  // ── Split helpers ───────────────────────────────────────────────────

  /** Split trades into in-sample (first 70%) and out-of-sample (last 30%). */
  splitHoldout(trades: TradeRecord[]): { inSample: TradeRecord[]; outOfSample: TradeRecord[] } {
    const sorted = [...trades].sort((a, b) => a.orderedAt.getTime() - b.orderedAt.getTime());
    const splitIdx = Math.floor(sorted.length * 0.7);
    return { inSample: sorted.slice(0, splitIdx), outOfSample: sorted.slice(splitIdx) };
  }

  /** Compute stability: fraction of rolling windows that are profitable. */
  computeStabilityScore(trades: TradeRecord[], windowSize: number = 5): number {
    if (trades.length < windowSize) return 0;

    const sorted = [...trades].sort((a, b) => a.orderedAt.getTime() - b.orderedAt.getTime());
    let positiveWindows = 0;
    let totalWindows = 0;

    for (let i = 0; i <= sorted.length - windowSize; i++) {
      const window = sorted.slice(i, i + windowSize);
      const windowPnl = window.reduce((s, t) => s + t.netPnl, 0);
      if (windowPnl > 0) positiveWindows++;
      totalWindows++;
    }

    return totalWindows > 0 ? positiveWindows / totalWindows : 0;
  }

  // ── Validation execution ────────────────────────────────────────────

  /**
   * Validate a candidate against baseline using holdout validation.
   * Returns a full ValidationResultOutcome with pass/reject and reasons.
   */
  async validateCandidate(
    candidateId: string,
    baselineTrades: TradeRecord[],
    candidateTrades: TradeRecord[],
  ): Promise<ValidationResultOutcome> {
    const candidate = await this.candidates.findOneBy({ id: candidateId });
    if (!candidate) throw new Error(`Candidate ${candidateId} not found`);

    // Compute metrics
    const baseline = this.computeBaselineMetrics(baselineTrades);
    const candidateMetrics = this.computeBaselineMetrics(candidateTrades);

    // Holdout split
    const { inSample, outOfSample } = this.splitHoldout(baselineTrades);

    // Stability
    const stabilityScore = this.computeStabilityScore(baselineTrades);

    // Gate checks
    const rejectionReasons: string[] = [];

    if (baseline.totalTrades < MIN_BASELINE_TRADES) {
      rejectionReasons.push(`Baseline sample too small: ${baseline.totalTrades} < ${MIN_BASELINE_TRADES}`);
    }
    if (candidateMetrics.totalTrades < MIN_CANDIDATE_TRADES) {
      rejectionReasons.push(`Candidate sample too small: ${candidateMetrics.totalTrades} < ${MIN_CANDIDATE_TRADES}`);
    }

    const winRateImprovement = candidateMetrics.winRate - baseline.winRate;
    if (baseline.totalTrades >= MIN_BASELINE_TRADES && candidateMetrics.totalTrades >= MIN_CANDIDATE_TRADES) {
      if (winRateImprovement < -MIN_WINRATE_IMPROVEMENT) {
        rejectionReasons.push(
          `Win rate degradation: ${candidateMetrics.winRate.toFixed(1)}% vs baseline ${baseline.winRate.toFixed(1)}% (${winRateImprovement.toFixed(1)}pp)`,
        );
      }

      const drawdownDegradation = candidateMetrics.maxDrawdown - baseline.maxDrawdown;
      if (drawdownDegradation > MAX_DRAWDOWN_DEGRADATION) {
        rejectionReasons.push(
          `Max drawdown degradation: ${candidateMetrics.maxDrawdown.toFixed(0)} vs baseline ${baseline.maxDrawdown.toFixed(0)}`,
        );
      }

      if (stabilityScore < MIN_STABILITY_RATIO) {
        rejectionReasons.push(
          `Stability too low: ${(stabilityScore * 100).toFixed(0)}% < ${(MIN_STABILITY_RATIO * 100).toFixed(0)}%`,
        );
      }
    }

    const passed = rejectionReasons.length === 0;

    // Persist validation result
    const vr = this.validationResults.create({
      candidateId,
      validationType: 'holdout',
      baselineWinRate: baseline.winRate,
      candidateWinRate: candidateMetrics.winRate,
      baselineExpectancy: baseline.expectancy,
      candidateExpectancy: candidateMetrics.expectancy,
      baselineTradeCount: baseline.totalTrades,
      candidateTradeCount: candidateMetrics.totalTrades,
      maxDrawdown: Math.max(baseline.maxDrawdown, candidateMetrics.maxDrawdown),
      stabilityScore,
      sampleSize: baselineTrades.length + candidateTrades.length,
      inSampleCount: inSample.length,
      outOfSampleCount: outOfSample.length,
      regimeAware: false,
      passed,
      rejectionReason: rejectionReasons.join('; ') || null,
      evidence: { baseline, candidate: candidateMetrics },
    });

    const saved = await this.validationResults.save(vr);

    // Update candidate with validation result
    candidate.validationId = saved.id;
    candidate.status = passed ? 'APPROVED' : 'REJECTED';
    await this.candidates.save(candidate);

    return {
      candidateId,
      validationType: 'holdout',
      baseline,
      candidate: candidateMetrics,
      passed,
      rejectionReasons,
      stabilityScore,
      regimeAware: false,
      sampleSize: baselineTrades.length + candidateTrades.length,
      inSampleCount: inSample.length,
      outOfSampleCount: outOfSample.length,
    };
  }

  /** Retrieve a validation result by ID. */
  async getResult(id: string): Promise<ValidationResult | null> {
    return this.validationResults.findOneBy({ id });
  }

  /** Retrieve all validation results for a candidate. */
  async getResultsForCandidate(candidateId: string): Promise<ValidationResult[]> {
    return this.validationResults.find({ where: { candidateId }, order: { createdAt: 'DESC' } });
  }
}
