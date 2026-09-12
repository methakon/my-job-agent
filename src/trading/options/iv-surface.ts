/**
 * GATE 7 #2 (roadmap row 67) — IV SURFACE FEATURES ACROSS STRIKE AND EXPIRY.
 *
 * Single responsibility: assemble the archived option chain's implied vols into an explicit, versioned SURFACE
 * per (underlying, session) — one slice per expiry, each slice a deterministic strike-ordered set of IV points
 * with its own summary — and state the coverage it actually has. PURE: no clock, no I/O, no DB, no network, no
 * AI, no randomness.
 *
 * ── PINNED DEFINITION (inputs, output schema, timestamps, edges) ───────────────────────────
 *   point  = { underlying, sessionDate, expiry, strike, optionType, iv } — the caller supplies them.
 *   USABLE IV = finite and > 0; a 0/negative IV is EXCLUDED and counted (`excludedIv`), never treated as a
 *   real vol. Points with a non-finite strike are excluded and counted as `excludedStrike`.
 *   SLICE (per expiry) = the usable points for that expiry, ordered by strike then optionType (CE before PE),
 *   with strikeLow/strikeHigh, ivMin/ivMax/ivMedian, callCount/putCount and `sufficient`
 *   (distinct strikes >= minStrikesPerExpiry — a STRUCTURAL coverage bound, not a tuned threshold).
 *   SURFACE (per underlying+session) = the slices ordered by expiry, plus `expiryCount`, `termAvailable`
 *   (expiryCount >= 2 — whether a term dimension exists at all), total `strikeCoverage`, and the pooled
 *   ivMin/ivMax/ivMedian over every usable point.
 *   UNITS: IV as the chain publishes it (annualised percent); strikes in index points; counts are integers.
 *   TIMESTAMPS: this module reads no clock. The caller attaches `sessionDate`; a point with an unusable
 *   session date is refused rather than filed under a guessed one.
 *
 * ── MISSING / DEGENERATE DATA → a safe explicit state ───────────────────────────────────────
 *   NO_IVS (no usable IV for the underlying/session) / NO_SESSION_DATE (a point without a usable YYYY-MM-DD)
 *   — status UNAVAILABLE with an empty surface; a slice is never padded and a missing expiry is never
 *   interpolated.
 *
 * RESEARCH / SHADOW ONLY: nothing in production imports this module (asserted by test); no state is written
 * and no decision, order or risk path reads it. Versioned: ivsurface-v1.
 */

export const IV_SURFACE_VERSION = 'ivsurface-v1';

export type IvSurfaceStatus = 'OK' | 'UNAVAILABLE' | 'DISABLED';
export const IV_SURFACE_STATUSES: readonly IvSurfaceStatus[] = ['OK', 'UNAVAILABLE', 'DISABLED'];

/** Closed, published refusal vocabulary (declaration order is the canonical order). */
export const IV_SURFACE_REFUSALS = ['NO_IVS', 'NO_SESSION_DATE'] as const;
export type IvSurfaceRefusal = (typeof IV_SURFACE_REFUSALS)[number];

export interface IvSurfacePoint {
	underlying: string;
	sessionDate: string;
	expiry: string;
	strike: number | null;
	optionType: string | null;
	/** Annualised implied volatility as the chain publishes it (percent). */
	iv: number | null;
	/** Provenance, echoed (never used to compute). */
	source?: string | null;
	sourceTimestamp?: Date | string | null;
}

export interface IvSurfaceConfig {
	enabled: boolean;
	/** Structural coverage bound: distinct strikes a slice needs before it is called `sufficient`. */
	minStrikesPerExpiry: number;
}

export const DEFAULT_IV_SURFACE_CONFIG: IvSurfaceConfig = { enabled: true, minStrikesPerExpiry: 3 };

export const IV_SURFACE_SPEC = {
	feature: 'IvSurface',
	version: IV_SURFACE_VERSION,
	question: 'What does the option-IV surface look like across strikes and expiries for one underlying and session?',
	input: '{underlying, sessionDate, expiry, strike, optionType, iv} points supplied by the caller',
	output: 'one slice per expiry (strike-ordered IV points + min/max/median/counts + a coverage flag) and one surface per underlying+session (slices, expiryCount, termAvailable, strikeCoverage, pooled summary)',
	units: 'IV as published (annualised percent); strikes in index points; counts are integers',
	timestamps: 'the caller attaches sessionDate; no clock is read and a point without a usable date is refused',
	thresholds: 'none — minStrikesPerExpiry is a structural coverage bound, not a fitted threshold',
	refuses: [...IV_SURFACE_REFUSALS] as string[],
	missingData: 'no usable IV for the underlying/session, or a point with no usable session date ⇒ an empty surface with a closed-vocabulary token; a slice is never padded or interpolated',
};

