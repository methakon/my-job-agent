import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PreApplyService } from './pre-apply.service';
import { ApplyEngineService } from '../applications/apply-engine.service';
import { AstroMuhurtaService, SHUBH_MIN_SCORE } from './astro-muhurta.service';

/**
 * MuhurtaSendService — every SWEEP_MINUTES looks at items the user
 * APPROVED in the pre-apply queue and submits them. Each send records the
 * sweep-time muhurta match % (0–100) on the item for audit; sends are no
 * longer gated on shubh status (the match % is informational).
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

		this.logger.log(
			`muhurta sweep: ${approved.length} approved item(s) — ` +
				`now score ${assessment.score}/${SHUBH_MIN_SCORE} ` +
				`(${assessment.weekday}, tithi ${assessment.tithi} ${assessment.paksha}, ${assessment.nakshatra})` +
				(assessment.shubh ? ` — SHUBH window open, submitting` : ` — not shubh, sending anyway (score recorded)`),
		);

		for (const item of approved) {
			try {
				const result = await this.engine.submitPrepared(item);
				// Record the sweep-time muhurta match % on the item so it is
				// auditable; the send proceeds regardless of shubh status.
				await this.preApply.recordMuhurtaMatch(item.id, assessment.score);
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
