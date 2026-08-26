import { Injectable, Logger } from '@nestjs/common';
import { ScrapedLead, PortalAdapter, ApplyResult } from '../applications/portal-adapter.interface';
import { PortalCredentialService } from '../applications/portal-credential.service';
import { InboxReaderService } from '../applications/inbox-reader.service';

/**
 * FinnAdapter — FINN.no (Norway's largest marketplace / job board).
 *
 * Search requires NO login: results are server-side rendered into the search
 * page as base64 JSON in <script data-react-query-state>, 50 docs per page.
 *
 * Login uses Schibsted Vend passwordless OTP flow (documented in
 * docs/TODO.md, commit 0764407):
 *   1. GET login.vend.no/authn/?client_sdrn=…finn-client… → #bffData
 *      (csrfToken + client id)
 *   2. POST /authn/api/identity/passwordless-start/ (email) → passwordlessToken
 *   3. OTP email arrives — subject contains "innloggingskoden til FINN.no" —
 *      read via InboxReaderService.readOtp('finn')
 *   4. POST /authn/api/identity/passwordless-code/ (code) → next.href
 *   5. GET next.href with cookie jar → schibsted session cookie set
 *
 * Apply: most finn.no ads hand off to the employer's own ATS (Webcruiter,
 * Jobbnorge, …) via /job-apply/{adId}/apply — the apply engine's direct
 * channel machinery (browser automation / HR email) handles those. This
 * adapter's apply() resolves the real target and reports needs_info with it
 * when the submission must happen on an external site.
 */
const AUTHN_URL =
	'https://login.vend.no/authn/?client_sdrn=sdrn%3Aspid.no%3Aclient%3A5087dc1b421c7a0b79000000' +
	'&redirect_uri=https%3A%2F%2Fwww.finn.no%2Fauth%2FloginCallback' +
	'&client_id=5087dc1b421c7a0b79000000&scope=openid';
const BFF_HOST = 'https://login.vend.no';
const SEARCH_URL = 'https://www.finn.no/job/search';
const UA =
	'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** English-only IT job titles (fast pre-filter before fetching ad pages). */
const TITLE_DEV_RE =
	/\b(developer|engineer|backend|frontend|full[- ]?stack|software|node|typescript|javascript|python|java|react|cloud|devops|data\s|senior|lead|architect|sdet|api|fullstack|systemutvikler|utvikler)\b/i;

/** Norwegian-only ads are dropped (user wants English-speaking jobs in Norway). */
const NORWEGIAN_CHARS = /[æøåÆØÅ]/g;

interface CookieJar {
	[name: string]: { value: string; domain: string };
}

interface FinnSession {
	cookies: Record<string, string>;
}

@Injectable()
export class FinnAdapter implements PortalAdapter {
	readonly source = 'finn';
	readonly label = 'FINN.no (Norway)';
	private readonly logger = new Logger(FinnAdapter.name);
	private session: FinnSession | null = null;

	constructor(
		private readonly creds?: PortalCredentialService,
		private readonly inbox?: InboxReaderService,
	) {}

