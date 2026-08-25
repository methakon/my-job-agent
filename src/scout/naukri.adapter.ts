import { Injectable, Logger } from '@nestjs/common';
import { ScrapedLead, PortalAdapter, ApplyResult } from '../applications/portal-adapter.interface';
import { PortalCredentialService } from '../applications/portal-credential.service';
import { NkparamGenerator } from './nkparam.generator';

/**
 * NaukriAdapter — connects to the user's Naukri account (email+password
 * stored AES-256 encrypted in DB) to search jobs and one-click apply.
 *
 * Verified working 2026-08-25:
 *  - login: POST /central-login-services/v1/login → nauk_at Bearer cookie
 *  - search: GET /jobapi/v3/search with nkparam RSA signature header
 */
const BASE = 'https://www.naukri.com';
const SEARCH_URL = `${BASE}/jobapi/v3/search`;
const LOGIN_URL = `${BASE}/central-login-services/v1/login`;

interface NaukriSession {
	token: string;
	cookies: string;
}

@Injectable()
export class NaukriAdapter implements PortalAdapter {
	readonly source = 'naukri';
	readonly label = 'Naukri.com';
	private readonly logger = new Logger(NaukriAdapter.name);
	private session: NaukriSession | null = null;
	private readonly nkparam = new NkparamGenerator();

	constructor(private readonly creds: PortalCredentialService) {}

	async login(username: string, password: string): Promise<boolean> {
		const res = await fetch(LOGIN_URL, {
			method: 'POST',
			headers: {
				accept: 'application/json',
				appid: '105',
				clientid: 'd3skt0p',
				'content-type': 'application/json',
				referer: `${BASE}/nlogin/login`,
				systemid: 'jobseeker',
				'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/121 Safari/537.36',
			},
			body: JSON.stringify({ username, password }),
		});
		if (!res.ok) {
			this.logger.warn(`naukri login HTTP ${res.status}`);
			return false;
		}
		const setCookies = res.headers.getSetCookie?.() ?? [];
		const cookieStr = setCookies.map((c) => c.split(';')[0]).join('; ');
		const token = /nauk_at=([^;]+)/.exec(cookieStr)?.[1] ?? '';
		this.session = { token, cookies: cookieStr };
		this.logger.log(`naukri logged in as ${username} (token OK)`);
		return true;
	}

	private async ensureSession(): Promise<NaukriSession | null> {
		if (this.session) return this.session;
		const cred = await this.creds.getPortalSecret('naukri');
		if (!cred) {
			this.logger.warn('no naukri credentials stored');
			return null;
		}
		const ok = await this.login(cred.username, cred.secret);
		return ok ? this.session : null;
	}

	private searchHeaders(session: NaukriSession): Record<string, string> {
		return {
			accept: 'application/json',
			appid: '109',
			systemid: 'Naukri',
			nkparam: this.nkparam.generate('srp'),
			authorization: `Bearer ${session.token}`,
			cookie: session.cookies,
			'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/121 Safari/537.36',
		};
	}

	async scrape(): Promise<ScrapedLead[]> {
		const session = await this.ensureSession();
		if (!session) throw new Error('naukri not authenticated');

		const keywords = ['nestjs backend', 'node.js typescript backend'];
		const leads: ScrapedLead[] = [];
		for (const kw of keywords) {
			const url = `${SEARCH_URL}?noOfResults=30&urlType=search_by_keyword&searchType=adv&keyword=${encodeURIComponent(kw)}&wfhType=2`;
			const res = await fetch(url, { headers: this.searchHeaders(session) });
			if (!res.ok) {
				this.logger.warn(`naukri search "${kw}" HTTP ${res.status}`);
				continue;
			}
			const data = (await res.json()) as { jobDetails?: Array<Record<string, unknown>> };
			for (const j of data.jobDetails ?? []) {
				leads.push({
					source: this.source,
					externalId: String(j.jobId),
					title: String(j.title ?? ''),
					company: String((j.companyName as string) ?? (j.company as string) ?? 'unknown'),
					location: (j.placeholders as Array<{ type: string; label: string }> | undefined)
						?.find((ph) => ph.type === 'location')?.label ?? null,
					description: String((j.jobDescription as string) ?? '').replace(/<[^>]+>/g, '').slice(0, 3000),
					url: `${BASE}/job-listings-${String(j.jobId)}`,
				});
			}
		}
		return leads;
	}

	/** One-click easy apply on Naukri (cloudgateway apply-workflow, verified format from NopeRi). */
	async apply(
		lead: ScrapedLead,
		_profileData: Record<string, string>,
		_answers: Record<string, string>,
	): Promise<ApplyResult> {
		const session = await this.ensureSession();
		if (!session) return { ok: false, status: 'failed', errorDetail: 'naukri not authenticated' };
		const sid = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14) + '0000000';
		const res = await fetch(`${BASE}/cloudgateway-workflow/workflow-services/apply-workflow/v1/apply`, {
			method: 'POST',
			headers: {
				...this.searchHeaders(session),
				appid: '121',
				systemid: 'jobseeker',
				clientid: 'd3skt0p',
				'content-type': 'application/json',
			},
			body: JSON.stringify({
				strJobsarr: [lead.externalId],
				logstr: `--drecomm_apply-1-F-0-1--${sid}-`,
				flowtype: 'show',
				crossdomain: true,
				jquery: 1,
				rdxMsgId: '',
				chatBotSDK: true,
				mandatory_skills: [],
				optional_skills: [],
				applyTypeId: '107',
				closebtn: 'y',
				applySrc: 'drecomm_apply',
				sid,
				mid: '',
			}),
		});
		if (res.ok) return { ok: true, status: 'submitted' };
		const bodyText = await res.text().catch(() => '');
		return { ok: false, status: 'failed', errorDetail: `naukri apply HTTP ${res.status}: ${bodyText.slice(0, 150)}` };
	}

	/** Application history from Naukri (tracking FR-8). */
	async applicationHistory(): Promise<Array<Record<string, unknown>>> {
		const session = await this.ensureSession();
		if (!session) return [];
		const res = await fetch(`${BASE}/cloudgateway-apply/whtma-services/v0/applyapi/v5/history`, {
			headers: this.searchHeaders(session),
		});
		if (!res.ok) {
			this.logger.warn(`naukri history HTTP ${res.status}`);
			return [];
		}
		const data = (await res.json()) as { jobApplyDetails?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>;
		return Array.isArray(data) ? data : (data.jobApplyDetails ?? []);
	}
}
