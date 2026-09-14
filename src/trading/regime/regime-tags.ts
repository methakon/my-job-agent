/**
 * ROW 123 — GATE 10 #1 "Create trend, range, volatility, liquidity and opening-state tags."
 *
 * doneWhen: "A reviewer can determine exactly what the item does and a replay/test demonstrates
 *            the behavior."
 *
 * WHAT THIS IS
 *   Five orthogonal, deterministic session tags describing the regime ENTERING a session:
 *     trend          TREND_UP | TREND_DOWN | RANGE      (last close vs SMA20, in ATR units)
 *     range          NARROW | NORMAL | WIDE             (last session's high-low, in ATR units)
 *     volatility     LOW | NORMAL | HIGH                (ATR/close, vs its own trailing history)
 *     liquidity      THIN | NORMAL | THICK              (volume, vs its own trailing history — PROXY)
 *     openingState   FLAT | GAP_UP_SMALL/LARGE | GAP_DOWN_SMALL/LARGE  (this session's open vs prior close)
 *
 * TIMESTAMP BASIS — the whole point of this module
 *   The regime "entering" session t is computed from sessions STRICTLY BEFORE t, plus t's OWN OPEN.
 *   That is exactly the information available at 09:15 IST on t. Nothing after the open of t can
 *   change it, so the tags are safe as point-in-time features; this is asserted by the leakage tests.
 *
 *   An ex-post "what kind of day was t" classifier is deliberately NOT provided. Such a label is
 *   only knowable after the close and reusing it as an input is the classic look-ahead error; a
 *   caller that needs it must build it from the session's own bar and label it as an outcome.
 *
 * PURITY
 *   Pure functions over plain arrays: no database, no HTTP, no broker, no clock, no randomness, no
 *   AI. Determinism is exact — the same sessions and open always produce the same tags.
 *
 * FAIL CLOSED
 *   A tag that cannot be computed is UNKNOWN together with a reason from a closed vocabulary.
 *   No tag is ever defaulted, interpolated or set to a neutral value to look complete.
 *
 * WHY ITS OWN BAR TYPE
 *   The gap engine's SessionBar carries a source-specific "quoted close = the PREVIOUS session's
 *   close" convention. Regime math needs each session's OWN close, so this module defines its own
 *   explicit bar instead of silently inheriting that semantics.
 */
export const REGIME_TAGS_VERSION = 'regimetag-v1';

/** One recorded session. Every field is that session's OWN value. */
export type RegimeSessionBar = {
	/** 'YYYY-MM-DD' in IST, supplied by the caller (never re-derived from a timestamp). */
	sessionDate: string;
	open: number;
	high: number;
	low: number;
	close: number;
	/** null when the archive holds no volume for this session — NEVER coerced to 0. */
	volume: number | null;
};

export const TREND_TAGS = ['TREND_UP', 'TREND_DOWN', 'RANGE', 'UNKNOWN'] as const;
export const RANGE_TAGS = ['NARROW', 'NORMAL', 'WIDE', 'UNKNOWN'] as const;
export const VOLATILITY_TAGS = ['LOW', 'NORMAL', 'HIGH', 'UNKNOWN'] as const;
export const LIQUIDITY_TAGS = ['THIN', 'NORMAL', 'THICK', 'UNKNOWN'] as const;
export const OPENING_STATE_TAGS = ['FLAT', 'GAP_UP_SMALL', 'GAP_UP_LARGE', 'GAP_DOWN_SMALL', 'GAP_DOWN_LARGE', 'UNKNOWN'] as const;

export type TrendTag = (typeof TREND_TAGS)[number];
export type RangeTag = (typeof RANGE_TAGS)[number];
export type VolatilityTag = (typeof VOLATILITY_TAGS)[number];
export type LiquidityTag = (typeof LIQUIDITY_TAGS)[number];
export type OpeningStateTag = (typeof OPENING_STATE_TAGS)[number];

/** Closed refusal vocabulary — declaration order is the canonical order. */
export const REGIME_REFUSALS = [
	'NO_SESSIONS',            // nothing prior to look at
	'INSUFFICIENT_HISTORY',   // fewer usable prior sessions than the tag needs
	'NO_ATR',                 // ATR undefined (flat/invalid prior sessions)
	'NO_PRIOR_CLOSE',         // the last prior session has no usable close
	'NO_OPEN',                // this session's open is missing/invalid
	'NO_VOLUME',              // the last prior session has no volume (liquidity cannot be tagged)
] as const;
export type RegimeRefusal = (typeof REGIME_REFUSALS)[number];

export type RegimeFamily = 'trend' | 'range' | 'volatility' | 'liquidity' | 'openingState';

