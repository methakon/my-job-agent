import { Injectable, Logger } from '@nestjs/common';
import { ScrapedLead, PortalAdapter, ApplyResult } from '../applications/portal-adapter.interface';

/**
 * Micro1JobsAdapter — micro1.ai's job board at micro1-jobs.com.
 *
 * micro1 is a frontier AI data lab (Bengaluru/US, remote-friendly). Their
 * public careers page is at micro1.ai/careers, and the searchable board is
 * micro1-jobs.com. This adapter scrapes the public board if it exposes JSON,
 * otherwise falls back to the careers page and reports needs_info.
 */
const BOARD_URL = 'https://www.micro1-jobs.com/';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121 Safari/537.36';

@Injectable()
export class Micro1JobsAdapter implements PortalAdapter {
	readonly source = 'micro1';
	readonly label = 'micro1.ai (micro1-jobs.com)';
	private readonly logger = new Logger(Micro1JobsAdapter.name);

	async scrape(): Promise<ScrapedLead[]> {
		try {
			const res = await fetch(BOARD_URL, {
				headers: { 'user-agent': UA, accept: 'text/html,application/json' },
				redirect: 'follow',
			});
			const html = await res.text();

			// Try to find embedded JSON job data (common pattern: window.__NUXT__, data-client-state, etc.)
			const jsonCandidates = [
				/...job...json/i,  // placeholder — refine once real payload shape is known
			];

			// For now: micro1-jobs.com may render server-side or require JS.
			// If a structured payload is found, parse it; otherwise report via needs_info.
			this.logger.debug(`micro1 scrape: fetched ${html.length} bytes from ${BOARD_URL}`);

			// Placeholder: return empty until the real payload shape is confirmed.
			// Once micro1 exposes a parseable list, add extraction here.
			return [];
		} catch (err) {
			this.logger.warn(`micro1 scrape failed: ${String(err).slice(0, 150)}`);
			return [];
		}
	}

	async apply(lead: ScrapedLead, _profileData: Record<string, string>, _answers: Record<string, string>): Promise<ApplyResult> {
		const url = lead.url ?? `https://www.micro1.ai/careers`;
		return {
			ok: false,
			status: 'needs_info',
			missingInfo: [`micro1 career page: ${url} — apply via the portal or direct channel`],
			errorDetail: url,
		};
	}
}
