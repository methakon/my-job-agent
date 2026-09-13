import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThanOrEqual, IsNull, MoreThan, Between, LessThan, Not } from 'typeorm';
import { UpstoxLivePaperConfig } from './upstox-live-paper.config';
import {
  UpstoxLivePaperPortfolio,
  UpstoxLivePaperTrade,
  UpstoxLivePaperOrder,
  UpstoxLivePaperPosition,
  UpstoxLivePaperPnlEvent,
  UpstoxLivePaperOptionQuote,
  UpstoxLivePaperMarketSnapshot,
  UpstoxLivePaperWeeklyReport,
} from './upstox-live-paper-entities';
import { UpstoxLivePaperMarketService, LiveFeedStatus } from './upstox-live-paper-market.service';
import {
  LiveOptionTick,
  LiveMarketTick,
} from './upstox-live-paper-market.service';
import { entryGuards, paperRiskSnapshot, riskPolicyFromEnv } from './paper-risk';

// ── DTOs ─────────────────────────────────────────────────────────────────────

export class CreateUpstoxLivePaperPortfolioDto {
  label?: string;
  capital: number;
  fridayTradingEnabled?: boolean;
  autoTradeEnabled?: boolean;
}

export class OpenUpstoxLivePaperTradeDto {
  portfolioId: string;
  instrument: string;
  side: 'BUY' | 'SELL';
  quantity: number; // lots
  lotSize: number;
  entryPrice?: number; // if omitted, use current ask/bid
  algoSource?: string;
  decisionParams?: string;
  decisionId?: string | null;
  /** Explicit quote snapshot to use for the fill (if provided, overrides live quote). */
  quoteSnapshot?: LiveOptionTick;
}

export class CloseUpstoxLivePaperTradeDto {
  tradeId: string;
  exitPrice: number;
  exitTrigger?: string;
  exitQuoteTs?: string;
  cost?: number;
}

export class IngestUpstoxLivePaperQuoteDto {
  rows: (LiveOptionTick | LiveMarketTick)[];
}

// ── Cost model (Indian discount broker; same basis as FYERS desk). ────────────

const OPTION_COST_RATES = {
  brokerageFlat: 20,        // ₹20 per executed order
  // STT on the SALE of an option: 0.15% of premium (Finance Act 2026, effective
  // 1-Apr-2026; raised from 0.10%). Sell side only.
  sttSellPct: 0.0015,
  exchangeTxnPct: 0.0003553,// NSE 0.03553% of premium
  stampBuyPct: 0.00003,     // 0.003% of premium, buy side
  gstPct: 0.18,             // 18% on brokerage + exchange txn + SEBI only
  sebiPct: 0.000001,        // ₹10 per crore
};

export interface OptionCostBreakdown {
  notional: number;
  brokerage: number;
  stt: number;
  exchangeTxn: number;
  gst: number;
  sebi: number;
  stamp: number;
  slippage: number;
  total: number;
}

export function calculateOptionCost(
  premium: number,
  units: number,
  side: 'BUY' | 'SELL',
  slippagePct: number,
): OptionCostBreakdown {
  const notional = premium * units;
  const brokerage = OPTION_COST_RATES.brokerageFlat; // flat ₹20, options
  const stt = side === 'SELL' ? notional * OPTION_COST_RATES.sttSellPct : 0;
  const exchangeTxn = notional * OPTION_COST_RATES.exchangeTxnPct;
  const stamp = side === 'BUY' ? notional * OPTION_COST_RATES.stampBuyPct : 0;
  const sebi = notional * OPTION_COST_RATES.sebiPct;
  // GST applies to the taxable broker/exchange/regulatory services ONLY
  // (brokerage + exchange txn + SEBI). STT and stamp duty are statutory levies
  // and sit OUTSIDE the GSTable base. Same basis as the FYERS desk.
  const gst = (brokerage + exchangeTxn + sebi) * OPTION_COST_RATES.gstPct;
  const slippage = notional * (slippagePct / 10000);
  const total = brokerage + stt + exchangeTxn + gst + sebi + stamp + slippage;
  return { notional, brokerage, stt, exchangeTxn, gst, sebi, stamp, slippage, total };
}

// ── Service ───────────────────────────────────────────────────────────────────

@Injectable()
export class UpstoxLivePaperService {
  private readonly logger = new Logger(UpstoxLivePaperService.name);

  private readonly config: UpstoxLivePaperConfig;
  private readonly market: UpstoxLivePaperMarketService;

  private readonly portfolios: Repository<UpstoxLivePaperPortfolio>;
  private readonly trades: Repository<UpstoxLivePaperTrade>;
  private readonly orders: Repository<UpstoxLivePaperOrder>;
  private readonly positions: Repository<UpstoxLivePaperPosition>;
  private readonly pnlEvents: Repository<UpstoxLivePaperPnlEvent>;
  private readonly optionQuotes: Repository<UpstoxLivePaperOptionQuote>;
  private readonly marketSnapshots: Repository<UpstoxLivePaperMarketSnapshot>;
  private readonly weeklyReports: Repository<UpstoxLivePaperWeeklyReport>;

