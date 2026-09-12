/**
 * GATE 4 #4 (roadmap row 41) — GapRangePos FEATURE component.
 *
 * Single responsibility: for each session, measure WHERE THE OPEN SITS RELATIVE TO THE PRIOR
 * SESSION'S HIGH-LOW RANGE. It is a pure function: no clock, no I/O, no DB, no network, no AI,
 * no randomness. Everything it needs is an argument.
 *
 * ── PINNED DEFINITION (units, windows, edges) ───────────────────────────────────────────────
 *   priorRange  = prior.high − prior.low            (the PRIOR session's own high-low range)
 *   GapRangePos = (open − prior.low) / priorRange
 *
 *   UNITS       dimensionless ratio, measured in prior-range widths (not points, not %).
 *                 0    the open is exactly at the prior session's low
 *                 0.5  the open is at the midpoint of the prior range
 *                 1    the open is exactly at the prior session's high
 *                 > 1  the open is ABOVE the prior range (a range gap up)
 *                 < 0  the open is BELOW the prior range (a range gap down)
 *
 *   WINDOW      the IMMEDIATELY PRECEDING session in the adapter-ordered series. No lookback, no
 *               averaging, no smoothing, no interpolation. Sessions come from the shared adapter
 *               (`gap-session-series.ts`), which owns session labelling and bar selection.
 *
 *   LOOK-AHEAD  none. GapRangePos reads only the session `open` and the PRIOR session's `high`
 *               and `low` — all three are known at (or before) the open. The session's own
 *               high/low/close and every outcome-derived field are NEVER read.
 *
 *   THRESHOLDS  none. The component classifies nothing and holds no tunable constant, so it can
 *               never be "tuned so a result looks better" (asserted by test).
 *
 * ── MISSING / DEGENERATE DATA → a safe explicit UNAVAILABLE state ────────────────────────────
 *   A closed vocabulary of refusal reasons, each with a null value. Nothing is defaulted,
 *   interpolated, or carried forward:
 *     NO_PRIOR_SESSION        the first session of a series has no prior session to measure against
 *     NO_PRIOR_RANGE          the prior session's high or low is absent / not a finite number
 *     ZERO_PRIOR_RANGE        prior.high === prior.low ⇒ the ratio is undefined (0/0 is never 0)
 *     IMPOSSIBLE_PRIOR_RANGE  prior.high < prior.low  ⇒ the bar is internally inconsistent
 *     NO_SESSION_OPEN         the session open is absent, non-finite, or non-positive
 *   The last three are defensive: the adapter already filters such bars, but a caller-supplied
 *   series must not be able to fabricate a value by handing this component a broken bar.
 *
 * Research / shadow only: no production module imports this yet (asserted by test). Wiring it to
 * a desk is a separate, explicitly-scoped step.
 */

import { SessionBar } from './gap-session-series';

export const GAP_RANGE_POS_VERSION = 'gaprangepos-v1';

export type GapRangePosRefusal =
	| 'NO_PRIOR_SESSION'
	| 'NO_PRIOR_RANGE'
	| 'ZERO_PRIOR_RANGE'
	| 'IMPOSSIBLE_PRIOR_RANGE'
	| 'NO_SESSION_OPEN';

/** Closed, published refusal vocabulary (declaration order is the canonical order). */
export const GAP_RANGE_POS_REFUSALS: readonly GapRangePosRefusal[] = [
	'NO_PRIOR_SESSION',
	'NO_PRIOR_RANGE',
	'ZERO_PRIOR_RANGE',
	'IMPOSSIBLE_PRIOR_RANGE',
	'NO_SESSION_OPEN',
];

export type GapRangePosStatus = 'OK' | 'UNAVAILABLE' | 'DISABLED';

/** Canonical status order for the order-independent count map. */
export const GAP_RANGE_POS_STATUSES: readonly GapRangePosStatus[] = ['OK', 'UNAVAILABLE', 'DISABLED'];

export type GapRangePosConfig = {
	/** Master switch: false ⇒ the component computes nothing and reports a DISABLED row per input. */
	enabled: boolean;
};

/** No thresholds exist on purpose — this object is the single place every switch lives. */
export const DEFAULT_GAP_RANGE_POS_CONFIG: GapRangePosConfig = {
	enabled: true,
};

