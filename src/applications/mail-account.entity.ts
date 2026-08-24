import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Unique } from 'typeorm';

/**
 * MailAccount — one row per sending mailbox (Gmail primary, Outlook backup).
 * The app-password is stored in the DB (encrypted at rest via APP_SECRET).
 */
@Entity('mail_accounts')
@Unique(['email'])
export class MailAccount {
	@PrimaryGeneratedColumn('uuid')
	id!: string;

	@Column({ type: 'varchar', length: 180 })
	email!: string;

	/** gmail | outlook */
	@Column({ type: 'varchar', length: 20 })
	provider!: string;

	@Column({ type: 'varchar', length: 255, nullable: true })
	smtpHost!: string | null;

	@Column({ type: 'int', default: 587 })
	smtpPort!: number;

	/** App password, encrypted with APP_SECRET before storage. */
	@Column({ type: 'varchar', length: 500 })
	passwordEnc!: string;

	/** primary sends first; backup used on failure. */
	@Column({ type: 'tinyint', width: 1, default: 0 })
	isPrimary!: boolean;

	@Column({ type: 'tinyint', width: 1, default: 1 })
	active!: boolean;

	@Column({ type: 'int', default: 0 })
	sentToday!: number;

	@Column({ type: 'datetime', nullable: true })
	lastSentAt!: Date | null;

	@CreateDateColumn({ name: 'created_at' })
	createdAt!: Date;

	@UpdateDateColumn({ name: 'updated_at' })
	updatedAt!: Date;
}
