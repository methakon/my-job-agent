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

export interface OptimizedProfile {
	completenessScore: number; // 0-100
	profile: Record<string, string>;
	workHistory: WorkStint[];
	droppedStints: WorkStint[];
	notes: string[];
}

const MIN_STINT_MONTHS = 5; // stints shorter than this are hidden from applications by default

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
			return { completenessScore: 0, profile: {}, workHistory: [], droppedStints: [], notes: ['no profile saved yet'] };
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

		for (const stint of merged) {
			const months = this.monthsBetween(stint.from, stint.to);
			if (months < MIN_STINT_MONTHS && months >= 0) {
				dropped.push(stint);
				notes.push(`hidden ${stint.company} (${months} mo — below ${MIN_STINT_MONTHS} month threshold)`);
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
					.filter(([k, v]) => !k.startsWith('workHistory') && (typeof v === 'string' || typeof v === 'number'))
					.map(([k, v]) => [k, String(v)]),
			),
			workHistory: kept,
			droppedStints: dropped,
			notes,
		};
	}
}
