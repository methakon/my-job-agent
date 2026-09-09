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

	/** IMAP host (e.g. 'imap.gmail.com', 'outlook.office365.com') */
	@Column({ type: 'varchar', length: 255, nullable: true })
	imapHost!: string | null;

	/** IMAP port (default 993) */
	@Column({ type: 'int', default: 993 })
	imapPort!: number;

	/** Enable/disable IMAP for this account */
	@Column({ type: 'tinyint', width: 1, default: 1 })
	useImap!: boolean;

	/** Is password a Google App Password (vs OAuth or regular password) */
	@Column({ type: 'tinyint', width: 1, default: 0 })
	isAppPassword!: boolean;

	/** Count of consecutive IMAP failures */
	@Column({ type: 'int', default: 0 })
	imapFailureCount!: number;

	/** Last successful IMAP connection */
	@Column({ type: 'datetime', nullable: true })
	lastImapSuccess!: Date | null;

	/** Notes/description for this account */
	@Column({ type: 'text', nullable: true })
	notes!: string | null;

	@CreateDateColumn({ name: 'created_at' })
	createdAt!: Date;

	@UpdateDateColumn({ name: 'updated_at' })
	updatedAt!: Date;
}