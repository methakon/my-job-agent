/**
 * GATE 4 #3 (roadmap row 40) — GAP-FADE and FAILED-ORB CANDIDATES.
 *
 * Single responsibility: decide whether a session offers each candidate setup, deterministically,
 * and say so explicitly when it cannot decide. Two INDEPENDENT candidates with their own switch,
 * their own input contract and their own refusal list — never one blended score.
 *
 * "Candidate" means: the setup was present, decided WITHOUT looking at how the session turned out.
 * The outcome is somebody else's job (gap-taxonomy fillState, gap-hypotheses), and this module
 * never reads a post-open value to decide a candidate — see GAP_FADE_REQUIRES and the no-look-ahead
 * test in scripts/gap-candidates.test.js, which mutates every post-open field and asserts the
 * verdict cannot move.
 *
 * PURE: no clock, no I/O, no randomness, no model/AI interpretation, and no threshold chosen from
 * historical outcomes. Every threshold is a documented structural default in DEFAULT_CANDIDATE_CONFIG
 * and lives in exactly one place. Historical rates are evidence about what happened, never a tuning
 * target: this module reports counts, it never selects, ranks or optimises.
 *
 * Reuse, not duplication:
 *   * GAP-FADE consumes the taxonomy's SessionGapAssessment rows (gap geometry + materiality are
 *     computed once, in gap-taxonomy.ts) — it never re-derives a gap.
 *   * the session clock (IST midnight, 09:15 open) comes from the pre-open session calendar.
 *
 * GATE 4 is RESEARCH/SHADOW ONLY: nothing in production imports this module, no decision, order or
 * risk path reads it, and no state is written. Versioned: gap-cand-v1.
 */

import { MARKET_OPEN_START_MIN, MARKET_CLOSE_MIN } from '../pre-open/pre-open-session';
import { sessionMidnightMs } from '../pre-open/pre-open-alignment';
import {
	GapDirection,
	SessionGapAssessment,
} from './gap-taxonomy';

export const GAP_CANDIDATES_VERSION = 'gap-cand-v1';

export type CandidateName = 'GAP_FADE' | 'FAILED_ORB';
export const CANDIDATE_NAMES: readonly CandidateName[] = ['GAP_FADE', 'FAILED_ORB'];

export type CandidateStatus = 'OK' | 'NOT_APPLICABLE' | 'UNAVAILABLE' | 'DISABLED';

/** Plain-language contract per candidate, so a reviewer can check the code against the words. */
export interface CandidateSpec {
	name: CandidateName;
	asserts: string;
	requires: string[];
	candidateWhen: string;
	refuses: string[];
}

/**
 * Every reason token this module can emit, per candidate. Published so a replay can be checked
 * against a closed vocabulary: a verdict that invents a new reason without documenting it here is a
 * defect, not a detail.
 */
export const CANDIDATE_REFUSAL_TOKENS: Record<CandidateName, readonly string[]> = {
	GAP_FADE: ['NOT_A_MATERIAL_GAP', 'GAP_TOO_LARGE_FOR_FADE', 'TAXONOMY_UNAVAILABLE', 'DISABLED'],
	FAILED_ORB: ['NO_SESSION_OPEN', 'LATE_START', 'RANGE_INCOMPLETE', 'NO_PATH_AFTER_RANGE', 'NO_BREAKOUT', 'BREAKOUT_HELD', 'DISABLED'],
};

