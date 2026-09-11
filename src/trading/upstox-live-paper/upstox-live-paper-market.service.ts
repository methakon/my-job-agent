import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThanOrEqual } from 'typeorm';
import { BsmGreeks, BsmInputs, localGreeks, bsmGreeks } from '../bsm-greeks';
import { UpstoxLivePaperConfig } from './upstox-live-paper.config';
import { UpstoxLivePaperTokenService } from './upstox-live-paper-auth.service';
import { FeedHealthService } from '../unified-market-data/feed-health.service';
import { FeedArbitrationService } from '../unified-market-data/feed-arbitration.service';
import { TickInterpreterService } from '../unified-market-data/canonical/tick-interpreter.service';
import { UnifiedMarketDataService } from '../unified-market-data/unified-market-data.service';
import { ownedUniverses, shortUniverse } from '../unified-market-data/feed-arbitration.state';
import { universeForInstrument } from './upstox-live-paper.config';
import { UPSTOX_LIVE_DATA_ISOLATION } from './upstox-live-paper.const';
import { UpstoxLivePaperOptionQuote, UpstoxLivePaperMarketSnapshot } from './upstox-live-paper-entities';

/** Feed name this desk's REST poll registers under with the arbiter. */
const UPSTOX_REST_FEED = 'UPSTOX_REST';

const UPSTOX_LIVE_API_BASE = 'https://api.upstox.com';
const UPSTOX_LIVE_V2_OPTION_CHAIN = '/v2/option/chain';
const UPSTOX_LIVE_V2_OPTION_CONTRACT = '/v2/option/contract';
/** v2 quote endpoints are keyed by instrument_key (NOT instrument_token). */
const UPSTOX_LIVE_V2_QUOTE = '/v2/market-quote/quotes';
const UPSTOX_LIVE_V2_LTP = '/v2/market-quote/ltp';
const UPSTOX_LIVE_V2_MARKET_STATUS = '/v2/market/status';
const UPSTOX_LIVE_WS_BASE = 'wss://api.upstox.com/live/';

