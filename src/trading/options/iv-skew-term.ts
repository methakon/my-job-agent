/**
 * GATE 7 #3 (roadmap row 69) — SKEW AND TERM-STRUCTURE SLOPE / CURVATURE.
 *
 * Single responsibility: from the row-67 IV surface, compute each slice's SKEW (the deterministic IV-vs-strike
 * slope) and, across expiries, the TERM-STRUCTURE slope (and curvature when a third expiry exists) — and give
 * a safe explicit state whenever the surface does not carry enough strikes or expiries. PURE: no clock, no
 * I/O, no DB, no network, no AI, no randomness. It CONSUMES the row-67 report rather than re-deriving a
 * surface (reuse, not duplication).
 *
 * ── PINNED DEFINITION (inputs, transformation, units, edges) ───────────────────────────────
 *   SKEW (per expiry slice) = the ordinary-least-squares slope of IV on STRIKE over the slice's usable points:
 *         skewPerPoint  = Σ(x−x̄)(y−ȳ) / Σ(x−x̄)²          (IV percent per 1 strike point)
 *         skewPer100    = 100 × skewPerPoint               (per 100 strike points, for readability)
 *       Deterministic and assumption-free: no ATM match, no wing selection, no percentile. A slice with fewer
 *       than 2 distinct strikes has no slope → INSUFFICIENT_STRIKES.
 *   TERM (per surface) = the expiries ordered ascending, each represented by its slice's MEDIAN IV (the same
 *       deterministic representative row 67 reports — never an interpolated ATM IV):
 *         slopePerDay   = (IV_far − IV_near) / (daysBetween)          (IV percent per calendar day)
 *         curvature     = standard second difference of the per-expiry medians over their day gaps
 *                        — reported only when THREE expiries exist, else null with INSUFFICIENT_EXPIRIES.
 *   UNITS: IV as published (annualised percent); skew percent per strike point; term percent per day.
 *   TIMESTAMPS/WINDOW: no clock is read; expiry dates are calendar dates and their gaps are plain arithmetic.
 *
 * ── MISSING / DEGENERATE DATA → a safe explicit state ───────────────────────────────────────
 *   NO_SURFACE (the row-67 surface is not OK for that underlying/session)
 *   INSUFFICIENT_STRIKES (< 2 distinct strikes in a slice ⇒ no skew)
 *   INSUFFICIENT_EXPIRIES (< 2 for the term slope, < 3 for curvature)
 *   ZERO_EXPIRY_GAP (two expiries share a date ⇒ no per-day rate is defined)
 *   — the unavailable value is null with its token; nothing is interpolated or fabricated.
 *
 * RESEARCH / SHADOW ONLY: nothing in production imports this module (asserted by test); no state is written
 * and no decision, order or risk path reads it. Versioned: ivskewterm-v1.
 */

import { IvSurfaceReport, IvExpirySlice } from './iv-surface';

export const IV_SKEW_TERM_VERSION = 'ivskewterm-v1';

export type IvSkewTermStatus = 'OK' | 'UNAVAILABLE' | 'DISABLED';
export const IV_SKEW_TERM_STATUSES: readonly IvSkewTermStatus[] = ['OK', 'UNAVAILABLE', 'DISABLED'];

/** Closed, published refusal vocabulary (declaration order is the canonical order). */
export const IV_SKEW_TERM_REFUSALS = ['NO_SURFACE', 'INSUFFICIENT_STRIKES', 'INSUFFICIENT_EXPIRIES', 'ZERO_EXPIRY_GAP'] as const;
export type IvSkewTermRefusal = (typeof IV_SKEW_TERM_REFUSALS)[number];

export interface IvSkewTermConfig {
	enabled: boolean;
}

export const DEFAULT_IV_SKEW_TERM_CONFIG: IvSkewTermConfig = { enabled: true };

