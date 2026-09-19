
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThan, LessThan, Between, In, FindOptionsWhere } from 'typeorm';
import { UnifiedOptionQuoteHistory } from './unified-option-quote-history.entity';
import { UnifiedMarketSnapshotHistory } from './unified-market-snapshot-history.entity';

/**
 * Read-only research service for historical market data.
 *
 * Provides bounded, indexed queries against unified_option_quotes_history
 * and unified_market_snapshots_history for off-hours analysis.
 *
 * SAFETY:
 * - NEVER performs full-table scans — all queries use WHERE + LIMIT
 * - NEVER blocks live trading (runs async/off-hours only)
 * - All windows are bounded (max 30 trading days by default)
 * - Results are capped (max 1000 rows per query by default)
 * - Uses existing composite indexes (underlying+receivedTimestamp,
 *   symbol+receivedTimestamp, ts+instrumentKey)
 */

export interface HistoryWindow {
  /** Start of window (inclusive). */
  start: Date;
  /** End of window (inclusive). */
  end: Date;
}

export interface QuoteQueryOptions {
  /** Filter by underlying index (e.g. NIFTY, NIFTYBANK). */
  underlying?: string;
  /** Filter by instrument key (exact match). */
  instrumentKey?: string;
  /** Filter by option type (CE/PE). */
  optionType?: string;
  /** Filter by expiry date (YYYY-MM-DD string). */
  expiry?: string;
  /** Filter by strike price. */
  strike?: number;
  /** Maximum rows to return. Default 1000. */
  limit?: number;
  /** Sort direction. Default DESC (newest first). */
  order?: 'ASC' | 'DESC';
}

export interface SnapshotQueryOptions {
  /** Filter by underlying symbol. */
  symbol?: string;
  /** Filter by underlying name. */
  underlying?: string;
  /** Maximum rows to return. Default 1000. */
  limit?: number;
  /** Sort direction. Default DESC (newest first). */
  order?: 'ASC' | 'DESC';
}

export interface AggregatedQuoteStats {
  instrumentKey: string;
  underlying: string;
  expiry: string;
  sampleCount: number;
  avgLtp: number | null;
  minLtp: number | null;
  maxLtp: number | null;
  avgSpread: number | null;
  avgVolume: number | null;
  firstTimestamp: Date;
  lastTimestamp: Date;
}

export interface AggregatedSnapshotStats {
  symbol: string;
  sampleCount: number;
  avgLtp: number | null;
  minLtp: number | null;
  maxLtp: number | null;
  avgVolume: number | null;
  firstTimestamp: Date;
  lastTimestamp: Date;
}

/** Maximum trading days for a single query window. */
const MAX_WINDOW_DAYS = 30;
/** Default row limit per query. */
const DEFAULT_LIMIT = 1000;
/** Maximum row limit per query. */
const MAX_LIMIT = 5000;

@Injectable()
export class HistoricalResearchService {
  private readonly logger = new Logger(HistoricalResearchService.name);

  constructor(
    @InjectRepository(UnifiedOptionQuoteHistory)
    private readonly quoteHistory: Repository<UnifiedOptionQuoteHistory>,
    @InjectRepository(UnifiedMarketSnapshotHistory)
    private readonly snapshotHistory: Repository<UnifiedMarketSnapshotHistory>,
  ) {}

  // ── Window helpers ──────────────────────────────────────────────────

  /** Build a bounded window. Caps to MAX_WINDOW_DAYS. */
  buildWindow(end: Date, daysBack: number): HistoryWindow {
    const capped = Math.min(daysBack, MAX_WINDOW_DAYS);
    const start = new Date(end);
    start.setDate(start.getDate() - capped);
    start.setHours(9, 0, 0, 0); // market open
    return { start, end };
  }

  /** Build a window for a specific IST trading session date (YYYY-MM-DD). */
  buildSessionWindow(sessionDate: string): HistoryWindow {
    const start = new Date(sessionDate + 'T09:15:00+05:30');
    const end = new Date(sessionDate + 'TT15:30:00+05:30');
    return { start, end };
  }

