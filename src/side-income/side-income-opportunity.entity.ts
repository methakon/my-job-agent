import { Entity, Column, CreateDateColumn, UpdateDateColumn, PrimaryColumn, Index } from 'typeorm';

@Entity('side_income_opportunities')
export class SideIncomeOpportunity {
	@PrimaryColumn({ type: 'varchar', length: 36 })
	id: string;

	@Index()
	@Column({ length: 120 })
	provider: string;

	@Column({ length: 160 })
	title: string;

	@Column({ length: 30 })
	model: string;

	@Column({ type: 'text' })
	description: string;

	@Column({ length: 10 })
	involvement: string;

	@Column({ length: 20, default: 'researched' })
	status: string;

	@CreateDateColumn({ type: 'datetime', precision: 6 })
	createdAt: Date;

	@UpdateDateColumn({ type: 'datetime', precision: 6 })
	updatedAt: Date;

	@Column({ type: 'text', nullable: true })
	costBreakdownJson: string;

	@Column({ type: 'text', nullable: true })
	requirementsJson: string;

	@Column({ type: 'text', nullable: true })
	documentsJson: string;

	@Column({ type: 'text', nullable: true })
	howToApply: string;

	@Column({ length: 255, nullable: true })
	applyUrl: string;

	@Column({ type: 'text', nullable: true })
	warningsJson: string;

	@Column({ type: 'int', default: 0 })
	fitScore: number;

	@Column({ length: 60, nullable: true })
	investmentRange: string;

	@Column({ length: 200, nullable: true })
	expectedIncome: string;
}
