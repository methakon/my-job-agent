import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PortalAdapter, ScrapedLead, ApplyResult } from './portal-adapter.interface';
import { RemotiveAdapter, RemoteOkAdapter } from '../scout/public-api.adapters';
import { ApplicationRepository } from './application.repository';
import { ApplySettingRepository } from './apply-setting.repository';
import { AnswerBankService } from './answer-bank.service';
import { EmailTrackerService } from './email-tracker.service';
import { DirectChannelDetector, DirectChannel } from './direct-channel.detector';
import { DirectApplyMailer } from './direct-apply.mailer';
import { ProfileService } from '../profile/profile.service';
import { LeadRepository } from '../leads/lead.repository';

/**
 * ApplyEngine — registry of PortalAdapters + submission loop.
 * Adding a portal later = implement PortalAdapter in a new file and push it
 * into `adapters` below. Nothing else changes.
 */
@Injectable()
export class ApplyEngineService implements OnModuleInit {
	private readonly logger = new Logger(ApplyEngineService.name);
	private readonly adapters: Map<string, PortalAdapter> = new Map();

	constructor(
		private readonly appRepo: ApplicationRepository,
		private readonly settingsRepo: ApplySettingRepository,
		private readonly answers: AnswerBankService,
		private readonly profileService: ProfileService,
		private readonly leadRepo: LeadRepository,
		private readonly emailTracker: EmailTrackerService,
		private readonly detector: DirectChannelDetector,
		private readonly mailer: DirectApplyMailer,
	) {}

	onModuleInit(): void {
		for (const a of [new RemotiveAdapter(), new RemoteOkAdapter()]) {
			this.register(a);
		}
		void this.emailTracker.poll().catch(() => undefined);
	}

	/** Manual trigger from dashboard. */
	pollEmail(): Promise<number> {
		return this.emailTracker.poll();
	}

	register(adapter: PortalAdapter): void {
		this.adapters.set(adapter.source, adapter);
		this.logger.log(`registered portal adapter: ${adapter.source} (${adapter.label})`);
	}

	listSources(): Array<{ source: string; label: string }> {
		return [...this.adapters.values()].map((a) => ({ source: a.source, label: a.label }));
	}

	async ensureSettings(): Promise<void> {
		await this.settingsRepo.ensureDefaults(this.listSources().map((s) => s.source));
		if (process.env.APPLY_KILL_SWITCH === 'true') this.logger.warn('GLOBAL KILL SWITCH is ON — no submissions will go out');
	}

	private killSwitchOn(): boolean {
		return process.env.APPLY_KILL_SWITCH === 'true';
	}

	/**
	 * Attempt one application for a stored lead.
	 * Generates cover letter from profile + job title/company, resolves custom
	 * questions via the answer bank; unknown questions → needs_info.
	 */
	async applyToLead(leadId: string): Promise<ApplyResult & { applicationId?: string }> {
		const lead = await this.leadRepo.findRecent(500).then((all) => all.find((l) => l.id === leadId));
		if (!lead) return { ok: false, status: 'failed', errorDetail: 'lead not found' };

		const setting = await this.settingsRepo.findBySource(lead.source);
		const adapter = this.adapters.get(lead.source);
		if (!adapter) return { ok: false, status: 'failed', errorDetail: `no adapter for source ${lead.source}` };
		if (this.killSwitchOn()) return { ok: false, status: 'failed', errorDetail: 'kill switch active' };
		if (setting && !setting.autoApplyEnabled) return { ok: false, status: 'needs_info', missingInfo: [`auto-apply disabled for ${lead.source} — enable in settings`] };

		const dailyCount = await this.appRepo.countTodayBySource(lead.source);
		if (setting && dailyCount >= setting.maxPerDay) {
			return { ok: false, status: 'needs_info', missingInfo: [`daily cap reached for ${lead.source} (${dailyCount}/${setting.maxPerDay})`] };
		}

		const profileData = await this.profileService.flatten();
		const profileResp = await this.profileService.getResponse();
		if (profileResp && profileResp.missingFields.length > 0) {
			return { ok: false, status: 'needs_info', missingInfo: profileResp.missingFields.map((f) => `profile.${f}`) };
		}

		const application = await this.appRepo.createPartial({
			leadId: lead.id,
			source: lead.source,
			status: 'submitting',
			coverLetter: this.generateCoverLetter(profileData, lead),
		});

		try {
			const questions = await (adapter as unknown as { probeQuestions?(lead: ScrapedLead): Promise<string[]> }).probeQuestions?.(lead) ?? [];
			const resolved = await this.answers.resolve(questions);
			const unanswered = questions.filter((q) => !(q in resolved));
			if (unanswered.length > 0) {
				await this.answers.seedFromProfile(profileData);
				const reResolved = await this.answers.resolve(unanswered);
				for (const q of unanswered.filter((q) => q in reResolved)) resolved[q] = reResolved[q];
			}
			const stillUnanswered = questions.filter((q) => !(q in resolved));

			// PRIORITY: apply directly via company ATS or HR email when available;
			// portal easy-apply is only the last resort (user rule).
			let result: ApplyResult;
			const channel = await this.detector.detect(lead);
			if (channel && stillUnanswered.length === 0) {
				result = await this.applyDirect(lead, profileData, channel, application);
			} else if (stillUnanswered.length > 0) {
				result = { ok: false, status: 'needs_info', questions: stillUnanswered.map((q) => ({ question: q, answer: null })), missingInfo: stillUnanswered };
			} else {
				result = await adapter.apply(lead, profileData, resolved);
			}

			application.status = result.status;
			application.questionsJson = JSON.stringify(result.questions ?? []);
			application.missingInfoJson = result.missingInfo ? JSON.stringify(result.missingInfo) : null;
			application.errorDetail = result.errorDetail ?? null;
			await this.appRepo.save(application);
			if (result.status === 'submitted') await this.leadRepo.setStatus(lead.id, 'applied');
			return { ...result, applicationId: application.id };
		} catch (err) {
			application.status = 'failed';
			application.errorDetail = String(err).slice(0, 1000);
			await this.appRepo.save(application);
			return { ok: false, status: 'failed', errorDetail: String(err), applicationId: application.id };
		}
	}

