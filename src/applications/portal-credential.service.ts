import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { MailAccount } from './mail-account.entity';

/**
 * PortalCredentialService — stores portal login credentials (Naukri, Monster,
 * LinkedIn session cookies…) in DB encrypted with AES-256 (same scheme as
 * mail_accounts). Reuses mail_accounts table with provider='portal:<name>'.
 */
const PORTAL_PREFIX = 'portal:';

@Injectable()
export class PortalCredentialService {
	private readonly logger = new Logger(PortalCredentialService.name);

	constructor(
		@InjectRepository(MailAccount) private readonly repo: Repository<MailAccount>,
		private readonly config: ConfigService,
	) {}

	private key(): Buffer {
		return crypto.createHash('sha256').update(this.config.get<string>('APP_SECRET') ?? '').digest();
	}

	encrypt(plain: string): string {
		const iv = crypto.randomBytes(16);
		const c = crypto.createCipheriv('aes-256-cbc', this.key(), iv);
		return `${iv.toString('hex')}:${Buffer.concat([c.update(plain, 'utf8'), c.final()]).toString('hex')}`;
	}

	decrypt(enc: string): string {
		const [ivHex, dataHex] = enc.split(':');
		const d = crypto.createDecipheriv('aes-256-cbc', this.key(), Buffer.from(ivHex, 'hex'));
		return Buffer.concat([d.update(Buffer.from(dataHex, 'hex')), d.final()]).toString('utf8');
	}

	async savePortalCredential(portal: string, username: string, secretPlain: string): Promise<MailAccount> {
		let row = await this.repo.findOne({ where: { email: `${PORTAL_PREFIX}${portal}:${username}` } });
		if (!row) {
			row = this.repo.create({ email: `${PORTAL_PREFIX}${portal}:${username}` });
		}
		row.provider = `${PORTAL_PREFIX}${portal}`;
		row.smtpHost = null;
		row.smtpPort = 0;
		row.passwordEnc = this.encrypt(secretPlain);
		return this.repo.save(row);
	}

	async getPortalSecret(portal: string, username?: string): Promise<{ username: string; secret: string } | null> {
		const where = username
			? { email: `${PORTAL_PREFIX}${portal}:${username}` }
			: { provider: `${PORTAL_PREFIX}${portal}` };
		const rows = await this.repo.find({ where });
		if (rows.length === 0) return null;
		const row = username ? rows[0] : rows[0];
		return {
			username: row.email.replace(`${PORTAL_PREFIX}${portal}:`, ''),
			secret: this.decrypt(row.passwordEnc),
		};
	}
}
