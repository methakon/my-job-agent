import { Injectable, Logger } from '@nestjs/common';

/**
 * ApplicationProcessDetector (FR-10) + SelfImprovementEngine (FR-11).
 *
 * FR-10: Before applying anywhere, the engine READS the job description for
 * an explicit application process ("apply via", "send CV to", "click apply",
 * "email careers@…") and follows THAT process instead of assuming a channel.
 *
 * FR-11: Self-improvement loop — every application outcome (submitted,
 * opened/replied, rejected, needs_info reason) feeds back into weights that
 * tune future behaviour: which channels succeed, which keywords get responses,
 * optimal send times, per-portal success rates.
 */
export interface DetectedProcess {
	kind: 'email' | 'ats' | 'portal-form' | 'external-link';
	target?: string;
	instruction: string;
}

export interface LearningStats {
	channelSuccess: Record<string, { sent: number; replies: number }>;
	keywordReplies: Record<string, number>;
	bestSendHour: number | null;
	totalApplications: number;
}

const PROCESS_PATTERNS: Array<[RegExp, DetectedProcess['kind']]> = [
	[/send (?:your )?(?:cv|resume|application|profile)\s*(?:to|at)\s*([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/i, 'email'],
	[/(?:apply|applications?)\s*(?:via|by|through|to)\s*e-?mail\s*[:\-]?\s*([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/i, 'email'],
	[/e-?mail\s*(:)?\s*([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/i, 'email'],
	[/(greenhouse|lever|workable|ashby|smartrecruiters|teamtailor)/i, 'ats'],
	[/apply\s+(?:online|here|now|through (?:our|the) (?:website|portal|career))/i, 'portal-form'],
];

@Injectable()
export class ProcessLearningService {
	private readonly logger = new Logger(ProcessLearningService.name);

	/** FR-10: extract the employer's stated application process from the JD. */
	detectProcess(title: string, description: string | null | undefined, leadUrl?: string | null): DetectedProcess | null {
		const text = `${title}\n${description ?? ''}`;
		for (const [re, kind] of PROCESS_PATTERNS) {
			const m = text.match(re);
			if (!m) continue;
			if (kind === 'email') {
				const email = (m[1] || m[2] || '').toLowerCase();
				if (email && !/noreply|no-reply|example\./.test(email)) {
					return { kind: 'email', target: email, instruction: `JD says to email ${email} — following stated process` };
				}
			}
			if (kind === 'ats') {
				return { kind: 'ats', target: m[1], instruction: `JD mentions ${m[1]} ATS — use their form` };
			}
			if (kind === 'portal-form') {
				return { kind: 'portal-form', instruction: 'JD says apply online via company portal' };
			}
		}
		return null;
	}

	/** FR-11: record outcome; weights persisted in DB via answer bank pattern later. */
	async recordOutcome(
		statsRepo: { findOne: (o: unknown) => Promise<{ value: string } | null>; save: (s: unknown) => Promise<unknown> },
		outcome: { channel: string; replied?: boolean; keyword?: string; hour?: number },
	): Promise<void> {
		void statsRepo;
		void outcome;
		this.logger.debug('outcome recorded (weights table pending)');
	}

	stats(): LearningStats {
		return {
			channelSuccess: {},
			keywordReplies: {},
			bestSendHour: null,
			totalApplications: 0,
		};
	}
}
