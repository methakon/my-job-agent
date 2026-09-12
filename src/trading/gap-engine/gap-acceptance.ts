/**
 * GATE 4 #6 (roadmap row 43) — EARLY GAP ACCEPTANCE / REJECTION state.
 *
 * Single responsibility: decide, WITHIN A BOUNDED EARLY WINDOW after the open, whether the session's
 * gap is being ACCEPTED (price holds the gap side and never returns to the gap origin) or REJECTED
 * (price returns to the gap origin), and say so explicitly when it cannot decide. PURE: no clock, no
 * I/O, no DB, no network, no AI, no randomness — everything it needs is an argument.
 *
 * ── PINNED DEFINITION (units, window, boundary, edges) ──────────────────────────────────────
 *   gap origin  = prevClose                     (the same origin the taxonomy calls "filled")
 *   gap         = open − prevClose              (signed; direction UP when > 0, DOWN when < 0)
 *   early window= [open, open + earlyWindowMinutes)  — open is 09:15 IST for the session date
 *
 *   DECISION, evaluated in this documented precedence (first match wins):
 *     NOT_APPLICABLE  the session has NO gap (open == prevClose) — there is nothing to accept/reject
 *     UNAVAILABLE     the path does not cover the early window well enough to decide (see below)
 *     REJECTED        an observation inside the early window reached the gap origin
 *                     (UP: price <= prevClose, DOWN: price >= prevClose) — DECISIVE even if the
 *                     window is only partly covered: the rejection has already happened
 *     ACCEPTED        the origin was never reached AND the path covers the window through its end
 *     UNAVAILABLE     otherwise (the window is not yet covered) — acceptance is never assumed
 *
 *   TIMESTAMP BOUNDARY: only observations with `instantMs` in [open, open + earlyWindowMinutes) can
 *   decide the state; coverage of the window END is judged by any observation at/after it. An
 *   absolute instant is required (IST wall clock converted by the loader, never a bare string).
 *
 *   UNITS: prices are index points; instants are epoch milliseconds; the window is minutes from the
 *   open; observations are counted, not weighted.
 *
 *   MISSING / DEGENERATE DATA → a safe explicit state behind a CLOSED refusal vocabulary; a state is
 *   never guessed from a partial window:
 *     NO_SESSION_OPEN        the session date is not a usable YYYY-MM-DD
 *     NO_PREV_CLOSE          the session bar carries no previous close, so the origin is unknown
 *     NO_GAP                 open == prevClose (NOT_APPLICABLE — nothing to accept or reject)
 *     NO_PATH                the path holds no observation inside the session window
 *     LATE_START             the first observation is too late to cover the open
 *     WINDOW_INCOMPLETE      too few observations inside the window, or the path does not reach the
 *                            window end while the origin was never touched
 *   NO LOOK-AHEAD: the decision reads only observations inside the early window. A later observation
 *   can only ever be used to assert that the window was COVERED, never to change an ACCEPTED/REJECTED
 *   verdict (asserted by test: mutating post-window prices cannot move a verdict).
 *
 * RESEARCH / SHADOW ONLY: nothing in production imports this module (asserted by test); it writes no
 * state and no decision, order or risk path reads it. Versioned: gapacc-v1.
 */

import { MARKET_OPEN_START_MIN, MARKET_CLOSE_MIN } from '../pre-open/pre-open-session';
import { sessionMidnightMs } from '../pre-open/pre-open-alignment';
import { SessionBar } from './gap-session-series';
import { IntradaySessionPath, PathPoint } from './gap-candidates';

export const GAP_ACCEPTANCE_VERSION = 'gapacc-v1';

export type GapAcceptanceState = 'ACCEPTED' | 'REJECTED';
export type GapAcceptanceStatus = 'OK' | 'NOT_APPLICABLE' | 'UNAVAILABLE' | 'DISABLED';

/** Closed, published refusal vocabulary (declaration order is the canonical order). */
export const GAP_ACCEPTANCE_REFUSALS = [
	'NO_SESSION_OPEN',
	'NO_PREV_CLOSE',
	'NO_GAP',
	'NO_PATH',
	'LATE_START',
	'WINDOW_INCOMPLETE',
] as const;
export type GapAcceptanceRefusal = (typeof GAP_ACCEPTANCE_REFUSALS)[number];

/** Canonical status order for the order-independent count map. */
export const GAP_ACCEPTANCE_STATUSES: readonly GapAcceptanceStatus[] = ['OK', 'NOT_APPLICABLE', 'UNAVAILABLE', 'DISABLED'];

