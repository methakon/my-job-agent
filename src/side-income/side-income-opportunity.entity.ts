import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

/**
 * SideIncomeOpportunity — a researched side-income / gig / partnership
 * opportunity (delivery partner, franchise, CSC, etc.) relevant to the
 * user's location (11 Pound Road, Khagra, Berhampore, Murshidabad 742103).
 * Rows are seeded from verified research and refreshed by the scout.
 */
@Entity('side_income_opportunities')
export class SideIncomeOpportunity {
	@PrimaryGeneratedColumn('uuid')
	id!: string;

	@Column({ type: 'varchar', length: 120 })
	@Index('idx_sio_provider')
	provider!: string; // Amazon DSP, Valmo/Meesho, Delhivery, Amazon Easy...

	@Column({ type: 'varchar', length: 160 })
	title!: string;

	/** individual | hub | store | digital */
	@Column({ type: 'varchar', length: 30 })
	model!: string;

	@Column({ type: 'text' })
	description!: string;

	/** JSON: [{item, cost}] breakdown of one-time + monthly costs */
	@Column({ type: 'text', nullable: true })
	costBreakdownJson!: string | null;

	@Column({ type: 'varchar', length: 60, nullable: true })
	investmentRange!: string | null; // "₹50k–₹1.5L"

	@Column({ type: 'varchar', length: 200, nullable: true })
	expectedIncome!: string | null;

	/** JSON array of requirement strings */
	@Column({ type: 'text', nullable: true })
	requirementsJson!: string | null;

	/** JSON array of document strings needed to apply */
	@Column({ type: 'text', nullable: true })
	documentsJson!: string | null;

	@Column({ type: 'text', nullable: true })
	howToApply!: string | null;

	@Column({ type: 'varchar', length: 255, nullable: true })
	applyUrl!: string | null;

	/** JSON array of warning strings (scams, gotchas) */
	@Column({ type: 'text', nullable: true })
	warningsJson!: string | null;

	/** none | low | medium | high — user asked for minimum involvement */
	@Column({ type: 'varchar', length: 10 })
	involvement!: string;

	@Column({ type: 'int', default: 0 })
	fitScore!: number; // agent's fit estimate vs user's constraints

	@Column({ type: 'varchar', length: 20, default: 'researched' })
	status!: string; // researched | applied | in_progress | rejected

	@CreateDateColumn({ name: 'created_at' })
	createdAt!: Date;

	@UpdateDateColumn({ name: 'updated_at' })
	updatedAt!: Date;
}
