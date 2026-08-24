import { Injectable, Logger } from '@nestjs/common';
import { ScrapedLead } from './portal-adapter.interface';

export interface DirectChannel {
	kind: 'ats' | 'email';
	/** Where to apply: ATS application URL or mailto address. */
	target: string;
	/** Which detector matched, for logging/transparency. */
	detectedBy: string;
}

const ATS_PATTERNS: Array<[RegExp, string]> = [
	[/boards\.greenhouse\.io\/([a-z0-9-]+)\/jobs\/(\d+)/i, 'greenhouse'],
	[/job-boards\.greenhouse\.io\/([a-z0-9-]+)\/jobs\/(\d+)/i, 'greenhouse'],
	[/jobs\.lever\.co\/([a-z0-9-]+)\/([a-z0-9-]+)/i, 'lever'],
	[/jobs\.workable\.com\/([a-z0-9-]+)\/jobs\/(\d+)/i, 'workable'],
	[/ashbyhq\.com\/([a-z0-9-]+)\/([a-f0-9-]+)/i, 'ashby'],
];

/**
 * DirectChannelDetector — finds a way to apply DIRECTLY to the company
 * (preferred) before falling back to portal easy-apply (last resort).
 *
 * Priority:
 *   1. Company ATS page (Greenhouse/Lever/Workable/Ashby) linked in the posting
 *   2. HR/recruiting email visible in the description
 *   3. (caller falls back to) portal easy-apply
 */
@Injectable()
export class DirectChannelDetector {
	private readonly logger = new Logger(DirectChannelDetector.name);

	/**
	 * Resolve the best apply channel for a lead.
	 * Optionally probes Greenhouse's public API to confirm the job is live.
	 */
	async detect(lead: ScrapedLead): Promise<DirectChannel | null> {
		const text = `${lead.description ?? ''} ${lead.url ?? ''}`;

		for (const [re, name] of ATS_PATTERNS) {
			const m = text.match(re);
			if (!m) continue;
			const target = await this.canonicalAtsUrl(name, m);
			if (target) {
				this.logger.log(`direct ATS channel found for "${lead.title}" via ${name}`);
				return { kind: 'ats', target, detectedBy: name };
			}
		}

		const email = this.findHrEmail(text);
		if (email && !this.isPortalNoise(email)) {
			this.logger.log(`direct EMAIL channel found for "${lead.title}" -> ${email}`);
			return { kind: 'email', target: email, detectedBy: 'description-email' };
		}
		return null;
	}

	private async canonicalAtsUrl(kind: string, m: RegExpMatchArray): Promise<string | null> {
		if (kind === 'greenhouse') {
			const [, board, jobId] = m;
			// verify job still open via public API; get canonical URL
			try {
				const res = await fetch(`https://boards-api.greenhouse.io/v1/boards/${board}/jobs/${jobId}`);
				if (res.ok) return `https://boards.greenhouse.io/${board}/jobs/${jobId}`;
			} catch { /* fall through */ }
			return null;
		}
		return m[0];
	}

	private findHrEmail(text: string): string | null {
		const m = text.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
		return m ? m[0].toLowerCase() : null;
	}

	private isPortalNoise(email: string): boolean {
		// portal no-reply / system addresses are not HR contacts
		return /(noreply|no-reply|donotreply|careers@remoteok|remotive)/i.test(email);
	}
}
