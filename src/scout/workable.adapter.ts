import { Injectable, Logger } from '@nestjs/common';
import { ScrapedLead, PortalAdapter, ApplyResult } from '../applications/portal-adapter.interface';
import { PortalCredentialService } from '../applications/portal-credential.service';

/**
 * WorkableAdapter — workable.com-hosted career pages.
 *
 * Workable powers company career sites under *.workable.com. Search is not
 * available without an employer account; this adapter operates in two modes:
 *
 * 1. Scrape mode: generic search via job-boards aggregators is left to other
 *    adapters. Workable itself exposes no public job listing API for seekers.
 *    The `scrape()` here returns an empty list and is a no-op placeholder so
 *    the adapter is registered and visible without breaking the pipeline.
 *
 * 2. Apply mode: given a lead whose url points at a workable.com career page
 *    (e.g. `https://company.workable.com/jobs/12345/`), the `apply()` resolves
 *    the real ATS/form target and reports needs_info with the apply URL so the
 *    direct-channel machinery can take it from there.
 *
 * Direct-channel detector already registers the /jobs.workable.com/:slug/jobs/:id
 * pattern for ATS recognition; this adapter adds the Workable source label and
 * a first-class apply path.
 */
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121 Safari/537.36';

@Injectable()
export class WorkableAdapter implements PortalAdapter {
	readonly source = 'workable';
	readonly label = 'Workable.com career pages';
	private readonly logger = new Logger(WorkableAdapter.name);

	constructor(private readonly creds?: PortalCredentialService) {}

	/** Workable exposes no public seeker-facing search API; placeholder no-op. */
	async scrape(): Promise<ScrapedLead[]> {
		this.logger.debug('workable scrape: no public search API — returning empty');
		return [];
	}

	/**
	 * Resolve the apply URL for a workable-hosted job.
	 * Workable job pages typically redirect/link to the employer's own apply
	 * form or an embedded Workable apply flow; we follow redirects to find the
	 * real destination and hand it back as needs_info.
	 */
	async apply(lead: ScrapedLead, _profileData: Record<string, string>, _answers: Record<string, string>): Promise<ApplyResult> {
		const url = lead.url ?? '';
		if (!url) {
			return { ok: false, status: 'failed', errorDetail: 'workable apply: lead has no url' };
		}

		try {
			// Follow redirects to land on the real apply target.
			const res = await fetch(url, {
				headers: { 'user-agent': UA, accept: 'text/html,application/json' },
				redirect: 'follow',
			});
			const finalUrl = res.url;

			// If we ended up on a workable apply domain, that's the target.
			const isWorkableApply = /workable\.com\/[a-z]+\/apply/i.test(finalUrl) ||
				/workable\.com\/jobs\/\d+/i.test(finalUrl);

			return {
				ok: false,
				status: 'needs_info',
				missingInfo: [
					isWorkableApply
						? `Workable-hosted apply page at ${finalUrl} — submit via direct channel`
						: `Workable career page resolves to ${finalUrl} — verify ATS and apply manually or via direct channel`,
				],
				errorDetail: finalUrl,
			};
		} catch (err) {
			return {
				ok: false,
				status: 'failed',
				errorDetail: `workable apply resolve failed: ${String(err).slice(0, 200)}`,
			};
		}
	}
}
