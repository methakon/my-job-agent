import { Injectable, Logger } from '@nestjs/common';

/**
 * HrEmailInvestigator (FR-13) — escalating investigation to find a real HR
 * contact for a company when the job description itself has none:
 *   1. curl the job posting URL → scan for emails
 *   2. curl company site career pages (/careers /jobs /about /contact …)
 *   3. homepage scan
 * EVIDENCE ONLY (user rule 2026-08-27): pattern-guessing role mailboxes
 * (hr@ careers@ …) is FORBIDDEN — a guessed address is never a channel.
 * If no evidence-based contact exists, return null; the apply engine then
 * falls through to portal apply (last uploaded CV, no tailoring) or the
 * company ATS link instead.
 * Results are cached per company (in-memory + DB later) with confidence.
 */
export interface HrContact {
	email: string;
	confidence: 'high' | 'medium' | 'low';
	source: string; // where it was found: 'jd' | 'job-page' | 'careers-page:<path>' | 'pattern-guess'
}

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const CAREER_PATHS = ['/careers', '/jobs', '/career', '/about', '/contact', '/company/careers', '/join-us'];
const ROLE_PREFIXES = ['hr', 'careers', 'jobs', 'talent', 'recruiting', 'recruitment', 'hiring', 'apply'];
const NOISE_RE = /(noreply|no-reply|donotreply|example\.(com|org)|sentry\.io|wixpress|googlemail.*noreply|w3\.org|wcap|privacy|dataprotection|gdpr|webmaster|abuse|postmaster|feedback|unsubscribe)/i;

/** Last-two-labels base domain (naukri.com, co.uk etc.) for cross-domain guards. */
const baseDomain = (d: string): string => d.replace(/^www\./, '').toLowerCase().split('.').slice(-2).join('.');

@Injectable()
export class HrEmailInvestigator {
	private readonly logger = new Logger(HrEmailInvestigator.name);
	private cache = new Map<string, HrContact | null>();

	/** Main entry: find the best HR contact for a company/job. */
	async investigate(company: string, jobUrl?: string | null, description?: string | null): Promise<HrContact | null> {
		const cacheKey = `${company}:${jobUrl ?? ''}`;
		if (this.cache.has(cacheKey)) return this.cache.get(cacheKey)!;

		const result = await this.run(company, jobUrl, description);
		this.cache.set(cacheKey, result);
		return result;
	}

	private async run(company: string, jobUrl?: string | null, description?: string | null): Promise<HrContact | null> {
		// 0. description already had one? (handled upstream, but double-check)
		const fromDesc = this.scanText(description ?? '', `desc:${company}`);
		if (fromDesc.length > 0) return this.pickBest(fromDesc, 'high');

		// 1. curl the actual job posting page
		if (jobUrl) {
			const pageContacts = await this.curlAndScan(jobUrl, 'job-page');
			if (pageContacts.length > 0) return this.pickBest(pageContacts, 'high');
		}

		// 2. find company website domain
		const domain = await this.findCompanyDomain(company);
		if (!domain) return null;
		this.logger.log(`company domain resolved: ${company} -> ${domain}`);

		// 3. career/contact pages on the domain
		for (const path of CAREER_PATHS) {
			const contacts = await this.curlAndScan(`https://${domain}${path}`, `careers-page:${path}`);
			if (contacts.length > 0) return this.pickBest(contacts, 'medium');
		}
		// also scan homepage
		const home = await this.curlAndScan(`https://${domain}`, 'home-page');
		if (home.length > 0) return this.pickBest(home, 'medium');

		// EVIDENCE ONLY (user rule 2026-08-27): no pattern-guessing role
		// mailboxes (hr@ careers@ …). A guessed address is never a channel —
		// return null so the engine falls through to portal / ATS apply.
		return null;
	}