  /** Build a multi-session window (from N sessions back to now). */
  buildMultiSessionWindow(endingDate: Date, sessionCount: number): HistoryWindow {
    const capped = Math.min(sessionCount, MAX_WINDOW_DAYS);
    const start = new Date(endingDate);
    start.setDate(start.getDate() - capped);
    start.setHours(9, 15, 0, 0);
    const end = new Date(endingDate);
    end.setHours(15, 30, 0, 0);
    return { start, end };
  }

  private clampLimit(n?: number): number {
    if (!n || n <= 0) return DEFAULT_LIMIT;
    return Math.min(n, MAX_LIMIT);
  }

  // ── Quote history queries ───────────────────────────────────────────

  /** Query historical option quotes within a bounded window. */
  async getQuoteWindow(
    window: HistoryWindow,
    options: QuoteQueryOptions = {},
  ): Promise<UnifiedOptionQuoteHistory[]> {
    const where: FindOptionsWhere<UnifiedOptionQuoteHistory> = {
      receivedTimestamp: Between(window.start, window.end),
    };
    if (options.underlying) where.underlying = options.underlying;
    if (options.instrumentKey) where.instrumentKey = options.instrumentKey;
    if (options.optionType) where.optionType = options.optionType;
    if (options.expiry) where.expiry = options.expiry;
    if (options.strike !== undefined) where.strike = options.strike;

    return this.quoteHistory.find({
      where,
      order: { receivedTimestamp: options.order ?? 'DESC' },
      take: this.clampLimit(options.limit),
    });
  }

  /** Get the latest historical quote for a given instrument. */
  async getLatestQuote(instrumentKey: string): Promise<UnifiedOptionQuoteHistory | null> {
    return this.quoteHistory.findOne({
      where: { instrumentKey },
      order: { receivedTimestamp: 'DESC' },
    });
  }

  /** Get all distinct underlying values in the history. */
  async getUnderlyings(): Promise<string[]> {
    const rows = await this.quoteHistory
      .createQueryBuilder('q')
      .select('DISTINCT q.underlying', 'underlying')
      .getRawMany();
    return rows.map((r: any) => r.underlying).filter(Boolean);
  }

  /** Get distinct instrument keys for a given underlying in a window. */
  async getInstrumentKeys(
    window: HistoryWindow,
    underlying: string,
  ): Promise<string[]> {
    const rows = await this.quoteHistory
      .createQueryBuilder('q')
      .select('DISTINCT q.instrumentKey', 'instrumentKey')
      .where('q.receivedTimestamp BETWEEN :start AND :end', window)
      .andWhere('q.underlying = :underlying', { underlying })
      .getRawMany();
    return rows.map((r: any) => r.instrumentKey).filter(Boolean);
  }

  // ── Snapshot history queries ────────────────────────────────────────

  /** Query historical market snapshots within a bounded window. */
  async getSnapshotWindow(
    window: HistoryWindow,
    options: SnapshotQueryOptions = {},
  ): Promise<UnifiedMarketSnapshotHistory[]> {
    const where: FindOptionsWhere<UnifiedMarketSnapshotHistory> = {
      receivedTimestamp: Between(window.start, window.end),
    };
    if (options.symbol) where.symbol = options.symbol;
    if (options.underlying) where.underlying = options.underlying;

    return this.snapshotHistory.find({
      where,
      order: { receivedTimestamp: options.order ?? 'DESC' },
      take: this.clampLimit(options.limit),
    });
  }

  /** Get the latest historical snapshot for a given symbol. */
  async getLatestSnapshot(symbol: string): Promise<UnifiedMarketSnapshotHistory | null> {
    return this.snapshotHistory.findOne({
      where: { symbol },
      order: { receivedTimestamp: 'DESC' },
    });
  }

  /** Get all distinct symbols in snapshot history. */
  async getSnapshotSymbols(): Promise<string[]> {
    const rows = await this.snapshotHistory
      .createQueryBuilder('s')
      .select('DISTINCT s.symbol', 'symbol')
      .getRawMany();
    return rows.map((r: any) => r.symbol).filter(Boolean);
  }

  // ── Aggregated queries ──────────────────────────────────────────────