/** Pinned, versioned thresholds. Changing any of these requires a new REGIME_TAGS_VERSION. */
export const REGIME_THRESHOLDS = {
	atrPeriod: 14,
	/** Prior sessions needed before any tag is attempted. */
	minSessions: 15,
	/** Window used for the self-calibrating percentile tags (volatility/range/liquidity). */
	percentileWindow: 60,
	/** A value in the bottom/top third of its own trailing window is NARROW/THIN/LOW / WIDE/THICK/HIGH. */
	percentileLow: 1 / 3,
	percentileHigh: 2 / 3,
	/** trend: |close − SMA20| in ATR units above this is a trend, otherwise RANGE. */
	smaPeriod: 20,
	trendDistanceAtr: 0.5,
	/** liquidity: minimum non-null prior volumes before tagging. */
	minVolumes: 20,
	/** openingState: |gap| in ATR units at/below this is FLAT, at/above `openingLargeAtr` is LARGE. */
	openingFlatAtr: 0.1,
	openingLargeAtr: 0.5,
} as const;

export type RegimeTags = {
	version: string;
	/** The last prior session the tags were computed from (the basis of the regime). */
	asOfSession: string | null;
	trend: TrendTag;
	range: RangeTag;
	volatility: VolatilityTag;
	liquidity: LiquidityTag;
	openingState: OpeningStateTag;
	/** One entry per UNKNOWN tag giving the exact blocking condition. Empty when all tags resolved. */
	reasons: Partial<Record<RegimeFamily, RegimeRefusal>>;
	context: {
		sessionsUsed: number;
		atr14: number | null;
		priorClose: number | null;
		sma: number | null;
		/** This session's gap in ATR units (its open vs the prior close). */
		gapAtr: number | null;
		/** Percentile of each self-calibrated measure in its own trailing window, when computed. */
		percentiles: { volatility: number | null; range: number | null; liquidity: number | null };
	};
};

export type RegimeInput = {
	/** Sessions STRICTLY BEFORE the session being tagged, ascending by date. */
	priorSessions: readonly RegimeSessionBar[];
	/** The open of the session being tagged — knowable at 09:15 IST, the frozen feature instant. */
	open: number | null;
};

const isPos = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** True range of session i against the PREVIOUS session's close. */
const trueRange = (bars: readonly RegimeSessionBar[], i: number): number => {
	const prevClose = bars[i - 1].close;
	return Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - prevClose), Math.abs(bars[i].low - prevClose));
};

/** Every true range from index 1 upward. `trs[k]` belongs to session index k+1. */
const trueRanges = (bars: readonly RegimeSessionBar[]): number[] => {
	const out: number[] = [];
	for (let i = 1; i < bars.length; i++) out.push(trueRange(bars, i));
	return out;
};

/** ATR ending AT session index i = mean of the `period` true ranges up to i. Null when undefined. */
const atrAt = (trs: readonly number[], i: number, period: number): number | null => {
	if (i < period) return null;
	let sum = 0;
	for (let k = i - period; k < i; k++) sum += trs[k];
	const atr = sum / period;
	return Number.isFinite(atr) && atr > 0 ? atr : null;
};

/** Share of `values` at or below `v` — a self-calibrating rank in [0,1]. */
const percentileRank = (values: readonly number[], v: number): number | null => {
	if (!values.length) return null;
	let n = 0;
	for (const x of values) if (x <= v) n += 1;
	return n / values.length;
};

/**
 * The regime ENTERING a session: computed from the prior sessions plus this session's open.
 * Pure and deterministic; every unresolvable tag is UNKNOWN with a reason.
 */