export interface GapAcceptanceConfig {
	/** Master switch: false ⇒ no state is computed and every input is reported DISABLED. */
	enabled: boolean;
	/** Structural default: how long after the open still counts as "early". */
	earlyWindowMinutes: number;
	/** How late the first observation may be and still be treated as covering the open. */
	maxStartLagMinutes: number;
	/** Minimum observations inside the early window before a state may be decided. */
	minObservationsInWindow: number;
}

export const DEFAULT_GAP_ACCEPTANCE_CONFIG: GapAcceptanceConfig = {
	enabled: true,
	earlyWindowMinutes: 30,
	maxStartLagMinutes: 5,
	minObservationsInWindow: 2,
};

/** Machine-checkable statement of the contract; carried on every result for a reviewer. */
export const GAP_ACCEPTANCE_SPEC = {
	feature: 'EarlyGapAcceptance',
	version: GAP_ACCEPTANCE_VERSION,
	question: 'Within the first earlyWindowMinutes after the open, did price ACCEPT the gap (hold the gap side) or REJECT it (return to the gap origin)?',
	origin: 'prevClose — the same origin the taxonomy uses for "filled"',
	window: 'open (09:15 IST for the session date) .. open + earlyWindowMinutes',
	units: 'prices in index points; instants in epoch ms; window in minutes from the open; observations counted, never weighted',
	precedence: 'NO_GAP (NOT_APPLICABLE) → NO_SESSION_OPEN / NO_PREV_CLOSE / NO_PATH / LATE_START / WINDOW_INCOMPLETE (UNAVAILABLE) → REJECTED → ACCEPTED',
	lookAhead: 'only observations inside the early window decide; a later observation may only assert window coverage, never change a verdict',
	thresholds: 'structural defaults only (earlyWindowMinutes, maxStartLagMinutes, minObservationsInWindow), never tuned against outcomes',
	refuses: [...GAP_ACCEPTANCE_REFUSALS] as string[],
};

export interface SessionGapAcceptance {
	sessionDate: string;
	instrument: string;
	status: GapAcceptanceStatus;
	/** The decided state, or null in every non-OK state (never assumed). */
	state: GapAcceptanceState | null;
	reason: GapAcceptanceRefusal | null;
	reasonDetail: string | null;
	direction: 'UP' | 'DOWN' | null;
	/** The gap origin (previous close) the decision is measured against. */
	originLevel: number | null;
	evidence: {
		open: number | null;
		prevClose: number | null;
		gapAbs: number | null;
		windowFromMs: number | null;
		windowToMs: number | null;
		observationsInWindow: number | null;
		startLagMs: number | null;
		windowCoveredToEnd: boolean | null;
		/** First instant inside the window at/through the origin, when REJECTED. */
		firstRejectionAtMs: number | null;
		/** The most extreme price inside the window on the gap's side, when available. */
		extremeInWindow: number | null;
	};
}

export interface GapAcceptanceReport {
	version: string;
	enabled: boolean;
	config: GapAcceptanceConfig;
	observations: SessionGapAcceptance[];
	counts: Record<GapAcceptanceStatus, number>;
	stateCounts: Record<GapAcceptanceState, number>;
	refusalCounts: Record<GapAcceptanceRefusal, number>;
	coverage: {
		sessionsIn: number;
		pathsIn: number;
		ok: number;
		accepted: number;
		rejected: number;
		notApplicable: number;
		unavailable: number;
		disabled: number;
	};
	spec: typeof GAP_ACCEPTANCE_SPEC;
	reviewerSummary: string;
	digest: string;
}

export const describeGapAcceptance = (c: GapAcceptanceConfig = DEFAULT_GAP_ACCEPTANCE_CONFIG): string =>
	[
		`${GAP_ACCEPTANCE_VERSION}: within the first ${c.earlyWindowMinutes} min after the open, decides whether the session's gap is`,
		`ACCEPTED (price holds the gap side and never returns to the gap origin = the previous close) or REJECTED (price returns to the origin).`,
		`Only observations inside that window decide; a later observation may only confirm the window was covered, never change a verdict.`,
		`A late-starting path, too few in-window observations, or a path that never reaches the window end while the origin was untouched`,
		`is refused as UNAVAILABLE with one of ${GAP_ACCEPTANCE_REFUSALS.join(' / ')} — acceptance is never assumed from a partial window.`,
		`No gap means NOT_APPLICABLE (NO_GAP). Thresholds are structural defaults, never tuned. enabled=${c.enabled}.`,
	].join(' ');

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Canonical TOTAL order: session date, then the row's own pre-open identity content. */
const bySession = (rows: SessionBar[]): SessionBar[] =>
	[...rows].sort((a, b) => {
		if (a.sessionDate !== b.sessionDate) return a.sessionDate < b.sessionDate ? -1 : 1;
		const ka = `${a.instrument}|${a.open}|${a.prevClose}`;
		const kb = `${b.instrument}|${b.open}|${b.prevClose}`;
		return ka < kb ? -1 : ka > kb ? 1 : 0;
	});