  constructor(
    config: UpstoxLivePaperConfig,
    market: UpstoxLivePaperMarketService,
    @InjectRepository(UpstoxLivePaperPortfolio)
    portfolios: Repository<UpstoxLivePaperPortfolio>,
    @InjectRepository(UpstoxLivePaperTrade)
    trades: Repository<UpstoxLivePaperTrade>,
    @InjectRepository(UpstoxLivePaperOrder)
    orders: Repository<UpstoxLivePaperOrder>,
    @InjectRepository(UpstoxLivePaperPosition)
    positions: Repository<UpstoxLivePaperPosition>,
    @InjectRepository(UpstoxLivePaperPnlEvent)
    pnlEvents: Repository<UpstoxLivePaperPnlEvent>,
    @InjectRepository(UpstoxLivePaperOptionQuote)
    optionQuotes: Repository<UpstoxLivePaperOptionQuote>,
    @InjectRepository(UpstoxLivePaperMarketSnapshot)
    marketSnapshots: Repository<UpstoxLivePaperMarketSnapshot>,
    @InjectRepository(UpstoxLivePaperWeeklyReport)
    weeklyReports: Repository<UpstoxLivePaperWeeklyReport>,
  ) {
    this.config = config;
    this.market = market;
    this.portfolios = portfolios;
    this.trades = trades;
    this.orders = orders;
    this.positions = positions;
    this.pnlEvents = pnlEvents;
    this.optionQuotes = optionQuotes;
    this.marketSnapshots = marketSnapshots;
    this.weeklyReports = weeklyReports;
  }

  // ── safety ──────────────────────────────────────────────────────────────────

  readonly paperOnly = true;
  readonly safetyLockActive = true;

  /** Public accessor for controller/status endpoints. */
  getConfig(): UpstoxLivePaperConfig { return this.config; }

  /**
   * Lot size for a contract, resolved without inventing a value. Priority:
   *   1. an explicit size supplied by the caller (operator instruction),
   *   2. UPSTOX_LIVE_PAPER_LOT_SIZE (this desk's own override),
   *   3. PATTERN_LOT_SIZE (kept as an alias so the pattern engine's env still works),
   *   4. the broker's OWN contract master, read from /v2/option/contract.
   * When none of these resolve, the answer is null and the caller MUST skip the
   * order — a fabricated lot size would silently mis-state the position.
   */
  lotSizeFor(instrument: string, explicit?: number | null): { lotSize: number | null; source: string } {
    const explicitSize = Number(explicit);
    if (Number.isFinite(explicitSize) && explicitSize >= 1) {
      return { lotSize: Math.trunc(explicitSize), source: 'instruction' };
    }
    for (const [name, source] of [['UPSTOX_LIVE_PAPER_LOT_SIZE', 'env'], ['PATTERN_LOT_SIZE', 'env-alias']] as const) {
      const raw = Number(process.env[name]);
      if (Number.isFinite(raw) && raw >= 1) return { lotSize: Math.trunc(raw), source };
    }
    const fromMaster = this.market.lotSizeForSymbol(instrument);
    if (fromMaster !== null) return { lotSize: fromMaster, source: 'broker-contract-master' };
    return { lotSize: null, source: 'unresolved' };
  }

  /** Contract-master state (what the broker told us), for status/UI. */
  contractMasterStatus(): { underlyings: Record<string, number>; note: string | null } {
    return this.market.contractMasterStatus();
  }

  /**
   * The premium an entry would actually fill at, from a LIVE quote — the same
   * computation openTrade uses (ask for a BUY, bid for a SELL, else LTP, then the
   * desk's slippage assumption). Reads this desk's own quotes first and falls
   * back to the shared/common store, which is how a STANDBY desk still sees the
   * one active tape. Returns null when there is no honest price to use.
   */
  async previewEntry(instrument: string, side: 'BUY' | 'SELL'): Promise<{
    premium: number | null; reference: number | null; source: string; stale: boolean;
    quoteTs: string | null; spreadPct: number | null; ageMs: number | null;
  }> {
    let quote: LiveOptionTick | null = null;
    let source = 'desk-own';
    try {
      quote = await this.fetchLiveQuoteForInstrument(instrument);
    } catch {
      quote = null;
    }
    if (!quote) {
      try {
        quote = await this.market.sharedOptionTickFor({ contractSymbol: instrument });
      } catch {
        quote = null;
      }
      if (quote) source = 'common-store';
    }
    if (!quote) return { premium: null, reference: null, source: 'none', stale: true, quoteTs: null, spreadPct: null, ageMs: null };

    // Age from the tick's OWN timestamp, so the same rule applies whether the
    // price came from this desk's poll or from the shared store.
    const quoteMs = quote.ts ? new Date(quote.ts).getTime() : NaN;
    const ageMs = Number.isFinite(quoteMs) ? Date.now() - quoteMs : null;
    const stale = ageMs === null || ageMs > this.config.staleQuoteMaxAgeMs;
    const reference = (side === 'BUY' && quote.ask != null) ? quote.ask
      : (side === 'SELL' && quote.bid != null) ? quote.bid : quote.ltp;
    const premium = reference > 0 ? this.fillPriceForSide(side, reference, this.config.defaultSlippageBps) : null;
    return {
      premium, reference, source, stale,
      quoteTs: quote.ts ? new Date(quote.ts).toISOString() : null,
      spreadPct: this.computeSpreadPct(quote.bid, quote.ask),
      ageMs,
    };
  }

