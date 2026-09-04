import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/** Reflexion episodic memory (T-08, guidebook-derived → v4 Gate 14).
 *  One row per CLOSED trade: deterministic failure classification + a
 *  structured critique/heuristic that later decisions can retrieve. */
@Entity('fnf_trade_reflections')
@Index('idx_reflections_lookup', ['underlying', 'strategyType', 'createdAt'])
export class FnfTradeReflection {
	@PrimaryGeneratedColumn('uuid')
	id!: string;

	/** FnfTrade id this reflection was produced from. */
	@Column({ type: 'varchar', length: 64 })
	tradeId!: string;

	@Column({ type: 'varchar', length: 40 })
	underlying!: string;

	/** algoSource, e.g. option-candidate-rank-v1 / sma-mean-reversion-v1. */
	@Column({ type: 'varchar', length: 64 })
	strategyType!: string;

	@Column({ type: 'decimal', precision: 14, scale: 2 })
	pnlRealized!: number;

	/** net P&L as % of the entry outlay (units × entry premium). */
	@Column({ type: 'decimal', precision: 10, scale: 2 })
	pnlPct!: number;

	/** holding time in whole minutes. */
	@Column({ type: 'int' })
	holdingMinutes!: number;

	/** exit_trigger: target | stop | manual | time | flatten */
	@Column({ type: 'varchar', length: 16 })
	exitTrigger!: string;

	/** deterministic outcome class: WIN_TARGET, LOSS_STOP, LOSS_MANUAL,
	 *  WIN_MANUAL, TIME_EXIT, … */
	@Column({ type: 'varchar', length: 40 })
	outcomeClass!: string;

	/** short human label of the failure mode, when a loss. */
	@Column({ type: 'varchar', length: 60, default: '' })
	failureTag!: string;

	/** v4/v5 Gate 14 #1 failure family: signal | regime | execution | liquidity |
	 *  data | model | timing | event | risk-veto | none */
	@Column({ type: 'varchar', length: 16, default: 'none' })
	failureFamily!: string;

	/** v4/v5 Gate 14 #5 evidence class. Single-trade critiques start as
	 *  OBSERVATION; promotion to HYPOTHESIS → TESTED_RULE requires repeated
	 *  out-of-sample confirmation (#7/#8) — never auto-promoted from one trade. */
	@Column({ type: 'varchar', length: 20, default: 'OBSERVATION' })
	reflectionClass!: string;

	/** number of confirming observations behind this heuristic (promotion gate). */
	@Column({ type: 'int', default: 1 })
	confirmations!: number;

	/** structured verbal critique composed from outcome facts. */
	@Column({ type: 'text' })
	critique!: string;

	/** an amendable, injectable rule learned from this outcome. */
	@Column({ type: 'text' })
	heuristic!: string;

	@CreateDateColumn()
	createdAt!: Date;
}
