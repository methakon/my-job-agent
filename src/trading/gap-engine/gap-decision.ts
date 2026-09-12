/**
 * GATE 4 #11 (roadmap row 48) — RETURN FADE, FOLLOW OR NO TRADE.
 *
 * Single responsibility: combine the gate-4 evidence already produced into ONE decision per session —
 * fade the gap, follow the gap, or do nothing — and say exactly why when the answer is NO_TRADE. PURE: no
 * clock, no I/O, no DB, no network, no AI, no randomness. Every input is an argument.
 *
 * ── PINNED DEFINITION (inputs, transformation, output, timestamp boundary, failure) ────────
 *   INPUTS (all from earlier gate-4 rows, consumed as REPORTS so their versions travel):
 *     * FadeScore / FollowScore (row 44, `gapscore-v1`) for the session;
 *     * the early acceptance/rejection state (row 43, `gapacc-v1`);
 *     * OPTIONALLY the net expected value of a reviewed plan (row 47, `gapev-v1`).
 *   TRANSFORMATION (documented precedence, first match wins — no score is blended, no weight fitted):
 *     1. scores missing or not OK            → NO_TRADE  SCORES_UNAVAILABLE (a NO_GAP score is reported as NO_GAP)
 *     2. FadeScore === FollowScore           → NO_TRADE  SCORE_TIE
 *     3. winner = the strictly greater score → FADE or FOLLOW
 *     4. confirmation must AGREE with the state:
 *          FOLLOW requires ACCEPTED, FADE requires REJECTED
 *        a missing/unusable state       → NO_TRADE  NO_CONFIRMATION
 *        a state that contradicts       → NO_TRADE  CONFIRMATION_CONFLICT
 *     5. EV gate: when an EV row is supplied it is a HARD gate — not OK → NO_TRADE EV_UNAVAILABLE;
 *        netEvPoints <= 0 → NO_TRADE NON_POSITIVE_EV. `requireEv` (default false) makes an ABSENT EV row a
 *        refusal too (EV_REQUIRED); left false, an absent EV row is recorded as `evGate = NOT_SUPPLIED`
 *        and the decision stands, because the EV calculator legitimately has no probability input before a
 *        calibrated model exists (GATE 12) and inventing one is forbidden.
 *     6. otherwise                           → FADE or FOLLOW
 *   OUTPUT: one of exactly FADE / FOLLOW / NO_TRADE, with the winner, its score, the gap direction and the
 *   TRADE direction the decision implies (a fade trades against the gap; a follow trades with it).
 *   TIMESTAMP BOUNDARY: every input is knowable at the open — the scores read pre-open geometry only, the
 *   acceptance state is an early-window judgement, and the EV row is a caller-timestamped plan. This module
 *   reads no session clock and never looks at the session outcome.
 *   FAILURE BEHAVIOUR: any required input that is missing, refused or unusable yields NO_TRADE with a
 *   closed-vocabulary token and a human detail; NO decision is fabricated from partial evidence. If the
 *   component is disabled every session returns NO_TRADE/DISABLED and nothing is counted as decided.
 *
 * RESEARCH / SHADOW ONLY: nothing in production imports this module (asserted by test); it writes no state
 * and no decision, order or risk path reads it. Versioned: gapdec-v1.
 */

import { GapDirection } from './gap-taxonomy';
import { GapScoreReport, SessionGapScores } from './gap-scores';
import { GapAcceptanceReport, SessionGapAcceptance } from './gap-acceptance';
import { GapExpectedValueReport, PlanExpectedValue } from './gap-expected-value';

export const GAP_DECISION_VERSION = 'gapdec-v1';

export type GapDecisionSide = 'FADE' | 'FOLLOW';
export const GAP_DECISION_SIDES: readonly GapDecisionSide[] = ['FADE', 'FOLLOW'];

export type GapDecisionOutcome = 'FADE' | 'FOLLOW' | 'NO_TRADE';
export const GAP_DECISION_OUTCOMES: readonly GapDecisionOutcome[] = ['FADE', 'FOLLOW', 'NO_TRADE'];

export type GapDecisionStatus = 'OK' | 'NO_TRADE' | 'DISABLED';
export const GAP_DECISION_STATUSES: readonly GapDecisionStatus[] = ['OK', 'NO_TRADE', 'DISABLED'];

