import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { FnfTradingService } from './fnf-trading.service';

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
  provider: 'fyers' | 'disabled';
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
 * Real-time F&O market-data input. FYERS is data-only here: this service owns
 * one market-data socket and only calls FnfTradingService.ingestSnapshots().
 * No broker order socket or order-placement method is reachable from it.
 */
@Injectable()
export class FnoMarketDataService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FnoMarketDataService.name);
  private socket: FyersSocket | null = null;
  private readonly lastPersistedAt = new Map<string, number>();
  private readonly statusValue: FeedStatus;
  private readonly persistEveryMs: number;

  constructor(private readonly trading: FnfTradingService) {
    const symbols = (process.env.FNO_MARKET_DATA_SYMBOLS ?? 'NSE:NIFTY50-INDEX,NSE:NIFTYBANK-INDEX,NSE:SENSEX-INDEX')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 50);
    const provider = (process.env.FNO_MARKET_DATA_PROVIDER ?? 'fyers').toLowerCase();
    const enabled = /^(1|true|yes)$/i.test(process.env.FNO_MARKET_DATA_ENABLED ?? 'false');
    this.persistEveryMs = Math.max(250, Number(process.env.FNO_MARKET_DATA_PERSIST_MS ?? 1000));
    this.statusValue = {
      provider: provider === 'fyers' ? 'fyers' : 'disabled',
      enabled: enabled && provider === 'fyers',
      connected: false,
      subscribedSymbols: symbols,
      ticksReceived: 0,
      lastTickAt: null,
      lastError: null,
      lastMessage: null,
    };
  }

  onModuleInit(): void {
    if (!this.statusValue.enabled) {
      this.statusValue.lastMessage = 'disabled; set FNO_MARKET_DATA_ENABLED=true and configure FYERS credentials';
      this.logger.log(this.statusValue.lastMessage);
      return;
    }

    const appId = process.env.FYERS_APP_ID?.trim();
    const accessToken = process.env.FYERS_ACCESS_TOKEN?.trim();
    if (!appId || !accessToken) {
      this.statusValue.enabled = false;
      this.statusValue.lastError = 'FYERS credentials are not configured';
      this.logger.warn('F&O market feed disabled: FYERS_APP_ID/FYERS_ACCESS_TOKEN are missing');
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
    this.socket?.close?.();
    this.socket = null;
    this.statusValue.connected = false;
  }

  status(): FeedStatus {
    return { ...this.statusValue, subscribedSymbols: [...this.statusValue.subscribedSymbols] };
  }

  private onConnect(): void {
    if (!this.socket) return;
    this.statusValue.connected = true;
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
  }

  private onError(message: unknown): void {
    this.statusValue.connected = false;
    this.statusValue.lastError = this.safeMessage(message);
    this.logger.warn(`FYERS market-data error: ${this.statusValue.lastError}`);
  }

  private onMessage(message: unknown): void {
    const parsed = this.parseMessage(message);
    if (!parsed.length) return;
    for (const tick of parsed) {
      this.statusValue.ticksReceived += 1;
      this.statusValue.lastTickAt = tick.ts;
      const now = Date.now();
      const last = this.lastPersistedAt.get(tick.instrument) ?? 0;
      if (now - last < this.persistEveryMs) continue;
      this.lastPersistedAt.set(tick.instrument, now);
      void this.trading.ingestSnapshots([tick]).catch((error: unknown) => {
        this.statusValue.lastError = `snapshot persistence failed: ${this.safeMessage(error)}`;
        this.logger.warn(this.statusValue.lastError);
      });
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
      const epoch = asFinite(record.timestamp, record.ft, record.ts) ?? Date.now() / 1000;
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