/** Machine-checkable statement of the contract; carried on every result for a reviewer. */
export const GAP_RANGE_POS_SPEC = {
	feature: 'GapRangePos',
	version: GAP_RANGE_POS_VERSION,
	formula: 'GapRangePos = (open − prior.low) / (prior.high − prior.low)',
	units: 'dimensionless ratio in prior-range widths: 0 = at prior low, 1 = at prior high, >1 = opened above the prior range, <0 = opened below it',
	window: 'the immediately preceding session in the adapter-ordered series (no lookback, no averaging, no smoothing)',
	inputs: ['session.open', 'prior.high', 'prior.low'],
	lookAhead: 'none — only the open and the prior session high/low, all known at the open; the session own high/low/close are never read',
	thresholds: 'none — the component classifies nothing and holds no tunable constant',
	refuses: [...GAP_RANGE_POS_REFUSALS] as string[],
	missingData:
		'NO_PRIOR_SESSION (first session of a series) / NO_PRIOR_RANGE (prior high or low absent) / ' +
		'ZERO_PRIOR_RANGE (prior high equals its low; the ratio is undefined) / ' +
		'IMPOSSIBLE_PRIOR_RANGE (prior high below prior low) / ' +
		'NO_SESSION_OPEN (open absent or non-positive) — each yields status UNAVAILABLE with a null value, never a default',
};

export type SessionGapRangePos = {
	sessionDate: string;
	instrument: string;
	status: GapRangePosStatus;
	/** Closed-vocabulary token; null only when status is OK. */
	reason: GapRangePosRefusal | null;
	/** Human-readable detail for the refusal, or null when OK. */
	reasonDetail: string | null;
	/** The feature value, or null in every non-OK state (never 0, never NaN). */
	gapRangePos: number | null;
	measures: {
		open: number | null;
		priorHigh: number | null;
		priorLow: number | null;
		priorRange: number | null;
	};
};

export type GapRangePosResult = {
	version: string;
	enabled: boolean;
	config: GapRangePosConfig;
	observations: SessionGapRangePos[];
	/** Canonical order (GAP_RANGE_POS_STATUSES). */
	counts: Record<GapRangePosStatus, number>;
	/** Canonical order (GAP_RANGE_POS_REFUSALS); zero-filled so the vocabulary is always visible. */
	refusalCounts: Record<GapRangePosRefusal, number>;
	coverage: {
		sessionsIn: number;
		ok: number;
		unavailable: number;
		disabled: number;
		firstSession: string | null;
		lastSession: string | null;
		firstOkSession: string | null;
		lastOkSession: string | null;
	};
	spec: typeof GAP_RANGE_POS_SPEC;
	reviewerSummary: string;
	digest: string;
};

/** One-paragraph statement a reviewer can check without reading the implementation. */
export const describeGapRangePos = (config: GapRangePosConfig = DEFAULT_GAP_RANGE_POS_CONFIG): string =>
	[
		`${GAP_RANGE_POS_VERSION}: measures where each session's OPEN sits inside the PRIOR session's high-low range`,
		`as GapRangePos = (open − prior.low) / (prior.high − prior.low), a dimensionless ratio in prior-range widths`,
		`(0 = at the prior low, 1 = at the prior high, >1 opened above the prior range, <0 opened below it).`,
		`The prior session is the immediately preceding one in the series; there is no lookback, no averaging and no threshold.`,
		`It reads only the open and the prior session's high/low, so nothing after the open can influence it.`,
		`Missing or degenerate input yields UNAVAILABLE with one of ${GAP_RANGE_POS_REFUSALS.join(' / ')} and a null value, never a fabricated number.`,
		`enabled=${config.enabled}.`,
	].join(' ');

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Canonical TOTAL order over the input set: session date, then a tie-break on the row's own
 * PRE-OPEN identity content. Date alone is not enough — two instruments (or two re-derived
 * series) can share a date, and `sort` is stable, so ties would keep the caller's order and leak
 * it into the digest. The tie-break deliberately uses only fields knowable before the open.
 */
const bySession = (rows: SessionBar[]): SessionBar[] =>
	[...rows].sort((a, b) => {
		if (a.sessionDate !== b.sessionDate) return a.sessionDate < b.sessionDate ? -1 : 1;
		const ka = `${a.instrument}|${a.open}|${a.prevClose}`;
		const kb = `${b.instrument}|${b.open}|${b.prevClose}`;
		return ka < kb ? -1 : ka > kb ? 1 : 0;
	});

const unavailable = (
	s: SessionBar,
	reason: GapRangePosRefusal,
	reasonDetail: string,
	measures: SessionGapRangePos['measures'],
): SessionGapRangePos => ({
	sessionDate: s.sessionDate,
	instrument: s.instrument,
	status: 'UNAVAILABLE',
	reason,
	reasonDetail,
	gapRangePos: null,
	measures,
});

