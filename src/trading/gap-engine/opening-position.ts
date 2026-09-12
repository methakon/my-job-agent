/**
 * GATE 4 #5 (roadmap row 42) — OPENING POSITION RELATIVE TO THE PRIOR VALUE AREA.
 *
 * Single responsibility: say where a session's OPEN sits relative to the PRIOR session's value area
 * (the row-60 profile's VAL/VAH), as a labelled state plus a normalised position, and say so
 * explicitly when it cannot. PURE: no clock, no I/O, no DB, no network, no AI, no randomness.
 *
 * ── PINNED DEFINITION (units, window, edges) ───────────────────────────────────────────────
 *   pos        = (open − prior.VAL) / (prior.VAH − prior.VAL)      (value-area widths)
 *   state      = ABOVE_VALUE  when open > prior.VAH
 *                BELOW_VALUE  when open < prior.VAL
 *                INSIDE_VALUE otherwise (VAL <= open <= VAH)
 *   UNITS      pos is a dimensionless ratio in value-area widths: 0 = at VAL, 1 = at VAH,
 *              < 0 opened below the value area, > 1 opened above it. Prices are index points.
 *   WINDOW     the PRIOR session in the adapter-ordered series — the immediately preceding session
 *              that produced a value profile. No lookback, no averaging, no interpolation.
 *   LOOK-AHEAD none: the open and the PRIOR session's value area are both known before the session
 *              trades. The session's own high/low/close are never read.
 *
 * ── MISSING / DEGENERATE DATA → a safe explicit state ───────────────────────────────────────
 *   NO_SESSION_OPEN / NO_PRIOR_SESSION / PROFILE_UNAVAILABLE / ZERO_VALUE_AREA
 *   — each yields a null position with the token and a human detail. A position is never fabricated;
 *     PROFILE_UNAVAILABLE carries the value-profile refusal reason verbatim behind the token.
 *
 * RESEARCH / SHADOW ONLY: nothing in production imports this module (asserted by test). Versioned:
 * oppos-v1.
 */

import { SessionBar } from './gap-session-series';
import { ValueProfile, ValueProfileReport } from '../value-profile/value-profile';

export const OPENING_POSITION_VERSION = 'oppos-v1';

export type OpeningState = 'ABOVE_VALUE' | 'BELOW_VALUE' | 'INSIDE_VALUE';
export type OpeningStatus = 'OK' | 'UNAVAILABLE' | 'DISABLED';

/** Closed, published refusal vocabulary (declaration order is the canonical order). */
export const OPENING_POSITION_REFUSALS = [
	'NO_SESSION_OPEN',
	'NO_PRIOR_SESSION',
	'PROFILE_UNAVAILABLE',
	'ZERO_VALUE_AREA',
] as const;
export type OpeningPositionRefusal = (typeof OPENING_POSITION_REFUSALS)[number];

export const OPENING_POSITION_STATUSES: readonly OpeningStatus[] = ['OK', 'UNAVAILABLE', 'DISABLED'];
export const OPENING_STATES: readonly OpeningState[] = ['ABOVE_VALUE', 'INSIDE_VALUE', 'BELOW_VALUE'];

export interface OpeningPositionConfig {
	enabled: boolean;
}

export const DEFAULT_OPENING_POSITION_CONFIG: OpeningPositionConfig = { enabled: true };

export const OPENING_POSITION_SPEC = {
	feature: 'OpeningPosition',
	version: OPENING_POSITION_VERSION,
	question: "Where does a session's open sit relative to the PRIOR session's value area (VAL/VAH)?",
	formula: 'pos = (open − prior.VAL) / (prior.VAH − prior.VAL), with state ABOVE_VALUE / INSIDE_VALUE / BELOW_VALUE',
	units: 'pos is a dimensionless ratio in value-area widths (0 = VAL, 1 = VAH, <0 below the area, >1 above it); prices in index points',
	window: 'the immediately preceding session in the series that produced a value profile — no lookback, no averaging',
	lookAhead: 'none — the open and the prior value area are known before the session trades; the session own high/low/close are never read',
	refuses: [...OPENING_POSITION_REFUSALS] as string[],
	missingData:
		'NO_SESSION_OPEN (open absent/non-positive) / NO_PRIOR_SESSION (no earlier profiled session) / ' +
		'PROFILE_UNAVAILABLE (the value profile refused — its reason is propagated verbatim) / ' +
		'ZERO_VALUE_AREA (VAH == VAL, so the ratio is undefined) — each yields a null position, never a default',
};