export const IV_SKEW_TERM_SPEC = {
	feature: 'IvSkewTerm',
	version: IV_SKEW_TERM_VERSION,
	question: 'What is each expiry slice IV-vs-strike skew, and what is the term-structure slope/curvature?',
	input: 'the row-67 IvSurface report (consumed, not re-derived)',
	skew: 'OLS slope of IV on strike per slice: skewPerPoint = Σ(x−x̄)(y−ȳ)/Σ(x−x̄)²; skewPer100 = 100× that',
	term: 'per-expiry representative = the slice MEDIAN IV; slopePerDay = (IV_far − IV_near)/daysBetween; curvature = second difference when three expiries exist',
	units: 'IV annualised percent; skew percent per strike point; term percent per calendar day',
	timestamps: 'no clock read; expiry dates are calendar dates and gaps are plain arithmetic',
	thresholds: 'none — no ATM match, no wing selection, no percentile',
	refuses: [...IV_SKEW_TERM_REFUSALS] as string[],
	missingData: 'a non-OK surface, < 2 strikes in a slice, < 2 expiries for the slope (< 3 for curvature), or a zero expiry gap ⇒ a null value with a closed-vocabulary token',
};

export const describeIvSkewTerm = (c: IvSkewTermConfig = DEFAULT_IV_SKEW_TERM_CONFIG): string =>
	[
		`${IV_SKEW_TERM_VERSION}: per expiry slice, skew = the OLS slope of IV on strike (percent per strike point);`,
		`per surface, term slope = (median IV far − median IV near)/daysBetween and curvature = the second difference`,
		`when three expiries exist. No ATM match, no wing selection and no tuned threshold;`,
		`insufficient strikes/expiries or a zero expiry gap refuses with one of ${IV_SKEW_TERM_REFUSALS.join(' / ')}. enabled=${c.enabled}.`,
	].join(' ');

export interface SliceSkew {
	expiry: string;
	strikeCount: number;
	ivMedian: number;
	skewPerPoint: number | null;
	skewPer100: number | null;
	reason: IvSkewTermRefusal | null;
}

export interface SurfaceSkewTerm {
	underlying: string;
	sessionDate: string;
	status: IvSkewTermStatus;
	reason: IvSkewTermRefusal | null;
	reasonDetail: string | null;
	slices: SliceSkew[];
	term: { expiries: string[]; expiryCount: number; daysTotal: number | null; slopePerDay: number | null; curvature: number | null; reason: IvSkewTermRefusal | null };
}

export interface IvSkewTermReport {
	version: string;
	enabled: boolean;
	config: IvSkewTermConfig;
	spec: typeof IV_SKEW_TERM_SPEC;
	/** Carried from the surface report so a reviewer knows which surface version was consumed. */
	upstreamSurfaceVersion: string | null;
	surfaces: SurfaceSkewTerm[];
	counts: Record<IvSkewTermStatus, number>;
	refusalCounts: Record<IvSkewTermRefusal, number>;
	coverage: { surfacesIn: number; ok: number; unavailable: number; disabled: number; slicesWithSkew: number; slopes: number; curvatures: number };
	reviewerSummary: string;
	digest: string;
}

const round6 = (v: number): number => Number(v.toFixed(6));
const daysBetween = (a: string, b: string): number | null => {
	const ta = Date.parse(`${a}T00:00:00Z`);
	const tb = Date.parse(`${b}T00:00:00Z`);
	if (!Number.isFinite(ta) || !Number.isFinite(tb)) return null;
	return Math.round((tb - ta) / 86_400_000);
};

/** OLS slope of y (IV) on x (strike), or null when the x values do not vary. */
const olsSlope = (points: Array<{ strike: number; iv: number }>): number | null => {
	const n = points.length;
	if (n < 2) return null;
	const mx = points.reduce((a, p) => a + p.strike, 0) / n;
	const my = points.reduce((a, p) => a + p.iv, 0) / n;
	let num = 0;
	let den = 0;
	for (const p of points) {
		num += (p.strike - mx) * (p.iv - my);
		den += (p.strike - mx) * (p.strike - mx);
	}
	return den > 0 ? num / den : null;
};