/** Closed, published refusal vocabulary (declaration order is the canonical order). */
export const GAP_DECISION_REFUSALS = [
	'SCORES_UNAVAILABLE',
	'NO_GAP',
	'SCORE_TIE',
	'NO_CONFIRMATION',
	'CONFIRMATION_CONFLICT',
	'EV_REQUIRED',
	'EV_UNAVAILABLE',
	'NON_POSITIVE_EV',
] as const;
export type GapDecisionRefusal = (typeof GAP_DECISION_REFUSALS)[number];

export type EvGate = 'PASSED' | 'NOT_SUPPLIED';

export interface GapDecisionConfig {
	enabled: boolean;
	/** When true, an ABSENT EV row refuses (EV_REQUIRED); when false it is recorded as NOT_SUPPLIED. */
	requireEv: boolean;
}

export const DEFAULT_GAP_DECISION_CONFIG: GapDecisionConfig = { enabled: true, requireEv: false };

export const GAP_DECISION_SPEC = {
	feature: 'GapDecision',
	version: GAP_DECISION_VERSION,
	question: 'Given the gate-4 evidence for a session, should the gap be faded, followed, or not traded?',
	inputs: 'FadeScore + FollowScore (row 44), the early acceptance/rejection state (row 43), and optionally the net EV of a reviewed plan (row 47)',
	transformation: 'precedence, first match wins: scores unavailable/NO_GAP → tie → greater score wins → the acceptance state must agree (FOLLOW=ACCEPTED, FADE=REJECTED) → the optional EV row must be OK and netEvPoints > 0 → decide',
	output: 'exactly one of FADE / FOLLOW / NO_TRADE, with the winner, its score, the gap direction and the trade direction implied (a fade trades against the gap; a follow with it)',
	timestampBoundary: 'all inputs are knowable at the open; the module reads no session clock and never looks at the session outcome',
	failureBehavior: 'any missing/refused/unusable required input ⇒ NO_TRADE with a closed-vocabulary token and a null decision; no decision is fabricated from partial evidence',
	thresholds: 'none — the winner is the strictly greater equal-weight count and the confirmation is an exact state match',
	refuses: [...GAP_DECISION_REFUSALS] as string[],
	missingData: 'a missing/unusable score or acceptance state, a tie, or (when the EV row is supplied or requireEv is set) an absent/refused/non-positive EV ⇒ NO_TRADE, never a guessed side',
};

export const describeGapDecision = (c: GapDecisionConfig = DEFAULT_GAP_DECISION_CONFIG): string =>
	[
		`${GAP_DECISION_VERSION}: returns FADE, FOLLOW or NO_TRADE from the gate-4 evidence.`,
		`The side is the strictly greater of the two independent counts; a tie returns NO_TRADE.`,
		`The acceptance state must agree (FOLLOW needs ACCEPTED, FADE needs REJECTED), else NO_TRADE.`,
		`A supplied EV row is a hard gate (must be OK with netEvPoints > 0); requireEv=${c.requireEv}`,
		`decides whether an ABSENT EV row (EV_REQUIRED) or a recorded NOT_SUPPLIED state applies.`,
		`Every failure path returns NO_TRADE with one of ${GAP_DECISION_REFUSALS.join(' / ')}. enabled=${c.enabled}.`,
	].join(' ');

// ── shapes ──────────────────────────────────────────────────────────────────

export interface GapDecisionInputs {
	scores: GapScoreReport;
	acceptance: GapAcceptanceReport;
	/** Optional: the row-47 report. When supplied, its rows are a hard gate for the sessions they cover. */
	ev?: GapExpectedValueReport | null;
}

export interface SessionGapDecision {
	sessionDate: string;
	instrument: string;
	status: GapDecisionStatus;
	decision: GapDecisionOutcome;
	reason: GapDecisionRefusal | null;
	reasonDetail: string | null;
	side: GapDecisionSide | null;
	gapDirection: GapDirection | null;
	/** LONG when the implied trade expects price to rise, SHORT when it expects a fall. */
	tradeDirection: 'LONG' | 'SHORT' | null;
	winner: { side: GapDecisionSide; score: number; maxScore: number } | null;
	evidence: {
		fadeScore: number | null;
		followScore: number | null;
		fadeComponents: Record<string, boolean> | null;
		followComponents: Record<string, boolean> | null;
		acceptanceState: string | null;
		evNetPoints: number | null;
		evGate: EvGate;
	};
}

