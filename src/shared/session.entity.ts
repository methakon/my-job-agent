import { Entity, PrimaryColumn, Column, Index } from 'typeorm';

@Entity('sessions')
export class Session {
	@PrimaryColumn({ type: 'varchar', length: 128 })
	sid: string;

	@Column({ type: 'longtext' })
	sess: string;

	@Index()
	@Column({ type: 'datetime' })
	expire: Date;
}