	// ------------------------------------------------------------------ login
	/** OTP login against Schibsted Vend. Returns true when session cookie set. */
	async login(): Promise<boolean> {
		const email = await this.loginEmail();
		if (!email) {
			this.logger.warn('finn login: no email — store portal:finn credential or set FINN_EMAIL');
			return false;
		}
		const jar = new Map<string, string>();

		// 1. authn page → csrfToken + client id
		const authn = await this.get(AUTHN_URL, jar);
		const bff = /<div id="bffData"[^>]*>\s*([\s\S]*?)\s*<\/div>/.exec(authn);
		if (!bff) {
			this.logger.warn('finn login: bffData block not found on authn page');
			return false;
		}
		let bffJson: { csrfToken?: string; client?: { id?: string } };
		try {
			bffJson = JSON.parse(decodeHtmlEntities(bff[1]));
		} catch (e) {
			this.logger.warn(`finn login: bffData parse failed: ${String(e).slice(0, 120)}`);
			return false;
		}
		const csrf = bffJson.csrfToken ?? '';
		const clientId = bffJson.client?.id ?? '';
		if (!csrf || !clientId) {
			this.logger.warn('finn login: csrfToken/client.id missing from bffData');
			return false;
		}

		// 2. passwordless-start (email OTP trigger)
		const sessionId = cryptoRandomUuid();
		const startRes = await fetch(`${BFF_HOST}/authn/api/identity/passwordless-start/?client_id=${clientId}`, {
			method: 'POST',
			headers: {
				accept: 'application/json',
				'content-type': 'application/x-www-form-urlencoded; charset=utf-8',
				'x-csrf-token': csrf,
				'x-session-id': sessionId,
				cookie: jarToCookie(jar),
				'user-agent': UA,
			},
			body: new URLSearchParams({
				connection: 'email',
				email,
				deviceData: JSON.stringify(minimalDeviceData()),
			}).toString(),
			redirect: 'manual',
		});
		absorbCookies(startRes, jar);
		const startBody = await startRes.json().catch(() => null);
		const passwordlessToken = startBody?.data?.attributes?.token;
		if (!startRes.ok || !passwordlessToken) {
			this.logger.warn(
				`finn login: passwordless-start failed HTTP ${startRes.status}: ${JSON.stringify(startBody).slice(0, 200)}`,
			);
			return false;
		}

		// 3. OTP from Gmail (subject: "Innloggingskoden din til FINN.no")
		if (!this.inbox) {
			this.logger.warn('finn login: InboxReaderService not available for OTP');
			return false;
		}
		let otp: string | null = null;
		for (let attempt = 0; attempt < 5 && !otp; attempt++) {
			await sleep(attempt === 0 ? 6000 : 8000);
			const mail = await this.inbox.readOtp('finn', 10);
			otp = mail?.code ?? null;
		}
		if (!otp) {
			this.logger.warn('finn login: no OTP email received within timeout');
			return false;
		}

		// 4. passwordless-code → next.href carries the session redirect
		const codeRes = await fetch(`${BFF_HOST}/authn/api/identity/passwordless-code/?client_id=${clientId}`, {
			method: 'POST',
			headers: {
				accept: 'application/json',
				'content-type': 'application/x-www-form-urlencoded; charset=utf-8',
				'x-csrf-token': csrf,
				'x-session-id': sessionId,
				cookie: jarToCookie(jar),
				'user-agent': UA,
			},
			body: new URLSearchParams({
				code: otp,
				remember: JSON.stringify(true),
				connection: 'email',
				passwordlessToken,
			}).toString(),
			redirect: 'manual',
		});
		absorbCookies(codeRes, jar);
		const codeBody = await codeRes.json().catch(() => null);
		const nextHref = codeBody?.next?.href;
		if (!codeRes.ok || !nextHref) {
			this.logger.warn(
				`finn login: passwordless-code failed HTTP ${codeRes.status}: ${JSON.stringify(codeBody).slice(0, 200)}`,
			);
			return false;
		}

		// 5. follow the session-establishing redirect
		await this.get(nextHref.startsWith('http') ? nextHref : `${BFF_HOST}${nextHref}`, jar);

		this.session = { cookies: Object.fromEntries(jar) };
		this.logger.log('finn logged in via OTP');
		return true;
	}

	private async loginEmail(): Promise<string | null> {
		const envEmail = process.env.FINN_EMAIL?.trim();
		if (envEmail) return envEmail;
		const cred = await this.creds?.getPortalSecret('finn');
		return cred?.username?.trim() || null;
	}

	private async ensureSession(): Promise<boolean> {
		if (this.session) return true;
		return this.login();
	}

