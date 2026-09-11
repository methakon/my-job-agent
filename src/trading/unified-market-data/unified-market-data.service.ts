import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Like, Repository } from 'typeorm';
import { UnifiedOptionQuote } from './unified-option-quote.entity';
import { UnifiedMarketSnapshot } from './unified-market-snapshot.entity';
import { canonicalInstrumentKey } from './canonical/canonical-tick';

/**
 * Normalized feed shape accepted from any broker adapter (brief s5).
 * Adapters map provider messages onto this shape; this service stamps
 * receive-time, data-quality and sequence and persists ONCE to the common
 * store, then keeps an in-memory latest-observation cache that both trading
 * engines consume (same ticks for both engines — brief s12).
 */
export type UnifiedTickInput = {
  /** Broker/exchange instrument key (e.g. NSE:NIFTY26SEP25600CE). */
  instrumentKey: string;
  underlying?: string | null;
  exchange?: string | null;
  segment?: string | null;
  instrumentType?: string | null;
  expiry?: string | null;
  strike?: number | null;
  optionType?: 'CE' | 'PE' | string | null;
  ltp?: number | null;
  bid?: number | null;
  ask?: number | null;
  bidQty?: number | null;
  askQty?: number | null;
  volume?: number | null;
  oi?: number | null;
  previousOi?: number | null;
  changeOi?: number | null;
  iv?: number | null;
  delta?: number | null;
  gamma?: number | null;
  theta?: number | null;
  vega?: number | null;
  /** Index/underlying OHLC (index snapshots). */
  open?: number | null;
  high?: number | null;
  low?: number | null;
  close?: number | null;
  depth?: unknown;
  /** Source identity: FYERS_LIVE | UPSTOX_LIVE | … (never overwritten). */
  source: string;
  /** Broker feed timestamp, when the source publishes one. */
  sourceTimestamp?: string | Date | null;
};

const finite = (value: unknown): number | null => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const tsOf = (value: unknown): Date | null => {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
};

/**
 * 'YYYY-MM-DD HH:MM:SS' in the process's own timezone — the same wall-clock
 * label mysql2 writes into DATETIME columns (connection timezone 'local').
 * Used ONLY for store-side "recent rows" counts; feed age is always derived
 * from JS Date differences.
 */
