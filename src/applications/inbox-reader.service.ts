import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { ImapFlow } from 'imapflow';
import * as crypto from 'crypto';
import { MailAccount } from './mail-account.entity';

export interface OtpEmail {
	from: string;
	subject: string;
	code: string;
	date: Date | null;
}

/**
 * InboxReaderService — reads mailboxes via IMAP using the SAME encrypted
 * app-passwords stored in mail_accounts (user rule: credentials live in DB).
 *
 * Two jobs:
 *  1. FR-12 OTP reading: portal logins often need email verification codes.
 *     The agent fetches the newest code from the inbox and uses it to
 *     complete signups/logins automatically (e.g. finn.no).
 *  2. Recruiter reply tracking feeds the email-tracker pipeline.
 */
const OTP_SENDER_HINTS = /(finn|naukri|monster|linkedin|indeed|verify|noreply|no-reply|security|account)/i;
const CODE_RE = /\b(\d{6})\b/;

@Injectable()
export class InboxReaderService {
	private readonly logger = new Logger(InboxReaderService.name);

	constructor(
		@InjectRepository(MailAccount) private readonly repo: Repository<MailAccount>,
		private readonly config: ConfigService,
	) {}

	private decrypt(enc: string): string {
		const [ivHex, dataHex] = enc.split(':');
		const key = crypto.createHash('sha256').update(this.config.get<string>('APP_SECRET') ?? '').digest();
		const d = crypto.createDecipheriv('aes-256-cbc', key, Buffer.from(ivHex, 'hex'));
		return Buffer.concat([d.update(Buffer.from(dataHex, 'hex')), d.final()]).toString('utf8');
	}

	/**
	 * Connect to IMAP server with exponential backoff for failed accounts.
	 */
	private async connect(account: MailAccount): Promise<ImapFlow> {
		// Skip if IMAP disabled for this account
		if (account.useImap !== undefined && account.useImap === false) {
			throw new Error(`IMAP disabled for ${account.email}`);
		}

		// Skip if too many recent failures (exponential backoff)
		if (account.imapFailureCount && account.imapFailureCount > 0) {
			const hoursSinceLastFailure = account.lastImapSuccess
				? (Date.now() - account.lastImapSuccess.getTime()) / (60 * 60 * 1000)
				: Infinity;
			
			// Exponential backoff: wait 2^(n-1) hours for n failures
			const backoffHours = Math.pow(2, account.imapFailureCount - 1);
			if (hoursSinceLastFailure < backoffHours) {
				throw new Error(`IMAP backoff for ${account.email}: ${account.imapFailureCount} failures, wait ${backoffHours} hours`);
			}
		}

		const client = new ImapFlow({
			host: account.imapHost || (account.provider === 'gmail' ? 'imap.gmail.com' : 'outlook.office365.com'),
			port: account.imapPort || 993,
			secure: true,
			auth: { user: account.email, pass: this.decrypt(account.passwordEnc) },
			logger: false,
		} as any); // timeout option not in Typescript types but works at runtime

		await client.connect();
		return client;
	}

	private async updateImapStatus(account: MailAccount, success: boolean): Promise<void> {
		try {
			if (success) {
				await this.repo.update(account.id, {
					lastImapSuccess: new Date(),
					imapFailureCount: 0,
				});
			} else {
				await this.repo.update(account.id, {
					imapFailureCount: (account.imapFailureCount || 0) + 1,
				});

				// Auto-disable if 5+ consecutive failures
				if ((account.imapFailureCount || 0) + 1 >= 5) {
					await this.repo.update(account.id, {
						useImap: false,
					});
					this.logger.warn(`Auto-disabled IMAP for ${account.email}: 5+ consecutive failures`);
				}
			}
		} catch (err) {
			this.logger.error(`Failed to update IMAP status for ${account.email}: ${err.message}`);
		}
	}

