import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/** T-07 — trade-report outbox. The trading agent writes one row per open/close
 *  (plus NO-TRADE sessions), a local poller delivers each row to the configured
 *  messaging channels (Telegram now, WhatsApp when reconnected) via `hermes
 *  send`, then marks it sent. Survives restarts; never loses a report. */
@Entity('fnf_trade_reports')
export class FnfTradeReport {
	@PrimaryGeneratedColumn('uuid')
	id!: string;

	/** report kind: OPEN | CLOSE | NO_TRADE | DAILY | ERROR */
	@Column({ type: 'varchar', length: 16 })
	kind!: string;

	@Column({ type: 'datetime' })
	occurredAt!: Date;

	@Column({ type: 'varchar', length: 64, nullable: true })
	instrument?: string | null;

	@Column({ type: 'varchar', length: 16, nullable: true })
	side?: string | null;

	@Column({ type: 'varchar', length: 32, nullable: true })
	status?: string | null;

	@Column({ type: 'decimal', precision: 14, scale: 2, nullable: true })
	price?: number | null;

	@Column({ type: 'decimal', precision: 14, scale: 2, nullable: true })
	quantity?: number | null;

	@Column({ type: 'decimal', precision: 14, scale: 2, nullable: true })
	netPnl?: number | null;

	@Column({ type: 'decimal', precision: 14, scale: 2, nullable: true })
	ceiling?: number | null;

	/** human text sent to the channel. */
	@Column({ type: 'text' })
	message!: string;

	@Column({ type: 'varchar', length: 24, default: 'pending' })
	delivery!: string; // pending | sent | failed

	@CreateDateColumn()
	createdAt!: Date;
}
