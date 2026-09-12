/**
 * GATE 4 #1 (roadmap row 38) — GAP TAXONOMY component.
 *
 * Single responsibility: classify each session's gap into ONE pinned class, deterministically,
 * from OHLC only. Pure: no clock, no I/O, no AI, no randomness. Thresholds live in ONE config
 * object, so the component can be enabled/disabled or retuned independently without touching
 * any caller.
 *
 * PINNED DEFINITIONS (all OHLC-derivable; nothing is inferred from unobserved ticks):
 *   gapAbs      = open − prevClose          gapPct = gapAbs / prevClose * 100
 *   gapRatio    = |gapAbs| / priorRange     (priorRange = prior session high − low)
 *   material    = |gapPct| >= minGapPct  AND  gapRatio >= minGapRatio
 *   FILLED (up) = session low  <= prevClose   FILLED (down) = session high >= prevClose
 *   fill timing is NOT derivable from OHLC and is always reported UNAVAILABLE, never guessed.
 *
 * Classes, evaluated in this documented precedence (first match wins):
 *   NONE                    the gap is not material by BOTH thresholds
 *   ISLAND                  a material gap opposite in sign to the previous material gap,
 *                           where the intervening session's range does not overlap the
 *                           range before it (an isolated range separated by gaps both sides)
 *   BREAKAWAY               material, opened OUTSIDE the lookback range, NOT filled, and the
 *                           session holds that side (close beyond open)
 *   RUNAWAY_CONTINUATION    material, NOT filled, holds its side, but is not a fresh lookback
 *                           breakout (continuation inside/at the range edge)
 *   EXHAUSTION              material, filled, trending into the gap, and the session closes
 *                           back THROUGH prevClose (the move failed)
 *   COMMON                  material, filled, and still closing on the gap's side
 *   UNCLASSIFIED            material but matching no pinned class — reported WITH its measures
 *                           rather than forced into the nearest label
 *
 * Every assessment carries its measures, the gap zone, the fill state, older-open-gap
 * interaction and safe-explicit UNAVAILABLE reasons (missing prevClose/close, zero prior
 * range, series too short for the lookback). Missing inputs never become a class.
 */

import { SessionBar } from './gap-session-series';

export const GAP_TAXONOMY_VERSION = 'gap-tax-v1';

export type GapClass = 'NONE' | 'COMMON' | 'BREAKAWAY' | 'RUNAWAY_CONTINUATION' | 'EXHAUSTION' | 'ISLAND' | 'UNCLASSIFIED';
export type GapDirection = 'UP' | 'DOWN';
export type GapFillState = 'UNFILLED' | 'FILLED' | 'UNKNOWN';

export const GAP_CLASSES: readonly GapClass[] = ['NONE', 'COMMON', 'BREAKAWAY', 'RUNAWAY_CONTINUATION', 'EXHAUSTION', 'ISLAND', 'UNCLASSIFIED'];

export type GapTaxonomyConfig = {
	/** Master switch: false ⇒ the component computes nothing and says so. */
	enabled: boolean;
	/** Minimum |gap| as a percentage of prevClose for a gap to be material. */
	minGapPct: number;
	/** Minimum |gap| as a fraction of the prior session's range. */
	minGapRatio: number;
	/** Sessions of range used for the breakout test. */
	breakoutLookback: number;
	/** How many older sessions are scanned for interaction with still-open gaps. */
	openGapLookback: number;
};

export const DEFAULT_GAP_TAXONOMY_CONFIG: GapTaxonomyConfig = {
	enabled: true,
	minGapPct: 0.15,
	minGapRatio: 0.10,
	breakoutLookback: 5,
	openGapLookback: 60,
};

export type SessionGapAssessment = {
	sessionDate: string;
	instrument: string;
	status: 'OK' | 'UNAVAILABLE';
	reason: string | null;
	class: GapClass | null;
	direction: GapDirection | null;
	gapAbs: number | null;
	gapPct: number | null;
	gapRatio: number | null;
	zone: { low: number; high: number } | null;
	fillState: GapFillState;
	fillTiming: 'UNAVAILABLE';
	fillTimingReason: string;
	openedOutsideLookback: boolean | null;
	olderGapInteraction: { sessionDates: string[]; note: string };
	measures: Record<string, number | null>;
};

