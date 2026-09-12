/**
 * GATE 4 #2 (roadmap row 39) — TWO SEPARATE GAP HYPOTHESES: GAP-FILL and GAP-AND-GO.
 *
 * Single responsibility: state each hypothesis as an explicit, falsifiable proposition, evaluate
 * it against an ALREADY-CLASSIFIED session, and report the observed outcome. Pure: no clock, no
 * I/O, no randomness, no AI, no threshold tuning.
 *
 * REUSE, NOT DUPLICATION: this module never recomputes gap geometry. It consumes the taxonomy's
 * `SessionGapAssessment` rows (direction, zone, fillState, measures) and the session series is
 * read by the caller through the existing adapter. Anything the taxonomy could not determine
 * propagates as UNAVAILABLE with the taxonomy's own reason — the hypotheses never invent a value.
 *
 * WHAT EACH HYPOTHESIS ASSERTS (documented, and asserted by the test):
 *
 *   GAP_FILL   — "a MATERIAL gap is filled during the session it opened."
 *                realized  ⇔ the session's range reaches the gap ORIGIN (up: low <= prevClose,
 *                down: high >= prevClose) — i.e. the taxonomy's fillState is FILLED.
 *                requires  : a material gap with a known direction and a known fill state.
 *
 *   GAP_AND_GO — "a MATERIAL gap holds and the session continues in the gap's direction."
 *                realized  ⇔ the gap is NOT filled AND the session closes beyond its open in the
 *                gap direction (up: close > open, down: close < open).
 *                requires  : the same inputs PLUS the session open/close.
 *
 * The two are INDEPENDENT: separate switches, separate observation lists, separate coverage. They
 * are not complements — a session can realize neither, either, or (only with an exactly-flat
 * close, impossible to satisfy both ways) one of them; the report says so rather than forcing a
 * partition. Immaterial gaps are NOT_APPLICABLE, because a hypothesis about a material gap says
 * nothing about a non-gap session.
 *
 * HISTORICAL RESULTS ARE DESCRIPTIVE EVIDENCE ONLY. The report includes the observed counts and a
 * fixed-geometry excursion measure (entry = session open, risk = the gap, reward = the session's
 * extension) purely so a reviewer can see what happened. NO threshold in this module is chosen or
 * adjusted against those results, and the test asserts the shipped defaults match the documented
 * constants.
 */

import { GapDirection, SessionGapAssessment } from './gap-taxonomy';

export const GAP_HYPOTHESES_VERSION = 'gaphyp-v1';

export type HypothesisName = 'GAP_FILL' | 'GAP_AND_GO';
export const HYPOTHESIS_NAMES: readonly HypothesisName[] = ['GAP_FILL', 'GAP_AND_GO'];

export type HypothesisStatus = 'OK' | 'UNAVAILABLE' | 'NOT_APPLICABLE' | 'DISABLED';
export type HypothesisOutcome = 'REALIZED' | 'NOT_REALIZED';

export type HypothesisSpec = {
	hypothesis: HypothesisName;
	/** The falsifiable statement. */
	asserts: string;
	/** Inputs that must be present before an outcome may be stated. */
	requires: string[];
	/** The deterministic condition under which the statement is REALIZED. */
	realizedWhen: string;
	/** The documented refusal reasons this hypothesis can return. */
	refusals: string[];
	/** Fixed geometry used for the descriptive excursion measure (never tuned). */
	descriptiveMeasure?: string;
};

export const HYPOTHESIS_SPECS: Record<HypothesisName, HypothesisSpec> = {
	GAP_FILL: {
		hypothesis: 'GAP_FILL',
		asserts: 'A material gap is filled during the session it opened.',
		requires: ['a material gap (taxonomy class != NONE)', 'a known gap direction', 'a known fill state'],
		realizedWhen: 'the session range reaches the gap origin: up ⇒ low <= prevClose, down ⇒ high >= prevClose',
		refusals: ['UNAVAILABLE: the taxonomy could not assess this session (its reason is propagated)',
			'UNAVAILABLE: direction or fill state is unknown',
			'NOT_APPLICABLE: the session had no material gap'],
	},
	GAP_AND_GO: {
		hypothesis: 'GAP_AND_GO',
		asserts: 'A material gap holds (is not filled) and the session continues in the gap direction.',
		requires: ['everything GAP_FILL requires', 'the session open', 'the session close'],
		realizedWhen: 'the gap is UNFILLED and the session closes beyond its open in the gap direction (up ⇒ close > open, down ⇒ close < open)',
		refusals: ['UNAVAILABLE: the taxonomy could not assess this session (its reason is propagated)',
			'UNAVAILABLE: direction, fill state, open or close is unknown',
			'NOT_APPLICABLE: the session had no material gap'],
		descriptiveMeasure: 'entry = session open, risk = |open − prevClose| (the gap), reward = |session extreme − open|; reported descriptively, never used to select anything',
	},
};

