import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  Index,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { EventIntelEvent } from './event.entity';

/**
 * Immutable event version. Each time new evidence changes the event's
 * understanding, a new version is appended. Old versions are never modified.
 */
@Entity('event_intel_version')
@Index('idx_version_event_id', ['eventId'])
@Index('idx_version_event_num', ['eventId', 'versionNumber'], { unique: true })
export class EventIntelVersion {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** FK → event_intel_event.id */
  @Column({ name: 'event_id', type: 'uuid' })
  eventId!: string;

  /** 1-based monotonically increasing version number. */
  @Column({ name: 'version_number', type: 'int' })
  versionNumber!: number;

  /** What kind of evidence produced this version. */
  @Column({ name: 'evidence_type', type: 'varchar', length: 32 })
  evidenceType!: string;

  /** Headline of the evidence that triggered this version. */
  @Column({ name: 'evidence_title', type: 'text', nullable: true })
  evidenceTitle!: string | null;

  /** Body of the evidence. */
  @Column({ name: 'evidence_body', type: 'text', nullable: true })
  evidenceBody!: string | null;

  /** Source name of this evidence. */
  @Column({ name: 'evidence_source', type: 'varchar', length: 128, nullable: true })
  evidenceSource!: string | null;

  /** Source URL of this evidence. */
  @Column({ name: 'evidence_source_url', type: 'text', nullable: true })
  evidenceSourceUrl!: string | null;

  /** Source's own published timestamp for this evidence. */
  @Column({ name: 'evidence_published_at', type: 'datetime', nullable: true })
  evidencePublishedAt!: Date | null;

  /** When our system received this evidence. */
  @Column({ name: 'received_at', type: 'datetime' })
  receivedAt!: Date;

  /** State machine state before this version. */
  @Column({ name: 'state_before', type: 'varchar', length: 48, nullable: true })
  stateBefore!: string | null;

  /** State machine state after this version. */
  @Column({ name: 'state_after', type: 'varchar', length: 48, nullable: true })
  stateAfter!: string | null;

  /** Reason code for the state transition. */
  @Column({ name: 'state_transition_reason_code', type: 'varchar', length: 64, nullable: true })
  stateTransitionReasonCode!: string | null;

  /** Hash of the feature set at this version. */
  @Column({ name: 'feature_hash', type: 'varchar', length: 128, nullable: true })
  featureHash!: string | null;

  /** ID of the prediction made at this version (if any). */
  @Column({ name: 'frozen_prediction_id', type: 'uuid', nullable: true })
  frozenPredictionId!: string | null;

  @CreateDateColumn({ type: 'datetime' })
  createdAt!: Date;
}
