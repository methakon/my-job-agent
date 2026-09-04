import { Entity, PrimaryGeneratedColumn, Column, Index, CreateDateColumn } from 'typeorm';

/** Historical price snapshots archived after each session close.
 *  Schema mirrors fnf_market_snapshots; rows move here at session end so the
 *  live table only ever holds the current session's ticks. */
@Entity('fnf_market_snapshots_history')
@Index(['instrument', 'ts'])
export class FnfMarketSnapshotHistory {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 64 })
  instrument: string;

  @Column({ type: 'decimal', precision: 14, scale: 4 })
  price: number;

  @Column({ type: 'decimal', precision: 14, scale: 2, default: 0 })
  volume: number;

  @Column({ type: 'decimal', precision: 14, scale: 4, nullable: true })
  open: number;

  @Column({ type: 'decimal', precision: 14, scale: 4, nullable: true })
  high: number;

  @Column({ type: 'decimal', precision: 14, scale: 4, nullable: true })
  low: number;

  @Column({ type: 'decimal', precision: 14, scale: 4, nullable: true })
  close: number;

  /** Timestamp of this snapshot (IST). */
  @Column({ type: 'datetime' })
  ts: Date;

  @Column({ type: 'varchar', length: 16, nullable: true })
  source?: string | null;

  /** When the row was archived (session rollover time, IST). */
  @Column({ type: 'datetime' })
  archivedAt: Date;

  @CreateDateColumn()
  createdAt: Date;
}
