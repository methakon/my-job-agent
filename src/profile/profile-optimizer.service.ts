import { Injectable } from '@nestjs/common';
import { CandidateProfile } from './candidate-profile.entity';
import { ProfileRepository } from './profile.repository';

export interface WorkStint {
	company: string;
	role: string;
	from: string;
	to: string;
	summary?: string;
	/** User policy (2026-08-27): tagged=true means this stint is < 4 months and must be SKIPPED when building tailored CVs for sending/applying. Kept in the profile section document. */
	tagged?: boolean;
}

export interface EducationEntry {
	school: string;
	degree: string;
	from: string;
	to: string;
	note?: string;
}

export interface ProjectEntry {
	name: string;
	client?: string;
	tech: string[];
	from?: string;
	to?: string;
	summary?: string;
}

export interface OptimizedProfile {
	completenessScore: number; // 0-100
	profile: Record<string, string>;
	workHistory: WorkStint[];
	droppedStints: WorkStint[];
	/** Education history — ALL entries, descending by start then end date. */
	education: EducationEntry[];
	/** Major projects — ALL kept here; the CV builder selects/orders by JD skill relevance. */
	projects: ProjectEntry[];
	notes: string[];
}

const MIN_STINT_MONTHS = 4; // tag stints shorter than this (user policy 2026-08-27)
// user policy 2026-08-27 (verbatim): "keep all of them in profile section document tagged
// for those who are less than 4 month but ignore them while creating tailored cv for sending
// or appliying". Profile already keeps all 11 stints ✓. Optimizer now TAGS short stints
// instead of dropping them; CV builder skips tagged entries. LinkedIn easy-apply uses last
// uploaded CV only (no custom tailoring).

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
		const parse = (s: string): number => {
			if (s === 'present') return Date.now();
			const iso = /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00Z` : `${s}-01T00:00:00Z`;
			return new Date(iso).getTime();
		};
		const f = parse(from);
		const t = parse(to);
		if (Number.isNaN(f) || Number.isNaN(t)) return 999;
		return Math.round((t - f) / (30.44 * 864e5));
	}

	async optimize(): Promise<OptimizedProfile> {
		const p = await this.profileRepo.findFirst();
		if (!p) {
			return { completenessScore: 0, profile: {}, workHistory: [], droppedStints: [], education: [], projects: [], notes: ['no profile saved yet'] };
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
			// NEW POLICY (2026-08-27): never drop — tag stints under 4 months.
			// The last job is still never tagged as short even if it's short, but
			// that's an edge case (the most recent stint rarely qualifies).
			if (months >= 0 && months < MIN_STINT_MONTHS && months < 12 && !isMostRecent(stint)) {
				const tagged: WorkStint = { ...stint, tagged: true };
				kept.push(tagged);
				notes.push(`tagged ${stint.company} (${months} mo — under ${MIN_STINT_MONTHS} month threshold, tagged for CV exclusion)`);
			} else {
				kept.push(stint);
			}
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

		// Major projects — ALL kept (never dropped); selection/ordering for the
		// CV happens in the builder by JD skill relevance (user rule 2026-08-27).
		let projects: ProjectEntry[] = [];
		try {
			projects = p.projectsJson ? JSON.parse(p.projectsJson) : [];
		} catch {
			projects = [];
		}

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
					.filter(([k, v]) => !k.startsWith('workHistory') && !k.startsWith('education') && !k.startsWith('projects') && (typeof v === 'string' || typeof v === 'number'))
					.map(([k, v]) => [k, String(v)]),
			),
			workHistory: kept,
			droppedStints: dropped,
			education,
			projects,
			notes,
		};
	}
}
