import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

/**
 * Failure journal entity — GATE 14.
 *
 * Every rejected or failed experiment gets a row here with structured fields
 * for diagnosis and reproducibility. Enables: retrieving failure reasons,
 * diagnosing hypothesis failures, maintaining failure history, and attaching
 * evidence back to experiments.
 *
 * Items covered: 199 (record thesis, data, success conditions),
 * 202 (store evidence that experiment failed), 210 (retrieve failure reasons),
 * 216 (require out-of-sample evidence), 220 (retain both trade and no-trade outcomes),
 * 224 (maintain champion/challenger/history).
 */
@Entity('failure_journal')
export class FailureJournal {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Link to the experiment that failed (experiment.id). */
  @Column({ type: 'varchar', length: 36, nullable: true })
  experimentId!: string | null;

  /** Human-readable failure label. */
  @Column({ type: 'varchar', length: 200 })
  failureLabel!: string;

  /**
   * Original thesis: what we expected and why.
   * Item 199: record thesis, data, and success conditions before testing.
   */
  @Column({ type: 'text', nullable: true })
  thesis!: string | null;

  /**
   * Data source and time range used for this test.
   * Item 199: record data source.
   */
  @Column({ type: 'text', nullable: true })
  dataSource!: string | null;

  /**
   * Explicit success conditions that were NOT met.
   * Item 199: record success conditions before testing.
   */
  @Column({ type: 'json', nullable: true })
  successConditions!: Record<string, any> | null;

  /**
   * Evidence that the experiment failed (JSON): metrics, comparison to baseline,
   * out-of-sample results.
   * Item 202: store evidence that experiment failed.
   */
  @Column({ type: 'json', nullable: true })
  failureEvidence!: Record<string, any> | null;

  /**
   * Structured failure reasons (JSON array): ['insufficient sample', 'edge vanished under costs', ...].
   * Item 210: retrieve failure reasons easily.
   */
  @Column({ type: 'json', nullable: true })
  failureReasons!: string[] | null;

  /**
   * Whether out-of-sample evidence was provided.
   * Item 216: require out-of-sample evidence to accept any result.
   */
  @Column({ type: 'boolean', default: false })
  outOfSampleEvidenceProvided!: boolean;

  /**
   * Trade outcomes included: both winning and losing trades retained.
   * Item 220: retain both trade and no-trade outcomes.
   */
  @Column({ type: 'json', nullable: true })
  tradeOutcomes!: Record<string, any>[] | null;

  /**
   * Link to the experiment that beat this one (if any).
   * Item 224: maintain champion/challenger/version history.
   */
  @Column({ type: 'varchar', length: 36, nullable: true })
  supersededByExperimentId!: string | null;

  /** Experiment status at time of failure. */
  @Column({ type: 'varchar', length: 20, nullable: true })
  experimentStatusAtFailure!: string | null;

  /** MAE (maximum adverse excursion) if applicable. */
  @Column({ type: 'decimal', precision: 10, scale: 4, nullable: true })
  mae!: number | null;

  /** MFE (maximum favorable excursion) if applicable. */
  @Column({ type: 'decimal', precision: 10, scale: 4, nullable: true })
  mfe!: number | null;

  /** Build SHA when failure was recorded. */
  @Column({ type: 'varchar', length: 48 })
  buildSha!: string;

  /** Schema version. */
  @Column({ type: 'int', default: 1 })
  schemaVersion!: number;

  @CreateDateColumn()
  createdAt!: Date;
}
