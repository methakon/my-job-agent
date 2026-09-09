import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, ManyToOne, JoinColumn, Index } from 'typeorm';
import { UpstoxLivePaperTrade } from './upstox-live-paper-trade.entity';

/**
 * Simulated order + fill log for the Upstox LIVE paper engine.
 *
 * Records every simulated order/partial-fill so the system can reconstruct
 * entry/exit quality, slippage, spread capture, and partial-fill behaviour.
 *
 * Isolation:
 *  - PAPER-only table; brokerOrderId is always null in PAPER mode.
 *  - Tagged dataSource=UPSTOX, executionMode=PAPER.
 */
@Entity('upstox_live_paper_orders')
@Index('idx_ulpo_trade', ['tradeId'])
@Index('idx_ulpo_status', ['status'])
@Index('idx_ulpo_created', ['createdAt'])
export class UpstoxLivePaperOrder {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Trade this simulated order belongs to. */
  @Column({ name: 'tradeId', length: 36 })
  tradeId: string;

  @ManyToOne(() => UpstoxLivePaperTrade, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tradeId' })
  trade: UpstoxLivePaperTrade;

  /** Hermies-generated simulated order id. */
  @Column({ name: 'simulatedOrderId', length: 64 })
  simulatedOrderId: string;

  /** Always null in PAPER mode. */
  @Column({ type: 'varchar',  name: 'brokerOrderId', length: 64, nullable: true })
  brokerOrderId: string | null;

  @Column({ length: 8 })
  side: 'BUY' | 'SELL';

  @Column()
  quantity: number; // units requested

  @Column({ name: 'filledQuantity', default: 0 })
  filledQuantity: number; // units filled so far

  @Column({ length: 16, default: 'PENDING' })
  status: 'PENDING' | 'PARTIAL' | 'FILLED' | 'REJECTED' | 'CANCELLED';

  /** Simulated fill price per unit (for the filled portion). */
  @Column({ name: 'fillPrice', type: 'decimal', precision: 14, scale: 4, default: 0 })
  fillPrice: number;

  /** Ask price used for BUY simulated fills, bid for SELL. */
  @Column({ name: 'referencePrice', type: 'decimal', precision: 14, scale: 4, nullable: true })
  referencePrice: number | null;

  /** Spread at fill time (ask-bid as percentage of mid, or zero if unavailable). */
  @Column({ name: 'spreadPct', type: 'decimal', precision: 8, scale: 4, default: 0 })
  spreadPct: number;

  /** Simulated slippage applied as percentage of fill price. */
  @Column({ name: 'slippagePct', type: 'decimal', precision: 8, scale: 4, default: 0 })
  slippagePct: number;

  /** Timestamp of the market quote used for this fill. */
  @Column({ name: 'fillQuoteTs', type: 'datetime', nullable: true })
  fillQuoteTs: Date | null;

  /** Why the order was rejected/cancelled, if applicable. */
  @Column({ type: 'varchar',  length: 255, nullable: true })
  rejectReason: string | null;

  // ---- isolation / provenance ----
  @Column({ length: 16, default: 'UPSTOX' })
  dataSource: string;

  @Column({ length: 16, default: 'PAPER' })
  executionMode: string;

  @CreateDateColumn()
  createdAt: Date;

  @Column({ type: 'datetime', nullable: true })
  updatedAt: Date | null;
}
