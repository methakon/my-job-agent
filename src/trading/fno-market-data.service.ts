import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { FnfTradingService } from './fnf-trading.service';
import { parseYahooChartResponse, parseYahooSymbolConfig, YahooSymbolConfig } from './yahoo-finance-parser';
import { FnfOptionChainService } from './fnf-option-chain.service';
import { OptionContract } from './option-chain-parser';
import { shouldAcceptTick } from './market-feed-guard';

// The FYERS package currently ships JavaScript without TypeScript declarations.
// Keep the SDK boundary typed as unknown/any and validate every inbound field.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const fyersDataSocketModule = require('fyers-api-v3').fyersDataSocket as {
  getInstance: (accessToken: string, logPath?: string, enableLogging?: boolean) => FyersSocket;
};

type FyersSocket = {
  on: (event: string, handler: (...args: unknown[]) => void) => void;
  connect: () => void;
  subscribe: (symbols: string[], isDepth?: boolean, channel?: number) => void;
  mode: (mode: unknown, channel?: number) => void;
  autoreconnect?: (retries: number) => void;
  close?: () => void;
  FullMode?: unknown;
};

type FeedStatus = {
  provider: 'fyers' | 'yahoo' | 'disabled';
  /** Provider configured at boot (fyers = primary with Yahoo auto-fallback). */
  requestedProvider: 'fyers' | 'yahoo';
  /** True while Yahoo polling stands in for an unavailable FYERS socket. */
  fallbackActive: boolean;
  enabled: boolean;
  connected: boolean;
  subscribedSymbols: string[];
  ticksReceived: number;
  lastTickAt: string | null;
  lastError: string | null;
  lastMessage: string | null;
};

type Tick = {
  instrument: string;
  price: number;
  volume: number;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  bid?: number;
  ask?: number;
  openInterest?: number;
  impliedVolatility?: number;
  delta?: number;
  gamma?: number;
  theta?: number;
  vega?: number;
  ts: string;
};

