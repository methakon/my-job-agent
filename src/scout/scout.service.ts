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

	/** Non-engineer role titles that must never match a dev profile. */
	private static readonly VETO_RE = /\b(graphic|visual)\s+designer\b|\bux\/?ui\b|\bqa\b|\btester?\b|data\s+entry|recruiter|sales|marketing|account(ant|manager)|content\s+writer|support\s+engineer|devops\s+intern|technical\s+writer|administrat/i;

	/**
	 * Score a lead against the profile (title-aware, boilerplate-stripped).
	 * - Title veto: non-dev roles score 0 and are not stored.
	 * - Title matches count double; boilerplate URLs/links stripped first.
	 */
	private scoreLead(title: string, description: string | null | undefined, skills: string[], allSkills: string[]): { score: number; matched: string[] } {
		const titleLower = title.toLowerCase();
		if (ScoutService.VETO_RE.test(titleLower)) return { score: 0, matched: [] };

		// strip URLs & HTML so boilerplate links can't contribute matches
		const cleanDesc = (description ?? '')
			.replace(/<a[^>]*>[\s\S]*?<\/a>/gi, ' ')
			.replace(/https?:\/\/\S+/g, ' ')
			.replace(/<[^>]+>/g, ' ');
		const descWords = cleanDesc.toLowerCase();

		const matched: string[] = [];
		let score = 0;
		for (const skill of skills) {
			const inTitle = titleLower.includes(skill);
			const inDesc = descWords.includes(skill);
			if (!inTitle && !inDesc) continue;
			matched.push(skill);
			score += inTitle ? 2 : 1;
		}
		// require at least one skill hit IN THE TITLE or 3 distinct skills overall
		const titleHits = matched.filter((s) => titleLower.includes(s)).length;
		if (matched.length === 0 || (titleHits === 0 && matched.length < 3)) {
			return { score: 0, matched: [] };
		}
		return { score: Math.min(100, Math.round((score / Math.max(allSkills.length, 5)) * 130)), matched };
	}

	private async storeAndScore(leads: ScrapedLead[]): Promise<number> {
		const skills = ((await this.profileService.getResponse())?.skills ?? TARGET_SKILLS).map((s) => s.toLowerCase());
		const haystackSkills = [...new Set([...skills, ...TARGET_SKILLS])];
		let added = 0;
		for (const lead of leads) {
			if (await this.leadRepo.findByExternal(lead.source, lead.externalId)) continue;
			const { score, matched } = this.scoreLead(lead.title, lead.description, haystackSkills, skills);
			if (score === 0) continue; // irrelevant / vetoed — skip storage
			await this.leadRepo.upsert({ ...lead, matchScore: score, matchedSkills: matched, status: 'new', scrapedAt: new Date() });
			added++;
		}
		return added;
	}
}
