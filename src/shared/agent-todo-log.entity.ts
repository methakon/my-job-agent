import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

@Entity('agent_todo_log')
export class AgentTodoLog {
	@ PrimaryGeneratedColumn()
	id: number;

	@Column({ type: 'varchar', length: 32, nullable: true })
	todoId: string;

	@Column({ type: 'varchar', length: 255 })
	title: string;

	@Column({ type: 'varchar', length: 16, default: 'pending' })
	status: string;

	@Column({ type: 'text', nullable: true })
	detail: string;

	@UpdateDateColumn({ type: 'timestamp' })
	updatedAt: Date;
}
