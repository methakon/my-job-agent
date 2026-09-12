/**
 * GATE 4 #7 (roadmap row 44) — INDEPENDENT FadeScore and FollowScore.
 *
 * Single responsibility: turn the pre-open gap evidence into TWO SEPARATE, independently switchable
 * scores — how strongly the evidence supports FADING the gap vs FOLLOWING it — and say so explicitly
 * when it cannot. It is deliberately NOT one blended score: each side has its own switch, its own
 * component list and its own maximum.
 *
 * PURE: no clock, no I/O, no DB, no network, no AI, no randomness. Everything it needs is an argument.
 *
 * ── PINNED DEFINITION (inputs, weighting, units, edges) ─────────────────────────────────────
 *   Each score is the COUNT of equally-weighted, documented pre-open components that hold for the
 *   session — never a fitted weight:
 *
 *   FadeScore components (0..4)                       FollowScore components (0..4)
 *     f_materialGap   taxonomy class is not NONE       g_materialGap   taxonomy class is not NONE
 *     f_insideRange   GapRangePos in [0, 1]            g_outsideRange  GapRangePos < 0 or > 1
 *     f_counterTrend  prior session moved AGAINST       g_withTrend     prior session moved WITH
 *                     the gap direction                                 the gap direction
 *     f_withinSize    |gap| <= prior session range      g_sizeBreak     |gap| > prior session range
 *
 *   WEIGHTING: every component weighs exactly 1 (EQUAL_UNWEIGHTED). There is no coefficient to tune,
 *   no threshold chosen from historical outcomes, and no ranking of one session against another — a
 *   score is a count of stated facts about ONE session. The size bound is the same structural bound
 *   row 40 already uses (a gap at least as large as the whole prior range is a structural break).
 *
 *   UNITS: each score is an integer count (0..4); components are booleans; gapRatio is dimensionless.
 *
 *   LOOK-AHEAD: every input is knowable at the open — the gap geometry and the PRIOR session's
 *   range/trend (from the taxonomy) plus GapRangePos (from row 41). The session's own close/high/low
 *   and the outcome-derived class VALUE are never read: materiality is read only as "class is not
 *   NONE", which the taxonomy assigns from gap thresholds before it looks at any session OHLC.
 *
 * ── MISSING / DEGENERATE DATA → a safe explicit state, never a fabricated score ──────────────
 *     NO_GAP               the session has no gap (open == previous close): nothing to fade or follow
 *     TAXONOMY_UNAVAILABLE the taxonomy assessment is not OK (its reason is propagated verbatim)
 *     RANGE_POS_UNAVAILABLE GapRangePos is not OK (its reason is propagated verbatim)
 *     DISABLED             the side's own switch is off — computed nothing, said so
 *
 * RESEARCH / SHADOW ONLY: nothing in production imports this module (asserted by test); no state is
 * written and no decision, order or risk path reads it. Versioned: gapscore-v1.
 */

import { GapDirection, SessionGapAssessment } from './gap-taxonomy';
import { GapRangePosResult } from './gap-range-pos';

export const GAP_SCORES_VERSION = 'gapscore-v1';

export type GapScoreSide = 'FADE' | 'FOLLOW';
export const SCORE_SIDES: readonly GapScoreSide[] = ['FADE', 'FOLLOW'];

/** Canonical score statuses, in the order the count map is emitted. */
export const GAP_SCORE_STATUSES = ['OK', 'NOT_APPLICABLE', 'UNAVAILABLE', 'DISABLED'] as const;
export type GapScoreStatus = (typeof GAP_SCORE_STATUSES)[number];

/** Closed, published refusal vocabulary (declaration order is the canonical order). */
export const GAP_SCORE_REFUSALS = ['NO_GAP', 'TAXONOMY_UNAVAILABLE', 'RANGE_POS_UNAVAILABLE'] as const;
export type GapScoreRefusal = (typeof GAP_SCORE_REFUSALS)[number];

export const SCORE_COMPONENTS: Record<GapScoreSide, readonly string[]> = {
	FADE: ['f_materialGap', 'f_insideRange', 'f_counterTrend', 'f_withinSize'],
	FOLLOW: ['g_materialGap', 'g_outsideRange', 'g_withTrend', 'g_sizeBreak'],
};

export interface GapScoresConfig {
	fade: { enabled: boolean };
	follow: { enabled: boolean };
}

/** Two independent switches — one per side; neither reads the other. */
export const DEFAULT_GAP_SCORES_CONFIG: GapScoresConfig = {
	fade: { enabled: true },
	follow: { enabled: true },
};

/** Fields each side is allowed to read — the pre-open whitelist, pinned so a drive-by edit is visible. */
export const SCORE_REQUIRES = ['status', 'class', 'direction', 'gapRatio', 'measures.priorRange', 'measures.priorTrendUp'] as const;