const asFinite = (...values: unknown[]): number | undefined => {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' ? value as Record<string, unknown> : null;

/**
 * Real-time/near-real-time F&O market-data input. FYERS and Yahoo are data-only here: this service owns
 * one market-data socket and only calls FnfTradingService.ingestSnapshots().
 * No broker order socket or order-placement method is reachable from it.
 */
@Injectable()
export class FnoMarketDataService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FnoMarketDataService.name);
  private socket: FyersSocket | null = null;
  private yahooPollTimer: ReturnType<typeof setInterval> | null = null;
  private yahooPollInFlight = false;
  private readonly lastPersistedAt = new Map<string, number>();
  private readonly lastYahooTickAt = new Map<string, string>();
  private readonly statusValue: FeedStatus;
  private readonly persistEveryMs: number;
  private readonly yahooSymbols: YahooSymbolConfig[];
  private readonly yahooPollMs: number;
  private readonly yahooTimeoutMs: number;
  private readonly optionContracts: Map<string, OptionContract>;
  private destroyed = false;

  constructor(private readonly trading: FnfTradingService, private readonly optionChain: FnfOptionChainService) {
    const symbols = (process.env.FNO_MARKET_DATA_SYMBOLS ?? 'NSE:NIFTY50-INDEX,NSE:NIFTYBANK-INDEX,NSE:SENSEX-INDEX')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 50);
    const provider = (process.env.FNO_MARKET_DATA_PROVIDER ?? 'fyers').toLowerCase();
    const enabled = /^(1|true|yes)$/i.test(process.env.FNO_MARKET_DATA_ENABLED ?? 'false');
    this.persistEveryMs = Math.max(250, Number(process.env.FNO_MARKET_DATA_PERSIST_MS ?? 1000));
    this.yahooSymbols = parseYahooSymbolConfig(
      process.env.YAHOO_FINANCE_SYMBOLS ?? '^NSEI=NSE:NIFTY50-INDEX,^NSEBANK=NSE:NIFTYBANK-INDEX,^BSESN=NSE:SENSEX-INDEX',
    );
    this.yahooPollMs = Math.max(5_000, Number(process.env.YAHOO_FINANCE_POLL_MS ?? 15_000));
    this.yahooTimeoutMs = Math.max(2_000, Number(process.env.YAHOO_FINANCE_TIMEOUT_MS ?? 10_000));
    this.optionContracts = new Map(this.optionChain.configuredContracts().map((contract) => [contract.symbol, contract]));
    const supportedProvider = provider === 'fyers' || provider === 'yahoo';
    // 'fyers' (default) = FYERS primary; Yahoo poll stands in only while FYERS is unavailable.
    // 'yahoo' = explicit Yahoo-only mode (manual override).
    const requestedProvider: FeedStatus['requestedProvider'] = provider === 'yahoo' ? 'yahoo' : 'fyers';
    const subscribedSymbols = requestedProvider === 'yahoo' ? this.yahooSymbols.map(({ symbol }) => symbol) : symbols;
    this.statusValue = {
      provider: supportedProvider ? requestedProvider : 'disabled',
      requestedProvider,
      fallbackActive: false,
      enabled: enabled && supportedProvider && subscribedSymbols.length > 0,
      connected: false,
      subscribedSymbols,
      ticksReceived: 0,
      lastTickAt: null,
      lastError: null,
      lastMessage: null,
    };
  }


  /** Auto-register option symbols listed in FNO_MARKET_DATA_SYMBOLS so their
   *  ticks route to the option-quote store (never to index snapshots). Runs at
   *  module init when the DB connection is guaranteed (constructor-time saves
   *  race the async TypeORM connection). */
  private autoRegisterOptionSymbols(symbols: string[]): void {
    // Auto-register option symbols listed in FNO_MARKET_DATA_SYMBOLS so their
    // ticks route to the option-quote store (never to index snapshots). Pattern:
    // NSE:NIFTY<DDMMM><STRIKE><CE|PE> or BSE:SENSEX<DDMMM><STRIKE><CE|PE>.
    const optionSymbolPattern = /^(NSE|BSE):([A-Z0-9]+)(\d{2}[A-Z]{3})(\d+)(CE|PE)$/;
    const MONTHS: Record<string, string> = { JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06', JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12' };
    const expiryOf = (ddmmy: string, optionType: string): string | null => {
      // FYERS expiry code DDMMM (e.g. 26SEP). Year inferred: if the date has already
      // passed this year, assume next year.
      const day = Number(ddmmy.slice(0, 2));
      const mon = MONTHS[ddmmy.slice(2, 5)];
      if (!mon) return null;
      const now = new Date();
      let year = now.getUTCFullYear();
      if (now.getUTCMonth() + 1 > Number(mon) || (now.getUTCMonth() + 1 === Number(mon) && now.getUTCDate() > day)) year += 1;
      const iso = `${year}-${mon}-${String(day).padStart(2, '0')}`;
      const d = new Date(iso + 'T00:00:00.000Z');
      return Number.isNaN(d.getTime()) ? null : iso;
    };
    for (const sym of symbols) {
      const m = optionSymbolPattern.exec(sym);
      if (!m || this.optionContracts.has(sym)) continue;
      const underlying = m[1] === 'BSE' && m[2].includes('SENSEX') ? 'SENSEX' : m[2];
      const expiry = expiryOf(m[3], m[5]);
      if (!expiry) continue;
      const strike = Number(m[4]);
      // Lot sizes (NSE/BSE circulars, effective Jan 2026): NIFTY 65, BANKNIFTY 30,
      // FINNIFTY 60, SENSEX 20. Env FNO_OPTION_LOT_SIZE overrides for one symbol set.
      const token = m[2].toUpperCase();
      const DEFAULT_LOT: Record<string, number> = { NIFTY: 65, NIFTYBANK: 30, NIFTYFIN: 60, SENSEX: 20 };
      const lotSize = Number(process.env.FNO_OPTION_LOT_SIZE ?? 0)
        || DEFAULT_LOT[token]
        || (m[1] === 'BSE' ? 20 : 65);
      const contract = {
        symbol: sym,
        underlying,
        expiry,
        strike,
        optionType: m[5] as 'CE' | 'PE',
        lotSize,
        tickSize: 0.05,
      };
      this.optionContracts.set(sym, contract);
      void this.optionChain.upsertContract(contract).catch((e: unknown) => {
        this.logger.warn(`option contract auto-register failed for ${sym}: ${(e as Error).message}`);
      });
    }
  }

  onModuleInit(): void {
    // Register option contracts first (works even when the feed is disabled —
    // the engine needs the tradable universe regardless of live streaming).
    const optionSymbols = (process.env.FNO_MARKET_DATA_SYMBOLS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    this.autoRegisterOptionSymbols(optionSymbols);
    // Also persist contracts declared explicitly via FNO_OPTION_CONTRACTS.
    for (const contract of this.optionChain.configuredContracts()) {
      if (!this.optionContracts.has(contract.symbol)) this.optionContracts.set(contract.symbol, contract);
      void this.optionChain.upsertContract(contract).catch((e: unknown) => {
        this.logger.warn(`configured option contract upsert failed for ${contract.symbol}: ${(e as Error).message}`);
      });
    }
    if (!this.statusValue.enabled) {
      this.statusValue.lastMessage = this.statusValue.provider === 'yahoo'
        ? 'disabled; set FNO_MARKET_DATA_ENABLED=true and configure YAHOO_FINANCE_SYMBOLS'
        : 'disabled; set FNO_MARKET_DATA_ENABLED=true and configure FYERS credentials';
      this.logger.log(this.statusValue.lastMessage);
      return;
    }

    if (this.statusValue.requestedProvider === 'yahoo') {
      this.statusValue.provider = 'yahoo';
      this.statusValue.lastMessage = `polling Yahoo Finance chart API every ${this.yahooPollMs}ms (explicit Yahoo mode, paper-only)`;
      this.logger.log(this.statusValue.lastMessage);
      this.startYahooPoller();
      return;
    }

    // Requested provider = fyers: FYERS socket is primary. Yahoo is NOT polled
    // unless/until FYERS is unavailable (missing credentials, socket error/close).
    const appId = process.env.FYERS_APP_ID?.trim();
    const accessToken = process.env.FYERS_ACCESS_TOKEN?.trim();
    if (!appId || !accessToken) {
      this.startYahooFallback('FYERS credentials missing (FYERS_APP_ID/FYERS_ACCESS_TOKEN)');
      return;
    }

    try {
      const token = `${appId}:${accessToken}`;
      this.socket = fyersDataSocketModule.getInstance(token, '', false);
      this.socket.on('connect', () => this.onConnect());
      this.socket.on('message', (message: unknown) => this.onMessage(message));
      this.socket.on('error', (message: unknown) => this.onError(message));
      this.socket.on('close', (message: unknown) => this.onClose(message));
      this.socket.autoreconnect?.(6);
      this.socket.connect();
      this.statusValue.lastMessage = 'connecting to FYERS market-data WebSocket';
      this.logger.log(this.statusValue.lastMessage);
    } catch (error) {
      this.onError(error);
    }
  }

  onModuleDestroy(): void {
    this.destroyed = true;
    this.stopYahooFallback();
    this.socket?.close?.();
    this.socket = null;
    this.statusValue.connected = false;
  }

  /** Start (or keep) the Yahoo poller for explicit-yahoo mode. */
  private startYahooPoller(): void {
    if (this.yahooPollTimer) return;
    void this.pollYahoo();
    this.yahooPollTimer = setInterval(() => void this.pollYahoo(), this.yahooPollMs);
  }

  /** Yahoo stands in ONLY while FYERS is unavailable; stops when FYERS connects. */
  private startYahooFallback(reason: string): void {
    if (this.destroyed || this.statusValue.requestedProvider !== 'fyers' || this.yahooPollTimer) return;
    this.statusValue.fallbackActive = true;
    this.statusValue.provider = 'yahoo';
    this.statusValue.connected = false;
    this.statusValue.lastMessage = `Yahoo fallback active (FYERS unavailable: ${reason}); every tick is recorded`;
    this.logger.warn(this.statusValue.lastMessage);
    this.startYahooPoller();
  }

  private stopYahooFallback(): void {
    if (this.yahooPollTimer) {
      clearInterval(this.yahooPollTimer);
      this.yahooPollTimer = null;
    }
    if (this.statusValue.fallbackActive) {
      this.statusValue.fallbackActive = false;
      this.statusValue.provider = 'fyers';
      this.logger.log('FYERS socket available again — Yahoo fallback stopped');
    }
  }

  status(): FeedStatus {
    return { ...this.statusValue, subscribedSymbols: [...this.statusValue.subscribedSymbols] };
  }

  private onConnect(): void {
    if (!this.socket) return;
    this.stopYahooFallback();
    this.statusValue.connected = true;
    this.statusValue.provider = 'fyers';
    this.statusValue.lastError = null;
    this.statusValue.lastMessage = `connected; subscribing to ${this.statusValue.subscribedSymbols.length} symbol(s)`;
    // FYERS' official Node client uses SymbolUpdate for full LTP/OHLCV ticks.
    this.socket.subscribe(this.statusValue.subscribedSymbols, false, 1);
    if (this.socket.FullMode !== undefined) this.socket.mode(this.socket.FullMode, 1);
    this.logger.log(this.statusValue.lastMessage);
  }

  private onClose(message: unknown): void {
    this.statusValue.connected = false;
    this.statusValue.lastMessage = `socket closed${message ? `: ${this.safeMessage(message)}` : ''}`;
    this.logger.warn(this.statusValue.lastMessage);
    this.startYahooFallback('FYERS socket closed');
  }

  private onError(message: unknown): void {
    this.statusValue.connected = false;
    this.statusValue.lastError = this.safeMessage(message);
    this.logger.warn(`FYERS market-data error: ${this.statusValue.lastError}`);
    this.startYahooFallback(`FYERS socket error: ${this.statusValue.lastError}`);
  }

  private onMessage(message: unknown): void {
    this.recordTicks(this.parseMessage(message), 'fyers');
  }

  private recordTicks(ticks: Tick[], provider: string): void {
    if (!ticks.length) return;
    for (const tick of ticks) {
      const lastYahooTs = this.lastYahooTickAt.get(tick.instrument);
      if (!shouldAcceptTick(provider, tick.ts, lastYahooTs)) continue;
      if (provider === 'yahoo') this.lastYahooTickAt.set(tick.instrument, tick.ts);
      this.statusValue.ticksReceived += 1;
      this.statusValue.lastTickAt = tick.ts;
      const optionContract = this.optionContracts.get(tick.instrument);
      if (optionContract) {
        void this.optionChain.ingestQuote({
          contractSymbol: optionContract.symbol,
          ltp: tick.price,
          bid: tick.bid,
          ask: tick.ask,
          volume: tick.volume,
          openInterest: tick.openInterest,
          impliedVolatility: tick.impliedVolatility,
          delta: tick.delta,
          gamma: tick.gamma,
          theta: tick.theta,
          vega: tick.vega,
          ts: tick.ts,
          provider,
        }).catch((error: unknown) => {
          this.statusValue.lastError = `option quote persistence failed: ${this.safeMessage(error)}`;
          this.logger.warn(this.statusValue.lastError);
        });
        // Option-contract ticks are premium data — they never become index snapshots.
        continue;
      }
      const now = Date.now();
      const last = this.lastPersistedAt.get(tick.instrument) ?? 0;
      if (now - last < this.persistEveryMs) continue;
      this.lastPersistedAt.set(tick.instrument, now);
      void this.trading.ingestSnapshots([{ ...tick, source: provider }]).catch((error: unknown) => {
        this.statusValue.lastError = `snapshot persistence failed: ${this.safeMessage(error)}`;
        this.logger.warn(this.statusValue.lastError);
      });
    }
  }

  private async pollYahoo(): Promise<void> {
    if (this.yahooPollInFlight) return;
    this.yahooPollInFlight = true;
    try {
      const results = await Promise.allSettled(this.yahooSymbols.map((config) => this.fetchYahooTick(config)));
      const ticks: Tick[] = [];
      const errors: string[] = [];
      for (const result of results) {
        if (result.status === 'fulfilled') ticks.push(result.value);
        else errors.push(this.safeMessage(result.reason));
      }
      this.recordTicks(ticks, 'yahoo');
      this.statusValue.connected = ticks.length > 0;
      this.statusValue.lastError = errors.length ? errors.join('; ').slice(0, 240) : null;
      this.statusValue.lastMessage = `Yahoo Finance poll: ${ticks.length}/${this.yahooSymbols.length} symbol(s) returned data`;
      if (errors.length) this.logger.warn(`${this.statusValue.lastMessage}; ${this.statusValue.lastError}`);
      else this.logger.log(this.statusValue.lastMessage);
    } catch (error) {
      this.statusValue.connected = false;
      this.statusValue.lastError = this.safeMessage(error);
      this.statusValue.lastMessage = 'Yahoo Finance poll failed';
      this.logger.warn(`${this.statusValue.lastMessage}: ${this.statusValue.lastError}`);
    } finally {
      this.yahooPollInFlight = false;
    }
  }

  private async fetchYahooTick(config: YahooSymbolConfig): Promise<Tick> {
    const baseUrl = (process.env.YAHOO_FINANCE_CHART_URL ?? 'https://query1.finance.yahoo.com/v8/finance/chart').replace(/\/$/, '');
    const range = process.env.YAHOO_FINANCE_RANGE ?? '1d';
    const interval = process.env.YAHOO_FINANCE_INTERVAL ?? '1m';
    const url = `${baseUrl}/${encodeURIComponent(config.symbol)}?range=${encodeURIComponent(range)}&interval=${encodeURIComponent(interval)}&includePrePost=false`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.yahooTimeoutMs);
    try {
      const response = await fetch(url, {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'my-job-agent-paper-feed/1.0',
        },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Yahoo Finance HTTP ${response.status} for ${config.symbol}`);
      const payload: unknown = await response.json();
      const tick = parseYahooChartResponse(payload, config.instrument);
      if (!tick) throw new Error(`Yahoo Finance returned no usable quote for ${config.symbol}`);
      return tick;
    } finally {
      clearTimeout(timeout);
    }
  }

  private parseMessage(message: unknown): Tick[] {
    let value: unknown = message;
    if (Buffer.isBuffer(value)) value = value.toString('utf8');
    if (typeof value === 'string') {
      try {
        value = JSON.parse(value);
      } catch {
        return [];
      }
    }

    const records: Record<string, unknown>[] = [];
    const collect = (candidate: unknown): void => {
      if (Array.isArray(candidate)) {
        candidate.forEach(collect);
        return;
      }
      const record = asRecord(candidate);
      if (!record) return;
      const nested = record.d ?? record.data;
      if (nested && (Array.isArray(nested) || typeof nested === 'object')) collect(nested);
      if (record.symbol || record.n || record.symbolName || record.ltp || record.lp || record.last_traded_price) records.push(record);
    };
    collect(value);

    return records.flatMap((record) => {
      const nested = asRecord(record.v);
      const instrument = String(record.symbol ?? record.n ?? record.symbolName ?? '').trim();
      const price = asFinite(record.ltp, record.lp, record.last_traded_price, nested?.lp, nested?.ltp);
      if (!instrument || price === undefined || price < 0) return [];
      // FYERS v3 uses exch_feed_time (epoch seconds) for timestamp
      const epoch = asFinite(record.timestamp, record.ft, record.ts, record.exch_feed_time) ?? Date.now() / 1000;
      const ts = new Date(epoch < 2_000_000_000 ? epoch * 1000 : epoch);
      if (Number.isNaN(ts.getTime())) return [];
      return [{
        instrument,
        price,
        volume: asFinite(record.volume, record.vol, nested?.volume, nested?.v) ?? 0,
        open: asFinite(record.open_price, record.open, nested?.open_price),
        high: asFinite(record.high_price, record.high, nested?.high_price),
        low: asFinite(record.low_price, record.low, nested?.low_price),
        close: asFinite(record.prev_close_price, record.close, nested?.prev_close_price),
        bid: asFinite(record.bid, record.bid_price, nested?.bid, nested?.bid_price),
        ask: asFinite(record.ask, record.ask_price, nested?.ask, nested?.ask_price),
        openInterest: asFinite(record.oi, record.open_interest, nested?.oi, nested?.open_interest),
        impliedVolatility: asFinite(record.iv, record.implied_volatility, nested?.iv, nested?.implied_volatility),
        delta: asFinite(record.delta, nested?.delta),
        gamma: asFinite(record.gamma, nested?.gamma),
        theta: asFinite(record.theta, nested?.theta),
        vega: asFinite(record.vega, nested?.vega),
        ts: ts.toISOString(),
      }];
    });
  }

  private safeMessage(value: unknown): string {
    if (value instanceof Error) return value.message;
    if (typeof value === 'string') return value.slice(0, 240);
    try {
      return JSON.stringify(value).slice(0, 240);
    } catch {
      return 'unknown WebSocket error';
    }
  }
}