	// ------------------------------------------------------------------ scrape
	async scrape(): Promise<ScrapedLead[]> {
		const keywords = ['backend developer', 'full stack developer', 'node typescript', 'software engineer'];
		const seen = new Set<string>();
		const leads: ScrapedLead[] = [];
		for (const kw of keywords) {
			try {
				const page = await this.get(`${SEARCH_URL}?q=${encodeURIComponent(kw)}`, new Map());
				for (const doc of extractSearchDocs(page)) {
					const adId = String(doc.ad_id ?? doc.id ?? '');
					if (!adId || seen.has(adId)) continue;
					seen.add(adId);
					const title = String(doc.heading ?? doc.job_title ?? '').trim();
					if (!TITLE_DEV_RE.test(title)) continue; // English-IT pre-filter
					leads.push({
						source: this.source,
						externalId: adId,
						title,
						company: String(doc.company_name ?? 'unknown').trim(),
						location: String(doc.location ?? doc.locations?.[0] ?? '').trim() || null,
						description: null, // enriched below for promising leads
						url: String(doc.canonical_url ?? `https://www.finn.no/job/ad/${adId}`),
					});
				}
			} catch (err) {
				this.logger.warn(`finn search "${kw}" failed: ${String(err).slice(0, 150)}`);
			}
		}
		// Enrich descriptions (concurrency 3, capped) — needed by the 3-skill scorer rule.
		await enrichDescriptions(leads.slice(0, 30), this);
		return leads.filter((l) => isEnglishJob(l.description ?? `${l.title} ${l.company}`));
	}

	/** Follow the job-apply URL to its real destination (usually external ATS). */
	async resolveApplyUrl(adId: string): Promise<string> {
		const res = await fetch(`https://www.finn.no/job-apply/${adId}/apply`, {
			headers: { 'user-agent': UA },
			redirect: 'follow',
		});
		return res.url;
	}

	/**
	 * finn.no native submission is a full ATS-style form (CV upload etc.).
	 * The engine's direct channel machinery handles the real ATS/email path;
	 * here we resolve the actual destination so needs_info carries a usable URL.
	 */
	async apply(lead: ScrapedLead, _profileData: Record<string, string>, _answers: Record<string, string>): Promise<ApplyResult> {
		if (!(await this.ensureSession())) {
			return { ok: false, status: 'failed', errorDetail: 'finn not authenticated (OTP login failed)' };
		}
		const adId = lead.externalId;
		try {
			const target = await this.resolveApplyUrl(adId);
			const external = !/^https:\/\/www\.finn\.no\//.test(target);
			return {
				ok: false,
				status: 'needs_info',
				missingInfo: [
					external
						? `finn.no hands off to external ATS — apply at ${target}`
						: `finn.no native apply form at ${target} requires manual/CV upload`,
				],
				errorDetail: target,
			};
		} catch (err) {
			return { ok: false, status: 'failed', errorDetail: `finn apply resolve failed: ${String(err).slice(0, 200)}` };
		}
	}

	/** Used by the enrichment helper; keep fetch logic in one place. */
	async get(url: string, jar: Map<string, string>): Promise<string> {
		const headers: Record<string, string> = { 'user-agent': UA, accept: 'text/html,application/json' };
		if (jar.size > 0) headers.cookie = jarToCookie(jar);
		const res = await fetch(url, { headers, redirect: 'follow' });
		absorbCookies(res, jar);
		return res.text();
	}
}

// ------------------------------------------------------------------ helpers

function decodeHtmlEntities(s: string): string {
	return s
		.replace(/&quot;/g, '"')
		.replace(/&#x27;|&#39;/g, "'")
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&amp;/g, '&');
}

function cryptoRandomUuid(): string {
	if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
	return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
		const r = (Math.random() * 16) | 0;
		return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
	});
}

