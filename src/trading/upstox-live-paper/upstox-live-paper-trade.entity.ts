import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn,
  ManyToOne, JoinColumn, Index,
} from 'typeorm';
import { UpstoxLivePaperPortfolio } from './upstox-live-paper-portfolio.entity';

/**
 * One simulated paper trade in the Upstox LIVE paper system.
 *
 * Isolation (spec §3/§12):
 *  - Separate table from FYERS `fnf_trades` and from existing `upstox_trades`.
 *  - Every row is tagged data_source=UPSTOX, execution_mode=PAPER by default.
 *  - Never mixed with FYERS data; broker/source fields allow distinction.
 */
@Entity('upstox_live_paper_trades')
@Index('idx_ulpt_portfolio_status', ['portfolioId', 'status'])
@Index('idx_ulpt_ordered_at', ['orderedAt'])
@Index('idx_ulpt_broker_source', ['dataSource', 'executionMode'])
export class UpstoxLivePaperTrade {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => UpstoxLivePaperPortfolio, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'portfolioId' })
  portfolio: UpstoxLivePaperPortfolio;

  @Column({ name: 'portfolioId', length: 36 })
  portfolioId: string;

  /** Instrument trading symbol, e.g. NIFTY26DEC23500CE. */
  @Column({ length: 64 })
  instrument: string;

  @Column({ length: 8 })
  side: 'BUY' | 'SELL';

  /** Quantity in units (lots × lot size). */
  @Column()
  quantity: number;

  /** Entry premium per unit (paper fill price). */
  @Column({ type: 'decimal', precision: 14, scale: 4 })
  entryPrice: number;

  /** Exit premium per unit (0 while open). */
  @Column({ type: 'decimal', precision: 14, scale: 4, default: 0 })
  exitPrice: number;

  /** Gross P&L at close (premium terms). */
  @Column({ type: 'decimal', precision: 14, scale: 2, default: 0 })
  grossPnl: number;

  /** Simulated cost including brokerage + slippage + charges. */
  @Column({ type: 'decimal', precision: 14, scale: 2, default: 0 })
  cost: number;

  /** Net P&L after simulated cost. */
  @Column({ type: 'decimal', precision: 14, scale: 2, default: 0 })
  netPnl: number;

  @Column({ length: 12, default: 'OPEN' })
  status: 'OPEN' | 'CLOSED' | 'CANCELLED' | 'REJECTED';

  /** Simulated order id (Hermes-generated, not a live Upstox order id). */
  @Column({ type: 'varchar',  length: 64, nullable: true })
  simulatedOrderId: string | null;

  /** Real Upstox order id — always null in PAPER mode. */
  @Column({ type: 'varchar',  length: 64, nullable: true })
  brokerOrderId: string | null;

  /** Algorithm/scenario that generated the trade. */
  @Column({ type: 'text', nullable: true })
  algoSource: string | null;

  /** JSON decision context: target, stop, confidence, market snapshot refs, etc. */
  @Column({ type: 'text', nullable: true })
  decisionParams: string | null;

  /** When the simulated order was placed. */
  @CreateDateColumn({ name: 'orderedAt' })
  orderedAt: Date;

  /** When the position was closed (nullable). */
  @Column({ name: 'closedAt', type: 'datetime', nullable: true })
  closedAt: Date | null;

  // ---- isolation / provenance fields (spec §12) ----
  @Column({ length: 16, default: 'UPSTOX' })
  dataSource: string;

  @Column({ length: 16, default: 'PAPER' })
  executionMode: string;

  /** Timestamp of the quote used for entry price (source of truth for fill price). */
  @Column({ name: 'entryQuoteTs', type: 'datetime', nullable: true })
  entryQuoteTs: Date | null;

  /** Spreads/slippage recorded for this trade. */
  @Column({ name: 'fillSpreadPct', type: 'decimal', precision: 8, scale: 4, default: 0 })
  fillSpreadPct: number;

  @Column({ name: 'fillSlippagePct', type: 'decimal', precision: 8, scale: 4, default: 0 })
  fillSlippagePct: number;

  /** Reject reason when status=REJECTED. */
  @Column({ type: 'varchar',  length: 255, nullable: true })
  rejectReason: string | null;

  /** Optional upstream decision id for audit. */
  @Column({ type: 'varchar',  length: 64, nullable: true })
  decisionId: string | null;
}
