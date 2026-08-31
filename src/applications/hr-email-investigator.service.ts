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
const CAREER_PATHS = ['/careers', '/jobs', '/career', '/careers-listing', '/openings', '/join-us', '/about', '/contact', '/company/careers'];
const ROLE_PREFIXES = ['hr', 'careers', 'jobs', 'talent', 'recruiting', 'recruitment', 'hiring', 'apply'];
const NOISE_RE = /(noreply|no-reply|donotreply|example\.(com|org)|sentry\.io|wixpress|googlemail.*noreply|w3\.org|wcap|privacy|dataprotection|gdpr|webmaster|abuse|postmaster|feedback|unsubscribe)/i;
// Generic role mailboxes (support@ info@ contact@ …) are NEVER evidence of an
// HR contact — an application sent there lands in a queue nobody reads for
// hiring (user rule 2026-08-28, flexm.com/support@ incident). HR-flavoured
// locals (hr@ careers@ talent@ …) stay eligible ONLY when actually found on
// a page — guessing them remains forbidden.
const GENERIC_LOCAL_RE = /^(support|info|contact|hello|hi|sales|admin|office|enquiries?|query|queries|help|team|general|marketing|press|media|subscribe|newsletter|accounts?|billing|legal|security|compliance|ops|operations?|service|services?|connect|start|business|partners?)$/i;

/** Last-two-labels base domain (naukri.com, co.uk etc.) for cross-domain guards.
 *  Accepts either a bare hostname or an email address (domain after @ is used). */
const baseDomain = (d: string): string => {
	const host = d.includes('@') ? d.split('@')[1] : d;
	return host.replace(/^www\./, '').toLowerCase().split('.').slice(-2).join('.');
};

@Injectable()
export class HrEmailInvestigator {
	private readonly logger = new Logger(HrEmailInvestigator.name);
	private investigateCache = new Map<string, HrContact | null>();
	private formCache = new Map<string, string | null>();

