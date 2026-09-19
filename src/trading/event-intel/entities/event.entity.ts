import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  Index,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

/** Canonical event entity — the central record for event intelligence. */
@Entity('event_intel_event')
@Index('idx_event_canonical_id', ['canonicalEventId'], { unique: true })
@Index('idx_event_state', ['currentState'])
@Index('idx_event_ontology', ['ontology'])
@Index('idx_event_received_at', ['receivedAt'])
export class EventIntelEvent {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Stable canonical ID for this event across all versions and sources. */
  @Column({ type: 'varchar', length: 128 })
  canonicalEventId!: string;

  /** Event classification. */
  @Column({ type: 'varchar', length: 32 })
  ontology!: string;

  /** Lifecycle state as new evidence arrives. */
  @Column({ type: 'varchar', length: 24 })
  lifecycle!: string;

  /** State machine position (S0_DETECTED through S7). */
  @Column({ type: 'varchar', length: 48 })
  currentState!: string;

  /** Headline / title. */
  @Column({ type: 'varchar', length: 512 })
  title!: string;

  /** Full body text (nullable for scheduled events with no body yet). */
  @Column({ type: 'text', nullable: true })
  body!: string | null;

  /** Source reliability tier. */
  @Column({ type: 'varchar', length: 32 })
  sourceTier!: string;

  /** Human-readable source name (e.g. "Reuters", "RBI"). */
  @Column({ type: 'varchar', length: 128 })
  sourceName!: string;

  /** URL of the original source article / page. */
  @Column({ type: 'text', nullable: true })
  sourceUrl!: string | null;

  /** Source's own publication timestamp (NOT when we received it). */
  @Column({ type: 'timestamptz' })
  sourcePublishedAt!: Date;

  /** Source's own last-updated timestamp (if revision). */
  @Column({ type: 'timestamptz', nullable: true })
  sourceUpdatedAt!: Date | null;

  /** When our system first received this event. */
  @Column({ type: 'timestamptz' })
  receivedAt!: Date;

  /** When our system finished initial processing. */
  @Column({ type: 'timestamptz', nullable: true })
  processedAt!: Date | null;

  /** Semantic fingerprint for deduplication / merging. */
  @Column({ type: 'varchar', length: 128 })
  eventFingerprint!: string;

  /** Deterministic hash of the raw payload (for audit). */
  @Column({ type: 'varchar', length: 128, nullable: true })
  rawPayloadHash!: string | null;

  /** ISO 639-1 language code. */
  @Column({ type: 'varchar', length: 8, default: 'en' })
  language!: string;

  /** Affected country codes. */
  @Column({ type: 'simple-array', nullable: true })
  countries!: string[];

  /** Involved institutions (central banks, regulators). */
  @Column({ type: 'simple-array', nullable: true })
  institutions!: string[];

  /** Involved company names / tickers. */
  @Column({ type: 'simple-array', nullable: true })
  companies!: string[];

  /** Affected financial assets / indices. */
  @Column({ type: 'simple-array', nullable: true })
  assets!: string[];

  /** Event type classification (e.g. "rate_decision", "earnings"). */
  @Column({ type: 'varchar', length: 64, nullable: true })
  eventType!: string | null;

  /** Event subtype (e.g. "rate_cut", "rate_hold"). */
  @Column({ type: 'varchar', length: 64, nullable: true })
  eventSubtype!: string | null;

  /** Scheduled / expected time for planned events. */
  @Column({ type: 'timestamptz', nullable: true })
  scheduledTime!: Date | null;

  /** Timezone of the scheduled time (e.g. "Asia/Kolkata"). */
  @Column({ type: 'varchar', length: 32, nullable: true })
  scheduledTimezone!: string | null;

  /** Importance score 0-10. */
  @Column({ type: 'int', nullable: true })
  importance!: number | null;

  /** Raw surprise metric (before normalization). */
  @Column({ type: 'decimal', precision: 10, scale: 6, nullable: true })
  surpriseRaw!: number | null;

  /** Standardized surprise (z-score). */
  @Column({ type: 'decimal', precision: 10, scale: 6, nullable: true })
  surpriseStandardized!: number | null;

  /** Surprise percentile in historical distribution. */
  @Column({ type: 'decimal', precision: 5, scale: 2, nullable: true })
  surprisePercentile!: number | null;

  /** Novelty score (0-1, how new / unprecedented). */
  @Column({ type: 'decimal', precision: 5, scale: 4, nullable: true })
  noveltyScore!: number | null;

  /** Number of versions this event has gone through. */
  @Column({ type: 'int', default: 1 })
  versionCount!: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
