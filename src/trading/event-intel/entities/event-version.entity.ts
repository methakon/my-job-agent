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
  @Column({ type: 'uuid' })
  eventId!: string;

  /** 1-based monotonically increasing version number. */
  @Column({ type: 'int' })
  versionNumber!: number;

  /** What kind of evidence produced this version. */
  @Column({ type: 'varchar', length: 32 })
  evidenceType!: string;

  /** Headline of the evidence that triggered this version. */
  @Column({ type: 'text', nullable: true })
  evidenceTitle!: string | null;

  /** Body of the evidence. */
  @Column({ type: 'text', nullable: true })
  evidenceBody!: string | null;

  /** Source name of this evidence. */
  @Column({ type: 'varchar', length: 128, nullable: true })
  evidenceSource!: string | null;

  /** Source URL of this evidence. */
  @Column({ type: 'text', nullable: true })
  evidenceSourceUrl!: string | null;

  /** Source's own published timestamp for this evidence. */
  @Column({ type: 'timestamptz', nullable: true })
  evidencePublishedAt!: Date | null;

  /** When our system received this evidence. */
  @Column({ type: 'timestamptz' })
  receivedAt!: Date;

  /** State machine state before this version. */
  @Column({ type: 'varchar', length: 48, nullable: true })
  stateBefore!: string | null;

  /** State machine state after this version. */
  @Column({ type: 'varchar', length: 48, nullable: true })
  stateAfter!: string | null;

  /** Reason code for the state transition. */
  @Column({ type: 'varchar', length: 64, nullable: true })
  stateTransitionReasonCode!: string | null;

  /** Hash of the feature set at this version. */
  @Column({ type: 'varchar', length: 128, nullable: true })
  featureHash!: string | null;

  /** ID of the prediction made at this version (if any). */
  @Column({ type: 'uuid', nullable: true })
  frozenPredictionId!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
