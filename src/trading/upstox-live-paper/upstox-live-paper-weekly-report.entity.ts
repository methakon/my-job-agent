import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

/**
 * Weekly trading report (stored + Markdown).
 *
 * Persisted so each report is queryable, diffable, and re-renderable. The
 * Markdown body is also stored so it can be delivered to the user without
 * re-running the report generation.
 */
@Entity('upstox_live_paper_weekly_reports')
@Index('idx_ulpwr_week', ['reportWeek'])
@Index('idx_ulpwr_portfolio', ['portfolioId'])
export class UpstoxLivePaperWeeklyReport {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Portfolio this report covers. */
  @Column({ name: 'portfolioId', length: 36 })
  portfolioId: string;

  /** ISO week, e.g. '2026-W37'. */
  @Column({ name: 'reportWeek', length: 12 })
  reportWeek: string;

  /** Start of the reporting week (inclusive, IST). */
  @Column({ name: 'weekStart', type: 'datetime' })
  weekStart: Date;

  /** End of the reporting week (inclusive, IST). */
  @Column({ name: 'weekEnd', type: 'datetime' })
  weekEnd: Date;

  /** Starting paper capital at week start (INR). */
  @Column({ name: 'startingCapital', type: 'decimal', precision: 14, scale: 2 })
  startingCapital: number;

  /** Ending equity at week end (INR): capital + netPnl + unrealised. */
  @Column({ name: 'endingEquity', type: 'decimal', precision: 14, scale: 2 })
  endingEquity: number;

  /** Realised P&L over the week (INR). */
  @Column({ name: 'realisedPnl', type: 'decimal', precision: 14, scale: 2 })
  realisedPnl: number;

  /** Unrealised P&L over the week (INR). */
  @Column({ name: 'unrealisedPnl', type: 'decimal', precision: 14, scale: 2 })
  unrealisedPnl: number;

  /** Total P&L (realised + unrealised) over the week (INR). */
  @Column({ name: 'totalPnl', type: 'decimal', precision: 14, scale: 2 })
  totalPnl: number;

  /** Percentage return over the week. */
  @Column({ type: 'decimal', precision: 10, scale: 4 })
  returnPct: number;

  /** Number of trades opened in the week. */
  @Column()
  tradeCount: number;

  /** Winning trades in the week. */
  @Column()
  winningTrades: number;

  /** Losing trades in the week. */
  @Column()
  losingTrades: number;

  /** Win rate (percent). */
  @Column({ type: 'decimal', precision: 6, scale: 2 })
  winRate: number;

  /** Average winner (INR). */
  @Column({ name: 'avgWinner', type: 'decimal', precision: 14, scale: 2 })
  avgWinner: number;

  /** Average loser (INR, absolute value). */
  @Column({ name: 'avgLoser', type: 'decimal', precision: 14, scale: 2 })
  avgLoser: number;

  /** Profit factor (gross wins / gross losses). */
  @Column({ type: 'decimal', precision: 10, scale: 4 })
  profitFactor: number;

  /** Maximum drawdown over the week (INR). */
  @Column({ name: 'maxDrawdown', type: 'decimal', precision: 14, scale: 2 })
  maxDrawdown: number;

  /** Largest winning trade (INR). */
  @Column({ name: 'largestWin', type: 'decimal', precision: 14, scale: 2 })
  largestWin: number;

  /** Largest losing trade (INR, absolute value). */
  @Column({ name: 'largestLoss', type: 'decimal', precision: 14, scale: 2 })
  largestLoss: number;

  /** Brokerage/charges assumption note. */
  @Column({ type: 'varchar',  length: 255, nullable: true })
  costAssumptions: string | null;

  /** Estimated slippage note. */
  @Column({ type: 'varchar',  length: 255, nullable: true })
  slippageAssumptions: string | null;

  /** Performance by underlying (JSON: { underlying: { trades, winRate, netPnl, ... } }). */
  @Column({ name: 'perfByUnderlying', type: 'json', nullable: true })
  perfByUnderlying: Record<string, unknown> | null;

  /** Performance by strategy/algo (JSON). */
  @Column({ name: 'perfByStrategy', type: 'json', nullable: true })
  perfByStrategy: Record<string, unknown> | null;

  /** Performance by option type CE/PE (JSON). */
  @Column({ name: 'perfByType', type: 'json', nullable: true })
  perfByType: Record<string, unknown> | null;

  /** Performance by expiry (JSON). */
  @Column({ name: 'perfByExpiry', type: 'json', nullable: true })
  perfByExpiry: Record<string, unknown> | null;

  /** Performance by time of day bucket (JSON). */
  @Column({ name: 'perfByTimeOfDay', type: 'json', nullable: true })
  perfByTimeOfDay: Record<string, unknown> | null;

  /** Entry/exit statistics (JSON). */
  @Column({ name: 'entryExitStats', type: 'json', nullable: true })
  entryExitStats: Record<string, unknown> | null;

  /** AI-readable analysis section (text). */
  @Column({ type: 'text', nullable: true })
  aiAnalysis: string | null;

  /** Full Markdown report body. */
  @Column({ type: 'text', nullable: true })
  markdown: string | null;

  /** Generation timestamp. */
  @Column({ name: 'generatedAt', type: 'datetime' })
  generatedAt: Date;

  // ---- isolation / provenance ----
  @Column({ length: 16, default: 'UPSTOX' })
  dataSource: string;

  @Column({ length: 16, default: 'PAPER' })
  executionMode: string;

  @CreateDateColumn()
  createdAt: Date;
}
