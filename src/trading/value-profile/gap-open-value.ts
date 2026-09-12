/**
 * GATE 6 #5 (roadmap row 64) — GAP OPENS ABOVE/BELOW VALUE AND ACCEPTANCE / REJECTION.
 *
 * Single responsibility: for each session, classify WHERE the session OPENED relative to the PRIOR
 * session's value area (above / below / inside) and, for a gap open, whether the session ACCEPTED that
 * higher/lower location or REJECTED it — over an explicit sample, reporting the sample size and coverage
 * behind every number. PURE: no clock, no I/O, no DB, no network, no AI, no randomness.
 *
 * ── PINNED DEFINITION (reference, window, metric, states) ──────────────────────────────────
 *   reference area = the PRIOR profiled session's value area (VAL/VAH) from the row-60 profile — never
 *                    the session's own area, which is not known at the open.
 *   open           = the FIRST in-window observation (the price the session is trading at from 09:15),
 *                    subject to the same start-coverage bound as GATE 6 #3 (`maxStartLagMinutes`).
 *   openLocation   = ABOVE_VALUE when open > VAH; BELOW_VALUE when open < VAL; INSIDE_VALUE otherwise
 *                    (an open exactly on an edge counts as INSIDE — pinned, not a tolerance band).
 *   outcome        = for a gap open (ABOVE/BELOW) the open IS the excursion:
 *                      ACCEPTED   the higher/lower location HELD — price never returned inside
 *                                 [VAL, VAH] through the session close
 *                      REJECTED   price returned strictly inside the area and never left it again
 *                                 through the close (the stated level was rejected)
 *                      REVISITED  price returned inside but left the area again later, so the return
 *                                 did not hold either way — reported explicitly, never forced
 *                    INSIDE_VALUE opens carry NOT_APPLICABLE: there is no gap relative to value to
 *                    accept or reject.
 *
 *   METRIC (the reproducible number): the counts of ACCEPTED / REJECTED / REVISITED for ABOVE_VALUE and
 *   BELOW_VALUE opens — reported together with the SAMPLE SIZE (number of judged gap opens) and the
 *   coverage behind it. gapPoints (how far outside the nearest edge the open was) and timeToReturnMs are
 *   reported descriptively; nothing here is tuned, ranked or used to select.
 *
 *   UNITS: prices and gapPoints in index points; instants in epoch ms.
 *
 * ── MISSING / DEGENERATE DATA → a safe explicit state ───────────────────────────────────────
 *   NO_SESSION_DATE / NO_VALUE_AREA / ZERO_VALUE_AREA / NO_POINTS / LATE_START /
 *   NO_SESSION_CLOSE_COVERAGE / NO_GAP_OPEN (NOT_APPLICABLE) — each with a null location and outcome;
 *   a gap-open outcome is never fabricated from a partial tape.
 *
 * RESEARCH / SHADOW ONLY: nothing in production imports this module (asserted by test). Versioned:
 * gapval-v1.
 */

import { sessionMidnightMs } from '../pre-open/pre-open-alignment';
import { MARKET_OPEN_START_MIN, MARKET_CLOSE_MIN } from '../pre-open/pre-open-session';
import { ProfilePath } from './value-profile';

/**
 * The ONLY session fields this component needs. Deliberately structural: the session-series adapter is
 * NOT imported, so it stays owned by its own chain.
 */
export type GapOpenSessionBar = {
	sessionDate: string;
	instrument: string;
};

export const GAP_OPEN_VALUE_VERSION = 'gapval-v1';

export type GapOpenLocation = 'ABOVE_VALUE' | 'BELOW_VALUE' | 'INSIDE_VALUE';
export type GapOpenOutcome = 'ACCEPTED' | 'REJECTED' | 'REVISITED' | 'NOT_APPLICABLE';
export type GapOpenStatus = 'OK' | 'NOT_APPLICABLE' | 'UNAVAILABLE' | 'DISABLED';

/** Closed, published refusal vocabulary (declaration order is the canonical order). */
export const GAP_OPEN_REFUSALS = [
	'NO_SESSION_DATE',
	'NO_VALUE_AREA',
	'ZERO_VALUE_AREA',
	'NO_POINTS',
	'LATE_START',
	'NO_SESSION_CLOSE_COVERAGE',
	'NO_GAP_OPEN',
] as const;
export type GapOpenRefusal = (typeof GAP_OPEN_REFUSALS)[number];

