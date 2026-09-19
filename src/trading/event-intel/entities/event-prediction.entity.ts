import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  Index,
  CreateDateColumn,
} from 'typeorm';

/**
 * Immutable prediction record. One row per (event, version, featureHash).
 * Created at each decision point; never updated.
 */
@Entity('event_intel_prediction')
@Index('idx_prediction_event_id', ['eventId'])
@Index('idx_prediction_event_ver', ['eventId', 'versionNumber'], { unique: true })
export class EventIntelPrediction {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** FK → event_intel_event.id */
  @Column({ type: 'uuid' })
  eventId!: string;

  /** Event version this prediction is based on. */
  @Column({ type: 'int' })
  versionNumber!: number;

  /** Hash of the feature vector used. */
  @Column({ type: 'varchar', length: 128 })
  featureHash!: string;

  /** Probability of an upward move. */
  @Column({ type: 'decimal', precision: 6, scale: 4, nullable: true })
  pUp!: number | null;

  /** Probability of a downward move. */
  @Column({ type: 'decimal', precision: 6, scale: 4, nullable: true })
  pDown!: number | null;

  /** Probability of flat / no significant move. */
  @Column({ type: 'decimal', precision: 6, scale: 4, nullable: true })
  pFlat!: number | null;

  /** JSON-serialized move quantiles [p10, p25, p50, p75, p90] in index points. */
  @Column({ type: 'text', nullable: true })
  moveQuantiles!: string | null;

  /** Probability of significant IV crush post-event. */
  @Column({ type: 'decimal', precision: 6, scale: 4, nullable: true })
  ivCrushProbability!: number | null;

  /** JSON-serialized expected change in skew. */
  @Column({ type: 'text', nullable: true })
  skewChangeDistribution!: string | null;

  /** JSON-serialized expected change in term structure slope. */
  @Column({ type: 'text', nullable: true })
  termStructureChangeDistribution!: string | null;

  /** Probability of liquidity stress during event window. */
  @Column({ type: 'decimal', precision: 6, scale: 4, nullable: true })
  liquidityStressProbability!: number | null;

  /** Probability the system should abstain (not trade). */
  @Column({ type: 'decimal', precision: 6, scale: 4, nullable: true })
  abstainProbability!: number | null;

  /** Reasons for abstention. */
  @Column({ type: 'simple-array', nullable: true })
  abstainReasons!: string[];

  /** Strategy type (e.g. 'long_call', 'long_put', 'straddle'). */
  @Column({ type: 'varchar', length: 32, nullable: true })
  paperCandidateType!: string | null;

  /** Target strike price for the paper candidate. */
  @Column({ type: 'decimal', precision: 12, scale: 2, nullable: true })
  paperCandidateStrike!: number | null;

  /** Target expiry string (e.g. "2026-09-25"). */
  @Column({ type: 'varchar', length: 16, nullable: true })
  paperCandidateExpiry!: string | null;

  /** Confidence in the paper candidate (0-1). */
  @Column({ type: 'decimal', precision: 6, scale: 4, nullable: true })
  paperCandidateConfidence!: number | null;

  /** Risk gate verdict: PAPER_CANDIDATE or ABSTAIN. */
  @Column({ type: 'varchar', length: 16, nullable: true })
  riskGateResult!: string | null;

  /** Rejection reason if ABSTAIN. */
  @Column({ type: 'text', nullable: true })
  riskGateRejectionReason!: string | null;

  /** Source's own publication timestamp. */
  @Column({ type: 'timestamptz' })
  sourcePublishedAt!: Date;

  /** When our system received the source data. */
  @Column({ type: 'timestamptz' })
  receivedAt!: Date;

  /** When the raw data was normalized. */
  @Column({ type: 'timestamptz', nullable: true })
  normalizedAt!: Date | null;

  /** When the data was verified / validated. */
  @Column({ type: 'timestamptz', nullable: true })
  verifiedAt!: Date | null;

  /** When features were extracted. */
  @Column({ type: 'timestamptz', nullable: true })
  featureAt!: Date | null;

  /** When the forecast was generated. */
  @Column({ type: 'timestamptz', nullable: true })
  forecastAt!: Date | null;

  /** When the final decision was made. */
  @Column({ type: 'timestamptz' })
  decisionAt!: Date;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
