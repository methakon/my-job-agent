/**
 * GATE 7 #1 (roadmap row 66) — IV-RV AND IV-VERSUS-FORECAST-VOLATILITY.
 *
 * Single responsibility: for each underlying, compare the chain's implied volatility (an annualised level)
 * with the realised volatility of its price tape (annualised from actual timestamps), and say so explicitly
 * when either side is missing. PURE: no clock, no I/O, no DB, no network, no AI, no randomness.
 *
 * ── PINNED DEFINITION (inputs, transformation, units, window, edges) ───────────────────────
 *   IV REFERENCE (per underlying): the MEDIAN of the chain's usable implied vols — robust, and it needs no
 *   ATM identification (no strike-to-spot matching is invented). Usable = finite and > 0; a 0/negative IV is
 *   EXCLUDED and counted (`excludedIv`), never treated as a real vol. Min/max/count are reported alongside.
 *   RV: the ANNUALISED realised volatility of the supplied price tape:
 *         r_i = ln(p_i / p_{i−1})                 (only observations with a finite price > 0)
 *         realisedVariance = Σ r_i²
 *         rvAnnualised = sqrt(realisedVariance × secondsPerYear / elapsedSeconds)
 *       `secondsPerYear` is a CALENDAR constant (default 31,536,000 = 365 d), not a fitted parameter;
 *       `elapsedSeconds` comes from the supplied timestamps, so the estimator needs no cadence assumption.
 *   COMPARISON: ivFraction = ivReference / 100 (the chain publishes IV as an annualised PERCENT);
 *         ivMinusRv = ivFraction − rvAnnualised;  ivToRvRatio = ivFraction / rvAnnualised.
 *   UNITS: both sides are annualised fractional volatility (dimensionless); differences/ratios as above.
 *   WINDOW: the caller supplies the tape; this module reads no clock and imposes no window of its own. If it
 *   is ever used at decision time the caller must pass a PRIOR tape — the transformation itself is
 *   point-in-time given its inputs.
 *
 * ── MISSING / DEGENERATE DATA → a safe explicit state ───────────────────────────────────────
 *   NO_IV (no usable IV for the underlying) / NO_PRICES (no usable price) / INSUFFICIENT_PRICES (fewer than
 *   minPrices observations) / ZERO_ELAPSED (all timestamps equal ⇒ no elapsed time) — each yields null
 *   values with a closed-vocabulary token; nothing is interpolated or fabricated.
 *
 * RESEARCH / SHADOW ONLY: nothing in production imports this module (asserted by test); no state is written
 * and no decision, order or risk path reads it. Versioned: ivrv-v1.
 */

export const IV_RV_VERSION = 'ivrv-v1';

export type IvRvStatus = 'OK' | 'UNAVAILABLE' | 'DISABLED';
export const IV_RV_STATUSES: readonly IvRvStatus[] = ['OK', 'UNAVAILABLE', 'DISABLED'];

/** Closed, published refusal vocabulary (declaration order is the canonical order). */
export const IV_RV_REFUSALS = ['NO_IV', 'NO_PRICES', 'INSUFFICIENT_PRICES', 'ZERO_ELAPSED'] as const;
export type IvRvRefusal = (typeof IV_RV_REFUSALS)[number];

export interface IvObservation {
	underlying: string;
	/** Provenance, echoed through (never used to compute). */
	instrumentKey?: string | null;
	expiry?: string | null;
	optionType?: string | null;
	strike?: number | null;
	source?: string | null;
	sourceTimestamp?: Date | string | null;
	/** Annualised implied volatility, as the chain publishes it (percent, e.g. 12.68). */
	iv: number | null;
}

export interface PriceObservation {
	underlying: string;
	/** Absolute instant, epoch ms (the caller converts its own wall clock once, with an explicit offset). */
	instantMs: number | null;
	price: number | null;
	source?: string | null;
}

export interface IvRvConfig {
	enabled: boolean;
	/** Minimum usable price observations before an RV is reported. */
	minPrices: number;
	/** Calendar seconds per year used to annualise the realised variance (365 d). */
	secondsPerYear: number;
}

export const DEFAULT_IV_RV_CONFIG: IvRvConfig = { enabled: true, minPrices: 10, secondsPerYear: 31_536_000 };

