import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { ImapFlow } from 'imapflow';
import { simpleParser, ParsedMail } from 'mailparser';
import { StatusUpdate } from './status-update.entity';
import { ApplicationRepository } from './application.repository';

const STATUS_KEYWORDS: Array<[string, RegExp]> = [
	['rejected', /(unfortunately|not moving forward|regret to inform|decided not to)/i],
	['interview', /(interview|schedule a call|availability for a call)/i],
	['offer', /(offer letter|pleasure to offer|compensation package)/i],
	['in_review', /(reviewing your application|under review|shortlisted|next steps)/i],
	['viewed', /(your application.*(viewed|received)|thank you for applying)/i],
];

/**
 * EmailTracker — polls the user's IMAP inbox (Gmail etc.) for replies about
 * applications and stores each match as a StatusUpdate with the original
 * HTML body preserved.
 */
@Injectable()
export class EmailTrackerService {
	private readonly logger = new Logger(EmailTrackerService.name);

	constructor(
		@InjectRepository(StatusUpdate) private readonly repo: Repository<StatusUpdate>,
		private readonly appRepo: ApplicationRepository,
		private readonly config: ConfigService,
	) {}

	async poll(): Promise<number> {
		const host = this.config.get<string>('IMAP_HOST');
		const user = this.config.get<string>('IMAP_USER');
		const pass = this.config.get<string>('IMAP_PASSWORD');
		if (!host || !user || !pass) {
			this.logger.warn('IMAP not configured (IMAP_HOST/IMAP_USER/IMAP_PASSWORD) — skipping email tracking');
			return 0;
		}
		let stored = 0;
		const client = new ImapFlow({ host, port: Number(this.config.get('IMAP_PORT', 993)), secure: true, auth: { user, pass }, logger: false });
		try {
			await client.connect();
			const lock = await client.getMailboxLock('INBOX');
			try {
				// last 7 days, unread + read job-related mail
				for await (const msg of client.fetch({ since: new Date(Date.now() - 7 * 864e5) }, { envelope: true, source: true })) {
					if (!msg.source) continue;
					const parsed = await simpleParser(msg.source);
					stored += await this.processEmail(parsed);
				}
			} finally {
				lock.release();
			}
			await client.logout();
		} catch (err) {
			this.logger.warn(`email poll failed: ${String(err).slice(0, 200)}`);
		}
		return stored;
	}

	private async processEmail(email: ParsedMail): Promise<number> {
		const subject = email.subject ?? '';
		const text = String(email.html ?? email.text ?? '');
		const hit = STATUS_KEYWORDS.find(([, re]) => re.test(subject) || re.test(text.slice(0, 5000)));
		if (!hit) return 0;

		const company = this.extractCompany(email.from?.text ?? '');
		const apps = await this.appRepo.findRecent(300);
		const app = apps.find((a) => company && a.source && subject.toLowerCase().includes(company.toLowerCase()));
		const dedupeKey = `email:${subject}:${email.date?.toISOString() ?? ''}`;

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
		this.logger.log(`stored status update "${hit[0]}" from email: ${subject}`);
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
