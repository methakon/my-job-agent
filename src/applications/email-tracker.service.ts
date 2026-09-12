import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import { simpleParser, ParsedMail } from 'mailparser';
import * as crypto from 'crypto';
import { StatusUpdate } from './status-update.entity';
import { ApplicationRepository } from './application.repository';
import { MailAccount } from './mail-account.entity';
import {
	createGuardedImapClient,
	imapSkipReason,
	recordImapOutcome,
} from './imap-safety';

const STATUS_KEYWORDS: Array<[string, RegExp]> = [
	['rejected', /(unfortunately|not moving forward|regret to inform|decided not to|no longer under consideration|position has been filled)/i],
	['interview', /(interview|schedule a call|availability for a call|invite you to.*(chat|meet|call)|assessment|take-home|technical round)/i],
	['offer', /(offer letter|pleasure to offer|compensation package|welcome to the team|congratulations.*offer)/i],
	['in_review', /(reviewing your application|under review|shortlisted|next steps|moving forward with your application)/i],
	['viewed', /(your application.*(viewed|received)|thank you for applying|we received your application)/i],
];

/** Subjects that are clearly NOT employer responses — checked before
 *  STATUS_KEYWORDS so newsletters/order confirmations never get stored. */
const NOISE_SUBJECTS: RegExp[] = [
	/order|shipment|delivery|invoice|payment|receipt|refund|ticket received/i,
	/scholarship|grant|funding|contest|giveaway/i,
	/weekly digest|newsletter|new posts|market (update|report)|while IT cuts|top (jobs|companies)|jobs you (may|might)|recommended for you|matches for you/i,
	/reviews? of .*(companies|employers)|rate (your|the) (company|employer)|glassdoor|indeed.*review|see what (employees|people) have to say|you applied to .*(see what|review)/i,
	/your (daily|weekly) (dose|brief)|career (tips|advice)|resume (tips|advice)|interview (tips|questions|prep)/i,
	/training|bootcamp|course|certification|workshop|webinar|cloudops prep|coding interview problems/i,
	/price|sale|discount|offers? (for|from)|deal of the day/i,
	/login|verify (your|the) (account|email)|security alert|password/i,
	/[0-9]+\s*(new\s*)?jobs?\b|job alert/i,
	/unsubscribe|you're receiving this/i,
	/highlight your application|profile (boost|strengthen)|get (more|better) (views|responses)/i,
	/shortlisted.*(unlock|register|guidance|coach)|register now.*unlock|ex-amazon|ex-google|ex-microsoft/i,
	/thanks for completing your application/i, // portal ack (e.g. GetWork), not an employer response
];