export type GapTaxonomyResult = {
	version: string;
	enabled: boolean;
	config: GapTaxonomyConfig;
	assessments: SessionGapAssessment[];
	counts: Record<string, number>;
	coverage: {
		sessionsIn: number;
		assessed: number;
		unavailable: number;
		materialGaps: number;
		filled: number;
		openGaps: number;
		/** The SERIES window (every session offered), plus the assessed sub-window. */
		firstSession: string | null;
		lastSession: string | null;
		firstAssessedSession: string | null;
		lastAssessedSession: string | null;
	};
	/** One-paragraph statement of exactly what this component does. */
	reviewerSummary: string;
	digest: string;
};

export const describeGapTaxonomy = (config: GapTaxonomyConfig = DEFAULT_GAP_TAXONOMY_CONFIG): string =>
	[
		`${GAP_TAXONOMY_VERSION}: classifies each session's gap from OHLC alone into ${GAP_CLASSES.join(' / ')}`,
		`with pinned precedence; material means |gapPct| >= ${config.minGapPct}% AND gapRatio >= ${config.minGapRatio};`,
		`fill is a range fact (up: low <= prevClose); fill timing is reported UNAVAILABLE because OHLC cannot time it;`,
		`the breakout test uses the previous ${config.breakoutLookback} sessions' range; interaction scans the previous`,
		`${config.openGapLookback} sessions for still-open gaps; missing inputs yield UNAVAILABLE with a reason, never a class.`,
	].join(' ');

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * An OPEN gap = a material gap whose ORIGIN (prevClose) no later session has reached.
 * The origin — not the whole zone — is what "filled" means everywhere in this component, so
 * openness and fillState can never disagree: a later session merely trading inside the zone
 * (without reaching the origin) leaves the gap open.
 */
const isGapStillOpen = (
	sessions: SessionBar[],
	gapIndex: number,
	origin: number,
	direction: GapDirection,
	uptoIndex: number,
): boolean => {
	for (let i = gapIndex + 1; i <= uptoIndex && i < sessions.length; i += 1) {
		const s = sessions[i];
		if (direction === 'UP' ? s.low <= origin : s.high >= origin) return false; // origin revisited ⇒ filled
	}
	return true;
};

