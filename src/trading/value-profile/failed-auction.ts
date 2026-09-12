/**
 * GATE 6 #3 (roadmap row 62) — FAILED AUCTION DETECTION.
 *
 * "Excursion outside value followed by acceptance back inside."
 *
 * Single responsibility: given a session's intraday path and a REFERENCE value area, decide whether the
 * session made an excursion outside that area and then ACCEPTED back inside (a failed auction), or held
 * the excursion. PURE: no clock, no I/O, no DB, no network, no AI, no randomness.
 *
 * ── PINNED DEFINITION (inputs, window, states, edges) ───────────────────────────────────────
 *   reference area = the PRIOR session's value area (VAL/VAH) from the row-60 profile — never the
 *                    session's own area, which is only known after the session ran.
 *   excursion      = the FIRST observation strictly outside [VAL, VAH] (UP when > VAH, DOWN when < VAL)
 *   acceptance     = a LATER observation back inside [VAL, VAH] after which the price NEVER leaves the
 *                    area again through the session close — one clean, untuned rule (no minutes, no
 *                    percentage, no tolerance band).
 *
 *   STATES, evaluated in this documented precedence (first match wins):
 *     FAILED_AUCTION       excursion outside, then a return inside, then no further exit through close
 *     EXCURSION_HELD       excursion outside and it never returned inside before the close
 *     EXCURSION_REVISITED  it returned inside but left the area AGAIN later, so acceptance never held
 *   NOT_APPLICABLE         price never left the reference area (NO_EXCURSION) — nothing to fail
 *
 *   COVERAGE (both are structural bounds, not tuned):
 *     the path must start within `maxStartLagMinutes` of the 09:15 open, and must reach within
 *     `closeCoverageMinutes` of the 15:30 close — otherwise the excursion/acceptance cannot be judged
 *     to the session boundary and the session is REFUSED rather than judged on a partial tape.
 *
 *   UNITS: prices in index points; instants in epoch ms; the reference area in index points.
 *
 * ── MISSING / DEGENERATE DATA → a safe explicit state ───────────────────────────────────────
 *   NO_SESSION_DATE / NO_POINTS / NO_VALUE_AREA (the profile refused — its reason propagated verbatim)
 *   / ZERO_VALUE_AREA / LATE_START / NO_SESSION_CLOSE_COVERAGE / NO_EXCURSION (NOT_APPLICABLE)
 *   — each with a null state; a failed auction is never fabricated from a partial tape.
 *
 * RESEARCH / SHADOW ONLY: nothing in production imports this module (asserted by test). Versioned:
 * failauc-v1.
 */

import { sessionMidnightMs } from '../pre-open/pre-open-alignment';
import { MARKET_OPEN_START_MIN, MARKET_CLOSE_MIN } from '../pre-open/pre-open-session';
import { ProfilePath } from '../value-profile/value-profile';

/**
 * The ONLY session fields this component needs. It is a structural type on purpose: the session-series
 * adapter is NOT imported here, so that adapter stays owned by its own chain and this module cannot
 * become a second consumer of its geometry.
 */
export type AuctionSessionBar = {
	sessionDate: string;
	instrument: string;
	open: number | null;
	prevClose: number | null;
};

export const FAILED_AUCTION_VERSION = 'failauc-v1';

export type AuctionState = 'FAILED_AUCTION' | 'EXCURSION_HELD' | 'EXCURSION_REVISITED';
export type FailedAuctionStatus = 'OK' | 'NOT_APPLICABLE' | 'UNAVAILABLE' | 'DISABLED';

/** Closed, published refusal vocabulary (declaration order is the canonical order). */
export const FAILED_AUCTION_REFUSALS = [
	'NO_SESSION_DATE',
	'NO_POINTS',
	'NO_VALUE_AREA',
	'ZERO_VALUE_AREA',
	'LATE_START',
	'NO_SESSION_CLOSE_COVERAGE',
	'NO_EXCURSION',
] as const;
export type FailedAuctionRefusal = (typeof FAILED_AUCTION_REFUSALS)[number];

