import { Injectable } from '@nestjs/common';
import { CandidateProfile } from './candidate-profile.entity';
import { ProfileRepository } from './profile.repository';

export interface WorkStint {
	company: string;
	role: string;
	from: string;
	to: string;
	summary?: string;
}

export interface EducationEntry {
	school: string;
	degree: string;
	from: string;
	to: string;
	note?: string;
}

export interface OptimizedProfile {
	completenessScore: number; // 0-100
	profile: Record<string, string>;
	workHistory: WorkStint[];
	droppedStints: WorkStint[];
	/** Education history — ALL entries, descending by start then end date. */
	education: EducationEntry[];
	notes: string[];
}

const MIN_STINT_MONTHS = 4; // drop ONLY stints shorter than this (user rule 2026-08-27)
// user rule 2026-08-27 (verbatim): "it can remove only the company which i have
// worke duration of less than 3-4 month but last job should not be removed".
// So: stints under 4 months may be hidden — EXCEPT the most recent stint (the
// last job), which is NEVER removed regardless of duration; stints >= 12 months
// are never removed either. Ordering is the CV builder's job (descending by
// join date, then leave date).

/**
 * ProfileOptimizer — scores profile completeness and derives the
 * application-ready variant:
 *  - hides very short stints (< MIN_STINT_MONTHS) so CV screens don't see
 *    noise that invites gap questions (user-requested rule)
 *  - reports what was dropped and why.
 */
@Injectable()
export class ProfileOptimizer {
	constructor(private readonly profileRepo: ProfileRepository) {}

	private monthsBetween(from: string, to: string): number {
		const f = new Date(`${from}-01T00:00:00Z`).getTime();
		const t = to === 'present' ? Date.now() : new Date(`${to}-01T00:00:00Z`).getTime();
		if (Number.isNaN(f) || Number.isNaN(t)) return 999;
		return Math.round((t - f) / (30.44 * 864e5));
	}

	async optimize(): Promise<OptimizedProfile> {
		const p = await this.profileRepo.findFirst();
		if (!p) {
			return { completenessScore: 0, profile: {}, workHistory: [], droppedStints: [], education: [], notes: ['no profile saved yet'] };
		}

		let stints: WorkStint[] = [];
		try {
			stints = p.workHistoryJson ? JSON.parse(p.workHistoryJson) : [];
		} catch {
			stints = [];
		}

		// Merge consecutive stints at the SAME company (designation changes are
		// not new companies): combine period, join role titles.
		const merged: WorkStint[] = [];
		for (const stint of stints) {
			const prev = merged[merged.length - 1];
			if (prev && prev.company.toLowerCase() === stint.company.toLowerCase()) {
				if (stint.from < prev.from) prev.from = stint.from; // earlier start wins
				if (stint.to === 'present' || (prev.to !== 'present' && stint.to > prev.to)) {
					prev.to = stint.to; // later end wins
				}
				if (!prev.role.includes(stint.role)) prev.role = `${stint.role}, ${prev.role}`;
				if (stint.summary && !prev.summary) prev.summary = stint.summary;
			} else {
				merged.push({ ...stint });
			}
		}

		const kept: WorkStint[] = [];
		const dropped: WorkStint[] = [];
		const notes: string[] = [];

		// The most recent stint (last job) is identified by the latest start date,
		// then latest end date — it is NEVER dropped (user rule 2026-08-27).
		const ranked = [...merged].sort((a, b) => b.from.localeCompare(a.from) || b.to.localeCompare(a.to));
		const mostRecent = ranked[0];
		const isMostRecent = (s: WorkStint): boolean =>
			mostRecent !== undefined && s.company === mostRecent.company && s.from === mostRecent.from && s.to === mostRecent.to;

		for (const stint of merged) {
			const months = this.monthsBetween(stint.from, stint.to);
			// drop only stints under the threshold (and under 12 months); never the last job
			if (months >= 0 && months < MIN_STINT_MONTHS && months < 12 && !isMostRecent(stint)) {
				dropped.push(stint);
				notes.push(`hidden ${stint.company} (${months} mo — under ${MIN_STINT_MONTHS} month threshold, not the last job)`);
			} else {
				kept.push(stint);
			}
		}
		// keep at least the most substantial role even if all were short
		if (kept.length === 0 && dropped.length > 0) {
			const longest = dropped.sort((a, b) => this.monthsBetween(b.from, b.to) - this.monthsBetween(a.from, a.to))[0];
			kept.push(longest);
			notes.push(`kept ${longest.company} as longest experience despite short duration`);
		}

		// Education history — same rules as experience (FR-23): ALL entries kept,
		// descending by start then end date. Never dropped, never relevance-ordered.
		let education: EducationEntry[] = [];
		try {
			education = p.educationJson ? JSON.parse(p.educationJson) : [];
		} catch {
			education = [];
		}
		education = [...education].sort((a, b) => b.from.localeCompare(a.from) || b.to.localeCompare(a.to));

		// completeness score across application-critical fields
		const fields: Array<[() => unknown, number]> = [
			[() => p.name, 10],
			[() => p.email, 15],
			[() => p.phone, 10],
			[() => p.skills, 20],
			[() => p.noticePeriod, 10],
			[() => p.salaryExpectation, 10],
			[() => p.currentLocation, 5],
			[() => p.githubUrl || p.portfolioUrl, 10],
			[() => kept.length > 0, 10],
		];
		const score = fields.reduce((acc, [get, weight]) => acc + (get() ? weight : 0), 0);

		return {
			completenessScore: score,
			profile: Object.fromEntries(
				Object.entries(p as unknown as Record<string, unknown>)
					.filter(([k, v]) => !k.startsWith('workHistory') && !k.startsWith('education') && (typeof v === 'string' || typeof v === 'number'))
					.map(([k, v]) => [k, String(v)]),
			),
			workHistory: kept,
			droppedStints: dropped,
			education,
			notes,
		};
	}
}