  /**
   * Public summary of the safety posture, for controllers / UI status.
   * Never exposes the raw env value beyond the derived DISPLAY form.
   */
  safetyStatusText(): string {
    return [
      `UPSTOX MARKET DATA: ${this.config.liveCredentialsPresent ? 'LIVE' : 'CONFIGURED (no creds)'}`,
      `EXECUTION: PAPER`,
      `REAL ORDERS: DISABLED`,
      `SAFETY LOCK: UPSTOX_SANDBOX_ENABLED=${this.config.sandboxEnabled ? 'true' : 'false'}`,
      `PAPER CAPITAL: \u20b9${this.config.paperCapital.toLocaleString('en-IN')}`,
      `SLIPPAGE ASSUMPTION: ${this.config.defaultSlippageBps} bps`,
      `STALE QUOTE MAX AGE: ${this.config.staleQuoteMaxAgeMs} ms`,
      `ABNORMAL SPREAD THRESHOLD: ${this.config.abnormalSpreadPctThreshold}%`,
    ].join(' \u00b7 ');
  }

  private assertPaperMode(): void {
    if (!this.paperOnly) {
      throw new BadRequestException('[UPSTOX-LIVE-PAPER] paper-only enforcement — REAL order path is unreachable from this module');
    }
    if (!this.config.safetyLockActive) {
      throw new BadRequestException('[UPSTOX-LIVE-PAPER] safety lock inactive — UPSTOX_SANDBOX_ENABLED must be true for PAPER mode');
    }
    if (this.config.realOrderAllowed) {
      // Even if derivation says REAL allowed, THIS module stays PAPER.
      this.logger.warn('[UPSTOX-LIVE-PAPER] REAL_ORDER_ALLOWED=true derivation — module remains PAPER only; real order APIs are never called here');
    }
  }

  // ── portfolio ───────────────────────────────────────────────────────────────

  async listPortfolios(): Promise<UpstoxLivePaperPortfolio[]> {
    return this.portfolios.find({ order: { createdAt: 'ASC' } });
  }

  async getPortfolio(id: string): Promise<UpstoxLivePaperPortfolio> {
    const p = await this.portfolios.findOne({ where: { id } });
    if (!p) throw new BadRequestException(`portfolio ${id} not found`);
    return p;
  }

  async createPortfolio(dto: CreateUpstoxLivePaperPortfolioDto): Promise<UpstoxLivePaperPortfolio> {
    this.assertPaperMode();
    const capital = Math.max(1000, dto.capital);
    const portfolio = this.portfolios.create({
      label: dto.label ?? 'main-live-paper',
      capital,
      ceiling: capital,
      deployed: 0,
      netPnl: 0,
      unrealisedPnl: 0,
      totalCost: 0,
      openPositionCount: 0,
      autoTradeEnabled: dto.autoTradeEnabled ?? false,
      fridayTradingEnabled: dto.fridayTradingEnabled ?? false,
      dataSource: 'UPSTOX',
      executionMode: 'PAPER',
          });
          const savedPortfolio = await this.portfolios.save(portfolio);
          await this.recordPnlEvent(savedPortfolio.id, null, 0, 'PORTFOLIO_CREATED', `Portfolio created with capital \u20b9${capital.toLocaleString('en-IN')}`);
          return savedPortfolio;
  }

  async updatePortfolio(id: string, dto: Partial<CreateUpstoxLivePaperPortfolioDto>): Promise<UpstoxLivePaperPortfolio> {
    this.assertPaperMode();
    const p = await this.getPortfolio(id);
    Object.assign(p, {
      label: dto.label ?? p.label,
      capital: dto.capital != null ? Math.max(1000, dto.capital) : p.capital,
    });
    p.ceiling = Math.max(0, Number(p.capital));
    return this.portfolios.save(p);
  }

  async setAutoTrade(id: string, enabled: boolean): Promise<UpstoxLivePaperPortfolio> {
    const p = await this.getPortfolio(id);
    p.autoTradeEnabled = enabled;
    return this.portfolios.save(p);
  }

  async setFridayTrading(id: string, enabled: boolean): Promise<UpstoxLivePaperPortfolio> {
    const p = await this.getPortfolio(id);
    p.fridayTradingEnabled = enabled;
    return this.portfolios.save(p);
  }

  // ── market data ingestion (from external feed) ─────────────────────────────