export const FAILED_AUCTION_STATUSES: readonly FailedAuctionStatus[] = ['OK', 'NOT_APPLICABLE', 'UNAVAILABLE', 'DISABLED'];
export const AUCTION_STATES: readonly AuctionState[] = ['FAILED_AUCTION', 'EXCURSION_HELD', 'EXCURSION_REVISITED'];

export interface FailedAuctionConfig {
	enabled: boolean;
	/** How late the first observation may be and still be treated as covering the open. */
	maxStartLagMinutes: number;
	/** How close to the 15:30 close the last observation must reach for the tail to be judgeable. */
	closeCoverageMinutes: number;
}

export const DEFAULT_FAILED_AUCTION_CONFIG: FailedAuctionConfig = {
	enabled: true,
	maxStartLagMinutes: 30,
	closeCoverageMinutes: 30,
};

export const FAILED_AUCTION_SPEC = {
	feature: 'FailedAuction',
	version: FAILED_AUCTION_VERSION,
	question: 'Did the session excursion outside the prior value area and then accept back inside it (a failed auction), or did the excursion hold?',
	reference: 'the PRIOR session value area (VAL/VAH) from the row-60 profile — never the session own area',
	excursion: 'the FIRST observation strictly outside [VAL, VAH]; direction UP above VAH, DOWN below VAL',
	acceptance: 'a later observation back inside [VAL, VAH] after which price never leaves the area again through the session close — one untuned rule',
	precedence: 'NO_EXCURSION (NOT_APPLICABLE) → UNAVAILABLE tokens → EXCURSION_HELD → EXCURSION_REVISITED → FAILED_AUCTION',
	thresholds: 'only two coverage bounds (maxStartLagMinutes, closeCoverageMinutes); no acceptance tolerance, band, percentage or duration is tunable',
	refuses: [...FAILED_AUCTION_REFUSALS] as string[],
	missingData: 'no observations, no/refused/zero-width reference area, a tape that does not cover the open or the close ⇒ a null state with a closed-vocabulary token, never a fabricated auction result',
};

export interface SessionFailedAuction {
	sessionDate: string;
	instrument: string;
	status: FailedAuctionStatus;
	reason: FailedAuctionRefusal | null;
	reasonDetail: string | null;
	state: AuctionState | null;
	direction: 'UP' | 'DOWN' | null;
	evidence: {
		val: number | null;
		vah: number | null;
		priorSessionDate: string | null;
		observations: number | null;
		observationsOutside: number | null;
		firstExcursionAtMs: number | null;
		firstReturnInsideAtMs: number | null;
		lastObservationAtMs: number | null;
	};
}

export interface FailedAuctionReport {
	version: string;
	enabled: boolean;
	config: FailedAuctionConfig;
	spec: typeof FAILED_AUCTION_SPEC;
	upstreamProfileVersion: string;
	observations: SessionFailedAuction[];
	counts: Record<FailedAuctionStatus, number>;
	stateCounts: Record<AuctionState, number>;
	refusalCounts: Record<FailedAuctionRefusal, number>;
	coverage: { sessionsIn: number; profilesIn: number; ok: number; failed: number; held: number; revisited: number; notApplicable: number; unavailable: number; disabled: number };
	reviewerSummary: string;
	digest: string;
}