const emptyEvidence = (): SessionGapAcceptance['evidence'] => ({
	open: null,
	prevClose: null,
	gapAbs: null,
	windowFromMs: null,
	windowToMs: null,
	observationsInWindow: null,
	startLagMs: null,
	windowCoveredToEnd: null,
	firstRejectionAtMs: null,
	extremeInWindow: null,
});

const refused = (s: SessionBar, reason: GapAcceptanceRefusal, detail: string, evidence: SessionGapAcceptance['evidence'], status: GapAcceptanceStatus = 'UNAVAILABLE'): SessionGapAcceptance => ({
	sessionDate: s.sessionDate,
	instrument: s.instrument,
	status,
	state: null,
	reason,
	reasonDetail: detail,
	direction: null,
	originLevel: null,
	evidence,
});

function assessOne(s: SessionBar, path: IntradaySessionPath | null, cfg: GapAcceptanceConfig): SessionGapAcceptance {
	const ev = emptyEvidence();
	ev.open = isNum(s.open) ? s.open : null;
	ev.prevClose = isNum(s.prevClose) ? s.prevClose : null;

	const midnight = sessionMidnightMs(s.sessionDate);
	if (midnight === null) {
		return refused(s, 'NO_SESSION_OPEN', `"${s.sessionDate}" is not a usable session date`, ev);
	}
	if (!isNum(s.open) || s.open <= 0 || !isNum(s.prevClose) || s.prevClose <= 0) {
		return refused(s, 'NO_PREV_CLOSE', 'the session bar carries no usable open/previous close, so the gap origin is unknown', ev);
	}
	const direction: 'UP' | 'DOWN' = s.open > s.prevClose ? 'UP' : 'DOWN';
	const gapAbs = s.open - s.prevClose;
	if (gapAbs === 0) {
		return {
			...refused(s, 'NO_GAP', 'open equals the previous close, so there is no gap to accept or reject', ev, 'NOT_APPLICABLE'),
			direction,
			originLevel: s.prevClose,
			evidence: { ...ev, gapAbs: 0 },
		};
	}

	const openMs = midnight + MARKET_OPEN_START_MIN * 60_000;
	const closeMs = midnight + MARKET_CLOSE_MIN * 60_000;
	const windowToMs = openMs + cfg.earlyWindowMinutes * 60_000;
	ev.windowFromMs = openMs;
	ev.windowToMs = windowToMs;
	ev.gapAbs = gapAbs;

	const points = (path?.points ?? [])
		.filter((p: PathPoint) => isNum(p.instantMs) && isNum(p.price) && p.price > 0 && p.instantMs >= openMs && p.instantMs <= closeMs)
		.sort((a, b) => a.instantMs - b.instantMs);
	if (!points.length) {
		return refused(s, 'NO_PATH', 'the path holds no observation inside the session window', ev);
	}

	const startLagMs = points[0].instantMs - openMs;
	ev.startLagMs = startLagMs;
	if (startLagMs > cfg.maxStartLagMinutes * 60_000) {
		return refused(
			s,
			'LATE_START',
			`first observation is ${(startLagMs / 60_000).toFixed(1)} min after the 09:15 open, later than the ${cfg.maxStartLagMinutes} min bound, so the early window would be a mislabelled proxy`,
			ev,
		);
	}

	const inWindow = points.filter((p) => p.instantMs < windowToMs);
	ev.observationsInWindow = inWindow.length;
	if (inWindow.length < cfg.minObservationsInWindow) {
		return refused(s, 'WINDOW_INCOMPLETE', `${inWindow.length} observation(s) inside the ${cfg.earlyWindowMinutes}-minute early window (need at least ${cfg.minObservationsInWindow})`, ev);
	}

	const originLevel = s.prevClose;
	const reachedOrigin = (p: PathPoint): boolean => (direction === 'UP' ? p.price <= originLevel : p.price >= originLevel);
	const firstRejection = inWindow.find(reachedOrigin);
	ev.extremeInWindow = direction === 'UP'
		? Math.min(...inWindow.map((p) => p.price))
		: Math.max(...inWindow.map((p) => p.price));

	// REJECTED is decisive as soon as the origin is reached inside the window — even with partial coverage.
	if (firstRejection) {
		ev.firstRejectionAtMs = firstRejection.instantMs;
		return {
			sessionDate: s.sessionDate, instrument: s.instrument, status: 'OK', state: 'REJECTED', reason: null, reasonDetail: null,
			direction, originLevel, evidence: ev,
		};
	}

	// Acceptance requires coverage THROUGH the window end; the origin untouched is not enough.
	const windowCoveredToEnd = points.some((p) => p.instantMs >= windowToMs);
	ev.windowCoveredToEnd = windowCoveredToEnd;
	if (!windowCoveredToEnd) {
		return refused(s, 'WINDOW_INCOMPLETE', `no observation reaches the end of the ${cfg.earlyWindowMinutes}-minute early window, so acceptance cannot be claimed`, ev);
	}

	return {
		sessionDate: s.sessionDate, instrument: s.instrument, status: 'OK', state: 'ACCEPTED', reason: null, reasonDetail: null,
		direction, originLevel, evidence: ev,
	};
}

