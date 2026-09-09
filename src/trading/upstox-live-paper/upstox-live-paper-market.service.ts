import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThanOrEqual } from 'typeorm';
import { BsmGreeks, BsmInputs, localGreeks, bsmGreeks } from '../bsm-greeks';
import { UpstoxLivePaperConfig } from './upstox-live-paper.config';
import { FeedHealthService } from '../unified-market-data/feed-health.service';
import { UPSTOX_LIVE_DATA_ISOLATION } from './upstox-live-paper.const';
import { UpstoxLivePaperOptionQuote, UpstoxLivePaperMarketSnapshot } from './upstox-live-paper-entities';

const UPSTOX_LIVE_API_BASE = 'https://api.upstox.com';
const UPSTOX_LIVE_V2_OPTION_CHAIN = '/v2/option/chain';
const UPSTOX_LIVE_V2_QUOTE = '/v2/quote';
const UPSTOX_LIVE_V2_MARKET_STATUS = '/v2/market/status';
const UPSTOX_LIVE_WS_BASE = 'wss://api.upstox.com/live/';

interface UpstoxApiError { status?: number; code?: string; message?: string; details?: string; }

interface UpstoxOptionChainRow {
  symbol?: string; instrumentToken?: string; lastPrice?: number; openInterest?: number;
  changeinOI?: number; volume?: number; bidPrice?: number; askPrice?: number; bidQty?: number;
  askQty?: number; impliedVolatility?: number; underlying?: string; strikePrice?: number;
  optionType?: string; expiryDate?: string; timestamp?: string; mode?: string;
}

interface UpstoxQuoteResponse {
  data?: { symbol?: string; instrumentToken?: string; lastPrice?: number; bidPrice?: number; askPrice?: number;
    bidQty?: number; askQty?: number; volume?: number; openInterest?: number; changeinOI?: number;
    impliedVolatility?: number; underlying?: string; strikePrice?: number; optionType?: string;
    expiryDate?: string; timestamp?: string; mode?: string; [k: string]: unknown };
  status?: string; code?: string; message?: string;
}

interface UpstoxMarketStatusResponse {
  status?: string; code?: string; message?: string;
  data?: { exchange?: string; timestamp?: string; marketStatus?: string; [k: string]: unknown };
}

export interface LiveOptionTick {
  contractSymbol: string; instrumentToken: string; underlying: string; expiry: string; strike: number;
  optionType: 'CE' | 'PE'; ltp: number; bid: number | null; ask: number | null;
  bidQty: number | null; askQty: number | null; volume: number; openInterest: number; oiChange: number;
  impliedVolatility: number | null; underlyingPrice: number | null; ts: Date; upstoxRef: string | null;
  dataSource: string; executionMode: string;
}

export interface LiveMarketTick {
  instrument: string; price: number; bid: number | null; ask: number | null; volume: number;
  open: number | null; high: number | null; low: number | null; close: number | null; ts: Date;
  upstoxRef: string | null; dataSource: string; executionMode: string;
}

export interface LiveFeedStatus {
  enabled: boolean; paperOnly: boolean; safetyLockActive: boolean;
  marketDataSource: 'UPSTOX_LIVE' | 'UPSTOX_LIVE_DISABLED' | 'DEGRADED';
  optionChainFetchedAt: string | null; lastOptionQuoteTs: string | null; lastMarketSnapshotTs: string | null;
  staleBlockedTrades: number; wsConnected: boolean; wsLastError: string | null; restLastError: string | null;
  lastError: string | null; instrumentsTracked: number; quotesPersistedToday: number;
}

const nowUtc = () => new Date();
const parseExpiryDate = (raw: unknown): string | null => {
  if (!raw) return null;
  const s = String(raw).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) { const d = new Date(s + 'T00:00:00.000Z'); return Number.isNaN(d.getTime()) ? null : s; }
  const m = s.match(/^(\d{2})([A-Z]{3})(\d{4})$/);
  if (!m) return null;
  const months = { JAN:'01',FEB:'02',MAR:'03',APR:'04',MAY:'05',JUN:'06',JUL:'07',AUG:'08',SEP:'09',OCT:'10',NOV:'11',DEC:'12' };
  const mon = months[m[2]]; if (!mon) return null;
  const iso = `${m[3]}-${mon}-${m[1]}`; const d = new Date(iso + 'T00:00:00.000Z');
  return Number.isNaN(d.getTime()) ? null : iso;
};
const parseTs = (raw: unknown): Date | null => {
  if (!raw) return null; const n = Number(raw);
  if (Number.isFinite(n)) { const c = n < 1e12 ? new Date(n*1000) : new Date(n); return Number.isNaN(c.getTime()) ? null : c; }
  const d = new Date(String(raw)); return Number.isNaN(d.getTime()) ? null : d;
};
const finite = (v: unknown): number | null => { if (v===null||v===undefined||v==='') return null; const n=Number(v); return Number.isFinite(n)?n:null; };
const toOptionType = (raw: unknown): 'CE'|'PE'|null => { const s=String(raw??'').trim().toUpperCase(); if(s==='CE')return'CE'; if(s==='PE')return'PE'; return null; };