  async ingestQuotes(dto: IngestUpstoxLivePaperQuoteDto): Promise<{ persisted: number; errors: string[] }> {
    this.assertPaperMode();
    const errors: string[] = [];
    let persisted = 0;
    for (const row of dto.rows) {
      try {
        if (this.isOptionTick(row)) {
          await this.persistOptionQuote(row);
          const tsMs = row.ts.getTime();
          this.market.markOptionQuoteTs(row.contractSymbol, tsMs);
          this.market.incrementQuotesPersisted();
          persisted += 1;
        } else {
          await this.persistMarketSnapshot(row);
          const tsMs = row.ts.getTime();
          this.market.markMarketSnapshotTs(row.instrument, tsMs);
          if (row.price != null && Number.isFinite(row.price)) {
            this.market.underlyingPriceCache().set(row.instrument, row.price);
          }
          persisted += 1;
        }
      } catch (err) {
        errors.push(this.market.errorMessage(err));
      }
    }
    return { persisted, errors };
  }

  private isOptionTick(row: LiveOptionTick | LiveMarketTick): row is LiveOptionTick {
    return 'contractSymbol' in row && 'strike' in row;
  }

  private async persistOptionQuote(tick: LiveOptionTick): Promise<void> {
    const entity = this.optionQuotes.create({
      instrumentToken: tick.instrumentToken,
      underlying: tick.underlying,
      expiry: tick.expiry,
      strike: tick.strike,
      optionType: tick.optionType,
      ltp: tick.ltp,
      bid: tick.bid,
      ask: tick.ask,
      bidQty: tick.bidQty,
      askQty: tick.askQty,
      volume: tick.volume,
      openInterest: tick.openInterest,
      oiChange: tick.oiChange,
      impliedVolatility: tick.impliedVolatility,
      underlyingPrice: tick.underlyingPrice,
      bidDepth: tick.bidQty ? Math.round(tick.bidQty) : null,
      askDepth: tick.askQty ? Math.round(tick.askQty) : null,
      ts: tick.ts,
      dataSource: tick.dataSource ?? 'UPSTOX',
      executionMode: tick.executionMode ?? 'PAPER',
    });
    await this.optionQuotes.save(entity);
  }

  private async persistMarketSnapshot(tick: LiveMarketTick): Promise<void> {
    const entity = this.marketSnapshots.create({
      instrument: tick.instrument,
      price: tick.price,
      bid: tick.bid,
      ask: tick.ask,
      volume: tick.volume,
      open: tick.open,
      high: tick.high,
      low: tick.low,
      close: tick.close,
      ts: tick.ts,
      dataSource: tick.dataSource ?? 'UPSTOX',
      executionMode: tick.executionMode ?? 'PAPER',
      upstoxRef: tick.upstoxRef,
    });
    await this.marketSnapshots.save(entity);
  }

  // ── trades ──────────────────────────────────────────────────────────────────

  async listTrades(portfolioId?: string, limit = 200): Promise<UpstoxLivePaperTrade[]> {
    const where: Record<string, unknown> = {};
    if (portfolioId) where.portfolioId = portfolioId;
    return this.trades.find({ where, order: { orderedAt: 'DESC' }, take: limit });
  }

  async getTrade(id: string): Promise<UpstoxLivePaperTrade> {
    const t = await this.trades.findOne({ where: { id } });
    if (!t) throw new BadRequestException(`trade ${id} not found`);
    return t;
  }

