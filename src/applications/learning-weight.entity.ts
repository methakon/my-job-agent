import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

/**
 * LearningWeight (FR-11) — one row per metric key, storing accumulated
 * success/reply counters that tune future application behaviour:
 *   channel:<name>        → {sent, replies} per application channel
 *   keyword:<word>        → reply count for CV/email keyword
 *   hour:<0-23>           → replies by send hour
 *   portal:<source>       → {sent, replies} per job-board source
 */
@Entity('learning_weights')
export class LearningWeight {
	@PrimaryGeneratedColumn('uuid')
	id!: string;

	@Index('idx_lw_key', { unique: true })
	@Column({ type: 'varchar', length: 120 })
	metricKey!: string;

	@Column({ type: 'int', default: 0 })
	sent!: number;

	@Column({ type: 'int', default: 0 })
	replies!: number;

	/** JSON blob for extra stats (e.g. lastOutcomeAt). */
	@Column({ type: 'text', nullable: true })
	extraJson!: string | null;

	@CreateDateColumn({ name: 'created_at' })
	createdAt!: Date;

	@UpdateDateColumn({ name: 'updated_at' })
	updatedAt!: Date;
}