@Injectable()
export class UpstoxLivePaperMarketService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(UpstoxLivePaperMarketService.name);
  private readonly config: UpstoxLivePaperConfig;
  private readonly optionQuotes: Repository<UpstoxLivePaperOptionQuote>;
  private readonly marketSnapshots: Repository<UpstoxLivePaperMarketSnapshot>;

  private lastOptionQuoteTsByContract = new Map<string, number>();
  private lastMarketSnapshotTsByInstrument = new Map<string, number>();
  private staleBlockedCount = 0;
  /** Newest tick timestamp observed from ANY Upstox instrument (feed gate). */
  private lastLiveTickMs: number | null = null;
  private optionChainFetchedAt: Date | null = null;
  private wsConnected = false;
  private wsLastError: string | null = null;
  private restLastError: string | null = null;
  private quotesPersistedToday = 0;
  private wsTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly paperOnly: boolean;
  private readonly safetyLockActive: boolean;
  private latestUnderlyingPriceByInstrument = new Map<string, number>();

  slippageBps(): number { return this.config.defaultSlippageBps; }
  staleThresholdMs(): number { return this.config.staleQuoteMaxAgeMs; }
  abnormalSpreadThresholdPct(): number { return this.config.abnormalSpreadPctThreshold; }

  incrementStaleBlocked(): void { this.staleBlockedCount++; }
  incrementQuotesPersisted(): void { this.quotesPersistedToday++; }
  errorMessage(err: unknown): string {
    if (err instanceof Error) return err.message;
    if (typeof err==='object' && err && (err as UpstoxApiError).message) return (err as UpstoxApiError).message as string;
    return String(err);
  }
  markOptionQuoteTs(cs: string, ms: number): void {
    this.lastOptionQuoteTsByContract.set(cs, ms);
    if (this.lastLiveTickMs === null || ms > this.lastLiveTickMs) this.lastLiveTickMs = ms;
  }
  markMarketSnapshotTs(inst: string, ms: number): void {
    this.lastMarketSnapshotTsByInstrument.set(inst, ms);
    if (this.lastLiveTickMs === null || ms > this.lastLiveTickMs) this.lastLiveTickMs = ms;
  }
  underlyingPriceCache(): Map<string, number> { return this.latestUnderlyingPriceByInstrument; }

  constructor(config: UpstoxLivePaperConfig,
    @InjectRepository(UpstoxLivePaperOptionQuote) optionQuotes: Repository<UpstoxLivePaperOptionQuote>,
    @InjectRepository(UpstoxLivePaperMarketSnapshot) marketSnapshots: Repository<UpstoxLivePaperMarketSnapshot>,
    private readonly feedHealth: FeedHealthService) {
    this.config = config; this.optionQuotes = optionQuotes; this.marketSnapshots = marketSnapshots;
    this.paperOnly = config.paperOnly; this.safetyLockActive = config.safetyLockActive;
    // Feed-health gate registration (brief s6/s8): the Upstox desk's own REST
    // polling registers as its live source until the desk migrates onto the
    // unified tick stream (Phase 4). Never satisfies the gate before its first
    // real tick (ageMs null).
    this.feedHealth.registerFeed('UPSTOX_REST', 'upstox-paper', {
      ageMs: () => (this.lastLiveTickMs === null ? null : Math.max(0, Date.now() - this.lastLiveTickMs)),
    });
  }

  async onModuleInit(): Promise<void> {
    if (!this.config.liveInstruments.length) { this.logger.warn('[UPSTOX-LIVE] no instruments — market ingestion no-op'); return; }
    if (!this.config.liveCredentialsPresent) { this.logger.warn('[UPSTOX-LIVE] missing credentials — REST calls will fail auth'); return; }
    void this.fetchOptionChain(); void this.fetchMarketStatus(); this.startPeriodicRefresh();
    if (this.config.liveWebSocketEnabled) void this.startWebSocket();
  }
  onModuleDestroy(): void { this.stopPeriodicRefresh(); this.stopWebSocket(); }

  status(): LiveFeedStatus {
    const src: LiveFeedStatus['marketDataSource'] = !this.config.liveCredentialsPresent ? 'UPSTOX_LIVE_DISABLED'
      : this.optionChainFetchedAt || this.lastOptionQuoteTsByContract.size>0 ? 'UPSTOX_LIVE' : 'DEGRADED';
    return {
      enabled: this.config.liveCredentialsPresent && this.config.liveInstruments.length>0,
      paperOnly: this.paperOnly, safetyLockActive: this.safetyLockActive, marketDataSource: src,
      optionChainFetchedAt: this.optionChainFetchedAt?.toISOString() ?? null,
      lastOptionQuoteTs: this.lastOptionQuoteTsByContract.size ? new Date(Math.max(...this.lastOptionQuoteTsByContract.values())).toISOString() : null,
      lastMarketSnapshotTs: this.lastMarketSnapshotTsByInstrument.size ? new Date(Math.max(...this.lastMarketSnapshotTsByInstrument.values())).toISOString() : null,
      staleBlockedTrades: this.staleBlockedCount, wsConnected: this.wsConnected,
      wsLastError: this.wsLastError, restLastError: this.restLastError,
      lastError: this.restLastError ?? this.wsLastError,
      instrumentsTracked: this.config.liveInstruments.length, quotesPersistedToday: this.quotesPersistedToday,
    };
  }

  async fetchOptionChain(): Promise<{fetched:number;errors:string[]}> {
    if (!this.config.liveCredentialsPresent) { this.restLastError='LIVE credentials missing'; this.logger.warn(this.restLastError); return {fetched:0,errors:[this.restLastError]}; }
    const errors: string[] = []; const headers = this.liveAuthHeaders(); const symbols = this.config.liveInstruments.slice(0,50);
    if (!symbols.length) return {fetched:0,errors:['no instruments']};
    for (const sym of symbols) {
      try {
        const row = await this.fetchOptionChainForSymbol(sym, headers);
        if (!row) { errors.push(`no data for ${sym}`); continue; }
        const tick = await this.normalizeOptionChainRow(row, sym);
        if (!tick) { errors.push(`unparseable row for ${sym}`); continue; }
        await this.persistOptionQuote(tick);
        this.lastOptionQuoteTsByContract.set(tick.contractSymbol, tick.ts.getTime());
        this.quotesPersistedToday++;
      } catch (err) { errors.push(`${sym}: ${this.errorMessage(err)}`); this.logger.warn(`[UPSTOX-LIVE] fetch failed for ${sym}: ${this.errorMessage(err)}`); }
    }
    this.optionChainFetchedAt = nowUtc();
    this.restLastError = errors.length ? errors.join('; ').slice(0,300) : null;
    this.logger.log(`[UPSTOX-LIVE] option chain: ${symbols.length-errors.length}/${symbols.length} persisted`);
    return { fetched: symbols.length-errors.length, errors };
  }

  private async fetchOptionChainForSymbol(sym: string, headers: Record<string,string>): Promise<UpstoxOptionChainRow|null> {
    const token = this.instrumentTokenForSymbol(sym); if (!token) return null;
    const q = await this.fetchJson<UpstoxQuoteResponse>(`${UPSTOX_LIVE_API_BASE}${UPSTOX_LIVE_V2_QUOTE}?instrument_token=${encodeURIComponent(token)}`, {method:'GET',headers});
    if (q?.data) return this.upstoxQuoteDataToRow(q.data, token, sym);
    const underlying = this.underlyingForSymbol(sym); if (!underlying) return null;
    const chain = await this.fetchJson<{data?:UpstoxOptionChainRow[];status?:string;code?:string;message?:string}>(
      `${UPSTOX_LIVE_API_BASE}${UPSTOX_LIVE_V2_OPTION_CHAIN}?instrument_token=${encodeURIComponent(underlying)}`, {method:'GET',headers});
    if (!chain?.data?.length) { if (chain?.code||chain?.message) throw new Error(`Upstox chain error ${chain.code}: ${chain.message}`); return null; }
    return chain.data.find(r=>this.rowMatchesSymbol(r,sym)) ?? chain.data[0] ?? null;
  }

  private rowMatchesSymbol(row: UpstoxOptionChainRow, sym: string): boolean {
    const s = String(row.symbol??'').trim().toUpperCase();
    if (!s) return false;
    return s === sym.toUpperCase() || sym.toUpperCase().includes(s) || s.includes(sym.toUpperCase());
  }

  private async fetchMarketStatus(): Promise<void> {
    if (!this.config.liveCredentialsPresent) return;
    try {
      const res = await this.fetchJson<UpstoxMarketStatusResponse>(`${UPSTOX_LIVE_API_BASE}${UPSTOX_LIVE_V2_MARKET_STATUS}`, {method:'GET',headers:this.liveAuthHeaders()});
      this.optionChainFetchedAt = nowUtc(); this.logger.log(`[UPSTOX-LIVE] market status: ${res?.status??'unknown'}`);
    } catch (err) { this.logger.warn(`[UPSTOX-LIVE] market status failed: ${this.errorMessage(err)}`); }
  }

  private async startWebSocket(): Promise<void> {
    if (!this.config.liveCredentialsPresent) { this.wsLastError='LIVE credentials missing'; return; }
    this.logger.log('[UPSTOX-LIVE] starting WS for live ticks'); this.reconnectTimer=null; await this.connectWebSocket();
  }
  private async connectWebSocket(): Promise<void> { this.wsConnected=false; this.wsLastError=null; this.logger.log('[UPSTOX-LIVE] WS path prepared; using REST polling fallback'); }
  private stopWebSocket(): void { this.wsConnected=false; if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer=null; } }

  private startPeriodicRefresh(): void {
    if (this.wsTimer) return;
    const interval = Math.max(10000, Number(process.env.UPSTOX_LIVE_POLL_MS ?? 30000));
    this.wsTimer = setInterval(() => { void this.fetchOptionChain().catch(e=>this.logger.warn(`[UPSTOX-LIVE] periodic fetch failed: ${this.errorMessage(e)}`)); void this.fetchMarketStatus().catch(()=>{}); }, interval);
    this.wsTimer.unref?.();
  }
  private stopPeriodicRefresh(): void { if (this.wsTimer) { clearInterval(this.wsTimer); this.wsTimer=null; } }

  private async persistOptionQuote(tick: LiveOptionTick): Promise<void> {
    const entity = this.optionQuotes.create({ contractSymbol: tick.contractSymbol, instrumentToken: tick.instrumentToken, underlying: tick.underlying, expiry: tick.expiry, strike: tick.strike, optionType: tick.optionType, ltp: tick.ltp, bid: tick.bid, ask: tick.ask, bidQty: tick.bidQty, askQty: tick.askQty, volume: tick.volume, openInterest: tick.openInterest, oiChange: tick.oiChange, impliedVolatility: tick.impliedVolatility, underlyingPrice: tick.underlyingPrice, bidDepth: tick.bidQty?Math.round(tick.bidQty):null, askDepth: tick.askQty?Math.round(tick.askQty):null, ts: tick.ts, dataSource: tick.dataSource, executionMode: tick.executionMode });
    await this.optionQuotes.save(entity);
  }

  private async persistMarketSnapshot(tick: LiveMarketTick): Promise<void> {
    const entity = this.marketSnapshots.create({ instrument: tick.instrument, price: tick.price, bid: tick.bid, ask: tick.ask, volume: tick.volume, open: tick.open, high: tick.high, low: tick.low, close: tick.close, ts: tick.ts, dataSource: tick.dataSource, executionMode: tick.executionMode, upstoxRef: tick.upstoxRef });
    await this.marketSnapshots.save(entity);
    if (tick.price!=null && Number.isFinite(tick.price)) this.latestUnderlyingPriceByInstrument.set(tick.instrument, tick.price);
  }

  isStale(contractSymbol: string): boolean { const ts = this.lastOptionQuoteTsByContract.get(contractSymbol); if (!ts) return true; return (Date.now()-ts) > this.config.staleQuoteMaxAgeMs; }
  latestQuoteTs(contractSymbol: string): number | null { return this.lastOptionQuoteTsByContract.get(contractSymbol) ?? null; }

  private async normalizeOptionChainRow(row: UpstoxOptionChainRow, reqSym: string): Promise<LiveOptionTick|null> {
    const symbol = row.symbol ?? reqSym; const contractSymbol = this.contractSymbolForRow(row, symbol); if (!contractSymbol) return null;
    const ts = parseTs(row.timestamp) ?? nowUtc(); const optionType = toOptionType(row.optionType) ?? 'CE';
    const expiry = parseExpiryDate(row.expiryDate) ?? '2099-12-31'; const strike = finite(row.strikePrice) ?? 0;
    const underlying = String(row.underlying??'').trim().toUpperCase() || 'UNKNOWN';
    const ltp = finite(row.lastPrice); const bid = finite(row.bidPrice); const ask = finite(row.askPrice);
    if (ltp===null || ltp<=0) return null;
    const iv = finite(row.impliedVolatility); const spot = this.latestUnderlyingPriceByInstrument.get(underlying) ?? null;
    const greeks = this.computeGreeks(ltp, strike, expiry, spot, optionType, iv);
    return { contractSymbol, instrumentToken: String(row.instrumentToken??''), underlying, expiry, strike, optionType, ltp, bid: bid??null, ask: ask??null, bidQty: finite(row.bidQty), askQty: finite(row.askQty), volume: Math.max(0,Math.trunc(finite(row.volume)??0)), openInterest: Math.max(0,Math.trunc(finite(row.openInterest)??0)), oiChange: Math.trunc(finite(row.changeinOI)??0), impliedVolatility: iv??greeks?.iv??null, underlyingPrice: spot, ts, upstoxRef: String(row.instrumentToken??''), dataSource: UPSTOX_LIVE_DATA_ISOLATION.dataSource, executionMode: UPSTOX_LIVE_DATA_ISOLATION.executionMode };
  }

  private upstoxQuoteDataToRow(data: UpstoxQuoteResponse['data'], token: string, reqSym: string): UpstoxOptionChainRow|null {
    if (!data) return null;
    return { symbol: data.symbol??reqSym, instrumentToken: data.instrumentToken??token, lastPrice: data.lastPrice, bidPrice: data.bidPrice, askPrice: data.askPrice, bidQty: data.bidQty, askQty: data.askQty, volume: data.volume, openInterest: data.openInterest, changeinOI: data.changeinOI, impliedVolatility: data.impliedVolatility, underlying: data.underlying, strikePrice: data.strikePrice, optionType: data.optionType, expiryDate: data.expiryDate, timestamp: data.timestamp, mode: data.mode };
  }

  private contractSymbolForRow(row: UpstoxOptionChainRow, reqSym: string): string|null {
    const s = String(row.symbol??'').trim(); if (s) return s;
    const u = String(row.underlying??'').trim().toUpperCase(); const strike = finite(row.strikePrice); const type = toOptionType(row.optionType); const expiry = parseExpiryDate(row.expiryDate);
    if (u && strike!=null && type && expiry) { const ss = String(Math.trunc(strike)); return `${u}${expiry.slice(2).replace(/-/g,'')}${ss}${type}`; }
    return reqSym || null;
  }

  private underlyingForSymbol(sym: string): string|null { const m = sym.match(/^([A-Z]+)/); return m ? m[1] : null; }
  private instrumentTokenForSymbol(sym: string): string|null { return sym; }

  private computeGreeks(ltp: number, strike: number, expiry: string, spot: number|null, optionType: 'CE'|'PE', ivOverride: number|null): BsmGreeks|null {
    if (!spot || spot<=0) return null;
    const expiryDate = new Date(expiry+'T15:30:00.000Z'); const now = nowUtc();
    let years = (expiryDate.getTime()-now.getTime())/(1000*60*60*24*365); if (years<=0) years = 1/(252*24);
    const inputs: BsmInputs = { spot, strike, years };
    if (ivOverride && ivOverride>0) { const g = bsmGreeks(inputs, optionType, ivOverride); if (!g) return null; return { ...g, premium: ltp, iv: ivOverride }; }
    return localGreeks(ltp, inputs, optionType);
  }

  private liveAuthHeaders(): Record<string,string> {
    const key = this.config.liveApiKey; const secret = this.config.liveApiSecret; const token = this.config.liveAccessToken;
    const headers: Record<string,string> = { 'Content-Type':'application/json', Accept:'application/json' };
    if (key && secret) { headers['x-api-key']=key; if (token) headers['Authorization']=`Bearer ${token}`; } else if (token) { headers['Authorization']=`Bearer ${token}`; }
    return headers;
  }

  private async fetchJson<T>(url: string, opts: {method:string; headers:Record<string,string>}): Promise<T> {
    const res = await fetch(url, { method: opts.method, headers: opts.headers, signal: AbortSignal.timeout(15000) });
    const text = await res.text();
    if (!res.ok) { const parsed = this.tryParseError<UpstoxApiError>(text); throw new Error(`HTTP ${res.status} from ${url}: ${(parsed?.message??parsed?.code??text).slice(0,500)}`); }
    try { return JSON.parse(text) as T; } catch { throw new Error(`invalid JSON from ${url}: ${text.slice(0,300)}`); }
  }

  private tryParseError<T>(text: string): T|null { try { return JSON.parse(text) as T; } catch { return null; } }
}
