import { Injectable, Logger } from '@nestjs/common';
import { ScrapedLead, PortalAdapter, ApplyResult } from '../applications/portal-adapter.interface';

/**
 * A1GroupAdapter — A1 Telekom Austria Group careers (jobs.a1.com).
 *
 * Data source (reverse-engineered from the site's job-listing block bundle,
 * 2026-08-27): the vacancy list is NOT WordPress posts — it is fetched from
 *   GET https://jobs.a1.com/wp-json/a1-group/v1/filter-jobs?country=<slug>
 * JSON items: { id, title, url, company, location,
 *               type: { category, timeType, remoteType } }
 * `per_page` is hard-capped at 6 server-side → paginate with `page=`.
 *
 * Countries: austria, bulgaria, croatia, north-macedonia, serbia, slovenia.
 *
 * Language rule (user rule, mirrors the Norway adapter): German-language
 * postings are dropped (Austrian roles are often German: (w/m/d), :in,
 * Mitarbeiter, Praktikum, ä/ö/ü/ß …) plus non-IT roles (shop/sales).
 *
 * Apply chain: A1 posts redirect to a Workday ATS
 * (a1group.wd3.myworkdayjobs.com). The adapter resolves the Workday apply
 * URL from each kept lead's detail page and embeds it in the description so
 * DirectChannelDetector labels the lead `workday` (company ATS) and the
 * pre-apply queue stages it — FR-19: company site only, never quick-apply.
 */

const BASE = 'https://jobs.a1.com';
const JOBS_API = `${BASE}/wp-json/a1-group/v1/filter-jobs`;
const WORKDAY_RE = /https:\/\/[a-z0-9.-]*myworkdayjobs\.com\/[^\s"'<>]+/i;

const COUNTRIES: Array<{ slug: string; label: string }> = [
	{ slug: 'austria', label: 'Austria' },
	{ slug: 'bulgaria', label: 'Bulgaria' },
	{ slug: 'croatia', label: 'Croatia' },
	{ slug: 'north-macedonia', label: 'North Macedonia' },
	{ slug: 'serbia', label: 'Serbia' },
	{ slug: 'slovenia', label: 'Slovenia' },
];

/** German-language markers — drop the posting entirely. */
const GERMAN_RE =
	/\((w\/m\/d|m\/w\/d|w\/m|m\/w)\)|(:in\b)|(mitarbeiter|praktikum|verkauf|berater|kaufmann|betreuer|leiter|assistenz|buchhaltung|sachbearbeiter|bachelorarbeit|masterarbeit|bewerb|lehre|ausschreibung)/i;
/** Umlauts/ß in a title are a strong German signal. */
const UMLAUT_RE = /[äöüßÄÖÜ]/;
/** Non-IT role categories that never match a backend profile. */
const NON_IT_RE =
	/\b(sales|shop|store|retail|vertrieb|call center|reception|bartender|waiter|cashier|driver|warehouse|logistik|produktion|mechatronik|qa|quality assurance)\b/i;
/** IT/tech keywords that make an English-title role worth keeping. */
const IT_RE =
	/\b(developer|engineer|software|programmer|backend|frontend|front-end|fullstack|full-stack|devops|cloud|data|security|network|system|sre|platform|infrastructure|it |product owner|scrum master|solution architect|automation|test|qa|mobile|ios|android|java|javascript|typescript|node|python|golang|php|react|angular|sql|database)\b/i;

interface A1JobItem {
	id: string;
	title: string;
	url: string;
	company: string;
	location: string;
	type?: { category?: string; timeType?: string; remoteType?: string };
}

@Injectable()
export class A1GroupAdapter implements PortalAdapter {
	readonly source = 'a1group';
	readonly label = 'A1 Group (jobs.a1.com)';
	private readonly logger = new Logger(A1GroupAdapter.name);
	/** Cap pages per country so one scout run stays bounded (~40 reqs). */
	private static readonly MAX_PAGES_PER_COUNTRY = 10;

	async scrape(): Promise<ScrapedLead[]> {
		const leads: ScrapedLead[] = [];
		for (const c of COUNTRIES) {
			try {
				const countryLeads = await this.scrapeCountry(c.slug, c.label);
				leads.push(...countryLeads);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				this.logger.warn(`a1group scrape failed for ${c.slug}: ${msg}`);
			}
		}
		this.logger.log(`a1group scrape: ${leads.length} English/IT leads kept`);
		return leads;
	}

	private async scrapeCountry(slug: string, label: string): Promise<ScrapedLead[]> {
		const out: ScrapedLead[] = [];
		let page = 1;
		for (;;) {
			const url = `${JOBS_API}?country=${slug}&page=${page}`;
			const res = await fetch(url, {
				headers: { 'User-Agent': 'Mozilla/5.0 (my-job-agent/0.1)' },
				signal: AbortSignal.timeout(20_000),
			});
			if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
			const data = (await res.json()) as { items: A1JobItem[]; maxPages: number; totalItems: number };
			if (!data.items?.length) break;

			for (const it of data.items) {
				if (!this.keep(it)) continue;
				const workdayUrl = await this.resolveWorkdayUrl(it.url);
				out.push({
					source: this.source,
					externalId: it.id,
					title: it.title.trim(),
					company: it.company?.trim() || 'A1 Group',
					location: `${it.location?.trim() ?? ''}, ${label}`,
					description: [
						`${it.title.trim()} at ${it.company || 'A1 Group'} — ${it.location ?? label} (${label}).`,
						it.type ? `${it.type.category ?? ''} · ${it.type.timeType ?? ''} · ${it.type.remoteType ?? ''}` : '',
						workdayUrl ? `Apply: ${workdayUrl}` : '',
					].filter(Boolean).join(' '),
					url: workdayUrl ?? it.url,
				});
			}

			if (page >= (data.maxPages ?? 1) || page >= A1GroupAdapter.MAX_PAGES_PER_COUNTRY) break;
			page++;
		}
		this.logger.log(`a1group ${slug}: ${out.length} kept`);
		return out;
	}

	/** German + non-IT veto; keep only English-title IT roles. */
	private keep(it: A1JobItem): boolean {
		const t = it.title;
		if (GERMAN_RE.test(t) || UMLAUT_RE.test(t) || NON_IT_RE.test(t)) return false;
		return IT_RE.test(t);
	}

	/** Fetch the detail page and pull the Workday apply link out of it. */
	private async resolveWorkdayUrl(detailUrl: string | undefined): Promise<string | null> {
		if (!detailUrl) return null;
		try {
			const res = await fetch(detailUrl, {
				headers: { 'User-Agent': 'Mozilla/5.0 (my-job-agent/0.1)' },
				signal: AbortSignal.timeout(20_000),
			});
			if (!res.ok) return null;
			const html = await res.text();
			const m = html.match(WORKDAY_RE);
			return m ? m[0].replace(/&amp;/g, '&') : null;
		} catch {
			return null;
		}
	}

	async apply(
		lead: ScrapedLead,
		_profile: Record<string, string>,
		_answers: Record<string, string>,
	): Promise<ApplyResult> {
		// Workday external applications require an account; FR-19 keeps
		// company-site-only, so the lead is staged in the pre-apply queue
		// (channel: workday ATS) for the user to approve / manual-apply.
		const target = lead.url?.includes('myworkdayjobs') ? lead.url : undefined;
		return {
			ok: false,
			status: 'needs_info',
			missingInfo: [
				target
					? `Workday ATS application requires an account: ${target} — approve in pre-apply queue for staged manual apply`
					: `apply at company site: ${lead.url ?? 'unknown'}`,
			],
		};
	}
}
