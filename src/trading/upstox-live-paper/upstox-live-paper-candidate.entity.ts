import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

/**
 * The LEARNING JOURNAL: one row per candidate the V1 policy evaluated — the
 * executed ones AND the NO-TRADE ones.
 *
 * The operator's rule is explicit: log every candidate, including rejections,
 * with all entry feature scores, the hypothetical entry/stop/target, the 5/10/
 * 15/30/60-minute outcomes, MFE/MAE (maximum favourable / adverse price), and
 * whether it turned out to be a missed winner, a false breakout, a premature
 * exit or a late entry.
 *
 * That is what makes the thresholds testable later: a rejected candidate that
 * would have run 180% is the evidence that decides whether 0.65/0.60 are the
 * right gates — you cannot see that if only winners get recorded.
 *
 * Every row is stamped with the strategy version and the risk policy it was
 * judged under, so comparisons across versions and across configured capitals
 * stay honest (₹2,000 and ₹10,000 rows are otherwise not comparable).
 */
@Entity('upstox_live_paper_candidates')
@Index('idx_ulpc_session', ['portfolioId', 'sessionDate'])
@Index('idx_ulpc_contract', ['contractSymbol', 'evaluatedAt'])
@Index('idx_ulpc_qualified', ['qualified', 'sessionDate'])
@Index('idx_ulpc_trade', ['tradeId'])
export class UpstoxLivePaperCandidate {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'portfolioId', type: 'varchar', length: 36, nullable: true })
  portfolioId: string | null;

  /** IST trading date, 'YYYY-MM-DD'. */
  @Column({ type: 'date' })
  sessionDate: string;

  /** Versions that produced this decision (comparability across runs). */
  @Column({ length: 48, default: 'UPSTOX_AUTO_PAPER_ENTRY_V1' })
  strategyVersion: string;

  @Column({ length: 32, default: 'paper-risk-v1' })
  riskPolicyVersion: string;

  // ── the contract under evaluation ──────────────────────────────────────
  @Column({ length: 96 })
  contractSymbol: string;

  @Column({ length: 32 })
  underlying: string;

  @Column({ type: 'date', nullable: true })
  expiry: string | null;

  @Column({ type: 'decimal', precision: 16, scale: 4, nullable: true })
  strike: number | null;

  @Column({ type: 'varchar', length: 2, nullable: true })
  optionType: 'CE' | 'PE' | null;

  /** Underlying level at evaluation. */
  @Column({ type: 'decimal', precision: 16, scale: 4, nullable: true })
  spot: number | null;

  // ── the live book at evaluation ────────────────────────────────────────
  @Column({ type: 'decimal', precision: 16, scale: 4 })
  ltp: number;

  @Column({ type: 'decimal', precision: 16, scale: 4, nullable: true })
  bid: number | null;

  @Column({ type: 'decimal', precision: 16, scale: 4, nullable: true })
  ask: number | null;

  @Column({ type: 'decimal', precision: 10, scale: 6, nullable: true })
  spreadPct: number | null;

  @Column({ type: 'bigint', nullable: true })
  volume: string | null;

  @Column({ type: 'bigint', nullable: true })
  openInterest: string | null;

  @Column({ type: 'bigint', nullable: true })
  oiChange: string | null;

  @Column({ type: 'decimal', precision: 12, scale: 6, nullable: true })
  iv: number | null;

  // The operator asked for IV/Greeks to be part of the entry evaluation, so they
  // are journalled per candidate and can be correlated with outcomes later.
  @Column({ type: 'decimal', precision: 12, scale: 6, nullable: true })
  delta: number | null;

  @Column({ type: 'decimal', precision: 12, scale: 6, nullable: true })
  gamma: number | null;

  @Column({ type: 'decimal', precision: 12, scale: 6, nullable: true })
  theta: number | null;

  @Column({ type: 'decimal', precision: 12, scale: 6, nullable: true })
  vega: number | null;

  @Column({ type: 'decimal', precision: 16, scale: 6, nullable: true })
  optionAtr: number | null;

  @Column({ type: 'decimal', precision: 16, scale: 6, nullable: true })
  underlyingAtr: number | null;

  /** Age of the quote at decision time — a stale tick must never look fresh. */
  @Column({ type: 'int', nullable: true })
  tickAgeMs: number | null;

  // ── entry feature scores (all of them, every candidate) ────────────────
  @Column({ type: 'decimal', precision: 8, scale: 4, default: 0 })
  confidence: number;

  @Column({ type: 'decimal', precision: 8, scale: 4, default: 0 })
  reversalScore: number;

  @Column({ type: 'varchar', length: 24, nullable: true })
  entryState: string | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  patternType: string | null;

  @Column({ type: 'json', nullable: true })
  scores: Record<string, unknown> | null;

  @Column({ type: 'json', nullable: true })
  thresholds: Record<string, unknown> | null;

  // ── decision + rationale ───────────────────────────────────────────────
  @Column({ type: 'tinyint', default: 0 })
  qualified: boolean;

  /** Whether this candidate actually became a position (qualified ≠ executed). */
  @Column({ type: 'tinyint', default: 0 })
  executed: boolean;

  /** 'NO_TRADE' when refused; otherwise the intended side. */
  @Column({ length: 12, default: 'NO_TRADE' })
  decision: string;

  /** Every hard block, so a refusal is explainable months later. */
  @Column({ type: 'json', nullable: true })
  refusals: string[] | null;

  @Column({ type: 'json', nullable: true })
  notes: string[] | null;

  // ── hypothetical plan (recorded even when refused) ─────────────────────
  @Column({ type: 'decimal', precision: 16, scale: 4, nullable: true })
  plannedEntry: number | null;

  @Column({ type: 'decimal', precision: 16, scale: 4, nullable: true })
  plannedStop: number | null;

  @Column({ name: 'plannedTarget', type: 'decimal', precision: 16, scale: 4, nullable: true })
  plannedTarget: number | null;

  @Column({ type: 'decimal', precision: 10, scale: 4, nullable: true })
  plannedRewardRisk: number | null;

  @Column({ type: 'decimal', precision: 16, scale: 2, nullable: true })
  plannedRisk: number | null;

  @Column({ type: 'decimal', precision: 10, scale: 4, nullable: true })
  plannedRiskPct: number | null;

  @Column({ type: 'int', nullable: true })
  lots: number | null;

  @Column({ type: 'int', nullable: true })
  lotSize: number | null;

  /** The account's configured capital when this was judged (comparability). */
  @Column({ type: 'decimal', precision: 16, scale: 2, nullable: true })
  configuredCapital: number | null;

  @Column({ type: 'decimal', precision: 16, scale: 2, nullable: true })
  riskBase: number | null;

  // ── execution ──────────────────────────────────────────────────────────
  @Column({ type: 'varchar', length: 36, nullable: true })
  tradeId: string | null;

  @Column({ type: 'decimal', precision: 16, scale: 4, nullable: true })
  entryPrice: number | null;

  @Column({ type: 'datetime', nullable: true })
  entryTs: Date | null;

  // ── outcome: what the market actually did ──────────────────────────────
  /** Maximum favourable excursion, in premium points and %. */
  @Column({ type: 'decimal', precision: 16, scale: 4, nullable: true })
  mfe: number | null;

  @Column({ type: 'decimal', precision: 10, scale: 4, nullable: true })
  mfePct: number | null;

  /** Maximum adverse excursion, in premium points and %. */
  @Column({ type: 'decimal', precision: 16, scale: 4, nullable: true })
  mae: number | null;

  @Column({ type: 'decimal', precision: 10, scale: 4, nullable: true })
  maePct: number | null;

  /** The single best/worst premium seen in the tracking window. */
  @Column({ type: 'decimal', precision: 16, scale: 4, nullable: true })
  maxFavourablePrice: number | null;

  @Column({ type: 'decimal', precision: 16, scale: 4, nullable: true })
  maxAdversePrice: number | null;

  @Column({ type: 'decimal', precision: 16, scale: 4, nullable: true })
  exitPrice: number | null;

  @Column({ type: 'datetime', nullable: true })
  exitTs: Date | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  exitReason: string | null;

  /** Best premium AFTER the exit — quantifies a premature exit. */
  @Column({ type: 'decimal', precision: 16, scale: 4, nullable: true })
  peakAfterExit: number | null;

  @Column({ type: 'decimal', precision: 10, scale: 4, nullable: true })
  missedOpportunityPct: number | null;

  /** { '5': {pct, price}, '10': …, '15': …, '30': …, '60': … } */
  @Column({ type: 'json', nullable: true })
  postExitOutcomes: Record<string, unknown> | null;

  /** { '5': {pct, price}, … } measured from the hypothetical entry when refused. */
  @Column({ type: 'json', nullable: true })
  forwardOutcomes: Record<string, unknown> | null;

  /** MISSED_WINNER | FALSE_BREAKOUT | PREMATURE_EXIT | LATE_ENTRY | GOOD_EXIT | LOSS_AVOIDED | PENDING */
  @Column({ length: 24, default: 'PENDING' })
  classification: string;

  @Column({ length: 16, default: 'PENDING' })
  outcomeStatus: string;

  @Column({ type: 'datetime', nullable: true })
  labelledAt: Date | null;

  @CreateDateColumn({ name: 'evaluatedAt' })
  evaluatedAt: Date;

  // ---- isolation / provenance ----
  @Column({ length: 16, default: 'UPSTOX' })
  dataSource: string;

  @Column({ length: 16, default: 'PAPER' })
  executionMode: string;

  @UpdateDateColumn()
  updatedAt: Date;
}
