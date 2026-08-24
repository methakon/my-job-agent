import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

@Entity('candidate_profile')
export class CandidateProfile {
	@PrimaryGeneratedColumn('uuid')
	id!: string;

	@Column({
	type: 'varchar', length: 120 })
	name!: string;

	@Column({
	type: 'varchar', length: 180, nullable: true })
	email!: string;

	@Column({
	type: 'varchar', length: 40, nullable: true })
	phone!: string;

	/** Comma-separated skill tags. */
	@Column({ type: 'text', nullable: true })
	skills!: string | null;

	@Column({
	type: 'varchar', length: 160, nullable: true })
	headline!: string | null;

	@Column({ type: 'decimal', precision: 4, scale: 1, nullable: true })
	experienceYears!: number | null;

	@Column({
	type: 'varchar', length: 60, nullable: true, comment: 'immediate|15|30|60 days' })
	noticePeriod!: string | null;

	@Column({ type: 'varchar', length: 255, nullable: true, comment: 'expected salary with currency' })
	salaryExpectation!: string | null;

	@Column({
	type: 'varchar', length: 255, nullable: true })
	linkedinUrl!: string | null;

	@Column({
	type: 'varchar', length: 255, nullable: true })
	githubUrl!: string | null;

	@Column({
	type: 'varchar', length: 255, nullable: true })
	portfolioUrl!: string | null;

	@Column({
	type: 'varchar', length: 180, nullable: true })
	currentLocation!: string | null;

	/** JSON array [{company, role, from, to, summary}] */
	@Column({ type: 'text', nullable: true })
	workHistoryJson!: string | null;

	@CreateDateColumn({ name: 'created_at' })
	createdAt!: Date;

	@UpdateDateColumn({ name: 'updated_at' })
	updatedAt!: Date;
}
