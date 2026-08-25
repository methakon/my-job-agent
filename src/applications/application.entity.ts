import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

@Entity('applications')
export class Application {
	@PrimaryGeneratedColumn('uuid')
	id!: string;

	/** FK to job_leads.id */
	@Column({
	type: 'varchar', length: 36 })
	@Index('idx_app_lead')
	leadId!: string;

	@Column({
	type: 'varchar', length: 30 })
	source!: string;

	@Column({
	type: 'varchar', length: 20, default: 'queued' })
	status!: string; // queued | needs_info | submitting | submitted | failed

	@Column({ type: 'text', nullable: true })
	coverLetter!: string | null;

	@Column({
	type: 'varchar', length: 255, nullable: true, comment: 'path of tailored CV variant used' })
	cvPath!: string | null;

	/** JSON array of [{question, answer}] actually submitted */
	@Column({ type: 'text', nullable: true })
	questionsJson!: string | null;

	/** What stopped a needs_info application. */
	@Column({ type: 'text', nullable: true })
	missingInfoJson!: string | null;

	@Column({ type: 'text', nullable: true })
	errorDetail!: string | null;

	/** How many backoff retries have been made (0 = never retried). */
	@Column({ type: 'int', default: 0 })
	retryCount!: number;

	@CreateDateColumn({ name: 'created_at' })
	createdAt!: Date;

	@UpdateDateColumn({ name: 'updated_at' })
	updatedAt!: Date;
}
