import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/** Spec v2 §2 — Upstox Sandbox tick storage, PHYSICALLY SEPARATE from the FYERS
 *  real tick tables (fnf_market_snapshots / fnf_option_quotes). Sandbox ticks
 *  are collected here for later analysis / strategy testing; they can NEVER
 *  enter the real analytical pipeline because real queries only read the real
 *  tables. Sandbox ingestion is async (background flush) so it never delays the
 *  FYERS real path. Fields map only what the Sandbox API actually provides. */
@Entity('sandbox_ticks')
@Index('idx_sbt_instrument_ts', ['instrument', 'ts'])
@Index('idx_sbt_symbol_ts', ['symbol', 'ts'])
@Index('idx_sbt_env', ['environment', 'onRealData'])
export class SandboxTick {
	@PrimaryGeneratedColumn('uuid')
	id!: string;

	/** e.g. 'NSE:NIFTY 26SEP 24500 CE' or Upstox trading symbol. */
	@Column({ type: 'varchar', length: 96 })
	instrument!: string;

	/** exchange/segment when applicable (NSE/BSE). */
	@Column({ type: 'varchar', length: 16, nullable: true })
	exchangeSegment?: string | null;

	/** Upstox instrument_token / symbol key. */
	@Column({ type: 'varchar', length: 64, nullable: true })
	symbol?: string | null;

	/** event timestamp (market time, sandbox clock). */
	@Column({ type: 'datetime' })
	ts!: Date;

	/** last traded price. */
	@Column({ type: 'decimal', precision: 14, scale: 2 })
	price!: number;

	/** volume/quantity when available. */
	@Column({ type: 'bigint', nullable: true })
	volume?: number | null;

	@Column({ type: 'decimal', precision: 14, scale: 2, nullable: true })
	bidPrice?: number | null;

	@Column({ type: 'decimal', precision: 14, scale: 2, nullable: true })
	askPrice?: number | null;

	@Column({ type: 'int', nullable: true })
	bidQty?: number | null;

	@Column({ type: 'int', nullable: true })
	askQty?: number | null;

	/** option fields when the tick is an option contract. */
	@Column({ type: 'varchar', length: 16, nullable: true })
	expiry?: string | null;

	@Column({ type: 'decimal', precision: 14, scale: 2, nullable: true })
	strike?: number | null;

	@Column({ type: 'varchar', length: 4, nullable: true })
	optionType?: string | null; // CE | PE

	/** data source: always UPSTOX for this table. */
	@Column({ type: 'varchar', length: 24, default: 'UPSTOX' })
	source!: string;

	/** trading environment: always SANDBOX. */
	@Column({ type: 'varchar', length: 16, default: 'SANDBOX' })
	environment!: string;

	/** always false here — sandbox ticks are never real data. */
	@Column({ type: 'boolean', default: false })
	onRealData!: boolean;

	/** Upstox-specific identifiers needed to reconstruct the event. */
	@Column({ type: 'varchar', length: 128, nullable: true })
	upstoxRef?: string | null;

	/** Hermes-side ingestion timestamp. */
	@CreateDateColumn()
	ingestedAt!: Date;
}
