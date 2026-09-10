import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  PaperRiskSnapshot,
  RISK_POLICY_VERSION,
  RiskPolicy,
  clampCapital,
  paperRiskSnapshot,
  riskPolicyFromEnv,
} from './paper-risk';
import { UpstoxLivePaperSession } from './upstox-live-paper-session.entity';
import { UpstoxLivePaperPortfolio } from './upstox-live-paper-portfolio.entity';
import { UpstoxLivePaperPnlEvent } from './upstox-live-paper-pnl-event.entity';
import { ENTRY_STRATEGY_VERSION } from './upstox-live-paper-entry-policy';
import { IST_OFFSET_MS, istDateOf } from './upstox-live-paper-instruction.rules';

/**
 * Account capital + risk envelope for the Upstox paper desk.
 *
 * ONE PLACE answers "how much may this account risk?" — and it answers it from
 * the account's OWN configured capital, never from a constant. The strategy asks
 * this service for a snapshot and uses it only for sizing/exposure.
 *
 * Changing the cap is a first-class, audited operation:
 *   - the portfolio row's capital/ceiling move to the new value
 *   - a CAPITAL_CHANGED event records old → new
 *   - the current session row keeps the capital it STARTED with
 *   - no trade, no P&L and no past session is ever rewritten
 * so a ₹2,000 session stays a ₹2,000 session after the cap moves to ₹10,000.
 */
@Injectable()
export class UpstoxLivePaperRiskService {
  private readonly logger = new Logger(UpstoxLivePaperRiskService.name);

  constructor(
    @InjectRepository(UpstoxLivePaperPortfolio) private readonly portfolios: Repository<UpstoxLivePaperPortfolio>,
    @InjectRepository(UpstoxLivePaperSession) private readonly sessions: Repository<UpstoxLivePaperSession>,
    @InjectRepository(UpstoxLivePaperPnlEvent) private readonly pnlEvents: Repository<UpstoxLivePaperPnlEvent>,
  ) {}

  /** Today's IST trading date, 'YYYY-MM-DD'. */
  todayIst(now = Date.now()): string {
    return istDateOf(now);
  }

  /** Minute-of-day in IST, for the session-window and time-stop rules. */
  istMinutes(now = Date.now()): number {
    const shifted = new Date(now + IST_OFFSET_MS);
    return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
  }

  /**
   * The policy in force for one account: the account's own recorded capital plus
   * the configured percentages. An account created at ₹2,000 keeps ₹2,000 even
   * if the environment default is ₹5,000, so historical accounts stay honest.
   */
  policyFor(portfolio: Pick<UpstoxLivePaperPortfolio, 'capital'>): RiskPolicy {
    return riskPolicyFromEnv(process.env, {
      configuredCapital: clampCapital(portfolio?.capital),
    });
  }

  /**
   * The live risk envelope for one account: equity, per-trade risk budget,
   * session loss limit, drawdown limit, deployable and position/lot caps — all
   * scaled from that account's configured capital.
   */
  async snapshotFor(portfolioId: string): Promise<{ policy: RiskPolicy; snapshot: PaperRiskSnapshot; session: UpstoxLivePaperSession | null }> {
    const portfolio = await this.portfolios.findOne({ where: { id: portfolioId } });
    if (!portfolio) throw new NotFoundException(`Upstox paper portfolio ${portfolioId} not found`);

    const policy = this.policyFor(portfolio);
    // The ACTIVE session of today (a capital reconfiguration supersedes the old
    // row and opens a fresh one).
    const session = await this.sessions.findOne({
      where: { portfolioId, sessionDate: this.todayIst(), status: 'OPEN' },
      order: { createdAt: 'DESC' },
    });
    // Peak is measured within the CURRENT capital configuration: rows superseded
    // by a reconfiguration are excluded, so drawdown and max-loss scale from the
    // capital now configured while the old rows stay untouched as history.
    const peakRows = await this.sessions.find({
      where: { portfolioId, status: 'OPEN' },
      order: { peakEquity: 'DESC' },
      take: 1,
    });
    const peakEquity = Math.max(
      Number(peakRows[0]?.peakEquity ?? 0),
      Number(portfolio.capital) + Number(portfolio.netPnl),
      Number(session?.startingEquity ?? 0),
    );

    const snapshot = paperRiskSnapshot(
      {
        capital: Number(portfolio.capital),
        deployed: Number(portfolio.deployed),
        netPnl: Number(portfolio.netPnl),
        unrealisedPnl: Number(portfolio.unrealisedPnl),
        openPositionCount: Number(portfolio.openPositionCount ?? 0),
        peakEquity,
        sessionStartEquity: session ? Number(session.startingEquity) : null,
      },
      policy,
    );
    return { policy, snapshot, session };
  }

