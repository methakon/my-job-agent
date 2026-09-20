/**
 * GATE 5 #4 (roadmap row 53) — MICROPRICE AND QUEUE-IMBALANCE FEATURES.
 *
 * Single responsibility: turn ONE L1 quote (best bid/ask + their sizes) into the size-weighted microprice and
 * the queue imbalance, plus the mid/spread context they sit between — deterministically, with the quote's
 * provenance echoed through, and with a safe explicit state when the quote cannot support the calculation.
 * PURE: no clock, no I/O, no DB, no network, no AI, no randomness. Every input is an argument.
 *
 * ── PINNED DEFINITION (formula, units, window, edges) ──────────────────────────────────────
 *   mid             = (bid + ask) / 2
 *   spread          = ask − bid                      (index points; relative = spread / mid)
 *   queueImbalance  = (bidQty − askQty) / (bidQty + askQty)          ∈ [−1, +1]
 *   microprice      = (bid × askQty + ask × bidQty) / (bidQty + askQty)
 *                     — the size-weighted top of book: it leans toward the side with LESS size (the side that
 *                       must move first), so microprice > mid when askQty > bidQty.
 *   micropriceOffsetPoints   = microprice − mid
 *   micropriceOffsetFraction = (microprice − mid) / mid              (dimensionless, sign = direction)
 *
 *   WINDOW: the features are a function of ONE observation ONLY. There is no lookback, no rolling window and
 *   no smoothing here, so nothing after the quote can influence it (no look-ahead by construction).
 *   UNITS: prices in index points; sizes in contracts (shares/lots as the provider reports them, echoed
 *   verbatim); queueImbalance and the offset fraction dimensionless.
 *
 * ── MISSING / DEGENERATE DATA → a safe explicit state ───────────────────────────────────────
 *   INVALID_QUOTE      bid or ask absent, non-finite or <= 0 (a 0 placeholder is NOT a price)
 *   CROSSED_BOOK       bid > ask (bid == ask is a valid zero spread)
 *   NO_SIZES           either size is absent — the FYERS quote case: bid/ask arrive without sizes
 *   NEGATIVE_SIZE      a size is negative
 *   ZERO_SIZE          both sizes are 0, so the weights sum to 0 (microprice undefined)
 *   NOT_A_NUMBER       a supplied size is non-finite
 *   NO_QUOTES          the observation itself is absent
 *   — each yields null values with a closed-vocabulary token and a human detail; never 0/NaN/Infinity and
 *     never a fabricated imbalance.
 *
 * RESEARCH / SHADOW ONLY: nothing in production imports this module (asserted by test); no state is written
 * and no decision, order or risk path reads it. Versioned: microimb-v1.
 */

/**
 * ── DISCLAIMER ─────────────────────────────────────────────────────────────────
 * ABSORPTION / STACKED IMBALANCE AS HYPOTHESIS, NOT PROOF.
 *
 * Strong queue imbalance or microprice offset are HYPOTHESSES about directional
 * pressure — they are NOT proof of directional intent. A large bid-side stack
 * may be a market-maker hedging, an algo layering, or a stale order that will
 * be pulled. Stacked imbalance shows WHERE size sits, not WHY it sits there.
 *
 * Do not use queue imbalance or microprice offset as standalone entry signals.
 * They must be combined with other evidence (trade flow, event context, regime)
 * and treated as probabilistic hints, not deterministic triggers.
 * ───────────────────────────────────────────────────────────────────────────────
 */

export const MICRO_IMBALANCE_VERSION = 'microimb-v1';

export type MicroStatus = 'OK' | 'UNAVAILABLE' | 'DISABLED';
export const MICRO_STATUSES: readonly MicroStatus[] = ['OK', 'UNAVAILABLE', 'DISABLED'];

