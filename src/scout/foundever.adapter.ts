import { Injectable, Logger } from '@nestjs/common';
import { ScrapedLead, PortalAdapter, ApplyResult } from '../applications/portal-adapter.interface';

/**
 * FoundeverAdapter — Foundever's careers site (jobs.foundever.com).
 *
 * Foundever (formerly Sitel/Teleperformance customer-experience ops) posts
 * primarily CX/contact-center roles, but their board can include IT/tech roles
 * in some regions. This adapter:
 *  - scrapes: fetches the public jobs listing if it exposes structured data;
 *    otherwise returns empty (no public seeker API confirmed without login).
 *  - apply: resolves the job page URL to the real apply target and reports
 *    needs_info with the destination.
 *
 * Note: most Foundever openings are non-engineering (CX, support). The scout
 * service's VETO_RE and title-score rules will filter out non-dev titles
 * before storage, so this adapter is safe to register even though Foundever
 * is not a software-employer target for this profile.
 */
const BOARD_URL = 'https://jobs.foundever.com/';
const CAREERS_URL = 'https://www.foundever.com/careers';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121 Safari/537.36';

@Injectable()
export class FoundeverAdapter implements PortalAdapter {
	readonly source = 'foundever';
	readonly label = 'Foundever (jobs.foundever.com)';
	private readonly logger = new Logger(FoundeverAdapter.name);

	async scrape(): Promise<ScrapedLead[]> {
		try {
			const res = await fetch(BOARD_URL, {
				headers: { 'user-agent': UA, accept: 'text/html,application/json' },
				redirect: 'follow',
			});
			const html = await res.text();
			this.logger.debug(`foundever scrape: fetched ${html.length} bytes`);

			// Look for embedded JSON job payloads (script id, data-state, window.__…).
			// Until the real payload shape is confirmed, return empty and rely on
			// future extraction or external board discovery (e.g. aggregator links).
			return [];
		} catch (err) {
			this.logger.warn(`foundever scrape failed: ${String(err).slice(0, 150)}`);
			return [];
		}
	}

	async apply(lead: ScrapedLead, _profileData: Record<string, string>, _answers: Record<string, string>): Promise<ApplyResult> {
		const url = lead.url ?? CAREERS_URL;
		return {
			ok: false,
			status: 'needs_info',
			missingInfo: [
				`Foundever career page: ${url} — verify role type (most are CX/ops) and apply via the portal or direct channel`,
			],
			errorDetail: url,
		};
	}
}