export const describeIvSurface = (c: IvSurfaceConfig = DEFAULT_IV_SURFACE_CONFIG): string =>
	[
		`${IV_SURFACE_VERSION}: builds an IV surface per underlying+session — one strike-ordered slice per expiry`,
		`with min/max/median IV and counts, plus expiryCount/termAvailable/strikeCoverage for the surface.`,
		`A slice is 'sufficient' when it has >= ${c.minStrikesPerExpiry} distinct strikes (a coverage bound, not a threshold).`,
		`Usable IV is finite and > 0; 0/negative IVs and non-finite strikes are excluded and counted.`,
		`Missing input refuses with one of ${IV_SURFACE_REFUSALS.join(' / ')}. enabled=${c.enabled}.`,
	].join(' ');

export interface IvSlicePoint {
	strike: number;
	optionType: string | null;
	iv: number;
}

export interface IvExpirySlice {
	expiry: string;
	points: IvSlicePoint[];
	strikeCount: number;
	strikeLow: number;
	strikeHigh: number;
	ivMin: number;
	ivMax: number;
	ivMedian: number;
	callCount: number;
	putCount: number;
	/** distinct strikes >= minStrikesPerExpiry */
	sufficient: boolean;
}

export interface UnderlyingSurface {
	underlying: string;
	sessionDate: string;
	status: IvSurfaceStatus;
	reason: IvSurfaceRefusal | null;
	reasonDetail: string | null;
	slices: IvExpirySlice[];
	expiryCount: number;
	/** expiryCount >= 2: whether the surface has a term dimension at all. */
	termAvailable: boolean;
	strikeCoverage: number;
	ivMin: number | null;
	ivMax: number | null;
	ivMedian: number | null;
	excludedIv: number;
	excludedStrike: number;
	pointsIn: number;
}