export interface SessionOpeningPosition {
	sessionDate: string;
	instrument: string;
	status: OpeningStatus;
	reason: OpeningPositionRefusal | null;
	reasonDetail: string | null;
	state: OpeningState | null;
	/** Normalised position in value-area widths, or null in every non-OK state. */
	pos: number | null;
	priorSessionDate: string | null;
	evidence: { open: number | null; val: number | null; vah: number | null; priorBasis: string | null };
}

export interface OpeningPositionReport {
	version: string;
	enabled: boolean;
	config: OpeningPositionConfig;
	spec: typeof OPENING_POSITION_SPEC;
	/** The upstream value-profile version this run consumed (provenance is carried, never assumed). */
	upstreamProfileVersion: string;
	observations: SessionOpeningPosition[];
	counts: Record<OpeningStatus, number>;
	stateCounts: Record<OpeningState, number>;
	refusalCounts: Record<OpeningPositionRefusal, number>;
	coverage: { sessionsIn: number; profilesIn: number; ok: number; above: number; inside: number; below: number; unavailable: number; disabled: number };
	reviewerSummary: string;
	digest: string;
}

export const describeOpeningPosition = (c: OpeningPositionConfig = DEFAULT_OPENING_POSITION_CONFIG): string =>
	[
		`${OPENING_POSITION_VERSION}: places each session's OPEN against the PRIOR session's value area`,
		`as pos = (open − prior.VAL) / (prior.VAH − prior.VAL) — a dimensionless ratio in value-area widths`,
		`(0 = at VAL, 1 = at VAH, <0 opened below the value area, >1 opened above it), labelled ABOVE_VALUE / INSIDE_VALUE / BELOW_VALUE.`,
		`The prior session is the immediately preceding one that produced a value profile; there is no lookback and no averaging.`,
		`It reads only the open and the prior value area, so nothing after the open can influence it.`,
		`Missing or degenerate input yields UNAVAILABLE with one of ${OPENING_POSITION_REFUSALS.join(' / ')} and a null position.`,
		`enabled=${c.enabled}.`,
	].join(' ');

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

const bySession = (rows: SessionBar[]): SessionBar[] =>
	[...rows].sort((a, b) => {
		if (a.sessionDate !== b.sessionDate) return a.sessionDate < b.sessionDate ? -1 : 1;
		const ka = `${a.instrument}|${a.open}|${a.prevClose}`;
		const kb = `${b.instrument}|${b.open}|${b.prevClose}`;
		return ka < kb ? -1 : ka > kb ? 1 : 0;
	});

const refused = (
	s: SessionBar,
	reason: OpeningPositionRefusal,
	detail: string,
	extra: Partial<SessionOpeningPosition> = {},
): SessionOpeningPosition => ({
	sessionDate: s.sessionDate, instrument: s.instrument, status: 'UNAVAILABLE', reason, reasonDetail: detail,
	state: null, pos: null, priorSessionDate: null,
	evidence: { open: isNum(s.open) ? s.open : null, val: null, vah: null, priorBasis: null },
	...extra,
});

/**
 * Build the opening position for every session of one instrument's series.
 * Consumes the row-60 value-profile REPORT (not a bare array), so the upstream version/provenance is
 * carried through; the PRIOR profiled session is matched by date.
 */
