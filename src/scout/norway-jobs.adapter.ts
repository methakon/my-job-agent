import { Injectable, Logger } from '@nestjs/common';
import { ScrapedLead, PortalAdapter, ApplyResult } from '../applications/portal-adapter.interface';

/**
 * NorwayJobsAdapter — scrapes englishjobs.no (markdown format) for
 * English-speaking software jobs in Norway. HK-dir verified education makes
 * the candidate eligible for the Norwegian Skilled Worker permit; roles pay
 * above the UDI floor (~NOK 545k/yr bachelor-level).
 */
const SOURCE_URL = 'https://englishjobs.no/jobs/software?format=markdown&sort=date';
const CITIES = /(Oslo|Bergen|Trondheim|Stavanger|Kristiansand|Tromsø|narvik|haugesund|sandnes|drammen|fredrikstad|Bærum|Asker)/i;

@Injectable()
export class NorwayJobsAdapter implements PortalAdapter {
	readonly source = 'norway';
	readonly label = 'Norway (English jobs)';
	private readonly logger = new Logger(NorwayJobsAdapter.name);

	async scrape(): Promise<ScrapedLead[]> {
		const res = await fetch(SOURCE_URL, {
			headers: { 'User-Agent': 'my-job-agent/0.1', Accept: 'text/markdown,text/html' },
		});
		if (!res.ok) throw new Error(`norway scrape HTTP ${res.status}`);
		const md = await res.text();

		const leads: ScrapedLead[] = [];
		const seen = new Set<string>();
		// Blocks look like:
		// [### Title](/clickout/<id>?...)
		//
		// * Company
		// * city
		// * Month DD
		//
		// description snippet...
		const blockRe = /\[###\s+([^\]]+)\]\((\/clickout(?:_alt)?\/[a-f0-9]+)[^)]*\)\s*\n\n((?:\*[^\n]+\n)+)\n?([\s\S]{0,600}?)(?=\n\n?\[###|\n\nreport probem|$)/g;
		let m: RegExpExecArray | null;
		while ((m = blockRe.exec(md)) !== null && leads.length < 40) {
			const [, rawTitle, href, metaBlock, snippet] = m;
			const title = rawTitle.replace(/\*/g, '').trim();
			if (!title || seen.has(href)) continue;
			seen.add(href);

			const metaLines = metaBlock.split('\n').map((l) => l.replace(/^[*-]\s*/, '').trim()).filter(Boolean);
			const company = metaLines[0] ?? 'Norway employer';
			const city = metaLines.find((l) => CITIES.test(l)) ?? '';
			const location = city ? `${city}, Norway` : 'Norway';

			leads.push({
				source: this.source,
				externalId: href.replace('/clickout', '').replace(/[^a-f0-9]/g, '') || href,
				title,
				company,
				location,
				description: snippet.replace(/\*/g, '').replace(/\s+/g, ' ').trim().slice(0, 1500),
				url: `https://englishjobs.no${href}`,
			});
		}
		this.logger.log(`norway scrape: ${leads.length} jobs`);
		return leads;
	}

	async apply(
		lead: ScrapedLead,
		_profile: Record<string, string>,
		_answers: Record<string, string>,
	): Promise<ApplyResult> {
		// Norwegian employers take direct applications on their own site —
		// the direct-channel detector handles ATS/email; otherwise manual.
		return {
			ok: false,
			status: 'needs_info',
			missingInfo: [`apply directly at employer site: ${lead.url ?? 'unknown'}`],
		};
	}
}