export interface GapDecisionReport {
	version: string;
	enabled: boolean;
	config: GapDecisionConfig;
	spec: typeof GAP_DECISION_SPEC;
	/** Carried so a reviewer can say which upstream versions produced this decision. */
	upstream: { scoresVersion: string | null; acceptanceVersion: string | null; evVersion: string | null };
	decisions: SessionGapDecision[];
	counts: Record<GapDecisionOutcome, number>;
	statusCounts: Record<GapDecisionStatus, number>;
	reasonCounts: Record<GapDecisionRefusal, number>;
	coverage: {
		sessionsIn: number;
		decided: number;
		fade: number;
		follow: number;
		noTrade: number;
		/** Sessions whose EV row was supplied and passed the gate. */
		evPassed: number;
		/** Sessions where no EV row was supplied (recorded, not silently ignored). */
		evNotSupplied: number;
	};
	reviewerSummary: string;
	digest: string;
}

const bySession = (rows: SessionGapDecision[]): SessionGapDecision[] =>
	[...rows].sort((a, b) => {
		if (a.sessionDate !== b.sessionDate) return a.sessionDate < b.sessionDate ? -1 : 1;
		return a.instrument < b.instrument ? -1 : a.instrument > b.instrument ? 1 : 0;
	});

const key = (r: { sessionDate: string; instrument: string }): string => `${r.sessionDate}|${r.instrument}`;

const tradeDirectionOf = (side: GapDecisionSide, gap: GapDirection): 'LONG' | 'SHORT' => {
	// A follow trades WITH the gap; a fade trades AGAINST it.
	const followUp = gap === 'UP';
	const wantsUp = side === 'FOLLOW' ? followUp : !followUp;
	return wantsUp ? 'LONG' : 'SHORT';
};

function decideOne(
	sessionDate: string,
	instrument: string,
	fade: SessionGapScores | null,
	follow: SessionGapScores | null,
	acceptance: SessionGapAcceptance | null,
	ev: PlanExpectedValue | null,
	cfg: GapDecisionConfig,
): SessionGapDecision {
	const gapDirection = (acceptance?.direction ?? fade?.direction ?? follow?.direction ?? null) as GapDirection | null;
	const evNet = ev && ev.status === 'OK' && ev.ev ? ev.ev.netEvPoints : null;
	const base = {
		sessionDate,
		instrument,
		gapDirection,
		evidence: {
			fadeScore: fade?.score ?? null,
			followScore: follow?.score ?? null,
			fadeComponents: fade?.components ?? null,
			followComponents: follow?.components ?? null,
			acceptanceState: acceptance?.state ?? null,
			evNetPoints: evNet,
			evGate: 'NOT_SUPPLIED' as EvGate,
		},
	};
	const no = (reason: GapDecisionRefusal, detail: string): SessionGapDecision => ({
		...base, status: 'NO_TRADE', decision: 'NO_TRADE', reason, reasonDetail: detail, side: null, tradeDirection: null, winner: null,
	});

	if (!cfg.enabled) {
		return { ...base, status: 'DISABLED', decision: 'NO_TRADE', reason: null, reasonDetail: 'the component is disabled; no decision was computed for this input', side: null, tradeDirection: null, winner: null };
	}
	if (!fade || !follow) return no('SCORES_UNAVAILABLE', 'the session is missing a FadeScore or FollowScore row, so there is no side to compare');
	if (fade.status === 'NOT_APPLICABLE' || follow.status === 'NOT_APPLICABLE') {
		return no('NO_GAP', `there is no material gap to act on (${fade.reason ?? follow.reason ?? 'NO_GAP'})`);
	}
	if (fade.status !== 'OK' || follow.status !== 'OK' || fade.score === null || follow.score === null) {
		return no('SCORES_UNAVAILABLE', `the scores are not OK (fade=${fade.status}${fade.reason ? `/${fade.reason}` : ''}, follow=${follow.status}${follow.reason ? `/${follow.reason}` : ''})`);
	}
	if (fade.score === follow.score) {
		return no('SCORE_TIE', `the two sides are tied at ${fade.score}/${fade.maxScore}, so neither is favoured`);
	}

	const side: GapDecisionSide = fade.score > follow.score ? 'FADE' : 'FOLLOW';
	const score = side === 'FADE' ? fade.score : follow.score;
	const winner = { side, score, maxScore: side === 'FADE' ? fade.maxScore : follow.maxScore };

	if (!acceptance || acceptance.status !== 'OK' || !acceptance.state) {
		return no('NO_CONFIRMATION', `the acceptance state is ${acceptance ? `${acceptance.status}${acceptance.reason ? `/${acceptance.reason}` : ''}` : 'absent'}, so the ${side} side is unconfirmed`);
	}
	const required = side === 'FOLLOW' ? 'ACCEPTED' : 'REJECTED';
	if (acceptance.state !== required) {
		return no('CONFIRMATION_CONFLICT', `the ${side} side needs the gap ${required.toLowerCase()}, but the early state is ${acceptance.state}`);
	}

	let evGate: EvGate = 'NOT_SUPPLIED';
	if (ev) {
		if (ev.status !== 'OK' || !ev.ev) {
			return no('EV_UNAVAILABLE', `an expected-value row was supplied for this session but it is ${ev.status}${ev.reason ? ` (${ev.reason})` : ''}`);
		}
		if (!(ev.ev.netEvPoints > 0)) {
			return no('NON_POSITIVE_EV', `the supplied plan has net EV ${ev.ev.netEvPoints} points, which is not positive after spread, slippage and fees`);
		}
		evGate = 'PASSED';
	} else if (cfg.requireEv) {
		return no('EV_REQUIRED', 'no expected-value row was supplied and requireEv is set, so the decision fails closed');
	}

	const decided: SessionGapDecision = {
		...base,
		status: 'OK',
		decision: side,
		reason: null,
		reasonDetail: null,
		side,
		tradeDirection: gapDirection ? tradeDirectionOf(side, gapDirection) : null,
		winner,
	};
	decided.evidence.evGate = evGate;
	return decided;
}