export const IV_RV_SPEC = {
	feature: 'IvRv',
	version: IV_RV_VERSION,
	question: 'For each underlying, how does the chain implied volatility compare with the realised volatility of its tape?',
	ivReference: 'the MEDIAN of the usable chain IVs (finite and > 0); 0/negative IVs are excluded and counted; min/max/count reported',
	rv: 'rvAnnualised = sqrt( Σ ln(p_i/p_{i−1})² × secondsPerYear / elapsedSeconds ) over the supplied tape',
	units: 'both sides annualised fractional volatility; IV input is an annualised PERCENT (divided by 100)',
	window: 'the caller supplies the tape; the module reads no clock. For a decision-time use the caller must pass a PRIOR tape',
	thresholds: 'none — only the calendar constant secondsPerYear and the structural minPrices bound',
	refuses: [...IV_RV_REFUSALS] as string[],
	missingData: 'no usable IV, no usable price, too few prices or zero elapsed time ⇒ null values with a closed-vocabulary token',
};

export const describeIvRv = (c: IvRvConfig = DEFAULT_IV_RV_CONFIG): string =>
	[
		`${IV_RV_VERSION}: per underlying, IV reference = MEDIAN of the usable chain IVs (0/negative excluded) and`,
		`rvAnnualised = sqrt(Σ ln(p_i/p_{i−1})² × ${c.secondsPerYear} / elapsedSeconds) over the supplied tape.`,
		`Both sides are annualised fractional volatility; IV is divided by 100.`,
		`At least ${c.minPrices} usable prices and a non-zero elapsed time are required, and no threshold is tuned.`,
		`Missing input refuses with one of ${IV_RV_REFUSALS.join(' / ')}. enabled=${c.enabled}.`,
	].join(' ');

export interface IvSummary {
	ivReference: number | null;
	ivMin: number | null;
	ivMax: number | null;
	ivCount: number;
	excludedIv: number;
}

export interface IvRvValues {
	/** Annualised fractional IV (median/100). */
	ivFraction: number;
	/** Annualised fractional realised volatility. */
	rvAnnualised: number;
	ivMinusRv: number;
	ivToRvRatio: number;
}

export interface UnderlyingIvRv {
	underlying: string;
	status: IvRvStatus;
	reason: IvRvRefusal | null;
	reasonDetail: string | null;
	iv: IvSummary;
	prices: { count: number; usedPrices: number; firstInstantMs: number | null; lastInstantMs: number | null; elapsedSeconds: number | null };
	values: IvRvValues | null;
}

