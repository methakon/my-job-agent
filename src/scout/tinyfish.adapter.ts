import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { ScrapedLead, PortalAdapter, ApplyResult } from '../applications/portal-adapter.interface';

/**
 * TinyFish discovery adapter (J-17 pilot).
 *
 * TinyFish is an external web-agent platform: we send a natural-language
 * "goal" plus a seed URL and it browses (its own browser, its own IPs) and
 * returns structured JSON. That removes our scraping/anti-bot burden AND
 * keeps the user's real LinkedIn profile untouched (no ban risk here).
 *
 * Runs are LONG (LinkedIn guest browsing can take 3-10+ min), so this
 * adapter is ASYNC by design:
 *   - scrape()        launches one async run per goal (skips goals that
 *                     already have a PENDING/RUNNING run) and returns []
 *                     immediately. Scout's hourly loop never stalls on us.
 *   - collectPending() polls the in-flight runs and maps COMPLETED results
 *                     into ScrapedLead[]. Called by ScoutService.runOnce
 *                     after the scrape loop AND by an internal timer so a
 *                     manual /leads/scout still yields leads ~1-2 min after
 *                     the run finishes instead of waiting for next hour.
 *   - Leads found are pushed through ScoutService.storeAndScore via the
 *                     onCollected sink (set by ScoutService in getTinyFish).
 *
 * Discovery-only for now ("dry-run apply"): scrape() returns no apply
 * channel, so leads land in the pre-apply queue for human approval exactly
 * like every other source.
 *
 * Env knobs:
 *   TINYFISH_API_KEY         required (presence also gates registration)
 *   TINYFISH_GOALS_JSON      optional: [{url,label,keywords:[...]}] — else
 *                            the LinkedIn default below
 *   TINYFISH_MAX_PER_GOAL    cap jobs collected per goal (default 12)
 *   TINYFISH_BROWSER_PROFILE 'lite' (default, fast) | 'stealth' (slower,
 *                            better vs hostile sites; escalate if we see
 *                            site-block errors)
 *   TINYFISH_POLL_MS         poll interval while runs are live (default 90s)
 *   TINYFISH_MAX_POLLS       cap polls per run before giving up to the
 *                            hourly cycle (default 30 ≈ 45 min)
 *
 * API notes (learned live 2026-09-03):
 *   - agent_config knobs (mode:'strict', max_steps, custom durations) are
 *     BETA-GATED: this account gets 403 FORBIDDEN unless enrolled at /beta.
 *     Omit agent_config entirely.
 *   - Sync POST /v1/automation/run can exceed 300s on LinkedIn and cannot
 *     be cancelled → run-async + GET /v1/runs/{id} is the right shape.
 *   - Run statuses: PENDING | RUNNING | COMPLETED | FAILED | CANCELLED.
 *   - With an output_schema, a COMPLETED run's `result` holds the parsed
 *     object (e.g. {jobs:[...]}).
 */
interface TinyFishGoal {
	url: string;
	label: string;
	keywords: string[];
}
interface PendingRun {
	runId: string;
	goalLabel: string;
	polling: boolean;
	polls: number;
}

@Injectable()
export class TinyFishAdapter implements PortalAdapter {
	readonly source = 'tinyfish';
	readonly label = 'TinyFish (external web agent)';
	private readonly logger = new Logger(TinyFishAdapter.name);
	private readonly apiKey = process.env.TINYFISH_API_KEY || '';
	private readonly baseUrl = 'https://agent.tinyfish.ai';
	private readonly maxPerGoal = Number(process.env.TINYFISH_MAX_PER_GOAL || 12);
	private readonly pollEveryMs = Number(process.env.TINYFISH_POLL_MS || 90_000);
	private readonly maxPolls = Number(process.env.TINYFISH_MAX_POLLS || 30);
	private readonly pending = new Map<string, PendingRun>();
	private pollTimer: NodeJS.Timeout | null = null;
	/** Sink for leads discovered OUTSIDE runOnce (timer polls). */
	private leadSink: ((leads: ScrapedLead[]) => Promise<number>) | null = null;

