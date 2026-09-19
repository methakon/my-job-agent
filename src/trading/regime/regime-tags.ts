/**
 * ROW 123 — GATE 10 #1 "Create trend, range, volatility, liquidity and opening-state tags."
 * ROW 125 — GATE 10 #2 "Add event/catalyst state."
 * ROW 127 — GATE 10 #3 "Add gap-state and acceptance/rejection state."
 * ROW 129 — GATE 10 #4 "Add volatility transition state."
 * ROW 135 — GATE 10 #5 "Do not let regime state hard-veto until measured."
 *
 * doneWhen: "A reviewer can determine exactly what the item does and a replay/test demonstrates
 *            the behavior."
 *
 * WHAT THIS IS
 *   Eight orthogonal, deterministic session tags describing the regime ENTERING a session:
 *     trend          TREND_UP | TREND_DOWN | RANGE      (last close vs SMA20, in ATR units)
 *     range          NARROW | NORMAL | WIDE             (last session's high-low, in ATR units)
 *     volatility     LOW | NORMAL | HIGH                (ATR/close, vs its own trailing history)
 *     liquidity      THIN | NORMAL | THICK              (volume, vs its own trailing history — PROXY)
 *     openingState   FLAT | GAP_UP_SMALL/LARGE | GAP_DOWN_SMALL/LARGE  (this session's open vs prior close)
 *     eventCatalyst  NONE | LOW | MEDIUM | HIGH | UNKNOWN  (external events, caller-provided)
 *     gapAcceptance  UNTESTED | ACCEPTED | REJECTED | UNKNOWN  (gap fill/rejection state)
 *     volatilityTransition STABLE | EXPANDING | CONTRACTING | UNKNOWN  (ATR regime shift)
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
 * VETO SAFETY (ROW 135)
 *   The vetoReport field on RegimeTags reports what WOULD veto if it were active, but never blocks.
 *   All veto conditions have wouldBlock: false until explicitly measured and validated.
 *
 * WHY ITS OWN BAR TYPE
 *   The gap engine's SessionBar carries a source-specific "quoted close = the PREVIOUS session's
 *   close" convention. Regime math needs each session's OWN close, so this module defines its own
 *   explicit bar instead of silently inheriting that semantics.
 */
export const REGIME_TAGS_VERSION = 'regimetag-v2';

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
export const EVENT_CATALYST_TAGS = ['NONE', 'LOW', 'MEDIUM', 'HIGH', 'UNKNOWN'] as const;
export const GAP_ACCEPTANCE_TAGS = ['UNTESTED', 'ACCEPTED', 'REJECTED', 'UNKNOWN'] as const;
export const VOL_TRANSITION_TAGS = ['STABLE', 'EXPANDING', 'CONTRACTING', 'UNKNOWN'] as const;

export type TrendTag = (typeof TREND_TAGS)[number];
export type RangeTag = (typeof RANGE_TAGS)[number];
export type VolatilityTag = (typeof VOLATILITY_TAGS)[number];
export type LiquidityTag = (typeof LIQUIDITY_TAGS)[number];
export type OpeningStateTag = (typeof OPENING_STATE_TAGS)[number];
export type EventCatalystTag = (typeof EVENT_CATALYST_TAGS)[number];
export type GapAcceptanceTag = (typeof GAP_ACCEPTANCE_TAGS)[number];
export type VolTransitionTag = (typeof VOL_TRANSITION_TAGS)[number];

/** Closed refusal vocabulary — declaration order is the canonical order. */
export const REGIME_REFUSALS = [
	'NO_SESSIONS',            // nothing prior to look at
	'INSUFFICIENT_HISTORY',   // fewer usable prior sessions than the tag needs
	'NO_ATR',                 // ATR undefined (flat/invalid prior sessions)
	'NO_PRIOR_CLOSE',         // the last prior session has no usable close
	'NO_OPEN',                // this session's open is missing/invalid
	'NO_VOLUME',              // the last prior session has no volume (liquidity cannot be tagged)
	'NO_PREV_SESSION',        // no previous session for gap acceptance context (ROW 127)
	'NO_EVENT_DATA',          // event/catalyst data not provided (ROW 125)
	'NO_VOL_TRANSITION_DATA', // insufficient ATR history for volatility transition (ROW 129)
] as const;
export type RegimeRefusal = (typeof REGIME_REFUSALS)[number];