export type HypothesisConfig = {
	/** Independent switch per hypothesis. */
	enabled: boolean;
};

export type HypothesisObservation = {
	hypothesis: HypothesisName;
	sessionDate: string;
	instrument: string;
	status: HypothesisStatus;
	reason: string | null;
	outcome: HypothesisOutcome | null;
	/** Descriptive, fixed-geometry evidence. Never a selection criterion. */
	evidence: Record<string, number | null>;
};

export type HypothesisBlock = {
	spec: HypothesisSpec;
	enabled: boolean;
	observations: HypothesisObservation[];
	coverage: {
		sessionsConsidered: number;
		evaluable: number;
		realized: number;
		notRealized: number;
		unavailable: number;
		notApplicable: number;
		realizedRate: number | null;
	};
};

export type HypothesisReport = {
	version: string;
	gapFill: HypothesisBlock;
	gapAndGo: HypothesisBlock;
	/** How the two independent blocks overlap — reported, never assumed. */
	combination: {
		bothRealized: number;
		onlyGapFill: number;
		onlyGapAndGo: number;
		neither: number;
	};
	reviewerSummary: string;
	digest: string;
};

export const DEFAULT_HYPOTHESIS_CONFIG: Record<HypothesisName, HypothesisConfig> = {
	GAP_FILL: { enabled: true },
	GAP_AND_GO: { enabled: true },
};

export const describeGapHypotheses = (): string =>
	[
		`${GAP_HYPOTHESES_VERSION}: two independent hypotheses over the taxonomy's assessed sessions.`,
		`GAP_FILL asserts ${HYPOTHESIS_SPECS.GAP_FILL.asserts} Realized when ${HYPOTHESIS_SPECS.GAP_FILL.realizedWhen}.`,
		`GAP_AND_GO asserts ${HYPOTHESIS_SPECS.GAP_AND_GO.asserts} Realized when ${HYPOTHESIS_SPECS.GAP_AND_GO.realizedWhen}.`,
		'Each has its own switch; immaterial gaps are NOT_APPLICABLE; a session the taxonomy could not',
		'assess is UNAVAILABLE with the taxonomy reason propagated; outcomes are observations, not',
		'optimization targets, and no threshold here is tuned against the historical result.',
	].join(' ');

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Evaluate ONE hypothesis over the assessments. Never mutates its input. */
function evaluateOne(
	name: HypothesisName,
	assessments: SessionGapAssessment[],
	enabled: boolean,
): HypothesisBlock {
	const spec = HYPOTHESIS_SPECS[name];
	const observations: HypothesisObservation[] = [];

	if (!enabled) {
		for (const a of assessments) {
			observations.push({
				hypothesis: name, sessionDate: a.sessionDate, instrument: a.instrument,
				status: 'DISABLED', reason: `${name} is switched off in this configuration`, outcome: null, evidence: {},
			});
		}
		observations.sort((a, b) => (a.sessionDate < b.sessionDate ? -1 : a.sessionDate > b.sessionDate ? 1 : 0));
		return {
			spec, enabled: false, observations,
			coverage: { sessionsConsidered: assessments.length, evaluable: 0, realized: 0, notRealized: 0, unavailable: 0, notApplicable: 0, realizedRate: null },
		};
	}

	for (const a of assessments) {
		const base = { hypothesis: name, sessionDate: a.sessionDate, instrument: a.instrument };
		// 1) propagate the taxonomy's refusal verbatim — never a fabricated outcome
		if (a.status !== 'OK' || a.class === null) {
			observations.push({ ...base, status: 'UNAVAILABLE', reason: a.reason ?? 'the taxonomy produced no assessment', outcome: null, evidence: {} });
			continue;
		}
		// 2) a hypothesis about a material gap says nothing about a non-gap session
		if (a.class === 'NONE') {
			observations.push({ ...base, status: 'NOT_APPLICABLE', reason: 'the session had no material gap (taxonomy class NONE)', outcome: null, evidence: {} });
			continue;
		}
		const direction: GapDirection | null = a.direction;
		if (!direction || a.fillState === 'UNKNOWN') {
			observations.push({ ...base, status: 'UNAVAILABLE', reason: 'direction or fill state is unknown for this session', outcome: null, evidence: {} });
			continue;
		}
		const m = a.measures ?? {};
		const open = isNum(m.open) ? m.open : null;
		const close = isNum(m.close) ? m.close : null;
		const prevClose = isNum(m.prevClose) ? m.prevClose : null;
		const extreme = direction === 'UP' ? (isNum(m.high) ? m.high : null) : (isNum(m.low) ? m.low : null);
		const gapPts = open !== null && prevClose !== null ? Math.abs(open - prevClose) : null;
		const extensionPts = open !== null && close !== null ? Math.abs(close - open) : null;
		const excursionPts = open !== null && extreme !== null ? Math.abs(extreme - open) : null;

		if (name === 'GAP_FILL') {
			const realized = a.fillState === 'FILLED';
			observations.push({
				...base, status: 'OK', reason: null, outcome: realized ? 'REALIZED' : 'NOT_REALIZED',
				evidence: {
					direction: null, gapPct: a.gapPct, gapPts, gapRatio: a.gapRatio, zoneLow: a.zone ? a.zone.low : null, zoneHigh: a.zone ? a.zone.high : null,
					sessionRangePts: isNum(m.high) && isNum(m.low) ? m.high - m.low : null,
					sessionExtensionPts: extensionPts,
				},
			});
			continue;
		}

		// GAP_AND_GO: unfilled AND continued in the gap direction. Needs open and close.
		if (open === null || close === null) {
			observations.push({ ...base, status: 'UNAVAILABLE', reason: 'GAP_AND_GO requires the session open and close, which are missing', outcome: null, evidence: {} });
			continue;
		}
		const continued = direction === 'UP' ? close > open : close < open;
		const realized = a.fillState === 'UNFILLED' && continued;
		const rMultiple = gapPts !== null && gapPts > 0 && excursionPts !== null ? excursionPts / gapPts : null;
		observations.push({
			...base, status: 'OK', reason: null, outcome: realized ? 'REALIZED' : 'NOT_REALIZED',
			evidence: {
				gapPct: a.gapPct, gapPts, gapRatio: a.gapRatio,
				sessionExtensionPts: extensionPts, excursionPts, descriptiveRMultiple: rMultiple,
				continueDirectionPts: direction === 'UP' ? (close !== null && open !== null ? close - open : null) : (close !== null && open !== null ? open - close : null),
			},
		});
	}

	const evaluable = observations.filter((o) => o.status === 'OK');
	const realized = evaluable.filter((o) => o.outcome === 'REALIZED').length;
	// Canonical output order (by session date) so neither the observations nor the digest can
	// depend on the order the caller happened to supply assessments in.
	observations.sort((a, b) => (a.sessionDate < b.sessionDate ? -1 : a.sessionDate > b.sessionDate ? 1 : 0));
	return {
		spec, enabled: true, observations,
		coverage: {
			sessionsConsidered: assessments.length,
			evaluable: evaluable.length,
			realized,
			notRealized: evaluable.length - realized,
			unavailable: observations.filter((o) => o.status === 'UNAVAILABLE').length,
			notApplicable: observations.filter((o) => o.status === 'NOT_APPLICABLE').length,
			realizedRate: evaluable.length ? realized / evaluable.length : null,
		},
	};
}