export const GAP_SCORES_SPEC = {
	feature: 'FadeScore + FollowScore',
	version: GAP_SCORES_VERSION,
	question: 'How many documented pre-open components support fading the gap, and how many support following it?',
	weighting: 'EQUAL_UNWEIGHTED — every component weighs 1; no coefficient and no fitted threshold exists',
	components: SCORE_COMPONENTS,
	units: 'integer count 0..4 per side; components are booleans; gapRatio is dimensionless',
	lookAhead: 'pre-open inputs only (gap geometry + prior session range/trend + GapRangePos); materiality is read only as "class is not NONE"',
	refuses: [...GAP_SCORE_REFUSALS] as string[],
	missingData:
		'NO_GAP (no gap) / TAXONOMY_UNAVAILABLE or RANGE_POS_UNAVAILABLE (the parent refused — its reason is propagated verbatim) / DISABLED (that side is switched off) — score is null, never a fabricated number',
};

export interface SessionGapScores {
	sessionDate: string;
	instrument: string;
	status: GapScoreStatus;
	reason: GapScoreRefusal | null;
	reasonDetail: string | null;
	direction: GapDirection | null;
	/** The count of satisfied components, or null in every non-OK state. */
	score: number | null;
	maxScore: number;
	components: Record<string, boolean> | null;
	evidence: {
		gapRatio: number | null;
		gapRangePos: number | null;
		priorRange: number | null;
		priorTrendUp: number | null;
	};
}

export interface GapScoreBlock {
	side: GapScoreSide;
	enabled: boolean;
	maxScore: number;
	spec: typeof GAP_SCORES_SPEC;
	observations: SessionGapScores[];
	/** Distribution of the score over the OK rows: index = score, value = sessions. */
	distribution: number[];
	coverage: { inputsIn: number; ok: number; notApplicable: number; unavailable: number; disabled: number };
}

export interface GapScoreReport {
	version: string;
	config: GapScoresConfig;
	fade: GapScoreBlock;
	follow: GapScoreBlock;
	reviewerSummary: string;
	digest: string;
}

export const describeGapScores = (c: GapScoresConfig = DEFAULT_GAP_SCORES_CONFIG): string =>
	[
		`${GAP_SCORES_VERSION}: two INDEPENDENT, equally-weighted counts (no fitted weights) over pre-open gap evidence.`,
		`FADE enabled=${c.fade.enabled}: ${SCORE_COMPONENTS.FADE.join(' + ')} (each weighs 1, max 4).`,
		`FOLLOW enabled=${c.follow.enabled}: ${SCORE_COMPONENTS.FOLLOW.join(' + ')} (each weighs 1, max 4).`,
		`Components use only values knowable at the open; the session's own close/high/low and the outcome-derived class value are never read.`,
		`A session with no gap is NOT_APPLICABLE; a parent that refused yields UNAVAILABLE with ${GAP_SCORE_REFUSALS.join(' / ')} and a null score.`,
		`Nothing here ranks sessions against each other or tunes anything against historical outcomes.`,
	].join(' ');

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Canonical TOTAL order: session date, then the row's own identity content. */
const bySession = <T extends { sessionDate: string; instrument: string }>(rows: T[], key: (r: T) => string): T[] =>
	[...rows].sort((a, b) => {
		if (a.sessionDate !== b.sessionDate) return a.sessionDate < b.sessionDate ? -1 : 1;
		const ka = `${a.instrument}|${key(a)}`;
		const kb = `${b.instrument}|${key(b)}`;
		return ka < kb ? -1 : ka > kb ? 1 : 0;
	});