  /**
   * Record this session's configured starting capital — the operator's
   * "each training session/account should record its configured starting
   * capital". Created once per account per IST day; safe to call on every tick.
   */
  async ensureSession(portfolioId: string, now = Date.now()): Promise<UpstoxLivePaperSession> {
    const portfolio = await this.portfolios.findOne({ where: { id: portfolioId } });
    if (!portfolio) throw new NotFoundException(`Upstox paper portfolio ${portfolioId} not found`);

    const sessionDate = this.todayIst(now);
    const policy = this.policyFor(portfolio);
    let session = await this.sessions.findOne({
      where: { portfolioId, sessionDate, status: 'OPEN' },
      order: { createdAt: 'DESC' },
    });

    if (!session) {
      session = await this.sessions.save(this.sessions.create({
        portfolioId,
        sessionDate,
        startingCapital: clampCapital(portfolio.capital),
        startingEquity: Number(portfolio.capital) + Number(portfolio.netPnl) + Number(portfolio.unrealisedPnl),
        endingEquity: Number(portfolio.capital) + Number(portfolio.netPnl) + Number(portfolio.unrealisedPnl),
        sessionNetPnl: 0,
        peakEquity: Number(portfolio.capital) + Number(portfolio.netPnl) + Number(portfolio.unrealisedPnl),
        riskMode: policy.mode,
        // Frozen copy: percentages + limits as they stood when the session began.
        riskPolicy: { ...policy } as unknown as Record<string, unknown>,
        riskPolicyVersion: RISK_POLICY_VERSION,
        strategyVersion: ENTRY_STRATEGY_VERSION,
        status: 'OPEN',
      }));
      this.logger.log(
        `[UPSTOX-LIVE-PAPER] training session ${sessionDate} opened · configured capital ₹${policy.configuredCapital} · ` +
        `risk ${policy.maxRiskPerTradePct}%/trade · max ${policy.maxOpenPositions} position(s) · ${ENTRY_STRATEGY_VERSION}`,
      );
    }

    const equity = Number(portfolio.capital) + Number(portfolio.netPnl) + Number(portfolio.unrealisedPnl);
    await this.sessions.update(session.id, {
      endingEquity: equity,
      sessionNetPnl: equity - Number(session.startingEquity),
      peakEquity: Math.max(Number(session.peakEquity ?? 0), equity),
    });
    return (await this.sessions.findOne({ where: { id: session.id } })) as UpstoxLivePaperSession;
  }

