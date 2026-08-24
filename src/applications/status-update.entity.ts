import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

@Entity('status_updates')
export class StatusUpdate {
	@PrimaryGeneratedColumn('uuid')
	id!: string;

	/** FK to applications.id */
	@Column({
	type: 'varchar', length: 36 })
	@Index('idx_status_application')
	applicationId!: string;

	@Column({
	type: 'varchar', length: 30 })
	status!: string; // viewed | in_review | interview | offer | rejected | note

	/** portal | email | manual */
	@Column({
	type: 'varchar', length: 20 })
	sourceType!: string;

	@Column({
	type: 'varchar', length: 255, nullable: true })
	subject!: string | null;

	/** Raw HTML body of the source email/page snippet. */
	@Column({ type: 'mediumtext', nullable: true })
	contentHtml!: string | null;

	@CreateDateColumn({ name: 'created_at' })
	createdAt!: Date;

	@UpdateDateColumn({ name: 'updated_at' })
	updatedAt!: Date;
}
