import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

@Entity('interview_questions')
@Index(['topic'])
export class InterviewQuestion {
	@PrimaryGeneratedColumn('uuid')
	id!: string;

	@Column({
	type: 'varchar', length: 60 })
	topic!: string; // nestjs | typescript | mysql | system-design | hr | behavioral ...

	@Column({ type: 'text' })
	question!: string;

	@Column({ type: 'text', nullable: true })
	answerGuide!: string | null;

	/** difficulty 1-5 */
	@Column({ type: 'int', default: 3 })
	difficulty!: number;

	@CreateDateColumn({ name: 'created_at' })
	createdAt!: Date;
}