export interface IvRvReport {
	version: string;
	enabled: boolean;
	config: IvRvConfig;
	spec: typeof IV_RV_SPEC;
	observations: UnderlyingIvRv[];
	counts: Record<IvRvStatus, number>;
	refusalCounts: Record<IvRvRefusal, number>;
	coverage: { underlyingsIn: number; ok: number; unavailable: number; disabled: number; ivObservations: number; priceObservations: number; excludedIv: number };
	reviewerSummary: string;
	digest: string;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const round6 = (v: number): number => Number(v.toFixed(6));

/** Median of a non-empty numeric array (even count ⇒ mean of the two middle values). Deterministic. */
const median = (xs: number[]): number => {
	const s = [...xs].sort((a, b) => a - b);
	const m = Math.floor(s.length / 2);
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export function evaluateIvRv(ivs: IvObservation[], prices: PriceObservation[], config: Partial<IvRvConfig> = {}): IvRvReport {
	const cfg: IvRvConfig = { ...DEFAULT_IV_RV_CONFIG, ...config };

	const byUnderlying = new Map<string, { ivs: IvObservation[]; prices: PriceObservation[] }>();
	const bucket = (underlying: string) => {
		const k = String(underlying ?? '').trim();
		if (!k) return null;
		if (!byUnderlying.has(k)) byUnderlying.set(k, { ivs: [], prices: [] });
		return byUnderlying.get(k)!;
	};
	for (const o of ivs ?? []) { const b = bucket(o?.underlying); if (b) b.ivs.push(o); }
	for (const p of prices ?? []) { const b = bucket(p?.underlying); if (b) b.prices.push(p); }

	const observations: UnderlyingIvRv[] = [...byUnderlying.keys()].sort().map((underlying) => {
		const b = byUnderlying.get(underlying)!;
		const usableIv = b.ivs.map((o) => (isNum(o.iv) ? (o.iv as number) : null)).filter((v): v is number => v !== null && v > 0);
		const excludedIv = b.ivs.length - usableIv.length;
		const iv: IvSummary = usableIv.length
			? { ivReference: round6(median(usableIv)), ivMin: round6(Math.min(...usableIv)), ivMax: round6(Math.max(...usableIv)), ivCount: usableIv.length, excludedIv }
			: { ivReference: null, ivMin: null, ivMax: null, ivCount: 0, excludedIv };

		const usablePrices = b.prices
			.filter((p) => isNum(p.instantMs) && isNum(p.price) && (p.price as number) > 0)
			.sort((x, y) => (x.instantMs as number) - (y.instantMs as number));
		const firstInstantMs = usablePrices.length ? (usablePrices[0].instantMs as number) : null;
		const lastInstantMs = usablePrices.length ? (usablePrices[usablePrices.length - 1].instantMs as number) : null;
		const elapsedSeconds = firstInstantMs !== null && lastInstantMs !== null ? (lastInstantMs - firstInstantMs) / 1000 : null;
		const pricesMeta = { count: b.prices.length, usedPrices: usablePrices.length, firstInstantMs, lastInstantMs, elapsedSeconds };

		const no = (reason: IvRvRefusal, detail: string): UnderlyingIvRv => ({ underlying, status: 'UNAVAILABLE', reason, reasonDetail: detail, iv, prices: pricesMeta, values: null });
		if (!cfg.enabled) return { underlying, status: 'DISABLED', reason: null, reasonDetail: 'the component is disabled; no comparison was computed for this underlying', iv, prices: pricesMeta, values: null };
		if (!iv.ivCount) return no('NO_IV', `no usable implied volatility for ${underlying} (${excludedIv} of ${b.ivs.length} excluded as non-positive/absent)`);
		if (!usablePrices.length) return no('NO_PRICES', `no usable price observation for ${underlying}`);
		if (usablePrices.length < cfg.minPrices) return no('INSUFFICIENT_PRICES', `${usablePrices.length} usable price(s) for ${underlying} (need >= ${cfg.minPrices})`);
		if (!(elapsedSeconds && elapsedSeconds > 0)) return no('ZERO_ELAPSED', `the price tape for ${underlying} spans no elapsed time, so no rate is defined`);

		let sumSq = 0;
		for (let i = 1; i < usablePrices.length; i += 1) {
			const r = Math.log((usablePrices[i].price as number) / (usablePrices[i - 1].price as number));
			sumSq += r * r;
		}
		const rvAnnualised = Math.sqrt(sumSq * (cfg.secondsPerYear / elapsedSeconds));
		const ivFraction = (iv.ivReference as number) / 100;
		return {
			underlying,
			status: 'OK',
			reason: null,
			reasonDetail: null,
			iv,
			prices: pricesMeta,
			values: { ivFraction: round6(ivFraction), rvAnnualised: round6(rvAnnualised), ivMinusRv: round6(ivFraction - rvAnnualised), ivToRvRatio: round6(rvAnnualised > 0 ? ivFraction / rvAnnualised : 0) },
		};
	});

	const counts: Record<IvRvStatus, number> = { OK: 0, UNAVAILABLE: 0, DISABLED: 0 };
	const refusalCounts = Object.fromEntries(IV_RV_REFUSALS.map((r) => [r, 0])) as Record<IvRvRefusal, number>;
	let excludedIvTotal = 0;
	for (const o of observations) {
		counts[o.status] += 1;
		if (o.reason) refusalCounts[o.reason] += 1;
		excludedIvTotal += o.iv.excludedIv;
	}

	return {
		version: IV_RV_VERSION,
		enabled: cfg.enabled,
		config: cfg,
		spec: IV_RV_SPEC,
		observations,
		counts,
		refusalCounts,
		coverage: {
			underlyingsIn: observations.length,
			ok: counts.OK,
			unavailable: counts.UNAVAILABLE,
			disabled: counts.DISABLED,
			ivObservations: (ivs ?? []).length,
			priceObservations: (prices ?? []).length,
			excludedIv: excludedIvTotal,
		},
		reviewerSummary: describeIvRv(cfg),
		digest: JSON.stringify(observations.map((o) => [o.underlying, o.status, o.reason, o.iv.ivReference, o.values ? o.values.rvAnnualised : null, o.values ? o.values.ivMinusRv : null])),
	};
}