  /** Compute aggregated stats per instrument across a window. */
  async getQuoteAggregates(
    window: HistoryWindow,
    underlying: string,
  ): Promise<AggregatedQuoteStats[]> {
    const rows = await this.quoteHistory
      .createQueryBuilder('q')
      .select([
        'q.instrumentKey AS instrumentKey',
        'q.underlying AS underlying',
        'q.expiry AS expiry',
        'COUNT(*) AS sampleCount',
        'AVG(q.ltp) AS avgLtp',
        'MIN(q.ltp) AS minLtp',
        'MAX(q.ltp) AS maxLtp',
        'AVG(CASE WHEN q.bid IS NOT NULL AND q.ask IS NOT NULL THEN (q.ask - q.bid) ELSE NULL END) AS avgSpread',
        'AVG(q.volume) AS avgVolume',
        'MIN(q.receivedTimestamp) AS firstTimestamp',
        'MAX(q.receivedTimestamp) AS lastTimestamp',
      ])
      .where('q.receivedTimestamp BETWEEN :start AND :end', window)
      .andWhere('q.underlying = :underlying', { underlying })
      .groupBy('q.instrumentKey')
      .addGroupBy('q.underlying')
      .addGroupBy('q.expiry')
      .having('COUNT(*) >= 3') // minimum 3 data points
      .orderBy('sampleCount', 'DESC')
      .limit(this.clampLimit(200))
      .getRawMany();

    return rows.map((r: any) => ({
      instrumentKey: r.instrumentKey,
      underlying: r.underlying,
      expiry: r.expiry,
      sampleCount: Number(r.sampleCount),
      avgLtp: r.avgLtp !== null ? Number(r.avgLtp) : null,
      minLtp: r.minLtp !== null ? Number(r.minLtp) : null,
      maxLtp: r.maxLtp !== null ? Number(r.maxLtp) : null,
      avgSpread: r.avgSpread !== null ? Number(r.avgSpread) : null,
      avgVolume: r.avgVolume !== null ? Number(r.avgVolume) : null,
      firstTimestamp: r.firstTimestamp,
      lastTimestamp: r.lastTimestamp,
    }));
  }

  /** Compute aggregated stats per symbol across a window. */
  async getSnapshotAggregates(
    window: HistoryWindow,
    symbol?: string,
  ): Promise<AggregatedSnapshotStats[]> {
    const qb = this.snapshotHistory
      .createQueryBuilder('s')
      .select([
        's.symbol AS symbol',
        'COUNT(*) AS sampleCount',
        'AVG(s.ltp) AS avgLtp',
        'MIN(s.ltp) AS minLtp',
        'MAX(s.ltp) AS maxLtp',
        'AVG(s.volume) AS avgVolume',
        'MIN(s.receivedTimestamp) AS firstTimestamp',
        'MAX(s.receivedTimestamp) AS lastTimestamp',
      ])
      .where('s.receivedTimestamp BETWEEN :start AND :end', window);

    if (symbol) {
      qb.andWhere('s.symbol = :symbol', { symbol });
    }

    const rows = await qb
      .groupBy('s.symbol')
      .having('COUNT(*) >= 3')
      .orderBy('sampleCount', 'DESC')
      .limit(this.clampLimit(50))
      .getRawMany();

    return rows.map((r: any) => ({
      symbol: r.symbol,
      sampleCount: Number(r.sampleCount),
      avgLtp: r.avgLtp !== null ? Number(r.avgLtp) : null,
      minLtp: r.minLtp !== null ? Number(r.minLtp) : null,
      maxLtp: r.maxLtp !== null ? Number(r.maxLtp) : null,
      avgVolume: r.avgVolume !== null ? Number(r.avgVolume) : null,
      firstTimestamp: r.firstTimestamp,
      lastTimestamp: r.lastTimestamp,
    }));
  }

  /** Count rows in a window (for data availability checks). */
  async countQuotes(window: HistoryWindow, underlying?: string): Promise<number> {
    const where: FindOptionsWhere<UnifiedOptionQuoteHistory> = {
      receivedTimestamp: Between(window.start, window.end),
    };
    if (underlying) where.underlying = underlying;
    return this.quoteHistory.count({ where });
  }

  async countSnapshots(window: HistoryWindow, symbol?: string): Promise<number> {
    const where: FindOptionsWhere<UnifiedMarketSnapshotHistory> = {
      receivedTimestamp: Between(window.start, window.end),
    };
    if (symbol) where.symbol = symbol;
    return this.snapshotHistory.count({ where });
  }
}