  /**
   * Open a simulated paper position.
   * - BUY fills at ask + slippage; SELL fills at bid - slippage.
   * - Uses the latest live quote if no explicit quote is provided.
   * - Refuses to fill if the quote is stale.
   * - Enforces capital ceiling and Friday block.
   * - Never submits a live order.
   */
  async openTrade(dto: OpenUpstoxLivePaperTradeDto): Promise<UpstoxLivePaperTrade> {
    this.assertPaperMode();
    const portfolio = await this.getPortfolio(dto.portfolioId);

    if (new Date().getDay() === 5 && !portfolio.fridayTradingEnabled) {
      throw new BadRequestException('Friday block active — no new positions on Friday unless fridayTradingEnabled');
    }

    // Ensure the instrument is an option contract (CE/PE). Index symbols are reference-only.
    if (!/(CE|PE)$/.test(dto.instrument)) {
      throw new BadRequestException(`instrument ${dto.instrument} does not end in CE/PE — reference-only, not tradable`);
    }

    const lotSize = Math.max(1, dto.lotSize);
    const lots = Math.max(1, Math.trunc(dto.quantity));
    const units = lots * lotSize;

    // Determine fill price from explicit quote or live quote.
    let fillPrice: number;
    let refPrice: number | null;
    let spreadPct = 0;
    let slippagePct = this.config.defaultSlippageBps;
    let entryQuoteTs: Date | null = null;

    if (dto.quoteSnapshot) {
      const q = dto.quoteSnapshot;
      if (this.market.isStale(q.contractSymbol)) {
        this.market.incrementStaleBlocked();
        throw new BadRequestException(`quote for ${q.contractSymbol} is stale — cannot open position`);
      }
      entryQuoteTs = q.ts;
      refPrice = (dto.side === 'BUY' && q.ask != null) ? q.ask : (dto.side === 'SELL' && q.bid != null) ? q.bid : q.ltp;
      spreadPct = this.computeSpreadPct(q.bid, q.ask);
      fillPrice = this.fillPriceForSide(dto.side, refPrice, slippagePct);
      if (dto.entryPrice && Number.isFinite(dto.entryPrice)) {
        // caller overrides fill price (e.g. back-test). Still record spread/slippage from quote.
        fillPrice = Math.max(0.01, dto.entryPrice);
      }
    } else {
      // Fetch the latest live quote.
      const latest = await this.market.fetchOptionChain();
      if (!latest.fetched) {
        throw new BadRequestException('no live quote available — cannot open position');
      }
      // Fetch a single quote for the specific instrument.
      const quote = await this.fetchLiveQuoteForInstrument(dto.instrument);
      if (!quote || this.market.isStale(quote.contractSymbol)) {
        this.market.incrementStaleBlocked();
        throw new BadRequestException(`no live quote for ${dto.instrument} or quote is stale`);
      }
      entryQuoteTs = quote.ts;
      refPrice = (dto.side === 'BUY' && quote.ask != null) ? quote.ask : (dto.side === 'SELL' && quote.bid != null) ? quote.bid : quote.ltp;
      spreadPct = this.computeSpreadPct(quote.bid, quote.ask);
      fillPrice = this.fillPriceForSide(dto.side, refPrice, slippagePct);
    }

    const outlay = fillPrice * units;
    const headroom = (Number(portfolio.ceiling) || Number(portfolio.capital)) - Number(portfolio.deployed);
    if (outlay > headroom) {
      throw new BadRequestException(`premium outlay ₹${outlay.toFixed(2)} exceeds headroom ₹${headroom.toFixed(2)}`);
    }

    // ── account risk envelope ─────────────────────────────────────────────────
    // Enforced for EVERY entry path — manual, pattern dispatch or V1 — so no
    // caller can exceed the account's own limits. Everything below is scaled
    // from THIS account's configured capital; nothing assumes a fixed amount.
    const envelope = paperRiskSnapshot(
      {
        capital: Number(portfolio.capital),
        deployed: Number(portfolio.deployed),
        netPnl: Number(portfolio.netPnl),
        unrealisedPnl: Number(portfolio.unrealisedPnl),
        openPositionCount: await this.trades.count({ where: { portfolioId: portfolio.id, status: 'OPEN' } }),
        peakEquity: Number(portfolio.capital) + Math.max(0, Number(portfolio.netPnl)),
      },
      riskPolicyFromEnv(process.env, { configuredCapital: Number(portfolio.capital) }),
    );
    const alreadyOpen = envelope.openPositionCount > 0
      ? await this.trades.findOne({ where: { portfolioId: portfolio.id, instrument: dto.instrument, status: 'OPEN' } })
      : null;
    const guards = entryGuards({
      snapshot: envelope,
      openSameContract: alreadyOpen ? `${alreadyOpen.instrument}:${alreadyOpen.side}` : null,
      side: dto.side,
      outlay,
    });
    if (!guards.allowed) {
      throw new BadRequestException(
        `risk envelope refused the entry (capital ₹${envelope.configuredCapital.toFixed(2)}, max ${envelope.maxOpenPositions} position(s)) — ${guards.refusals.join('; ')}`,
      );
    }

    // Compute cost (entry leg only for now; round-trip cost added on close).
    const costBreakdown = calculateOptionCost(fillPrice, units, dto.side, slippagePct);

    const simulatedOrderId = this.sSimulatedOrderId();
    const trade = this.trades.create({
      portfolioId: portfolio.id,
      instrument: dto.instrument,
      side: dto.side,
      quantity: units,
      entryPrice: fillPrice,
      cost: costBreakdown.total,
      status: 'OPEN',
      simulatedOrderId,
      brokerOrderId: null,
      algoSource: dto.algoSource ?? 'manual',
      decisionParams: dto.decisionParams ?? JSON.stringify({ contract: { symbol: dto.instrument, lotSize, units } }),
      decisionId: dto.decisionId ?? null,
      dataSource: 'UPSTOX',
      executionMode: 'PAPER',
      entryQuoteTs,
      fillSpreadPct: spreadPct,
      fillSlippagePct: slippagePct,
      rejectReason: null,
    });
    const savedTrade: UpstoxLivePaperTrade = await this.trades.save(trade) as UpstoxLivePaperTrade;

    // Record the simulated order.
    const order = this.orders.create({
      tradeId: savedTrade.id,
      simulatedOrderId,
      brokerOrderId: null,
      side: dto.side,
      quantity: units,
      filledQuantity: units,
      status: 'FILLED',
      fillPrice: fillPrice,
      referencePrice: refPrice,
      spreadPct,
      slippagePct,
      fillQuoteTs: entryQuoteTs,
      rejectReason: null,
      dataSource: 'UPSTOX',
      executionMode: 'PAPER',
      updatedAt: new Date(),
    });
    await this.orders.save(order);

    // Update portfolio deployed + open position count.
    await this.portfolios.update(portfolio.id, {
      deployed: Number(portfolio.deployed) + outlay,
      openPositionCount: (portfolio.openPositionCount || 0) + 1,
    });

    // Single economic accounting path for OPEN: charge the entry-leg cost ONCE.
    // The ledger event below is record-only (recordPnlEvent never mutates equity).
    const newNetPnl = Number(portfolio.netPnl) - costBreakdown.total;
    await this.portfolios.update(portfolio.id, { netPnl: newNetPnl });
    await this.recordPnlEvent(portfolio.id, savedTrade.id, -costBreakdown.total, 'TRADE_OPEN',
      `OPEN ${dto.side} ${dto.instrument} @ ₹${fillPrice.toFixed(2)} · outlay ₹${outlay.toFixed(2)} · cost ₹${costBreakdown.total.toFixed(2)}`);

    // Update position (may be partial if open already exists).
    await this.syncPosition(portfolio.id, savedTrade);

    this.logger.log(`[UPSTOX-LIVE-PAPER] OPEN ${dto.side} ${units} units ${dto.instrument} @ ₹${fillPrice.toFixed(2)} (spread ${spreadPct}%, slippage ${slippagePct}bps)`);
    return savedTrade;
  }

