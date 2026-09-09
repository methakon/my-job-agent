import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

@Entity('upstox_portfolios')
export class UpstoxPortfolio {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ length: 128 })
  label: string;

  @Column({ type: 'decimal', precision: 14, scale: 2 })
  capital: number;

  @Column({ type: 'decimal', precision: 14, scale: 2, default: 5000.00 })
  ceiling: number;

  @Column({ type: 'decimal', precision: 14, scale: 2 })
  deployed: number;

  @Column({ type: 'decimal', precision: 14, scale: 2 })
  netPnl: number;

  @Column({ type: 'decimal', precision: 14, scale: 2 })
  totalCost: number;

  @Column({ default: false })
  autoTradeEnabled: boolean;

  @Column({ default: false })
  fridayTradingEnabled: boolean;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @Column({ default: true })
  active: boolean;
}

@Entity('upstox_trades')
@Index(['portfolioId', 'status'])
@Index(['orderedAt'])
export class UpstoxTrade {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ length: 36 })
  portfolioId: string;

  @Column({ length: 64 })
  instrument: string;

  @Column({ length: 8 })
  side: 'BUY' | 'SELL';

  @Column()
  quantity: number;

  @Column({ type: 'decimal', precision: 14, scale: 2 })
  entryPrice: number;

  @Column({ type: 'decimal', precision: 14, scale: 2, default: 0.00 })
  exitPrice: number;

  @Column({ type: 'decimal', precision: 14, scale: 2, default: 0.00 })
  grossPnl: number;

  @Column({ type: 'decimal', precision: 14, scale: 2, default: 0.00 })
  cost: number;

  @Column({ type: 'decimal', precision: 14, scale: 2, default: 0.00 })
  netPnl: number;

  @Column({ length: 12, default: 'OPEN' })
  status: 'OPEN' | 'CLOSED' | 'CANCELLED';

  @Column({ nullable: true })
  brokerOrderId: string;

  @Column({ type: 'text', nullable: true })
  algoSource: string;

  @Column({ type: 'text', nullable: true })
  decisionParams: string;

  @Column()
  orderedAt: Date;

  @Column({ nullable: true })
  closedAt: Date;

  @Column({ default: true })
  onRealData: boolean;

  @Column({ length: 16, default: 'UPSTOX' })
  executionProvider: string;

  @Column({ length: 16, default: 'SANDBOX' })
  executionMode: 'SANDBOX' | 'REAL';

  @Column({ nullable: true })
  decisionId: string;

  @Column({ nullable: true })
  exitAlertReason: string;

  @Column({ nullable: true })
  exitAlertAt: Date;

  @Column({ type: 'decimal', precision: 14, scale: 2, nullable: true })
  exitAlertPrice: number;
}