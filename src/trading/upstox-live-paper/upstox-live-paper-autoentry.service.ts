import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThanOrEqual, Repository } from 'typeorm';
import {
  ChainLeg,
  Candle,
  PatternAssessment,
  TickLike,
  assessPattern,
  atr,
  bucketCandles,
  patternThresholdsFromEnv,
} from '../pattern-engine/pattern-features';
import {
  AtmCandidateLeg,
  ENTRY_STRATEGY_VERSION,
  buildAtmUniverse,
  entryPolicyThresholdsFromEnv,
  evaluateEntryV1,
  evaluateExitV1,
} from './upstox-live-paper-entry-policy';
import { UpstoxLivePaperOptionQuote } from './upstox-live-paper-option-quote.entity';
import { UpstoxLivePaperMarketSnapshot } from './upstox-live-paper-market-snapshot.entity';
import { UpstoxLivePaperPortfolio } from './upstox-live-paper-portfolio.entity';
import { UpstoxLivePaperTrade } from './upstox-live-paper-trade.entity';
import { UpstoxLivePaperService } from './upstox-live-paper.service';
import { UpstoxLivePaperRiskService } from './upstox-live-paper-risk.service';
import { UpstoxLivePaperLearningService } from './upstox-live-paper-learning.service';
import { UpstoxLivePaperConfig } from './upstox-live-paper.config';
import { IST_OFFSET_MS, IST_SESSION_CLOSE_MINUTES } from './upstox-live-paper-instruction.rules';
import { PaperRiskSnapshot } from './paper-risk';

/** The desk only evaluates inside the Indian cash session (IST). */
const SESSION_OPEN_MINUTES = 9 * 60 + 15;
const SESSION_CLOSE_MINUTES = IST_SESSION_CLOSE_MINUTES;
const BUCKET_MS = 5 * 60_000;

/**
 * UPSTOX_AUTO_PAPER_ENTRY_V1 — the unattended entry/exit loop for the Upstox
 * paper account.
 *
 * It is the ONE place a V1 position can be opened, and it opens at most one:
 *   - the account's own risk envelope decides sizing and whether anything is
 *     allowed at all (1% of that account's CURRENT equity, per the operator),
 *   - the ATM CE/PE universe comes from the desk's live chain (broker contract
 *     master for lot size/expiry — never an assumed expiry),
 *   - every leg evaluated is journalled, qualified OR refused,
 *   - the open position is managed FIRST each tick (trail / stop / invalidation
 *     / expiry-day time stop) so an exit can never be starved by entry work.
 *
 * It cannot reach a real order: it calls the desk's paper fill path, and the
 * desk never submits to the Upstox order API.
 */
@Injectable()
export class UpstoxLivePaperAutoEntryService {
  private readonly logger = new Logger(UpstoxLivePaperAutoEntryService.name);
  private running = false;

  constructor(
    private readonly config: UpstoxLivePaperConfig,
    private readonly desk: UpstoxLivePaperService,
    private readonly risk: UpstoxLivePaperRiskService,
    private readonly learning: UpstoxLivePaperLearningService,
    @InjectRepository(UpstoxLivePaperPortfolio) private readonly portfolios: Repository<UpstoxLivePaperPortfolio>,
    @InjectRepository(UpstoxLivePaperOptionQuote) private readonly quotes: Repository<UpstoxLivePaperOptionQuote>,
    @InjectRepository(UpstoxLivePaperMarketSnapshot) private readonly snapshots: Repository<UpstoxLivePaperMarketSnapshot>,
    @InjectRepository(UpstoxLivePaperTrade) private readonly trades: Repository<UpstoxLivePaperTrade>,
  ) {}

  /** V1 auto-entry is on unless explicitly disabled. Real orders stay impossible. */
  get enabled(): boolean {
    return /^(1|true|yes)$/i.test(process.env.UPSTOX_AUTO_PAPER_ENTRY_ENABLED ?? 'true');
  }

  private get lookbackMinutes(): number {
    return Math.max(30, Math.min(1440, Number(process.env.UPSTOX_AUTO_PAPER_LOOKBACK_MIN ?? 240) || 240));
  }

  private get intervalSeconds(): number {
    return Math.max(10, Math.min(600, Number(process.env.UPSTOX_AUTO_PAPER_INTERVAL_SEC ?? 30) || 30));
  }

