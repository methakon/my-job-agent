import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/** Portal operator identity — one row for the owner.
 *  Identity/lookup fields (email) stay plaintext; everything credential-like or
 *  personal is AES-256-CBC encrypted under ENCRYPTION_KEY (see EncryptionService),
 *  stored as `iv:cipher` hex in the *_enc columns. */
@Entity('portal_users')
export class PortalUser {
	@PrimaryGeneratedColumn('uuid')
	id!: string;

	@Index({ unique: true })
	@Column({ type: 'varchar', length: 190 })
	email!: string;

	@Column({ type: 'varchar', length: 120 })
	name!: string;

	/** role: operator | admin | readonly */
	@Column({ type: 'varchar', length: 24, default: 'operator' })
	role!: string;

	/** AES-encrypted portal login password (plaintext SESSION_PASSWORD when
	 *  this row is the seed source). Decrypt via EncryptionService. */
	@Column({ type: 'text', nullable: true })
	passwordEnc!: string | null;

	/** AES-encrypted JSON blob of non-secret profile details
	 *  (birth details, astro profile, location, etc). */
	@Column({ type: 'text', nullable: true })
	profileEnc!: string | null;

	/** AES-encrypted JSON map of machine credentials (mail IMAP/SMTP, broker,
	 *  mysql) — `{ "key": "<iv:cipher>" }`. Kept out of .env long-term. */
	@Column({ type: 'text', nullable: true })
	credentialsEnc!: string | null;

	@CreateDateColumn()
	createdAt!: Date;

	@UpdateDateColumn()
	updatedAt!: Date;
}
