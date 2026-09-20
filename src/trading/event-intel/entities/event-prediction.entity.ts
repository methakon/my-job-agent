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
  @Column({ name: 'event_id', type: 'uuid' })
  eventId!: string;

  /** Event version this prediction is based on. */
  @Column({ name: 'version_number', type: 'int' })
  versionNumber!: number;

  /** Hash of the feature vector used. */
  @Column({ name: 'feature_hash', type: 'varchar', length: 128 })
  featureHash!: string;

  /** Probability of an upward move. */
  @Column({ name: 'p_up', type: 'decimal', precision: 6, scale: 4, nullable: true })
  pUp!: number | null;

  /** Probability of a downward move. */
  @Column({ name: 'p_down', type: 'decimal', precision: 6, scale: 4, nullable: true })
  pDown!: number | null;

  /** Probability of flat / no significant move. */
  @Column({ name: 'p_flat', type: 'decimal', precision: 6, scale: 4, nullable: true })
  pFlat!: number | null;

  /** JSON-serialized move quantiles [p10, p25, p50, p75, p90] in index points. */
  @Column({ name: 'move_quantiles', type: 'text', nullable: true })
  moveQuantiles!: string | null;

  /** Probability of significant IV crush post-event. */
  @Column({ name: 'iv_crush_probability', type: 'decimal', precision: 6, scale: 4, nullable: true })
  ivCrushProbability!: number | null;

  /** JSON-serialized expected change in skew. */
  @Column({ name: 'skew_change_distribution', type: 'text', nullable: true })
  skewChangeDistribution!: string | null;

  /** JSON-serialized expected change in term structure slope. */
  @Column({ name: 'term_structure_change_distribution', type: 'text', nullable: true })
  termStructureChangeDistribution!: string | null;

  /** Probability of liquidity stress during event window. */
  @Column({ name: 'liquidity_stress_probability', type: 'decimal', precision: 6, scale: 4, nullable: true })
  liquidityStressProbability!: number | null;

  /** Probability the system should abstain (not trade). */
  @Column({ name: 'abstain_probability', type: 'decimal', precision: 6, scale: 4, nullable: true })
  abstainProbability!: number | null;

  /** Reasons for abstention. */
  @Column({ name: 'abstain_reasons', type: 'simple-array', nullable: true })
  abstainReasons!: string[];

  /** Strategy type (e.g. 'long_call', 'long_put', 'straddle'). */
  @Column({ name: 'paper_candidate_type', type: 'varchar', length: 32, nullable: true })
  paperCandidateType!: string | null;

  /** Target strike price for the paper candidate. */
  @Column({ name: 'paper_candidate_strike', type: 'decimal', precision: 12, scale: 2, nullable: true })
  paperCandidateStrike!: number | null;

  /** Target expiry string (e.g. "2026-09-25"). */
  @Column({ name: 'paper_candidate_expiry', type: 'varchar', length: 16, nullable: true })
  paperCandidateExpiry!: string | null;

  /** Confidence in the paper candidate (0-1). */
  @Column({ name: 'paper_candidate_confidence', type: 'decimal', precision: 6, scale: 4, nullable: true })
  paperCandidateConfidence!: number | null;

  /** Risk gate verdict: PAPER_CANDIDATE or ABSTAIN. */
  @Column({ name: 'risk_gate_result', type: 'varchar', length: 16, nullable: true })
  riskGateResult!: string | null;

  /** Rejection reason if ABSTAIN. */
  @Column({ name: 'risk_gate_rejection_reason', type: 'text', nullable: true })
  riskGateRejectionReason!: string | null;

  /** Source's own publication timestamp. */
  @Column({ name: 'source_published_at', type: 'datetime' })
  sourcePublishedAt!: Date;

  /** When our system received the source data. */
  @Column({ name: 'received_at', type: 'datetime' })
  receivedAt!: Date;

  /** When the raw data was normalized. */
  @Column({ name: 'normalized_at', type: 'datetime', nullable: true })
  normalizedAt!: Date | null;

  /** When the data was verified / validated. */
  @Column({ name: 'verified_at', type: 'datetime', nullable: true })
  verifiedAt!: Date | null;

  /** When features were extracted. */
  @Column({ name: 'feature_at', type: 'datetime', nullable: true })
  featureAt!: Date | null;

  /** When the forecast was generated. */
  @Column({ name: 'forecast_at', type: 'datetime', nullable: true })
  forecastAt!: Date | null;

  /** When the final decision was made. */
  @Column({ name: 'decision_at', type: 'datetime' })
  decisionAt!: Date;

  @CreateDateColumn({ type: 'datetime' })
  createdAt!: Date;
}