export function buildOpeningPositions(
	sessions: SessionBar[],
	profileReport: ValueProfileReport,
	config: Partial<OpeningPositionConfig> = {},
): OpeningPositionReport {
	const cfg: OpeningPositionConfig = { ...DEFAULT_OPENING_POSITION_CONFIG, ...config };
	const ordered = bySession(sessions);

	// index the OK profiles per instrument, date-ordered, so "prior" is well defined
	const byInstrument = new Map<string, ValueProfile[]>();
	for (const p of profileReport.profiles) {
		if (!byInstrument.has(p.instrument)) byInstrument.set(p.instrument, []);
		byInstrument.get(p.instrument)!.push(p);
	}
	for (const list of byInstrument.values()) list.sort((a, b) => (a.sessionDate < b.sessionDate ? -1 : a.sessionDate > b.sessionDate ? 1 : 0));

	const observations: SessionOpeningPosition[] = ordered.map((s) => {
		if (!cfg.enabled) {
			return { ...refused(s, 'NO_SESSION_OPEN', 'the component is disabled; no position was computed for this input'), status: 'DISABLED', reason: null, reasonDetail: 'the component is disabled; no position was computed for this input' };
		}
		if (!isNum(s.open) || s.open <= 0) {
			return refused(s, 'NO_SESSION_OPEN', 'the session open is absent, non-finite or non-positive');
		}
		const list = byInstrument.get(s.instrument) ?? [];
		let prior: ValueProfile | null = null;
		for (const p of list) if (p.sessionDate < s.sessionDate) prior = p;
		if (!prior) {
			return refused(s, 'NO_PRIOR_SESSION', 'no earlier session produced a value profile for this instrument', { evidence: { open: s.open, val: null, vah: null, priorBasis: null } });
		}
		if (prior.status !== 'OK' || prior.val === null || prior.vah === null) {
			return refused(s, 'PROFILE_UNAVAILABLE', `the prior session's value profile is ${prior.status}${prior.reason ? ` (${prior.reason}: ${prior.reasonDetail})` : ''}`, {
				priorSessionDate: prior.sessionDate,
				evidence: { open: s.open, val: prior.val, vah: prior.vah, priorBasis: prior.basis },
			});
		}
		const width = prior.vah - prior.val;
		if (!(width > 0)) {
			return refused(s, 'ZERO_VALUE_AREA', `the prior value area is zero-width (VAL=${prior.val}, VAH=${prior.vah}), so the ratio is undefined`, {
				priorSessionDate: prior.sessionDate,
				evidence: { open: s.open, val: prior.val, vah: prior.vah, priorBasis: prior.basis },
			});
		}

		const pos = (s.open - prior.val) / width;
		const state: OpeningState = s.open > prior.vah ? 'ABOVE_VALUE' : s.open < prior.val ? 'BELOW_VALUE' : 'INSIDE_VALUE';
		return {
			sessionDate: s.sessionDate, instrument: s.instrument, status: 'OK', reason: null, reasonDetail: null,
			state, pos, priorSessionDate: prior.sessionDate,
			evidence: { open: s.open, val: prior.val, vah: prior.vah, priorBasis: prior.basis },
		};
	});

	const counts: Record<OpeningStatus, number> = { OK: 0, UNAVAILABLE: 0, DISABLED: 0 };
	const stateCounts: Record<OpeningState, number> = { ABOVE_VALUE: 0, INSIDE_VALUE: 0, BELOW_VALUE: 0 };
	const refusalCounts = Object.fromEntries(OPENING_POSITION_REFUSALS.map((r) => [r, 0])) as Record<OpeningPositionRefusal, number>;
	for (const o of observations) {
		counts[o.status] += 1;
		if (o.state) stateCounts[o.state] += 1;
		if (o.reason) refusalCounts[o.reason] += 1;
	}

	return {
		version: OPENING_POSITION_VERSION,
		enabled: cfg.enabled,
		config: cfg,
		spec: OPENING_POSITION_SPEC,
		upstreamProfileVersion: profileReport.version,
		observations,
		counts,
		stateCounts,
		refusalCounts,
		coverage: {
			sessionsIn: ordered.length,
			profilesIn: profileReport.profiles.length,
			ok: counts.OK,
			above: stateCounts.ABOVE_VALUE,
			inside: stateCounts.INSIDE_VALUE,
			below: stateCounts.BELOW_VALUE,
			unavailable: counts.UNAVAILABLE,
			disabled: counts.DISABLED,
		},
		reviewerSummary: describeOpeningPosition(cfg),
		digest: JSON.stringify(observations.map((o) => [o.sessionDate, o.instrument, o.status, o.state, o.reason, o.pos === null ? null : Number(o.pos.toFixed(6)), o.priorSessionDate])),
	};
}
