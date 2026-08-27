import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import * as crypto from 'crypto';
import { MailAccount } from './mail-account.entity';

export interface ApplicationEmail {
	to: string;
	subject: string;
	html: string;
	cvPath?: string;
}

const PROVIDER_SMTP: Record<string, { host: string; port: number }> = {
	gmail: { host: 'smtp.gmail.com', port: 465 },
	outlook: { host: 'smtp.office365.com', port: 587 },
};

/**
 * MailService — sends application emails through the user's own mailboxes
 * (Gmail primary, Outlook backup). App-passwords are stored encrypted in the
 * mail_accounts table (key = APP_SECRET). User completes 2FA once when
 * creating each app-password; no interactive login happens afterwards.
 *
 * Emails are written to sound human — short, specific, no corporate filler.
 */
@Injectable()
export class MailService implements OnModuleInit {
	private readonly logger = new Logger(MailService.name);

	constructor(
		@InjectRepository(MailAccount) private readonly repo: Repository<MailAccount>,
		private readonly config: ConfigService,
	) {}

	onModuleInit(): void {
		const key = this.encryptionKey();
		if (key.equals(Buffer.alloc(32))) this.logger.warn('APP_SECRET not set — stored passwords cannot be encrypted/decrypted');
	}

	private encryptionKey(): Buffer {
		return crypto.createHash('sha256').update(this.config.get<string>('APP_SECRET') ?? '').digest();
	}

	encrypt(plain: string): string {
		const iv = crypto.randomBytes(16);
		const cipher = crypto.createCipheriv('aes-256-cbc', this.encryptionKey(), iv);
		return `${iv.toString('hex')}:${Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]).toString('hex')}`;
	}

	decrypt(enc: string): string {
		const [ivHex, dataHex] = enc.split(':');
		const decipher = crypto.createDecipheriv('aes-256-cbc', this.encryptionKey(), Buffer.from(ivHex, 'hex'));
		return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
	}

	/** Add/update a mailbox. Call once per account; user provides app-password after enabling 2FA. */
	async saveAccount(input: {
		email: string;
		passwordPlain: string;
		provider?: string;
		isPrimary?: boolean;
	}): Promise<MailAccount> {
		const provider = input.provider ?? (input.email.includes('gmail') ? 'gmail' : 'outlook');
		let account = await this.repo.findOne({ where: { email: input.email } });
		if (!account) {
			account = this.repo.create({ email: input.email });
		}
		account.provider = provider;
		const smtp = PROVIDER_SMTP[provider] ?? PROVIDER_SMTP.outlook;
		account.smtpHost = smtp.host;
		account.smtpPort = smtp.port;
		account.passwordEnc = this.encrypt(input.passwordPlain);
		if (input.isPrimary !== undefined) account.isPrimary = input.isPrimary;
		return this.repo.save(account);
	}

	listAccounts(): Promise<MailAccount[]> {
		return this.repo.find();
	}

	private async transportFor(account: MailAccount): Promise<nodemailer.Transporter> {
		return nodemailer.createTransport({
			host: account.smtpHost ?? PROVIDER_SMTP[account.provider]?.host,
			port: account.smtpPort,
			secure: account.smtpPort === 465,
			auth: { user: account.email, pass: this.decrypt(account.passwordEnc) },
		});
	}

	/** Try primary first, then backup accounts. Daily cap per mailbox keeps volume human. */
	async send(app: ApplicationEmail): Promise<{ ok: boolean; via?: string; error?: string }> {
		// Daily rollover: the 15/day mailbox cap resets with the calendar
		// (2026-08-27 defect: a stale sentToday permanently blocked the only
		// active mailbox, so every send fell through to dead portal rows).
		const today = new Date().toDateString();
		const accounts = (await this.repo.find({ where: { active: true }, order: { isPrimary: 'DESC' } }))
			.map((a) => {
				if (a.sentToday > 0 && a.lastSentAt && new Date(a.lastSentAt).toDateString() !== today) a.sentToday = 0;
				return a;
			})
			.filter((a) => a.sentToday < 15);
		if (accounts.length === 0) return { ok: false, error: 'no-active-mail-account' };

		for (const account of accounts) {
			try {
				const transport = await this.transportFor(account);
				await transport.sendMail({
					from: `"Swarna Sekhar Dhar" <${account.email}>`,
					to: app.to,
					subject: app.subject,
					html: app.html.replace(/\n/g, '<br>'),
					attachments: app.cvPath ? [{ path: app.cvPath }] : [],
				});
				account.sentToday += 1;
				account.lastSentAt = new Date();
				await this.repo.save(account);
				this.logger.log(`application sent via ${account.email} -> ${app.to}`);
				return { ok: true, via: account.email };
			} catch (err) {
				this.logger.warn(`send failed via ${account.email}: ${String(err).slice(0, 150)} — trying next`);
			}
		}
		return { ok: false, error: 'all-mail-accounts-failed' };
	}
}
