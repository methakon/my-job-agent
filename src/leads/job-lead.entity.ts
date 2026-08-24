import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index, Unique } from 'typeorm';

@Entity('job_leads')
@Unique(['source', 'externalId'])
export class JobLead {
	@PrimaryGeneratedColumn('uuid')
	id!: string;

	@Column({
	type: 'varchar', length: 30 })
	source!: string; // remotive | remoteok | wwr | naukri | monster | linkedin

	@Column({
	type: 'varchar', length: 190 })
	externalId!: string;

	@Column({
	type: 'varchar', length: 250 })
	title!: string;

	@Column({
	type: 'varchar', length: 160 })
	company!: string;

	@Column({
	type: 'varchar', length: 180, nullable: true })
	location!: string | null;

	@Column({ type: 'text', nullable: true })
	description!: string | null;

	@Column({
	type: 'varchar', length: 500, nullable: true })
	url!: string | null;

	@Column({ type: 'decimal', precision: 5, scale: 2, default: 0 })
	matchScore!: number;

	@Column({ type: 'simple-json', nullable: true })
	matchedSkills!: string[] | null;

	@Column({
	type: 'varchar', length: 20, default: 'new' })
	status!: string; // new | queued | applied | skipped

	@Column({ type: 'datetime', nullable: true })
	scrapedAt!: Date | null;

	@CreateDateColumn({ name: 'created_at' })
	createdAt!: Date;
}
