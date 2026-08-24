import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

@Entity('apply_settings')
export class ApplySetting {
	@PrimaryGeneratedColumn('uuid')
	id!: string;

	/** Portal/source name — one row per adapter. */
	@Column({ length: 30, unique: true })
	source!: string;

	@Column({ type: 'tinyint', width: 1, default: 0 })
	autoApplyEnabled!: boolean;

	@Column({ type: 'int', default: 10 })
	maxPerDay!: number;

	@Column({ type: 'int', default: 60 })
	minutesBetweenApplies!: number;

	/** JSON — source-specific credentials config (cookie names, tokens). Never raw passwords. */
	@Column({ type: 'text', nullable: true })
	authConfigJson!: string | null;

	@Column({ type: 'text', nullable: true })
	notes!: string | null;

	@CreateDateColumn({ name: 'created_at' })
	createdAt!: Date;

	@UpdateDateColumn({ name: 'updated_at' })
	updatedAt!: Date;
}