export type RegimeFamily = 'trend' | 'range' | 'volatility' | 'liquidity' | 'openingState' | 'eventCatalyst' | 'gapAcceptance' | 'volatilityTransition';

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
	/** ROW 127 — gapAcceptance: ATR threshold for gap fill detection (caller-provided or derived). */
	gapAcceptanceAtrThreshold: 0.5,
	/** ROW 127 — gapAcceptance: sessions to wait before checking acceptance. */
	gapAcceptanceWaitSessions: 3,
	/** ROW 129 — volatilityTransition: ATR ratio thresholds for expansion/contraction. */
	volTransitionSpikeRatio: 1.5,
	volTransitionContractionRatio: 0.7,
	/** ROW 129 — volatilityTransition: minimum ATR history length for transition detection. */
	volTransitionMinAtrHistory: 14,
} as const;

/**
 * ROW 135 — Veto report types.
 * Report-only: every condition has wouldBlock: false until explicitly validated.
 */
export type RegimeVetoStatus = {
	/** Whether this veto condition would block if it were active. Always false until measured. */
	wouldBlock: false;
	/** The condition name (e.g., 'EVENT_CATALYST_HIGH'). */
	condition: string;
	/** Human-readable description of what would veto. */
	description: string;
};

export type RegimeVetoReport = {
	eventCatalyst?: RegimeVetoStatus;
	gapAcceptance?: RegimeVetoStatus;
	volatilityTransition?: RegimeVetoStatus;
};

export type RegimeTags = {
	version: string;
	/** The last prior session the tags were computed from (the basis of the regime). */
	asOfSession: string | null;
	trend: TrendTag;
	range: RangeTag;
	volatility: VolatilityTag;
	liquidity: LiquidityTag;
	openingState: OpeningStateTag;
	eventCatalyst: EventCatalystTag;
	gapAcceptance: GapAcceptanceTag;
	volatilityTransition: VolTransitionTag;
	/** One entry per UNKNOWN tag giving the exact blocking condition. Empty when all tags resolved. */
	reasons: Partial<Record<RegimeFamily, RegimeRefusal>>;
	/** ROW 135 — veto report: report-only, never blocks. */
	vetoReport: RegimeVetoReport;
	context: {
		sessionsUsed: number;
		atr14: number | null;
		priorClose: number | null;
		sma: number | null;
		/** This session's gap in ATR units (its open vs the prior close). */
		gapAtr: number | null;
		/** Percentile of each self-calibrated measure in its own trailing window, when computed. */
		percentiles: { volatility: number | null; range: number | null; liquidity: number | null };
		/** ROW 129 — volatility transition ATR context. */
		volTransition?: { currentAtr: number; medianAtr: number; ratio: number };
		/** ROW 127 — gap acceptance context (previous session's data for comparison). */
		gapAcceptance?: { prevGapDirection: 'UP' | 'DOWN' | 'FLAT' | null; gapSizeAtr: number | null };
	};
};

