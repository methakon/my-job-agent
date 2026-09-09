import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

/**
 * P&L event audit trail for the Upstox LIVE paper system.
 *
 * Every realised/unrealised P&L change is recorded here so the weekly report
 * and anomaly detection can trace exactly when and why P&L moved.
 *
 * Isolation: PAPER-only, dataSource=UPSTOX, executionMode=PAPER.
 */
@Entity('upstox_live_paper_pnl_events')
@Index('idx_ulpe_portfolio', ['portfolioId'])
@Index('idx_ulpe_ts', ['ts'])
@Index('idx_ulpe_type', ['eventType'])
export class UpstoxLivePaperPnlEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'portfolioId', length: 36 })
  portfolioId: string;

  /** Trade id if this event is trade-specific, else null. */
  @Column({ type: 'varchar',  name: 'tradeId', length: 36, nullable: true })
  tradeId: string | null;

  /** eventType: TRADE_OPEN, TRADE_CLOSE, UNREALISED_MARK, DIVIDEND, FEE, SLIPPAGE, ADJUSTMENT. */
  @Column({ length: 32 })
  eventType: string;

  /** P&L delta in INR (positive = gain, negative = loss). */
  @Column({ type: 'decimal', precision: 14, scale: 2 })
  pnlDelta: number;

  /** Running portfolio netPnl after this event. */
  @Column({ name: 'runningNetPnl', type: 'decimal', precision: 14, scale: 2 })
  runningNetPnl: number;

  /** Human-readable description of the event. */
  @Column({ type: 'varchar',  length: 512, nullable: true })
  description: string | null;

  /** JSON context for the event (fill details, quote refs, etc.). */
  @Column({ type: 'text', nullable: true })
  context: string | null;

  // ---- isolation / provenance ----
  @Column({ length: 16, default: 'UPSTOX' })
  dataSource: string;

  @Column({ length: 16, default: 'PAPER' })
  executionMode: string;

  @Column({ type: 'datetime' })
  ts: Date;

  @CreateDateColumn()
  createdAt: Date;
}
