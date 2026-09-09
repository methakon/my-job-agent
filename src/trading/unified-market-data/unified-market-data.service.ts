import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UnifiedOptionQuote } from './unified-option-quote.entity';
import { UnifiedMarketSnapshot } from './unified-market-snapshot.entity';

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

  constructor(
    @InjectRepository(UnifiedOptionQuote)
    private readonly quotes: Repository<UnifiedOptionQuote>,
    @InjectRepository(UnifiedMarketSnapshot)
    private readonly snapshots: Repository<UnifiedMarketSnapshot>,
  ) {}

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

  reset(): void {
    this.sequences.clear();
    this.sourceStats.clear();
    this.latestQuotes.clear();
    this.latestSnapshots.clear();
  }
}