/** Closed, published refusal vocabulary (declaration order is the canonical order). */
export const MICRO_REFUSALS = [
	'NO_QUOTES',
	'INVALID_QUOTE',
	'CROSSED_BOOK',
	'NO_SIZES',
	'NEGATIVE_SIZE',
	'ZERO_SIZE',
	'NOT_A_NUMBER',
] as const;
export type MicroRefusal = (typeof MICRO_REFUSALS)[number];

/**
 * What kind of observation this is. Recorded, never assumed: an event-stream tick and a periodic REST
 * snapshot are different evidence, and a GATE 5 feature must not present one as the other.
 */
export type QuoteBasis = 'EVENT' | 'SNAPSHOT' | 'UNKNOWN';
export const QUOTE_BASES: readonly QuoteBasis[] = ['EVENT', 'SNAPSHOT', 'UNKNOWN'];

export interface MicroQuote {
	instrumentKey: string;
	source: string;
	bid: number | null;
	ask: number | null;
	bidQty: number | null;
	askQty: number | null;
	/** Provenance, echoed through unchanged (never used to compute). */
	sourceTimestamp?: Date | string | null;
	receivedTimestamp?: Date | string | null;
	sequenceNumber?: number | null;
	payloadHash?: string | null;
	dataQuality?: string | null;
	basis?: QuoteBasis;
}

export interface MicroImbalanceConfig {
	enabled: boolean;
}

export const DEFAULT_MICRO_IMBALANCE_CONFIG: MicroImbalanceConfig = { enabled: true };

export const MICRO_IMBALANCE_SPEC = {
	feature: 'MicropriceQueueImbalance',
	version: MICRO_IMBALANCE_VERSION,
	question: 'For one L1 quote, what is the size-weighted microprice and the queue imbalance?',
	formula: 'microprice = (bid×askQty + ask×bidQty)/(bidQty+askQty); queueImbalance = (bidQty−askQty)/(bidQty+askQty)',
	units: 'prices in index points; sizes as the provider reports them (echoed verbatim); imbalance/offset-fraction dimensionless',
	window: 'ONE observation only — no lookback, no rolling window, no smoothing, so no look-ahead is possible',
	edges: 'bid == ask is a valid zero spread; bid > ask is CROSSED_BOOK; a 0 bid/ask is not a price; both sizes 0 is ZERO_SIZE',
	refuses: [...MICRO_REFUSALS] as string[],
	missingData: 'absent/invalid quote, crossed book, absent/negative/zero/non-finite sizes ⇒ null values with a closed-vocabulary token, never a fabricated imbalance',
	provenance: 'source, source/received timestamps, sequence number, payload hash, data quality and the EVENT/SNAPSHOT basis are echoed through unchanged',
	note: 'multi-level depth (OBI/MLOFI) and event-based OFI are NOT inputs here: no order-book levels are persisted and no size-carrying event stream exists',
};

export const describeMicroImbalance = (c: MicroImbalanceConfig = DEFAULT_MICRO_IMBALANCE_CONFIG): string =>
	[
		`${MICRO_IMBALANCE_VERSION}: microprice = (bid×askQty + ask×bidQty)/(bidQty+askQty) and`,
		`queueImbalance = (bidQty−askQty)/(bidQty+askQty), from ONE L1 quote with the mid/spread context.`,
		`No lookback and no smoothing, so no look-ahead; sizes are echoed verbatim.`,
		`A quote with no sizes (the FYERS case) is NO_SIZES, a crossed book is CROSSED_BOOK, and both-zero sizes`,
		`is ZERO_SIZE — never 0/NaN/Infinity. enabled=${c.enabled}.`,
	].join(' ');

export interface MicroImbalanceValues {
	mid: number;
	spread: number;
	relativeSpread: number;
	microprice: number;
	micropriceOffsetPoints: number;
	micropriceOffsetFraction: number;
	/** ∈ [−1, +1]; positive = bid-heavy book. */
	queueImbalance: number;
}