export interface IvSurfaceReport {
	version: string;
	enabled: boolean;
	config: IvSurfaceConfig;
	spec: typeof IV_SURFACE_SPEC;
	surfaces: UnderlyingSurface[];
	counts: Record<IvSurfaceStatus, number>;
	refusalCounts: Record<IvSurfaceRefusal, number>;
	coverage: { pointsIn: number; surfaces: number; ok: number; unavailable: number; disabled: number; slices: number; withTerm: number; excludedIv: number; excludedStrike: number };
	reviewerSummary: string;
	digest: string;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const round6 = (v: number): number => Number(v.toFixed(6));
const median = (xs: number[]): number => {
	const s = [...xs].sort((a, b) => a - b);
	const m = Math.floor(s.length / 2);
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export function evaluateIvSurface(points: IvSurfacePoint[], config: Partial<IvSurfaceConfig> = {}): IvSurfaceReport {
	const cfg: IvSurfaceConfig = { ...DEFAULT_IV_SURFACE_CONFIG, ...config };

	const groups = new Map<string, IvSurfacePoint[]>();
	for (const p of points ?? []) {
		const k = `${String(p?.underlying ?? '').trim()}|${String(p?.sessionDate ?? '')}`;
		if (!groups.has(k)) groups.set(k, []);
		groups.get(k)!.push(p);
	}

	const surfaces: UnderlyingSurface[] = [...groups.keys()].sort().map((key) => {
		const [underlying, sessionDate] = key.split('|');
		const rows = groups.get(key)!;
		const empty = { slices: [] as IvExpirySlice[], expiryCount: 0, termAvailable: false, strikeCoverage: 0, ivMin: null, ivMax: null, ivMedian: null, excludedIv: 0, excludedStrike: 0, pointsIn: rows.length };
		if (!cfg.enabled) return { underlying, sessionDate, status: 'DISABLED' as const, reason: null, reasonDetail: 'the component is disabled; no surface was computed for this underlying/session', ...empty };
		if (!/^\d{4}-\d{2}-\d{2}$/.test(sessionDate)) return { underlying, sessionDate, status: 'UNAVAILABLE' as const, reason: 'NO_SESSION_DATE' as const, reasonDetail: `"${sessionDate}" is not a usable YYYY-MM-DD session date`, ...empty };

		let excludedIv = 0;
		let excludedStrike = 0;
		const byExpiry = new Map<string, IvSlicePoint[]>();
		for (const p of rows) {
			if (!isNum(p.iv) || (p.iv as number) <= 0) { excludedIv += 1; continue; }
			if (!isNum(p.strike)) { excludedStrike += 1; continue; }
			const expiry = String(p.expiry ?? '');
			if (!expiry) { excludedStrike += 1; continue; }
			if (!byExpiry.has(expiry)) byExpiry.set(expiry, []);
			byExpiry.get(expiry)!.push({ strike: p.strike as number, optionType: p.optionType ? String(p.optionType).toUpperCase().slice(0, 2) : null, iv: p.iv as number });
		}

		const usable = [...byExpiry.values()].reduce((a, l) => a + l.length, 0);
		if (!usable) return { underlying, sessionDate, status: 'UNAVAILABLE' as const, reason: 'NO_IVS' as const, reasonDetail: `no usable IV for ${underlying} on ${sessionDate} (${excludedIv} non-positive/absent, ${excludedStrike} without a strike)`, ...empty, excludedIv, excludedStrike };

		const slices: IvExpirySlice[] = [...byExpiry.keys()].sort().map((expiry) => {
			const pts = byExpiry.get(expiry)!.sort((a, b) => (a.strike !== b.strike ? a.strike - b.strike : (a.optionType ?? '') < (b.optionType ?? '') ? -1 : (a.optionType ?? '') > (b.optionType ?? '') ? 1 : 0));
			const ivs = pts.map((p) => p.iv);
			const strikes = [...new Set(pts.map((p) => p.strike))].sort((a, b) => a - b);
			return {
				expiry,
				points: pts,
				strikeCount: strikes.length,
				strikeLow: strikes[0],
				strikeHigh: strikes[strikes.length - 1],
				ivMin: round6(Math.min(...ivs)),
				ivMax: round6(Math.max(...ivs)),
				ivMedian: round6(median(ivs)),
				callCount: pts.filter((p) => p.optionType === 'CE').length,
				putCount: pts.filter((p) => p.optionType === 'PE').length,
				sufficient: strikes.length >= cfg.minStrikesPerExpiry,
			};
		});

		const allIvs = slices.flatMap((s) => s.points.map((p) => p.iv));
		const allStrikes = [...new Set(slices.flatMap((s) => s.points.map((p) => p.strike)))];
		return {
			underlying,
			sessionDate,
			status: 'OK' as const,
			reason: null,
			reasonDetail: null,
			slices,
			expiryCount: slices.length,
			termAvailable: slices.length >= 2,
			strikeCoverage: allStrikes.length,
			ivMin: round6(Math.min(...allIvs)),
			ivMax: round6(Math.max(...allIvs)),
			ivMedian: round6(median(allIvs)),
			excludedIv,
			excludedStrike,
			pointsIn: rows.length,
		};
	});

	const counts: Record<IvSurfaceStatus, number> = { OK: 0, UNAVAILABLE: 0, DISABLED: 0 };
	const refusalCounts = Object.fromEntries(IV_SURFACE_REFUSALS.map((r) => [r, 0])) as Record<IvSurfaceRefusal, number>;
	let slices = 0;
	let withTerm = 0;
	for (const s of surfaces) {
		counts[s.status] += 1;
		if (s.reason) refusalCounts[s.reason] += 1;
		slices += s.slices.length;
		if (s.termAvailable) withTerm += 1;
	}

	return {
		version: IV_SURFACE_VERSION,
		enabled: cfg.enabled,
		config: cfg,
		spec: IV_SURFACE_SPEC,
		surfaces,
		counts,
		refusalCounts,
		coverage: {
			pointsIn: (points ?? []).length,
			surfaces: surfaces.length,
			ok: counts.OK,
			unavailable: counts.UNAVAILABLE,
			disabled: counts.DISABLED,
			slices,
			withTerm,
			excludedIv: surfaces.reduce((a, s) => a + s.excludedIv, 0),
			excludedStrike: surfaces.reduce((a, s) => a + s.excludedStrike, 0),
		},
		reviewerSummary: describeIvSurface(cfg),
		digest: JSON.stringify(surfaces.map((s) => [s.underlying, s.sessionDate, s.status, s.reason, s.expiryCount, s.termAvailable, s.strikeCoverage, s.ivMedian, s.slices.map((x) => [x.expiry, x.strikeCount, x.ivMedian])])),
	};
}
