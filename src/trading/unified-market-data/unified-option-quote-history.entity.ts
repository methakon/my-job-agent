import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Historical copy of unified_option_quotes.
 *
 * Identical schema to UnifiedOptionQuote plus an `archivedAt` timestamp
 * recording when the row was moved from the live table.  Created by
 * UnifiedArchiveService.archiveTicksBefore(); the live table is the
 * canonical write target for the market-data pipeline.
 */
@Entity('unified_option_quotes_history')
@Index('idx_uoq_history_key_ts', ['instrumentKey', 'ts'])
@Index('idx_uoq_history_chain', ['underlying', 'expiry', 'strike'])
@Index('idx_uoq_history_received', ['receivedTimestamp'])
@Index('idx_uoq_history_archived', ['archivedAt'])
export class UnifiedOptionQuoteHistory {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 96 })
  instrumentKey: string;

  @Column({ type: 'varchar', length: 32, nullable: true })
  underlying: string | null;

  @Column({ type: 'varchar', length: 16, nullable: true })
  exchange: string | null;

  @Column({ type: 'varchar', length: 24, nullable: true })
  segment: string | null;

  @Column({ type: 'varchar', length: 24, nullable: true })
  instrumentType: string | null;

  @Column({ type: 'date', nullable: true })
  expiry: string | null;

  @Column({ type: 'decimal', precision: 14, scale: 4, nullable: true })
  strike: number | null;

  @Column({ type: 'varchar', length: 2, nullable: true })
  optionType: string | null;

  @Column({ type: 'decimal', precision: 14, scale: 4, nullable: true })
  ltp: number | null;

  @Column({ type: 'decimal', precision: 14, scale: 4, nullable: true })
  bid: number | null;

  @Column({ type: 'decimal', precision: 14, scale: 4, nullable: true })
  ask: number | null;

  @Column({ type: 'int', nullable: true })
  bidQty: number | null;

  @Column({ type: 'int', nullable: true })
  askQty: number | null;

  @Column({ type: 'decimal', precision: 18, scale: 2, nullable: true })
  volume: number | null;

  @Column({ type: 'decimal', precision: 18, scale: 2, nullable: true })
  oi: number | null;

  @Column({ type: 'decimal', precision: 18, scale: 2, nullable: true })
  previousOi: number | null;

  @Column({ type: 'decimal', precision: 18, scale: 2, nullable: true })
  changeOi: number | null;

  @Column({ type: 'decimal', precision: 10, scale: 4, nullable: true })
  iv: number | null;

  @Column({ type: 'decimal', precision: 10, scale: 6, nullable: true })
  delta: number | null;

  @Column({ type: 'decimal', precision: 10, scale: 6, nullable: true })
  gamma: number | null;

  @Column({ type: 'decimal', precision: 10, scale: 6, nullable: true })
  theta: number | null;

  @Column({ type: 'decimal', precision: 10, scale: 6, nullable: true })
  vega: number | null;

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

  /** When this row was archived from the live table. */
  @Column({ type: 'datetime' })
  archivedAt: Date;
}