	/** Main entry: find the best HR contact for a company/job. */
	async investigate(company: string, jobUrl?: string | null, description?: string | null): Promise<HrContact | null> {
		const cacheKey = `${company}:${jobUrl ?? ''}`;
		if (this.investigateCache.has(cacheKey)) return this.investigateCache.get(cacheKey)!;

		const result = await this.run(company, jobUrl, description);
		this.investigateCache.set(cacheKey, result);
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

	/**
	 * FR-19 — find the company's OWN application form (no email evidence case).
	 * The company careers page usually has an apply form or an apply link; the
	 * browser agent fills it directly instead of emailing a generic support
	 * mailbox (user rule 2026-08-28, flexm.com incident: support@ is NOT an
	 * application channel — fill the form). Returns a URL to drive with
	 * BrowserFormService, or null if the company site has no discernible form.
	 */
	async findApplyFormUrl(company: string, jobUrl?: string | null): Promise<string | null> {
		const cacheKey = `form:${company}`;
		if (this.formCache.has(cacheKey)) return this.formCache.get(cacheKey)!;

		const domain = await this.findCompanyDomain(company);
		if (!domain) return null;
		const candidates: string[] = [jobUrl ?? '', `https://${domain}`, `https://www.${domain}`];
		for (const path of CAREER_PATHS) candidates.push(`https://${domain}${path}`, `https://www.${domain}${path}`);

		const seen = new Set<string>();
		for (const url of candidates) {
			if (!url || seen.has(url)) continue;
			seen.add(url);
			const formUrl = await this.scanForForm(url);
			if (formUrl) {
				this.formCache.set(cacheKey, formUrl);
				this.logger.log(`apply form found: ${company} -> ${formUrl}`);
				return formUrl;
			}
		}
		this.formCache.set(cacheKey, null);
		return null;
	}

	/** Fetch a page and return its URL if it hosts an application form (form
	 *  element with file/email/name inputs, or an "Apply"/"Submit application"
	 *  CTA — excluding pure newsletter subscribe forms). */
	private async scanForForm(url: string): Promise<string | null> {
		try {
			const res = await fetch(url, {
				headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/121 Safari/537.36' },
				signal: AbortSignal.timeout(12_000),
				redirect: 'follow',
			});
			if (!res.ok) return null;
			const html = await res.text();
			const lower = html.toLowerCase();
			// a real application form: has a file/upload input (resume) OR a
			// form mentioning application/apply/career in its markup
			const hasFileInput = /<input[^>]*type=["']file["']/i.test(html);
			const hasApplyForm = /<form[\s>][^>]*>[\s\S]{0,20000}?(name|email|phone|resume|cv|upload|apply|application|position|coverletter)/i.test(html);
			const hasApplyCta = /(apply now|apply for this job|submit application|send application|i'?m interested|job application)/i.test(lower);
			if ((hasFileInput || hasApplyForm) && hasApplyCta) return res.url;
			// an embedded careers ATS iframe/link pointing at a form on the same domain
			const applyHref = html.match(/href=["']([^"']*(apply|application|careers-listing|open-positions|openings)[^"']*)["']/i);
			if (applyHref && !/^(#|javascript)/i.test(applyHref[1])) {
				const target = new URL(applyHref[1], res.url);
				if (target.hostname.replace(/^www\./, '') === res.url.split('/')[2].replace(/^www\./, '')) {
					return await this.scanForForm(target.href) ?? target.href;
				}
			}
			return null;
		} catch {
			return null;
		}
	}

	/** Fetch a URL and extract non-noise emails (job/career context preferred).
	 *  Domain guard: emails must share the page host's base domain — footer/badge
	 *  addresses from unrelated domains (w3.org, github.io, portals) are dropped. */
	private async curlAndScan(url: string, source: string): Promise<HrContact[]> {
		const attempts = [url];
		// bare-domain self-redirect loops are common (301 -> same URL); the
		// www. variant usually serves fine — retry it before giving up
		if (!url.includes('://www.')) {
			attempts.push(url.replace('://', '://www.'));
		}
		for (const target of attempts) {
			try {
				const res = await fetch(target, {
					headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/121 Safari/537.36' },
					signal: AbortSignal.timeout(12_000),
					redirect: 'follow',
				});
				if (!res.ok) continue;
				const html = await res.text();
				const pageHost = new URL(res.url).hostname;
				return this.scanText(html, source).filter((c) => baseDomain(c.email) === baseDomain(pageHost));
			} catch {
				continue;
			}
		}
		return [];
	}

	private scanText(text: string, source: string): HrContact[] {
		const matches = text.match(EMAIL_RE) ?? [];
		const seen = new Set<string>();
		const out: HrContact[] = [];
		for (const raw of matches) {
			const email = raw.toLowerCase();
			if (seen.has(email) || NOISE_RE.test(email)) continue;
			seen.add(email);
			// Generic role mailboxes are NEVER application evidence — a support@
			// inbox is not an HR channel (user rule 2026-08-28). Personal-name
			// addresses (john.doe@) and HR-flavoured roles (hr@ talent@ …) stay.
			const local = email.split('@')[0];
			if (GENERIC_LOCAL_RE.test(local)) continue;
			out.push({ email, confidence: 'medium', source });
		}
		return out.slice(0, 10);
	}

	/**
	 * Pick the best candidate as the HR contact.
	 * - HR-flavoured addresses (hr@ careers@ talent@ …) are best — HIGH confidence.
	 * - A personal-name address (firstname.lastname@) is acceptable evidence —
	 *   it's a real person (recruiter/founder) and belongs to the company domain.
	 * - NEVER return a generic role mailbox (support@ info@ …) — those were
	 *   already dropped in scanText; this is the last line of defence.
	 */
	private pickBest(candidates: HrContact[], minConfidence: HrContact['confidence']): HrContact | null {
		const hrFlavoured = candidates.find((c) =>
			ROLE_PREFIXES.some((p) => c.email.startsWith(p)) || /human.?resources|hiring|talent/i.test(c.email),
		);
		if (hrFlavoured) return { ...hrFlavoured, confidence: 'high' };
		// no HR-flavoured address → a named personal address is still evidence
		const named = candidates.find((c) => /^[a-z0-9._-]+\.[a-z0-9._-]+@/.test(c.email) || /^(m|me|sri|dr|mr|ms)\.?[a-z]+@/i.test(c.email));
		if (named) return { ...named, confidence: minConfidence };
		// only generic/unknown role boxes remain → NOT evidence, fall through
		return null;
	}

	/** Resolve company → website domain. */
	private async findCompanyDomain(company: string): Promise<string | null> {
		// heuristic 1: direct guesses, verified via DNS A record (DoH) — more
		// reliable than HTTP HEAD (small sites often block HEAD or have TLS quirks)
		const slug = company.toLowerCase().replace(/[^a-z0-9]+/g, '');
		const brands = [slug];
		// brand-name candidates: "(iCloudEMS)" parentheticals and the leading word(s)
		// before "Pvt"/"Ltd"/"Inc"/"LLC" — the legal name slug often fails DNS while
		// the brand domain resolves (e.g. "CNV Labs India Pvt. Ltd (iCloudEMS)" -> icloudems.com)
		const paren = company.match(/\(([^)]+)\)/);
		if (paren) brands.push(paren[1].toLowerCase().replace(/[^a-z0-9]+/g, ''));
		const legalTrim = company.toLowerCase().replace(/\b(pvt|ltd|inc|llc|private|limited|technologies?|solutions?|systems?|labs?|labs|india|ind)\b\.?/g, '').replace(/[^a-z0-9]+/g, '');
		if (legalTrim.length >= 4) brands.push(legalTrim);
		for (const b of [...new Set(brands)]) {
			for (const dom of [`${b}.com`, `${b}.io`, `${b}.co`, `${b}.in`, `${b}.tech`, `${b}.net`]) {
				if (await this.dnsResolves(dom)) return dom;
			}
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
