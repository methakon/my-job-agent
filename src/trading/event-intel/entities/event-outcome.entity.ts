import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  Index,
  CreateDateColumn,
} from 'typeorm';

/**
 * Event outcome — recorded once after an event resolves.
 * Captures the actual market impact and prediction accuracy.
 */
@Entity('event_intel_outcome')
@Index('idx_outcome_event_id', ['eventId'], { unique: true })
export class EventIntelOutcome {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** FK → event_intel_event.id (one outcome per event). */
  @Column({ name: 'event_id', type: 'uuid' })
  eventId!: string;

  /** Final lifecycle state at resolution. */
  @Column({ name: 'final_lifecycle', type: 'varchar', length: 24 })
  finalLifecycle!: string;

  /** Final state machine state at resolution. */
  @Column({ name: 'final_state', type: 'varchar', length: 48 })
  finalState!: string;

  /** Total number of versions accumulated. */
  @Column({ name: 'total_versions', type: 'int' })
  totalVersions!: number;

  /** Whether the event was retracted or denied. */
  @Column({ name: 'was_retracted', type: 'boolean', default: false })
  wasRetracted!: boolean;

  /** Actual spot move (index points). */
  @Column({ name: 'actual_spot_move', type: 'decimal', precision: 12, scale: 4, nullable: true })
  actualSpotMove!: number | null;

  /** Actual IV move (percentage points). */
  @Column({ name: 'actual_iv_move', type: 'decimal', precision: 10, scale: 4, nullable: true })
  actualIVMove!: number | null;

  /** Prediction accuracy score (0-1). */
  @Column({ name: 'prediction_accuracy', type: 'decimal', precision: 6, scale: 4, nullable: true })
  predictionAccuracy!: number | null;

  /** JSON-serialized counterfactual: what would have happened without the event. */
  @Column({ name: 'counterfactual_no_event', type: 'text', nullable: true })
  counterfactualNoEvent!: string | null;

  /** JSON-serialized error attribution breakdown. */
  @Column({ name: 'error_attribution', type: 'text', nullable: true })
  errorAttribution!: string | null;

  /** Number of source observations that fed this event. */
  @Column({ name: 'source_observations_count', type: 'int', default: 0 })
  sourceObservationsCount!: number;

  @CreateDateColumn({ type: 'datetime' })
  createdAt!: Date;
}