	private readonly defaultGoals: TinyFishGoal[] = [
		{
			url: 'https://www.linkedin.com/jobs/search?keywords=NestJS&f_WT=2&f_TPR=r604800&sortBy=DD',
			label: 'linkedin-nestjs-remote-7d',
			keywords: ['nestjs', 'node.js', 'nodejs', 'typescript', 'backend', 'full-stack', 'senior', 'developer', 'engineer'],
		},
	];

	private goals(): TinyFishGoal[] {
		const raw = process.env.TINYFISH_GOALS_JSON;
		if (!raw) return this.defaultGoals;
		try {
			const parsed = JSON.parse(raw) as TinyFishGoal[];
			if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((g) => g.url && g.label)) return parsed;
		} catch {
			this.logger.warn('TINYFISH_GOALS_JSON invalid — falling back to default goals');
		}
		return this.defaultGoals;
	}

	/** Registered by ScoutService; used to store timer-collected leads. */
	onCollected(fn: (leads: ScrapedLead[]) => Promise<number>): void {
		this.leadSink = fn;
	}

	async scrape(): Promise<ScrapedLead[]> {
		if (!this.apiKey) return [];
		const launched: string[] = [];
		for (const goal of this.goals()) {
			const inFlight = [...this.pending.values()].some((r) => r.goalLabel === goal.label);
			if (inFlight) continue;
			try {
				const runId = await this.startAsync(goal);
				this.pending.set(runId, { runId, goalLabel: goal.label, polling: false, polls: 0 });
				launched.push(goal.label);
			} catch (err) {
				this.logger.warn(`tinyfish ${goal.label} launch failed: ${String(err)}`);
			}
		}
		if (launched.length > 0) this.logger.log(`tinyfish launched async runs: ${launched.join(', ')}`);
		// First poll soon after launch (runs usually need a few minutes anyway).
		this.schedulePoll(30_000);
		return []; // async by design — results arrive via collectPending()
	}

	/**
	 * Poll in-flight runs, map COMPLETED results to leads, and push them
	 * through the sink (ScoutService.storeAndScore). Called from runOnce and
	 * the internal timer.
	 */
	async collectPending(): Promise<number> {
		if (!this.apiKey || this.pending.size === 0) return 0;
		let stored = 0;
		for (const [runId, run] of [...this.pending.entries()]) {
			if (run.polling) continue; // another poll path is already on it
			run.polling = true;
			run.polls += 1;
			try {
				const status = await this.fetchStatus(runId);
				if (status === 'COMPLETED') {
					const leads = await this.fetchLeads(runId);
					this.pending.delete(runId);
					if (leads.length > 0) {
						this.logger.log(`tinyfish ${run.goalLabel}: ${leads.length} jobs collected`);
						if (this.leadSink) stored += await this.leadSink(leads);
					}
				} else if (status === 'FAILED' || status === 'CANCELLED') {
					this.pending.delete(runId);
					this.logger.warn(`tinyfish ${run.goalLabel} run ended ${status}`);
				} else if (run.polls >= this.maxPolls) {
					this.pending.delete(runId);
					this.logger.warn(`tinyfish ${run.goalLabel} still ${status} after ${run.polls} polls — dropped, hourly cycle relaunches`);
				}
			} catch (err) {
				this.logger.warn(`tinyfish ${run.goalLabel} poll error: ${String(err)}`);
			} finally {
				run.polling = false;
			}
		}
		if (this.pending.size === 0 && this.pollTimer) {
			clearTimeout(this.pollTimer);
			this.pollTimer = null;
		}
		return stored;
	}

	/** PortalAdapter.apply — discovery-only pilot: no apply channel yet. */
	async apply(): Promise<ApplyResult> {
		return { ok: false, status: 'needs_info', missingInfo: ['TinyFish pilot is discovery-only; apply via the posting URL using the ATS/email direct channel'] };
	}

	// ---- internals -------------------------------------------------------

	private buildGoalText(goal: TinyFishGoal): string {
		return [
			`Visit the LinkedIn jobs search results at the given URL (remote roles, last 7 days, sorted by date).`,
			`Collect up to ${this.maxPerGoal} job postings that match backend/full-stack development for a senior Node.js/TypeScript/NestJS engineer.`,
			`Skip non-engineering roles (sales, marketing, QA, recruiters, data entry).`,
			`For each posting return: title (exact card title), company, location, and the canonical job URL (https://www.linkedin.com/jobs/view/<id>/ if visible, otherwise the href of the card).`,
			`Open up to 2 postings to read the description; if a description is not visible without signing in, set description to null and move on.`,
			`Do NOT sign in, do NOT create an account, do NOT click Apply. If a login wall appears, wait briefly and retry once; if it persists, return what you already collected.`,
			`Never fabricate or guess: skip any posting whose details you cannot actually read.`,
			'Return ONLY JSON matching this output_schema: {"jobs":[{"title":"...","company":"...","location":"...","url":"...","description":null}]}',
		].join(' ');
	}

	private outputSchema() {
		return {
			type: 'object',
			properties: {
				jobs: {
					type: 'array',
					items: {
						type: 'object',
						properties: {
							title: { type: 'string' },
							company: { type: 'string' },
							location: { type: 'string' },
							url: { type: 'string' },
							description: { type: 'string' },
						},
						required: ['title', 'company', 'url'],
					},
				},
			},
			required: ['jobs'],
		};
	}

	private async startAsync(goal: TinyFishGoal): Promise<string> {
		const res = await fetch(`${this.baseUrl}/v1/automation/run-async`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'X-API-Key': this.apiKey },
			body: JSON.stringify({
				url: goal.url,
				goal: this.buildGoalText(goal),
				output_schema: this.outputSchema(),
				browser_profile: process.env.TINYFISH_BROWSER_PROFILE || 'lite',
			}),
			signal: AbortSignal.timeout(30_000),
		});
		const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
		if (!res.ok) {
			const msg = typeof body.error === 'string' ? body.error : JSON.stringify(body);
			throw new Error(`HTTP ${res.status} ${msg}`);
		}
		const runId = typeof body.run_id === 'string' ? body.run_id : '';
		if (!runId) throw new Error(`no run_id in response: ${JSON.stringify(body).slice(0, 200)}`);
		return runId;
	}

	private async fetchStatus(runId: string): Promise<string> {
		const res = await fetch(`${this.baseUrl}/v1/runs/${runId}`, {
			headers: { 'X-API-Key': this.apiKey },
			signal: AbortSignal.timeout(30_000),
		});
		if (!res.ok) throw new Error(`status HTTP ${res.status}`);
		const body = (await res.json()) as Record<string, unknown>;
		return typeof body.status === 'string' ? body.status : 'FAILED';
	}

	private async fetchLeads(runId: string): Promise<ScrapedLead[]> {
		const res = await fetch(`${this.baseUrl}/v1/runs/${runId}`, {
			headers: { 'X-API-Key': this.apiKey },
			signal: AbortSignal.timeout(30_000),
		});
		if (!res.ok) throw new Error(`result HTTP ${res.status}`);
		const body = (await res.json()) as Record<string, unknown>;
		const result = body.result as { jobs?: unknown } | null;
		const rawJobs = Array.isArray(result?.jobs) ? (result.jobs as Record<string, unknown>[]) : [];
		const leads: ScrapedLead[] = [];
		for (const raw of rawJobs) {
			if (typeof raw.title !== 'string' || typeof raw.company !== 'string') continue;
			if (typeof raw.url !== 'string' || raw.url.length === 0) continue;
			leads.push({
				source: this.source,
				externalId: this.externalId(raw.url),
				title: raw.title.slice(0, 190),
				company: raw.company.slice(0, 140),
				location: typeof raw.location === 'string' ? raw.location.slice(0, 140) : '',
				description: typeof raw.description === 'string' ? raw.description : null,
				url: raw.url,
			});
		}
		return leads;
	}

	/** Stable dedupe id: LinkedIn job id when present, else sha1 of the URL. */
	private externalId(url: string): string {
		const view = /\/jobs\/view\/(\d+)/.exec(url);
		if (view) return view[1];
		return createHash('sha1').update(url).digest('hex').slice(0, 32);
	}

	private schedulePoll(delayMs: number): void {
		if (this.pollTimer || this.pending.size === 0 || !this.apiKey) return;
		this.pollTimer = setTimeout(() => {
			this.pollTimer = null;
			this.collectPending()
				.catch((err) => this.logger.warn(`tinyfish timer poll failed: ${String(err)}`))
				.finally(() => {
					if (this.pending.size > 0) this.schedulePoll(this.pollEveryMs);
				});
		}, delayMs);
	}
}
