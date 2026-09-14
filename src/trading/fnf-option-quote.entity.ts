import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/** Provider quote for one explicit option contract; this is market data only. */
@Entity('fnf_option_quotes')
@Index('idx_fnf_option_quotes_contract_ts', ['contractSymbol', 'ts'])
@Index('idx_fnf_option_quotes_chain_ts', ['underlying', 'expiry', 'optionType', 'ts'])
export class FnfOptionQuote {
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

  /** NULL when the provider published none — absence must never become a real 0. */
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

  @CreateDateColumn()
  createdAt: Date;
}
