import { Injectable, Logger } from '@nestjs/common';
import { ScrapedLead, PortalAdapter, ApplyResult } from '../applications/portal-adapter.interface';

const REMOTIVE_API = 'https://remotive.com/api/remote-jobs?search=node.js&limit=50';
const REMOTEOK_API = 'https://remoteok.com/api';

/** Public-API adapters (legal, no login). Naukri/Monster/LinkedIn adapters come as separate files. */
@Injectable()
export class RemotiveAdapter implements PortalAdapter {
	readonly source = 'remotive';
	readonly label = 'Remotive';

	async scrape(): Promise<ScrapedLead[]> {
		const res = await fetch(REMOTIVE_API);
		if (!res.ok) throw new Error(`remotive scrape HTTP ${res.status}`);
		const data = (await res.json()) as { jobs?: Array<Record<string, unknown>> };
		return (data.jobs ?? []).map((j) => ({
			source: this.source,
			externalId: String(j.id),
			title: String(j.title ?? ''),
			company: String(j.company_name ?? ''),
			location: (j.candidate_required_location as string) ?? null,
			description: (j.description as string)?.slice(0, 4000) ?? null,
			url: (j.url as string) ?? null,
		}));
	}

	async apply(_lead: ScrapedLead, _profile: Record<string, string>, _answers: Record<string, string>): Promise<ApplyResult> {
		// Remotive postings link to employer ATS pages — handled by the ATS adapter.
		return { ok: false, status: 'failed', errorDetail: 'remotive routes via ATS adapter' };
	}
}

interface RemoteOkJob {
	position?: string;
	company?: string;
	location?: string;
	description?: string;
	url?: string;
	slug?: string;
	id?: string;
}

@Injectable()
export class RemoteOkAdapter implements PortalAdapter {
	readonly source = 'remoteok';
	readonly label = 'RemoteOK';
	private readonly logger = new Logger(RemoteOkAdapter.name);

	async scrape(): Promise<ScrapedLead[]> {
		const res = await fetch(REMOTEOK_API, { headers: { 'User-Agent': 'my-job-agent/0.1' } });
		if (!res.ok) throw new Error(`remoteok scrape HTTP ${res.status}`);
		const data = (await res.json()) as RemoteOkJob[];
		return data
			.filter((j) => j && j.position)
			.map((j) => ({
				source: this.source,
				externalId: String(j.id ?? j.slug ?? j.position),
				title: String(j.position),
				company: String(j.company ?? ''),
				location: j.location ?? null,
				description: j.description?.replace(/<[^>]+>/g, '').slice(0, 4000) ?? null,
				url: j.url ? `https://remoteok.com${j.url}` : null,
			}));
	}

	async apply(_lead: ScrapedLead, _profile: Record<string, string>, _answers: Record<string, string>): Promise<ApplyResult> {
		return { ok: false, status: 'failed', errorDetail: 'remoteok routes via ATS adapter' };
	}
}
