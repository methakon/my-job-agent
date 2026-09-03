import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { ScrapedLead } from '../applications/portal-adapter.interface';
import { RemotiveAdapter, RemoteOkAdapter } from './public-api.adapters';
import { NorwayJobsAdapter } from './norway-jobs.adapter';
import { NaukriAdapter } from './naukri.adapter';
import { MonsterAdapter } from './monster.adapter';
import { FinnAdapter } from './finn.adapter';
import { A1GroupAdapter } from './a1-group.adapter';
import { WorkableAdapter } from './workable.adapter';
import { Micro1JobsAdapter } from './micro1.adapter';
import { FoundeverAdapter } from './foundever.adapter';
import { BicsomAdapter } from './bicsom.adapter';
import { TinyFishAdapter } from './tinyfish.adapter';
import { PortalCredentialService } from '../applications/portal-credential.service';
import { InboxReaderService } from '../applications/inbox-reader.service';
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
		new MonsterAdapter(),
		new WorkableAdapter(),
		new Micro1JobsAdapter(),
		new FoundeverAdapter(),
		new BicsomAdapter(),
	];

	constructor(
		private readonly leadRepo: LeadRepository,
		private readonly profileService: ProfileService,
		private readonly creds: PortalCredentialService,
		private readonly inbox: InboxReaderService,
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

	/** FINN needs creds (email) + inbox (OTP), so it's also lazy. */
	private finnAdapter: FinnAdapter | null = null;
	private getFinn(): FinnAdapter {
		if (!this.finnAdapter) {
			this.finnAdapter = new FinnAdapter(this.creds, this.inbox);
			this.adapters.push(this.finnAdapter);
		}
		return this.finnAdapter;
	}

	/** TinyFish runs only when a key exists (costs credits per run). */
	private tinyFishAdapter: TinyFishAdapter | null = null;
	private getTinyFish(): TinyFishAdapter | null {
		if (!process.env.TINYFISH_API_KEY) return null;
		if (!this.tinyFishAdapter) {
			this.tinyFishAdapter = new TinyFishAdapter();
			// Timer-collected results store straight into the normal pipeline.
			this.tinyFishAdapter.onCollected(async (leads) => this.storeAndScore(leads));
			this.adapters.push(this.tinyFishAdapter);
		}
		return this.tinyFishAdapter;
	}

	/** Runs every SCOUT_INTERVAL_MINUTES (default 60 — FR-18 hourly fetch). */
	@Interval(Number(process.env.SCOUT_INTERVAL_MINUTES || 60) * 60 * 1000)
	async runScheduled(): Promise<void> {
		await this.runOnce();
	}

	async runOnce(): Promise<{ scraped: number; newLeads: number }> {
		this.getNaukri(); // ensure naukri adapter registered
		this.getFinn(); // ensure finn adapter registered (scrape needs no login)
		this.getTinyFish(); // register only when TINYFISH_API_KEY present
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
		// TinyFish scrape() launches async runs and returns []; collect any runs
		// that completed since the last cycle (timer polls also store directly).
		try {
			const tf = this.getTinyFish();
			if (tf) newLeads += await tf.collectPending();
		} catch (err) {
			this.logger.warn(`tinyfish collect failed: ${String(err)}`);
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
		let rawScore = 0;
		for (const skill of skills) {
			const inTitle = titleLower.includes(skill);
			const inDesc = descWords.includes(skill);
			if (!inTitle && !inDesc) continue;
			matched.push(skill);
			rawScore += inTitle ? 2 : 1;
		}
		// require at least one skill hit IN THE TITLE or 3 distinct skills overall
		const titleHits = matched.filter((s) => titleLower.includes(s)).length;
		if (matched.length === 0 || (titleHits === 0 && matched.length < 3)) {
			return { score: 0, matched: [] };
		}

		// --- scoring hygiene ---
		// 1) Scale to 100 only when ALL profile skills match (was 130 — too generous
		//    for a 13-skill profile; generic boilerplate descriptions could hit 100
		//    with a single title keyword + a few desc mentions).
		const pct = Math.round((rawScore / Math.max(allSkills.length, 5)) * 100);

		// 2) Penalise jobs whose PRIMARY stack (title) is a technology the profile
		//    does not include — prevents Java / Spring / Ruby / Rails roles scoring
		//    high on backend-keyword matches alone.
		const profileSet = new Set(allSkills);
		const FOREIGN_TITLE = [
			'java', 'spring boot', 'springboot', 'spring framework',
			'ruby', 'rails', 'ruby on rails', 'ror',
			'python', 'django', 'flask', 'fastapi',
			'dotnet', '.net', 'c#', 'csharp',
			'golang', 'go lang',
			'swift', 'kotlin', 'android',
			'rust', 'scala', 'elixir', 'phoenix',
			'perl', 'c++', 'cpp',
		];
		const foreignHits = FOREIGN_TITLE.filter((kw) => titleLower.includes(kw) && !profileSet.has(kw));
		const cap = foreignHits.length ? 55 : 100;

		return { score: Math.min(cap, pct), matched };
	}

	private async storeAndScore(leads: ScrapedLead[]): Promise<number> {
		const profileSkills = (await this.profileService.getResponse())?.skills ?? [];
		// Score only against the candidate's REAL skills. TARGET_SKILLS is a
		// fallback ONLY when no profile exists — never merged on top of a real
		// profile, otherwise skills the user does not have (react, ruby, java…)
		// would inflate match scores.
		const skills = profileSkills.length ? profileSkills : TARGET_SKILLS;
		const haystackSkills = skills.map((s) => s.toLowerCase());
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