const wallClockStamp = (ms: number): string => {
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

/** Freshness of the common store (see storeFreshness()). */
export type StoreFreshness = {
  lastTs: Date | null;
  ageMs: number | null;
  source: string | null;
  quotesLast5m: number;
  snapshotsLast5m: number;
  symbolsLast5m: number;
};

/**
 * Broker-independent common market-data pipeline (brief s4/s5/s7).
 * No broker SDK, no auth, no order code — only normalize → stamp → persist →
 * cache/broadcast. Writes the common tables once per observation; engines and
 * pages read the in-memory latest cache (Phase 4) or the tables.
 */
@Injectable()
export class UnifiedMarketDataService {
  private readonly logger = new Logger(UnifiedMarketDataService.name);

  /** Per-source monotonic sequence counters. */
  private readonly sequences = new Map<string, number>();
  /** Per-source tick counters (status + health machine input). */
  private readonly sourceStats = new Map<string, { ticks: number; lastAt: Date | null }>();
  /** Latest option-quote observation per instrument key (single source of truth for engines). */
  private readonly latestQuotes = new Map<string, UnifiedOptionQuote>();
  /** Latest underlying/index observation per symbol. */
  private readonly latestSnapshots = new Map<string, UnifiedMarketSnapshot>();
  /**
   * Idempotency window for repeated observations (source|instrument|source ts).
   * A producer that sends the same broker tick twice (doubled SDK subscription
   * after a token rebuild, or a restarted socket replaying its snapshot) must
   * NOT write a second row: measured on 2026-09-10 this produced ~39 % duplicate
   * rows in unified_option_quotes. The latest-observation cache is still updated,
   * so consumers always see the newest values.
   */
  private readonly recentIngestKeys = new Map<string, number>();
  private readonly dedupeWindowMs: number;
  private duplicatesSuppressed = 0;

  constructor(
    @InjectRepository(UnifiedOptionQuote)
    private readonly quotes: Repository<UnifiedOptionQuote>,
    @InjectRepository(UnifiedMarketSnapshot)
    private readonly snapshots: Repository<UnifiedMarketSnapshot>,
  ) {
    this.dedupeWindowMs = Math.max(0, Number(process.env.UNIFIED_INGEST_DEDUPE_MS ?? 5_000));
  }

  /** Repeated observations dropped by the ingest dedupe (observability). */
  duplicateCount(): number {
    return this.duplicatesSuppressed;
  }

  /** True when this exact observation was already written inside the window. */
  private isRepeatedIngest(source: string, instrumentKey: string, ts: Date): boolean {
    if (this.dedupeWindowMs <= 0) return false;
    const key = `${source}|${instrumentKey}|${ts.getTime()}`;
    const nowMs = Date.now();
    const seenAt = this.recentIngestKeys.get(key);
    if (seenAt !== undefined && nowMs - seenAt <= this.dedupeWindowMs) {
      this.duplicatesSuppressed += 1;
      return true;
    }
    this.recentIngestKeys.set(key, nowMs);
    // Bound the map: drop everything older than the window.
    if (this.recentIngestKeys.size > 20_000) {
      for (const [k, at] of this.recentIngestKeys) {
        if (nowMs - at > this.dedupeWindowMs) this.recentIngestKeys.delete(k);
      }
    }
    return false;
  }

  /** Per-source sequence number (monotonic, in-memory). */
  nextSequence(source: string): number {
    const next = (this.sequences.get(source) ?? 0) + 1;
    this.sequences.set(source, next);
    return next;
  }

  private bumpSource(source: string, at: Date): void {
    const stats = this.sourceStats.get(source) ?? { ticks: 0, lastAt: null };
    stats.ticks += 1;
    stats.lastAt = at;
    this.sourceStats.set(source, stats);
  }

  /** Feed-observability: per-source tick count + last observation time. */
  sourceSummary(): Record<string, { ticks: number; lastAt: string | null }> {
    const out: Record<string, { ticks: number; lastAt: string | null }> = {};
    for (const [source, stats] of this.sourceStats) {
      out[source] = { ticks: stats.ticks, lastAt: stats.lastAt?.toISOString() ?? null };
    }
    return out;
  }

  /** Normalized option observation (options only; index ticks go to ingestSnapshot). */
  async ingestQuote(input: UnifiedTickInput): Promise<UnifiedOptionQuote | null> {
    const instrumentKey = String(input.instrumentKey ?? '').trim();
    const source = String(input.source ?? '').trim();
    if (!instrumentKey || !source) return null;

    const receivedTimestamp = new Date();
    const sourceTimestamp = tsOf(input.sourceTimestamp);
    // A source timestamp that was PROVIDED but is unparseable is a malformed
    // observation (brief s5) → INVALID. Absent source timestamps (REST
    // adapters without one) fall back to receive time and stay GOOD.
    const sourceTsInvalid = input.sourceTimestamp !== null && input.sourceTimestamp !== undefined && sourceTimestamp === null;
    const ts = sourceTimestamp ?? receivedTimestamp;
    const ltp = finite(input.ltp);
    const bid = finite(input.bid);
    const ask = finite(input.ask);
    // Data-quality gate (brief s8): invalid ts or no price at all → INVALID.
    const dataQuality =
      sourceTsInvalid || (ltp === null && bid === null && ask === null) ? 'INVALID' : 'GOOD';

    const row = this.quotes.create({
      instrumentKey,
      underlying: String(input.underlying ?? '').trim() || null,
      exchange: String(input.exchange ?? '').trim() || null,
      segment: String(input.segment ?? '').trim() || null,
      instrumentType: String(input.instrumentType ?? '').trim() || null,
      expiry: input.expiry ? String(input.expiry).trim() : null,
      strike: finite(input.strike),
      optionType: input.optionType ? String(input.optionType).trim().toUpperCase().slice(0, 2) : null,
      ltp,
      bid,
      ask,
      bidQty: finite(input.bidQty),
      askQty: finite(input.askQty),
      volume: finite(input.volume) ?? 0,
      oi: finite(input.oi) ?? 0,
      previousOi: finite(input.previousOi),
      changeOi: finite(input.changeOi),
      iv: finite(input.iv),
      delta: finite(input.delta),
      gamma: finite(input.gamma),
      theta: finite(input.theta),
      vega: finite(input.vega),
      depth: input.depth ?? null,
      source,
      sourceTimestamp,
      receivedTimestamp,
      sequenceNumber: this.nextSequence(source),
      dataQuality,
      ts,
    });

    this.bumpSource(source, ts);
    this.latestQuotes.set(instrumentKey, row);
    // Repeated observation of the SAME broker tick: refresh the cache (done
    // above) but do not write a second row.
    if (this.isRepeatedIngest(source, instrumentKey, ts)) return row;
    try {
      return await this.quotes.save(row);
    } catch (error) {
      this.logger.warn(`unified quote persist failed for ${instrumentKey}: ${(error as Error).message}`);
      // Cache still holds the observation for the engines even if the write
      // hiccups — the store is a write-behind cache first, table second.
      return row;
    }
  }

  /** Underlying/index observation. */
  async ingestSnapshot(input: UnifiedTickInput): Promise<UnifiedMarketSnapshot | null> {
    const symbol = String(input.instrumentKey ?? '').trim();
    const source = String(input.source ?? '').trim();
    if (!symbol || !source) return null;

    const receivedTimestamp = new Date();
    const sourceTimestamp = tsOf(input.sourceTimestamp);
    const sourceTsInvalid = input.sourceTimestamp !== null && input.sourceTimestamp !== undefined && sourceTimestamp === null;
    const ts = sourceTimestamp ?? receivedTimestamp;
    const ltp = finite(input.ltp);
    const dataQuality = sourceTsInvalid || ltp === null ? 'INVALID' : 'GOOD';

    const row = this.snapshots.create({
      symbol,
      underlying: String(input.underlying ?? '').trim() || null,
      exchange: String(input.exchange ?? '').trim() || null,
      ltp,
      volume: finite(input.volume) ?? 0,
      open: finite(input.open),
      high: finite(input.high),
      low: finite(input.low),
      close: finite(input.close),
      source,
      sourceTimestamp,
      receivedTimestamp,
      sequenceNumber: this.nextSequence(source),
      dataQuality,
      ts,
    });

    this.bumpSource(source, ts);
    this.latestSnapshots.set(symbol, row);
    if (this.isRepeatedIngest(source, symbol, ts)) return row;
    try {
      return await this.snapshots.save(row);
    } catch (error) {
      this.logger.warn(`unified snapshot persist failed for ${symbol}: ${(error as Error).message}`);
      return row;
    }
  }

  /** Latest cached option observation for an instrument key (engines read this). */
  latestQuote(instrumentKey: string): UnifiedOptionQuote | null {
    return this.latestQuotes.get(instrumentKey) ?? null;
  }

  /** All cached latest option observations (option-chain surface for engines/pages). */
  listLatestQuotes(): UnifiedOptionQuote[] {
    return [...this.latestQuotes.values()];
  }

  /** Latest cached underlying observation for a symbol. */
  latestSnapshot(symbol: string): UnifiedMarketSnapshot | null {
    return this.latestSnapshots.get(symbol) ?? null;
  }

  listLatestSnapshots(): UnifiedMarketSnapshot[] {
    return [...this.latestSnapshots.values()];
  }

  /** Age of the freshest observation for an instrument, ms (null if none). */
  quoteAgeMs(instrumentKey: string, now = Date.now()): number | null {
    const quote = this.latestQuotes.get(instrumentKey);
    if (!quote) return null;
    return Math.max(0, now - quote.ts.getTime());
  }

  /** Whether ANY live source has produced an observation within staleMs. */
  hasFreshData(staleMs: number, now = Date.now()): boolean {
    for (const stats of this.sourceStats.values()) {
      if (stats.lastAt && now - stats.lastAt.getTime() <= staleMs) return true;
    }
    return false;
  }

  /**
   * Latest observation for one option contract from the COMMON store — how a desk
   * CONSUMES ticks produced by the other desk's feed (brief s12). Lookup order:
   *   1. this process's in-memory latest cache (a producer in THIS process), then
   *   2. the unified_option_quotes table, because the other producer is a
   *      DIFFERENT process/host (the FYERS WS worker runs on the Dhargent VM).
   * Returns null when the store has nothing, nothing fresh enough, or only a
   * row flagged INVALID. The row's `source` is the TRUE producer (FYERS_LIVE /
   * UPSTOX_LIVE) and must be carried through by the caller — a consumer never
   * relabels someone else's tick as its own.
   */
  async sharedQuote(
    query: {
      /** Exact broker instrument key (preferred when known). */
      instrumentKey?: string | null;
      /** Broker contract symbol without exchange prefix (NIFTY26SEP23900CE). */
      contractSymbol?: string | null;
      underlying?: string | null;
      expiry?: string | null;
      strike?: number | null;
      optionType?: string | null;
    },
    opts: { maxAgeMs?: number; now?: number } = {},
  ): Promise<UnifiedOptionQuote | null> {
    const nowMs = opts.now ?? Date.now();
    const maxAgeMs = opts.maxAgeMs ?? Number(process.env.UNIFIED_SHARED_QUOTE_MAX_AGE_MS ?? 60_000);
    const freshEnough = (row: UnifiedOptionQuote | null | undefined): row is UnifiedOptionQuote => {
      if (!row) return false;
      if (String(row.dataQuality ?? 'GOOD').toUpperCase() === 'INVALID') return false;
      const at = (row.receivedTimestamp ?? row.ts)?.getTime?.() ?? 0;
      return at > 0 && nowMs - at <= maxAgeMs;
    };

    const key = String(query.instrumentKey ?? '').trim();
    const symbol = String(query.contractSymbol ?? '').trim().toUpperCase();
    // A producer writes the CANONICAL key (NSE:NIFTY26SEP23000PE) while a caller
    // may still ask with its broker's own form (Upstox's NSE_FO|NIFTY26SEP23000PE),
    // so both shapes are matched. This only WIDENS the lookup: it cannot produce a
    // row that is not in the store.
    const canonicalKey = key ? canonicalInstrumentKey(key) : null;
    const keyTail = key ? String(key).split('|').pop()!.split(':').pop()!.trim().toUpperCase() : '';
    const bareSymbol = symbol || (/^[A-Z0-9]+$/.test(keyTail) ? keyTail : '');
    const symbolIsUsable = Boolean(bareSymbol) && !/^\d+$/.test(bareSymbol);

    // 1. In-process cache.
    for (const candidate of [key, canonicalKey].filter((k): k is string => Boolean(k))) {
      const cached = this.latestQuotes.get(candidate);
      if (freshEnough(cached)) return cached;
    }
    if (symbolIsUsable) {
      let newest: UnifiedOptionQuote | null = null;
      for (const row of this.latestQuotes.values()) {
        const rowSymbol = String(row.instrumentKey ?? '').split(':').pop()?.toUpperCase();
        if (rowSymbol !== bareSymbol) continue;
        if (!newest || row.ts.getTime() > newest.ts.getTime()) newest = row;
      }
      if (freshEnough(newest)) return newest;
    }

    // 2. Common table (another process produced it).
    try {
      const where: Record<string, unknown>[] = [];
      if (key || symbolIsUsable) {
        if (key) where.push({ instrumentKey: key });
        if (canonicalKey && canonicalKey !== key) where.push({ instrumentKey: canonicalKey });
        if (symbolIsUsable) where.push({ instrumentKey: Like(`%:${bareSymbol}`) });
      } else {
        const fallback: Record<string, unknown> = {};
        if (query.underlying) fallback.underlying = String(query.underlying).toUpperCase();
        if (query.expiry) fallback.expiry = String(query.expiry);
        if (query.strike !== null && query.strike !== undefined) fallback.strike = query.strike;
        if (query.optionType) fallback.optionType = String(query.optionType).toUpperCase();
        where.push(fallback);
      }
      // A desk knows its contract by FIELDS (underlying/expiry/strike/right) even
      // when its broker spells the symbol differently from the canonical key, so a
      // field-level candidate is added whenever those fields are supplied. This can
      // only widen the lookup — it never fabricates a row.
      if (query.underlying && query.strike !== null && query.strike !== undefined && query.optionType) {
        const byFields: Record<string, unknown> = {
          underlying: String(query.underlying).toUpperCase(),
          strike: query.strike,
          optionType: String(query.optionType).toUpperCase(),
        };
        if (query.expiry) byFields.expiry = String(query.expiry);
        where.push(byFields);
      }
      const row = await this.quotes.findOne({ where, order: { receivedTimestamp: 'DESC' } });
      return freshEnough(row) ? row : null;
    } catch (error) {
      this.logger.warn(`unified sharedQuote lookup failed: ${(error as Error).message}`);
      return null;
    }
  }

  /**
   * Newest fresh observation per instrument for ONE underlying — the
   * universe-level sibling of sharedQuote(). A desk whose OWN broker feed has
   * gone quiet uses this to keep evaluating the universe from whatever OTHER
   * producer is live, so source selection/failover is per instrument and the
   * engine stays broker-agnostic (brief s2/s4/s12).
   *
   * Reads this process's in-memory latest cache first (a local producer), then
   * the unified_option_quotes table (the other producer may be a different
   * process). One row per instrument key, newest wins; rows older than maxAgeMs
   * or flagged INVALID are dropped. `source` is carried through untouched.
   */
  async sharedQuotesForUnderlying(
    underlying: string,
    opts: { maxAgeMs?: number; now?: number; limit?: number } = {},
  ): Promise<UnifiedOptionQuote[]> {
    const wanted = String(underlying ?? '').trim().toUpperCase();
    if (!wanted) return [];
    const nowMs = opts.now ?? Date.now();
    const maxAgeMs = opts.maxAgeMs ?? Number(process.env.UNIFIED_SHARED_QUOTE_MAX_AGE_MS ?? 60_000);
    const limit = Math.max(1, Math.min(2_000, opts.limit ?? 500));
    const freshEnough = (row: UnifiedOptionQuote | null | undefined): row is UnifiedOptionQuote => {
      if (!row) return false;
      if (String(row.dataQuality ?? 'GOOD').toUpperCase() === 'INVALID') return false;
      const at = (row.receivedTimestamp ?? row.ts)?.getTime?.() ?? 0;
      return at > 0 && nowMs - at <= maxAgeMs;
    };
    const newest = new Map<string, UnifiedOptionQuote>();
    const consider = (row: UnifiedOptionQuote | null | undefined): void => {
      if (!freshEnough(row)) return;
      const key = String(row.instrumentKey ?? '').trim().toUpperCase();
      if (!key) return;
      const at = (row.receivedTimestamp ?? row.ts).getTime();
      const previous = newest.get(key);
      const previousAt = previous ? (previous.receivedTimestamp ?? previous.ts).getTime() : 0;
      if (!previous || at > previousAt) newest.set(key, row);
    };
    for (const row of this.latestQuotes.values()) {
      if (String(row.underlying ?? '').trim().toUpperCase() === wanted) consider(row);
    }
    try {
      const rows = await this.quotes.find({
        where: { underlying: wanted },
        order: { receivedTimestamp: 'DESC' },
        take: limit,
      });
      for (const row of rows) consider(row);
    } catch (error) {
      this.logger.warn(`unified sharedQuotesForUnderlying(${wanted}) failed: ${(error as Error).message}`);
    }
    return [...newest.values()].slice(0, limit);
  }

  /**
   * Freshness of the common store, readable from ANY process — including one
   * that runs no feed socket of its own (the web app displays ticks the
   * headless engine writes; brief s4/s12: one store, many readers).
   * Ages are computed in JS on purpose: DATETIME columns carry wall clock in
   * the writers' timezone (IST on both hosts) while the DB server's NOW() /
   * UTC_TIMESTAMP() is UTC, so SQL-side time maths on them is skewed ~5.5 h.
   */
  async storeFreshness(now = Date.now()): Promise<StoreFreshness> {
    const [quotes, snapshots] = await Promise.all([
      this.quotes.find({ order: { receivedTimestamp: 'DESC' }, take: 1 }),
      this.snapshots.find({ order: { receivedTimestamp: 'DESC' }, take: 1 }),
    ]);
    const newest = [quotes[0] as UnifiedOptionQuote | undefined, snapshots[0] as UnifiedMarketSnapshot | undefined]
      .filter((row): row is UnifiedOptionQuote | UnifiedMarketSnapshot => Boolean(row?.receivedTimestamp))
      .sort((a, b) => b.receivedTimestamp.getTime() - a.receivedTimestamp.getTime())[0] ?? null;
    const lastTs = newest?.receivedTimestamp ?? null;

    const cutoff = wallClockStamp(now - 5 * 60_000);
    const [quotesLast5m, snapshotsLast5m, symbolsRaw] = await Promise.all([
      this.quotes.createQueryBuilder('q').where('q.receivedTimestamp > :cutoff', { cutoff }).getCount(),
      this.snapshots.createQueryBuilder('s').where('s.receivedTimestamp > :cutoff', { cutoff }).getCount(),
      this.quotes
        .createQueryBuilder('q')
        .select('COUNT(DISTINCT q.instrumentKey)', 'n')
        .where('q.receivedTimestamp > :cutoff', { cutoff })
        .getRawOne<{ n: string }>(),
    ]);

    return {
      lastTs,
      ageMs: lastTs ? Math.max(0, now - lastTs.getTime()) : null,
      source: newest?.source ?? null,
      quotesLast5m,
      snapshotsLast5m,
      symbolsLast5m: Number(symbolsRaw?.n ?? 0),
    };
  }

  reset(): void {
    this.sequences.clear();
    this.sourceStats.clear();
    this.latestQuotes.clear();
    this.latestSnapshots.clear();
    this.recentIngestKeys.clear();
    this.duplicatesSuppressed = 0;
  }
}
