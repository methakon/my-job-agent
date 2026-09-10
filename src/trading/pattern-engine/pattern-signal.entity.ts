import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/**
 * One detected pattern candidate = ONE feature snapshot + its forward outcome
 * labels (brief s12/s13/s16). This table is the learning dataset, not a trade
 * log: FAILED_BREAKOUT / NO_TRADE / late-entry cases are stored alongside the
 * good ones so nothing is learned from survivorship bias.
 *
 * Nothing here places an order. Trading is a separate, flag-gated dispatch step
 * whose per-desk result is recorded in `dispatch`.
 */
@Entity('pattern_signals')
@Index(['sessionDate', 'signal'])
@Index(['contractSymbol', 'bucketTs'])
@Index(['underlying', 'signalTs'])
export class PatternSignal {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  /** IST session date (YYYY-MM-DD) — the market's own calendar. */
  @Column({ type: 'varchar', length: 10 })
  sessionDate: string;

  @Column({ type: 'varchar', length: 24 })
  underlying: string;

  /** Broker instrument key of the observed contract. */
  @Column({ type: 'varchar', length: 96 })
  instrumentKey: string;

  @Column({ type: 'varchar', length: 64 })
  contractSymbol: string;

  @Column({ type: 'date', nullable: true })
  expiry: string | null;

  @Column({ type: 'decimal', precision: 14, scale: 4, nullable: true })
  strike: number | null;

  @Column({ type: 'varchar', length: 2, nullable: true })
  optionType: 'CE' | 'PE' | null;

  /** Candle bucket this assessment was made on. */
  @Column({ type: 'datetime' })
  bucketTs: Date;

  @Column({ type: 'int', default: 5 })
  bucketMinutes: number;

  @Column({ type: 'datetime' })
  signalTs: Date;

  /** Feed that produced the underlying observation (FYERS_LIVE / UPSTOX_LIVE). */
  @Column({ type: 'varchar', length: 24, nullable: true })
  feedSource: string | null;

  @Column({ type: 'varchar', length: 64 })
  patternType: string;

  @Column({ type: 'varchar', length: 16 })
  signal: 'BUY_CE' | 'BUY_PE' | 'NO_TRADE';

  @Column({ type: 'varchar', length: 24 })
  entryState: string;

  @Column({ type: 'decimal', precision: 6, scale: 4, default: 0 })
  confidence: number;

  @Column({ type: 'varchar', length: 32 })
  strategyVersion: string;

  @Column({ type: 'varchar', length: 768 })
  reason: string;

  // ── Structure (normalized) ────────────────────────────────────────────────
  @Column({ type: 'tinyint', default: 0 })
  consolidationDetected: boolean;

  @Column({ type: 'decimal', precision: 14, scale: 4, nullable: true }) rangeHigh: number | null;
  @Column({ type: 'decimal', precision: 14, scale: 4, nullable: true }) rangeLow: number | null;
  @Column({ type: 'decimal', precision: 10, scale: 6, nullable: true }) rangeWidthPct: number | null;
  @Column({ type: 'decimal', precision: 10, scale: 6, nullable: true }) rangeWidthAtr: number | null;
  @Column({ type: 'decimal', precision: 14, scale: 4, nullable: true }) atr: number | null;
  @Column({ type: 'decimal', precision: 10, scale: 6, nullable: true }) atrPct: number | null;
  @Column({ type: 'int', default: 0 }) consolidationBars: number;
  @Column({ type: 'int', default: 0 }) failedBreakouts: number;

  // ── Scores (each stored separately so its value can be measured later) ────
  @Column({ type: 'decimal', precision: 6, scale: 4, default: 0 }) reversalScore: number;
  @Column({ type: 'decimal', precision: 6, scale: 4, default: 0 }) breakoutScore: number;
  @Column({ type: 'decimal', precision: 6, scale: 4, default: 0 }) momentumScore: number;
  @Column({ type: 'decimal', precision: 6, scale: 4, default: 0 }) volumeScore: number;
  @Column({ type: 'decimal', precision: 6, scale: 4, default: 0 }) oiScore: number;
  @Column({ type: 'decimal', precision: 6, scale: 4, default: 0 }) ivScore: number;
  @Column({ type: 'decimal', precision: 6, scale: 4, default: 0 }) underlyingScore: number;
  @Column({ type: 'decimal', precision: 6, scale: 4, default: 0 }) liquidityScore: number;
  @Column({ type: 'decimal', precision: 6, scale: 4, default: 0 }) chainScore: number;