export const GAP_OPEN_STATUSES: readonly GapOpenStatus[] = ['OK', 'NOT_APPLICABLE', 'UNAVAILABLE', 'DISABLED'];
/** Declaration order is the canonical (and report) order. */
export const GAP_OPEN_LOCATIONS: readonly GapOpenLocation[] = ['ABOVE_VALUE', 'BELOW_VALUE', 'INSIDE_VALUE'];
export const GAP_OPEN_OUTCOMES: readonly GapOpenOutcome[] = ['ACCEPTED', 'REJECTED', 'REVISITED', 'NOT_APPLICABLE'];

export interface GapOpenValueConfig {
	enabled: boolean;
	/** How late the first observation may be and still count as the session open. */
	maxStartLagMinutes: number;
	/** How close to the 15:30 close the last observation must reach for the outcome to be judgeable. */
	closeCoverageMinutes: number;
}

export const DEFAULT_GAP_OPEN_VALUE_CONFIG: GapOpenValueConfig = {
	enabled: true,
	maxStartLagMinutes: 30,
	closeCoverageMinutes: 30,
};

export const GAP_OPEN_VALUE_SPEC = {
	feature: 'GapOpenValue',
	version: GAP_OPEN_VALUE_VERSION,
	question: 'Where did the session open relative to the PRIOR session value area, and did the session accept or reject that gap-open location?',
	reference: 'the PRIOR session value area (VAL/VAH) from the row-60 profile — never the session own area',
	window: 'the session open is the FIRST in-window observation (>= 09:15) within maxStartLagMinutes of the open; the outcome is judged to within closeCoverageMinutes of the 15:30 close',
	metric: 'for ABOVE_VALUE and BELOW_VALUE opens: ACCEPTED (location held) / REJECTED (returned inside and never left) / REVISITED (returned inside then left again), reported with the sample size and coverage',
	locations: 'ABOVE_VALUE (open > VAH), BELOW_VALUE (open < VAL), INSIDE_VALUE otherwise — an open exactly on an edge counts as INSIDE, never a tolerance band',
	acceptance: 'ACCEPTED = price never returns strictly inside [VAL, VAH] through the close; REJECTED = it returns inside and never leaves again; REVISITED = it returns inside but leaves again',
	units: 'prices and gapPoints in index points; instants in epoch ms',
	thresholds: 'only the two coverage bounds (maxStartLagMinutes, closeCoverageMinutes); the location and acceptance rules have no tolerance, band or duration',
	refuses: [...GAP_OPEN_REFUSALS] as string[],
	missingData: 'no observations, no/refused/zero-width reference area, or a tape that does not cover the open or the close ⇒ a null location and outcome with a closed-vocabulary token, never a fabricated result',
};

export const describeGapOpenValue = (c: GapOpenValueConfig = DEFAULT_GAP_OPEN_VALUE_CONFIG): string =>
	[
		`${GAP_OPEN_VALUE_VERSION}: classifies where the session OPENED relative to the PRIOR session's value area and whether a gap open was accepted or rejected.`,
		`The open is the first observation within ${c.maxStartLagMinutes} min of 09:15; the outcome is judged to within ${c.closeCoverageMinutes} min of the 15:30 close.`,
		`ABOVE_VALUE = open above VAH, BELOW_VALUE = open below VAL, INSIDE_VALUE otherwise (an open on an edge counts as INSIDE).`,
		`For a gap open: ACCEPTED = price never returned inside the area through the close; REJECTED = it returned inside and never left again; REVISITED = it returned inside but left again.`,
		`The report always states its SAMPLE SIZE (judged gap opens) and the location/outcome counts behind it.`,
		`Missing or degenerate input yields a null location and outcome with one of ${GAP_OPEN_REFUSALS.join(' / ')}. enabled=${c.enabled}.`,
	].join(' ');

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