  /**
   * Close a simulated paper position.
   * - BUY close at bid; SELL close at ask. Uses latest live quote if exitPrice not provided as explicit fill.
   * - Computes gross/net P&L, updates portfolio, records P&L events.
   */
  async closeTrade(dto: CloseUpstoxLivePaperTradeDto): Promise<UpstoxLivePaperTrade> {
    this.assertPaperMode();
    const trade = await this.trades.findOne({ where: { id: dto.tradeId }, relations: { portfolio: true } });
    if (!trade) throw new BadRequestException(`trade ${dto.tradeId} not found`);
    if (trade.status !== 'OPEN') throw new BadRequestException(`trade ${dto.tradeId} is ${trade.status}, not OPEN`);

    const qty = Number(trade.quantity);
    const entry = Number(trade.entryPrice);
    let exitPrice = dto.exitPrice;
    let refPrice: number | null = null;
    let spreadPct = 0;
    let slippagePct = this.config.defaultSlippageBps;

    if (exitPrice == null || !Number.isFinite(exitPrice) || exitPrice <= 0) {
      // Use latest live quote for the exit fill.
      const quote = await this.fetchLiveQuoteForInstrument(trade.instrument);
      if (!quote) throw new BadRequestException('no live quote available for exit fill');
      if (this.market.isStale(quote.contractSymbol)) {
        this.market.incrementStaleBlocked();
        throw new BadRequestException(`live quote for ${trade.instrument} is stale — cannot close position`);
      }
      exitPrice = this.fillPriceForSide(trade.side === 'BUY' ? 'SELL' : 'BUY', refPrice ?? quote.ltp, slippagePct);
      refPrice = (trade.side === 'BUY' && quote.bid != null) ? quote.bid : quote.ask;
      spreadPct = this.computeSpreadPct(quote.bid, quote.ask);
    } else {
      // Use explicit exit price (caller-provided fill).
    }

    // Gross P&L in premium terms: BUY (long) → (exit - entry) * units; SELL (short) → (entry - exit) * units.
    const grossPnl = trade.side === 'BUY' ? (exitPrice - entry) * qty : (entry - exitPrice) * qty;

    // Round-trip cost = entry leg cost (from trade.cost) + exit leg cost.
    const exitCostBreakdown = calculateOptionCost(exitPrice, qty, trade.side === 'BUY' ? 'SELL' : 'BUY', slippagePct);
    const totalCost = Number(trade.cost) + exitCostBreakdown.total;

    // Full round-trip net: this is the trade record AND the source the week roll
    // sums. The portfolio only books the CLOSE-leg movement, because the entry
    // leg was already charged at OPEN — charging it here again would double-count.
    const netPnl = grossPnl - totalCost;
    const closeNetPnl = grossPnl - exitCostBreakdown.total;

    trade.exitPrice = exitPrice;
    trade.grossPnl = grossPnl;
    trade.cost = totalCost;
    trade.netPnl = netPnl;
    trade.status = 'CLOSED';
    trade.closedAt = new Date();
    trade.fillSpreadPct = trade.fillSpreadPct + spreadPct;
    trade.fillSlippagePct = trade.fillSlippagePct + slippagePct;

    // Record closing order.
    const closeOrder = this.orders.create({
      tradeId: trade.id,
      simulatedOrderId: this.sSimulatedOrderId(),
      brokerOrderId: null,
      side: trade.side === 'BUY' ? 'SELL' : 'BUY',
      quantity: qty,
      filledQuantity: qty,
      status: 'FILLED',
      fillPrice: exitPrice,
      referencePrice: refPrice,
      spreadPct,
      slippagePct,
      fillQuoteTs: dto.exitQuoteTs ? new Date(dto.exitQuoteTs) : new Date(),
      rejectReason: null,
      dataSource: 'UPSTOX',
      executionMode: 'PAPER',
      updatedAt: new Date(),
    });
    await this.orders.save(closeOrder);

    const savedTrade: UpstoxLivePaperTrade = await this.trades.save(trade) as UpstoxLivePaperTrade;

    // Update portfolio.
    const portfolio = trade.portfolio;
    // Single economic accounting path for CLOSE (the only equity mutation here).
    const newNetPnl = Number(portfolio.netPnl) + closeNetPnl;
    const deployedRelease = Number(portfolio.deployed) - (entry * qty);
    await this.portfolios.update(portfolio.id, {
      deployed: Math.max(0, deployedRelease),
      netPnl: newNetPnl,
      totalCost: Number(portfolio.totalCost) + totalCost,
      openPositionCount: Math.max(0, (portfolio.openPositionCount || 0) - 1),
    });

    // Record P&L events. These are INFORMATIONAL component records for the audit
    // trail (nothing sums their deltas); the equity movement already happened once
    // above, and recordPnlEvent never mutates portfolio.netPnl.
    await this.recordPnlEvent(portfolio.id, trade.id, grossPnl, 'TRADE_CLOSE', `CLOSE ${trade.side} ${trade.instrument} @ ₹${exitPrice.toFixed(2)} · gross ₹${grossPnl.toFixed(2)} · net ₹${netPnl.toFixed(2)}`);
    await this.recordPnlEvent(portfolio.id, trade.id, netPnl, 'TRADE_CLOSE_NET', `Net P&L ₹${netPnl.toFixed(2)} (gross ₹${grossPnl.toFixed(2)}, cost ₹${totalCost.toFixed(2)})`);
    await this.recordPnlEvent(portfolio.id, trade.id, -totalCost, 'TRADE_COST', `Total cost ₹${totalCost.toFixed(2)}`);

    // Remove/close position.
    await this.syncPosition(portfolio.id, trade);

    this.logger.log(`[UPSTOX-LIVE-PAPER] CLOSE ${trade.id}: gross ₹${grossPnl.toFixed(2)} cost ₹${totalCost.toFixed(2)} net ₹${netPnl.toFixed(2)}`);
    return savedTrade;
  }