export function evaluateIvSkewTerm(surface: IvSurfaceReport | null, config: Partial<IvSkewTermConfig> = {}): IvSkewTermReport {
	const cfg: IvSkewTermConfig = { ...DEFAULT_IV_SKEW_TERM_CONFIG, ...config };

	const surfaces: SurfaceSkewTerm[] = (surface?.surfaces ?? []).map((s) => {
		const emptyTerm = { expiries: [] as string[], expiryCount: 0, daysTotal: null, slopePerDay: null, curvature: null, reason: null as IvSkewTermRefusal | null };
		if (!cfg.enabled) return { underlying: s.underlying, sessionDate: s.sessionDate, status: 'DISABLED' as const, reason: null, reasonDetail: 'the component is disabled; no skew or term value was computed', slices: [], term: emptyTerm };
		if (s.status !== 'OK') return { underlying: s.underlying, sessionDate: s.sessionDate, status: 'UNAVAILABLE' as const, reason: 'NO_SURFACE' as const, reasonDetail: `the row-67 surface is ${s.status}${s.reason ? ` (${s.reason})` : ''}`, slices: [], term: emptyTerm };

		const slices: SliceSkew[] = s.slices.map((sl: IvExpirySlice) => {
			const slope = olsSlope(sl.points.map((p) => ({ strike: p.strike, iv: p.iv })));
			if (slope === null) return { expiry: sl.expiry, strikeCount: sl.strikeCount, ivMedian: sl.ivMedian, skewPerPoint: null, skewPer100: null, reason: 'INSUFFICIENT_STRIKES' as const };
			return { expiry: sl.expiry, strikeCount: sl.strikeCount, ivMedian: sl.ivMedian, skewPerPoint: round6(slope), skewPer100: round6(100 * slope), reason: null };
		});

		// term: the slices are already expiry-ordered in the surface report
		const expiries = s.slices.map((x) => x.expiry);
		const medians = s.slices.map((x) => x.ivMedian);
		const term: SurfaceSkewTerm['term'] = { expiries, expiryCount: expiries.length, daysTotal: null, slopePerDay: null, curvature: null, reason: null };
		if (expiries.length < 2) {
			term.reason = 'INSUFFICIENT_EXPIRIES';
		} else {
			const gaps: number[] = [];
			let ok = true;
			for (let i = 1; i < expiries.length; i += 1) {
				const d = daysBetween(expiries[i - 1], expiries[i]);
				if (d === null || d <= 0) { ok = false; break; }
				gaps.push(d);
			}
			if (!ok) {
				term.reason = 'ZERO_EXPIRY_GAP';
			} else {
				const totalDays = gaps.reduce((a, b) => a + b, 0);
				term.daysTotal = totalDays;
				term.slopePerDay = round6((medians[medians.length - 1] - medians[0]) / totalDays);
				if (expiries.length >= 3) {
					// second difference of the per-expiry medians across uneven gaps
					const seg = (i: number) => (medians[i] - medians[i - 1]) / gaps[i - 1];
					term.curvature = round6((seg(2) - seg(1)) / ((gaps[0] + gaps[1]) / 2));
				} else {
					term.reason = 'INSUFFICIENT_EXPIRIES'; // slope OK, curvature needs a third expiry
				}
			}
		}

		return { underlying: s.underlying, sessionDate: s.sessionDate, status: 'OK' as const, reason: null, reasonDetail: null, slices, term };
	});

	const counts: Record<IvSkewTermStatus, number> = { OK: 0, UNAVAILABLE: 0, DISABLED: 0 };
	const refusalCounts = Object.fromEntries(IV_SKEW_TERM_REFUSALS.map((r) => [r, 0])) as Record<IvSkewTermRefusal, number>;
	let slicesWithSkew = 0;
	let slopes = 0;
	let curvatures = 0;
	for (const s of surfaces) {
		counts[s.status] += 1;
		if (s.reason) refusalCounts[s.reason] += 1;
		slicesWithSkew += s.slices.filter((x) => x.skewPerPoint !== null).length;
		if (s.term.slopePerDay !== null) slopes += 1;
		if (s.term.curvature !== null) curvatures += 1;
	}

	return {
		version: IV_SKEW_TERM_VERSION,
		enabled: cfg.enabled,
		config: cfg,
		spec: IV_SKEW_TERM_SPEC,
		upstreamSurfaceVersion: surface?.version ?? null,
		surfaces,
		counts,
		refusalCounts,
		coverage: { surfacesIn: (surface?.surfaces ?? []).length, ok: counts.OK, unavailable: counts.UNAVAILABLE, disabled: counts.DISABLED, slicesWithSkew, slopes, curvatures },
		reviewerSummary: describeIvSkewTerm(cfg),
		digest: JSON.stringify(surfaces.map((s) => [s.underlying, s.sessionDate, s.status, s.reason, s.slices.map((x) => [x.expiry, x.skewPer100]), s.term.slopePerDay, s.term.curvature, s.term.reason])),
	};
}
