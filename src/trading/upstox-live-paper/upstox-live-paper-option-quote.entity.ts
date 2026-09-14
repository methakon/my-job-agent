import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

/**
 * LIVE Upstox option-quote snapshot (one per contract per timestamp).
 *
 * Rich enough for OI buildup/unwinding, PCR, IV changes, Greeks, volume,
 * bid/ask spread, support/resistance, signal quality, entry/exit quality.
 *
 * Isolation: PAPER-adjacent market data, dataSource=UPSTOX, executionMode=PAPER.
 * Separate table from FYERS fnf_option_quotes.
 */
@Entity('upstox_live_paper_option_quotes')
@Index('idx_ulpoq_contract_ts', ['contractSymbol', 'ts'])
@Index('idx_ulpoq_chain_ts', ['underlying', 'expiry', 'optionType', 'ts'])
@Index('idx_ulpoq_broker_ts', ['dataSource', 'ts'])
export class UpstoxLivePaperOptionQuote {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Contract symbol, e.g. NIFTY26DEC23500CE. */
  @Column({ name: 'contractSymbol', length: 96 })
  contractSymbol: string;

  @Column({ length: 32 })
  underlying: string;

  @Column({ type: 'date' })
  expiry: string;

  @Column({ type: 'decimal', precision: 14, scale: 4 })
  strike: number;

  @Column({ length: 2 })
  optionType: 'CE' | 'PE';

  /** LTP / last traded price. */
  @Column({ type: 'decimal', precision: 14, scale: 4 })
  ltp: number;

  @Column({ type: 'decimal', precision: 14, scale: 4, nullable: true })
  bid: number | null;

  @Column({ type: 'decimal', precision: 14, scale: 4, nullable: true })
  ask: number | null;

  /** Best bid quantity. */
  @Column({ name: 'bidQty', type: 'int', nullable: true })
  bidQty: number | null;

  /** Best ask quantity. */
  @Column({ name: 'askQty', type: 'int', nullable: true })
  askQty: number | null;

  /**
   * Volume (contracts/lots traded). NULL when the provider published none —
   * deliberately nullable so absence is never recorded as a real 0.
   */
  @Column({ type: 'bigint', nullable: true })
  volume: number | null;

  /** Open interest. NULL when the provider published none (never a fabricated 0). */
  @Column({ type: 'bigint', nullable: true })
  openInterest: number | null;

  /**
   * Change in OI: `openInterest - prevOi`, computed by the capture path from the
   * PROVIDER's own previous-OI reference.
   *
   * SEMANTICS — established from captured EVIDENCE, not assumed: this is a
   * PROVIDER-REFERENCE change, NOT a snapshot-to-snapshot delta. Over 5,179 rows
   * of one contract spanning 27h, `openInterest - oiChange` (i.e. `prevOi`) took
   * exactly TWO distinct values while `openInterest` took 92; a per-snapshot
   * delta would have made the two counts equal. Do not consume it as a
   * tick-to-tick ΔOI — pair it only with a matching (provider-reference)
   * interval. See trading/research/capture-integrity.ts (DELTA_OI_SEMANTICS),
   * which also records what is still UNKNOWN about the provider's rollover rule.
   *
   * NULL when either the current or the provider's previous OI was unknown —
   * "we do not know the change" is not the same as "nothing changed".
   */
  @Column({ name: 'oiChange', type: 'bigint', nullable: true })
  oiChange: number | null;

  /** Implied volatility (annualized, fraction). */
  @Column({ name: 'impliedVolatility', type: 'decimal', precision: 10, scale: 6, nullable: true })
  impliedVolatility: number | null;

  /** Local BSM Greeks computed from live premium + spot. */
  @Column({ type: 'decimal', precision: 10, scale: 6, nullable: true })
  delta: number | null;

  @Column({ type: 'decimal', precision: 10, scale: 6, nullable: true })
  gamma: number | null;

  @Column({ type: 'decimal', precision: 10, scale: 6, nullable: true })
  theta: number | null;

  @Column({ type: 'decimal', precision: 10, scale: 6, nullable: true })
  vega: number | null;

  /** Underlying/index spot price used for Greek computation. */
  @Column({ name: 'underlyingPrice', type: 'decimal', precision: 14, scale: 4, nullable: true })
  underlyingPrice: number | null;

  /** Market depth: total bid/ask quantity in the top N levels when available. */
  @Column({ name: 'bidDepth', type: 'bigint', nullable: true })
  bidDepth: number | null;

  @Column({ name: 'askDepth', type: 'bigint', nullable: true })
  askDepth: number | null;

  /**
   * CAPTURE time — when this process read and persisted the row. This is NOT
   * market/quote time and must never be relabelled as such: the poller runs 24x7
   * with no session gate and after the bell the provider keeps serving its frozen
   * close value, so a post-close row carries a fresh `ts` over stale market data.
   * Use `providerTs` for the market's own time.
   */
  @Column({ type: 'datetime' })
  ts: Date;

  /**
   * The PROVIDER's own quote/feed timestamp, when it publishes one. Kept separate
   * so market time and capture time can never be conflated. NULL when the
   * provider published none — never a copy of `ts`, which would relabel capture
   * time as market time (the defect this column exists to prevent).
   */
  @Column({ name: 'providerTs', type: 'datetime', nullable: true })
  providerTs: Date | null;

  /**
   * The provider's own previous-OI reference, persisted so `oiChange` above is
   * verifiable per row instead of inferred. NULL when the provider published
   * none. See the `oiChange` semantics note.
   */
  @Column({ name: 'prevOi', type: 'bigint', nullable: true })
  prevOi: number | null;

  /**
   * sha256 of the raw provider leg, so a byte-identical REPEAT of the previous
   * observation is detectable rather than indistinguishable from a genuine new
   * print. NULL when it could not be computed.
   */
  @Column({ name: 'payloadHash', type: 'varchar', length: 64, nullable: true })
  payloadHash: string | null;

  // ---- isolation / provenance ----
  @Column({ length: 16, default: 'UPSTOX' })
  dataSource: string;

  @Column({ length: 16, default: 'PAPER' })
  executionMode: string;

  /** Upstox instrument token / reference for reconciliation. */
  @Column({ type: 'varchar',  length: 64, nullable: true })
  instrumentToken: string | null;

  @CreateDateColumn()
  createdAt: Date;
}
