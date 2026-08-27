import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { Repository } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import { Application } from './application.entity';
import { LeadRepository } from '../leads/lead.repository';
import { ApplyEngineService } from './apply-engine.service';
import { PreApplyItemRepository } from '../astro/pre-apply-item.repository';

/**
 * RetryBackoffService (user rule: auto-retry failed applications after
 * 5-30 min, increasing) — retries `failed` applications with escalating
 * delays: 5m → 10m → 20m → 30m (max 4 attempts), then gives up permanently.
 */
const BACKOFF_STEPS_MS = [5, 10, 20, 30].map((m) => m * 60_000);

@Injectable()
export class RetryBackoffService {
	private readonly logger = new Logger(RetryBackoffService.name);

	constructor(
		@InjectRepository(Application)
		private readonly appRepo: Repository<Application>,
		private readonly leadRepo: LeadRepository,
		private readonly engine: ApplyEngineService,
		private readonly preApplyRepo: PreApplyItemRepository,
	) {}

	/** Check every minute for applications whose backoff has elapsed. */
	@Interval(60_000)
	async tick(): Promise<void> {
		// FR-19: queue-governed leads are NEVER auto-retried — the user decides
		// resends via the pre-apply queue (approval rule 2026-08-27: silence ≠ yes).
		// Permanent failures (caps, kill switch, no mailbox) are never retried.
		const queuedLeadIds = new Set((await this.preApplyRepo.findAll(500)).map((q) => q.leadId));
		const due = (await this.appRepo
			.createQueryBuilder('a')
			.where('a.status = :s', { s: 'failed' })
			.andWhere('a.retryCount < :max', { max: BACKOFF_STEPS_MS.length })
			.getMany())
			.filter((a) => !queuedLeadIds.has(a.leadId))
			.filter((a) => !/kill switch|portal cap|daily cap|already applied|no-active-mail-account/i.test(a.errorDetail ?? ''));

		const now = Date.now();
		for (const app of due) {
			const delay = BACKOFF_STEPS_MS[Math.min(app.retryCount, BACKOFF_STEPS_MS.length - 1)];
			const lastTried = app.updatedAt ? new Date(app.updatedAt).getTime() : new Date(app.createdAt).getTime();
			if (now - lastTried < delay) continue;

			const attempt = app.retryCount + 1;
			this.logger.log(`retry #${attempt} (backoff ${delay / 60_000}min) for application ${app.id}`);
			app.retryCount = attempt;
			await this.appRepo.save(app); // persist first so a crash can't loop

			try {
				const result = await this.engine.applyToLead(app.leadId, app);
				app.status = result.status === 'submitted' ? 'submitted' : result.status;
				if (result.errorDetail) app.errorDetail = result.errorDetail;
				await this.appRepo.save(app);
				this.logger.log(`retry #${attempt} -> ${app.status}`);
				if (app.status === 'submitted') break;
			} catch (err) {
				app.errorDetail = String(err).slice(0, 500);
				await this.appRepo.save(app);
				this.logger.warn(`retry #${attempt} error: ${app.errorDetail.slice(0, 80)}`);
			}
		}
	}
}