  private fillPriceForSide(side: 'BUY' | 'SELL', refPrice: number | null, slippageBps: number): number {
    const base = refPrice ?? 0;
    if (base <= 0) return 0;
    const slippageFactor = 1 + (slippageBps / 10000);
    if (side === 'BUY') return base * slippageFactor;
    return base / slippageFactor;
  }

  private computeSpreadPct(bid: number | null, ask: number | null): number {
    if (bid == null || ask == null || bid <= 0) return 0;
    const mid = (bid + ask) / 2;
    if (mid <= 0) return 0;
    return ((ask - bid) / mid) * 100;
  }

  // ── positions ───────────────────────────────────────────────────────────────

  async listPositions(portfolioId?: string): Promise<UpstoxLivePaperPosition[]> {
    const where: Record<string, unknown> = { status: 'OPEN' };
    if (portfolioId) where.portfolioId = portfolioId;
    return this.positions.find({ where, order: { createdAt: 'DESC' } });
  }

  /**
   * Refresh mark prices for open positions from the latest live quotes.
   * Real-time unrealised P&L tracking.
   */
  async refreshPositionsMarkPrices(): Promise<void> {
    const open = await this.listPositions();
    for (const pos of open) {
      const quote = await this.fetchLiveQuoteForInstrument(pos.instrument);
      if (!quote) continue;
      const markPrice = quote.ltp;
      const unrealised = this.unrealisedPnlForPosition(pos, markPrice);
      pos.markPrice = markPrice;
      pos.unrealisedPnl = unrealised;
      pos.markPriceTs = quote.ts;
      await this.positions.save(pos);
    }
  }

  private unrealisedPnlForPosition(pos: UpstoxLivePaperPosition, markPrice: number): number {
    const qty = Number(pos.quantity);
    const avg = Number(pos.averagePrice);
    const side = pos.side;
    if (side === 'BUY') return (markPrice - avg) * qty;
    return (avg - markPrice) * qty;
  }

  private async syncPosition(portfolioId: string, trade: UpstoxLivePaperTrade): Promise<void> {
    const existing = await this.positions.findOne({ where: { tradeId: trade.id } });
    if (trade.status === 'CLOSED' || trade.status === 'CANCELLED') {
      if (existing) {
        existing.status = 'CLOSED';
        existing.closedAt = new Date();
        await this.positions.save(existing);
      }
      return;
    }
    // For a new open: upsert position record.
    const pos = this.positions.create({
      portfolioId,
      tradeId: trade.id,
      instrument: trade.instrument,
      side: trade.side,
      quantity: trade.quantity,
      averagePrice: trade.entryPrice,
      markPrice: trade.entryPrice,
      unrealisedPnl: 0,
      status: 'OPEN',
      markPriceTs: trade.entryQuoteTs,
      dataSource: 'UPSTOX',
      executionMode: 'PAPER',
    });
    // Remove any existing position for this trade first (should be none).
    if (existing) {
      await this.positions.remove(existing);
    }
    await this.positions.save(pos);
  }

  // ── P&L events ─────────────────────────────────────────────────────────────

  async listPnlEvents(portfolioId?: string, limit = 200): Promise<UpstoxLivePaperPnlEvent[]> {
    const where: Record<string, unknown> = {};
    if (portfolioId) where.portfolioId = portfolioId;
    return this.pnlEvents.find({ where, order: { ts: 'DESC' }, take: limit });
  }