export function regimeEntering(input: RegimeInput): RegimeTags {
	const T = REGIME_THRESHOLDS;
	const prior = input.priorSessions;
	const reasons: Partial<Record<RegimeFamily, RegimeRefusal>> = {};
	const ctx: RegimeTags['context'] = {
		sessionsUsed: 0,
		atr14: null,
		priorClose: null,
		sma: null,
		gapAtr: null,
		percentiles: { volatility: null, range: null, liquidity: null },
	};
	const unknown = (family: RegimeFamily, reason: RegimeRefusal) => { reasons[family] = reason; };

	const allUnknown = (reason: RegimeRefusal): RegimeTags => {
		for (const f of ['trend', 'range', 'volatility', 'liquidity', 'openingState'] as RegimeFamily[]) unknown(f, reason);
		return { version: REGIME_TAGS_VERSION, asOfSession: prior.length ? prior[prior.length - 1].sessionDate : null, trend: 'UNKNOWN', range: 'UNKNOWN', volatility: 'UNKNOWN', liquidity: 'UNKNOWN', openingState: 'UNKNOWN', reasons, context: ctx };
	};

	if (!prior.length) return allUnknown('NO_SESSIONS');
	const last = prior[prior.length - 1];
	ctx.sessionsUsed = prior.length;
	if (!isPos(last.close)) return allUnknown('NO_PRIOR_CLOSE');
	ctx.priorClose = last.close;
	if (prior.length < T.minSessions) return allUnknown('INSUFFICIENT_HISTORY');

	const trs = trueRanges(prior);
	const n = prior.length;
	const atr = atrAt(trs, n - 1, T.atrPeriod);
	if (atr === null) return allUnknown('NO_ATR');
	ctx.atr14 = atr;

	// ── trend: last close vs SMA20, measured in ATR units ─────────────────────
	let trend: TrendTag = 'UNKNOWN';
	if (n >= T.smaPeriod) {
		let sum = 0;
		for (let i = n - T.smaPeriod; i < n; i++) sum += prior[i].close;
		const sma = sum / T.smaPeriod;
		if (isNum(sma) && sma > 0) {
			ctx.sma = sma;
			const distance = (last.close - sma) / atr;
			if (distance > T.trendDistanceAtr) trend = 'TREND_UP';
			else if (distance < -T.trendDistanceAtr) trend = 'TREND_DOWN';
			else trend = 'RANGE';
		} else {
			unknown('trend', 'INSUFFICIENT_HISTORY');
		}
	} else {
		unknown('trend', 'INSUFFICIENT_HISTORY');
	}

	// ── self-calibrating percentile tags over the trailing window ─────────────
	const windowStart = Math.max(T.atrPeriod, n - T.percentileWindow);
	const volHist: number[] = [];
	const rangeHist: number[] = [];
	for (let i = windowStart; i <= n - 1; i++) {
		const a = atrAt(trs, i, T.atrPeriod);
		if (a === null || !isPos(prior[i].close)) continue;
		volHist.push(a / prior[i].close);
		rangeHist.push((prior[i].high - prior[i].low) / a);
	}
	const volP = volHist.length ? percentileRank(volHist, atr / last.close) : null;
	const rangeP = rangeHist.length ? percentileRank(rangeHist, (last.high - last.low) / atr) : null;
	ctx.percentiles.volatility = volP;
	ctx.percentiles.range = rangeP;

	let volatility: VolatilityTag = 'UNKNOWN';
	if (volP === null) unknown('volatility', 'INSUFFICIENT_HISTORY');
	else if (volP <= T.percentileLow) volatility = 'LOW';
	else if (volP >= T.percentileHigh) volatility = 'HIGH';
	else volatility = 'NORMAL';

	let range: RangeTag = 'UNKNOWN';
	if (rangeP === null) unknown('range', 'INSUFFICIENT_HISTORY');
	else if (rangeP <= T.percentileLow) range = 'NARROW';
	else if (rangeP >= T.percentileHigh) range = 'WIDE';
	else range = 'NORMAL';

	// ── liquidity: PROXY from recorded session volume (no order book in this archive) ──
	let liquidity: LiquidityTag = 'UNKNOWN';
	const volValues = prior.map((b) => b.volume).filter((v): v is number => isNum(v) && v > 0);
	if (!isNum(last.volume) || last.volume <= 0) unknown('liquidity', 'NO_VOLUME');
	else if (volValues.length < T.minVolumes) unknown('liquidity', 'INSUFFICIENT_HISTORY');
	else {
		const liqP = percentileRank(volValues.slice(-T.percentileWindow), last.volume);
		ctx.percentiles.liquidity = liqP;
		if (liqP === null) unknown('liquidity', 'INSUFFICIENT_HISTORY');
		else if (liqP <= T.percentileLow) liquidity = 'THIN';
		else if (liqP >= T.percentileHigh) liquidity = 'THICK';
		else liquidity = 'NORMAL';
	}

	// ── openingState: this session's open vs the prior close, in ATR units ────
	let openingState: OpeningStateTag = 'UNKNOWN';
	if (!isPos(input.open)) unknown('openingState', 'NO_OPEN');
	else {
		const gapAtr = (input.open - last.close) / atr;
		ctx.gapAtr = gapAtr;
		if (Math.abs(gapAtr) <= T.openingFlatAtr) openingState = 'FLAT';
		else if (gapAtr > 0) openingState = Math.abs(gapAtr) >= T.openingLargeAtr ? 'GAP_UP_LARGE' : 'GAP_UP_SMALL';
		else openingState = Math.abs(gapAtr) >= T.openingLargeAtr ? 'GAP_DOWN_LARGE' : 'GAP_DOWN_SMALL';
	}

	return { version: REGIME_TAGS_VERSION, asOfSession: last.sessionDate, trend, range, volatility, liquidity, openingState, reasons, context: ctx };
}