export const CANDIDATE_SPECS: Record<CandidateName, CandidateSpec> = {
	GAP_FADE: {
		name: 'GAP_FADE',
		asserts: 'A material but bounded gap is a fade candidate: price is expected to trade back toward the gap origin (the previous close).',
		requires: [
			'a taxonomy assessment with status OK (material gap, both thresholds passed)',
			'the gap direction, the gap size in percent and relative to the prior session range',
			'the session open and the previous close (pre-open values only)',
		],
		candidateWhen: 'material gap AND |gap| <= maxGapRatio x prior-session range (default 1.0): a gap at least as large as the whole prior range is treated as a structural break, not an ordinary fade.',
		refuses: [
			'NOT_A_MATERIAL_GAP — the taxonomy saw no material gap, so there is nothing to fade',
			'GAP_TOO_LARGE_FOR_FADE — |gap| exceeded the configured ratio',
			'TAXONOMY_UNAVAILABLE — the assessment itself was unavailable; the taxonomy reason (e.g. NO_PRIOR_SESSION) is propagated verbatim behind this token, never guessed',
			'DISABLED — the gapFade switch is off',
		],
	},
	FAILED_ORB: {
		name: 'FAILED_ORB',
		asserts: 'A failed opening-range breakout is a candidate: price left the opening range and then traded back inside it.',
		requires: [
			'an intraday path for the session (instant + price)',
			'coverage from the session open: the first observation no later than maxStartLagMinutes after 09:15 IST',
			'at least 2 observations inside the opening-range window and at least 1 after it',
		],
		candidateWhen: 'a breakout of the opening range occurred AND price re-entered the range afterwards (the breakout failed).',
		refuses: [
			'NO_SESSION_OPEN — the session date is not a usable YYYY-MM-DD',
			'LATE_START — the path starts too long after the open, so the opening range would be a mislabelled proxy',
			'RANGE_INCOMPLETE — too few observations inside the opening-range window',
			'NO_PATH_AFTER_RANGE — no observations after the window, so a breakout cannot be judged',
			'NO_BREAKOUT — price never left the opening range after the window closed (not applicable)',
			'BREAKOUT_HELD — the breakout never traded back inside the range (evaluated, not a candidate)',
			'DISABLED — the failedOrb switch is off',
		],
	},
};

export interface CandidateConfig {
	gapFade: {
		enabled: boolean;
		/** Structural default: a gap >= the prior session's whole range is a break, not a fade. */
		maxGapRatio: number;
	};
	failedOrb: {
		enabled: boolean;
		/** Length of the opening range, in minutes from 09:15 IST. */
		rangeMinutes: number;
		/** How late the first observation may be and still be treated as covering the open. */
		maxStartLagMinutes: number;
	};
}

export const DEFAULT_CANDIDATE_CONFIG: CandidateConfig = {
	gapFade: { enabled: true, maxGapRatio: 1.0 },
	failedOrb: { enabled: true, rangeMinutes: 15, maxStartLagMinutes: 5 },
};

export const describeCandidateConfig = (c: CandidateConfig = DEFAULT_CANDIDATE_CONFIG): string =>
	`${GAP_CANDIDATES_VERSION}: GAP_FADE enabled=${c.gapFade.enabled} (maxGapRatio=${c.gapFade.maxGapRatio}); ` +
	`FAILED_ORB enabled=${c.failedOrb.enabled} (rangeMinutes=${c.failedOrb.rangeMinutes}, maxStartLagMinutes=${c.failedOrb.maxStartLagMinutes}). ` +
	'Thresholds are structural defaults, never tuned against historical outcomes; candidates are decided without looking at how the session turned out.';

// ── shared shapes ────────────────────────────────────────────────────────────

/** One archived intraday observation. `instantMs` must be an absolute instant (IST wall → instant). */
export interface PathPoint {
	instantMs: number;
	price: number;
}

export interface IntradaySessionPath {
	sessionDate: string;
	instrument: string;
	points: PathPoint[];
}

type Verdict = { status: CandidateStatus; isCandidate: boolean | null; reason: string | null };

export interface GapFadeCandidate extends Verdict {
	kind: 'GAP_FADE';
	sessionDate: string;
	instrument: string;
	/** The fade trades AGAINST the gap. */
	direction: GapDirection | null;
	/** The gap origin: where a fade would complete (the previous close). */
	targetLevel: number | null;
	/** The near edge of the gap (the session open): beyond it, the fade thesis is void. */
	invalidationLevel: number | null;
	evidence: Record<string, number | null>;
}

export interface FailedOrbCandidate extends Verdict {
	kind: 'FAILED_ORB';
	sessionDate: string;
	instrument: string;
	direction: GapDirection | null;
	openingRange: { low: number; high: number; fromMs: number; toMs: number; observations: number } | null;
	breakout: { atMs: number; price: number } | null;
	reEntry: { atMs: number; price: number } | null;
	excursion: number | null;
	evidence: Record<string, number | null>;
}