  private async recordPnlEvent(
    portfolioId: string,
    tradeId: string | null,
    pnlDelta: number,
    eventType: string,
    description?: string,
    context?: Record<string, unknown>,
  ): Promise<void> {
    const portfolio = await this.portfolios.findOne({ where: { id: portfolioId } });
    if (!portfolio) return;
    // LEDGER-ONLY. This is the audit trail, never an economic actor: it must NOT
    // move portfolio.netPnl. Equity moves in exactly ONE place per event —
    // openTrade() charges the entry-leg cost, closeTrade() adds gross less the
    // exit-leg cost. Previously this method ALSO applied pnlDelta on top of the
    // explicit update, so the entry leg was charged twice and the close three
    // times. runningNetPnl below is a read-only snapshot taken after that single
    // authoritative update, so the ledger still reflects the true equity.
    const runningNetPnl = Number(portfolio.netPnl);
    const ev = this.pnlEvents.create({
      portfolioId,
      tradeId,
      eventType,
      pnlDelta,
      runningNetPnl,
      description: description ?? eventType,
      context: context ? JSON.stringify(context) : null,
      dataSource: 'UPSTOX',
      executionMode: 'PAPER',
      ts: new Date(),
    });
    await this.pnlEvents.save(ev);
  }

  // ── market helpers ──────────────────────────────────────────────────────────

  private async fetchLiveQuoteForInstrument(instrument: string): Promise<LiveOptionTick | null> {
    // Try to get the latest stored quote for this contract.
    const rows = await this.optionQuotes.find({
      where: { contractSymbol: instrument },
      order: { ts: 'DESC' },
      take: 1,
    });
    if (rows.length) {
      const r = rows[0];
      return {
        contractSymbol: r.contractSymbol,
        instrumentToken: r.instrumentToken ?? '',
        underlying: r.underlying,
        expiry: r.expiry,
        strike: Number(r.strike),
        optionType: r.optionType as 'CE' | 'PE',
        ltp: Number(r.ltp),
        bid: r.bid != null ? Number(r.bid) : null,
        ask: r.ask != null ? Number(r.ask) : null,
        bidQty: r.bidQty != null ? Number(r.bidQty) : null,
        askQty: r.askQty != null ? Number(r.askQty) : null,
        volume: Number(r.volume),
        openInterest: Number(r.openInterest),
        oiChange: Number(r.oiChange),
        impliedVolatility: r.impliedVolatility != null ? Number(r.impliedVolatility) : null,
        underlyingPrice: r.underlyingPrice != null ? Number(r.underlyingPrice) : null,
        ts: r.ts,
        upstoxRef: r.instrumentToken ?? '',
        dataSource: r.dataSource,
        executionMode: r.executionMode,
      };
    }
    return null;
  }

  // ── simulated order id ──────────────────────────────────────────────────────

  private sSimulatedOrderId(): string {
    const ts = Date.now().toString(36).toUpperCase();
    const rnd = Math.random().toString(36).slice(2, 8).toUpperCase();
    return `UP-LIVE-PAPER-${ts}-${rnd}`;
  }

  // ── status summary ──────────────────────────────────────────────────────────

  async summary(portfolioId?: string): Promise<{
    portfolios: UpstoxLivePaperPortfolio[];
    trades: UpstoxLivePaperTrade[];
    positions: UpstoxLivePaperPosition[];
    feedStatus: LiveFeedStatus;
    learning: { total: number; winners: number; winRate: number; netPnl: number; byAlgo: Record<string, { count: number; winRate: number; netPnl: number }> };
  }> {
    const [portfolios, trades, positions, feedStatus] = await Promise.all([
      this.listPortfolios(),
      this.listTrades(portfolioId, 200),
      this.listPositions(portfolioId),
      this.market.status(),
    ]);
    const closed = trades.filter((t) => t.status === 'CLOSED');
    const winners = closed.filter((t) => Number(t.netPnl) > 0);
    const byAlgo: Record<string, { count: number; winRate: number; netPnl: number; grossWinner: number; grossLoser: number }> = {};
    for (const t of closed) {
      const algo = t.algoSource ?? 'manual';
      if (!byAlgo[algo]) byAlgo[algo] = { count: 0, winRate: 0, netPnl: 0, grossWinner: 0, grossLoser: 0 };
      byAlgo[algo].count += 1;
      if (Number(t.netPnl) > 0) {
        byAlgo[algo].winRate += 100;
        byAlgo[algo].grossWinner += Number(t.netPnl);
      } else {
        byAlgo[algo].grossLoser += Math.abs(Number(t.netPnl));
      }
      byAlgo[algo].netPnl += Number(t.netPnl);
    }
    for (const algo of Object.keys(byAlgo)) {
      const a = byAlgo[algo];
      a.winRate = a.count ? a.winRate / a.count : 0;
    }
    return {
      portfolios,
      trades: trades.filter((t) => t.status === 'OPEN'),
      positions,
      feedStatus,
      learning: {
        total: closed.length,
        winners: winners.length,
        winRate: closed.length ? Math.round((winners.length / closed.length) * 100) : 0,
        netPnl: closed.reduce((s, t) => s + Number(t.netPnl), 0),
        byAlgo: byAlgo as Record<string, { count: number; winRate: number; netPnl: number }>,
      },
    };
  }
}