/**
 * Decide every session present in the score report(s). Input order is irrelevant; rows are emitted in
 * canonical order and the digest is a function of the DATA alone.
 */
export function decideGapSessions(inputs: GapDecisionInputs, config: Partial<GapDecisionConfig> = {}): GapDecisionReport {
	const cfg: GapDecisionConfig = { ...DEFAULT_GAP_DECISION_CONFIG, ...config };

	const fadeIndex = new Map<string, SessionGapScores>();
	for (const o of inputs.scores?.fade?.observations ?? []) fadeIndex.set(key(o), o);
	const followIndex = new Map<string, SessionGapScores>();
	for (const o of inputs.scores?.follow?.observations ?? []) followIndex.set(key(o), o);
	const acceptanceIndex = new Map<string, SessionGapAcceptance>();
	for (const o of inputs.acceptance?.observations ?? []) acceptanceIndex.set(key(o), o);
	const evIndex = new Map<string, PlanExpectedValue>();
	for (const o of inputs.ev?.plans ?? []) evIndex.set(key(o), o);

	const sessionKeys = [...new Set([...fadeIndex.keys(), ...followIndex.keys()])].sort();
	const decisions = sessionKeys.map((k) => {
		const o = fadeIndex.get(k) ?? followIndex.get(k);
		const sessionDate = o?.sessionDate ?? k.split('|')[0];
		const instrument = o?.instrument ?? k.split('|')[1];
		return decideOne(sessionDate, instrument, fadeIndex.get(k) ?? null, followIndex.get(k) ?? null, acceptanceIndex.get(k) ?? null, evIndex.get(k) ?? null, cfg);
	});

	const ordered = bySession(decisions);
	const counts: Record<GapDecisionOutcome, number> = { FADE: 0, FOLLOW: 0, NO_TRADE: 0 };
	const statusCounts: Record<GapDecisionStatus, number> = { OK: 0, NO_TRADE: 0, DISABLED: 0 };
	const reasonCounts = Object.fromEntries(GAP_DECISION_REFUSALS.map((r) => [r, 0])) as Record<GapDecisionRefusal, number>;
	let evPassed = 0;
	let evNotSupplied = 0;
	for (const d of ordered) {
		counts[d.decision] += 1;
		statusCounts[d.status] += 1;
		if (d.reason) reasonCounts[d.reason] += 1;
		if (d.evidence.evGate === 'PASSED') evPassed += 1;
		else if (d.status === 'OK') evNotSupplied += 1;
	}

	return {
		version: GAP_DECISION_VERSION,
		enabled: cfg.enabled,
		config: cfg,
		spec: GAP_DECISION_SPEC,
		upstream: {
			scoresVersion: inputs.scores?.version ?? null,
			acceptanceVersion: inputs.acceptance?.version ?? null,
			evVersion: inputs.ev?.version ?? null,
		},
		decisions: ordered,
		counts,
		statusCounts,
		reasonCounts,
		coverage: {
			sessionsIn: ordered.length,
			decided: statusCounts.OK,
			fade: counts.FADE,
			follow: counts.FOLLOW,
			noTrade: counts.NO_TRADE,
			evPassed,
			evNotSupplied,
		},
		reviewerSummary: describeGapDecision(cfg),
		digest: JSON.stringify(ordered.map((d) => [d.sessionDate, d.instrument, d.status, d.decision, d.reason, d.side, d.tradeDirection])),
	};
}