const bySession = (rows: GapOpenSessionBar[]): GapOpenSessionBar[] =>
	[...rows].sort((a, b) => {
		if (a.sessionDate !== b.sessionDate) return a.sessionDate < b.sessionDate ? -1 : 1;
		return a.instrument < b.instrument ? -1 : a.instrument > b.instrument ? 1 : 0;
	});

const emptyEvidence = (): SessionGapOpen['evidence'] => ({
	val: null, vah: null, priorSessionDate: null, open: null, openAtMs: null,
	observations: null, observationsOutside: null, firstReturnInsideAtMs: null, lastObservationAtMs: null,
});

const refused = (
	s: GapOpenSessionBar,
	reason: GapOpenRefusal,
	detail: string,
	evidence: SessionGapOpen['evidence'],
	status: GapOpenStatus = 'UNAVAILABLE',
): SessionGapOpen => ({
	sessionDate: s.sessionDate, instrument: s.instrument, status, reason, reasonDetail: detail,
	location: null, outcome: null, gapPoints: null, timeToReturnMs: null, evidence,
});

/** Disabled is not a refusal: the component was switched off, so no token is spent on it. */
const disabledFor = (s: GapOpenSessionBar): SessionGapOpen => ({
	sessionDate: s.sessionDate, instrument: s.instrument, status: 'DISABLED', reason: null,
	reasonDetail: 'the component is disabled; no location or outcome was computed for this input',
	location: null, outcome: null, gapPoints: null, timeToReturnMs: null, evidence: emptyEvidence(),
});

function detectOne(s: GapOpenSessionBar, path: ProfilePath | null, area: { val: number; vah: number; priorSessionDate: string } | null, cfg: GapOpenValueConfig): SessionGapOpen {
	const ev = emptyEvidence();
	if (area) { ev.val = area.val; ev.vah = area.vah; ev.priorSessionDate = area.priorSessionDate; }

	const midnight = sessionMidnightMs(s.sessionDate);
	if (midnight === null) return refused(s, 'NO_SESSION_DATE', `"${s.sessionDate}" is not a usable session date`, ev);
	if (!area) return refused(s, 'NO_VALUE_AREA', 'no earlier session produced a usable value area, so there is no reference to open against', ev);
	if (!(area.vah - area.val > 0)) return refused(s, 'ZERO_VALUE_AREA', `the reference value area is zero-width (VAL=${area.val}, VAH=${area.vah})`, ev);

	const openMs = midnight + MARKET_OPEN_START_MIN * 60_000;
	const closeMs = midnight + MARKET_CLOSE_MIN * 60_000;
	const points = (path?.points ?? [])
		.filter((p) => isNum(p.instantMs) && isNum(p.price) && p.price > 0 && p.instantMs >= openMs && p.instantMs <= closeMs)
		.sort((a, b) => a.instantMs - b.instantMs);
	if (!points.length) return refused(s, 'NO_POINTS', 'the path holds no observation inside the session window', ev);

	ev.observations = points.length;
	ev.lastObservationAtMs = points[points.length - 1].instantMs;
	if (points[0].instantMs - openMs > cfg.maxStartLagMinutes * 60_000) {
		return refused(s, 'LATE_START', `the first observation is ${((points[0].instantMs - openMs) / 60_000).toFixed(1)} min after the 09:15 open (bound ${cfg.maxStartLagMinutes}), so the open cannot be identified`, ev);
	}
	if (closeMs - points[points.length - 1].instantMs > cfg.closeCoverageMinutes * 60_000) {
		return refused(s, 'NO_SESSION_CLOSE_COVERAGE', `the tape ends ${((closeMs - points[points.length - 1].instantMs) / 60_000).toFixed(1)} min before the 15:30 close (bound ${cfg.closeCoverageMinutes}), so acceptance cannot be judged to the session end`, ev);
	}

	const open = points[0];
	ev.open = open.price;
	ev.openAtMs = open.instantMs;
	const isInside = (price: number): boolean => price >= area.val && price <= area.vah;
	const location: GapOpenLocation = open.price > area.vah ? 'ABOVE_VALUE' : open.price < area.val ? 'BELOW_VALUE' : 'INSIDE_VALUE';

	const base = { sessionDate: s.sessionDate, instrument: s.instrument, evidence: ev } as const;
	if (location === 'INSIDE_VALUE') {
		return { ...base, status: 'NOT_APPLICABLE', reason: 'NO_GAP_OPEN', reasonDetail: 'the session opened inside the prior value area, so there is no gap to accept or reject', location, outcome: 'NOT_APPLICABLE', gapPoints: 0, timeToReturnMs: null };
	}

	const gapPoints = location === 'ABOVE_VALUE' ? open.price - area.vah : area.val - open.price;
	ev.observationsOutside = points.filter((p) => !isInside(p.price)).length;

	const after = points.filter((p) => p.instantMs > open.instantMs);
	const firstReturn = after.find((p) => isInside(p.price));
	if (!firstReturn) {
		return { ...base, status: 'OK', reason: null, reasonDetail: null, location, outcome: 'ACCEPTED', gapPoints, timeToReturnMs: null };
	}
	ev.firstReturnInsideAtMs = firstReturn.instantMs;
	const timeToReturnMs = firstReturn.instantMs - open.instantMs;
	const leftAgain = after.filter((p) => p.instantMs > firstReturn.instantMs).find((p) => !isInside(p.price));
	const outcome: GapOpenOutcome = leftAgain ? 'REVISITED' : 'REJECTED';
	return { ...base, status: 'OK', reason: null, reasonDetail: null, location, outcome, gapPoints, timeToReturnMs };
}

