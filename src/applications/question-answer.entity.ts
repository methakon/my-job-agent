import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index, Unique } from 'typeorm';

@Entity('question_answers')
@Unique(['questionNormalized'])
export class QuestionAnswer {
	@PrimaryGeneratedColumn('uuid')
	id!: string;

	/** Lowercased, trimmed question text for matching. */
	@Column({ length: 300 })
	@Index()
	questionNormalized!: string;

	/** Original wording as first seen. */
	@Column({ length: 300 })
	questionOriginal!: string;

	@Column({ type: 'text' })
	answer!: string;

	@Column({ length: 20, default: 'auto' })
	origin!: string; // auto (from profile) | manual (user typed)

	@CreateDateColumn({ name: 'created_at' })
	createdAt!: Date;

	@UpdateDateColumn({ name: 'updated_at' })
	updatedAt!: Date;
}
