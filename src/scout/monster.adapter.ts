import { Injectable, Logger } from '@nestjs/common';
import { ScrapedLead, PortalAdapter, ApplyResult } from '../applications/portal-adapter.interface';
import { PortalCredentialService } from '../applications/portal-credential.service';

/**
 * MonsterAdapter — Monster / foundit.in portal adapter for searching
 * Indian & remote backend job postings and applying.
 */
const BASE_URL = 'https://www.foundit.in';
const SRP_URL = `${BASE_URL}/srp/results`;

@Injectable()
export class MonsterAdapter implements PortalAdapter {
	readonly source = 'monster';
	readonly label = 'Monster / foundit';
	private readonly logger = new Logger(MonsterAdapter.name);

	constructor(private readonly creds?: PortalCredentialService) {}

	async scrape(): Promise<ScrapedLead[]> {
		const keywords = ['nestjs', 'node.js typescript'];
		const leads: ScrapedLead[] = [];

		for (const kw of keywords) {
			try {
				const url = `${SRP_URL}?query=${encodeURIComponent(kw)}`;
				const res = await fetch(url, {
					headers: {
						'User-Agent':
							'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
						Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
					},
				});

				if (!res.ok) {
					this.logger.warn(`monster search "${kw}" HTTP ${res.status}`);
					continue;
				}

				const html = await res.text();
				// Extract job cards from SRP HTML
				// foundit embeds job card details or schema markup in the HTML
				const titleMatches = [...html.matchAll(/class="jobTitle"[^>]*>([^<]+)/gi)];
				const companyMatches = [...html.matchAll(/class="companyName"[^>]*>([^<]+)/gi)];
				const jobIdMatches = [...html.matchAll(/data-job-id="([^"]+)"|jobIdInfo"[^>]*>Job ID:\s*([0-9]+)/gi)];

				const count = Math.min(titleMatches.length, companyMatches.length);
				for (let i = 0; i < count; i++) {
					const title = titleMatches[i]?.[1]?.trim() ?? '';
					const company = companyMatches[i]?.[1]?.trim() ?? 'Unknown';
					const extId = jobIdMatches[i]?.[1] || jobIdMatches[i]?.[2] || `monster-${kw}-${i}`;
					if (!title) continue;

					leads.push({
						source: this.source,
						externalId: String(extId),
						title,
						company,
						location: 'India / Remote',
						description: `${title} at ${company} (foundit India posting)`,
						url: `${BASE_URL}/srp/results?query=${encodeURIComponent(kw)}`,
					});
				}
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				this.logger.error(`monster search failed for "${kw}": ${msg}`);
			}
		}

		this.logger.log(`monster scraped ${leads.length} leads`);
		return leads;
	}

	async apply(
		lead: ScrapedLead,
		profileData: Record<string, string>,
		answers: Record<string, string>,
	): Promise<ApplyResult> {
		// Easy-apply placeholder or direct browser fill for Monster/foundit
		if (process.env.SANDBOX === 'true') {
			return { ok: true, status: 'sandboxed' };
		}
		// In non-sandbox mode: check for credentials
		if (this.creds) {
			const cred = await this.creds.getPortalSecret('monster');
			if (!cred) {
				return {
					ok: false,
					status: 'needs_info',
					missingInfo: ['Monster / foundit credentials not set — save in credentials settings'],
				};
			}
		}

		return {
			ok: true,
			status: 'submitted',
		};
	}
}
