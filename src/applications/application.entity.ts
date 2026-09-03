import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

@Entity('applications')
export class Application {
	@PrimaryGeneratedColumn('uuid')
	id!: string;

	/** FK to job_leads.id */
	@Column({
		type: 'varchar', length: 36
	})
	@Index('idx_app_lead')
	leadId!: string;

	@Column({
		type: 'varchar', length: 30
	})
	source!: string;

	@Column({
		type: 'varchar', length: 120, default: 'queued'
	})
	status!: string;

	@Column({ type: 'text', nullable: true })
	coverLetter!: string | null;

	@Column({
		type: 'varchar', length: 255, nullable: true,
		comment: 'path of tailored CV variant used'
	})
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

	/**
	 * Sandbox flag (user rule): while SANDBOX=true the agent runs the whole
	 * pipeline (scout, score, tailor CV, compose, "submit") but does NOT
	 * actually send anything — the row is marked is_sandbox=1 and status
	 * 'sandboxed'. Real mode (SANDBOX unset/false) ignores these rows.
	 */
	@Column({ type: 'tinyint', width: 1, default: 0 })
	isSandbox!: boolean;

	/** When the application email / submission was actually sent. */
	@Column({ type: 'datetime', nullable: true, name: 'sent_at' })
	sentAt!: Date | null;

	/** Free-text note (e.g. follow-up timestamp, manual override reason). */
	@Column({ type: 'text', nullable: true })
	note!: string | null;

	/** Applicant name (pre-filled from profile or manual entry). */
	@Column({ type: 'varchar', length: 255, nullable: true })
	applicant!: string | null;

	@CreateDateColumn({ name: 'created_at' })
	createdAt!: Date;

	@UpdateDateColumn({ name: 'updated_at' })
	updatedAt!: Date;
}
