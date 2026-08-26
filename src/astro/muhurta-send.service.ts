import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PreApplyService } from './pre-apply.service';
import { ApplyEngineService } from '../applications/apply-engine.service';
import { AstroMuhurtaService } from './astro-muhurta.service';

/**
 * MuhurtaSendService — FR-16. Every SWEEP_MINUTES it looks at items the user
 * APPROVED in the pre-apply queue and submits them — but ONLY inside a shubh
 * (auspicious) muhurta window computed by AstroMuhurtaService. If the current
 * moment is not shubh, approved items simply wait for the next window.
 */
@Injectable()
export class MuhurtaSendService {
	private readonly logger = new Logger(MuhurtaSendService.name);

	constructor(
		private readonly preApply: PreApplyService,
		private readonly engine: ApplyEngineService,
		private readonly muhurta: AstroMuhurtaService,
	) {}

	@Interval(Number(process.env.MUHURTA_SWEEP_MINUTES ?? 10) * 60_000)
	async sweep(): Promise<void> {
		const now = new Date();
		const assessment = this.muhurta.assess(now);
		const approved = await this.preApply.approvedPending();

		if (approved.length === 0) return;

		if (!assessment.shubh) {
			this.logger.log(
				`muhurta sweep: ${approved.length} approved item(s) waiting — not shubh now ` +
				`(score ${assessment.score}; next shubh ~${this.muhurta.describeNext(now)})`,
			);
			return;
		}

		this.logger.log(
			`muhurta sweep: SHUBH window open (score ${assessment.score}, ` +
			`${assessment.weekday}, tithi ${assessment.tithi} ${assessment.paksha}, ${assessment.nakshatra}) — ` +
			`submitting ${approved.length} approved item(s)`,
		);

		for (const item of approved) {
			try {
				const result = await this.engine.submitPrepared(item);
				if (result.ok && result.status === 'submitted') {
					await this.preApply.markSent(item.id);
					this.logger.log(`muhurta send OK: ${item.source} lead ${item.leadId} (${item.id})`);
				} else if (result.ok && result.status === 'sandboxed') {
					await this.preApply.markSent(item.id);
					this.logger.log(`muhurta send SANDBOXED (no real submit): ${item.id}`);
				} else {
					await this.preApply.markFailed(item.id, result.errorDetail ?? result.status);
					this.logger.warn(`muhurta send failed: ${item.id} — ${result.errorDetail ?? result.status}`);
				}
			} catch (err) {
				await this.preApply.markFailed(item.id, String(err));
				this.logger.error(`muhurta send threw for ${item.id}: ${String(err).slice(0, 300)}`);
			}
		}
	}
}
