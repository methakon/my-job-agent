import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

/**
 * One TRAINING SESSION of an Upstox paper account.
 *
 * WHY: capital is configurable now, so a result only means something next to the
 * capital it was produced with. ₹1,150 net on ₹5,000 is not comparable to ₹1,150
 * on ₹10,000, and a session that ran while the cap was ₹2,000 must stay a ₹2,000
 * session forever.
 *
 * This row is the record of "what was configured when this session started":
 * the starting capital, the equity it started from, and a frozen snapshot of the
 * risk policy and strategy version that governed it. Later changes to the cap
 * write a NEW session row (and a capital-change event) — they never rewrite this
 * one, so history keeps its original configuration.
 */
@Entity('upstox_live_paper_sessions')
// One row per account per IST day is NOT enforced: a mid-session capital
// reconfiguration legitimately supersedes the active row and opens a fresh one.
@Index('idx_ulps_portfolio_date_open', ['portfolioId', 'sessionDate'])
@Index('idx_ulps_date', ['sessionDate'])
export class UpstoxLivePaperSession {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'portfolioId', length: 36 })
  portfolioId: string;

  /** IST trading date, 'YYYY-MM-DD'. */
  @Column({ type: 'date' })
  sessionDate: string;

  /** Configured paper capital for this session (INR) — the operator's number. */
  @Column({ type: 'decimal', precision: 16, scale: 2 })
  startingCapital: number;

  /** Equity at session start (capital + carried P&L + unrealised). */
  @Column({ type: 'decimal', precision: 16, scale: 2 })
  startingEquity: number;

  /** Equity at the last update (or close) of the session. */
  @Column({ type: 'decimal', precision: 16, scale: 2, default: 0 })
  endingEquity: number;

  /** Net P&L booked during this session (INR). */
  @Column({ type: 'decimal', precision: 16, scale: 2, default: 0 })
  sessionNetPnl: number;

  /** Highest equity seen during the session (drawdown reference). */
  @Column({ type: 'decimal', precision: 16, scale: 2, default: 0 })
  peakEquity: number;

  /** Risk/sizing mode in force: FIXED_CAPITAL | ACCOUNT_BALANCE_PCT. */
  @Column({ length: 24, default: 'FIXED_CAPITAL' })
  riskMode: string;

  /** Frozen risk policy (percentages, limits) as it stood when the session began. */
  @Column({ type: 'json', nullable: true })
  riskPolicy: Record<string, unknown> | null;

  /** Version of the risk engine that produced the policy above. */
  @Column({ length: 32, default: 'paper-risk-v1' })
  riskPolicyVersion: string;

  /** Version of the entry strategy that traded this session. */
  @Column({ length: 48, default: 'UPSTOX_AUTO_PAPER_ENTRY_V1' })
  strategyVersion: string;

  /** OPEN | CLOSED. */
  @Column({ length: 16, default: 'OPEN' })
  status: string;

  /**
   * Set when a mid-session capital reconfiguration ended this configuration:
   * the row keeps its own starting capital and final equity.
   */
  @Column({ type: 'varchar', length: 160, nullable: true })
  supersededReason: string | null;

  /** Where the session data came from: LIVE_MARKET_PAPER_EXECUTION. */
  @Column({ length: 32, default: 'LIVE_MARKET_PAPER_EXECUTION' })
  dataSource: string;

  @Column({ length: 16, default: 'PAPER' })
  executionMode: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
