import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Common normalized option-quote observation (brief s5/s7).
 *
 * ONE store for every live source (FYERS_LIVE, UPSTOX_LIVE, …). Broker/source
 * identity is preserved in `source`, `sourceTimestamp`, `sequenceNumber` and
 * `dataQuality` — never overwritten. This is market data only; no order or
 * accounting field lives here. Both trading engines (FnF, Upstox paper) read
 * from this single store / its in-memory latest cache.
 */
@Entity('unified_option_quotes')
@Index('idx_unified_option_quotes_key_ts', ['instrumentKey', 'ts'])
@Index('idx_unified_option_quotes_chain', ['underlying', 'expiry', 'strike'])
export class UnifiedOptionQuote {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Broker/exchange instrument key, e.g. NSE:NIFTY26SEP25600CE or an Upstox instrument key. */
  @Column({ type: 'varchar', length: 96 })
  instrumentKey: string;

  /** Underlying name, e.g. NIFTY / BANKNIFTY / SENSEX. */
  @Column({ type: 'varchar', length: 32, nullable: true })
  underlying: string | null;

  @Column({ type: 'varchar', length: 16, nullable: true })
  exchange: string | null;

  /** Segment, e.g. FO / INDEX / EQUITY. */
  @Column({ type: 'varchar', length: 24, nullable: true })
  segment: string | null;

  /** Instrument type: OPTION / INDEX / EQUITY / FUT. */
  @Column({ type: 'varchar', length: 24, nullable: true })
  instrumentType: string | null;

  @Column({ type: 'date', nullable: true })
  expiry: string | null;

  @Column({ type: 'decimal', precision: 14, scale: 4, nullable: true })
  strike: number | null;

  /** CE | PE (options only). */
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

  @Column({ type: 'decimal', precision: 18, scale: 2, default: 0 })
  volume: number;

  @Column({ type: 'decimal', precision: 18, scale: 2, default: 0 })
  oi: number;

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

  /** Optional market-depth snapshot (JSON). */
  @Column({ type: 'json', nullable: true })
  depth: unknown;

  /** Source identity: FYERS_LIVE | UPSTOX_LIVE | … — never hidden/overwritten. */
  @Column({ type: 'varchar', length: 24 })
  source: string;

  /** Broker feed timestamp (when the source published the observation). */
  @Column({ type: 'datetime', nullable: true })
  sourceTimestamp: Date | null;

  /** Application receive timestamp (when the pipeline saw the observation). */
  @Column({ type: 'datetime' })
  receivedTimestamp: Date;

  /** Monotonic per-source sequence assigned by the pipeline. */
  @Column({ type: 'int', nullable: true })
  sequenceNumber: number | null;

  /** GOOD | STALE | INVALID | RECOVERING (data-quality gate, brief s8). */
  @Column({ type: 'varchar', length: 12, default: 'GOOD' })
  dataQuality: string;

  /** Observation time: sourceTimestamp when present, else receivedTimestamp. */
  @Column({ type: 'datetime' })
  ts: Date;

  @CreateDateColumn()
  createdAt: Date;
}
