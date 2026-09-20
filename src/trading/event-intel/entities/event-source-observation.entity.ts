import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  Index,
  CreateDateColumn,
} from 'typeorm';

/**
 * Individual source observation — preserves every raw observation forever.
 * Never deleted, never updated. Provides full audit trail for corroboration.
 */
@Entity('event_intel_source_obs')
@Index('idx_source_obs_event_id', ['eventId'])
@Index('idx_source_obs_canonical_id', ['canonicalEventId'])
@Index('idx_source_obs_fingerprint', ['eventFingerprint'])
@Index('idx_source_obs_received_at', ['receivedAt'])
export class EventIntelSourceObservation {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** FK → event_intel_event.id */
  @Column({ name: 'event_id', type: 'uuid' })
  eventId!: string;

  /** Canonical event ID this observation maps to. */
  @Column({ name: 'canonical_event_id', type: 'varchar', length: 128 })
  canonicalEventId!: string;

  /** Unique ID from the source (e.g. Reuters GUID, article ID). */
  @Column({ name: 'source_id', type: 'varchar', length: 256 })
  sourceId!: string;

  /** Human-readable source name. */
  @Column({ name: 'source_name', type: 'varchar', length: 128 })
  sourceName!: string;

  /** Source reliability tier. */
  @Column({ name: 'source_tier', type: 'varchar', length: 32 })
  sourceTier!: string;

  /** URL of the original source. */
  @Column({ name: 'source_url', type: 'text', nullable: true })
  sourceUrl!: string | null;

  /** Source's own published timestamp. */
  @Column({ name: 'source_published_at', type: 'datetime' })
  sourcePublishedAt!: Date;

  /** Source's own last-updated timestamp. */
  @Column({ name: 'source_updated_at', type: 'datetime', nullable: true })
  sourceUpdatedAt!: Date | null;

  /** When our system received this observation. */
  @Column({ name: 'received_at', type: 'datetime' })
  receivedAt!: Date;

  /** When our system finished processing. */
  @Column({ name: 'processed_at', type: 'datetime', nullable: true })
  processedAt!: Date | null;

  /** Headline / title. */
  @Column({ name: 'title', type: 'text' })
  title!: string;

  /** Full body text. */
  @Column({ name: 'body', type: 'text', nullable: true })
  body!: string | null;

  /** Source type classification (e.g. "press_release", "data_release"). */
  @Column({ name: 'source_type', type: 'varchar', length: 64, nullable: true })
  sourceType!: string | null;

  /** ISO 639-1 language code. */
  @Column({ name: 'language', type: 'varchar', length: 8, nullable: true })
  language!: string | null;

  /** Deterministic hash of the raw payload. */
  @Column({ name: 'raw_payload_hash', type: 'varchar', length: 128, nullable: true })
  rawPayloadHash!: string | null;

  /** Semantic fingerprint for deduplication / merging. */
  @Column({ name: 'event_fingerprint', type: 'varchar', length: 128 })
  eventFingerprint!: string;

  /** Whether this is a corroboration of an existing event (vs. new info). */
  @Column({ name: 'is_corroboration', type: 'boolean', default: false })
  isCorroboration!: boolean;

  /** Ingestion latency from source publication to our receipt (ms). */
  @Column({ name: 'latency_ms', type: 'int', nullable: true })
  latencyMs!: number | null;

  @CreateDateColumn({ type: 'datetime' })
  createdAt!: Date;
}
