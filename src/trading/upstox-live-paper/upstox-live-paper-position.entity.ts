import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, ManyToOne, JoinColumn, Index } from 'typeorm';
import { UpstoxLivePaperTrade } from './upstox-live-paper-trade.entity';

/**
 * Current paper position snapshot — one row per open position.
 *
 * This is the running position state used for unrealised P&L, margin tracking,
 * and restart recovery. It is derived from trades but persisted so restart can
 * rebuild position state without re-deriving everything from event history.
 *
 * Isolation: PAPER-only, dataSource=UPSTOX, executionMode=PAPER.
 */
@Entity('upstox_live_paper_positions')
@Index('idx_ulpp_portfolio_instrument', ['portfolioId', 'instrument'])
@Index('idx_ulpp_status', ['status'])
export class UpstoxLivePaperPosition {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => UpstoxLivePaperTrade, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'tradeId' })
  trade: UpstoxLivePaperTrade;

  @Column({ name: 'portfolioId', length: 36 })
  portfolioId: string;

  @Column({ type: 'varchar',  length: 36, nullable: true })
  tradeId: string | null;

  /** Instrument trading symbol. */
  @Column({ length: 64 })
  instrument: string;

  @Column({ length: 8 })
  side: 'BUY' | 'SELL';

  /** Current net quantity in units. */
  @Column()
  quantity: number;

  /** Average entry price per unit (paper fill prices). */
  @Column({ type: 'decimal', precision: 14, scale: 4 })
  averagePrice: number;

  /** Last known mark price per unit (from latest live quote). */
  @Column({ name: 'markPrice', type: 'decimal', precision: 14, scale: 4, default: 0 })
  markPrice: number;

  /** Unrealised P&L for this position (INR). */
  @Column({ name: 'unrealisedPnl', type: 'decimal', precision: 14, scale: 2, default: 0 })
  unrealisedPnl: number;

  @Column({ length: 16, default: 'OPEN' })
  status: 'OPEN' | 'CLOSED' | 'FLATTENED';

  /** Timestamp of the last mark-price update. */
  @Column({ name: 'markPriceTs', type: 'datetime', nullable: true })
  markPriceTs: Date | null;

  // ---- isolation / provenance ----
  @Column({ length: 16, default: 'UPSTOX' })
  dataSource: string;

  @Column({ length: 16, default: 'PAPER' })
  executionMode: string;

  @CreateDateColumn()
  createdAt: Date;

  @Column({ type: 'datetime', nullable: true })
  closedAt: Date | null;
}
