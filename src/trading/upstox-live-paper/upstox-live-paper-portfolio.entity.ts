import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

/**
 * Upstox LIVE paper portfolio — separate from FYERS fnf_portfolios and the
 * existing upstox_portfolios (sandbox) table. Paper capital envelope only.
 *
 * Isolation (spec §3/§12):
 *  - Own table, never touched by FYERS or sandbox logic.
 *  - Tagged dataSource=UPSTOX, executionMode=PAPER by default.
 */
@Entity('upstox_live_paper_portfolios')
@Index('idx_ulpp_capital_mode', ['capital', 'executionMode'])
export class UpstoxLivePaperPortfolio {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Human label, e.g. 'main-live-paper'. */
  @Column({ length: 128, default: 'main-live-paper' })
  label: string;

  /** Total capital allocated to this paper envelope (INR). */
  @Column({ type: 'decimal', precision: 14, scale: 2 })
  capital: number;

  /** Hard money ceiling (INR). */
  @Column({ type: 'decimal', precision: 14, scale: 2 })
  ceiling: number;

  /** Amount deployed into open paper positions (INR, premium outlay). */
  @Column({ type: 'decimal', precision: 14, scale: 2, default: 0 })
  deployed: number;

  /** Lifetime net P&L (realised + unrealised, INR). */
  @Column({ type: 'decimal', precision: 14, scale: 2, default: 0 })
  netPnl: number;

  /** Cumulative simulated brokerage + charges paid (INR). */
  @Column({ type: 'decimal', precision: 14, scale: 2, default: 0 })
  totalCost: number;

  /** Auto-trading enabled on this portfolio. */
  @Column({ default: false })
  autoTradeEnabled: boolean;

  /** Friday trading allowed (default blocked). */
  @Column({ default: false })
  fridayTradingEnabled: boolean;

  /** Separately-tracked unrealised P&L for open positions (INR). */
  @Column({ type: 'decimal', precision: 14, scale: 2, default: 0 })
  unrealisedPnl: number;

  /** Count of currently open paper positions. */
  @Column({ default: 0 })
  openPositionCount: number;

  // ---- isolation / provenance ----
  @Column({ length: 16, default: 'UPSTOX' })
  dataSource: string;

  @Column({ length: 16, default: 'PAPER' })
  executionMode: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
