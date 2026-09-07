import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, ManyToOne, JoinColumn, Index } from 'typeorm';
import { FnfPortfolio } from './fnf-portfolio.entity';

export enum TradeSide { BUY = 'BUY', SELL = 'SELL' }
export enum TradeStatus { OPEN = 'OPEN', CLOSED = 'CLOSED', CANCELLED = 'CANCELLED' }

/** One position the agent took. Every field the user asked for is tracked here. */
@Entity('fnf_trades')
@Index('idx_trades_mode', ['onRealData', 'executionProvider', 'executionMode'])
@Index('idx_trades_status_mode', ['status', 'onRealData'])
export class FnfTrade {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => FnfPortfolio, { onDelete: 'CASCADE' })
  @JoinColumn()
  portfolio: FnfPortfolio;

  /** Instrument: NSE:NIFTY50, NSE:SENSEX, NSE:RELIANCE, etc. */
  @Column({ type: 'varchar', length: 64 })
  instrument: string;

  /** BUY or SELL. */
  @Column({ type: 'varchar', length: 8 })
  side: string;

  /** Quantity of units/contracts. */
  @Column({ type: 'int' })
  quantity: number;

  /** Entry price (INR per unit, or per lot for indices). */
  @Column({ type: 'decimal', precision: 14, scale: 2 })
  entryPrice: number;

  /** Exit price (0 if still open). */
  @Column({ type: 'decimal', precision: 14, scale: 2, default: 0 })
  exitPrice: number;

  /** Gross P&L at exit (INR). */
  @Column({ type: 'decimal', precision: 14, scale: 2, default: 0 })
  grossPnl: number;

  /** Trading cost on this trade (brokerage + tax + fees). INR. */
  @Column({ type: 'decimal', precision: 14, scale: 2, default: 0 })
  cost: number;

  /** Net P&L after cost. */
  @Column({ type: 'decimal', precision: 14, scale: 2, default: 0 })
  netPnl: number;

  /** Current status. */
  @Column({ type: 'varchar', length: 12, default: 'OPEN' })
  status: string;

  /** Order ID from broker (if connected). */
  @Column({ type: 'varchar', length: 64, nullable: true })
  brokerOrderId: string;

  /** Which algorithm/scenario generated this trade. */
  @Column({ type: 'text', nullable: true })
  algoSource: string;

  /** All prediction parameters that were active at entry: price target,
   *  stop-loss, confidence, scenario list, astro match, Friday flag, etc.
   *  Stored as JSON so the page can render the full decision context. */
  @Column({ type: 'text', nullable: true })
  decisionParams: string;

  /** Execution environment: true = real/FYERS pipeline; false = isolated sandbox/paper (Upstox). */
  @Column({ type: 'boolean', default: true })
  onRealData: boolean;

  /** Broker/provider that executed: FYERS (real pipeline) or UPSTOX (sandbox only). */
  @Column({ type: 'varchar', length: 16, default: 'FYERS' })
  executionProvider: string;

  /** Execution mode: REAL (FYERS pipeline) or SANDBOX (Upstox paper). */
  @Column({ type: 'varchar', length: 16, default: 'REAL' })
  executionMode: string;

  /** Timestamp the order was placed. */
  @CreateDateColumn()
  orderedAt: Date;

  /** Timestamp the position was closed (nullable). */
  @Column({ type: 'datetime', nullable: true })
  closedAt: Date;

  /** Decision ID from fnf_decision_journal.linkedDecisionId where available.
   *  Null where the trade was not tied to a DecisionSnapshot (e.g., manual). */
  @Column({ type: 'varchar', length: 64, nullable: true })
  decisionId: string | null;
}