export const describeFailedAuction = (c: FailedAuctionConfig = DEFAULT_FAILED_AUCTION_CONFIG): string =>
	[
		`${FAILED_AUCTION_VERSION}: reports whether a session excursion outside the PRIOR session's value area was followed by acceptance back inside it.`,
		`The excursion is the first observation strictly outside [VAL, VAH]; acceptance is a later return inside after which price never leaves the area again through the close.`,
		`FAILED_AUCTION = excursion then acceptance; EXCURSION_HELD = excursion never returned inside; EXCURSION_REVISITED = returned inside but left again, so acceptance never held.`,
		`A session whose tape does not cover the open (within ${c.maxStartLagMinutes} min) or the close (within ${c.closeCoverageMinutes} min) is REFUSED rather than judged on a partial tape.`,
		`Missing or degenerate input yields a null state with one of ${FAILED_AUCTION_REFUSALS.join(' / ')}.`,
		`The only tunable values are the two coverage bounds; the acceptance rule itself has no tolerance, band or duration. enabled=${c.enabled}.`,
	].join(' ');

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

const bySession = (rows: AuctionSessionBar[]): AuctionSessionBar[] =>
	[...rows].sort((a, b) => {
		if (a.sessionDate !== b.sessionDate) return a.sessionDate < b.sessionDate ? -1 : 1;
		const ka = `${a.instrument}|${a.open}|${a.prevClose}`;
		const kb = `${b.instrument}|${b.open}|${b.prevClose}`;
		return ka < kb ? -1 : ka > kb ? 1 : 0;
	});

const emptyEvidence = (): SessionFailedAuction['evidence'] => ({
	val: null, vah: null, priorSessionDate: null, observations: null, observationsOutside: null,
	firstExcursionAtMs: null, firstReturnInsideAtMs: null, lastObservationAtMs: null,
});

const refused = (
	s: AuctionSessionBar,
	reason: FailedAuctionRefusal,
	detail: string,
	evidence: SessionFailedAuction['evidence'],
	status: FailedAuctionStatus = 'UNAVAILABLE',
): SessionFailedAuction => ({
	sessionDate: s.sessionDate, instrument: s.instrument, status, reason, reasonDetail: detail,
	state: null, direction: null, evidence,
});

function detectOne(s: AuctionSessionBar, path: ProfilePath | null, area: { val: number; vah: number; priorSessionDate: string } | null, cfg: FailedAuctionConfig): SessionFailedAuction {
	const ev = emptyEvidence();
	if (area) { ev.val = area.val; ev.vah = area.vah; ev.priorSessionDate = area.priorSessionDate; }

	const midnight = sessionMidnightMs(s.sessionDate);
	if (midnight === null) return refused(s, 'NO_SESSION_DATE', `"${s.sessionDate}" is not a usable session date`, ev);
	if (!area) return refused(s, 'NO_VALUE_AREA', 'no earlier session produced a usable value area, so there is no reference to excuse from', ev);
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
		return refused(s, 'LATE_START', `the first observation is ${((points[0].instantMs - openMs) / 60_000).toFixed(1)} min after the 09:15 open (bound ${cfg.maxStartLagMinutes}), so the excursion cannot be judged from the session start`, ev);
	}
	if (closeMs - points[points.length - 1].instantMs > cfg.closeCoverageMinutes * 60_000) {
		return refused(s, 'NO_SESSION_CLOSE_COVERAGE', `the tape ends ${((closeMs - points[points.length - 1].instantMs) / 60_000).toFixed(1)} min before the 15:30 close (bound ${cfg.closeCoverageMinutes}), so acceptance cannot be judged to the session end`, ev);
	}

	const isInside = (price: number): boolean => price >= area.val && price <= area.vah;
	const outside = points.filter((p) => !isInside(p.price));
	ev.observationsOutside = outside.length;
	if (!outside.length) {
		return refused(s, 'NO_EXCURSION', 'price never left the reference value area, so there is no excursion to fail', ev, 'NOT_APPLICABLE');
	}

	const firstExcursion = outside[0];
	const direction: 'UP' | 'DOWN' = firstExcursion.price > area.vah ? 'UP' : 'DOWN';
	ev.firstExcursionAtMs = firstExcursion.instantMs;

	const afterExcursion = points.filter((p) => p.instantMs > firstExcursion.instantMs);
	const firstReturn = afterExcursion.find((p) => isInside(p.price));
	const base = { sessionDate: s.sessionDate, instrument: s.instrument, direction, evidence: ev } as const;

	if (!firstReturn) {
		return { ...base, status: 'OK', reason: null, reasonDetail: null, state: 'EXCURSION_HELD' };
	}
	ev.firstReturnInsideAtMs = firstReturn.instantMs;

	// acceptance holds only if price never leaves the area again through the close
	const afterReturn = afterExcursion.filter((p) => p.instantMs > firstReturn.instantMs);
	const leftAgain = afterReturn.find((p) => !isInside(p.price));
	const state: AuctionState = leftAgain ? 'EXCURSION_REVISITED' : 'FAILED_AUCTION';
	return { ...base, status: 'OK', reason: null, reasonDetail: null, state };
}

