import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

/**
 * Experiment tracking entity — GATE 16.
 * 
 * Every research experiment, validation run, and hypothesis test gets a row.
 * Enables: attempt counting, multiple-testing exposure, challenger vs champion,
 * and audit trail from hypothesis → data → strategy → feature → effect.
 * 
 * Items covered: 227 (register hypothesis/data/strategy/feature/effect),
 * 230 (track original vs candidate vs baseline), 233 (register execution/cost assumptions),
 * 236 (predefine acceptance criteria), 239 (record all attempts including failures),
 * 241 (track multiple-testing exposure), 244 (require challenger beats champion),
 * 247 (require rollback support), 250 (retest older skills when regime shifts).
 */
@Entity('experiments')
export class Experiment {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Human-readable experiment name, e.g. 'gap-absorption-v3'. */
  @Column({ type: 'varchar', length: 120 })
  name!: string;

  /** Research category: 'skill', 'feature', 'regime', 'risk', 'execution', 'calibration'. */
  @Column({ type: 'varchar', length: 40 })
  category!: string;

  /**
   * Hypothesis statement: what we expect to happen and why.
   * Items 227: register hypothesis.
   */
  @Column({ type: 'text', nullable: true })
  hypothesis!: string | null;

  /**
   * Data source description: what data is used and its time range.
   * Item 227: register data.
   */
  @Column({ type: 'text', nullable: true })
  dataSource!: string | null;

  /**
   * Strategy description: what we are testing.
   * Item 227: register strategy.
   */
  @Column({ type: 'text', nullable: true })
  strategy!: string | null;

  /**
   * Feature set description: which features are included.
   * Item 227: register feature.
   */
  @Column({ type: 'text', nullable: true })
  featureSet!: string | null;

  /**
   * Expected effect description: what we expect the feature/strategy to produce.
   * Item 227: register effect.
   */
  @Column({ type: 'text', nullable: true })
  expectedEffect!: string | null;

  /**
   * Original baseline configuration (JSON).
   * Item 230: track original vs candidate vs baseline.
   */
  @Column({ type: 'json', nullable: true })
  baselineConfig!: Record<string, any> | null;

  /**
   * Candidate (proposed) configuration (JSON).
   * Item 230: track original vs candidate vs baseline.
   */
  @Column({ type: 'json', nullable: true })
  candidateConfig!: Record<string, any> | null;

  /**
   * Execution and cost assumptions (JSON): slippage, latency, fees.
   * Item 233: register execution/cost assumptions.
   */
  @Column({ type: 'json', nullable: true })
  executionAssumptions!: Record<string, any> | null;

  /**
   * Predefined acceptance criteria (JSON): what metrics must be met.
   * Item 236: predefine acceptance criteria.
   */
  @Column({ type: 'json', nullable: true })
  acceptanceCriteria!: Record<string, any> | null;

  /** Number of times this experiment has been run (including failures).
   *  Item 239: record all attempts including failures. */
  @Column({ type: 'int', default: 0 })
  attemptCount!: number;

  /**
   * Total experiments run against this hypothesis/feature combination.
   * Item 241: track multiple-testing exposure and selection bias.
   */
  @Column({ type: 'int', default: 1 })
  multipleTestingExposure!: number;

  /**
   * The experiment ID this one must beat to be adopted.
   * Item 244: require challenger beats champion.
   */
  @Column({ type: 'varchar', length: 36, nullable: true })
  mustBeatExperimentId!: string | null;

  /**
   * Whether rollback to baseline is supported and tested.
   * Item 247: require rollback support.
   */
  @Column({ type: 'boolean', default: false })
  rollbackSupported!: boolean;

  /**
   * Regime context when experiment was last run (JSON).
   * Item 250: retest older skills when regime shifts.
   */
  @Column({ type: 'json', nullable: true })
  lastRegimeContext!: Record<string, any> | null;

  /**
   * When regime shifts, should this experiment be retested?
   * Item 250: retest older skills when regime shifts.
   */
  @Column({ type: 'boolean', default: false })
  retestOnRegimeShift!: boolean;

  /** PROPOSED | RUNNING | PASSED | FAILED | CHAMPION | ROLLED_BACK | SUPERSEDED */
  @Column({ type: 'varchar', length: 20, default: 'PROPOSED' })
  status!: string;

  /** Latest result summary (JSON): metrics, pass/fail, comparison to baseline. */
  @Column({ type: 'json', nullable: true })
  latestResult!: Record<string, any> | null;

  /** Rollback log (JSON array of rollback events). */
  @Column({ type: 'json', nullable: true })
  rollbackLog!: Record<string, any>[] | null;

  /** Schema version — increments when experiment schema changes. */
  @Column({ type: 'int', default: 1 })
  schemaVersion!: number;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