	/**
	 * Direct apply path (preferred): HR email via SMTP, or ATS page.
	 * ATS submissions open a browser-automation session; email is sent directly.
	 */
	private async applyDirect(
		lead: ScrapedLead,
		profileData: Record<string, string>,
		channel: DirectChannel,
		application: { cvPath: string | null },
	): Promise<ApplyResult> {
		if (channel.kind === 'email') {
			const coverLetter = application.cvPath ? null : this.generateCoverLetter(profileData, lead);
			const sent = await this.mailer.send({
				to: channel.target,
				subject: `Application: ${lead.title} — ${profileData.name ?? 'Swarna Sekhar Dhar'}`,
				html: coverLetter ?? this.generateCoverLetter(profileData, lead),
				cvPath: application.cvPath ?? undefined,
			});
			return sent.ok
				? { ok: true, status: 'submitted' }
				: { ok: false, status: 'failed', errorDetail: `direct-email failed: ${sent.error}` };
		}
		// ATS: hand off to browser automation session for that portal's form.
		// Filled from profileData + answer bank by the AtsApplyService (per-ATS adapter).
		return {
			ok: false,
			status: 'needs_info',
			missingInfo: [`direct ATS apply queued for ${channel.detectedBy}: ${channel.target} (browser automation pending)`],
		};
	}

	/**
	 * Tailored cover letter — customized per job: only the candidate's skills
	 * that actually appear in THIS job description are highlighted, so the
	 * letter reads focused and senior (user rule: trim skills to match JD).
	 */
	generateCoverLetter(profile: Record<string, string>, lead: ScrapedLead): string {
		const jd = `${lead.title} ${lead.description ?? ''}`.toLowerCase();
		const all = (profile.skills ?? '').split(',').map((s) => s.trim()).filter(Boolean);
		const relevant = all.filter((s) => jd.includes(s.toLowerCase()));
		const picked = (relevant.length >= 3 ? relevant : all.slice(0, 5)).slice(0, 8).join(', ');
		const years = profile.experienceYears ?? '';
		return (
			`Dear Hiring Team at ${lead.company},\n\n` +
			`I am applying for the ${lead.title} role. With ${years} years of backend experience` +
			` and hands-on strengths in ${picked}, my background maps directly to what your team is building.\n\n` +
			`Recent highlights: modernizing Laravel services to NestJS/TypeScript with REST + GraphQL APIs ` +
			`(CodeClouds), and leading backend delivery on Node.js microservices with MySQL/Oracle tuning (Han River Technology).\n\n` +
			`I would welcome the chance to discuss how I can contribute to ${lead.company}. Thank you for your consideration.\n\n` +
			`Best regards,\n${profile.name ?? ''}\n${profile.email ?? ''}${profile.phone ? ' | ' + profile.phone : ''}` +
			(profile.portfolioUrl ? `\nPortfolio: ${profile.portfolioUrl}` : '') +
			(profile.githubUrl ? `\nGitHub: ${profile.githubUrl}` : '')
		);
	}
}