export interface CandidateBlock<T> {
	spec: CandidateSpec;
	config: CandidateConfig[CandidateName extends 'GAP_FADE' ? 'gapFade' : never] | CandidateConfig[keyof CandidateConfig];
	results: T[];
	coverage: {
		inputsIn: number;
		evaluated: number;
		candidates: number;
		notApplicable: number;
		unavailable: number;
		disabled: number;
		/** Vocabulary/sorted order so the digest cannot depend on input order. */
		reasons: Record<string, number>;
	};
}

export interface GapCandidateReport {
	version: string;
	config: CandidateConfig;
	gapFade: CandidateBlock<GapFadeCandidate>;
	failedOrb: CandidateBlock<FailedOrbCandidate>;
	combination: { gapFadeOnly: number; failedOrbOnly: number; both: number; neither: number; sessionsInBothInputs: number };
	reviewerSummary: string;
	digest: string;
}

// ── helpers ──────────────────────────────────────────────────────────────────

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

const canonicalCounts = (counts: Record<string, number>, vocabulary?: readonly string[]): Record<string, number> => {
	const keys = vocabulary ? vocabulary.filter((k) => counts[k] !== undefined) : Object.keys(counts).sort();
	const out: Record<string, number> = {};
	for (const k of keys) out[k] = counts[k];
	return out;
};

/**
 * Canonical order: by session date, then by a caller-supplied identity key. The tie-break matters —
 * two inputs can carry the SAME session date (e.g. two instruments' paths), and ordering them by
 * date alone leaves them in whatever order the caller supplied, which would make the report digest
 * depend on input order.
 */
const bySession = <T extends { sessionDate: string }>(rows: T[], tieBreak: (r: T) => string = () => ''): T[] =>
	[...rows].sort((a, b) => {
		if (a.sessionDate !== b.sessionDate) return a.sessionDate < b.sessionDate ? -1 : 1;
		const ka = tieBreak(a);
		const kb = tieBreak(b);
		return ka < kb ? -1 : ka > kb ? 1 : 0;
	});

// ── GAP-FADE ─────────────────────────────────────────────────────────────────

/**
 * Fields this candidate is allowed to read. It is the pre-open set only: adding a post-open field
 * here would introduce look-ahead, and the no-look-ahead test fails if that happens.
 */
export const GAP_FADE_REQUIRES = ['status', 'class', 'direction', 'gapPct', 'gapRatio', 'measures.open', 'measures.prevClose', 'measures.priorRange'] as const;

const gapFadeVerdict = (a: SessionGapAssessment, cfg: CandidateConfig['gapFade']): GapFadeCandidate => {
	const base = { kind: 'GAP_FADE' as const, sessionDate: a.sessionDate, instrument: a.instrument };
	const evidence = {
		gapPct: isNum(a.gapPct) ? a.gapPct : null,
		gapRatio: isNum(a.gapRatio) ? a.gapRatio : null,
		priorRange: isNum(a.measures?.priorRange) ? (a.measures.priorRange as number) : null,
		maxGapRatio: cfg.maxGapRatio,
		open: isNum(a.measures?.open) ? (a.measures.open as number) : null,
		prevClose: isNum(a.measures?.prevClose) ? (a.measures.prevClose as number) : null,
	};

	if (a.status !== 'OK') {
		return { ...base, status: 'UNAVAILABLE', isCandidate: null, reason: `TAXONOMY_UNAVAILABLE — ${a.reason ?? 'assessment unavailable'}`, direction: null, targetLevel: null, invalidationLevel: null, evidence };
	}
	if (a.class === 'NONE' || !a.direction) {
		return { ...base, status: 'NOT_APPLICABLE', isCandidate: false, reason: 'NOT_A_MATERIAL_GAP — the taxonomy saw no material gap, so there is nothing to fade', direction: null, targetLevel: null, invalidationLevel: null, evidence };
	}
	if (!isNum(a.gapRatio)) {
		return { ...base, status: 'UNAVAILABLE', isCandidate: null, reason: 'gapRatio is not available, so the fade bound cannot be judged', direction: null, targetLevel: null, invalidationLevel: null, evidence };
	}
	if (a.gapRatio > cfg.maxGapRatio) {
		return { ...base, status: 'NOT_APPLICABLE', isCandidate: false, reason: `GAP_TOO_LARGE_FOR_FADE — |gap|/priorRange = ${a.gapRatio.toFixed(3)} exceeded ${cfg.maxGapRatio}`, direction: null, targetLevel: null, invalidationLevel: null, evidence };
	}

	// A fade trades against the gap: up-gap fades down toward prevClose; down-gap fades up.
	const direction: GapDirection = a.direction === 'UP' ? 'DOWN' : 'UP';
	const prevClose = isNum(a.measures?.prevClose) ? (a.measures.prevClose as number) : null;
	const open = isNum(a.measures?.open) ? (a.measures.open as number) : null;
	return { ...base, status: 'OK', isCandidate: true, reason: null, direction, targetLevel: prevClose, invalidationLevel: open, evidence };
};

