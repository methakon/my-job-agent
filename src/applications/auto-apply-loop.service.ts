import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { ApplyEngineService } from './apply-engine.service';
import { LeadRepository } from '../leads/lead.repository';
import { ProfileService } from '../profile/profile.service';

/**
 * AutoApplyLoop (user-approved nightly mode) — periodically applies to all
 * leads above MATCH_THRESHOLD automatically, respecting per-source daily caps,
 * the kill switch, and human-like pacing between submissions.
 */
const MATCH_THRESHOLD = Number(process.env.AUTO_APPLY_MIN_MATCH ?? 40);
const MAX_PER_RUN = Number(process.env.AUTO_APPLY_MAX_PER_RUN ?? 8);
const PAUSE_BETWEEN_MS = Number(process.env.AUTO_APPLY_PAUSE_MS ?? 90_000); // 1.5 min pacing

@Injectable()
export class AutoApplyLoopService {
	private readonly logger = new Logger(AutoApplyLoopService.name);
	private running = false;

	constructor(
		private readonly engine: ApplyEngineService,
		private readonly leadRepo: LeadRepository,
		private readonly profileService: ProfileService,
	) {}

	/** Every 6 hours, offset from the scout's run. */
	@Interval(6 * 60 * 60 * 1000)
	async runScheduled(): Promise<void> {
		await this.runOnce();
	}

	async runOnce(): Promise<{ applied: number; needsInfo: number; failed: number; skipped: number }> {
		if (this.running) return { applied: 0, needsInfo: 0, failed: 0, skipped: 0 };
		this.running = true;
		const tally = { applied: 0, needsInfo: 0, failed: 0, skipped: 0 };
		try {
			if (process.env.APPLY_KILL_SWITCH === 'true') {
				this.logger.warn('kill switch ON — auto-apply skipped');
				return tally;
			}
			const profile = await this.profileService.getResponse();
			if (!profile || profile.missingFields.length > 0) {
				this.logger.warn(`profile incomplete (${profile?.missingFields.join(',') ?? 'no profile'}) — auto-apply skipped`);
				return tally;
			}

			const candidates = (await this.leadRepo.findRecent(200))
				.filter((l) => l.status === 'new' && Number(l.matchScore) >= MATCH_THRESHOLD)
				.sort((a, b) => Number(b.matchScore) - Number(a.matchScore))
				.slice(0, MAX_PER_RUN);

			this.logger.log(`auto-apply: ${candidates.length} candidates >= ${MATCH_THRESHOLD}% match`);
			for (const lead of candidates) {
				try {
					const result = await this.engine.applyToLead(lead.id);
					tally[result.status === 'submitted' ? 'applied' : result.status === 'needs_info' ? 'needsInfo' : 'failed']++;
					this.logger.log(`auto-apply ${lead.source} "${lead.title}" -> ${result.status}${result.errorDetail ? ' (' + result.errorDetail.slice(0, 80) + ')' : ''}`);
				} catch (err) {
					tally.failed++;
					this.logger.warn(`auto-apply error on ${lead.id}: ${String(err).slice(0, 100)}`);
				}
				// human-like pacing between submissions
				await new Promise((r) => setTimeout(r, PAUSE_BETWEEN_MS));
			}
			this.logger.log(`auto-apply done: ${JSON.stringify(tally)}`);
		} finally {
			this.running = false;
		}
		return tally;
	}
}