/**
 * Classify the gap-open location and acceptance/rejection for every session offered.
 * Consumes the row-60 value-profile REPORT and the same session paths; the reference area is the PRIOR
 * profiled session, matched by date. Deterministic: sessions are canonically ordered and the digest is a
 * function of the DATA alone.
 */
export function buildGapOpenValue(
	sessions: GapOpenSessionBar[],
	profileReport: { version: string; profiles: Array<{ sessionDate: string; instrument: string; status: string; val: number | null; vah: number | null }> },
	paths: ProfilePath[],
	config: Partial<GapOpenValueConfig> = {},
): GapOpenValueReport {
	const cfg: GapOpenValueConfig = { ...DEFAULT_GAP_OPEN_VALUE_CONFIG, ...config };
	const ordered = bySession(sessions);

	const areas = new Map<string, Array<{ sessionDate: string; val: number; vah: number }>>();
	for (const p of profileReport.profiles) {
		if (p.status !== 'OK' || p.val === null || p.vah === null) continue;
		if (!areas.has(p.instrument)) areas.set(p.instrument, []);
		areas.get(p.instrument)!.push({ sessionDate: p.sessionDate, val: p.val, vah: p.vah });
	}
	for (const list of areas.values()) list.sort((a, b) => (a.sessionDate < b.sessionDate ? -1 : a.sessionDate > b.sessionDate ? 1 : 0));

	const pathIndex = new Map<string, ProfilePath>();
	for (const p of paths ?? []) pathIndex.set(`${p.sessionDate}|${p.instrument}`, p);

	const observations = ordered.map((s) => {
		if (!cfg.enabled) return disabledFor(s);
		const list = areas.get(s.instrument) ?? [];
		let prior: { sessionDate: string; val: number; vah: number } | null = null;
		for (const a of list) if (a.sessionDate < s.sessionDate) prior = a;
		const area = prior ? { val: prior.val, vah: prior.vah, priorSessionDate: prior.sessionDate } : null;
		return detectOne(s, pathIndex.get(`${s.sessionDate}|${s.instrument}`) ?? null, area, cfg);
	});

	const counts: Record<GapOpenStatus, number> = { OK: 0, NOT_APPLICABLE: 0, UNAVAILABLE: 0, DISABLED: 0 };
	const locationCounts: Record<GapOpenLocation, number> = { ABOVE_VALUE: 0, BELOW_VALUE: 0, INSIDE_VALUE: 0 };
	const outcomeCounts: Record<GapOpenOutcome, number> = { ACCEPTED: 0, REJECTED: 0, REVISITED: 0, NOT_APPLICABLE: 0 };
	const locationOutcomeCounts = {
		ABOVE_VALUE: { ACCEPTED: 0, REJECTED: 0, REVISITED: 0 },
		BELOW_VALUE: { ACCEPTED: 0, REJECTED: 0, REVISITED: 0 },
	};
	const refusalCounts = Object.fromEntries(GAP_OPEN_REFUSALS.map((r) => [r, 0])) as Record<GapOpenRefusal, number>;
	for (const o of observations) {
		counts[o.status] += 1;
		if (o.location) locationCounts[o.location] += 1;
		if (o.outcome) outcomeCounts[o.outcome] += 1;
		if (o.reason) refusalCounts[o.reason] += 1;
		if (o.status === 'OK' && o.outcome && o.outcome !== 'NOT_APPLICABLE') {
			(locationOutcomeCounts as Record<string, Record<string, number>>)[o.location as string][o.outcome as string] += 1;
		}
	}

	return {
		version: GAP_OPEN_VALUE_VERSION,
		enabled: cfg.enabled,
		config: cfg,
		spec: GAP_OPEN_VALUE_SPEC,
		upstreamProfileVersion: profileReport.version,
		observations,
		counts,
		locationCounts,
		outcomeCounts,
		locationOutcomeCounts,
		refusalCounts,
		coverage: {
			sessionsIn: ordered.length,
			profilesIn: profileReport.profiles.length,
			referenceAreas: [...areas.values()].reduce((a, l) => a + l.length, 0),
			judged: counts.OK,
			aboveValue: locationCounts.ABOVE_VALUE,
			belowValue: locationCounts.BELOW_VALUE,
			insideValue: locationCounts.INSIDE_VALUE,
			/** NUMBER OF JUDGED GAP OPENS — the sample size the doneWhen asks to be shown. */
			sampleSize: counts.OK,
			notApplicable: counts.NOT_APPLICABLE,
			unavailable: counts.UNAVAILABLE,
			disabled: counts.DISABLED,
		},
		reviewerSummary: describeGapOpenValue(cfg),
		digest: JSON.stringify(observations.map((o) => [o.sessionDate, o.instrument, o.status, o.reason, o.location, o.outcome, o.gapPoints === null ? null : Number(o.gapPoints.toFixed(6)), o.evidence.firstReturnInsideAtMs])),
	};
}

