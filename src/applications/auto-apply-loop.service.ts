import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { LeadRepository } from '../leads/lead.repository';
import { ProfileService } from '../profile/profile.service';
import { PreApplyService } from '../astro/pre-apply.service';

/**
 * AutoApplyLoop (FR-16/FR-17/FR-18) — every hour, looks at fresh leads above
 * MATCH_THRESHOLD and PREPARES them into the pre-apply queue (tailored CV,
 * email draft, channel, astro score, planned muhurta window). NOTHING is sent
 * here — the user reviews items on /pre-apply-page and approves them; only
 * MuhurtaSendService actually submits, and only inside a shubh muhurta.
 */
const MATCH_THRESHOLD = Number(process.env.AUTO_APPLY_MIN_MATCH ?? 40);
const MAX_PER_RUN = Number(process.env.AUTO_APPLY_MAX_PER_RUN ?? 12);

@Injectable()
export class AutoApplyLoopService {
	private readonly logger = new Logger(AutoApplyLoopService.name);
	private running = false;

	constructor(
		private readonly preApply: PreApplyService,
		private readonly leadRepo: LeadRepository,
		private readonly profileService: ProfileService,
	) {}

	/** FR-18: every hour, alongside the hourly scout fetch. */
	@Interval(60 * 60 * 1000)
	async runScheduled(): Promise<void> {
		await this.runOnce();
	}

	async runOnce(): Promise<{ prepared: number; skipped: number; errors: number }> {
		if (this.running) return { prepared: 0, skipped: 0, errors: 0 };
		this.running = true;
		const tally = { prepared: 0, skipped: 0, errors: 0 };
		try {
			if (process.env.APPLY_KILL_SWITCH === 'true') {
				this.logger.warn('kill switch ON — prepare loop skipped');
				return tally;
			}
			const profile = await this.profileService.getResponse();
			if (!profile || profile.missingFields.length > 0) {
				this.logger.warn(`profile incomplete (${profile?.missingFields.join(',') ?? 'no profile'}) — prepare loop skipped`);
				return tally;
			}

			const candidates = (await this.leadRepo.findRecent(200))
				.filter((l) => l.status === 'new' && Number(l.matchScore) >= MATCH_THRESHOLD)
				.sort((a, b) => Number(b.matchScore) - Number(a.matchScore))
				.slice(0, MAX_PER_RUN);

			this.logger.log(`prepare-loop: ${candidates.length} candidates >= ${MATCH_THRESHOLD}% match`);
			for (const lead of candidates) {
				try {
					const result = await this.preApply.prepare(lead.id);
					if ('error' in result) {
						tally.skipped++;
						this.logger.log(`prepare ${lead.source} "${lead.title}" -> skipped (${result.error})`);
					} else {
						tally.prepared++;
						this.logger.log(`prepare ${lead.source} "${lead.title}" -> queued ${result.id} (astro ${result.astroScore}/100)`);
					}
				} catch (err) {
					tally.errors++;
					this.logger.warn(`prepare error on ${lead.id}: ${String(err).slice(0, 100)}`);
				}
			}
			this.logger.log(`prepare-loop done: ${JSON.stringify(tally)}`);
		} finally {
			this.running = false;
		}
		return tally;
	}
}
