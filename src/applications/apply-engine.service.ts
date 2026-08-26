import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PortalAdapter, ScrapedLead, ApplyResult } from './portal-adapter.interface';
import { RemotiveAdapter, RemoteOkAdapter } from '../scout/public-api.adapters';
import { ApplicationRepository } from './application.repository';
import { ApplySettingRepository } from './apply-setting.repository';
import { AnswerBankService } from './answer-bank.service';
import { EmailTrackerService } from './email-tracker.service';
import { DirectChannelDetector, DirectChannel } from './direct-channel.detector';
import { DirectApplyMailer } from './direct-apply.mailer';
import { MailService } from './mail.service';
import { HumanEmailComposer } from './human-email-composer.service';
import { AtsCvBuilder } from './ats-cv-builder.service';
import { ProfileOptimizer } from '../profile/profile-optimizer.service';
import { ProcessLearningService, DetectedProcess } from './process-learning.service';
import { PortalCredentialService } from './portal-credential.service';
import { NaukriAdapter } from '../scout/naukri.adapter';
import { HrEmailInvestigator } from './hr-email-investigator.service';
import { BrowserFormService } from './browser-form.service';
import { LearningWeightsService } from './learning-weights.service';
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
		public readonly appRepo: ApplicationRepository,
		private readonly settingsRepo: ApplySettingRepository,
		private readonly answers: AnswerBankService,
		private readonly profileService: ProfileService,
		public readonly leadRepo: LeadRepository,
		private readonly emailTracker: EmailTrackerService,
		private readonly detector: DirectChannelDetector,
		private readonly mailer: MailService,
		private readonly composer: HumanEmailComposer,
		private readonly cvBuilder: AtsCvBuilder,
		private readonly profileOptimizer: ProfileOptimizer,
		public readonly processLearning: ProcessLearningService,
		private readonly portalCreds: PortalCredentialService,
		private readonly investigator: HrEmailInvestigator,
		private readonly browserForm: BrowserFormService,
		public readonly learning: LearningWeightsService,
	) {}

	onModuleInit(): void {
		for (const a of [new RemotiveAdapter(), new RemoteOkAdapter(), new NaukriAdapter(this.portalCreds)]) {
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

			// PRIORITY: 1) employer's stated process from the JD. 2) ATS/HR email
			// found in posting. 3) DEEP INVESTIGATION: job page → career pages →
			// pattern-guess + MX verify (FR-13). 4) easy-apply last.
			let result: ApplyResult;
			const stated = this.processLearning.detectProcess(lead.title, lead.description, lead.url);
			let channel: DirectChannel | null = stated
				? (stated.kind === 'email'
					? { kind: 'email', target: stated.target ?? '', detectedBy: 'jd-email' }
					: { kind: 'ats', target: stated.target ?? lead.url ?? '', detectedBy: `jd-${stated.kind}` })
				: await this.detector.detect(lead);
			if (!channel || channel.kind !== 'email') {
				const hr = await this.investigator.investigate(lead.company, lead.url, lead.description);
				if (hr) {
					// user rule: pattern-guess addresses are acceptable — job posters
					// often use their official mailboxes; log confidence but send.
					this.logger.log(`investigator found HR contact for ${lead.company}: ${hr.email} (${hr.source}, ${hr.confidence})`);
					channel = { kind: 'email', target: hr.email, detectedBy: `${hr.source}:${hr.confidence}` };
				}
			}
			if (stated) {
				this.logger.log(`JD-stated process for "${lead.title}": ${stated.instruction}`);
			}
			if (channel && stillUnanswered.length === 0) {
				const direct: DirectChannel = channel;
				result = await this.applyDirect(lead, profileData, direct, application);
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
			if (result.status === 'submitted') {
				await this.leadRepo.setStatus(lead.id, 'applied');
				// FR-11: feed outcome into learning weights (channel/portal/hour)
				try {
					const channelKind = channel?.kind ?? adapter.source;
					await this.learning.recordAttempt(channelKind, lead.source, new Date().getHours());
				} catch (e) {
					this.logger.warn(`learning record failed: ${String(e).slice(0, 80)}`);
				}
			}
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
			const skills = (profileData.skills ?? '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 5);
			const email = this.composer.compose(lead, profileData, skills);
			// Rewrite CV per job description and attach as PDF
			const cvPath = await this.buildCv(lead, profileData);
			const sent = await this.mailer.send({
				to: channel.target,
				subject: email.subject,
				html: email.bodyHtml,
				cvPath,
			});
			return sent.ok
				? { ok: true, status: 'submitted' }
				: { ok: false, status: 'failed', errorDetail: `direct-email failed: ${sent.error}` };
		}
		// ATS: drive the portal form with headless Chrome (FR-15). Filled from
		// profile data; stops before final submit unless AUTO_SUBMIT_BROWSER=true.
		const cvPath = await this.buildCv(lead, profileData);
		const values = this.profileToFormValues(profileData);
		const browser = await this.browserForm.fillAndSubmit({
			url: channel.target || lead.url || '',
			values,
			cvPath,
			autoSubmit: process.env.AUTO_SUBMIT_BROWSER === 'true',
		});
		return {
			ok: browser.ok,
			status: browser.status === 'filled' ? 'needs_info' : browser.status,
			missingInfo: browser.unansweredQuestions.length ? browser.unansweredQuestions : undefined,
			errorDetail: browser.errorDetail ?? `browser fill: ${browser.filledFields.length} fields, ${browser.screenshots.length} screenshots`,
		};
	}

	/** Map profile record to generic ATS form field values. */
	private profileToFormValues(p: Record<string, string>): Record<string, string> {
		const out: Record<string, string> = {};
		for (const [k, v] of Object.entries(p)) out[k] = v;
		// common alias keys portals use
		out['fullname'] = out['name'] ?? out['fullName'] ?? '';
		out['email'] = out['email'] ?? '';
		out['phone'] = out['phone'] ?? out['mobile'] ?? '';
		out['location'] = out['location'] ?? out['city'] ?? '';
		out['linkedin'] = out['linkedin'] ?? out['linkedinUrl'] ?? '';
		out['currentctc'] = out['currentCtc'] ?? '';
		out['expectedctc'] = out['expectedCtc'] ?? '';
		out['noticeperiod'] = out['noticePeriod'] ?? '';
		return out;
	}

	/** Build the JD-tailored ATS PDF CV and record its path on the application. */
	private async buildCv(lead: ScrapedLead, profileData: Record<string, string>): Promise<string | undefined> {
		try {
			const optimized = await this.profileOptimizer.optimize();
			const allSkills = (profileData.skills ?? '').split(',').map((s) => s.trim()).filter(Boolean);
			const jd = `${lead.title} ${lead.description ?? ''}`.toLowerCase();
			const matchedSkills = allSkills.filter((s) => jd.includes(s.toLowerCase()));
			const cvPath = await this.cvBuilder.build({
				profile: profileData,
				workHistory: optimized.workHistory,
				matchedSkills,
				allSkills,
				jobTitle: lead.title,
				jobCompany: lead.company,
				jobDescription: lead.description,
			});
			return cvPath;
		} catch (err) {
			this.logger.warn(`CV build failed, sending without attachment: ${String(err).slice(0, 150)}`);
			return undefined;
		}
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