function scoreOne(side: GapScoreSide, a: SessionGapAssessment, rp: { status: string; gapRangePos: number | null; reason?: string | null }, cfg: { enabled: boolean }): SessionGapScores {
	const evidence = {
		gapRatio: isNum(a.gapRatio) ? a.gapRatio : null,
		gapRangePos: isNum(rp.gapRangePos) ? (rp.gapRangePos as number) : null,
		priorRange: isNum(a.measures?.priorRange) ? (a.measures.priorRange as number) : null,
		priorTrendUp: isNum(a.measures?.priorTrendUp) ? (a.measures.priorTrendUp as number) : null,
	};
	const base = {
		sessionDate: a.sessionDate, instrument: a.instrument, direction: a.direction,
		maxScore: SCORE_COMPONENTS[side].length, components: null as Record<string, boolean> | null, evidence,
	};

	if (!cfg.enabled) {
		return { ...base, status: 'DISABLED', reason: null, reasonDetail: 'this side is disabled; no score was computed for this input', score: null };
	}
	if (a.status !== 'OK') {
		return { ...base, status: 'UNAVAILABLE', reason: 'TAXONOMY_UNAVAILABLE', reasonDetail: a.reason ?? 'the taxonomy assessment is unavailable', score: null };
	}
	if (rp.status !== 'OK') {
		return { ...base, status: 'UNAVAILABLE', reason: 'RANGE_POS_UNAVAILABLE', reasonDetail: `GapRangePos is ${rp.status}${rp.reason ? ` (${rp.reason})` : ''}`, score: null };
	}
	if (!a.direction || a.class === 'NONE') {
		return { ...base, status: 'NOT_APPLICABLE', reason: 'NO_GAP', reasonDetail: 'the session has no material gap, so there is nothing to fade or follow', score: null };
	}
	const gapUp = a.direction === 'UP';
	const priorTrendUp = isNum(a.measures?.priorTrendUp) ? (a.measures.priorTrendUp as number) === 1 : null;
	const gapRatio = isNum(a.gapRatio) ? a.gapRatio : null;
	const pos = isNum(rp.gapRangePos) ? rp.gapRangePos : null;

	const components: Record<string, boolean> = side === 'FADE'
		? {
			f_materialGap: true, // reachable only when the taxonomy saw a material gap
			f_insideRange: pos !== null && pos >= 0 && pos <= 1,
			f_counterTrend: priorTrendUp !== null && priorTrendUp !== gapUp,
			f_withinSize: gapRatio !== null && gapRatio <= 1,
		}
		: {
			g_materialGap: true,
			g_outsideRange: pos !== null && (pos < 0 || pos > 1),
			g_withTrend: priorTrendUp !== null && priorTrendUp === gapUp,
			g_sizeBreak: gapRatio !== null && gapRatio > 1,
		};

	return { ...base, status: 'OK', reason: null, reasonDetail: null, score: Object.values(components).filter(Boolean).length, components };
}

function buildBlock(
	side: GapScoreSide,
	assessments: SessionGapAssessment[],
	rangePos: GapRangePosResult,
	cfg: { enabled: boolean },
): GapScoreBlock {
	const rpIndex = new Map<string, { status: string; gapRangePos: number | null; reason?: string | null }>();
	for (const o of rangePos.observations) rpIndex.set(`${o.sessionDate}|${o.instrument}`, { status: o.status, gapRangePos: o.gapRangePos, reason: o.reason });

	const ordered = bySession(assessments, (a) => `${a.gapRatio ?? ''}|${a.direction ?? ''}`);
	const observations = ordered.map((a) => scoreOne(side, a, rpIndex.get(`${a.sessionDate}|${a.instrument}`) ?? { status: 'UNAVAILABLE', gapRangePos: null, reason: 'NO_RANGE_POS_ROW' }, cfg));

	const maxScore = SCORE_COMPONENTS[side].length;
	const distribution = new Array(maxScore + 1).fill(0);
	for (const o of observations) if (o.status === 'OK' && o.score !== null) distribution[o.score] += 1;

	return {
		side,
		enabled: cfg.enabled,
		maxScore,
		spec: GAP_SCORES_SPEC,
		observations,
		distribution,
		coverage: {
			inputsIn: assessments.length,
			ok: observations.filter((o) => o.status === 'OK').length,
			notApplicable: observations.filter((o) => o.status === 'NOT_APPLICABLE').length,
			unavailable: observations.filter((o) => o.status === 'UNAVAILABLE').length,
			disabled: observations.filter((o) => o.status === 'DISABLED').length,
		},
	};
}

const digestOf = (o: SessionGapScores[]): string =>
	JSON.stringify(o.map((x) => [x.sessionDate, x.instrument, x.status, x.reason, x.score]));

/**
 * Evaluate both independent scores. Input order is irrelevant; each block is emitted in canonical
 * order and each block's digest is a function of the DATA alone.
 */
export function evaluateGapScores(
	assessments: SessionGapAssessment[],
	rangePos: GapRangePosResult,
	config: Partial<{ fade: Partial<{ enabled: boolean }>; follow: Partial<{ enabled: boolean }> }> = {},
): GapScoreReport {
	const cfg: GapScoresConfig = {
		fade: { ...DEFAULT_GAP_SCORES_CONFIG.fade, ...(config.fade ?? {}) },
		follow: { ...DEFAULT_GAP_SCORES_CONFIG.follow, ...(config.follow ?? {}) },
	};
	const fade = buildBlock('FADE', assessments, rangePos, cfg.fade);
	const follow = buildBlock('FOLLOW', assessments, rangePos, cfg.follow);
	return {
		version: GAP_SCORES_VERSION,
		config: cfg,
		fade,
		follow,
		reviewerSummary: describeGapScores(cfg),
		digest: JSON.stringify([digestOf(fade.observations), digestOf(follow.observations)]),
	};
}
