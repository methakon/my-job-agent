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
  @Column({ name: 'canonical_event_id', type: 'varchar', length: 128 })
  canonicalEventId!: string;

  /** Event classification. */
  @Column({ name: 'ontology', type: 'varchar', length: 32 })
  ontology!: string;

  /** Lifecycle state as new evidence arrives. */
  @Column({ name: 'lifecycle', type: 'varchar', length: 24 })
  lifecycle!: string;

  /** State machine position (S0_DETECTED through S7). */
  @Column({ name: 'current_state', type: 'varchar', length: 48 })
  currentState!: string;

  /** Headline / title. */
  @Column({ name: 'title', type: 'varchar', length: 512 })
  title!: string;

  /** Full body text (nullable for scheduled events with no body yet). */
  @Column({ name: 'body', type: 'text', nullable: true })
  body!: string | null;

  /** Source reliability tier. */
  @Column({ name: 'source_tier', type: 'varchar', length: 32 })
  sourceTier!: string;

  /** Human-readable source name (e.g. "Reuters", "RBI"). */
  @Column({ name: 'source_name', type: 'varchar', length: 128 })
  sourceName!: string;

  /** URL of the original source article / page. */
  @Column({ name: 'source_url', type: 'text', nullable: true })
  sourceUrl!: string | null;

  /** Source's own publication timestamp (NOT when we received it). */
  @Column({ name: 'source_published_at', type: 'datetime' })
  sourcePublishedAt!: Date;

  /** Source's own last-updated timestamp (if revision). */
  @Column({ name: 'source_updated_at', type: 'datetime', nullable: true })
  sourceUpdatedAt!: Date | null;

  /** When our system first received this event. */
  @Column({ name: 'received_at', type: 'datetime' })
  receivedAt!: Date;

  /** When our system finished initial processing. */
  @Column({ name: 'processed_at', type: 'datetime', nullable: true })
  processedAt!: Date | null;

  /** Semantic fingerprint for deduplication / merging. */
  @Column({ name: 'event_fingerprint', type: 'varchar', length: 128 })
  eventFingerprint!: string;

  /** Deterministic hash of the raw payload (for audit). */
  @Column({ name: 'raw_payload_hash', type: 'varchar', length: 128, nullable: true })
  rawPayloadHash!: string | null;

  /** ISO 639-1 language code. */
  @Column({ name: 'language', type: 'varchar', length: 8, default: 'en' })
  language!: string;

  /** Affected country codes. */
  @Column({ name: 'countries', type: 'simple-array', nullable: true })
  countries!: string[];

  /** Involved institutions (central banks, regulators). */
  @Column({ name: 'institutions', type: 'simple-array', nullable: true })
  institutions!: string[];

  /** Involved company names / tickers. */
  @Column({ name: 'companies', type: 'simple-array', nullable: true })
  companies!: string[];

  /** Affected financial assets / indices. */
  @Column({ name: 'assets', type: 'simple-array', nullable: true })
  assets!: string[];

  /** Event type classification (e.g. "rate_decision", "earnings"). */
  @Column({ name: 'event_type', type: 'varchar', length: 64, nullable: true })
  eventType!: string | null;

  /** Event subtype (e.g. "rate_cut", "rate_hold"). */
  @Column({ name: 'event_subtype', type: 'varchar', length: 64, nullable: true })
  eventSubtype!: string | null;

  /** Scheduled / expected time for planned events. */
  @Column({ name: 'scheduled_time', type: 'datetime', nullable: true })
  scheduledTime!: Date | null;

  /** Timezone of the scheduled time (e.g. "Asia/Kolkata"). */
  @Column({ name: 'scheduled_timezone', type: 'varchar', length: 32, nullable: true })
  scheduledTimezone!: string | null;

  /** Importance score 0-10. */
  @Column({ name: 'importance', type: 'int', nullable: true })
  importance!: number | null;

  /** Raw surprise metric (before normalization). */
  @Column({ name: 'surprise_raw', type: 'decimal', precision: 10, scale: 6, nullable: true })
  surpriseRaw!: number | null;

  /** Standardized surprise (z-score). */
  @Column({ name: 'surprise_standardized', type: 'decimal', precision: 10, scale: 6, nullable: true })
  surpriseStandardized!: number | null;

  /** Surprise percentile in historical distribution. */
  @Column({ name: 'surprise_percentile', type: 'decimal', precision: 5, scale: 2, nullable: true })
  surprisePercentile!: number | null;

  /** Novelty score (0-1, how new / unprecedented). */
  @Column({ name: 'novelty_score', type: 'decimal', precision: 5, scale: 4, nullable: true })
  noveltyScore!: number | null;

  /** Number of versions this event has gone through. */
  @Column({ name: 'version_count', type: 'int', default: 1 })
  versionCount!: number;

  @CreateDateColumn({ type: 'datetime' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'datetime' })
  updatedAt!: Date;
}
