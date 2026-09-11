import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * GATE 2 — point-in-time pre-open / auction observation.
 *
 * APPEND-ONLY. One row per (instrument, session date, phase, source event time,
 * source). A repeated source tick collapses onto its dedupe key instead of
 * creating a second row, and an out-of-order arrival is stored with the event
 * time it actually carries — history is never rewritten and a later observation
 * is never used to back-fill an earlier one (item 4: no look-ahead).
 *
 * What this row can answer: "what did the agent actually know at 09:00 / 09:05 /
 * 09:08 / 09:14?" — every value carries its own source event time, receive time,
 * provenance and per-field quality. Missing values stay NULL, never 0/guess.
 *
 * This is market INTELLIGENCE storage: no order, account, position or capital
 * field appears here, so it can never mix trading-account state (item 18).
 */
@Entity('pre_open_observations')
@Index('idx_pre_open_obs_instrument_event', ['instrumentKey', 'eventTime'])
@Index('idx_pre_open_obs_session', ['sessionDate', 'sessionPhase'])
@Index('idx_pre_open_obs_dedupe', ['dedupeKey'], { unique: true })
export class PreOpenObservation {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Broker/exchange instrument key, e.g. BSE_INDEX|SENSEX. */
  @Column({ type: 'varchar', length: 96 })
  instrumentKey: string;

  @Column({ type: 'varchar', length: 64, nullable: true })
  symbol: string | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  underlying: string | null;

  @Column({ type: 'varchar', length: 16, nullable: true })
  exchange: string | null;

  /** 'YYYY-MM-DD' IST session date the observation belongs to. */
  @Column({ type: 'varchar', length: 10 })
  sessionDate: string;

  /** PRE_OPEN | OPEN_AUCTION | MARKET_OPEN | POST_OPEN | CLOSED | UNKNOWN. */
  @Column({ type: 'varchar', length: 16 })
  sessionPhase: string;

  /** The exchange's own published status at capture time (provenance only). */
  @Column({ type: 'varchar', length: 24, nullable: true })
  sourceStatus: string | null;

  /** Source event time (broker timestamp). NULL when the source omitted/broke it. */
  @Column({ type: 'datetime', nullable: true })
  eventTime: Date | null;

  /** Receive time stamped by us. Always present. */
  @Column({ type: 'datetime' })
  receivedAt: Date;

  /** previousClose - eventTime, in ms (freshness at capture). NULL when unknown. */
  @Column({ type: 'int', nullable: true })
  dataAgeMs: number | null;

  @Column({ type: 'decimal', precision: 14, scale: 4, nullable: true })
  previousClose: number | null;

  /** SOURCE | STORE_PRIOR_SESSION — how previousClose was obtained. */
  @Column({ type: 'varchar', length: 24, nullable: true })
  previousCloseSource: string | null;

  @Column({ type: 'decimal', precision: 14, scale: 4, nullable: true })
  referencePrice: number | null;

  /** Indicative equilibrium price (IEP) — NULL when not published. */
  @Column({ type: 'decimal', precision: 14, scale: 4, nullable: true })
  indicativePrice: number | null;

  @Column({ type: 'decimal', precision: 18, scale: 2, nullable: true })
  indicativeQuantity: number | null;

  @Column({ type: 'decimal', precision: 18, scale: 2, nullable: true })
  imbalanceTotal: number | null;

  @Column({ type: 'decimal', precision: 18, scale: 2, nullable: true })
  imbalanceMarket: number | null;

  @Column({ type: 'decimal', precision: 18, scale: 2, nullable: true })
  buyQuantity: number | null;

  @Column({ type: 'decimal', precision: 18, scale: 2, nullable: true })
  sellQuantity: number | null;

  @Column({ type: 'decimal', precision: 14, scale: 4, nullable: true })
  lastPrice: number | null;

  @Column({ type: 'decimal', precision: 18, scale: 2, nullable: true })
  volume: number | null;

  @Column({ type: 'decimal', precision: 14, scale: 4, nullable: true })
  bestBid: number | null;

  @Column({ type: 'decimal', precision: 18, scale: 2, nullable: true })
  bestBidQty: number | null;

  @Column({ type: 'decimal', precision: 14, scale: 4, nullable: true })
  bestAsk: number | null;

  @Column({ type: 'decimal', precision: 18, scale: 2, nullable: true })
  bestAskQty: number | null;

  /** Source identity: UPSTOX_V3_LIVE | … (never relabelled). */
  @Column({ type: 'varchar', length: 24 })
  source: string;

  /** COMPLETE | PARTIAL | UNAVAILABLE | STALE | INVALID. */
  @Column({ type: 'varchar', length: 16 })
  quality: string;

  /** Per-field quality map — data quality tracked separately from values. */
  @Column({ type: 'json', nullable: true })
  fieldQuality: Record<string, string> | null;

  /** Deterministic idempotency key — see preOpenDedupeKey(). */
  @Column({ type: 'varchar', length: 190 })
  dedupeKey: string;

  /** The source's own payload for audit (bounded, sensitive fields stripped). */
  @Column({ type: 'json', nullable: true })
  rawPayload: Record<string, unknown> | null;

  /**
   * Formula/algorithm version used when this observation is turned into features.
   * The ORM needs a literal here (it becomes the DDL default); the RUNTIME value always
   * comes from PRE_OPEN_FEATURES_VERSION in pre-open-features.ts, and the pre-open test
   * asserts this literal agrees with that constant so a future bump cannot drift.
   */
  @Column({ type: 'varchar', length: 16, default: 'po-v2' })
  featuresVersion: string;

  @CreateDateColumn()
  createdAt: Date;
}
