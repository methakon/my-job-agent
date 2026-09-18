import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Historical copy of unified_market_snapshots.
 *
 * Identical schema to UnifiedMarketSnapshot plus an `archivedAt` timestamp.
 */
@Entity('unified_market_snapshots_history')
@Index('idx_ums_history_symbol_ts', ['symbol', 'ts'])
@Index('idx_ums_history_received', ['receivedTimestamp'])
@Index('idx_ums_history_archived', ['archivedAt'])
export class UnifiedMarketSnapshotHistory {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 96 })
  symbol: string;

  @Column({ type: 'varchar', length: 32, nullable: true })
  underlying: string | null;

  @Column({ type: 'varchar', length: 16, nullable: true })
  exchange: string | null;

  @Column({ type: 'decimal', precision: 14, scale: 4, nullable: true })
  ltp: number | null;

  @Column({ type: 'decimal', precision: 18, scale: 2, nullable: true })
  volume: number | null;

  @Column({ type: 'decimal', precision: 14, scale: 4, nullable: true })
  bid: number | null;

  @Column({ type: 'decimal', precision: 14, scale: 4, nullable: true })
  ask: number | null;

  @Column({ type: 'int', nullable: true })
  bidQty: number | null;

  @Column({ type: 'int', nullable: true })
  askQty: number | null;

  @Column({ type: 'decimal', precision: 14, scale: 4, nullable: true })
  open: number | null;

  @Column({ type: 'decimal', precision: 14, scale: 4, nullable: true })
  high: number | null;

  @Column({ type: 'decimal', precision: 14, scale: 4, nullable: true })
  low: number | null;

  @Column({ type: 'decimal', precision: 14, scale: 4, nullable: true })
  close: number | null;

  @Column({ type: 'json', nullable: true })
  depth: unknown;

  @Column({ type: 'varchar', length: 24 })
  source: string;

  @Column({ type: 'datetime', nullable: true })
  sourceTimestamp: Date | null;

  @Column({ type: 'datetime' })
  receivedTimestamp: Date;

  @Column({ type: 'int', nullable: true })
  sequenceNumber: number | null;

  @Column({ type: 'varchar', length: 12, default: 'GOOD' })
  dataQuality: string;

  @Column({ type: 'datetime' })
  ts: Date;

  @CreateDateColumn()
  createdAt: Date;

  @Column({ type: 'datetime' })
  archivedAt: Date;
}