export interface SessionGapOpen {
	sessionDate: string;
	instrument: string;
	status: GapOpenStatus;
	reason: GapOpenRefusal | null;
	reasonDetail: string | null;
	location: GapOpenLocation | null;
	outcome: GapOpenOutcome | null;
	/** Distance of the open outside the nearest value edge, in index points (0 for an inside open). */
	gapPoints: number | null;
	/** How long after the open the first return inside took, in ms (null when the location held). */
	timeToReturnMs: number | null;
	evidence: {
		val: number | null;
		vah: number | null;
		priorSessionDate: string | null;
		open: number | null;
		openAtMs: number | null;
		observations: number | null;
		observationsOutside: number | null;
		firstReturnInsideAtMs: number | null;
		lastObservationAtMs: number | null;
	};
}

export interface GapOpenValueReport {
	version: string;
	enabled: boolean;
	config: GapOpenValueConfig;
	spec: typeof GAP_OPEN_VALUE_SPEC;
	/** Carried from the row-60 report, so a reviewer can say which profile version produced the areas. */
	upstreamProfileVersion: string;
	observations: SessionGapOpen[];
	counts: Record<GapOpenStatus, number>;
	locationCounts: Record<GapOpenLocation, number>;
	outcomeCounts: Record<GapOpenOutcome, number>;
	/** THE METRIC: outcome counts split by where the session opened. */
	locationOutcomeCounts: {
		ABOVE_VALUE: { ACCEPTED: number; REJECTED: number; REVISITED: number };
		BELOW_VALUE: { ACCEPTED: number; REJECTED: number; REVISITED: number };
	};
	refusalCounts: Record<GapOpenRefusal, number>;
	coverage: {
		sessionsIn: number;
		profilesIn: number;
		referenceAreas: number;
		judged: number;
		aboveValue: number;
		belowValue: number;
		insideValue: number;
		/** Judged gap opens — the sample size the doneWhen asks to be shown. */
		sampleSize: number;
		notApplicable: number;
		unavailable: number;
		disabled: number;
	};
	reviewerSummary: string;
	digest: string;
}
