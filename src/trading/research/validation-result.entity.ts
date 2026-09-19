
import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

/**
 * Validation evidence for an adaptation candidate.
 *
 * Stores the full comparison between baseline and candidate performance
 * including holdout/rolling validation metrics, regime-aware comparison,
 * and minimum sample thresholds.
 *
 * A candidate must NOT be activated unless validation passes all gates:
 * - Minimum sample count
 * - Improvement in key metrics
 * - No degradation in risk metrics
 * - Stability across sessions
 * - Regime-aware comparison
 */
@Entity('validation_results')
export class ValidationResult {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** The candidate being validated. */
  @Column({ type: 'varchar', length: 36 })
  candidateId!: string;

  /** Validation method: holdout | rolling | baseline_comparison */
  @Column({ type: 'varchar', length: 50 })
  validationType!: string;

  /** Baseline win rate (%). */
  @Column({ type: 'decimal', precision: 6, scale: 2, nullable: true })
  baselineWinRate!: number | null;

  /** Candidate/projected win rate (%). */
  @Column({ type: 'decimal', precision: 6, scale: 2, nullable: true })
  candidateWinRate!: number | null;

  /** Baseline expectancy (avg PnL per trade). */
  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  baselineExpectancy!: number | null;

  /** Candidate expectancy. */
  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  candidateExpectancy!: number | null;

  /** Number of trades in baseline period. */
  @Column({ type: 'int', default: 0 })
  baselineTradeCount!: number;

  /** Number of trades in candidate period. */
  @Column({ type: 'int', default: 0 })
  candidateTradeCount!: number;

  /** Maximum drawdown observed. */
  @Column({ type: 'decimal', precision: 8, scale: 2, nullable: true })
  maxDrawdown!: number | null;

  /** Stability score (0-1, higher = more stable across sessions). */
  @Column({ type: 'decimal', precision: 5, scale: 4, nullable: true })
  stabilityScore!: number | null;

  /** Total sample size used in validation. */
  @Column({ type: 'int', default: 0 })
  sampleSize!: number;

  /** Trades used for in-sample fitting. */
  @Column({ type: 'int', default: 0 })
  inSampleCount!: number;

  /** Trades used for out-of-sample validation. */
  @Column({ type: 'int', default: 0 })
  outOfSampleCount!: number;

  /** Whether regime-aware comparison was performed. */
  @Column({ type: 'boolean', default: false })
  regimeAware!: boolean;

  /** Whether validation passed all gates. */
  @Column({ type: 'boolean', default: false })
  passed!: boolean;

  /** Reason for rejection (if failed). */
  @Column({ type: 'text', nullable: true })
  rejectionReason!: string | null;

  /** Full validation evidence (JSON). */
  @Column({ type: 'json', nullable: true })
  evidence!: Record<string, any> | null;

  @CreateDateColumn()
  createdAt!: Date;
}
