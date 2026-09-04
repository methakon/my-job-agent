import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/** Point-in-time decision journal (v4/v5 GATE 1). One row per decision cycle of
 *  generateSignals — including NO TRADE — capturing every candidate considered,
 *  every rejection reason, the winner, versions and action family so any
 *  decision can be reproduced/audited later. Detail payloads are JSON text. */
@Entity('fnf_decision_journal')
@Index('idx_journal_ts', ['ts'])
@Index('idx_journal_action', ['actionFamily', 'ts'])
@Index('idx_journal_mode', ['onRealData', 'executionProvider'])
export class FnfDecisionJournal {
	@PrimaryGeneratedColumn('uuid')
	id!: string;

	/** decision time (asOf of the cycle, IST-naive like market snapshots). */
	@Column({ type: 'datetime' })
	ts!: Date;

	/** portfolio the decision was made for (null = UI/no-portfolio query). */
	@Column({ type: 'varchar', length: 64, nullable: true })
	portfolioId!: string | null;

	/** session phase: pre-open | open | post-close | holiday | closed */
	@Column({ type: 'varchar', length: 16, default: '' })
	sessionPhase!: string;

	/** data age at decision (max quote age minutes across considered quotes). */
	@Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
	dataAgeMin!: number;

	/** BUY | HOLD | NO TRADE | REJECT | ERROR */
	@Column({ type: 'varchar', length: 16 })
	actionFamily!: string;

	/** winner symbol when BUY (else ''). */
	@Column({ type: 'varchar', length: 64, default: '' })
	winnerSymbol!: string;

	/** strategy/algo version that produced the decision. */
	@Column({ type: 'varchar', length: 48, default: '' })
	algoSource!: string;

	/** repo SHA / build version captured at boot (set by caller from env). */
	@Column({ type: 'varchar', length: 48, default: '' })
	buildSha!: string;

	/** JSON: { direction, candidates:[{symbol,premium,contractValue,spreadPct,delta,score}...],
	 *  rejected:[reason...], reasons:[...], directionMap } */
	@Column({ type: 'longtext' })
	detailJson!: string;

	/** true = FYERS real pipeline; false = isolated sandbox/paper (Upstox). */
	@Column({ type: 'boolean', default: true })
	onRealData!: boolean;

	/** FYERS (real) | UPSTOX (sandbox). */
	@Column({ type: 'varchar', length: 16, default: 'FYERS' })
	executionProvider!: string;

	/** REAL (FYERS pipeline) | SANDBOX (Upstox paper). */
	@Column({ type: 'varchar', length: 16, default: 'REAL' })
	executionMode!: string;

	@CreateDateColumn()
	createdAt!: Date;
}
