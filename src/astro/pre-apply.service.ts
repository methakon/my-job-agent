import { Injectable, Logger } from '@nestjs/common';
import { ApplyEngineService } from '../applications/apply-engine.service';
import { PreApplyItem } from './pre-apply-item.entity';
import { PreApplyItemRepository } from './pre-apply-item.repository';
import { LeadRepository } from '../leads/lead.repository';
import { AstroLeadScoringService } from './astro-lead-scoring.service';
import { AstroMuhurtaService } from './astro-muhurta.service';

/**
 * PreApplyService — FR-16/FR-17 orchestrator.
 *
 * The agent never sends anything directly. It PREPARES an application
 * (tailored ATS CV + email draft + channel + astro match score + planned
 * muhurta window), parks it in the pre-apply queue as status `ready`, and
 * the user reviews it on /pre-apply-page. User actions:
 *   - approve           → status `approved`; MuhurtaSendService submits it
 *                         at the next shubh muhurta window (FR-16).
 *   - hold / resume     → pause the item (e.g. while correcting the CV).
 *   - uploadCv          → user rule: manually uploaded corrected CV replaces
 *                         the tailored one for the actual send.
 */
@Injectable()
export class PreApplyService {
	private readonly logger = new Logger(PreApplyService.name);

	constructor(
		private readonly items: PreApplyItemRepository,
		private readonly engine: ApplyEngineService,
		private readonly astroScoring: AstroLeadScoringService,
		private readonly muhurta: AstroMuhurtaService,
		private readonly leadRepo: LeadRepository,
	) {}

	/** Prepare an application for a lead — builds everything, sends nothing. */
	async prepare(leadId: string): Promise<PreApplyItem | { error: string }> {
		const existing = await this.items.findByLead(leadId);
		if (existing && existing.status !== 'failed') {
			return { error: `already in pre-apply queue (${existing.status})` };
		}

		const prep = await this.engine.prepareApplication(leadId);
		if (!prep.ok || !prep.lead) {
			return { error: prep.errorDetail ?? prep.status };
		}

		const storedLead = await this.leadRepo.findOneById(leadId);
		const astro = this.astroScoring.score(
			prep.lead.title,
			prep.lead.company,
			prep.lead.description,
		);
		const window = await this.muhurta.nextWindow(new Date());

		const item = await this.items.create({
			leadId,
			source: prep.lead.source,
			status: 'ready',
			matchScore: Number(storedLead?.matchScore ?? 0),
			astroScore: astro.score,
			astroJson: JSON.stringify({
				reasons: astro.reasons,
				muhurta: astro.muhurta,
			}),
			muhurtaWindowJson: window
				? JSON.stringify({
						startsAt: window.startsAt.toISOString(),
						endsAt: window.endsAt.toISOString(),
						score: window.score,
						tithi: window.tithi,
						nakshatra: window.nakshatra,
						weekday: window.weekday,
					})
				: null,
			channelJson: prep.channel ? JSON.stringify(prep.channel) : null,
			coverLetter: prep.coverLetter ?? null,
			emailSubject: prep.email?.subject ?? null,
			emailBody: prep.email?.bodyHtml ?? null,
			cvPath: prep.cvPath ?? null,
		});

		this.logger.log(`prepared pre-apply item ${item.id} for ${item.source} lead ${leadId} (astro ${astro.score}/100)`);
		return item;
	}

	/** User approves → item waits for the next shubh muhurta to actually send. */
	async approve(id: string): Promise<PreApplyItem | { error: string }> {
		const item = await this.items.findOneById(id);
		if (!item) return { error: 'not found' };
		if (item.status === 'sent') return { error: 'already sent' };
		item.status = 'approved';
		item.approvedAt = new Date();
		item.errorDetail = null;
		await this.items.save(item);
		this.logger.log(`pre-apply item ${id} APPROVED — will send at next shubh muhurta`);
		return item;
	}

	/** User holds the item (e.g. while uploading a corrected CV). */
	async hold(id: string): Promise<PreApplyItem | { error: string }> {
		const item = await this.items.findOneById(id);
		if (!item) return { error: 'not found' };
		if (item.status === 'sent') return { error: 'already sent — it lives in Applications & Tracking now' };
		item.status = 'hold';
		await this.items.save(item);
		return item;
	}

	/** Resume a held item back to ready (user may then approve again). */
	async resume(id: string): Promise<PreApplyItem | { error: string }> {
		const item = await this.items.findOneById(id);
		if (!item) return { error: 'not found' };
		if (item.status !== 'hold') return { error: `cannot resume status ${item.status}` };
		item.status = 'ready';
		await this.items.save(item);
		return item;
	}

	/** User rule: manually uploaded corrected CV replaces the tailored one. */
	async uploadCv(id: string, cvPath: string): Promise<PreApplyItem | { error: string }> {
		const item = await this.items.findOneById(id);
		if (!item) return { error: 'not found' };
		item.userCvPath = cvPath;
		await this.items.save(item);
		this.logger.log(`pre-apply item ${id} — user CV uploaded: ${cvPath}`);
		return item;
	}

	listPending(): Promise<PreApplyItem[]> {
		return this.items.findPending();
	}

	get(id: string): Promise<PreApplyItem | null> {
		return this.items.findOneById(id);
	}

	listAll(): Promise<PreApplyItem[]> {
		return this.items.findAll();
	}

	/** Review-queue items: everything still actionable — ready, hold, approved,
	 * failed. Sent items are excluded (they belong to Application Tracking). */
	listReview(): Promise<PreApplyItem[]> {
		return this.items.findReviewQueue();
	}

	/** Items approved by the user, waiting on a shubh muhurta window. */
	approvedPending(): Promise<PreApplyItem[]> {
		return this.items.findApprovedPendingSend();
	}

	async markSent(id: string): Promise<void> {
		const item = await this.items.findOneById(id);
		if (!item) return;
		item.status = 'sent';
		item.sentAt = new Date();
		await this.items.save(item);
	}

	async markFailed(id: string, error: string): Promise<void> {
		const item = await this.items.findOneById(id);
		if (!item) return;
		item.status = 'failed';
		item.errorDetail = error.slice(0, 1000);
		await this.items.save(item);
	}

	/** Record the sweep-time muhurta match % on the item at send time. */
	async recordMuhurtaMatch(id: string, score: number): Promise<void> {
		const item = await this.items.findOneById(id);
		if (!item) return;
		item.muhurtaMatchScore = Number(score);
		await this.items.save(item);
	}
}