export interface MicroImbalanceObservation {
	instrumentKey: string;
	source: string;
	status: MicroStatus;
	reason: MicroRefusal | null;
	reasonDetail: string | null;
	basis: QuoteBasis;
	values: MicroImbalanceValues | null;
	evidence: {
		bid: number | null;
		ask: number | null;
		bidQty: number | null;
		askQty: number | null;
		sourceTimestamp: string | null;
		receivedTimestamp: string | null;
		sequenceNumber: number | null;
		payloadHash: string | null;
		dataQuality: string | null;
	};
}

export interface MicroImbalanceReport {
	version: string;
	enabled: boolean;
	config: MicroImbalanceConfig;
	spec: typeof MICRO_IMBALANCE_SPEC;
	observations: MicroImbalanceObservation[];
	counts: Record<MicroStatus, number>;
	refusalCounts: Record<MicroRefusal, number>;
	coverage: { quotesIn: number; ok: number; unavailable: number; disabled: number; withSizes: number; byBasis: Record<QuoteBasis, number> };
	/** Distribution of the OK rows' queue imbalance over 10 equal bins of [−1, +1]; descriptive only. */
	queueImbalanceBins: number[];
	reviewerSummary: string;
	digest: string;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const round6 = (v: number): number => Number(v.toFixed(6));
const isoOrNull = (v: Date | string | null | undefined): string | null => {
	if (v === null || v === undefined) return null;
	if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
	const t = Date.parse(String(v));
	return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

const base = (q: MicroQuote) => ({
	instrumentKey: q?.instrumentKey ?? '',
	source: q?.source ?? '',
	basis: (q?.basis ?? 'UNKNOWN') as QuoteBasis,
	evidence: {
		bid: isNum(q?.bid) ? (q.bid as number) : null,
		ask: isNum(q?.ask) ? (q.ask as number) : null,
		bidQty: isNum(q?.bidQty) ? (q.bidQty as number) : null,
		askQty: isNum(q?.askQty) ? (q.askQty as number) : null,
		sourceTimestamp: isoOrNull(q?.sourceTimestamp),
		receivedTimestamp: isoOrNull(q?.receivedTimestamp),
		sequenceNumber: isNum(q?.sequenceNumber) ? (q.sequenceNumber as number) : null,
		payloadHash: q?.payloadHash ?? null,
		dataQuality: q?.dataQuality ?? null,
	},
});

function evaluateOne(q: MicroQuote, cfg: MicroImbalanceConfig): MicroImbalanceObservation {
	const common = base(q);
	const no = (reason: MicroRefusal, detail: string): MicroImbalanceObservation => ({ ...common, status: 'UNAVAILABLE', reason, reasonDetail: detail, values: null });

	if (!cfg.enabled) return { ...common, status: 'DISABLED', reason: null, reasonDetail: 'the component is disabled; no value was computed for this quote', values: null };
	if (!q || typeof q !== 'object') return no('NO_QUOTES', 'no observation was supplied');

	const bid = isNum(q.bid) ? q.bid : null;
	const ask = isNum(q.ask) ? q.ask : null;
	if (bid === null || ask === null) return no('INVALID_QUOTE', 'bid and ask must both be finite numbers');
	if (bid <= 0 || ask <= 0) return no('INVALID_QUOTE', `a 0 or negative price is not a quote (bid=${bid}, ask=${ask})`);
	if (bid > ask) return no('CROSSED_BOOK', `bid ${bid} > ask ${ask}`);

	if (q.bidQty === null || q.bidQty === undefined || q.askQty === null || q.askQty === undefined) {
		return no('NO_SIZES', 'bid/ask sizes are absent, so neither the microprice nor the queue imbalance is defined');
	}
	if (!isNum(q.bidQty) || !isNum(q.askQty)) return no('NOT_A_NUMBER', `a supplied size is not finite (bidQty=${String(q.bidQty)}, askQty=${String(q.askQty)})`);
	if (q.bidQty < 0 || q.askQty < 0) return no('NEGATIVE_SIZE', `sizes cannot be negative (bidQty=${q.bidQty}, askQty=${q.askQty})`);
	const total = q.bidQty + q.askQty;
	if (!(total > 0)) return no('ZERO_SIZE', 'both sizes are 0, so the sizes cannot weight the microprice');

	const mid = (bid + ask) / 2;
	const spread = ask - bid;
	const microprice = (bid * q.askQty + ask * q.bidQty) / total;
	return {
		...common,
		status: 'OK',
		reason: null,
		reasonDetail: null,
		values: {
			mid: round6(mid),
			spread: round6(spread),
			relativeSpread: round6(mid > 0 ? spread / mid : 0),
			microprice: round6(microprice),
			micropriceOffsetPoints: round6(microprice - mid),
			micropriceOffsetFraction: round6(mid > 0 ? (microprice - mid) / mid : 0),
			queueImbalance: round6((q.bidQty - q.askQty) / total),
		},
	};
}

/** Canonical TOTAL order: identity, then source, then the echoed sequence/timestamp, then the values. */
const byQuote = (rows: MicroImbalanceObservation[]): MicroImbalanceObservation[] =>
	[...rows].sort((a, b) => {
		const keyOf = (r: MicroImbalanceObservation): string =>
			`${r.instrumentKey}|${r.source}|${r.evidence.sourceTimestamp ?? ''}|${r.evidence.sequenceNumber ?? ''}|${r.evidence.bid ?? ''}|${r.evidence.ask ?? ''}|${r.evidence.bidQty ?? ''}|${r.evidence.askQty ?? ''}`;
		const ka = keyOf(a);
		const kb = keyOf(b);
		return ka < kb ? -1 : ka > kb ? 1 : 0;
	});

/**
 * Evaluate every quote. Input order is irrelevant; rows are emitted in canonical order and the digest is a
 * function of the DATA alone.
 */
export function evaluateMicroImbalance(quotes: MicroQuote[], config: Partial<MicroImbalanceConfig> = {}): MicroImbalanceReport {
	const cfg: MicroImbalanceConfig = { ...DEFAULT_MICRO_IMBALANCE_CONFIG, ...config };
	const rows = byQuote((quotes ?? []).map((q) => evaluateOne(q, cfg)));

	const counts: Record<MicroStatus, number> = { OK: 0, UNAVAILABLE: 0, DISABLED: 0 };
	const refusalCounts = Object.fromEntries(MICRO_REFUSALS.map((r) => [r, 0])) as Record<MicroRefusal, number>;
	const byBasis: Record<QuoteBasis, number> = { EVENT: 0, SNAPSHOT: 0, UNKNOWN: 0 };
	const bins = new Array(10).fill(0);
	let withSizes = 0;
	for (const r of rows) {
		counts[r.status] += 1;
		if (r.reason) refusalCounts[r.reason] += 1;
		byBasis[r.basis] += 1;
		if (isNum(r.evidence.bidQty) && isNum(r.evidence.askQty) && (r.evidence.bidQty as number) >= 0 && (r.evidence.askQty as number) >= 0) withSizes += 1;
		if (r.status === 'OK' && r.values) {
			const idx = Math.min(9, Math.max(0, Math.floor(((r.values.queueImbalance + 1) / 2) * 10)));
			bins[idx] += 1;
		}
	}

	return {
		version: MICRO_IMBALANCE_VERSION,
		enabled: cfg.enabled,
		config: cfg,
		spec: MICRO_IMBALANCE_SPEC,
		observations: rows,
		counts,
		refusalCounts,
		coverage: { quotesIn: rows.length, ok: counts.OK, unavailable: counts.UNAVAILABLE, disabled: counts.DISABLED, withSizes, byBasis },
		queueImbalanceBins: bins,
		reviewerSummary: describeMicroImbalance(cfg),
		digest: JSON.stringify(rows.map((r) => [r.instrumentKey, r.source, r.status, r.reason, r.values ? r.values.queueImbalance : null, r.values ? r.values.micropriceOffsetPoints : null])),
	};
}