  /**
   * The registered underlyings. The desk account model has no per-account
   * instrument, so the universe is the same one the desk ingests — the broker's
   * configured instruments, never a symbol invented here.
   */
  private get underlyings(): string[] {
    return this.config.liveInstruments;
  }

  private istMinutes(now: number): number {
    const t = new Date(now + IST_OFFSET_MS);
    return t.getUTCHours() * 60 + t.getUTCMinutes();
  }

  /** Same window the manual desk uses: only trade inside the cash session. */
  private withinSession(now: number): boolean {
    const minutes = this.istMinutes(now);
    if (minutes < SESSION_OPEN_MINUTES || minutes > SESSION_CLOSE_MINUTES) return false;
    const dow = new Date(now + IST_OFFSET_MS).getUTCDay();
    return dow >= 1 && dow <= 5;
  }

  @Cron('*/30 * * * * *', { name: 'upstox-live-paper-v1-autoentry' })
  async scheduledTick(): Promise<void> {
    if (!this.enabled) return;
    if (!this.withinSession(Date.now())) return;
    try {
      await this.runOnce();
    } catch (err) {
      this.logger.error(`[UPSTOX-AUTO-V1] tick failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  /**
   * Evidence labelling keeps its own clock and is NOT bound to the market
   * session: it only reads quotes already stored, so a label can be completed
   * after 15:30 from the same session's tape. Windows are clamped to the close,
   * so running after the bell can never turn an after-hours print into an
   * outcome. While the session is open the entry cycle already labels, so this
   * tick stays out of its way rather than doing the same work twice.
   */
  @Cron('*/30 * * * * *', { name: 'upstox-live-paper-v1-labelling' })
  async labellingTick(): Promise<void> {
    if (!this.enabled) return;
    if (this.withinSession(Date.now())) return;
    try {
      await this.labelStaleCandidates();
    } catch (err) {
      this.logger.error(`[UPSTOX-AUTO-V1] labelling tick failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  /**
   * One full V1 cycle: manage open risk first, then look for at most one entry.
   * Safe to call manually (the operator's dry-run / verification path).
   */
  async runOnce(now = Date.now()): Promise<Record<string, unknown>> {
    if (this.running) return { skipped: 'a cycle is already running' };
    this.running = true;
    const summary: Record<string, unknown> = {
      version: ENTRY_STRATEGY_VERSION,
      at: new Date(now).toISOString(),
      session: this.withinSession(now),
      accounts: [],
    };
    try {
      const armed = (await this.portfolios.find({ order: { createdAt: 'ASC' } }))
        .filter((p) => !!Number(p.autoTradeEnabled));
      for (const portfolio of armed) {
        const account: Record<string, unknown> = { portfolioId: portfolio.id, label: portfolio.label };
        // Records the configured starting capital of THIS session (per day).
        const session = await this.risk.ensureSession(portfolio.id, now);
        account.configuredCapital = Number(session.startingCapital);
        account.sessionDate = session.sessionDate;

        const { snapshot } = await this.risk.snapshotFor(portfolio.id);
        account.equity = snapshot.equity;
        account.maxRiskPerTrade = snapshot.maxRiskPerTrade;

        // Exits are never blocked by entry gates — risk first, always.
        account.managed = await this.manageOpenTrades(portfolio, snapshot, now);

        if (snapshot.openPositionCount >= snapshot.maxOpenPositions) {
          account.entrySkipped = `max open positions reached (${snapshot.openPositionCount}/${snapshot.maxOpenPositions})`;
          (summary.accounts as unknown[]).push(account);
          continue;
        }
        if (snapshot.maxLossHit) {
          account.entrySkipped = `session loss limit hit (${snapshot.maxLossAmount.toFixed(2)}, ${snapshot.maxLossPct}% of capital)`;
          (summary.accounts as unknown[]).push(account);
          continue;
        }
        if (snapshot.drawdownHit) {
          account.entrySkipped = `drawdown limit hit (${snapshot.maxDrawdownAmount.toFixed(2)}, ${snapshot.maxDrawdownPct}% of peak equity)`;
          (summary.accounts as unknown[]).push(account);
          continue;
        }

        account.scan = await this.scanForEntries(portfolio, snapshot, now);
        (summary.accounts as unknown[]).push(account);
      }
      summary.labelled = await this.labelStaleCandidates();
      return summary;
    } finally {
      this.running = false;
    }
  }

  /** ATM CE/PE candidates from the desk's own live chain, nearest expiry only. */
  private async atmUniverse(portfolio: UpstoxLivePaperPortfolio, snapshot: PaperRiskSnapshot) {
    const thresholds = entryPolicyThresholdsFromEnv();
    const since = new Date(Date.now() - this.lookbackMinutes * 60_000);
    const underlying = String(this.underlyings[0] ?? '');

    const rows = await this.quotes.find({
      where: { underlying, ts: MoreThanOrEqual(since) },
      order: { ts: 'DESC' },
      take: 6000,
    });
    if (!rows.length) return { legs: [] as AtmCandidateLeg[], spot: null as number | null, universe: null, thresholds, stale: 'no live option quotes in the lookback window' };

    // Latest tick per contract — a stale leg must not masquerade as the chain.
    const latest = new Map<string, UpstoxLivePaperOptionQuote>();
    for (const r of rows) if (!latest.has(r.contractSymbol)) latest.set(r.contractSymbol, r);

    const now = Date.now();
    const fresh = [...latest.values()].filter((r) => now - new Date(r.ts).getTime() <= this.config.staleQuoteMaxAgeMs * 4);
    if (!fresh.length) return { legs: [] as AtmCandidateLeg[], spot: null as number | null, universe: null, thresholds, stale: 'every contract tick is older than the stale-quote budget' };

    // NEAREST listed expiry, from the broker's own contract rows (never a
    // hard-coded date): today's expiry is used when today is expiry day.
    const today = await this.risk.todayIst();
    const expiries = [...new Set(fresh.map((r) => String(r.expiry).slice(0, 10)))]
      .filter((e) => e >= today)
      .sort();
    const expiry = expiries[0];
    if (!expiry) return { legs: [] as AtmCandidateLeg[], spot: null as number | null, universe: null, thresholds, stale: 'no expiry at or after today in the live chain' };

    const legs: AtmCandidateLeg[] = fresh
      .filter((r) => String(r.expiry).slice(0, 10) === expiry && Number(r.ltp) > 0)
      .map((r) => ({
        contractSymbol: r.contractSymbol,
        optionType: (String(r.optionType).toUpperCase() === 'PE' ? 'PE' : 'CE'),
        strike: Number(r.strike),
        expiry,
        ltp: Number(r.ltp),
        bid: r.bid === null ? null : Number(r.bid),
        ask: r.ask === null ? null : Number(r.ask),
        oi: Number(r.openInterest ?? 0),
        volume: Number(r.volume ?? 0),
      }));

    const spot = await this.latestSpot(underlying);
    const universe = buildAtmUniverse({ legs, spot, window: thresholds.atmStrikeWindow });
    return { legs, spot, universe, thresholds, stale: null as string | null };
  }

  private async latestSpot(underlying: string): Promise<number | null> {
    const row = await this.snapshots.findOne({ where: { instrument: underlying }, order: { ts: 'DESC' } });
    const price = row ? Number(row.price) : null;
    if (price !== null && Number.isFinite(price) && price > 0) return price;
    const byPrice = await this.quotes.findOne({ where: { underlying }, order: { ts: 'DESC' } });
    const fromLeg = byPrice?.underlyingPrice === null || byPrice?.underlyingPrice === undefined ? null : Number(byPrice.underlyingPrice);
    // Never invented: an underlying level must come from a real observation.
    return fromLeg !== null && Number.isFinite(fromLeg) && fromLeg > 0 ? fromLeg : null;
  }

  private async candlesFor(contractSymbol: string, underlying: string, since: Date): Promise<{ option: Candle[]; underlying: Candle[] }> {
    const [optRows, spotRows] = await Promise.all([
      this.quotes.find({ where: { contractSymbol, ts: MoreThanOrEqual(since) }, order: { ts: 'ASC' }, take: 3000 }),
      this.snapshots.find({ where: { instrument: underlying, ts: MoreThanOrEqual(since) }, order: { ts: 'ASC' }, take: 3000 }),
    ]);
    const optTicks: TickLike[] = optRows.map((r) => ({ ts: r.ts, price: Number(r.ltp ?? 0), volume: Number(r.volume ?? 0) }));
    const spotTicks: TickLike[] = spotRows.map((r) => ({ ts: r.ts, price: Number(r.price ?? 0), volume: Number(r.volume ?? 0) }));
    return { option: bucketCandles(optTicks, BUCKET_MS), underlying: bucketCandles(spotTicks, BUCKET_MS) };
  }

  private async chainLegs(underlying: string, expiry: string, strikes: Set<number>, since: Date): Promise<ChainLeg[]> {
    const rows = await this.quotes.find({ where: { underlying, ts: MoreThanOrEqual(since) }, order: { ts: 'DESC' }, take: 6000 });
    const latest = new Map<string, UpstoxLivePaperOptionQuote>();
    for (const r of rows) if (!latest.has(r.contractSymbol)) latest.set(r.contractSymbol, r);
    return [...latest.values()]
      .filter((r) => String(r.expiry).slice(0, 10) === expiry && strikes.has(Number(r.strike)))
      .map((r) => ({
        strike: Number(r.strike),
        optionType: (String(r.optionType).toUpperCase() === 'PE' ? 'PE' : 'CE') as 'CE' | 'PE',
        oi: Number(r.openInterest ?? 0),
        changeOi: Number(r.oiChange ?? 0),
        volume: Number(r.volume ?? 0),
        iv: r.impliedVolatility === null ? null : Number(r.impliedVolatility),
        ltp: Number(r.ltp ?? 0),
        bid: r.bid === null ? null : Number(r.bid),
        ask: r.ask === null ? null : Number(r.ask),
      }));
  }

  /** Evaluate the ATM universe; journal every leg; open at most one position. */
  private async scanForEntries(portfolio: UpstoxLivePaperPortfolio, snapshot: PaperRiskSnapshot, now: number): Promise<Record<string, unknown>> {
    const built = await this.atmUniverse(portfolio, snapshot);
    const thresholds = built.thresholds;
    if (!built.universe || !built.legs.length) {
      return { considered: 0, evaluated: 0, qualified: 0, opened: null, skipped: built.stale ?? 'no ATM universe' };
    }
    const sessionDate = await this.risk.todayIst(now);
    const nowIstMinutes = this.istMinutes(now);
    const since = new Date(now - this.lookbackMinutes * 60_000);
    const strikes = new Set<number>([...built.universe.ce, ...built.universe.pe].map((l) => Number(l.strike)));
    const chain = await this.chainLegs(String(this.underlyings[0] ?? ''), built.universe.ce[0]?.expiry ?? built.universe.pe[0]?.expiry ?? '', strikes, since);
    const patternThresholds = patternThresholdsFromEnv();

    let evaluated = 0;
    let qualified = 0;
    let opened: string | null = null;
    const decisions: Array<Record<string, unknown>> = [];

    // CE and PE of the ATM strike both get a fair evaluation; the better setup
    // wins, and only one may be taken (max 1 open position).
    for (const leg of [...built.universe.ce, ...built.universe.pe]) {
      const { option, underlying: underlyingCandles } = await this.candlesFor(leg.contractSymbol, String(this.underlyings[0] ?? ''), since);
      if (option.length < 4) continue;
      evaluated += 1;

      const latestQuote = (await this.quotes.findOne({ where: { contractSymbol: leg.contractSymbol }, order: { ts: 'DESC' } })) ?? null;
      const quoteTs = latestQuote ? new Date(latestQuote.ts).getTime() : null;
      const assessment: PatternAssessment = assessPattern({
        optionCandles: option,
        underlyingCandles,
        chainLegs: chain,
        quote: {
          ltp: leg.ltp,
          bid: leg.bid,
          ask: leg.ask,
          bidQty: latestQuote?.bidQty === null || latestQuote?.bidQty === undefined ? null : Number(latestQuote.bidQty),
          askQty: latestQuote?.askQty === null || latestQuote?.askQty === undefined ? null : Number(latestQuote.askQty),
          ts: latestQuote ? new Date(latestQuote.ts) : new Date(now),
          oi: leg.oi ?? null,
          changeOi: latestQuote?.oiChange === null || latestQuote?.oiChange === undefined ? null : Number(latestQuote.oiChange),
          iv: latestQuote?.impliedVolatility === null || latestQuote?.impliedVolatility === undefined ? null : Number(latestQuote.impliedVolatility),
        },
        optionType: leg.optionType,
        spot: built.spot,
        thresholds: patternThresholds,
      } as never);

      const optionAtr = atr(option, 14);
      const lotInfo = this.desk.lotSizeFor(leg.contractSymbol);
      const lotSize = lotInfo.lotSize ?? 0;
      const expiryIsToday = leg.expiry === sessionDate;

      const decision = evaluateEntryV1({
        assessment,
        optionAtr,
        premium: leg.ltp,
        bid: leg.bid,
        ask: leg.ask,
        lotSize,
        risk: snapshot,
        thresholds,
        nowIstMinutes,
        expiryIsToday,
        openSameContract: null,
      });

      const candidate = await this.learning.record({
        portfolioId: portfolio.id,
        sessionDate,
        contractSymbol: leg.contractSymbol,
        underlying: String(this.underlyings[0] ?? ''),
        expiry: leg.expiry,
        strike: leg.strike,
        optionType: leg.optionType,
        spot: built.spot,
        premium: leg.ltp,
        bid: leg.bid,
        ask: leg.ask,
        spreadPct: assessment.liquidity?.spreadPct === null || assessment.liquidity?.spreadPct === undefined ? null : Number(assessment.liquidity.spreadPct),
        volume: leg.volume ?? null,
        openInterest: leg.oi ?? null,
        oiChange: latestQuote?.oiChange === null || latestQuote?.oiChange === undefined ? null : Number(latestQuote.oiChange),
        iv: latestQuote?.impliedVolatility === null || latestQuote?.impliedVolatility === undefined ? null : Number(latestQuote.impliedVolatility),
        delta: latestQuote?.delta === null || latestQuote?.delta === undefined ? null : Number(latestQuote.delta),
        gamma: latestQuote?.gamma === null || latestQuote?.gamma === undefined ? null : Number(latestQuote.gamma),
        theta: latestQuote?.theta === null || latestQuote?.theta === undefined ? null : Number(latestQuote.theta),
        vega: latestQuote?.vega === null || latestQuote?.vega === undefined ? null : Number(latestQuote.vega),
        optionAtr,
        underlyingAtr: atr(underlyingCandles, 14),
        tickAgeMs: quoteTs === null ? null : Math.max(0, now - quoteTs),
        scores: decision.scores as unknown as Record<string, unknown>,
        thresholds: decision.thresholds as unknown as Record<string, unknown>,
        qualified: decision.qualified,
        decision: decision.side,
        refusals: decision.refusals,
        notes: decision.notes,
        entryState: decision.entryState,
        patternType: decision.patternType,
        confidence: decision.confidence,
        reversalScore: decision.reversalScore,
        plannedEntry: leg.ltp,
        plannedStop: decision.stop,
        plannedTarget: decision.target,
        plannedRewardRisk: decision.rewardRisk,
        plannedRisk: decision.risk.plannedRisk,
        plannedRiskPct: decision.risk.plannedRiskPct,
        lots: decision.sizing && decision.sizing.allowed === true ? decision.sizing.lots : null,
        lotSize,
        configuredCapital: decision.risk.configuredCapital,
        riskBase: decision.risk.riskBase,
      });

      decisions.push({
        contractSymbol: leg.contractSymbol,
        optionType: leg.optionType,
        strike: leg.strike,
        premium: leg.ltp,
        confidence: decision.confidence,
        reversalScore: decision.reversalScore,
        entryState: decision.entryState,
        qualified: decision.qualified,
        refusals: decision.refusals,
        candidateId: candidate.id,
      });

      if (!decision.qualified) continue;
      qualified += 1;

      if (opened) continue; // one position per account, per V1
      const sizing = decision.sizing;
      if (!sizing || sizing.allowed !== true) continue;
      if (!lotSize || !Number.isFinite(lotSize) || lotSize <= 0) continue;

      const trade = await this.desk.openTrade({
        portfolioId: portfolio.id,
        instrument: leg.contractSymbol,
        side: 'BUY',
        quantity: sizing.lots,
        lotSize,
        entryPrice: leg.ltp,
        algoSource: ENTRY_STRATEGY_VERSION,
        decisionParams: JSON.stringify({
          strategyVersion: ENTRY_STRATEGY_VERSION,
          candidateId: candidate.id,
          side: decision.side,
          confidence: decision.confidence,
          reversalScore: decision.reversalScore,
          entryState: decision.entryState,
          stop: decision.stop,
          target: decision.target,
          rewardRisk: decision.rewardRisk,
          plannedRisk: decision.risk.plannedRisk,
          plannedRiskPct: decision.risk.plannedRiskPct,
          configuredCapital: decision.risk.configuredCapital,
          thresholds: decision.thresholds,
        }),
        decisionId: candidate.id,
      });
      await this.learning.markEntered(candidate.id, { tradeId: trade.id, entryPrice: Number(trade.entryPrice) });
      opened = trade.id;
      this.logger.log(
        `[UPSTOX-AUTO-V1] OPEN ${leg.contractSymbol} ${sizing.lots} lot(s) @ ₹${leg.ltp} · ` +
        `conf ${decision.confidence.toFixed(3)} · stop ₹${decision.stop?.toFixed(2)} target ₹${decision.target?.toFixed(2)} · ` +
        `risk ₹${decision.risk.plannedRisk?.toFixed(2)} (${decision.risk.plannedRiskPct?.toFixed(2)}% of ₹${decision.risk.configuredCapital})`,
      );
    }

    return {
      considered: built.universe.considered,
      atmStrike: built.universe.atmStrike,
      spot: built.spot,
      evaluated,
      qualified,
      opened,
      decisions,
    };
  }

  /** Trail / stop / invalidation / time stop — evaluated before any entry work. */
  private async manageOpenTrades(portfolio: UpstoxLivePaperPortfolio, snapshot: PaperRiskSnapshot, now: number): Promise<Array<Record<string, unknown>>> {
    const open = (await this.trades.find({ where: { portfolioId: portfolio.id, status: 'OPEN' }, order: { orderedAt: 'ASC' } }));
    const out: Array<Record<string, unknown>> = [];
    if (!open.length) return out;

    const thresholds = entryPolicyThresholdsFromEnv();
    const sessionDate = await this.risk.todayIst(now);
    const nowIstMinutes = this.istMinutes(now);

    for (const trade of open) {
      const latest = await this.quotes.findOne({ where: { contractSymbol: trade.instrument }, order: { ts: 'DESC' } });
      if (!latest) { out.push({ tradeId: trade.id, status: 'no quote' }); continue; }

      const ltp = Number(latest.ltp);
      if (!(ltp > 0)) { out.push({ tradeId: trade.id, status: 'invalid premium' }); continue; }

      const entryPrice = Number(trade.entryPrice);
      const entryTs = trade.orderedAt ?? trade.entryQuoteTs ?? new Date(now);
      const candidate = await this.findCandidateFor(trade.id);
      if (candidate) await this.learning.updateExcursion(candidate.id, ltp);

      const since = new Date(new Date(entryTs).getTime() - 60_000);
      const { option, underlying: underlyingCandles } = await this.candlesFor(trade.instrument, String(this.underlyings[0] ?? ''), since);
      const optionAtr = atr(option, 14);
      const optionType: 'CE' | 'PE' = (String(candidate?.optionType ?? (trade.instrument.endsWith('PE') ? 'PE' : 'CE')).toUpperCase() === 'PE' ? 'PE' : 'CE');

      const tickRows = await this.quotes.find({ where: { contractSymbol: trade.instrument, ts: MoreThanOrEqual(since) }, order: { ts: 'ASC' }, take: 3000 });
      let highest = entryPrice;
      let lowest = entryPrice;
      for (const r of tickRows) {
        const p = Number(r.ltp);
        if (p > 0) { highest = Math.max(highest, p); lowest = Math.min(lowest, p); }
      }

      // Setup invalidation is measured with the SAME feature engine, so the exit
      // reasons mean the same thing as the entry reasons.
      let setupInvalidated = false;
      let adverseReversalScore: number | null = null;
      const expiry = candidate?.expiry ? String(candidate.expiry).slice(0, 10) : (latest.expiry ? String(latest.expiry).slice(0, 10) : sessionDate);
      const chain = await this.chainLegs(String(this.underlyings[0] ?? ''), expiry, new Set([Number(latest.strike)]), since);
      if (option.length >= 4 && optionType === (String(latest.optionType).toUpperCase() === 'PE' ? 'PE' : 'CE')) {
        const assessment = assessPattern({
          optionCandles: option,
          underlyingCandles,
          chainLegs: chain,
          quote: {
            ltp, bid: latest.bid === null ? null : Number(latest.bid), ask: latest.ask === null ? null : Number(latest.ask),
            bidQty: latest.bidQty === null ? null : Number(latest.bidQty), askQty: latest.askQty === null ? null : Number(latest.askQty),
            ts: new Date(latest.ts), oi: latest.openInterest === null ? null : Number(latest.openInterest),
            changeOi: latest.oiChange === null ? null : Number(latest.oiChange),
            iv: latest.impliedVolatility === null ? null : Number(latest.impliedVolatility),
          },
          optionType,
          spot: await this.latestSpot(String(this.underlyings[0] ?? '')),
          thresholds: patternThresholdsFromEnv(),
        } as never);
        setupInvalidated = assessment.signal === 'NO_TRADE' && assessment.entryState !== 'EARLY_REVERSAL';
        adverseReversalScore = Number(assessment.reversal?.score ?? 0);
      }

      const initialStop = candidate?.plannedStop === null || candidate?.plannedStop === undefined ? entryPrice * 0.9 : Number(candidate.plannedStop);
      const target = candidate?.plannedTarget === null || candidate?.plannedTarget === undefined ? null : Number(candidate.plannedTarget);

      const exit = evaluateExitV1({
        entryPrice,
        initialStop,
        target,
        ltp,
        highestLtp: highest,
        lowestLtp: lowest,
        optionAtr,
        barsHeld: option.length,
        nowIstMinutes,
        expiryIsToday: expiry === sessionDate,
        setupInvalidated,
        adverseReversalScore,
        thresholds,
      });

      if (!exit.exit) {
        out.push({ tradeId: trade.id, ltp, stop: exit.stop, exit: false, notes: exit.notes });
        continue;
      }

      const closed = await this.desk.closeTrade({ tradeId: trade.id, exitPrice: ltp, exitTrigger: exit.reason ?? 'V1_EXIT' });
      if (candidate) await this.learning.markExit(candidate.id, { exitPrice: Number(closed.exitPrice), exitReason: exit.reason ?? 'V1_EXIT' });
      this.logger.log(`[UPSTOX-AUTO-V1] CLOSE ${trade.instrument} @ ₹${ltp} · ${exit.reason} · MFE ${((highest - entryPrice) / entryPrice * 100).toFixed(1)}% MAE ${((lowest - entryPrice) / entryPrice * 100).toFixed(1)}%`);
      out.push({ tradeId: trade.id, ltp, exit: true, reason: exit.reason, candidateId: candidate?.id ?? null });
      void snapshot;
    }
    return out;
  }

  private async findCandidateFor(tradeId: string) {
    return this.learning.findByTradeId(tradeId);
  }

  /** Fill in 5/10/15/30/60-minute outcomes for candidates whose tape has arrived. */
  private async labelStaleCandidates(): Promise<number> {
    const rows = await this.learning.pendingLabelling(50);
    let labelled = 0;
    const now = Date.now();
    for (const row of rows) {
      const anchor = new Date(row.entryTs ?? row.evaluatedAt).getTime();
      if (now - anchor < 5 * 60_000) continue;
      const updated = await this.learning.labelOutcomeFor(row.id);
      if (updated) labelled += 1;
    }
    return labelled;
  }

  /** Operator-facing description of the live V1 configuration. */
  policyDescription(): Record<string, unknown> {
    const thresholds = entryPolicyThresholdsFromEnv();
    return {
      version: ENTRY_STRATEGY_VERSION,
      enabled: this.enabled,
      intervalSeconds: this.intervalSeconds,
      lookbackMinutes: this.lookbackMinutes,
      sessionWindowIst: '09:15–15:30',
      // The env keys that govern this loop, so the operator can see what to edit
      // to change it (values are read per run; a pm2 restart applies an .env edit).
      configKeys: ['UPSTOX_AUTO_PAPER_ENTRY_ENABLED', 'UPSTOX_AUTO_PAPER_LOOKBACK_MIN', 'UPSTOX_AUTO_PAPER_INTERVAL_SEC'],
      thresholds,
    };
  }
}
