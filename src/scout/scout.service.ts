import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { ScrapedLead } from '../applications/portal-adapter.interface';
import { RemotiveAdapter, RemoteOkAdapter } from './public-api.adapters';
import { NorwayJobsAdapter } from './norway-jobs.adapter';
import { NaukriAdapter } from './naukri.adapter';
import { PortalCredentialService } from '../applications/portal-credential.service';
import { LeadRepository } from '../leads/lead.repository';
import { ProfileService } from '../profile/profile.service';

const TARGET_SKILLS = ['nestjs', 'node', 'typescript', 'astro', 'mysql', 'react', 'full stack', 'full-stack', 'backend'];

@Injectable()
export class ScoutService {
	private readonly logger = new Logger(ScoutService.name);
	private readonly adapters: Array<{ source: string; scrape(): Promise<ScrapedLead[]> }> = [
		new RemotiveAdapter(),
		new RemoteOkAdapter(),
		new NorwayJobsAdapter(),
	];

	constructor(
		private readonly leadRepo: LeadRepository,
		private readonly profileService: ProfileService,
		private readonly creds: PortalCredentialService,
	) {}

	/** Naukri needs DI-provided credential service, so it's created lazily. */
	private naukriAdapter: NaukriAdapter | null = null;
	private getNaukri(): NaukriAdapter {
		if (!this.naukriAdapter) {
			this.naukriAdapter = new NaukriAdapter(this.creds);
			this.adapters.push(this.naukriAdapter);
		}
		return this.naukriAdapter;
	}

	/** Runs every SCOUT_INTERVAL_MINUTES (default 6h); also triggered manually. */
	@Interval(Number(process.env.SCOUT_INTERVAL_MINUTES || 360) * 60 * 1000)
	async runScheduled(): Promise<void> {
		await this.runOnce();
	}

	async runOnce(): Promise<{ scraped: number; newLeads: number }> {
		this.getNaukri(); // ensure naukri adapter registered
		let scraped = 0;
		let newLeads = 0;
		for (const adapter of this.adapters) {
			try {
				const leads = await adapter.scrape();
				scraped += leads.length;
				newLeads += await this.storeAndScore(leads);
			} catch (err) {
				this.logger.warn(`${adapter.source} scrape failed: ${String(err)}`);
			}
		}
		this.logger.log(`scout done: ${scraped} scraped, ${newLeads} new`);
		return { scraped, newLeads };
	}

	private async storeAndScore(leads: ScrapedLead[]): Promise<number> {
		const skills = ((await this.profileService.getResponse())?.skills ?? TARGET_SKILLS).map((s) => s.toLowerCase());
		const haystackSkills = [...new Set([...skills, ...TARGET_SKILLS])];
		let added = 0;
		for (const lead of leads) {
			if (await this.leadRepo.findByExternal(lead.source, lead.externalId)) continue;
			const text = `${lead.title} ${lead.description ?? ''}`.toLowerCase();
			const matched = haystackSkills.filter((s) => text.includes(s));
			if (matched.length === 0) continue; // not relevant at all — skip storage
			const matchScore = Math.min(100, Math.round((matched.length / Math.max(skills.length, 3)) * 100));
			await this.leadRepo.upsert({ ...lead, matchScore, matchedSkills: matched, status: 'new', scrapedAt: new Date() });
			added++;
		}
		return added;
	}
}