/**
 * Detect failed auctions for every session of one instrument's series.
 * Consumes the row-60 value-profile REPORT and the same session paths; the reference area is the
 * PRIOR profiled session, matched by date.
 */
export function detectFailedAuctions(
	sessions: AuctionSessionBar[],
	profileReport: { version: string; profiles: Array<{ sessionDate: string; instrument: string; status: string; val: number | null; vah: number | null; reason: string | null }> },
	paths: ProfilePath[],
	config: Partial<FailedAuctionConfig> = {},
): FailedAuctionReport {
	const cfg: FailedAuctionConfig = { ...DEFAULT_FAILED_AUCTION_CONFIG, ...config };
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
		if (!cfg.enabled) return refused(s, 'NO_POINTS', 'the component is disabled; no state was computed for this input', emptyEvidence(), 'DISABLED');
		const list = areas.get(s.instrument) ?? [];
		let prior: { sessionDate: string; val: number; vah: number } | null = null;
		for (const a of list) if (a.sessionDate < s.sessionDate) prior = a;
		const area = prior ? { val: prior.val, vah: prior.vah, priorSessionDate: prior.sessionDate } : null;
		return detectOne(s, pathIndex.get(`${s.sessionDate}|${s.instrument}`) ?? null, area, cfg);
	});

	const counts: Record<FailedAuctionStatus, number> = { OK: 0, NOT_APPLICABLE: 0, UNAVAILABLE: 0, DISABLED: 0 };
	const stateCounts: Record<AuctionState, number> = { FAILED_AUCTION: 0, EXCURSION_HELD: 0, EXCURSION_REVISITED: 0 };
	const refusalCounts = Object.fromEntries(FAILED_AUCTION_REFUSALS.map((r) => [r, 0])) as Record<FailedAuctionRefusal, number>;
	for (const o of observations) {
		counts[o.status] += 1;
		if (o.state) stateCounts[o.state] += 1;
		if (o.reason) refusalCounts[o.reason] += 1;
	}

	return {
		version: FAILED_AUCTION_VERSION,
		enabled: cfg.enabled,
		config: cfg,
		spec: FAILED_AUCTION_SPEC,
		upstreamProfileVersion: profileReport.version,
		observations,
		counts,
		stateCounts,
		refusalCounts,
		coverage: {
			sessionsIn: ordered.length,
			profilesIn: profileReport.profiles.length,
			ok: counts.OK,
			failed: stateCounts.FAILED_AUCTION,
			held: stateCounts.EXCURSION_HELD,
			revisited: stateCounts.EXCURSION_REVISITED,
			notApplicable: counts.NOT_APPLICABLE,
			unavailable: counts.UNAVAILABLE,
			disabled: counts.DISABLED,
		},
		reviewerSummary: describeFailedAuction(cfg),
		digest: JSON.stringify(observations.map((o) => [o.sessionDate, o.instrument, o.status, o.state, o.reason, o.direction, o.evidence.firstExcursionAtMs, o.evidence.firstReturnInsideAtMs])),
	};
}
