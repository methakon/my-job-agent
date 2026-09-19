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
  @Column({ type: 'uuid' })
  eventId!: string;

  /** Canonical event ID this observation maps to. */
  @Column({ type: 'varchar', length: 128 })
  canonicalEventId!: string;

  /** Unique ID from the source (e.g. Reuters GUID, article ID). */
  @Column({ type: 'varchar', length: 256 })
  sourceId!: string;

  /** Human-readable source name. */
  @Column({ type: 'varchar', length: 128 })
  sourceName!: string;

  /** Source reliability tier. */
  @Column({ type: 'varchar', length: 32 })
  sourceTier!: string;

  /** URL of the original source. */
  @Column({ type: 'text', nullable: true })
  sourceUrl!: string | null;

  /** Source's own published timestamp. */
  @Column({ type: 'timestamptz' })
  sourcePublishedAt!: Date;

  /** Source's own last-updated timestamp. */
  @Column({ type: 'timestamptz', nullable: true })
  sourceUpdatedAt!: Date | null;

  /** When our system received this observation. */
  @Column({ type: 'timestamptz' })
  receivedAt!: Date;

  /** When our system finished processing. */
  @Column({ type: 'timestamptz', nullable: true })
  processedAt!: Date | null;

  /** Headline / title. */
  @Column({ type: 'text' })
  title!: string;

  /** Full body text. */
  @Column({ type: 'text', nullable: true })
  body!: string | null;

  /** Source type classification (e.g. "press_release", "data_release"). */
  @Column({ type: 'varchar', length: 64, nullable: true })
  sourceType!: string | null;

  /** ISO 639-1 language code. */
  @Column({ type: 'varchar', length: 8, nullable: true })
  language!: string | null;

  /** Deterministic hash of the raw payload. */
  @Column({ type: 'varchar', length: 128, nullable: true })
  rawPayloadHash!: string | null;

  /** Semantic fingerprint for deduplication / merging. */
  @Column({ type: 'varchar', length: 128 })
  eventFingerprint!: string;

  /** Whether this is a corroboration of an existing event (vs. new info). */
  @Column({ type: 'boolean', default: false })
  isCorroboration!: boolean;

  /** Ingestion latency from source publication to our receipt (ms). */
  @Column({ type: 'int', nullable: true })
  latencyMs!: number | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
