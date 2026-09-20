
import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

/**
 * Persisted daily research output from the off-hours research worker.
 *
 * One row per (sessionDate, underlying) pair. Stores the full deterministic
 * research output: regime analysis, pattern statistics, candidate improvements,
 * and validation status — never merely logged to PM2.
 *
 * researchVersion increments when the research schema changes.
 * The latest version is the authoritative result for a given date/underlying.
 */
@Entity('research_results')
export class ResearchResult {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Trading session date (IST). */
  @Column({ type: 'date' })
  sessionDate!: string;

  /** Underlying index (NIFTY, NIFTYBANK, SENSEX, NIFTYFIN). */
  @Column({ type: 'varchar', length: 20 })
  underlying!: string;

  /** Number of historical data points analyzed. */
  @Column({ type: 'int', default: 0 })
  sampleCount!: number;

  /** Deterministic analytics output (volatility, trend, premium stats, etc.). */
  @Column({ type: 'json', nullable: true })
  metrics!: Record<string, any> | null;

  /** Detected market regime (LOW_VOL, HIGH_VOL, TREND_UP, TREND_DOWN, RANGE). */
  @Column({ type: 'varchar', length: 50, nullable: true })
  detectedRegime!: string | null;

  /** Pattern frequency, win rate, outcome distributions. */
  @Column({ type: 'json', nullable: true })
  patterns!: Record<string, any> | null;

  /** Candidate parameter changes proposed by the research (JSON array). */
  @Column({ type: 'json', nullable: true })
  candidateChanges!: Record<string, any>[] | null;

  /** Baseline performance metrics before proposed change. */
  @Column({ type: 'json', nullable: true })
  baselineMetrics!: Record<string, any> | null;

  /** Projected metrics if candidate is applied (estimated). */
  @Column({ type: 'json', nullable: true })
  candidateMetrics!: Record<string, any> | null;

  /** PROPOSED | VALIDATING | REJECTED | APPROVED | ACTIVATED | ROLLED_BACK */
  @Column({ type: 'varchar', length: 20, default: 'PROPOSED' })
  validationStatus!: string;

  /** Schema version — increments when research output format changes. */
  @Column({ type: 'int', default: 1 })
  researchVersion!: number;

  @CreateDateColumn()
  createdAt!: Date;
}