/** Minimal but plausible Vend deviceData (fingerprint fields the BFF expects). */
function minimalDeviceData(): Record<string, unknown> {
	return {
		acceptLanguage: 'en-GB,en;q=0.9',
		screenSize: '1920x1080',
		userAgent: UA,
		deviceType: 'desktop',
		viewportSize: '1920x937',
		localStorageEnabled: true,
		platform: 'Linux x86_64',
	};
}

function absorbCookies(res: Response, jar: Map<string, string>): void {
	const setCookies = res.headers.getSetCookie?.() ?? [];
	for (const sc of setCookies) {
		const [pair, ...rest] = sc.split(';');
		const eq = pair.indexOf('=');
		if (eq < 0) continue;
		const name = pair.slice(0, eq).trim();
		const value = pair.slice(eq + 1).trim();
		if (!name) continue;
		const domainMatch = /domain=([^;]+)/i.exec(rest.join(';'));
		const domain = domainMatch ? domainMatch[1].trim().replace(/^\./, '') : '';
		// keep the most specific domain (longest) for a name — good enough for this flow
		const existing = jar.get(name);
		if (!existing || domain.length >= (existingDomain(existing) ?? '').length) {
			jar.set(name, value);
		}
	}
}

function existingDomain(_cookieValue: string): string | null {
	return null; // simplified jar: last write wins; domains are stable in this flow
}

function jarToCookie(jar: Map<string, string>): string {
	return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

/** Parse the SSR-embedded search results (base64 react-query-state). */
function extractSearchDocs(html: string): Array<Record<string, unknown>> {
	const m = /<script type="application\/json" data-react-query-state>([\s\S]*?)<\/script>/.exec(html);
	if (!m) return [];
	let raw: string;
	try {
		raw = decodeHtmlEntities(m[1]);
		raw = Buffer.from(raw, 'base64').toString('utf8');
		const data = JSON.parse(raw);
		for (const q of data.queries ?? []) {
			const docs = q?.state?.data?.docs;
			if (Array.isArray(docs)) return docs as Array<Record<string, unknown>>;
		}
	} catch {
		return [];
	}
	return [];
}

/** Fetch each lead's ad page and pull the JobPosting description. */
async function enrichDescriptions(leads: ScrapedLead[], adapter: FinnAdapter): Promise<void> {
	let cursor = 0;
	async function worker(): Promise<void> {
		while (cursor < leads.length) {
			const lead = leads[cursor++];
			if (!lead.url) continue;
			try {
				const html = await adapter.get(lead.url, new Map());
				const desc = extractJobPostingDescription(html);
				if (desc) lead.description = desc;
			} catch {
				/* keep null description */
			}
			await sleep(350); // polite pacing
		}
	}
	await Promise.all([worker(), worker(), worker()]);
}

/** Pull the JobPosting description from an ad page's ld+json block. */
function extractJobPostingDescription(html: string): string | null {
	const re = /<script type="application\/ld\+json">\{"script:ld\+json":\{"@context":"https:\/\/[^"]*","@type":"JobPosting"(.*?)\}\}\s*<\/script>/s;
	const m = re.exec(html);
	if (!m) return null;
	try {
		const d = JSON.parse('{"@context":"https://schema.org","@type":"JobPosting"' + m[1] + '}');
		const desc = String(d.description ?? '');
		const clean = desc
			.replace(/<a[^>]*>[\s\S]*?<\/a>/gi, ' ')
			.replace(/https?:\/\/\S+/g, ' ')
			.replace(/<[^>]+>/g, ' ')
			.replace(/\s+/g, ' ')
			.trim();
		return clean.slice(0, 3000) || null;
	} catch {
		return null;
	}
}

/** English-job filter: drop ads whose visible text is dominated by Norwegian. */
function isEnglishJob(text: string): boolean {
	const nw = (text.match(NORWEGIAN_CHARS) ?? []).length;
	if (nw === 0) return true;
	// >1 Norwegian char per ~80 chars of text → treat as Norwegian-language ad
	return nw / Math.max(text.length, 1) < 0.0125;
}