	/** FR-12: find the newest OTP/verification code, optionally filtered by portal name. */
	async readOtp(portalHint?: string, withinMinutes = 15): Promise<OtpEmail | null> {
		// Only check accounts with active IMAP
		const accounts = await this.repo.find({ 
			where: { 
				active: true, 
				useImap: true 
			}, 
			order: { isPrimary: 'DESC' } 
		});

		if (accounts.length === 0) {
			this.logger.warn('No active IMAP accounts available for OTP reading');
			return null;
		}

		for (const account of accounts) {
			let client: ImapFlow | null = null;
			try {
				client = await this.connect(account);
				const lock = await client.getMailboxLock('INBOX');
				try {
					const since = new Date(Date.now() - withinMinutes * 60_000);
					const candidates: OtpEmail[] = [];
					for await (const msg of client.fetch({ since }, { envelope: true, source: true })) {
						if (!msg.source) continue;
						const body = msg.source.toString();
						const subject = msg.envelope?.subject ?? '';
						const from = msg.envelope?.from?.[0]?.address ?? '';
						const haystack = `${subject} ${from}`;
						const matchesPortal = !portalHint || haystack.toLowerCase().includes(portalHint.toLowerCase());
						if (!matchesPortal || !OTP_SENDER_HINTS.test(haystack)) continue;
						const m = body.match(CODE_RE);
						if (m) candidates.push({ from, subject, code: m[1], date: msg.envelope?.date ?? null });
					}
					candidates.sort((a, b) => (b.date?.getTime() ?? 0) - (a.date?.getTime() ?? 0));
					if (candidates[0]) {
						this.logger.log(`OTP found for ${portalHint ?? 'portal'}: ${candidates[0].code} (${candidates[0].from})`);
						await this.updateImapStatus(account, true);
						return candidates[0];
					}
				} finally {
					lock.release();
				}
				await client.logout();
				await this.updateImapStatus(account, true);
			} catch (err) {
				this.logger.warn(`inbox read failed on ${account.email}: ${String(err).slice(0, 150)}`);
				await this.updateImapStatus(account, false);
				if (client) await client.logout().catch(() => undefined);
			}
		}
		return null;
	}

	/** Poll unread recruiter-ish replies for tracking. Returns subjects seen. */
	async pollReplies(): Promise<string[]> {
		const subjects: string[] = [];
		const accounts = await this.repo.find({ 
			where: { 
				active: true, 
				useImap: true 
			}, 
			order: { isPrimary: 'DESC' } 
		});

		if (accounts.length === 0) {
			this.logger.warn('No active IMAP accounts available for reply polling');
			return subjects;
		}

		for (const account of accounts) {
			let client: ImapFlow | null = null;
			try {
				client = await this.connect(account);
				const lock = await client.getMailboxLock('INBOX');
				try {
					for await (const msg of client.fetch({ since: new Date(Date.now() - 7 * 864e5), seen: false }, { envelope: true })) {
						const subject = msg.envelope?.subject ?? '';
						if (/application|position|role|interview|opportunity|your (cv|resume)/i.test(subject)) {
							subjects.push(`[${account.email}] ${subject}`);
						}
					}
				} finally {
					lock.release();
				}
				await client.logout();
				await this.updateImapStatus(account, true);
			} catch (err) {
				this.logger.warn(`reply poll failed on ${account.email}: ${String(err).slice(0, 120)}`);
				await this.updateImapStatus(account, false);
				if (client) await client.logout().catch(() => undefined);
			}
		}
		return subjects;
	}

	/**
	 * Get IMAP health status for all accounts.
	 */
	async getImapHealth(): Promise<Array<{
		email: string;
		provider: string;
		useImap: boolean;
		imapHost: string;
		imapPort: number;
		isAppPassword: boolean;
		imapFailureCount: number;
		lastImapSuccess: Date | null;
		lastFailureAgeHours: number | null;
		backoffHours: number;
	}>> {
		const accounts = await this.repo.find({
			where: { active: true },
			order: { isPrimary: 'DESC', email: 'ASC' }
		});

		return accounts.map(acc => {
			const lastFailureAgeHours = acc.lastImapSuccess
				? (Date.now() - acc.lastImapSuccess.getTime()) / (60 * 60 * 1000)
				: null;
			
			const backoffHours = (acc.imapFailureCount && acc.imapFailureCount > 0)
				? Math.pow(2, acc.imapFailureCount - 1)
				: 0;

			return {
				email: acc.email,
				provider: acc.provider,
				useImap: acc.useImap ?? true,
				imapHost: acc.imapHost || (acc.provider === 'gmail' ? 'imap.gmail.com' : 'outlook.office365.com'),
				imapPort: acc.imapPort || 993,
				isAppPassword: acc.isAppPassword ?? false,
				imapFailureCount: acc.imapFailureCount || 0,
				lastImapSuccess: acc.lastImapSuccess,
				lastFailureAgeHours,
				backoffHours,
			};
		});
	}
}