	/** Fetch a URL and extract non-noise emails (job/career context preferred).
	 *  Domain guard: emails must share the page host's base domain — footer/badge
	 *  addresses from unrelated domains (w3.org, github.io, portals) are dropped. */
	private async curlAndScan(url: string, source: string): Promise<HrContact[]> {
		try {
			const res = await fetch(url, {
				headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/121 Safari/537.36' },
				signal: AbortSignal.timeout(12_000),
			});
			if (!res.ok) return [];
			const html = await res.text();
			const pageHost = new URL(url).hostname;
			return this.scanText(html, source).filter((c) => baseDomain(c.email) === baseDomain(pageHost));
		} catch {
			return [];
		}
	}

	private scanText(text: string, source: string): HrContact[] {
		const matches = text.match(EMAIL_RE) ?? [];
		const seen = new Set<string>();
		const out: HrContact[] = [];
		for (const raw of matches) {
			const email = raw.toLowerCase();
			if (seen.has(email) || NOISE_RE.test(email)) continue;
			seen.add(email);
			// mailto links / hr-ish local parts get priority ordering naturally by confidence pick
			out.push({ email, confidence: 'medium', source });
		}
		return out.slice(0, 10);
	}

	/** Prefer HR-flavoured addresses among candidates. */
	private pickBest(candidates: HrContact[], minConfidence: HrContact['confidence']): HrContact | null {
		const hrFlavoured = candidates.find((c) =>
			ROLE_PREFIXES.some((p) => c.email.startsWith(p)) || /human.?resources|hiring|talent/i.test(c.email),
		);
		if (hrFlavoured) return { ...hrFlavoured, confidence: 'high' };
		return candidates[0] ? { ...candidates[0], confidence: minConfidence } : null;
	}

	/** Resolve company → website domain. */
	private async findCompanyDomain(company: string): Promise<string | null> {
		// heuristic 1: direct guesses, verified via DNS A record (DoH) — more
		// reliable than HTTP HEAD (small sites often block HEAD or have TLS quirks)
		const slug = company.toLowerCase().replace(/[^a-z0-9]+/g, '');
		for (const dom of [`${slug}.com`, `${slug}.io`, `${slug}.co`, `${slug}.in`, `${slug}.tech`, `${slug}.net`]) {
			if (await this.dnsResolves(dom)) return dom;
		}
		// heuristic 2: DuckDuckGo HTML search — parse ONLY real result links
		try {
			const res = await fetch(`https://duckduckgo.com/html/?q=${encodeURIComponent(company + ' careers site')}`, {
				headers: { 'User-Agent': 'Mozilla/5.0 Chrome/121' },
				signal: AbortSignal.timeout(10_000),
			});
			const html = await res.text();
			const resultLinks = [...html.matchAll(/result__a"[^>]*href="https?:\/\/([^\/"#?]+)/gi)].map((m) => m[1].replace(/^www\./, ''));
			for (const dom of resultLinks) {
				if (this.isPortalDomain(dom) || !dom.includes('.')) continue;
				return dom;
			}
		} catch { /* ignore */ }
		return null;
	}

	/** Domains that are never a company's own careers site. */
	private isPortalDomain(domain: string): boolean {
		return /(w3\.org|github\.io|gitlab\.io|wordpress\.com|wixsite|blogspot|naukri|linkedin|indeed|glassdoor|remotive|remoteok|stackoverflow|wikipedia|facebook|twitter|instagram|youtube|duckduckgo|cloudflare)/i.test(domain);
	}

	private async dnsResolves(domain: string): Promise<boolean> {
		try {
			const res = await fetch(`https://cloudflare-dns.com/dns-query?name=${domain}&type=A`, {
				headers: { accept: 'application/dns-json' },
				signal: AbortSignal.timeout(6_000),
			});
			const data = (await res.json()) as { Answer?: Array<{ type: number }> };
			return Array.isArray(data.Answer) && data.Answer.some((a) => a.type === 1);
		} catch {
			return false;
		}
	}
}
