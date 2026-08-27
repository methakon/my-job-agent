import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import { ImapFlow } from 'imapflow';
import { simpleParser, ParsedMail } from 'mailparser';
import * as crypto from 'crypto';
import { StatusUpdate } from './status-update.entity';
import { ApplicationRepository } from './application.repository';
import { MailAccount } from './mail-account.entity';

const STATUS_KEYWORDS: Array<[string, RegExp]> = [
	['rejected', /(unfortunately|not moving forward|regret to inform|decided not to)/i],
	['interview', /(interview|schedule a call|availability for a call)/i],
	['offer', /(offer letter|pleasure to offer|compensation package)/i],
	['in_review', /(reviewing your application|under review|shortlisted|next steps)/i],
	['viewed', /(your application.*(viewed|received)|thank you for applying)/i],
];

/**
 * EmailTracker — polls EVERY active mailbox in mail_accounts (Gmail primary,
 * backup, and any new sending account like swarna.s.jobs@gmail.com) via IMAP
 * using the encrypted app-passwords already stored in the DB (user rule:
 * credentials live in mail_accounts, never .env). Each employer reply is
 * stored as a StatusUpdate with the original HTML body preserved and its
 * received date (created_at) so tracking is date-wise.
 *
 * 2026-08-28: rewired from IMAP_HOST/IMAP_USER/IMAP_PASSWORD env vars (which
 * were never set) to the mail_accounts table — the old path silently did
 * nothing, so no reply was ever tracked.
 */
@Injectable()
export class EmailTrackerService {
	private readonly logger = new Logger(EmailTrackerService.name);
	private running = false;

	constructor(
		@InjectRepository(StatusUpdate) private readonly repo: Repository<StatusUpdate>,
		@InjectRepository(MailAccount) private readonly mailRepo: Repository<MailAccount>,
		private readonly appRepo: ApplicationRepository,
		private readonly config: ConfigService,
	) {}

	private decrypt(enc: string): string {
		const [ivHex, dataHex] = enc.split(':');
		const key = crypto.createHash('sha256').update(this.config.get<string>('APP_SECRET') ?? '').digest();
		const d = crypto.createDecipheriv('aes-256-cbc', key, Buffer.from(ivHex, 'hex'));
		return Buffer.concat([d.update(Buffer.from(dataHex, 'hex')), d.final()]).toString('utf8');
	}

	/** Every 30 minutes, check all mailboxes for employer replies. */
	@Interval(30 * 60 * 1000)
	async pollScheduled(): Promise<void> {
		await this.poll();
	}

	async poll(): Promise<number> {
		if (this.running) return 0;
		this.running = true;
		let stored = 0;
		try {
			const accounts = await this.mailRepo.find({ where: { active: true }, order: { isPrimary: 'DESC' } });
			if (accounts.length === 0) {
				this.logger.warn('no active mail_accounts — skipping email tracking');
				return 0;
			}
			for (const account of accounts) {
				const client = new ImapFlow({
					host: account.provider === 'gmail' ? 'imap.gmail.com' : 'outlook.office365.com',
					port: 993,
					secure: true,
					auth: { user: account.email, pass: this.decrypt(account.passwordEnc) },
					logger: false,
				});
				try {
					await client.connect();
					const lock = await client.getMailboxLock('INBOX');
					try {
						// last 7 days, unread + read job-related mail
						for await (const msg of client.fetch({ since: new Date(Date.now() - 7 * 864e5) }, { envelope: true, source: true })) {
							if (!msg.source) continue;
							const parsed = await simpleParser(msg.source);
							stored += await this.processEmail(parsed, account);
						}
					} finally {
						lock.release();
					}
					await client.logout();
				} catch (err) {
					this.logger.warn(`email poll failed on ${account.email}: ${String(err).slice(0, 200)}`);
					await client.logout().catch(() => undefined);
				}
			}
		} finally {
			this.running = false;
		}
		return stored;
	}

	private async processEmail(email: ParsedMail, account: MailAccount): Promise<number> {
		const subject = email.subject ?? '';
		const text = String(email.html ?? email.text ?? '');
		const hit = STATUS_KEYWORDS.find(([, re]) => re.test(subject) || re.test(text.slice(0, 5000)));
		if (!hit) return 0;

		const company = this.extractCompany(email.from?.text ?? '');
		const apps = await this.appRepo.findRecent(300);
		const app = apps.find((a) => company && a.source && subject.toLowerCase().includes(company.toLowerCase()));
		// dedupe per mailbox so the same subject on the old and the new account both count
		const dedupeKey = `email:${account.email}:${subject}:${email.date?.toISOString() ?? ''}`;

		const existing = await this.repo.findOne({
			where: { subject: dedupeKey.slice(0, 255) },
		});
		if (existing) return 0;

		await this.repo.save(this.repo.create({
			applicationId: app?.id ?? 'unmatched',
			status: hit[0],
			sourceType: 'email',
			subject: dedupeKey.slice(0, 255),
			contentHtml: text.slice(0, 500000),
		}));
		this.logger.log(`stored status update "${hit[0]}" from ${account.email}: ${subject}`);
		return 1;
	}

	private extractCompany(fromText: string): string | null {
		// "Hiring Team <jobs@acme.com>" → acme
		const m = fromText.match(/<[^>]*@([a-z0-9-]+)\./i);
		return m ? m[1] : null;
	}

	listFor(applicationId: string): Promise<StatusUpdate[]> {
		return this.repo.find({ where: { applicationId }, order: { createdAt: 'DESC' } });
	}
}
