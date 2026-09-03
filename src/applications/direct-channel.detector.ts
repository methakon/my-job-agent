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
	[/https?:\/\/[a-z0-9.-]*myworkdayjobs\.com\/(?:[a-z0-9_-]+\/)?(?:job|details)\/[^\s"'<>]+/i, 'workday'],
];

/** Career-path segment that marks a page as job-related. */
const CAREER_TOKEN_RE = /^(?:jobs?|careers?|positions?|openings?|vacanc\w*|apply|listing|job|req-?\w*|requisition\w*)$/i;
/** A final path segment that is only a generic listing bucket (index page). */
const GENERIC_INDEX_SEGMENT_RE = /^(?:jobs?|careers?|positions?|openings?)$/i;

/** Portal/aggregator hosts — their postings are never a direct company channel. */
const PORTAL_HOST_RE = /(^|\.)(naukri\.com|linkedin\.com|indeed\.com|remoteok\.com|remotive\.com|englishjobs\.no|finn\.no|h1bvisajobs\.com|dev\.to|glassdoor\.com|monster\.com|ziprecruiter\.com|careerjet\.com|jooble\.org|adzuna\.\w+|dice\.com|simplyhired\.com|technojobs\.net|learn4good\.com|eurojobs\.com|jobstreet\.\w+|seek\.com|bebee\.\w+|workable\.com)$/i;

export type CompanyUrlClass = 'board' | 'company-specific' | 'company-index' | 'portal' | 'other';

/** Normalize a host for classification (lowercase, strip www.). */
export function bareHost(url: string): string {
	try {
		return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
	} catch {
		return '';
	}
}

export function isPortalHost(host: string): boolean {
	return PORTAL_HOST_RE.test(host);
}

export function isBoardUrl(url: string): boolean {
	return ATS_PATTERNS.some(([re]) => re.test(url));
}

/**
 * Classify an absolute URL as an ATS board, a company career page that points
 * at a SPECIFIC posting (drivable), a company careers INDEX (not drivable —
 * no single job to fill), a portal posting, or something else entirely.
 */
export function classifyCompanyUrl(url: string): CompanyUrlClass {
	if (isBoardUrl(url)) return 'board';
	const host = bareHost(url);
	if (!host) return 'other';
	if (isPortalHost(host)) return 'portal';
	let path: string;
	try {
		path = new URL(url).pathname.replace(/\/+$/, '');
	} catch {
		return 'other';
	}
	const segments = path.split('/').filter(Boolean);
	if (segments.length === 0) return 'other';
	const last = segments[segments.length - 1];
	const hasCareerToken = segments.some((s) => CAREER_TOKEN_RE.test(s));
	if (!hasCareerToken) return 'other';
	if (GENERIC_INDEX_SEGMENT_RE.test(last) && segments.length <= 2) return 'company-index';
	return 'company-specific';
}

/**
 * DirectChannelDetector — finds a way to apply DIRECTLY to the company
 * (preferred) before falling back to portal easy-apply (last resort).
 *
 * Priority (user-mandated always-company rule FR-19 + channel list):
 *   1. Company ATS page / company apply page linked in the posting
 *      (Greenhouse/Lever/Workable/Ashby/Workday + company career URLs)
 *   2. Posting URL itself is (or redirects to) a company apply page
 *   3. HR/recruiting email visible in the description
 *   4. (caller falls back to) portal easy-apply
 */
@Injectable()
export class DirectChannelDetector {
	private readonly logger = new Logger(DirectChannelDetector.name);

	/**
	 * Resolve the best apply channel for a lead.
	 * Optionally probes Greenhouse's public API to confirm the job is live,
	 * and follows short HTTP redirect chains on company posting URLs.
	 */
	async detect(lead: ScrapedLead): Promise<DirectChannel | null> {
		const text = `${lead.description ?? ''} ${lead.url ?? ''}`;

		// 1. Known ATS board links in the posting (verified where possible).
		for (const [re, name] of ATS_PATTERNS) {
			const m = text.match(re);
			if (!m) continue;
			const target = await this.canonicalAtsUrl(name, m);
			if (target) {
				this.logger.log(`direct ATS channel found for "${lead.title}" via ${name}`);
				return { kind: 'ats', target, detectedBy: name };
			}
		}

		// 2. Company apply page linked in the description (FR-19 always-company).
		const linked = this.companyApplyLinkInText(lead.description ?? '');
		if (linked) {
			this.logger.log(`company apply-page channel for "${lead.title}" -> ${linked}`);
			return { kind: 'ats', target: linked, detectedBy: 'company-apply-link' };
		}

		// 3. The posting URL itself is (or redirects to) a company apply page.
		if (lead.url) {
			const host = bareHost(lead.url);
			if (host && !isPortalHost(host) && !isBoardUrl(lead.url)) {
				const resolved = await this.resolveCompanyRedirect(lead.url);
				const finalUrl = resolved ?? lead.url;
				const klass = classifyCompanyUrl(finalUrl);
				if (klass === 'board') {
					// Redirect landed on an ATS board — canonicalize it.
					for (const [re, name] of ATS_PATTERNS) {
						const m = finalUrl.match(re);
						if (!m) continue;
						const target = await this.canonicalAtsUrl(name, m);
						if (target) {
							this.logger.log(`posting ${lead.url} redirects to ATS board ${name} -> ${target}`);
							return { kind: 'ats', target, detectedBy: `company-redirect-${name}` };
						}
					}
				} else if (klass === 'company-specific') {
					const by = resolved && resolved !== lead.url ? 'company-redirect' : 'company-apply-page';
					this.logger.log(`company apply-page channel for "${lead.title}" -> ${finalUrl} (${by})`);
					return { kind: 'ats', target: finalUrl, detectedBy: by };
				} else if (klass === 'company-index') {
					// A careers INDEX has no single posting to drive; leave the
					// lead to email/portal/manual paths (never silently skip).
					this.logger.log(`careers index (no specific posting): ${finalUrl} — not a drivable direct channel`);
				}
			}
		}

		// 4. HR email visible in the description.
		const email = this.findHrEmail(text);
		if (email && !this.isPortalNoise(email)) {
			this.logger.log(`direct EMAIL channel found for "${lead.title}" -> ${email}`);
			return { kind: 'email', target: email, detectedBy: 'description-email' };
		}
		return null;
	}

	/**
	 * First absolute http(s) URL in the description whose host is a company
	 * (not a portal) and whose path points at a SPECIFIC posting.
	 */
	private companyApplyLinkInText(description: string): string | null {
		const links = description.match(/https?:\/\/[^\s"'<>)]+/gi);
		if (!links) return null;
		for (const raw of links) {
			const url = raw.replace(/[.,;:!?]+$/g, '');
			const host = bareHost(url);
			if (!host || isPortalHost(host)) continue;
			const klass = classifyCompanyUrl(url);
			if (klass === 'company-specific') return url;
		}
		return null;
	}

	/** Follow a short HTTP redirect chain without downloading bodies. */
	private async resolveCompanyRedirect(url: string): Promise<string | null> {
		let current = url;
		let finalUrl = url;
		try {
			for (let hop = 0; hop < 6; hop += 1) {
				const res = await fetch(current, {
					method: 'GET',
					redirect: 'manual',
					signal: AbortSignal.timeout(8000),
					headers: { 'user-agent': 'Mozilla/5.0 (job-apply-channel-probe)' },
				});
				if (res.status >= 300 && res.status < 400) {
					const loc = res.headers.get('location');
					if (!loc) return finalUrl;
					finalUrl = new URL(loc, current).toString();
					current = finalUrl;
					continue;
				}
				return finalUrl;
			}
			return finalUrl;
		} catch {
			return null;
		}
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
		// portal no-reply / system / badge / footer addresses are not HR contacts.
		// w3.org badge addresses (team-wcap-contact@w3.org) appear in scraped page
		// footers of aggregator postings (naukri etc.) — never an HR channel.
		return /(^|@)(no-?reply|noreply|donotreply|info|careers|team-wcap-contact|w3\.org|@jobs\.|@careers\.|privacy|dataprotection|gdpr|webmaster|abuse|postmaster|feedback|unsubscribe|admin@|careers@remoteok|remotive)/i.test(email);
	}
}
