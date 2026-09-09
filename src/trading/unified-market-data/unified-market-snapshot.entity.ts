import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Common normalized underlying/index market snapshot (brief s5/s7).
 *
 * Index-level ticks (NIFTY / BANKNIFTY / SENSEX spot) from any live source.
 * Shares the provenance fields of UnifiedOptionQuote so every observation
 * preserves source, source/receive timestamps, sequence and data quality.
 */
@Entity('unified_market_snapshots')
@Index('idx_unified_market_snapshots_symbol_ts', ['symbol', 'ts'])
export class UnifiedMarketSnapshot {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Source instrument key, e.g. NSE:NIFTY50-INDEX. */
  @Column({ type: 'varchar', length: 96 })
  symbol: string;

  @Column({ type: 'varchar', length: 32, nullable: true })
  underlying: string | null;

  @Column({ type: 'varchar', length: 16, nullable: true })
  exchange: string | null;

  @Column({ type: 'decimal', precision: 14, scale: 4, nullable: true })
  ltp: number | null;

  @Column({ type: 'decimal', precision: 18, scale: 2, default: 0 })
  volume: number;

  @Column({ type: 'decimal', precision: 14, scale: 4, nullable: true })
  open: number | null;

  @Column({ type: 'decimal', precision: 14, scale: 4, nullable: true })
  high: number | null;

  @Column({ type: 'decimal', precision: 14, scale: 4, nullable: true })
  low: number | null;

  @Column({ type: 'decimal', precision: 14, scale: 4, nullable: true })
  close: number | null;

  /** Source identity: FYERS_LIVE | UPSTOX_LIVE | … */
  @Column({ type: 'varchar', length: 24 })
  source: string;

  @Column({ type: 'datetime', nullable: true })
  sourceTimestamp: Date | null;

  @Column({ type: 'datetime' })
  receivedTimestamp: Date;

  @Column({ type: 'int', nullable: true })
  sequenceNumber: number | null;

  /** GOOD | STALE | INVALID | RECOVERING. */
  @Column({ type: 'varchar', length: 12, default: 'GOOD' })
  dataQuality: string;

  @Column({ type: 'datetime' })
  ts: Date;

  @CreateDateColumn()
  createdAt: Date;
}
