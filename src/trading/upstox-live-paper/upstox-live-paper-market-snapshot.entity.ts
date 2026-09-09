import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

/**
 * LIVE Upstox underlying/market snapshot (index or equity level).
 *
 * Captures LTP, bid/ask, volume, OHLC, and timestamp for the underlying so the
 * option-chain analysis can always tie option quotes to the prevailing spot.
 *
 * Isolation: dataSource=UPSTOX, executionMode=PAPER. Separate from FYERS snapshots.
 */
@Entity('upstox_live_paper_market_snapshots')
@Index('idx_ulpms_instrument_ts', ['instrument', 'ts'])
@Index('idx_ulpms_broker_ts', ['dataSource', 'ts'])
export class UpstoxLivePaperMarketSnapshot {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Instrument, e.g. NSE:NIFTY50-INDEX or NSE:NIFTYBANK-INDEX. */
  @Column({ length: 64 })
  instrument: string;

  /** Last traded price (points for index, price for equity). */
  @Column({ type: 'decimal', precision: 14, scale: 4 })
  price: number;

  @Column({ type: 'decimal', precision: 14, scale: 4, nullable: true })
  bid: number | null;

  @Column({ type: 'decimal', precision: 14, scale: 4, nullable: true })
  ask: number | null;

  /** Volume (lots for index proxy, shares for equity). */
  @Column({ type: 'bigint', default: 0 })
  volume: number;

  @Column({ type: 'decimal', precision: 14, scale: 4, nullable: true })
  open: number | null;

  @Column({ type: 'decimal', precision: 14, scale: 4, nullable: true })
  high: number | null;

  @Column({ type: 'decimal', precision: 14, scale: 4, nullable: true })
  low: number | null;

  @Column({ type: 'decimal', precision: 14, scale: 4, nullable: true })
  close: number | null;

  /** Timestamp of the snapshot (market time). */
  @Column({ type: 'datetime' })
  ts: Date;

  // ---- isolation / provenance ----
  @Column({ length: 16, default: 'UPSTOX' })
  dataSource: string;

  @Column({ length: 16, default: 'PAPER' })
  executionMode: string;

  /** Upstox instrument token / reference. */
  @Column({ type: 'varchar',  length: 64, nullable: true })
  upstoxRef: string | null;

  @CreateDateColumn()
  createdAt: Date;
}
