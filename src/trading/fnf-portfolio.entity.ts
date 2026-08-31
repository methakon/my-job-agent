import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

/** FNF portfolio — the money envelope the agent trades within. */
@Entity('fnf_portfolios')
export class FnfPortfolio {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Human label, e.g. "main". */
  @Column({ type: 'varchar', length: 64, default: 'main' })
  label: string;

  /** Total capital allocated to this portfolio (the money limit). INR. */
  @Column({ type: 'decimal', precision: 14, scale: 2, default: 0 })
  capital: number;

  /** Amount already deployed into open positions. INR. */
  @Column({ type: 'decimal', precision: 14, scale: 2, default: 0 })
  deployed: number;

  /** Total realized + unrealized P&L across lifetime. INR. */
  @Column({ type: 'decimal', precision: 14, scale: 2, default: 0 })
  netPnl: number;

  /** Cumulative brokerage + tax + fees paid. INR. */
  @Column({ type: 'decimal', precision: 14, scale: 2, default: 0 })
  totalCost: number;

  /** Auto-trading enabled on this portfolio. */
  @Column({ type: 'boolean', default: false })
  autoTradeEnabled: boolean;

  /** Hard money limit (ceiling). Agent will not exceed this. INR. */
  @Column({ type: 'decimal', precision: 14, scale: 2, default: 0 })
  ceiling: number;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
