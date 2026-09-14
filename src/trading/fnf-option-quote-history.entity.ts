import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/** Historical option premium quotes archived after each session close.
 *  Schema mirrors fnf_option_quotes; rows move here at session end so the
 *  live table only ever holds the current session's ticks. */
@Entity('fnf_option_quotes_history')
@Index('idx_fnf_optq_hist_contract_ts', ['contractSymbol', 'ts'])
@Index('idx_fnf_optq_hist_chain_ts', ['underlying', 'expiry', 'optionType', 'ts'])
export class FnfOptionQuoteHistory {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 96 })
  contractSymbol: string;

  @Column({ type: 'varchar', length: 32 })
  underlying: string;

  @Column({ type: 'date' })
  expiry: string;

  @Column({ type: 'decimal', precision: 14, scale: 4 })
  strike: number;

  @Column({ type: 'varchar', length: 2 })
  optionType: string;

  @Column({ type: 'decimal', precision: 14, scale: 4 })
  ltp: number;

  @Column({ type: 'decimal', precision: 14, scale: 4, nullable: true })
  bid: number;

  @Column({ type: 'decimal', precision: 14, scale: 4, nullable: true })
  ask: number;

  /**
   * NULL when the provider published none. This table is an INSERT..SELECT copy
   * of fnf_option_quotes, so a fabricated 0 upstream (NOT NULL DEFAULT 0) is
   * what produced this archive's 3.9M-row all-zero OI column — relaxing only the
   * source table would leave that unfixable.
   */
  @Column({ type: 'decimal', precision: 18, scale: 2, nullable: true })
  volume: number | null;

  @Column({ type: 'decimal', precision: 18, scale: 2, nullable: true })
  openInterest: number | null;

  @Column({ type: 'decimal', precision: 10, scale: 4, nullable: true })
  impliedVolatility: number;

  @Column({ type: 'decimal', precision: 10, scale: 6, nullable: true })
  delta: number;

  @Column({ type: 'decimal', precision: 10, scale: 6, nullable: true })
  gamma: number;

  @Column({ type: 'decimal', precision: 10, scale: 6, nullable: true })
  theta: number;

  @Column({ type: 'decimal', precision: 10, scale: 6, nullable: true })
  vega: number;

  @Column({ type: 'varchar', length: 24 })
  provider: string;

  @Column({ type: 'datetime' })
  ts: Date;

  /** When the row was archived (session rollover time, IST). */
  @Column({ type: 'datetime' })
  archivedAt: Date;

  @CreateDateColumn()
  createdAt: Date;
}