/** Upstox v2 /option/chain leg — one side (call or put) of a strike row. */
interface UpstoxV2MarketData {
  ltp?: number; last_price?: number; close_price?: number; volume?: number;
  oi?: number; open_interest?: number; prev_oi?: number;
  bid_price?: number; bid_qty?: number; ask_price?: number; ask_qty?: number;
  [k: string]: unknown;
}
interface UpstoxV2Greeks { delta?: number; gamma?: number; theta?: number; vega?: number; iv?: number; [k: string]: unknown; }
interface UpstoxV2Leg { instrument_key?: string; market_data?: UpstoxV2MarketData; option_greeks?: UpstoxV2Greeks; [k: string]: unknown; }
interface UpstoxV2ChainRow {
  strike_price?: number; expiry?: string; underlying_key?: string; underlying_spot_price?: number;
  call_options?: UpstoxV2Leg; put_options?: UpstoxV2Leg; [k: string]: unknown;
}
interface UpstoxV2ContractRow {
  expiry?: string; strike_price?: number; instrument_key?: string; underlying_key?: string;
  lot_size?: number; lotSize?: number; trading_symbol?: string; [k: string]: unknown;
}
interface UpstoxV2Envelope<T> { status?: string; data?: T; code?: string; message?: string; errors?: unknown; }

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
  /**
   * TRUE producer of this price: 'UPSTOX_LIVE' when this desk's own REST poll
   * produced it, or the other feed's label (e.g. 'FYERS_LIVE') when the tick was
   * CONSUMED from the common store (brief s12 — desks share ticks, never
   * relabelled). Optional so existing producers stay valid.
   */
  feedSource?: string;
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
  /** Single-active-feed role for this desk's own REST producer (brief s2/s6). */
  feedRole: 'ACTIVE' | 'STANDBY' | 'DISABLED';
  /** Universe → owning feed, as elected by the arbiter. */
  activeFeedByUniverse: Record<string, string | null>;
  /** Why this desk's feed is standing by (null when it is active/disabled). */
  standbyReason: string | null;
  /** Ticks for this desk's instruments consumed from the common store. */
  sharedTicksUsed: number;
  /** Repeated observations dropped by the common store's ingest dedupe. */
  duplicateTicksSuppressed: number;
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
/** Today's date (YYYY-MM-DD) in IST — the market's own calendar. */
const istDateString = (now = Date.now()): string => new Date(now + 5.5 * 3_600_000).toISOString().slice(0, 10);
/** 'BSE_INDEX|SENSEX' → 'SENSEX' · 'NSE_INDEX|Nifty 50' → 'NIFTY50'. */
const underlyingShortName = (key: string): string =>
  String(key.split('|').pop() ?? key).toUpperCase().replace(/[^A-Z0-9]/g, '');

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
  /** Cached v2 auth headers + validity horizon (see liveAuthHeaders). */
  private authHeadersCache: Record<string,string> | null = null;
  private authCacheUntilMs = 0;
  /** Expiry currently used per underlying key, resolved from the broker's contract list. */
  private readonly expiryByUnderlyingKey = new Map<string, string>();
  /**
   * Lot size per underlying key, read from the broker's OWN contract master
   * (/v2/option/contract). Never hard-coded; unknown stays null.
   */
  private readonly lotSizeByUnderlyingKey = new Map<string, number>();
  /** Why the contract master has no lot size yet (null when it does). */
  private contractMasterNote: string | null = 'contract master not read yet';
  /** Last time the AUTH_REQUIRED warning was logged (throttled to 5 min). */
  private lastAuthWarnMs = 0;
  /** Single-active-feed role of THIS desk's REST producer (brief s2/s6). */
  private feedRole: 'ACTIVE' | 'STANDBY' | 'DISABLED' = 'DISABLED';
  /** Universe → owning feed (arbiter election), for status/UI. */
  private activeFeedByUniverse: Record<string, string | null> = {};
  private standbyReason: string | null = null;
  private lastStandbyLogMs = 0;
  /** Ticks consumed from the common store instead of this desk's own poll. */
  private sharedTicksUsed = 0;
  /** Last liveAuthHeaders() outcome — feeds the arbiter's credentialsOk. */
  private lastAuthOk = false;
  /** Last time a chain leg without its own instrument_key was reported (throttled). */
  private lastLegKeyWarnMs = 0;
  /**
   * Deterministic token → symbol map built from the broker's OWN contract master
   * (/v2/option/contract). Real v2 option-chain legs carry a NUMERIC instrument
   * key (e.g. `BSE_FO|862843`), which carries no identity by itself: the
   * canonical interpreter refuses to guess one, so the adapter supplies the
   * broker's own symbols here instead.
   */
  private readonly symbolByInstrumentKey = new Map<string, { symbol: string; exchange: string | null }>();
  private readonly symbolByToken = new Map<string, { symbol: string; exchange: string | null }>();

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

  /**
   * Lot size for one of THIS desk's contracts, read from the broker's own
   * contract master (/v2/option/contract — see captureContractMaster). Nothing
   * is hard-coded and nothing is guessed: an unresolved contract returns null and
   * the caller must skip the order rather than invent a size.
   */
  lotSizeForSymbol(instrument: string): number | null {
    const wanted = String(instrument ?? '').trim().toUpperCase();
    if (!wanted) return null;
    let best: { short: string; size: number } | null = null;
    for (const key of this.config.liveInstruments ?? []) {
      const short = underlyingShortName(key);
      const size = this.lotSizeByUnderlyingKey.get(key) ?? this.lotSizeByUnderlyingKey.get(short);
      if (!short || !size || size < 1) continue;
      if (!wanted.startsWith(short)) continue;
      // Longest underlying name wins when two tracked keys share a prefix.
      if (!best || short.length > best.short.length) best = { short, size };
    }
    return best ? best.size : null;
  }

  /** Contract-master state for status/UI — what was read, and what it said. */
  contractMasterStatus(): { underlyings: Record<string, number>; note: string | null } {
    const underlyings: Record<string, number> = {};
    for (const [key, size] of this.lotSizeByUnderlyingKey.entries()) underlyings[key] = size;
    return { underlyings, note: this.contractMasterNote };
  }

  /**
   * Read lot sizes out of a /v2/option/contract response. Upstox returns one row
   * per listed contract including `lot_size`; the modal (most frequent) value per
   * underlying is used. A response without lot_size records WHY, so the UI can
   * say "cannot size from the broker master" instead of guessing.
   */
  private captureContractMaster(key: string, rows: UpstoxV2ContractRow[], expiry: string | null): void {
    const short = underlyingShortName(key);
    const exchange = String(key).split('|')[0].split('_')[0] || null;
    // The same response is the ONLY honest source of a numeric token's identity:
    // remember instrument_key → trading_symbol so the canonical interpreter can
    // resolve a chain leg instead of rejecting it (never a guessed symbol).
    for (const row of rows) {
      const instrumentKey = String(row.instrument_key ?? '').trim();
      const tradingSymbol = String(row.trading_symbol ?? '').trim();
      if (!instrumentKey || !tradingSymbol) continue;
      const identity = { symbol: tradingSymbol, exchange };
      this.symbolByInstrumentKey.set(instrumentKey.toUpperCase(), identity);
      const token = instrumentKey.split('|').pop() ?? '';
      if (/^\d+$/.test(token)) this.symbolByToken.set(token, identity);
    }
    if (this.symbolByToken.size > 100_000) {
      // Bound the map: the master is re-read per underlying/expiry anyway.
      this.symbolByToken.clear();
      this.symbolByInstrumentKey.clear();
    }
    const counts = new Map<number, number>();
    for (const row of rows) {
      const raw = finite(row.lot_size) ?? finite(row.lotSize);
      if (raw === null || raw < 1) continue;
      const size = Math.max(1, Math.trunc(raw));
      counts.set(size, (counts.get(size) ?? 0) + 1);
    }
    if (!counts.size) {
      this.contractMasterNote = `/option/contract returned no lot_size for ${key}`;
      this.logger.warn(`[UPSTOX-LIVE] contract master: no lot size returned for ${key} (expiry ${expiry ?? '?'}) — orders cannot be sized from the broker master`);
      return;
    }
    const [size] = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
    const previous = this.lotSizeByUnderlyingKey.get(key);
    this.lotSizeByUnderlyingKey.set(key, size);
    this.lotSizeByUnderlyingKey.set(short, size);
    this.contractMasterNote = null;
    if (previous !== size) {
      this.logger.log(`[UPSTOX-LIVE] contract master: ${short} lot size ${size} across ${rows.length} contract rows (expiry ${expiry ?? '?'}) — source /v2/option/contract`);
    }
  }

  /**
   * Deterministic instrument-key/token → symbol resolution for the canonical
   * interpreter, taken from the broker's OWN contract master (never guessed).
   * A token the master has never described stays unresolved and the tick is
   * rejected by the interpreter — visible in its rejection counters.
   */
  private resolveContractSymbol(providerInstrumentId: string): { symbol: string; exchange: string | null } | null {
    const key = String(providerInstrumentId ?? '').trim();
    if (!key) return null;
    const direct = this.symbolByInstrumentKey.get(key.toUpperCase());
    if (direct) return direct;
    const token = key.split('|').pop() ?? key;
    return /^\d+$/.test(token) ? this.symbolByToken.get(token) ?? null : null;
  }

  constructor(config: UpstoxLivePaperConfig,
    @InjectRepository(UpstoxLivePaperOptionQuote) optionQuotes: Repository<UpstoxLivePaperOptionQuote>,
    @InjectRepository(UpstoxLivePaperMarketSnapshot) marketSnapshots: Repository<UpstoxLivePaperMarketSnapshot>,
    private readonly feedHealth: FeedHealthService,
    private readonly tokenService: UpstoxLivePaperTokenService,
    private readonly arbitration: FeedArbitrationService,
    private readonly unified: UnifiedMarketDataService,
    // Canonical interpreter (shadow by default): measures this RAW Upstox leg.
    private readonly interpreter: TickInterpreterService) {
    this.config = config; this.optionQuotes = optionQuotes; this.marketSnapshots = marketSnapshots;
    this.paperOnly = config.paperOnly; this.safetyLockActive = config.safetyLockActive;
    // Feed-health gate registration (brief s6/s8): the Upstox desk's own REST
    // polling registers as its live source until the desk migrates onto the
    // unified tick stream (Phase 4). Never satisfies the gate before its first
    // real tick (ageMs null).
    this.feedHealth.registerFeed('UPSTOX_REST', 'upstox-paper', {
      ageMs: () => (this.lastLiveTickMs === null ? null : Math.max(0, Date.now() - this.lastLiveTickMs)),
    });
    // Single-active-feed registration (brief s2/s6). This desk's REST poll is a
    // SECONDARY producer (priority 1 by default): it only publishes ticks for a
    // universe the arbiter has awarded it, so at most one feed drives a given
    // universe at a time. Priority/config come from the environment so the desk
    // can be demoted to pure consumer without a code change.
    this.arbitration.register({
      name: UPSTOX_REST_FEED,
      priority: this.arbitrationPriority(),
      universes: this.trackedUniverses(),
      enabled: () => this.config.liveCredentialsPresent && this.config.liveInstruments.length > 0,
      credentialsOk: () => this.lastAuthOk,
      note: 'upstox-paper REST poll (secondary by default)',
      ageMs: () => (this.lastLiveTickMs === null ? null : Math.max(0, Date.now() - this.lastLiveTickMs)),
    });
  }

  /** FEED_PRIORITY_UPSTOX_REST, fallback: secondary (1). */
  private arbitrationPriority(): number { return this.arbitration.priorityFor(UPSTOX_REST_FEED, 1); }

  /**
   * Option universes this desk's poll prices, from UPSTOX_LIVE_INSTRUMENTS.
   *
   * Universe labels are what the arbiter matches on, so they must agree with
   * the other feed's labels for the SAME underlying: `NSE_INDEX|Nifty 50`
   * derives `NIFTY50` while option contract symbols derive `NIFTY`. The opt-in
   * UPSTOX_LIVE_UNIVERSE_MAP makes the broker key register as `NIFTY`, so the
   * universe genuinely has two producers and failover between them is possible
   * (empty map = derived labels, unchanged behaviour).
   */
  private trackedUniverses(): string[] {
    return [
      ...new Set(
        this.config.liveInstruments
          .map((key) => universeForInstrument(key, this.config.liveUniverseMap))
          .filter(Boolean),
      ),
    ].sort();
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
      feedRole: this.config.liveCredentialsPresent && this.config.liveInstruments.length ? this.feedRole : 'DISABLED',
      activeFeedByUniverse: this.activeFeedByUniverse,
      standbyReason: this.standbyReason,
      sharedTicksUsed: this.sharedTicksUsed,
      duplicateTicksSuppressed: this.unified.duplicateCount(),
    };
  }

  async fetchOptionChain(): Promise<{fetched:number;errors:string[]}> {
    if (!this.config.liveCredentialsPresent) { this.restLastError='LIVE credentials missing'; this.logger.warn(this.restLastError); return {fetched:0,errors:[this.restLastError]}; }
    // Single-active-feed gate (brief s2/s6): at most ONE feed publishes ticks for
    // a universe. If another producer owns SENSEX (e.g. the FYERS worker), this
    // desk stays STANDBY and serves its decisions from the shared store instead
    // of calling the broker — no duplicate ticks, no wasted API budget.
    const universes = this.trackedUniverses();
    const decisions = await this.arbitration.decisions();
    this.activeFeedByUniverse = {};
    for (const d of decisions) if (d?.universe) this.activeFeedByUniverse[d.universe] = d.owner ?? null;
    const owned = ownedUniverses(UPSTOX_REST_FEED, universes, decisions);
    // Stand down ONLY against a real competing owner. If nobody holds our
    // universes (no lease yet, arbiter unavailable, universe not yet tracked)
    // this desk is the only producer and must keep polling — standing down
    // against nobody would silently starve the desk of its own feed.
    const contested = universes.filter((u) => {
      const owner = this.activeFeedByUniverse[u];
      return Boolean(owner) && owner !== UPSTOX_REST_FEED;
    });
    const active = contested.length ? owned.length > 0 : universes.length > 0;
    this.feedRole = active ? 'ACTIVE' : universes.length ? 'STANDBY' : 'DISABLED';
    this.standbyReason = active ? null
      : `feed arbitration awarded ${contested.join(', ') || universes.join(', ') || 'this universe'} to ${this.activeFeedByUniverse[contested[0]] ?? 'another producer'}`;
    if (!active) {
      const nowMs = Date.now();
      if (nowMs - this.lastStandbyLogMs > 300_000) {
        this.lastStandbyLogMs = nowMs;
        this.logger.log(`[UPSTOX-LIVE] STANDBY — ${this.standbyReason}; consuming shared live ticks, not polling`);
      }
      await this.arbitration.beat(UPSTOX_REST_FEED, { state: 'STANDBY', note: this.standbyReason });
      return { fetched: 0, errors: [] };
    }
    // Serve what the arbiter awarded, or — when nothing contests us — our own
    // configured universes.
    const wanted = owned.length ? owned : universes;
    const keys = this.config.liveInstruments
      .filter((k) => wanted.includes(universeForInstrument(k, this.config.liveUniverseMap)))
      .slice(0, 50);
    if (!keys.length) return {fetched:0,errors:['no instruments']};
    const headers = await this.liveAuthHeaders();
    if (!headers) {
      this.lastAuthOk = false;
      // No valid token row → nothing can be ingested. Say so out loud, but
      // throttled: the poll cycle retries every UPSTOX_LIVE_POLL_MS.
      this.restLastError = `AUTH_REQUIRED — ${this.restLastError ?? 'Upstox access token missing/expired'}; complete the login at /api/upstox/token/init`;
      const nowMs = Date.now();
      if (nowMs - this.lastAuthWarnMs > 300_000) { this.lastAuthWarnMs = nowMs; this.logger.warn(`[UPSTOX-LIVE] ${this.restLastError}`); }
      return {fetched:0,errors:[this.restLastError]};
    }
    this.lastAuthOk = true;
    const errors: string[] = []; let fetched = 0;
    for (const key of keys) {
      try {
        const chain = await this.fetchChainForKey(key, headers);
        if (!chain.ticks.length) { errors.push(`no tradable quotes for ${key}${chain.expiry?` (expiry ${chain.expiry})`:''}`); continue; }
        for (const tick of chain.ticks) {
          await this.persistOptionQuote(tick);
          this.markOptionQuoteTs(tick.contractSymbol, tick.ts.getTime());
          this.quotesPersistedToday++; fetched++;
        }
        if (chain.spot !== null) {
          await this.persistMarketSnapshot({
            instrument: chain.ticks[0].underlying, price: chain.spot, bid: null, ask: null, volume: 0,
            open: null, high: null, low: null, close: null, ts: chain.ticks[0].ts, upstoxRef: key,
            dataSource: UPSTOX_LIVE_DATA_ISOLATION.dataSource, executionMode: UPSTOX_LIVE_DATA_ISOLATION.executionMode,
          });
          this.markMarketSnapshotTs(chain.ticks[0].underlying, chain.ticks[0].ts.getTime());
          // The underlying's tape is part of the COMMON observation too: the
          // pattern engine cannot confirm a breakout without it, and the other
          // desk must be able to read it (brief s4/s17). Written through the
          // canonical pipeline, from the RAW provider row.
          await this.publishSharedSnapshot(shortUniverse(key), chain.ticks[0].ts, key, chain.spotRow);
        }
      } catch (err) { errors.push(`${key}: ${this.errorMessage(err)}`); this.logger.warn(`[UPSTOX-LIVE] fetch failed for ${key}: ${this.errorMessage(err)}`); }
    }
    this.optionChainFetchedAt = nowUtc();
    this.restLastError = errors.length ? errors.join('; ').slice(0,300) : null;
    this.logger.log(`[UPSTOX-LIVE] option chain: ${fetched} quotes persisted from ${keys.length} underlying(s)`);
    // Publish liveness + what we just produced (cross-process: the FYERS worker
    // reads this to know SENSEX is already covered).
    await this.arbitration.beat(UPSTOX_REST_FEED, {
      state: 'ACTIVE', note: null, universes: owned,
      lastTickAt: this.lastLiveTickMs === null ? null : new Date(this.lastLiveTickMs),
      credentialsOk: true,
    });
    return { fetched, errors };
  }

  /**
   * Mirror the underlying index tape into the COMMON store through the CANONICAL
   * pipeline: the RAW provider chain row (the response this desk just received)
   * is interpreted, validated and persisted in canonical form by the interpreter,
   * so the pattern engine and the other desk consume ONE canonical observation of
   * the index. The desk's own snapshot table is written separately
   * (persistMarketSnapshot) and is unaffected. Never fatal: a failed mirror must
   * not cost the desk its own tick, and a rejected row is dropped + counted
   * rather than routed to broker-specific logic.
   *
   * The identity the row itself does not carry — the index key this chain was
   * requested for — comes from the SAME provider call (`instrument_key=<key>`).
   */
  private async publishSharedSnapshot(universe: string, ts: Date, requestKey: string, row: unknown): Promise<void> {
    if (!row) return;
    try {
      const outcome = await this.interpreter.ingestMessage('UPSTOX_LIVE', row, {
        receivedAt: ts,
        identity: {
          providerInstrumentId: requestKey,
          underlying: universe,
          exchange: requestKey.startsWith('BSE') ? 'BSE' : 'NSE',
          instrumentType: 'INDEX',
        },
      });
      if (!outcome.persisted) {
        this.logger.warn(`[UPSTOX-LIVE] common-store index mirror not written for ${universe} (accepted=${outcome.accepted} rejected=${outcome.rejected} withheld=${outcome.withheld})`);
      }
    } catch (error) {
      this.logger.warn(`[UPSTOX-LIVE] common-store snapshot mirror failed for ${universe}: ${this.errorMessage(error)}`);
    }
  }

  /**
   * A tick for one of THIS desk's contracts, read from the common store instead
   * of called in from the broker. Used when the desk is STANDBY for a universe
   * (another feed owns the live slot) — the desks share observations while
   * keeping separate trades, balances and P&L. The returned tick keeps the
   * TRUE producer in `feedSource`, so the UI never presents another feed's
   * price as this desk's own.
   */
  async sharedOptionTickFor(query: {
    contractSymbol?: string | null; instrumentToken?: string | null; underlying?: string | null;
    expiry?: string | null; strike?: number | null; optionType?: 'CE' | 'PE' | null;
    maxAgeMs?: number;
  }): Promise<LiveOptionTick | null> {
    const maxAgeMs = query.maxAgeMs ?? this.config.staleQuoteMaxAgeMs;
    const row = await this.unified.sharedQuote({
      instrumentKey: query.instrumentToken ?? null,
      contractSymbol: query.contractSymbol ?? null,
      underlying: query.underlying ?? null,
      expiry: query.expiry ?? null,
      strike: query.strike ?? null,
      optionType: query.optionType ?? null,
    }, { maxAgeMs });
    if (!row) return null;
    const ltp = finite(row.ltp);
    if (ltp === null || ltp <= 0) return null;
    const instrumentKey = String(row.instrumentKey ?? '');
    const underlying = String(row.underlying ?? query.underlying ?? '').toUpperCase();
    const optionType = toOptionType(row.optionType) ?? query.optionType ?? null;
    if (!optionType) return null;
    const strike = finite(row.strike) ?? query.strike ?? 0;
    const expiry = String(row.expiry ?? query.expiry ?? '');
    const symbol = String(query.contractSymbol ?? instrumentKey.split(':').pop() ?? '').toUpperCase();
    const source = String(row.source ?? '').toUpperCase();
    this.sharedTicksUsed++;
    return {
      contractSymbol: symbol, instrumentToken: instrumentKey || String(query.instrumentToken ?? ''),
      underlying, expiry, strike, optionType, ltp,
      bid: finite(row.bid), ask: finite(row.ask), bidQty: finite(row.bidQty), askQty: finite(row.askQty),
      volume: Math.max(0, Math.trunc(finite(row.volume) ?? 0)),
      openInterest: Math.max(0, Math.trunc(finite(row.oi) ?? 0)),
      oiChange: Math.trunc(finite(row.changeOi) ?? 0),
      impliedVolatility: finite(row.iv),
      underlyingPrice: this.latestUnderlyingPriceByInstrument.get(underlying) ?? null,
      ts: row.receivedTimestamp ?? row.ts,
      upstoxRef: instrumentKey || null,
      dataSource: UPSTOX_LIVE_DATA_ISOLATION.dataSource,
      executionMode: UPSTOX_LIVE_DATA_ISOLATION.executionMode,
      feedSource: source || 'COMMON_STORE',
    };
  }

  /**
   * One underlying's live chain, flattened into per-leg ticks. Upstox v2 takes
   * `instrument_key` (e.g. BSE_INDEX|SENSEX) — not an instrument token — and
   * /option/chain REQUIRES `expiry_date`. The expiry comes from the broker's own
   * /option/contract list: the nearest LISTED expiry, which is today's expiry on
   * expiry day. No expiry is ever hard-coded.
   */
  private async fetchChainForKey(key: string, headers: Record<string,string>): Promise<{ticks: LiveOptionTick[]; spot: number|null; expiry: string|null; spotRow: unknown|null}> {
    const expiry = await this.resolveExpiry(key, headers);
    if (!expiry) return { ticks: [], spot: null, expiry: null, spotRow: null };
    const url = `${UPSTOX_LIVE_API_BASE}${UPSTOX_LIVE_V2_OPTION_CHAIN}?instrument_key=${encodeURIComponent(key)}&expiry_date=${encodeURIComponent(expiry)}`;
    const res = await this.fetchJson<UpstoxV2Envelope<UpstoxV2ChainRow[]>>(url, {method:'GET',headers});
    const rows = Array.isArray(res?.data) ? res.data : [];
    if (!rows.length) {
      if (res?.code || res?.message) throw new Error(`Upstox chain error ${res.code ?? ''}: ${res.message ?? ''}`);
      return { ticks: [], spot: null, expiry, spotRow: null };
    }

    const symbol = underlyingShortName(key);
    // The row that carries the underlying's tape — kept whole so the canonical
    // interpreter can read the provider's own field rather than a copy of it.
    const spotRow = rows.find(r => finite(r.underlying_spot_price) !== null) ?? null;
    const spot = finite(spotRow?.underlying_spot_price);
    if (spot !== null) this.latestUnderlyingPriceByInstrument.set(symbol, spot);

    // Bound the universe to a window of strikes around ATM (config-driven).
    const strikes = rows.map(r => finite(r.strike_price)).filter((n): n is number => n !== null).sort((a,b) => a-b);
    let keep: Set<number> | null = null;
    if (spot !== null && strikes.length) {
      const atm = strikes.reduce((best, s) => (Math.abs(s - spot) < Math.abs(best - spot) ? s : best), strikes[0]);
      const idx = strikes.indexOf(atm); const w = this.config.liveStrikeWindow;
      keep = new Set(strikes.slice(Math.max(0, idx - w), idx + w + 1));
    }

    const ts = nowUtc();
    const ticks: LiveOptionTick[] = [];
    for (const row of rows) {
      const strike = finite(row.strike_price); if (strike === null) continue;
      if (keep && !keep.has(strike)) continue;
      const rowExpiry = parseExpiryDate(row.expiry) ?? expiry;
      const legs: Array<[UpstoxV2Leg | undefined, 'CE' | 'PE']> = [[row.call_options, 'CE'], [row.put_options, 'PE']];
      for (const [leg, optionType] of legs) {
        const tick = this.legToTick(leg, optionType, strike, rowExpiry, symbol, key, ts);
        if (tick) ticks.push(tick);
      }
    }
    return { ticks, spot, expiry, spotRow };
  }

  /**
   * The expiry to fetch for an underlying, taken from the broker's contract list:
   * the earliest listed expiry not before today (i.e. today's expiry on expiry
   * day, else the next one). Memoised per underlying until it has passed.
   */
  private async resolveExpiry(key: string, headers: Record<string,string>): Promise<string|null> {
    const today = istDateString();
    const cached = this.expiryByUnderlyingKey.get(key);
    if (cached && cached >= today) return cached;
    const url = `${UPSTOX_LIVE_API_BASE}${UPSTOX_LIVE_V2_OPTION_CONTRACT}?instrument_key=${encodeURIComponent(key)}`;
    const res = await this.fetchJson<UpstoxV2Envelope<UpstoxV2ContractRow[]>>(url, {method:'GET',headers});
    const rows = Array.isArray(res?.data) ? res.data : [];
    const expiries = Array.from(new Set(rows.map(r => parseExpiryDate(r.expiry)).filter((e): e is string => e !== null))).sort();
    const upcoming = expiries.filter(e => e >= today);
    const picked = (this.config.livePreferTodayExpiry ? upcoming.find(e => e === today) : undefined) ?? upcoming[0] ?? null;
    if (picked) this.expiryByUnderlyingKey.set(key, picked);
    else this.logger.warn(`[UPSTOX-LIVE] no listed expiry on/after ${today} for ${key} (listed: ${expiries.join(', ') || 'none'})`);
    // Same response carries the broker's own lot sizes — capture them here so
    // order sizing never depends on a hand-set constant.
    if (rows.length) this.captureContractMaster(key, rows, picked);
    return picked;
  }

  /** Map one v2 chain leg (call/put) onto a desk tick; null when it has no price. */
  private legToTick(leg: UpstoxV2Leg | undefined, optionType: 'CE'|'PE', strike: number, expiry: string, symbol: string, key: string, ts: Date): LiveOptionTick | null {
    const md = leg?.market_data;
    if (!md) return null;
    const ltp = finite(md.ltp) ?? finite(md.last_price);
    if (ltp === null || ltp <= 0) return null; // no honest tick without a traded price
    const oi = finite(md.oi) ?? finite(md.open_interest);
    const prevOi = finite(md.prev_oi);
    const iv = finite(leg?.option_greeks?.iv);
    const spot = this.latestUnderlyingPriceByInstrument.get(symbol) ?? null;
    const greeks = this.computeGreeks(ltp, strike, expiry, spot, optionType, iv);
    const instrumentKey = String(leg?.instrument_key ?? '');
    const tick: LiveOptionTick = {
      contractSymbol: `${symbol}${expiry.slice(2).replace(/-/g,'')}${Math.trunc(strike)}${optionType}`,
      instrumentToken: instrumentKey, underlying: symbol, expiry, strike, optionType,
      ltp, bid: finite(md.bid_price), ask: finite(md.ask_price),
      bidQty: finite(md.bid_qty), askQty: finite(md.ask_qty),
      volume: Math.max(0, Math.trunc(finite(md.volume) ?? 0)),
      openInterest: Math.max(0, Math.trunc(oi ?? 0)),
      oiChange: oi !== null && prevOi !== null ? Math.trunc(oi - prevOi) : 0,
      impliedVolatility: iv ?? greeks?.iv ?? null,
      underlyingPrice: spot, ts, upstoxRef: instrumentKey || key,
      dataSource: UPSTOX_LIVE_DATA_ISOLATION.dataSource, executionMode: UPSTOX_LIVE_DATA_ISOLATION.executionMode,
    };
    // CANONICAL PIPELINE (mandatory, no mode): the RAW chain leg goes through the
    // deterministic interpreter, which validates it and persists what passes into
    // the common store in canonical form (the desk's own store is written by the
    // caller). A rejected leg is dropped and counted — it is never handed to
    // broker-specific logic as a fallback. The identity the leg does not carry
    // itself comes from the SAME provider response (row expiry/strike/right), never
    // from a guess; a leg with no instrument key at all is left unresolvable and
    // says so instead of inventing a symbol.
    if (!instrumentKey) {
      const nowMs = Date.now();
      if (nowMs - this.lastLegKeyWarnMs > 300_000) {
        this.lastLegKeyWarnMs = nowMs;
        this.logger.warn('[UPSTOX-LIVE] chain leg without instrument_key — no canonical identity to persist for this contract');
      }
    }
    void this.interpreter
      .ingestMessage('UPSTOX_LIVE', leg, {
        receivedAt: ts,
        // A numeric leg key carries no identity: the broker's own contract master
        // (read this cycle) is the only deterministic resolver.
        resolveSymbol: (id) => this.resolveContractSymbol(id),
        identity: {
          providerInstrumentId: instrumentKey || null,
          underlying: symbol,
          exchange: key.startsWith('BSE') ? 'BSE' : 'NSE',
          instrumentType: 'OPT',
          expiry, strike, optionType,
        },
      })
      .catch((error: unknown) => this.logger.warn(`[UPSTOX-LIVE] canonical ingest failed for ${tick.contractSymbol}: ${this.errorMessage(error)}`));
    return tick;
  }

  private async fetchMarketStatus(): Promise<void> {
    if (!this.config.liveCredentialsPresent) return;
    // Upstox v2 requires the exchange segment in the path — /v2/market/status/{exchange}.
    // A bare /v2/market/status answers 404 UDAPI100060 (Resource not Found).
    const exchange = this.marketStatusExchange();
    if (!exchange) return;
    try {
      const headers = await this.liveAuthHeaders(); if (!headers) return;
      const res = await this.fetchJson<UpstoxMarketStatusResponse>(`${UPSTOX_LIVE_API_BASE}${UPSTOX_LIVE_V2_MARKET_STATUS}/${encodeURIComponent(exchange)}`, {method:'GET',headers});
      // A market-status probe is not an option-chain fetch: it must not stamp
      // optionChainFetchedAt (that made a metadata call look like quote data).
      this.logger.log(`[UPSTOX-LIVE] market status (${exchange}): ${res?.data?.marketStatus ?? res?.status ?? 'unknown'}`);
    } catch (err) { this.logger.warn(`[UPSTOX-LIVE] market status failed: ${this.errorMessage(err)}`); }
  }

  /**
   * Exchange segment for /v2/market/status/{exchange}, derived from the tracked
   * underlyings (never hard-coded): 'BSE_INDEX|SENSEX' → 'BSE', 'NSE_FO|…' →
   * 'NSE_FO'. Index segments lose their _INDEX suffix (Upstox uses the plain
   * exchange for index market status).
   */
  private marketStatusExchange(): string {
    const first = String(this.config.liveInstruments?.[0] ?? '').trim();
    const segment = first.split('|')[0].trim().toUpperCase();
    if (!segment) return 'NSE';
    return segment.replace(/_INDEX$/, '');
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
    this.wsTimer = setInterval(() => {
      void this.fetchOptionChain().catch(e=>this.logger.warn(`[UPSTOX-LIVE] periodic fetch failed: ${this.errorMessage(e)}`));
      // Market-status is a broker metadata call: only probe while this desk owns
      // the live slot for its universe (a standby desk makes no Upstox calls).
      if (this.feedRole !== 'STANDBY') void this.fetchMarketStatus().catch(()=>{});
    }, interval);
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

  private computeGreeks(ltp: number, strike: number, expiry: string, spot: number|null, optionType: 'CE'|'PE', ivOverride: number|null): BsmGreeks|null {
    if (!spot || spot<=0) return null;
    const expiryDate = new Date(expiry+'T15:30:00.000Z'); const now = nowUtc();
    let years = (expiryDate.getTime()-now.getTime())/(1000*60*60*24*365); if (years<=0) years = 1/(252*24);
    const inputs: BsmInputs = { spot, strike, years };
    if (ivOverride && ivOverride>0) { const g = bsmGreeks(inputs, optionType, ivOverride); if (!g) return null; return { ...g, premium: ltp, iv: ivOverride }; }
    return localGreeks(ltp, inputs, optionType);
  }

  /**
   * Auth headers for Upstox v2 REST, built from the SINGLE active token row in
   * the database (never from .env — see UpstoxLivePaperTokenService). Cached
   * briefly so one poll cycle does not hit the DB per request. Returns null and
   * records restLastError when no valid token exists (AUTH_REQUIRED).
   */
  private async liveAuthHeaders(): Promise<Record<string,string> | null> {
    if (this.authHeadersCache && Date.now() < this.authCacheUntilMs) return this.authHeadersCache;
    let token: string;
    let expiresAt: Date;
    try {
      const active = await this.tokenService.getValidUpstoxAccessToken();
      token = active.token; expiresAt = active.expiresAt;
    } catch (err) {
      this.authHeadersCache = null; this.authCacheUntilMs = 0;
      this.restLastError = this.errorMessage(err);
      return null;
    }
    const headers: Record<string,string> = { 'Content-Type':'application/json', Accept:'application/json' };
    if (this.config.liveApiKey) headers['x-api-key'] = this.config.liveApiKey;
    headers['Authorization'] = `Bearer ${token}`;
    this.authHeadersCache = headers;
    this.authCacheUntilMs = Math.min(expiresAt.getTime(), Date.now() + 60_000);
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
