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
import { UnifiedMarketDataService } from '../unified-market-data/unified-market-data.service';
import {
  COMMON_CHAIN_VERSION,
  CommonChainRow,
  chainSourceDecision,
  commonChainRowFromUnified,
  commonRowsToAtmLegs,
  commonRowsToChainLegs,
  nearestExpiry,
} from './upstox-live-paper-common-chain';

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
    private readonly unified: UnifiedMarketDataService,
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

  /**
   * The desk's OWN stores key option quotes and index snapshots by the
   * NORMALIZED symbol — UpstoxLivePaperMarketService.symbolFromKey maps the broker
   * instrument key 'BSE_INDEX|SENSEX' to 'SENSEX' and writes that value into
   * upstox_live_paper_option_quotes.underlying / ..._market_snapshots.instrument.
   * UPSTOX_LIVE_INSTRUMENTS carries the BROKER key (correct for the market-data
   * API, wrong for these stores). Querying the stores with the raw broker key
   * matched nothing, so the ATM universe came back empty and no candidate was EVER
   * recorded (2026-09-11 audit: 0 rows for 'BSE_INDEX|SENSEX' vs 36,951 for
   * 'SENSEX' in the 240-minute lookback; candidates/instructions/trades all 0).
   * All desk-store lookups therefore use this normalized form.
   */
  private get deskUnderlying(): string {
    return String(this.underlyings[0] ?? '')
      .split('|')
      .pop()!
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '');
  }

  /** Exchange of the desk's universe ('BSE_INDEX|SENSEX' → 'BSE'), for common-store matching. */
  private get deskExchange(): string {
    const key = String(this.underlyings[0] ?? '');
    return key.includes('_') ? key.split('_')[0].toUpperCase() : '';
  }

  /**
   * How old a COMMON-store observation may be for this desk to use it. A cross-process
   * read carries more latency than an in-process tick, so the shared path uses the
   * common layer's own budget (`UNIFIED_SHARED_QUOTE_MAX_AGE_MS`, the knob every other
   * consumer of the shared store uses) and never borrows the desk's tighter own-feed
   * budget. The desk's own-feed rule (`staleQuoteMaxAgeMs`) is unchanged; a tick's
   * true age is still journalled on the candidate as `tickAgeMs`.
   */
  private get sharedFallbackMaxAgeMs(): number {
    const configured = Number(process.env.UNIFIED_SHARED_QUOTE_MAX_AGE_MS);
    if (Number.isFinite(configured) && configured > 0) return configured;
    return 60_000;
  }

  /**
   * Rows of this desk's OWN table, normalised to the shared chain shape so a single
   * set of rules (expiry, ATM, legs) applies to either source.
   */
  private ownRowsToChainShape(rows: UpstoxLivePaperOptionQuote[]): CommonChainRow[] {
    const out: CommonChainRow[] = [];
    for (const r of rows) {
      const mapped = commonChainRowFromUnified({
        instrumentKey: r.contractSymbol,
        underlying: r.underlying,
        expiry: r.expiry,
        strike: r.strike,
        optionType: r.optionType,
        ltp: r.ltp,
        bid: r.bid,
        ask: r.ask,
        bidQty: r.bidQty,
        askQty: r.askQty,
        volume: r.volume,
        oi: r.openInterest,
        changeOi: r.oiChange,
        iv: r.impliedVolatility,
        delta: r.delta,
        gamma: r.gamma,
        theta: r.theta,
        vega: r.vega,
        receivedTimestamp: r.ts,
        source: 'UPSTOX_LIVE',
      } as unknown as Record<string, unknown>);
      if (mapped) out.push(mapped);
    }
    return out;
  }

  /**
   * The COMMON store's chain for this universe — read ONLY when this desk's own feed
   * has nothing fresh. Each row keeps its true producer; the desk never relabels it
   * as its own. A lookup failure degrades to "nothing" rather than an exception.
   */
  private async commonStoreChain(underlying: string): Promise<{ rows: CommonChainRow[]; producer: string | null }> {
    try {
      const found = await this.unified.sharedQuotesForUnderlying(underlying, { maxAgeMs: this.sharedFallbackMaxAgeMs });
      const rows = found
        .map((row) => commonChainRowFromUnified(row as unknown as Record<string, unknown>))
        .filter((row): row is CommonChainRow => row !== null);
      const producers = [...new Set(rows.map((r) => r.source).filter(Boolean))].sort();
      return { rows, producer: producers.length ? producers.join('+') : null };
    } catch (err) {
      this.logger.warn(`[UPSTOX-LIVE] common-store chain lookup failed for ${underlying}: ${err instanceof Error ? err.message : err}`);
      return { rows: [], producer: null };
    }
  }

  /** Throttled [UPSTOX] diagnostics (operator spec 2026-09-11): one line per
   *  distinct state, at most one repeat every 5 minutes. Never logs secrets. */
  private lastDiagLine = '';
  private lastDiagAt = 0;
  private logThrottled(line: string, everyMs = 300_000): void {
    const now = Date.now();
    if (line === this.lastDiagLine && now - this.lastDiagAt < everyMs) return;
    this.lastDiagLine = line;
    this.lastDiagAt = now;
    this.logger.log(line);
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
      // [UPSTOX][SIGNAL] / [UPSTOX][NO_TRADE] — one clear line per cycle state.
      for (const account of summary.accounts as Array<Record<string, unknown>>) {
        const scan = (account.scan ?? {}) as Record<string, unknown>;
        if (account.entrySkipped) {
          this.logThrottled(`[UPSTOX][NO_TRADE] ${account.label}: reason=${account.entrySkipped}`);
          continue;
        }
        this.logThrottled(
          `[UPSTOX][SIGNAL] ${account.label}: evaluated=${scan.evaluated ?? 0} considered=${scan.considered ?? 0} ` +
            `qualified=${scan.qualified ?? 0} opened=${scan.opened ? String(scan.opened) : 'none'}`,
        );
        if (!scan.opened) {
          this.logThrottled(`[UPSTOX][NO_TRADE] ${account.label}: reason=${scan.skipped ?? 'no qualified entry this cycle'}`);
        }
      }
      summary.labelled = await this.labelStaleCandidates();
      return summary;
    } finally {
      this.running = false;
    }
  }

  /**
   * ATM CE/PE candidates, nearest expiry only.
   *
   * The desk's OWN chain is authoritative while it is fresh. When its own feed is
   * down — dead credentials, or another provider owning the universe — the SAME
   * universe is read from the common normalized store instead, so the desk keeps
   * working off the one live tape. Each row keeps its TRUE producer, surfaced here as
   * `feedSource`; a foreign tick is never presented as this desk's own, and nothing
   * is interpolated or invented.
   */
  private async atmUniverse(portfolio: UpstoxLivePaperPortfolio, snapshot: PaperRiskSnapshot) {
    const thresholds = entryPolicyThresholdsFromEnv();
    const since = new Date(Date.now() - this.lookbackMinutes * 60_000);
    const underlying = this.deskUnderlying;
    const now = Date.now();

    const rows = await this.quotes.find({
      where: { underlying, ts: MoreThanOrEqual(since) },
      order: { ts: 'DESC' },
      take: 6000,
    });
    const ownNewestTsMs = rows.length ? new Date(rows[0].ts).getTime() : null;

    // Latest tick per contract — a stale leg must not masquerade as the chain.
    const latest = new Map<string, UpstoxLivePaperOptionQuote>();
    for (const r of rows) if (!latest.has(r.contractSymbol)) latest.set(r.contractSymbol, r);
    const ownFresh = [...latest.values()].filter((r) => now - new Date(r.ts).getTime() <= this.config.staleQuoteMaxAgeMs * 4);

    // The common-store read is only paid for when the desk's own chain cannot serve.
    let commonRows: CommonChainRow[] = [];
    let producer: string | null = null;
    if (!ownFresh.length) {
      const common = await this.commonStoreChain(underlying);
      commonRows = common.rows;
      producer = common.producer;
    }
    const decision = chainSourceDecision({
      ownRows: ownFresh.length,
      ownNewestTsMs,
      commonRows: commonRows.length,
      nowMs: now,
      maxAgeMs: this.sharedFallbackMaxAgeMs,
    });

    const chainRows: CommonChainRow[] = decision.source === 'OWN' ? this.ownRowsToChainShape(ownFresh) : commonRows;
    const chainRowsBySymbol = new Map<string, CommonChainRow>(chainRows.map((r) => [r.contractSymbol, r]));
    const feedSource = decision.source === 'OWN' ? 'UPSTOX_LIVE' : producer ? `COMMON_STORE:${producer}` : null;
    const provenance = {
      chainSource: decision.source,
      chainSourceReason: decision.reason,
      feedSource,
      chainVersion: decision.source === 'COMMON' ? COMMON_CHAIN_VERSION : null,
      ownChainAgeMs: decision.ownAgeMs,
      chainRows: chainRowsBySymbol,
    };
    if (decision.source !== 'COMMON') producer = null;

    if (decision.source === 'NONE') {
      const reason = decision.reason === 'OWN_STALE_NO_COMMON'
        ? 'every contract tick is older than the stale-quote budget'
        : 'no live option quotes in the lookback window';
      return { legs: [] as AtmCandidateLeg[], spot: null as number | null, universe: null, thresholds, stale: reason, ...provenance };
    }

    // NEAREST listed expiry, from the SOURCE's own rows (never a hard-coded date):
    // today's expiry is used when today is expiry day.
    const today = await this.risk.todayIst();
    const expiry = nearestExpiry(chainRows, today);
    if (!expiry) return { legs: [] as AtmCandidateLeg[], spot: null as number | null, universe: null, thresholds, stale: 'no expiry at or after today in the live chain', ...provenance };

    const legs: AtmCandidateLeg[] = commonRowsToAtmLegs(chainRows, expiry);
    const spot = await this.latestSpot(underlying);
    const universe = buildAtmUniverse({ legs, spot, window: thresholds.atmStrikeWindow });
    return { legs, spot, universe, thresholds, stale: null as string | null, ...provenance };
  }

  /**
   * The underlying LEVEL used to locate ATM strikes. Read from this desk's own
   * snapshot store while it is FRESH; otherwise from the common store's index
   * observation for the same universe. A stale level is never used — an ATM strike
   * computed from an old price is worse than no trade — and the value is never
   * invented.
   */
  private async latestSpot(underlying: string): Promise<number | null> {
    const now = Date.now();
    const ownMaxAge = this.config.staleQuoteMaxAgeMs;
    const sharedMaxAge = this.sharedFallbackMaxAgeMs;
    const row = await this.snapshots.findOne({ where: { instrument: underlying }, order: { ts: 'DESC' } });
    const price = row ? Number(row.price) : null;
    const ownAgeMs = row ? Math.max(0, now - new Date(row.ts).getTime()) : null;
    if (price !== null && Number.isFinite(price) && price > 0 && ownAgeMs !== null && ownAgeMs <= ownMaxAge) return price;

    // Own level absent or stale → the common store's index observation (the other
    // producer publishes it: BSE:SENSEX / NSE:NIFTY50).
    const shared = await this.unified.sharedSnapshot({ tail: underlying, exchange: this.deskExchange }, { maxAgeMs: sharedMaxAge, now });
    const sharedPrice = shared ? Number(shared.ltp) : null;
    if (sharedPrice !== null && Number.isFinite(sharedPrice) && sharedPrice > 0) return sharedPrice;

    // Last resort: the level carried on this desk's own option rows, still gated by
    // the desk's OWN budget (a foreign tape is never used to make an own row pass).
    const byPrice = await this.quotes.findOne({ where: { underlying }, order: { ts: 'DESC' } });
    const fromLegAgeMs = byPrice ? Math.max(0, now - new Date(byPrice.ts).getTime()) : null;
    const fromLeg = byPrice?.underlyingPrice === null || byPrice?.underlyingPrice === undefined ? null : Number(byPrice.underlyingPrice);
    // Never invented: an underlying level must come from a real, sufficiently recent observation.
    return fromLeg !== null && Number.isFinite(fromLeg) && fromLeg > 0 && fromLegAgeMs !== null && fromLegAgeMs <= ownMaxAge ? fromLeg : null;
  }

  /**
   * Candles from this desk's own stores, or — when the desk is working off the
   * common store because its own feed is down — from the common store's own history
   * of the SAME contract and index. A tick with no usable price is dropped rather
   * than bucketed as 0, so a foreign tape cannot inject a fake bar.
   */
  private async candlesFor(contractSymbol: string, underlying: string, since: Date, useCommonStore = false): Promise<{ option: Candle[]; underlying: Candle[] }> {
    if (useCommonStore) {
      const [sharedQuotes, sharedSnaps] = await Promise.all([
        this.unified.sharedQuoteHistory(contractSymbol, { sinceMs: since.getTime() }),
        this.unified.sharedSnapshotHistory({ tail: underlying, exchange: this.deskExchange }, { sinceMs: since.getTime() }),
      ]);
      const tick = (row: { receivedTimestamp?: Date | string | null; ts?: Date | string | null; ltp?: unknown }): TickLike | null => {
        const at = row.receivedTimestamp ?? row.ts;
        const price = Number(row.ltp);
        if (!at || !Number.isFinite(price) || price <= 0) return null;
        return { ts: at as unknown as Date, price, volume: 0 };
      };
      const optTicks = sharedQuotes.map(tick).filter((t): t is TickLike => t !== null);
      const spotTicks = sharedSnaps.map(tick).filter((t): t is TickLike => t !== null);
      return { option: bucketCandles(optTicks, BUCKET_MS), underlying: bucketCandles(spotTicks, BUCKET_MS) };
    }
    const [optRows, spotRows] = await Promise.all([
      this.quotes.find({ where: { contractSymbol, ts: MoreThanOrEqual(since) }, order: { ts: 'ASC' }, take: 3000 }),
      this.snapshots.find({ where: { instrument: underlying, ts: MoreThanOrEqual(since) }, order: { ts: 'ASC' }, take: 3000 }),
    ]);
    const optTicks: TickLike[] = optRows.map((r) => ({ ts: r.ts, price: Number(r.ltp ?? 0), volume: Number(r.volume ?? 0) }));
    const spotTicks: TickLike[] = spotRows.map((r) => ({ ts: r.ts, price: Number(r.price ?? 0), volume: Number(r.volume ?? 0) }));
    return { option: bucketCandles(optTicks, BUCKET_MS), underlying: bucketCandles(spotTicks, BUCKET_MS) };
  }

  /**
   * Chain context (OI / IV) for the ATM strikes. When `chainRows` is supplied the
   * desk is working off the common store and those SAME rows are used — no second
   * read, and no mixing of two tapes. Otherwise the desk's own store is read.
   */
  private async chainLegs(underlying: string, expiry: string, strikes: Set<number>, since: Date, chainRows?: Map<string, CommonChainRow>): Promise<ChainLeg[]> {
    if (chainRows) return commonRowsToChainLegs([...chainRows.values()], expiry, strikes) as unknown as ChainLeg[];
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
    const useCommonStore = built.chainSource === 'COMMON';
    // [UPSTOX][MARKET_DATA] — the first line to read when nothing trades. It names the
    // source the desk is ACTUALLY reading (its own feed, or the common store), so a
    // foreign tape is never mistaken for this desk's own.
    const newest = await this.quotes.findOne({ where: { underlying: this.deskUnderlying }, order: { ts: 'DESC' } });
    const ageMs = newest ? Math.max(0, now - new Date(newest.ts).getTime()) : null;
    this.logThrottled(
      `[UPSTOX][MARKET_DATA] source=${built.feedSource ?? 'UPSTOX_LIVE'} universe=${this.deskUnderlying} ` +
        `own_feed=${newest ? 'TICKS' : 'NO_TICKS'} own_last_tick=${newest ? new Date(newest.ts).toISOString() : 'none'} own_age_ms=${ageMs === null ? 'n/a' : ageMs} ` +
        `chain_source=${built.chainSource}(${built.chainSourceReason})`,
    );
    if (!built.universe || !built.legs.length) {
      const reason = built.stale ?? 'no ATM universe';
      this.logThrottled(`[UPSTOX][NO_TRADE] universe=${this.deskUnderlying} considered=0 reason=${reason}`);
      return { considered: 0, evaluated: 0, qualified: 0, opened: null, skipped: reason, feedSource: built.feedSource, chainSource: built.chainSource };
    }
    const sessionDate = await this.risk.todayIst(now);
    const nowIstMinutes = this.istMinutes(now);
    const since = new Date(now - this.lookbackMinutes * 60_000);
    const strikes = new Set<number>([...built.universe.ce, ...built.universe.pe].map((l) => Number(l.strike)));
    // The chain context comes from the SAME rows the universe was built from, so the
    // desk never mixes two tapes.
    const chain = await this.chainLegs(this.deskUnderlying, built.universe.ce[0]?.expiry ?? built.universe.pe[0]?.expiry ?? '', strikes, since, built.chainRows);
    const patternThresholds = patternThresholdsFromEnv();

    let evaluated = 0;
    let qualified = 0;
    let opened: string | null = null;
    const decisions: Array<Record<string, unknown>> = [];

    // CE and PE of the ATM strike both get a fair evaluation; the better setup
    // wins, and only one may be taken (max 1 open position).
    for (const leg of [...built.universe.ce, ...built.universe.pe]) {
      const { option, underlying: underlyingCandles } = await this.candlesFor(leg.contractSymbol, this.deskUnderlying, since, useCommonStore);
      if (option.length < 4) continue;
      evaluated += 1;

      // Book / OI / IV / greeks for THIS leg come from the row the ATM universe was
      // built from — the same tape end to end, and no per-leg second read. Absent
      // values stay null.
      const chainRow = built.chainRows.get(leg.contractSymbol) ?? null;
      const quoteTs = chainRow?.ts ? new Date(chainRow.ts).getTime() : null;
      const assessment: PatternAssessment = assessPattern({
        optionCandles: option,
        underlyingCandles,
        chainLegs: chain,
        quote: {
          ltp: leg.ltp,
          bid: leg.bid,
          ask: leg.ask,
          bidQty: chainRow?.bidQty ?? null,
          askQty: chainRow?.askQty ?? null,
          ts: chainRow?.ts ?? new Date(now),
          oi: leg.oi ?? chainRow?.oi ?? null,
          changeOi: chainRow?.changeOi ?? null,
          iv: chainRow?.iv ?? null,
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
        underlying: this.deskUnderlying,
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
        oiChange: chainRow?.changeOi ?? null,
        iv: chainRow?.iv ?? null,
        delta: chainRow?.delta ?? null,
        gamma: chainRow?.gamma ?? null,
        theta: chainRow?.theta ?? null,
        vega: chainRow?.vega ?? null,
        optionAtr,
        underlyingAtr: atr(underlyingCandles, 14),
        tickAgeMs: quoteTs === null ? null : Math.max(0, now - quoteTs),
        scores: decision.scores as unknown as Record<string, unknown>,
        thresholds: decision.thresholds as unknown as Record<string, unknown>,
        qualified: decision.qualified,
        decision: decision.side,
        refusals: decision.refusals,
        notes: [...(decision.notes ?? []), `feed=${built.feedSource ?? 'UPSTOX_LIVE'} chain_source=${built.chainSource}`],
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
        `[UPSTOX][PAPER] OPEN ${leg.contractSymbol} ${sizing.lots} lot(s) @ ₹${leg.ltp} · ` +
        `conf ${decision.confidence.toFixed(3)} · stop ₹${decision.stop?.toFixed(2)} target ₹${decision.target?.toFixed(2)} · ` +
        `risk ₹${decision.risk.plannedRisk?.toFixed(2)} (${decision.risk.plannedRiskPct?.toFixed(2)}% of ₹${decision.risk.configuredCapital}) · ` +
        `feed=${built.feedSource ?? 'UPSTOX_LIVE'}`,
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
      feedSource: built.feedSource,
      chainSource: built.chainSource,
      chainSourceReason: built.chainSourceReason,
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
      // A position must be manageable off the SAME tape it was opened on: the desk's
      // own row while it is fresh, otherwise the common store's row for that contract.
      // Without this an entry taken from the common store could never be exited here.
      const ownLatest = await this.quotes.findOne({ where: { contractSymbol: trade.instrument }, order: { ts: 'DESC' } });
      const ownFresh = ownLatest !== null && now - new Date(ownLatest.ts).getTime() <= this.config.staleQuoteMaxAgeMs;
      let sharedRow: CommonChainRow | null = null;
      if (!ownFresh) {
        const shared = await this.unified.sharedQuote({ contractSymbol: trade.instrument }, { maxAgeMs: this.sharedFallbackMaxAgeMs, now });
        sharedRow = shared ? commonChainRowFromUnified(shared as unknown as Record<string, unknown>) : null;
      }
      const latest = ownFresh
        ? ownLatest
        : sharedRow
          ? {
              expiry: sharedRow.expiry,
              strike: sharedRow.strike,
              optionType: sharedRow.optionType,
              ltp: sharedRow.ltp,
              bid: sharedRow.bid,
              ask: sharedRow.ask,
              bidQty: sharedRow.bidQty,
              askQty: sharedRow.askQty,
              openInterest: sharedRow.oi,
              oiChange: sharedRow.changeOi,
              impliedVolatility: sharedRow.iv,
              ts: sharedRow.ts,
            }
          : null;
      if (!latest) { out.push({ tradeId: trade.id, status: 'no quote' }); continue; }
      const exitFromCommonStore = !ownFresh;
      const exitSource = ownFresh ? 'UPSTOX_LIVE' : `COMMON_STORE:${sharedRow?.source || 'UNKNOWN'}`;

      const ltp = Number(latest.ltp);
      if (!(ltp > 0)) { out.push({ tradeId: trade.id, status: 'invalid premium' }); continue; }

      const entryPrice = Number(trade.entryPrice);
      const entryTs = trade.orderedAt ?? trade.entryQuoteTs ?? new Date(now);
      const candidate = await this.findCandidateFor(trade.id);
      if (candidate) await this.learning.updateExcursion(candidate.id, ltp);

      const since = new Date(new Date(entryTs).getTime() - 60_000);
      const { option, underlying: underlyingCandles } = await this.candlesFor(trade.instrument, this.deskUnderlying, since, exitFromCommonStore);
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
      const exitChainRows = exitFromCommonStore
        ? new Map((await this.commonStoreChain(this.deskUnderlying)).rows.map((r) => [r.contractSymbol, r]))
        : undefined;
      const chain = await this.chainLegs(this.deskUnderlying, expiry, new Set([Number(latest.strike)]), since, exitChainRows);
      if (option.length >= 4 && optionType === (String(latest.optionType).toUpperCase() === 'PE' ? 'PE' : 'CE')) {
        const assessment = assessPattern({
          optionCandles: option,
          underlyingCandles,
          chainLegs: chain,
          quote: {
            ltp, bid: latest.bid === null ? null : Number(latest.bid), ask: latest.ask === null ? null : Number(latest.ask),
            bidQty: latest.bidQty === null ? null : Number(latest.bidQty), askQty: latest.askQty === null ? null : Number(latest.askQty),
            ts: latest.ts ? new Date(latest.ts) : new Date(now), oi: latest.openInterest === null ? null : Number(latest.openInterest),
            changeOi: latest.oiChange === null ? null : Number(latest.oiChange),
            iv: latest.impliedVolatility === null ? null : Number(latest.impliedVolatility),
          },
          optionType,
          spot: await this.latestSpot(this.deskUnderlying),
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
        out.push({ tradeId: trade.id, ltp, stop: exit.stop, exit: false, notes: exit.notes, source: exitSource });
        continue;
      }

      const closed = await this.desk.closeTrade({ tradeId: trade.id, exitPrice: ltp, exitTrigger: exit.reason ?? 'V1_EXIT' });
      if (candidate) await this.learning.markExit(candidate.id, { exitPrice: Number(closed.exitPrice), exitReason: exit.reason ?? 'V1_EXIT' });
      this.logger.log(`[UPSTOX-AUTO-V1] CLOSE ${trade.instrument} @ ₹${ltp} · ${exit.reason} · MFE ${((highest - entryPrice) / entryPrice * 100).toFixed(1)}% MAE ${((lowest - entryPrice) / entryPrice * 100).toFixed(1)}%`);
      out.push({ tradeId: trade.id, ltp, exit: true, reason: exit.reason, candidateId: candidate?.id ?? null, source: exitSource });
      void snapshot;
    }
    return out;
  }

  /**
   * Evaluate every OPEN position of one portfolio with the SAME management rules
   * the session loop uses, and close the ones the policy exits.
   *
   * Used by the week-start carry-forward pass so a position held over a week
   * boundary is judged exactly as it would have been mid-week — one exit policy,
   * not a second one written for the week start. It does NOT consider
   * `autoTradeEnabled`: a position carried over the weekend must still be
   * evaluated (and may be HELD) even if the account stopped auto-entering, and it
   * is never closed merely because the week changed — only a real rule closes it.
   */
  async manageCarriedPositions(portfolioId: string, now = Date.now()): Promise<Array<Record<string, unknown>>> {
    const portfolio = await this.portfolios.findOne({ where: { id: portfolioId } });
    if (!portfolio) throw new Error(`Upstox paper portfolio ${portfolioId} not found`);
    const { snapshot } = await this.risk.snapshotFor(portfolioId);
    return this.manageOpenTrades(portfolio, snapshot, now);
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