export function buildGapFadeCandidates(assessments: SessionGapAssessment[], config: CandidateConfig = DEFAULT_CANDIDATE_CONFIG): CandidateBlock<GapFadeCandidate> {
	const cfg = config.gapFade;
	if (!cfg.enabled) {
		return {
			spec: CANDIDATE_SPECS.GAP_FADE, config: cfg, results: [],
			coverage: { inputsIn: assessments.length, evaluated: 0, candidates: 0, notApplicable: 0, unavailable: 0, disabled: assessments.length, reasons: {} },
		};
	}
	const ordered = bySession(assessments, (a) => `${a.instrument}|${a.measures?.open ?? ''}|${a.measures?.prevClose ?? ''}|${a.gapAbs ?? ''}|${a.gapPct ?? ''}|${a.gapRatio ?? ''}`);
	const results = ordered.map((a) => gapFadeVerdict(a, cfg));
	const reasons: Record<string, number> = {};
	for (const r of results) {
		if (r.status === 'OK' || !r.reason) continue;
		const key = r.reason.split(' ')[0];
		reasons[key] = (reasons[key] ?? 0) + 1;
	}
	return {
		spec: CANDIDATE_SPECS.GAP_FADE, config: cfg, results,
		coverage: {
			inputsIn: assessments.length,
			evaluated: results.filter((r) => r.status === 'OK').length,
			candidates: results.filter((r) => r.isCandidate === true).length,
			notApplicable: results.filter((r) => r.status === 'NOT_APPLICABLE').length,
			unavailable: results.filter((r) => r.status === 'UNAVAILABLE').length,
			disabled: 0,
			reasons: canonicalCounts(reasons),
		},
	};
}

// ── FAILED-ORB ───────────────────────────────────────────────────────────────

export type OrbOutcome = 'CANDIDATE' | 'BREAKOUT_HELD' | 'NO_BREAKOUT';