const disabledRow = (s: SessionBar): SessionGapAcceptance => ({
	sessionDate: s.sessionDate, instrument: s.instrument, status: 'DISABLED', state: null, reason: null,
	reasonDetail: 'the component is disabled; no state was computed for this input', direction: null, originLevel: null, evidence: emptyEvidence(),
});

const digestOf = (observations: SessionGapAcceptance[]): string =>
	JSON.stringify(
		observations.map((o) => [
			o.sessionDate, o.instrument, o.status, o.state, o.reason,
			o.evidence.gapAbs === null ? null : Number(o.evidence.gapAbs.toFixed(6)),
			o.evidence.firstRejectionAtMs,
		]),
	);

/**
 * Decide the early acceptance/rejection state for every session of one instrument's series.
 * `paths` are joined by (sessionDate, instrument). Input order is irrelevant; observations are
 * emitted in canonical order and the digest is a function of the DATA alone.
 */
export function assessGapAcceptance(
	sessions: SessionBar[],
	paths: IntradaySessionPath[],
	config: Partial<GapAcceptanceConfig> = {},
): GapAcceptanceReport {
	const cfg: GapAcceptanceConfig = { ...DEFAULT_GAP_ACCEPTANCE_CONFIG, ...config };
	const ordered = bySession(sessions);

	const pathIndex = new Map<string, IntradaySessionPath>();
	for (const p of paths ?? []) pathIndex.set(`${p.sessionDate}|${p.instrument}`, p);

	const observations = cfg.enabled
		? ordered.map((s) => assessOne(s, pathIndex.get(`${s.sessionDate}|${s.instrument}`) ?? null, cfg))
		: ordered.map(disabledRow);

	const counts: Record<GapAcceptanceStatus, number> = { OK: 0, NOT_APPLICABLE: 0, UNAVAILABLE: 0, DISABLED: 0 };
	const stateCounts: Record<GapAcceptanceState, number> = { ACCEPTED: 0, REJECTED: 0 };
	const refusalCounts = Object.fromEntries(GAP_ACCEPTANCE_REFUSALS.map((r) => [r, 0])) as Record<GapAcceptanceRefusal, number>;
	for (const o of observations) {
		counts[o.status] += 1;
		if (o.state) stateCounts[o.state] += 1;
		if (o.reason) refusalCounts[o.reason] += 1;
	}

	return {
		version: GAP_ACCEPTANCE_VERSION,
		enabled: cfg.enabled,
		config: cfg,
		observations,
		counts,
		stateCounts,
		refusalCounts,
		coverage: {
			sessionsIn: ordered.length,
			pathsIn: (paths ?? []).length,
			ok: counts.OK,
			accepted: stateCounts.ACCEPTED,
			rejected: stateCounts.REJECTED,
			notApplicable: counts.NOT_APPLICABLE,
			unavailable: counts.UNAVAILABLE,
			disabled: counts.DISABLED,
		},
		spec: GAP_ACCEPTANCE_SPEC,
		reviewerSummary: describeGapAcceptance(cfg),
		digest: digestOf(observations),
	};
}