export function assessGapSeries(
	sessions: SessionBar[],
	config: Partial<GapTaxonomyConfig> = {},
): GapTaxonomyResult {
	const cfg: GapTaxonomyConfig = { ...DEFAULT_GAP_TAXONOMY_CONFIG, ...config };
	const counts: Record<string, number> = Object.fromEntries(GAP_CLASSES.map((c) => [c, 0]));

	if (!cfg.enabled) {
		return {
			version: GAP_TAXONOMY_VERSION,
			enabled: false,
			config: cfg,
			assessments: [],
			counts,
			coverage: { sessionsIn: sessions.length, assessed: 0, unavailable: 0, materialGaps: 0, filled: 0, openGaps: 0, firstSession: null, lastSession: null, firstAssessedSession: null, lastAssessedSession: null },
			reviewerSummary: describeGapTaxonomy(cfg),
			digest: JSON.stringify({ v: GAP_TAXONOMY_VERSION, enabled: false }),
		};
	}

	const ordered = [...sessions].sort((a, b) => (a.sessionDate < b.sessionDate ? -1 : a.sessionDate > b.sessionDate ? 1 : 0));
	const assessments: SessionGapAssessment[] = [];
	const materialIndexes: number[] = [];

	for (let i = 0; i < ordered.length; i += 1) {
		const s = ordered[i];
		const prior = ordered[i - 1] ?? null;
		const base: SessionGapAssessment = {
			sessionDate: s.sessionDate,
			instrument: s.instrument,
			status: 'UNAVAILABLE',
			reason: null,
			class: null,
			direction: null,
			gapAbs: null,
			gapPct: null,
			gapRatio: null,
			zone: null,
			fillState: 'UNKNOWN',
			fillTiming: 'UNAVAILABLE',
			fillTimingReason: 'OHLC cannot time a fill; intraday ticks are required and are not part of this component',
			openedOutsideLookback: null,
			olderGapInteraction: { sessionDates: [], note: 'not evaluated' },
			measures: {},
		};

		if (!isNum(s.prevClose) || s.prevClose <= 0) {
			assessments.push({ ...base, reason: 'NO_PREV_CLOSE: the prior session close is not quoted on this session row' });
			continue;
		}
		if (!isNum(s.close) || s.close <= 0) {
			assessments.push({ ...base, reason: 'NO_SESSION_CLOSE: the session close is not derivable (needs the next session quote)' });
			continue;
		}
		// gapRatio is measured against the PRIOR session's range, so a prior session is required.
		if (!prior) {
			assessments.push({ ...base, reason: 'NO_PRIOR_SESSION: the first session of a series has no prior range for gapRatio' });
			continue;
		}
		const priorRange = prior.range;
		if (!isNum(priorRange) || priorRange <= 0) {
			assessments.push({ ...base, reason: 'ZERO_PRIOR_RANGE: gapRatio is undefined for a zero-range prior session' });
			continue;
		}

		const gapAbs = s.open - s.prevClose;
		const gapPct = (gapAbs / s.prevClose) * 100;
		const gapRatio = Math.abs(gapAbs) / priorRange;
		const direction: GapDirection = gapAbs > 0 ? 'UP' : 'DOWN';
		const material = Math.abs(gapPct) >= cfg.minGapPct && gapRatio >= cfg.minGapRatio;
		const filled = direction === 'UP' ? s.low <= s.prevClose : s.high >= s.prevClose;
		const zone = direction === 'UP' ? { low: s.prevClose, high: s.open } : { low: s.open, high: s.prevClose };
		const holdsSide = direction === 'UP' ? s.close > s.open : s.close < s.open;
		const closesBeyondPrevClose = direction === 'UP' ? s.close >= s.prevClose : s.close <= s.prevClose;

		// lookback range over the preceding sessions (excluding today)
		const from = Math.max(0, i - cfg.breakoutLookback);
		const lookbackSlice = ordered.slice(from, i);
		const lookbackHigh = lookbackSlice.length ? Math.max(...lookbackSlice.map((x) => x.high)) : null;
		const lookbackLow = lookbackSlice.length ? Math.min(...lookbackSlice.map((x) => x.low)) : null;
		const openedOutsideLookback =
			lookbackSlice.length < cfg.breakoutLookback || lookbackHigh === null || lookbackLow === null
				? null
				: direction === 'UP'
					? s.open > lookbackHigh
					: s.open < lookbackLow;

		// prior trend: the previous session's own direction (requires its close)
		const priorTrendUp = prior && isNum(prior.close) ? prior.close > prior.open : null;
		const trendingIntoGap = priorTrendUp === null ? null : direction === 'UP' ? priorTrendUp : !priorTrendUp;

		let klass: GapClass;
		if (!material) {
			klass = 'NONE';
		} else {
			const prevGapIdx = materialIndexes.length ? materialIndexes[materialIndexes.length - 1] : -1;
			const prevGap = prevGapIdx >= 0 ? assessments[prevGapIdx] : null;
			const prevGapOpposite = !!prevGap && prevGap.direction !== null && prevGap.direction !== direction;
			// island: opposite previous gap AND the intervening range never overlapped the one before it
			const twoBack = prevGapIdx - 1 >= 0 ? ordered[prevGapIdx - 1] : null; // the session before the previous gap's session
			const isolated =
				!!twoBack && !!prior && !(prior.high >= twoBack.low && prior.low <= twoBack.high);

			if (prevGapOpposite && isolated) {
				klass = 'ISLAND';
			} else if (openedOutsideLookback === true && !filled && holdsSide) {
				klass = 'BREAKAWAY';
			} else if (!filled && holdsSide) {
				klass = 'RUNAWAY_CONTINUATION';
			} else if (filled && trendingIntoGap === true && !closesBeyondPrevClose) {
				klass = 'EXHAUSTION';
			} else if (filled && closesBeyondPrevClose) {
				klass = 'COMMON';
			} else {
				klass = 'UNCLASSIFIED';
			}
			materialIndexes.push(assessments.length);
		}

		// interaction with older gaps that are still open
		let interaction: SessionGapAssessment['olderGapInteraction'] = { sessionDates: [], note: 'no older open gap was intersected' };
		if (material && materialIndexes.length > 1) {
			const scanFrom = Math.max(0, materialIndexes.length - 1 - cfg.openGapLookback);
			const hits: string[] = [];
			for (let g = scanFrom; g < materialIndexes.length - 1; g += 1) {
				const older = assessments[materialIndexes[g]];
				if (!older.zone || !older.direction) continue;
				// the zone is prevClose..open for an UP gap and open..prevClose for a DOWN gap,
				// so the origin (prevClose) is the UP gap's zone.low and the DOWN gap's zone.high.
				const origin = older.direction === 'UP' ? older.zone.low : older.zone.high;
				if (!isGapStillOpen(ordered, materialIndexes[g], origin, older.direction, i - 1)) continue;
				if (s.high >= older.zone.low && s.low <= older.zone.high) hits.push(older.sessionDate);
			}
			interaction = hits.length
				? { sessionDates: hits, note: `today's range entered ${hits.length} still-open older gap zone(s)` }
				: { sessionDates: [], note: `scanned ${Math.min(cfg.openGapLookback, materialIndexes.length - 1)} older material gap(s); none still open and intersected` };
		}

		assessments.push({
			...base,
			status: 'OK',
			reason: klass === 'UNCLASSIFIED' ? 'NO_PINNED_CLASS_MATCHED: measures are reported so the case can be reviewed' : null,
			class: klass,
			direction,
			gapAbs,
			gapPct,
			gapRatio,
			zone,
			fillState: filled ? 'FILLED' : 'UNFILLED',
			openedOutsideLookback,
			olderGapInteraction: interaction,
			measures: {
				open: s.open,
				high: s.high,
				low: s.low,
				close: s.close,
				prevClose: s.prevClose,
				priorRange,
				lookbackHigh,
				lookbackLow,
				priorTrendUp: priorTrendUp === null ? null : priorTrendUp ? 1 : 0,
				// integrity check: the close implied by the previous session's own row must agree
				// with the close quoted on THIS row (a disagreement is surfaced, never averaged).
				prevCloseFromPriorSession: prior.close,
				prevCloseAgrees:
					isNum(prior.close) && isNum(s.prevClose)
						? Math.abs(prior.close - s.prevClose) < 0.01 ? 1 : 0
						: null,
			},
		});
	}

	for (const a of assessments) if (a.class) counts[a.class] += 1;

	const assessed = assessments.filter((a) => a.status === 'OK');
	const digest = JSON.stringify(
		assessments.map((a) => [a.sessionDate, a.class, a.direction, a.fillState, a.gapPct === null ? null : Number(a.gapPct.toFixed(4))]),
	);

	return {
		version: GAP_TAXONOMY_VERSION,
		enabled: true,
		config: cfg,
		assessments,
		counts,
		coverage: {
			sessionsIn: ordered.length,
			assessed: assessed.length,
			unavailable: assessments.length - assessed.length,
			materialGaps: assessed.filter((a) => a.class !== 'NONE').length,
			filled: assessed.filter((a) => a.fillState === 'FILLED').length,
			openGaps: assessed.filter((a) => a.fillState === 'UNFILLED' && a.class !== 'NONE').length,
			firstSession: ordered.length ? ordered[0].sessionDate : null,
			lastSession: ordered.length ? ordered[ordered.length - 1].sessionDate : null,
			firstAssessedSession: assessed.length ? assessed[0].sessionDate : null,
			lastAssessedSession: assessed.length ? assessed[assessed.length - 1].sessionDate : null,
		},
		reviewerSummary: describeGapTaxonomy(cfg),
		digest,
	};
}
