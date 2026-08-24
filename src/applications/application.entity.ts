import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

@Entity('applications')
export class Application {
	@PrimaryGeneratedColumn('uuid')
	id!: string;

	/** FK to job_leads.id */
	@Column({ length: 36 })
	@Index()
	leadId!: string;

	@Column({ length: 30 })
	source!: string;

	@Column({ length: 20, default: 'queued' })
	status!: string; // queued | needs_info | submitting | submitted | failed

	@Column({ type: 'text', nullable: true })
	coverLetter!: string | null;

	@Column({ length: 255, nullable: true, comment: 'path of tailored CV variant used' })
	cvPath!: string | null;

	/** JSON array of [{question, answer}] actually submitted */
	@Column({ type: 'text', nullable: true })
	questionsJson!: string | null;

	/** What stopped a needs_info application. */
	@Column({ type: 'text', nullable: true })
	missingInfoJson!: string | null;

	@Column({ type: 'text', nullable: true })
	errorDetail!: string | null;

	@CreateDateColumn({ name: 'created_at' })
	createdAt!: Date;

	@UpdateDateColumn({ name: 'updated_at' })
	updatedAt!: Date;
}