function assessOne(s: SessionBar, prior: SessionBar | null): SessionGapRangePos {
	// Order matters: a missing open is reported first, then the prior-session requirements.
	if (!isNum(s.open) || s.open <= 0) {
		return unavailable(s, 'NO_SESSION_OPEN', 'the session open is absent, non-finite or non-positive', {
			open: null,
			priorHigh: null,
			priorLow: null,
			priorRange: null,
		});
	}

	const open = s.open;
	if (!prior) {
		return unavailable(s, 'NO_PRIOR_SESSION', 'the first session of a series has no prior session to measure against', {
			open,
			priorHigh: null,
			priorLow: null,
			priorRange: null,
		});
	}

	const priorHigh = prior.high;
	const priorLow = prior.low;
	if (!isNum(priorHigh) || !isNum(priorLow)) {
		return unavailable(s, 'NO_PRIOR_RANGE', 'the prior session high or low is absent or not a finite number', {
			open,
			priorHigh: isNum(priorHigh) ? priorHigh : null,
			priorLow: isNum(priorLow) ? priorLow : null,
			priorRange: null,
		});
	}

	if (priorHigh < priorLow) {
		return unavailable(
			s,
			'IMPOSSIBLE_PRIOR_RANGE',
			`the prior session high (${priorHigh}) is below its low (${priorLow})`,
			{ open, priorHigh, priorLow, priorRange: null },
		);
	}

	const priorRange = priorHigh - priorLow;
	if (priorRange <= 0) {
		return unavailable(
			s,
			'ZERO_PRIOR_RANGE',
			'the prior session high equals its low, so GapRangePos is undefined',
			{ open, priorHigh, priorLow, priorRange },
		);
	}

	return {
		sessionDate: s.sessionDate,
		instrument: s.instrument,
		status: 'OK',
		reason: null,
		reasonDetail: null,
		gapRangePos: (open - priorLow) / priorRange,
		measures: { open, priorHigh, priorLow, priorRange },
	};
}

/** The disabled path computes NOTHING and says so on every input row. */
const disabledRow = (s: SessionBar): SessionGapRangePos => ({
	sessionDate: s.sessionDate,
	instrument: s.instrument,
	status: 'DISABLED',
	reason: null,
	reasonDetail: 'the component is disabled; no GapRangePos was computed for this input',
	gapRangePos: null,
	measures: { open: null, priorHigh: null, priorLow: null, priorRange: null },
});

const digestOf = (observations: SessionGapRangePos[]): string =>
	JSON.stringify(
		observations.map((o) => [
			o.sessionDate,
			o.instrument,
			o.status,
			o.reason,
			o.gapRangePos === null ? null : Number(o.gapRangePos.toFixed(6)),
		]),
	);

/**
 * Compute GapRangePos for every session of one instrument's series.
 * Input order is irrelevant; observations are emitted in canonical order and the digest is a
 * function of the DATA alone (asserted by test: reversed/shuffled input ⇒ identical digest).
 */
export function assessGapRangePosSeries(
	sessions: SessionBar[],
	config: Partial<GapRangePosConfig> = {},
): GapRangePosResult {
	const cfg: GapRangePosConfig = { ...DEFAULT_GAP_RANGE_POS_CONFIG, ...config };
	const ordered = bySession(sessions);

	const counts: Record<GapRangePosStatus, number> = { OK: 0, UNAVAILABLE: 0, DISABLED: 0 };
	const refusalCounts = Object.fromEntries(GAP_RANGE_POS_REFUSALS.map((r) => [r, 0])) as Record<GapRangePosRefusal, number>;

	let observations: SessionGapRangePos[];
	if (!cfg.enabled) {
		observations = ordered.map(disabledRow);
	} else {
		observations = ordered.map((s, i) => assessOne(s, ordered[i - 1] ?? null));
	}

	for (const o of observations) {
		counts[o.status] += 1;
		if (o.reason) refusalCounts[o.reason] += 1;
	}

	const ok = observations.filter((o) => o.status === 'OK');

	return {
		version: GAP_RANGE_POS_VERSION,
		enabled: cfg.enabled,
		config: cfg,
		observations,
		counts,
		refusalCounts,
		coverage: {
			sessionsIn: ordered.length,
			ok: counts.OK,
			unavailable: counts.UNAVAILABLE,
			disabled: counts.DISABLED,
			firstSession: ordered.length ? ordered[0].sessionDate : null,
			lastSession: ordered.length ? ordered[ordered.length - 1].sessionDate : null,
			firstOkSession: ok.length ? ok[0].sessionDate : null,
			lastOkSession: ok.length ? ok[ok.length - 1].sessionDate : null,
		},
		spec: GAP_RANGE_POS_SPEC,
		reviewerSummary: describeGapRangePos(cfg),
		digest: digestOf(observations),
	};
}
