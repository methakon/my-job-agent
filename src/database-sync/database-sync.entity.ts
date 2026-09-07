import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

export type SyncDirection = 'ORACLE_TO_LOCAL' | 'LOCAL_TO_ORACLE';
export type SyncStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'BLOCKED';

@Entity('database_sync_audit')
export class DatabaseSyncAudit {
	@PrimaryGeneratedColumn('uuid')
	id: string;

	@Column({ type: 'varchar', length: 32 })
	direction: SyncDirection;

	@Column({ type: 'varchar', length: 128 })
	tableName: string;

	@Column({ type: 'datetime' })
	startedAt: Date;

	@Column({ type: 'datetime', nullable: true })
	completedAt: Date;

	@Column({ type: 'varchar', length: 16 })
	status: SyncStatus;

	@Column({ type: 'int', default: 0 })
	rowsRead: number;

	@Column({ type: 'int', default: 0 })
	rowsInserted: number;

	@Column({ type: 'int', default: 0 })
	rowsUpdated: number;

	@Column({ type: 'int', default: 0 })
	rowsSkipped: number;

	@Column({ type: 'int', default: 0 })
	rowsFailed: number;

	@Column({ type: 'text', nullable: true })
	checkpointBefore: string;

	@Column({ type: 'text', nullable: true })
	checkpointAfter: string;

	@Column({ type: 'int', default: 0 })
	retryCount: number;

	@Column({ type: 'text', nullable: true })
	errorSummary: string;

	@CreateDateColumn()
	createdAt: Date;
}
