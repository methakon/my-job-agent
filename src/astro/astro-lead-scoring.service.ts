import { Injectable, Logger } from '@nestjs/common';
import { AstroMuhurtaService } from './astro-muhurta.service';

/**
 * AstroLeadScoringService — scores a job lead against the user's Vedic
 * significations so the agent prefers jobs that align with his chart:
 *
 * - Rahu Mahadasha until 2037 → Rahu significations: foreign/global,
 *   technology, software, innovation, out-of-the-box, networks.
 * - Lagna Virgo (Mercury) + 10th-lord significations: communication,
 *   data, analysis, IT services, backend logic, writing.
 * - Saturn + Mars in lagna: backend/infrastructure, disciplined
 *   engineering, systems, databases.
 * - Moon Aries Bharani: leadership, initiative, pioneering, energy.
 *
 * Scoring is additive keyword matching over (title + company + description)
 * with weighted dasha significations; the result is 0–100 with human-readable
 * reasons. This is a heuristic alignment, not a classical horary judgment —
 * it ranks *which* jobs suit the chart, while AstroMuhurtaService decides
 * *when* (shubh muhurta) to apply.
 */
export interface AstroLeadScore {
	score: number;
	/** human-readable list of matched significations */
	reasons: string[];
	/** current muhurta snapshot at scoring time */
	muhurta: { shubh: boolean; score: number; label: string };
}

const RAHU_TERMS = [
	'remote', 'global', 'international', 'worldwide', 'distributed', 'foreign',
	'cloud', 'saas', 'platform', 'ai', 'ml', 'data science', 'innovation',
	'startup', 'product', 'blockchain', 'open source', 'developer experience',
	'edge', 'fintech', 'web3', 'automation', 'scalable', 'microservices',
];
const MERCURY_TERMS = [
	'typescript', 'javascript', 'node', 'nestjs', 'backend', 'api', 'rest',
	'graphql', 'full stack', 'full-stack', 'software engineer', 'developer',
	'coding', 'programming', 'communication', 'documentation', 'analytics',
	'data', 'sql', 'database', 'technical', 'engineering',
];
const SATURN_TERMS = [
	'infrastructure', 'devops', 'reliability', 'sre', 'database administrator',
	'mysql', 'postgres', 'systems', 'architecture', 'legacy', 'migration',
	'monitoring', 'security', 'compliance', 'enterprise',
];
const MARS_TERMS = [
	'lead', 'senior', 'principal', 'team lead', 'leadership', 'initiative',
	'fast-paced', 'scale', 'high-performance', 'ownership', 'impact',
];

@Injectable()
export class AstroLeadScoringService {
	private readonly logger = new Logger(AstroLeadScoringService.name);

	constructor(private readonly muhurta: AstroMuhurtaService) {}

	score(
		title: string,
		company: string,
		description: string | null | undefined,
		now = new Date(),
	): AstroLeadScore {
		const haystack = `${title} ${company} ${description ?? ''}`.toLowerCase();
		const reasons: string[] = [];
		let score = 0;

		const count = (terms: string[], label: string, weight: number): number => {
			const hits = terms.filter((t) => haystack.includes(t));
			if (hits.length) {
				reasons.push(`${label}: ${hits.slice(0, 4).join(', ')}`);
				score += Math.min(weight, hits.length * (weight / 3));
			}
			return hits.length;
		};

		// Rahu MD (2037) dominates — foreign/tech/innovation weighted highest
		count(RAHU_TERMS, 'Rahu MD (foreign/tech/innovation)', 40);
		// Mercury lagna + 10th lord — core dev work
		count(MERCURY_TERMS, 'Mercury lagna (dev/data/communication)', 30);
		// Saturn in lagna — backend/infra discipline
		count(SATURN_TERMS, 'Saturn lagna (backend/infra)', 15);
		// Mars in lagna — senior/leadership
		count(MARS_TERMS, 'Mars lagna (senior/leadership)', 15);

		const final = Math.min(100, Math.round(score));
		const m = this.muhurta.assess(now);
		return {
			score: final,
			reasons: reasons.length ? reasons : ['no astro signification keywords matched'],
			muhurta: { shubh: m.shubh, score: m.score, label: this.muhurta.describeNext(now) },
		};
	}
}