export function evaluateGapHypotheses(
	assessments: SessionGapAssessment[],
	config: Partial<Record<HypothesisName, HypothesisConfig>> = {},
): HypothesisReport {
	const gapFillCfg = { ...DEFAULT_HYPOTHESIS_CONFIG.GAP_FILL, ...(config.GAP_FILL ?? {}) };
	const gapAndGoCfg = { ...DEFAULT_HYPOTHESIS_CONFIG.GAP_AND_GO, ...(config.GAP_AND_GO ?? {}) };

	const gapFill = evaluateOne('GAP_FILL', assessments, gapFillCfg.enabled);
	const gapAndGo = evaluateOne('GAP_AND_GO', assessments, gapAndGoCfg.enabled);

	const byDate = (block: HypothesisBlock): Map<string, HypothesisOutcome> => {
		const map = new Map<string, HypothesisOutcome>();
		for (const o of block.observations) if (o.status === 'OK' && o.outcome) map.set(o.sessionDate, o.outcome);
		return map;
	};
	const fillMap = byDate(gapFill);
	const goMap = byDate(gapAndGo);
	let both = 0; let onlyFill = 0; let onlyGo = 0; let neither = 0;
	for (const [date, fillOutcome] of fillMap) {
		const goOutcome = goMap.get(date);
		if (goOutcome === undefined) continue; // the other hypothesis could not evaluate this session
		if (fillOutcome === 'REALIZED' && goOutcome === 'REALIZED') both += 1;
		else if (fillOutcome === 'REALIZED') onlyFill += 1;
		else if (goOutcome === 'REALIZED') onlyGo += 1;
		else neither += 1;
	}

	const digest = JSON.stringify({
		v: GAP_HYPOTHESES_VERSION,
		gapFill: gapFill.observations.map((o) => [o.sessionDate, o.status, o.outcome]),
		gapAndGo: gapAndGo.observations.map((o) => [o.sessionDate, o.status, o.outcome]),
	});

	return {
		version: GAP_HYPOTHESES_VERSION,
		gapFill,
		gapAndGo,
		combination: { bothRealized: both, onlyGapFill: onlyFill, onlyGapAndGo: onlyGo, neither },
		reviewerSummary: describeGapHypotheses(),
		digest,
	};
}
