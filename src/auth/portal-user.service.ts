import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { PortalUser } from './portal-user.entity';
import { EncryptionService } from './encryption.service';

/** Canonical owner identity (bapay.9@gmail.com / Swarna Sekhar Dhar). */
export const OWNER_EMAIL = 'bapay.9@gmail.com';
export const OWNER_NAME = 'Swarna Sekhar Dhar';

/** Operator identity store: seed-on-boot user row, encrypted credential/profile
 *  vault under ENCRYPTION_KEY. */
@Injectable()
export class PortalUserService implements OnModuleInit {
	private readonly logger = new Logger(PortalUserService.name);

	constructor(
		@InjectRepository(PortalUser) private readonly users: Repository<PortalUser>,
		private readonly config: ConfigService,
		private readonly crypto: EncryptionService,
	) {}

	async onModuleInit(): Promise<void> {
		// Seed in the background — never block app boot on tunnel round-trips.
		void this.ensureOwnerSeeded().catch((e) => this.logger.warn(`owner seed failed: ${(e as Error).message}`));
	}

	/** Seed/refresh the owner row with current .env truth (password + profile). */
	async ensureOwnerSeeded(): Promise<PortalUser> {
		let user = await this.users.findOne({ where: { email: OWNER_EMAIL } });
		if (!user) {
			user = this.users.create({ email: OWNER_EMAIL, name: 'Swarna Sekhar Dhar', role: 'operator' });
			await this.users.save(user);
			this.logger.log(`owner user row seeded (${user.id.slice(0, 8)})`);
		}
		// Password: seed ONLY when the row has none yet (first boot during
		// migration). Never clobber a DB-changed password from a stale .env —
		// once the row is authoritative, .env is ignored (user directive).
		const hasStored = !!user.passwordEnc && this.crypto.decrypt(user.passwordEnc ?? '') !== '';
		const pw = this.config.get<string>('SESSION_PASSWORD') ?? '';
		if (!hasStored && pw) {
			user.passwordEnc = this.crypto.encrypt(pw);
		}
		const profile = {
			name: 'Swarna Sekhar Dhar',
			birthDate: '1981-12-09',
			birthTime: '01:00',
			birthTz: 'IST (UTC+05:30)',
			birthPlace: 'Berhampore, West Bengal, India (24.1N 88.25E)',
			astro: {
				system: 'Lahiri',
				lagna: 'Virgo (Saturn + Mars in lagna)',
				moon: 'Aries (Bharani nakshatra)',
				note: 'DOB flag unresolved: PAN/10th-cert read 09/12/1982 vs chart 09-12-1981 — chart value stored; ask user before changing.',
			},
		};
		const want = JSON.stringify(profile);
		if (this.crypto.decrypt(user.profileEnc ?? '') !== want) {
			user.profileEnc = this.crypto.encrypt(want);
		}
		await this.users.save(user);
		return user;
	}

	async findByEmail(email: string): Promise<PortalUser | null> {
		return this.users.findOne({ where: { email: email.trim().toLowerCase() } });
	}

	/** Verify a password against the owner row; falls back to .env SESSION_PASSWORD
	 *  only while migrating (no row yet). Once the row exists, the DB is
	 *  authoritative and .env is NOT consulted (user directive 2026-09-05). */
	async verifyPassword(email: string, password: string): Promise<boolean> {
		const user = await this.findByEmail(email);
		if (!user) return password === (this.config.get<string>('SESSION_PASSWORD') ?? '');
		const stored = this.crypto.decrypt(user.passwordEnc ?? '');
		if (!stored) return password === (this.config.get<string>('SESSION_PASSWORD') ?? '');
		return stored === password;
	}

	/** Verify against the owner row by the canonical recovery email. */
	async verifyOwnerPassword(password: string): Promise<boolean> {
		return this.verifyPassword(OWNER_EMAIL, password);
	}

	/** Change the owner password: encrypt + persist to DB. Also strips the
	 *  password from .env so the plaintext no longer lives in a tracked file
	 *  (user directive 2026-09-05: "login password should not be in .env"). */
	async changeOwnerPassword(newPassword: string): Promise<boolean> {
		let user = await this.users.findOne({ where: { email: OWNER_EMAIL } });
		if (!user) {
			user = this.users.create({ email: OWNER_EMAIL, name: 'Swarna Sekhar Dhar', role: 'operator' });
		}
		user.passwordEnc = this.crypto.encrypt(newPassword);
		await this.users.save(user);
		// Remove plaintext from .env + process.env so only the DB copy remains.
		try {
			const fs = await import('fs');
			const path = await import('path');
			for (const candidate of ['.env', path.join('..', '..', '.env')]) {
				if (!fs.existsSync(candidate)) continue;
				const raw = fs.readFileSync(candidate, 'utf8');
				const next = raw
					.split('\n')
					.filter((l) => !/^SESSION_PASSWORD=/.test(l))
					.join('\n');
				if (next !== raw) fs.writeFileSync(candidate, next);
			}
			delete process.env.SESSION_PASSWORD;
		} catch (e) {
			this.logger.warn(`env cleanup after password change failed: ${(e as Error).message}`);
		}
		return true;
	}

	/** Decrypted owner password (for forgot-password email). Empty if unset. */
	async ownerPassword(): Promise<string> {
		const user = await this.users.findOne({ where: { email: OWNER_EMAIL } });
		if (!user) return '';
		return this.crypto.decrypt(user.passwordEnc ?? '');
	}

	/** Read encrypted profile details (decrypted). */
	profileOf(user: PortalUser): Record<string, unknown> | null {
		const raw = this.crypto.decrypt(user.profileEnc ?? '');
		if (!raw) return null;
		try {
			return JSON.parse(raw) as Record<string, unknown>;
		} catch {
			return null;
		}
	}
}