/** Generic mailers that are never the employer themselves (job boards etc). */
const NOISE_SENDERS: RegExp[] = [
	/@(indeed|glassdoor|linkedin|naukri|foundit|monster|remotive|remoteok|getro|wellfound|join)\.(com|in|io|co)\b/i,
	/@(linkedin|google|microsoft|outlook)\.com\b/i, // own-account notifications
];

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
				// Shared backoff rule: an account in backoff (or hard-disabled) is not
				// re-polled. Without this the 30-minute interval hammered failing
				// mailboxes and re-triggered the socket-timeout crash every cycle.
				const skip = imapSkipReason(account);
				if (skip) {
					this.logger.warn(`email poll skipped for ${account.email}: ${skip}`);
					continue;
				}
				const { client, trap } = createGuardedImapClient({
					host: account.imapHost || (account.provider === 'gmail' ? 'imap.gmail.com' : 'outlook.office365.com'),
					port: account.imapPort || 993,
					secure: true,
					auth: { user: account.email, pass: this.decrypt(account.passwordEnc) },
					logger: false,
				} as any, (err) => this.logger.warn(`imap socket error on ${account.email}: ${err.message}`));
				try {
					await client.connect();
					const lock = await client.getMailboxLock('INBOX');
					try {
						for await (const msg of client.fetch({ since: new Date(Date.now() - 7 * 864e5) }, { envelope: true, source: true })) {
							if (!msg.source) continue;
							const parsed = await simpleParser(msg.source);
							stored += await this.processEmail(parsed, account);
						}
					} finally {
						lock.release();
					}
					await client.logout();
					await recordImapOutcome(this.mailRepo, account, true);
				} catch (err) {
					this.logger.warn(`email poll failed on ${account.email}: ${String(err).slice(0, 200)}${trap.lastError() ? ` [socket: ${trap.lastError()!.message}]` : ''}`);
					// Counting only: the OTP reader owns the auto-disable decision, so a
					// tracker failure can never silently stop OTP reading on its own.
					await recordImapOutcome(this.mailRepo, account, false, { allowAutoDisable: false });
					await client.logout().catch(() => undefined);
				}
			}
		} finally {
			this.running = false;
		}
		return stored;
	}

	private isNoise(email: ParsedMail, subject: string): boolean {
		if (NOISE_SUBJECTS.some((re) => re.test(subject))) return true;
		const fromText = email.from?.text ?? '';
		if (NOISE_SENDERS.some((re) => re.test(fromText))) return true;
		// newsletter-looking list-unsubscribe + no personal greeting in body
		return false;
	}

	private async processEmail(email: ParsedMail, account: MailAccount): Promise<number> {
		const subject = email.subject ?? '';
		if (this.isNoise(email, subject)) return 0;

		const text = String(email.html ?? email.text ?? '');
		const fromText = email.from?.text ?? '';

		// strong signal: a reply to OUR sent application (In-Reply-To present)
		const isReplyToOurs = !!(email.inReplyTo || email.references);

		// company from sender domain: "Hiring <jobs@acme.com>" → acme
		const senderDomain = fromText.match(/<[^>]*@([a-z0-9-]+(?:\.[a-z0-9-]+)+)/i)?.[1]?.toLowerCase() ?? null;

		// link to a known application via lead company/URL
		const apps = await this.appRepo.findRecentWithLead(300);
		const subjectLower = subject.toLowerCase();
		const linked = apps.find((a) => {
			const company = String(a.company ?? '').toLowerCase();
			const leadUrl = String(a.leadUrl ?? '').toLowerCase();
			if (senderDomain && (leadUrl.includes(senderDomain) || company.includes(senderDomain.replace(/^www\./, '')))) return true;
			if (company && company.length > 2 && subjectLower.includes(company)) return true;
			// first significant word of the company name ("Continental Industry" → "continental")
			const firstWord = company.split(/\s+/)[0];
			if (firstWord && firstWord.length > 3 && !/^(the|ltd|llc|inc|gmbh|pvt|privat|limited|group|company)$/.test(firstWord) && subjectLower.includes(firstWord)) return true;
			return false;
		});

		const hit = STATUS_KEYWORDS.find(([, re]) => re.test(subject) || re.test(text.slice(0, 5000)));
		// employer signal required: reply-to-ours, or linked app, or strong subject match
		const strongSubject = /(your application|candidacy|application (update|status)|interview|offer|reject|not moving forward)/i.test(subject);
		if (!isReplyToOurs && !linked && !strongSubject) return 0;
		if (!hit) return 0;

		const dedupeKey = `email:${account.email}:${subject}:${email.date?.toISOString() ?? ''}`;
		const existing = await this.repo.findOne({ where: { subject: dedupeKey.slice(0, 255) } });
		if (existing) return 0;

		await this.repo.save(this.repo.create({
			applicationId: linked?.id ?? 'unmatched',
			status: hit[0],
			sourceType: 'email',
			subject: dedupeKey.slice(0, 255),
			contentHtml: text.slice(0, 500000),
		}));
		this.logger.log(`stored status update "${hit[0]}" from ${account.email}: ${subject}`);
		return 1;
	}

	listFor(applicationId: string): Promise<StatusUpdate[]> {
		return this.repo.find({ where: { applicationId }, order: { createdAt: 'DESC' } });
	}
}