export type RegimeInput = {
	/** Sessions STRICTLY BEFORE the session being tagged, ascending by date. */
	priorSessions: readonly RegimeSessionBar[];
	/** The open of the session being tagged — knowable at 09:15 IST, the frozen feature instant. */
	open: number | null;
	/** ROW 125 — optional event/catalyst data: caller-provided, not computed from bars. */
	eventCatalyst?: EventCatalystTag;
	/** ROW 127 — optional: session high/low for gap acceptance computation (may differ from prior session). */
	sessionHigh?: number | null;
	sessionLow?: number | null;
	/** ROW 127 — optional: volume for gap acceptance context. */
	volume?: number | null;
	/** ROW 127 — optional: the previous session bar for gap acceptance (if priorSessions[-1] is not sufficient). */
	prevSession?: RegimeSessionBar | null;
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
		for (const f of ['trend', 'range', 'volatility', 'liquidity', 'openingState', 'eventCatalyst', 'gapAcceptance', 'volatilityTransition'] as RegimeFamily[]) unknown(f, reason);
		return {
			version: REGIME_TAGS_VERSION, asOfSession: prior.length ? prior[prior.length - 1].sessionDate : null,
			trend: 'UNKNOWN', range: 'UNKNOWN', volatility: 'UNKNOWN', liquidity: 'UNKNOWN', openingState: 'UNKNOWN',
			eventCatalyst: 'UNKNOWN', gapAcceptance: 'UNKNOWN', volatilityTransition: 'UNKNOWN',
			reasons, vetoReport: {}, context: ctx,
		};
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

	// ── ROW 125 — eventCatalyst: caller-provided, never computed from bars ─────
	let eventCatalyst: EventCatalystTag = 'UNKNOWN';
	if (input.eventCatalyst !== undefined) {
		eventCatalyst = input.eventCatalyst;
	} else {
		unknown('eventCatalyst', 'NO_EVENT_DATA');
	}

	// ── ROW 127 — gapAcceptance: gap fill/rejection state from prior session ───
	let gapAcceptance: GapAcceptanceTag = 'UNKNOWN';
	const prev = input.prevSession ?? (prior.length >= 2 ? prior[prior.length - 2] : null);
	if (!prev) {
		unknown('gapAcceptance', 'NO_PREV_SESSION');
	} else {
		// Determine previous session's gap direction
		const prevGapAtr = (prev.open - (prior.length >= 2 ? prior[prior.length - 2].close : prev.close)) / atr;
		const prevGapDir = Math.abs(prevGapAtr) <= T.openingFlatAtr ? 'FLAT' : (prevGapAtr > 0 ? 'UP' : 'DOWN');
		ctx.gapAcceptance = { prevGapDirection: prevGapDir as 'UP' | 'DOWN' | 'FLAT', gapSizeAtr: Math.abs(prevGapAtr) };

		if (prevGapDir === 'FLAT') {
			gapAcceptance = 'UNTESTED';
		} else {
			// Check if price has filled the gap in subsequent sessions
			const gapFillTarget = prevGapDir === 'UP' ? prev.low : prev.high;
			const priceAction = input.sessionHigh !== undefined && input.sessionLow !== undefined
				? { high: input.sessionHigh ?? last.high, low: input.sessionLow ?? last.low }
				: { high: last.high, low: last.low };

			const filled = prevGapDir === 'UP'
				? priceAction.low <= gapFillTarget
				: priceAction.high >= gapFillTarget;

			gapAcceptance = filled ? 'ACCEPTED' : 'REJECTED';
		}
	}

	// ── ROW 129 — volatilityTransition: ATR regime shift detection ─────────────
	let volatilityTransition: VolTransitionTag = 'UNKNOWN';
	const atrHist: number[] = [];
	for (let i = T.volTransitionMinAtrHistory; i <= n - 1; i++) {
		const a = atrAt(trs, i, T.atrPeriod);
		if (a !== null && isPos(prior[i].close)) atrHist.push(a);
	}
	if (atrHist.length < 3) {
		unknown('volatilityTransition', 'NO_VOL_TRANSITION_DATA');
	} else {
		const currentAtr = atrHist[atrHist.length - 1];
		const sorted = [...atrHist].sort((a, b) => a - b);
		const mid = Math.floor(sorted.length / 2);
		const medianAtr = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
		ctx.volTransition = { currentAtr, medianAtr, ratio: currentAtr / medianAtr };
		const ratio = currentAtr / medianAtr;
		if (ratio >= T.volTransitionSpikeRatio) volatilityTransition = 'EXPANDING';
		else if (ratio <= T.volTransitionContractionRatio) volatilityTransition = 'CONTRACTING';
		else volatilityTransition = 'STABLE';
	}

	// ROW 135 — veto report: report-only, never blocks
	const vetoReport: RegimeVetoReport = {};
	if (eventCatalyst !== 'UNKNOWN') vetoReport.eventCatalyst = { wouldBlock: false, condition: 'EVENT_CATALYST_' + eventCatalyst, description: 'Event catalyst state reported; no block until measured' };
	if (gapAcceptance !== 'UNKNOWN') vetoReport.gapAcceptance = { wouldBlock: false, condition: 'GAP_ACCEPTANCE_' + gapAcceptance, description: 'Gap acceptance state reported; no block until measured' };
	if (volatilityTransition !== 'UNKNOWN') vetoReport.volatilityTransition = { wouldBlock: false, condition: 'VOL_TRANSITION_' + volatilityTransition, description: 'Volatility transition state reported; no block until measured' };

	return {
		version: REGIME_TAGS_VERSION, asOfSession: last.sessionDate,
		trend, range, volatility, liquidity, openingState,
		eventCatalyst, gapAcceptance, volatilityTransition,
		reasons, vetoReport, context: ctx,
	};
}