  @Column({ type: 'varchar', length: 24, nullable: true })
  breakoutClass: string | null;

  @Column({ type: 'decimal', precision: 10, scale: 4, nullable: true })
  distanceAtr: number | null;

  @Column({ type: 'int', nullable: true })
  barsSinceBreakout: number | null;

  // ── Directions ────────────────────────────────────────────────────────────
  @Column({ type: 'varchar', length: 16, nullable: true }) underlyingDirection: string | null;
  @Column({ type: 'varchar', length: 16, nullable: true }) optionDirection: string | null;
  @Column({ type: 'tinyint', default: 0 }) underlyingConfirmed: boolean;
  @Column({ type: 'varchar', length: 24, nullable: true }) oiBehaviour: string | null;

  // ── Quote / chain snapshot at the signal ──────────────────────────────────
  @Column({ type: 'decimal', precision: 14, scale: 4, nullable: true }) ltp: number | null;
  @Column({ type: 'decimal', precision: 14, scale: 4, nullable: true }) bid: number | null;
  @Column({ type: 'decimal', precision: 14, scale: 4, nullable: true }) ask: number | null;
  @Column({ type: 'decimal', precision: 10, scale: 6, nullable: true }) spreadPct: number | null;
  @Column({ type: 'bigint', nullable: true }) volume: string | null;
  @Column({ type: 'bigint', nullable: true }) oi: string | null;
  @Column({ type: 'bigint', nullable: true }) changeOi: string | null;
  @Column({ type: 'decimal', precision: 10, scale: 4, nullable: true }) iv: number | null;
  @Column({ type: 'decimal', precision: 10, scale: 6, nullable: true }) delta: number | null;
  @Column({ type: 'decimal', precision: 10, scale: 6, nullable: true }) gamma: number | null;
  @Column({ type: 'decimal', precision: 10, scale: 6, nullable: true }) theta: number | null;
  @Column({ type: 'decimal', precision: 10, scale: 6, nullable: true }) vega: number | null;
  @Column({ type: 'decimal', precision: 10, scale: 6, nullable: true }) pcr: number | null;

  /** Plan levels, in PERCENT — never rupees (brief s11). */
  @Column({ type: 'decimal', precision: 10, scale: 6, nullable: true }) targetPct: number | null;
  @Column({ type: 'decimal', precision: 10, scale: 6, nullable: true }) stopPct: number | null;

  /** Full component/feature payload (parts, flags, chain + underlying detail). */
  @Column({ type: 'json', nullable: true })
  features: any;

  // ── Forward outcome labelling ─────────────────────────────────────────────
  @Column({ type: 'varchar', length: 24, default: 'PENDING' })
  outcomeLabel: string;

  @Column({ type: 'datetime', nullable: true }) labelledAt: Date | null;
  @Column({ type: 'decimal', precision: 10, scale: 6, nullable: true }) maxFavourablePct: number | null;
  @Column({ type: 'decimal', precision: 10, scale: 6, nullable: true }) maxAdversePct: number | null;
  /**
   * Forward outcome measurements per horizon. `covered:false` marks a horizon
   * the tape has not reached yet — it is stored but must never be aggregated as
   * if it were a result.
   */
  @Column({ type: 'json', nullable: true })
  outcomes: { horizons: unknown[]; coverageMinutes?: number } | null;

  // ── Per-desk dispatch (isolated; each desk decides independently) ─────────
  @Column({ type: 'json', nullable: true })
  dispatch: any;

  @Column({ type: 'varchar', length: 64, nullable: true }) fnfTradeId: string | null;
  @Column({ type: 'varchar', length: 64, nullable: true }) upstoxTradeId: string | null;
}