const failedOrbVerdict = (path: IntradaySessionPath, cfg: CandidateConfig['failedOrb']): FailedOrbCandidate => {
	const base = { kind: 'FAILED_ORB' as const, sessionDate: path.sessionDate, instrument: path.instrument, direction: null as GapDirection | null, openingRange: null, breakout: null, reEntry: null, excursion: null };
	const empty = { rangeLow: null, rangeHigh: null, points: path.points?.length ?? 0, rangePoints: null, postRangePoints: null, startLagMs: null, rangeMinutes: cfg.rangeMinutes, maxStartLagMinutes: cfg.maxStartLagMinutes } as Record<string, number | null>;

	const midnight = sessionMidnightMs(path.sessionDate);
	if (midnight === null) return { ...base, status: 'UNAVAILABLE', isCandidate: null, reason: `NO_SESSION_OPEN — "${path.sessionDate}" is not a usable session date`, evidence: empty };

	const openMs = midnight + MARKET_OPEN_START_MIN * 60_000;
	const closeMs = midnight + MARKET_CLOSE_MIN * 60_000;
	const rangeEndMs = openMs + cfg.rangeMinutes * 60_000;

	const points = (path.points ?? []).filter((p) => isNum(p.instantMs) && isNum(p.price) && p.price > 0 && p.instantMs >= openMs && p.instantMs <= closeMs).sort((a, b) => a.instantMs - b.instantMs);
	if (!points.length) return { ...base, status: 'UNAVAILABLE', isCandidate: null, reason: 'RANGE_INCOMPLETE — the path holds no observation inside the session window', evidence: empty };

	const startLagMs = points[0].instantMs - openMs;
	if (startLagMs > cfg.maxStartLagMinutes * 60_000) {
		return {
			...base, status: 'UNAVAILABLE', isCandidate: null,
			reason: `LATE_START — first observation is ${(startLagMs / 60_000).toFixed(1)} min after the 09:15 open, later than the ${cfg.maxStartLagMinutes} min bound, so the opening range would be a mislabelled proxy`,
			evidence: { ...empty, startLagMs, points: points.length },
		};
	}

	const inRange = points.filter((p) => p.instantMs < rangeEndMs);
	const afterRange = points.filter((p) => p.instantMs >= rangeEndMs);
	const evidence = { ...empty, startLagMs, points: points.length, rangePoints: inRange.length, postRangePoints: afterRange.length } as Record<string, number | null>;
	if (inRange.length < 2) return { ...base, status: 'UNAVAILABLE', isCandidate: null, reason: `RANGE_INCOMPLETE — ${inRange.length} observation(s) inside the ${cfg.rangeMinutes}-minute opening range (need at least 2)`, evidence };
	if (!afterRange.length) return { ...base, status: 'UNAVAILABLE', isCandidate: null, reason: 'NO_PATH_AFTER_RANGE — no observation after the opening range, so a breakout cannot be judged', evidence };

	const prices = inRange.map((p) => p.price);
	const low = Math.min(...prices);
	const high = Math.max(...prices);
	const openingRange = { low, high, fromMs: points[0].instantMs, toMs: rangeEndMs, observations: inRange.length };
	const rangeEvidence = { ...evidence, rangeLow: low, rangeHigh: high };

	// first breakout after the range window closes
	let breakout: { atMs: number; price: number } | null = null;
	let direction: GapDirection | null = null;
	for (const p of afterRange) {
		if (p.price > high) { breakout = { atMs: p.instantMs, price: p.price }; direction = 'UP'; break; }
		if (p.price < low) { breakout = { atMs: p.instantMs, price: p.price }; direction = 'DOWN'; break; }
	}
	if (!breakout || !direction) {
		return { ...base, status: 'NOT_APPLICABLE', isCandidate: false, reason: 'NO_BREAKOUT — price never left the opening range after the window closed', openingRange, evidence: rangeEvidence };
	}

	const afterBreakout = afterRange.filter((p) => p.instantMs > breakout!.atMs);
	const excursion = direction === 'UP'
		? Math.max(breakout.price, ...afterBreakout.map((p) => p.price)) - high
		: low - Math.min(breakout.price, ...afterBreakout.map((p) => p.price));
	const reEntryPoint = afterBreakout.find((p) => (direction === 'UP' ? p.price <= high : p.price >= low)) ?? null;
	const withBreakout = { ...rangeEvidence, breakoutPrice: breakout.price, excursion };
	if (!reEntryPoint) {
		return { ...base, status: 'OK', isCandidate: false, reason: 'BREAKOUT_HELD — the breakout never traded back inside the opening range', direction, openingRange, breakout, reEntry: null, excursion, evidence: withBreakout };
	}

	return {
		...base, status: 'OK', isCandidate: true, reason: null, direction: direction as GapDirection, openingRange, breakout,
		reEntry: { atMs: reEntryPoint.instantMs, price: reEntryPoint.price }, excursion,
		evidence: { ...withBreakout, reEntryPrice: reEntryPoint.price },
	};
};