  /**
   * Change the account's configured paper capital. Audited, and deliberately
   * non-destructive: history keeps the capital it was produced under.
   */
  async updateCapital(portfolioId: string, newCapital: number, options: { reason?: string; actor?: string } = {}): Promise<UpstoxLivePaperPortfolio> {
    const portfolio = await this.portfolios.findOne({ where: { id: portfolioId } });
    if (!portfolio) throw new NotFoundException(`Upstox paper portfolio ${portfolioId} not found`);

    const previous = Number(portfolio.capital);
    const next = clampCapital(newCapital);
    if (next === previous) return portfolio;

    // Deployed stays as it is: outstanding premium was committed at the old cap
    // and is not rewritten. Only the envelope changes, from now on.
    await this.portfolios.update(portfolioId, { capital: next, ceiling: next });
    await this.pnlEvents.save(this.pnlEvents.create({
      portfolioId,
      tradeId: null,
      eventType: 'CAPITAL_CHANGED',
      pnlDelta: 0,
      runningNetPnl: Number(portfolio.netPnl),
      description: `Configured paper capital ₹${previous.toFixed(2)} → ₹${next.toFixed(2)}${options.reason ? ` · ${options.reason}` : ''}${options.actor ? ` · by ${options.actor}` : ''}`,
      context: JSON.stringify({
        previousCapital: previous,
        newCapital: next,
        configuredBy: options.actor ?? 'operator',
        reason: options.reason ?? null,
        riskPolicyVersion: RISK_POLICY_VERSION,
        note: 'historical trades, P&L and sessions keep their original capital configuration',
      }),
      ts: new Date(),
    }));
    this.logger.log(`[UPSTOX-LIVE-PAPER] configured capital ₹${previous} → ₹${next} (history preserved)`);

    // A capital change starts a NEW training configuration: the active session
    // is closed under the capital it actually ran with (its numbers are kept
    // verbatim) and a fresh session opens, so every limit — risk/trade, max
    // loss, drawdown, exposure — scales from the capital now configured.
    const sessionDate = this.todayIst();
    const active = await this.sessions.find({ where: { portfolioId, sessionDate, status: 'OPEN' } });
    const runningEquity = Number(portfolio.capital) + Number(portfolio.netPnl) + Number(portfolio.unrealisedPnl);
    for (const s of active) {
      await this.sessions.update(s.id, {
        status: 'SUPERSEDED',
        endingEquity: runningEquity,
        sessionNetPnl: runningEquity - Number(s.startingEquity),
        supersededReason: `capital reconfigured ₹${previous.toFixed(2)} → ₹${next.toFixed(2)}`,
      });
    }
    // Always leave today with an ACTIVE session under the new capital, so the
    // recorded configuration matches the envelope actually in force.
    await this.ensureSession(portfolioId);

    return (await this.portfolios.findOne({ where: { id: portfolioId } })) as UpstoxLivePaperPortfolio;
  }

  /** Every session configuration this account has run under, newest first. */
  async listSessions(portfolioId: string, limit = 60): Promise<UpstoxLivePaperSession[]> {
    return this.sessions.find({ where: { portfolioId }, order: { sessionDate: 'DESC' }, take: Math.min(365, Math.max(1, limit)) });
  }

  /**
   * Risk envelope + policy for every account, so the operator can see what each
   * one is allowed to risk at its own configured capital.
   */
  async overview(): Promise<Array<Record<string, unknown>>> {
    const portfolios = await this.portfolios.find({ order: { createdAt: 'ASC' } });
    const out: Array<Record<string, unknown>> = [];
    for (const p of portfolios) {
      const { policy, snapshot } = await this.snapshotFor(p.id);
      out.push({
        portfolioId: p.id,
        label: p.label,
        configuredCapital: snapshot.configuredCapital,
        equity: snapshot.equity,
        netPnl: Number(p.netPnl),
        deployed: snapshot.deployed,
        deployable: snapshot.deployable,
        riskMode: snapshot.mode,
        riskBase: snapshot.riskBase,
        riskBaseSource: snapshot.riskBaseSource,
        maxRiskPerTrade: snapshot.maxRiskPerTrade,
        maxRiskPerTradePct: snapshot.maxRiskPerTradePct,
        maxLossAmount: snapshot.maxLossAmount,
        maxLossPct: snapshot.maxLossPct,
        maxDrawdownAmount: snapshot.maxDrawdownAmount,
        maxDrawdownPct: snapshot.maxDrawdownPct,
        maxOpenPositions: snapshot.maxOpenPositions,
        maxLotsPerPosition: snapshot.maxLotsPerPosition,
        allowAveragingDown: snapshot.allowAveragingDown,
        openPositionCount: snapshot.openPositionCount,
        riskPolicyVersion: policy.version,
        strategyVersion: ENTRY_STRATEGY_VERSION,
        checks: snapshot.checks,
      });
    }
    return out;
  }

  /** REFUSES a capital the engine cannot honour, instead of silently clamping. */
  validateCapitalRequested(value: unknown): number {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) throw new BadRequestException('capital must be a positive number');
    const clamped = clampCapital(n);
    if (clamped !== Math.round(n * 100) / 100) {
      throw new BadRequestException(`capital ${n} is outside the supported range (${clampCapital(0.0001)} … ) — refused rather than silently adjusted`);
    }
    return clamped;
  }
}
