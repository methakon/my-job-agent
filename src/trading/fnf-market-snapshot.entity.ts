import { Entity, PrimaryGeneratedColumn, Column, Index, CreateDateColumn } from 'typeorm';

/** One price snapshot for an instrument. Used for value-change tracking,
 *  charts, and algorithm input. Indexed on instrument + ts. */
@Entity('fnf_market_snapshots')
@Index(['instrument', 'ts'])
export class FnfMarketSnapshot {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** NSE:NIFTY50, NSE:SENSEX, NSE:RELIANCE, etc. */
  @Column({ type: 'varchar', length: 64 })
  instrument: string;

  /** Last traded price (INR, or points for indices). */
  @Column({ type: 'decimal', precision: 14, scale: 4 })
  price: number;

  /** Volume (lots for indices, shares for equities). */
  @Column({ type: 'decimal', precision: 14, scale: 2, default: 0 })
  volume: number;

  /** OHLC open (same resolution as price). */
  @Column({ type: 'decimal', precision: 14, scale: 4, nullable: true })
  open: number;

  /** High. */
  @Column({ type: 'decimal', precision: 14, scale: 4, nullable: true })
  high: number;

  /** Low. */
  @Column({ type: 'decimal', precision: 14, scale: 4, nullable: true })
  low: number;

  /** Close (same timestamp's close, if available). */
  @Column({ type: 'decimal', precision: 14, scale: 4, nullable: true })
  close: number;

  /** Timestamp of this snapshot (IST). */
  @Column({ type: 'datetime' })
  ts: Date;

  @CreateDateColumn()
  createdAt: Date;
}