export function buildFailedOrbCandidates(paths: IntradaySessionPath[], config: CandidateConfig = DEFAULT_CANDIDATE_CONFIG): CandidateBlock<FailedOrbCandidate> {
	const cfg = config.failedOrb;
	if (!cfg.enabled) {
		return {
			spec: CANDIDATE_SPECS.FAILED_ORB, config: cfg, results: [],
			coverage: { inputsIn: paths.length, evaluated: 0, candidates: 0, notApplicable: 0, unavailable: 0, disabled: paths.length, reasons: {} },
		};
	}
	const ordered = bySession(paths, (p) => `${p.instrument}|${(p.points ?? []).map((q) => `${q.instantMs}:${q.price}`).join(',')}`);
	const results = ordered.map((p) => failedOrbVerdict(p, cfg));
	const reasons: Record<string, number> = {};
	for (const r of results) {
		if (r.status === 'OK' || !r.reason) continue;
		const key = r.reason.split(' ')[0];
		reasons[key] = (reasons[key] ?? 0) + 1;
	}
	return {
		spec: CANDIDATE_SPECS.FAILED_ORB, config: cfg, results,
		coverage: {
			inputsIn: paths.length,
			evaluated: results.filter((r) => r.status === 'OK').length,
			candidates: results.filter((r) => r.isCandidate === true).length,
			notApplicable: results.filter((r) => r.status === 'NOT_APPLICABLE').length,
			unavailable: results.filter((r) => r.status === 'UNAVAILABLE').length,
			disabled: 0,
			reasons: canonicalCounts(reasons),
		},
	};
}

// ── combined report ──────────────────────────────────────────────────────────

export function buildGapCandidates(
	input: { assessments?: SessionGapAssessment[]; paths?: IntradaySessionPath[]; config?: Partial<CandidateConfig> },
): GapCandidateReport {
	const config: CandidateConfig = {
		gapFade: { ...DEFAULT_CANDIDATE_CONFIG.gapFade, ...(input.config?.gapFade ?? {}) },
		failedOrb: { ...DEFAULT_CANDIDATE_CONFIG.failedOrb, ...(input.config?.failedOrb ?? {}) },
	};
	const gapFade = buildGapFadeCandidates(input.assessments ?? [], config);
	const failedOrb = buildFailedOrbCandidates(input.paths ?? [], config);

	const fadeSessions = new Set(gapFade.results.filter((r) => r.isCandidate === true).map((r) => r.sessionDate));
	const orbSessions = new Set(failedOrb.results.filter((r) => r.isCandidate === true).map((r) => r.sessionDate));
	const inBothInputs = new Set([...gapFade.results.map((r) => r.sessionDate), ...failedOrb.results.map((r) => r.sessionDate)]);
	const both = [...fadeSessions].filter((d) => orbSessions.has(d)).length;

	const reviewerSummary = `${GAP_CANDIDATES_VERSION}: two independent gate-4 candidates. GAP_FADE (switchable) flags a material gap whose size is at most ${config.gapFade.maxGapRatio}x the prior session range — decided from pre-open values only, with the gap origin as the fade target and the session open as the invalidation; for GAP_FADE the evaluated set IS the candidate set by construction, because the ratio bound is its only filter. FAILED_ORB (switchable) flags a session where price left the ${config.failedOrb.rangeMinutes}-minute opening range and then traded back inside it, refusing any path that does not cover the 09:15 open (${config.failedOrb.maxStartLagMinutes} min bound) rather than substituting a late-start proxy. Candidates are decided without the session outcome; thresholds are structural defaults and were never tuned against results.`;

	const digest = JSON.stringify({
		v: GAP_CANDIDATES_VERSION,
		cfg: config,
		gapFade: { cov: gapFade.coverage, rows: gapFade.results.map((r) => [r.sessionDate, r.status, r.isCandidate, r.direction]) },
		failedOrb: { cov: failedOrb.coverage, rows: failedOrb.results.map((r) => [r.sessionDate, r.status, r.isCandidate, r.direction]) },
	});

	return {
		version: GAP_CANDIDATES_VERSION, config, gapFade, failedOrb,
		combination: { gapFadeOnly: fadeSessions.size - both, failedOrbOnly: orbSessions.size - both, both, neither: inBothInputs.size - (fadeSessions.size + orbSessions.size - both), sessionsInBothInputs: inBothInputs.size },
		reviewerSummary, digest,
	};
}
