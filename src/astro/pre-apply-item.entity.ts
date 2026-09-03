import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

/** PreApplyItem — one fully-prepared application awaiting user review.
 *  The agent builds the tailored ATS PDF CV, the human email draft, the
 *  detected channel and the astro muhurta plan, then parks it here with
 *  status 'ready'. NOTHING is sent until the user approves it; approved
 *  items are submitted by MuhurtaSendService on its next sweep.
 *  (The sweep records the sweep-time muhurta match % for audit but no
 *  longer gates the send on shubh status.)
 *
 *  Status flow: ready → approved → sent | (hold ⇄ ready) | failed
 */
@Entity('pre_apply_items')
export class PreApplyItem {
	@PrimaryGeneratedColumn('uuid')
	id!: string;

	/** FK → job_leads.id */
	@Column({ type: 'varchar', length: 36 })
	@Index('idx_preapply_lead')
	leadId!: string;

	/** portal/source (adapter name) */
	@Column({ type: 'varchar', length: 30 })
	source!: string;

	/** ready | approved | sent | hold | failed */
	@Column({ type: 'varchar', length: 20, default: 'ready' })
	status!: string;

	/** skill-match score at prepare time (0–100) */
	@Column({ type: 'decimal', precision: 5, scale: 2, default: 0 })
	matchScore!: number;

	/** astro signification score (0–100) from AstroLeadScoringService */
	@Column({ type: 'decimal', precision: 5, scale: 2, default: 0 })
	astroScore!: number;

	/** JSON: astro reasons + muhurta snapshot {score,shubh,label} */
	@Column({ type: 'text', nullable: true })
	astroJson!: string | null;

	/** JSON: planned muhurta window {startsAt,endsAt,score,tithi,nakshatra,weekday} */
	@Column({ type: 'text', nullable: true })
	muhurtaWindowJson!: string | null;

	/** channel plan: {kind: 'email'|'ats'|'portal', target?, detectedBy?} */
	@Column({ type: 'text', nullable: true })
	channelJson!: string | null;

	/** full cover letter / email body that will be sent */
	@Column({ type: 'text', nullable: true })
	coverLetter!: string | null;

	/** composed email subject (email channel only) */
	@Column({ type: 'varchar', length: 255, nullable: true })
	emailSubject!: string | null;

	/** composed email HTML body (email channel only) */
	@Column({ type: 'text', nullable: true })
	emailBody!: string | null;

	/** tailored ATS PDF CV path (built at prepare time) */
	@Column({ type: 'varchar', length: 255, nullable: true })
	cvPath!: string | null;

	/**
	 * manually uploaded corrected CV (user rule): when set, this file is
	 * what gets attached/sent instead of the tailored one.
	 */
	@Column({ type: 'varchar', length: 255, nullable: true })
	userCvPath!: string | null;

	/** error from the last prepare/approve attempt */
	@Column({ type: 'text', nullable: true })
	errorDetail!: string | null;

	/** astrological muhurta match score (0–100) recorded at send time */
	@Column({ type: 'decimal', precision: 5, scale: 2, default: 0 })
	muhurtaMatchScore!: number;

	@Column({ type: 'datetime', nullable: true })
	approvedAt!: Date | null;

	/** when it was actually submitted (status=sent) */
	@Column({ type: 'datetime', nullable: true })
	sentAt!: Date | null;

	@CreateDateColumn({ name: 'created_at' })
	createdAt!: Date;

	@UpdateDateColumn({ name: 'updated_at' })
	updatedAt!: Date;
}
