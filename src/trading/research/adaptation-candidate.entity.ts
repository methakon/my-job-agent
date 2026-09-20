
import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

/**
 * Controlled adaptation candidate — the bridge between research output
 * and actual trading-parameter changes.
 *
 * Lifecycle: PROPOSED → VALIDATING → APPROVED → ACTIVE → (ROLLED_BACK)
 *                                              → REJECTED
 *
 * Risk-limit parameters are NEVER allowed as adaptation targets.
 * Only non-safety parameters may be adapted: decay rates, timing windows,
 * confidence thresholds, pattern weights.
 */
@Entity('adaptation_candidates')
export class AdaptationCandidate {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Parameter name (e.g. 'decayRate.monday', 'windowStartHour.friday', 'confidenceFloor'). */
  @Column({ type: 'varchar', length: 100 })
  paramName!: string;

  /** Category: decay | timing | weight | threshold | confidence */
  @Column({ type: 'varchar', length: 50 })
  paramCategory!: string;

  /** Current value before adaptation (JSON serialized). */
  @Column({ type: 'text' })
  oldValue!: string;

  /** Proposed new value (JSON serialized). */
  @Column({ type: 'text' })
  proposedValue!: string;

  /** Human-readable reason for the proposed change. */
  @Column({ type: 'text' })
  reason!: string;

  /** Evidence IDs linking to research_results (JSON array). */
  @Column({ type: 'json', nullable: true })
  evidenceIds!: string[] | null;

  /** Baseline performance before change. */
  @Column({ type: 'json', nullable: true })
  baselineMetrics!: Record<string, any> | null;

  /** Projected performance after change. */
  @Column({ type: 'json', nullable: true })
  candidateMetrics!: Record<string, any> | null;

  /** PROPOSED | VALIDATING | APPROVED | ACTIVE | REJECTED | ROLLED_BACK */
  @Column({ type: 'varchar', length: 20, default: 'PROPOSED' })
  status!: string;

  /** Link to validation result if validated. */
  @Column({ type: 'varchar', length: 36, nullable: true })
  validationId!: string | null;

  /** When the candidate was activated (applied to live parameters). */
  @Column({ type: 'datetime', nullable: true })
  activatedAt!: Date | null;

  /** Value to restore if rolled back (JSON serialized). */
  @Column({ type: 'text', nullable: true })
  rollbackValue!: string | null;

  /** Link to the research result that proposed this. */
  @Column({ type: 'varchar', length: 36, nullable: true })
  researchResultId!: string | null;

  /** Previous active candidate ID that this one replaces (for rollback chain). */
  @Column({ type: 'varchar', length: 36, nullable: true })
  replacesCandidateId!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
