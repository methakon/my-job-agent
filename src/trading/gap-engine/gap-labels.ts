/**
 * GATE 8 #2 (roadmap row 87) — GAP OUTCOME LABELS WITH A PROVEN TIMESTAMP/LEAKAGE BOUNDARY.
 *
 * Single responsibility: turn each session's OUTCOME window into the six gap labels — fade, follow, midpoint
 * reach, full fill, maximum extension and time-to-target — using (a) the FROZEN pre-open features from the
 * row-85 dataset and (b) ONLY intraday observations inside that session's outcome window. PURE: no clock, no
 * I/O, no DB, no network, no AI, no randomness.
 *
 * ── THE LEAKAGE BOUNDARY (the row's whole requirement) ─────────────────────────────────────
 *   The input to a label is exactly two things, and nothing else:
 *     FEATURES  frozen at the decision cutoff — open, prevClose, priorRange, gapDirection (all from row 85;
 *               never re-read from the session tape, never any post-open column);
 *     OUTCOME   observations with openMs <= instantMs <= closeMs of the SAME sessionDate. Observations
 *               outside that window (or from another session) are IGNORED and COUNTED (`outsideWindowIgnored`).
 *   `detectLabelLeakage()` re-checks this independently, and the gate-8 test runs it over the archive: it
 *   returns a violation for any label whose window is malformed, whose features are not the frozen subset, or
 *   whose outcome used an out-of-window observation. A label is never computed from post-decision FEATURES.
 *
 * ── PINNED DEFINITION (labels, units, window, edges) ───────────────────────────────────────
 *   For a gap of direction d with open O and origin P (prevClose) and prior range R:
 *     midpoint      = (O + P) / 2
 *     follow        = 1 when the FAVOURABLE excursion beyond O reaches R (the row-40 structural yardstick),
 *                     else 0 — a structural bound, not a tuned threshold
 *     fade          = 1 when price reaches the origin P (the gap is fully filled) within the window, else 0
 *     midpointReach = 1 when price reaches the midpoint, else 0
 *     fullFill      = 1 when price reaches the origin P, else 0      (same event as `fade`, kept separate by request)
 *     maximumExtensionPoints = the largest favourable excursion beyond O (index points, >= 0)
 *     timeToTargetMs = ms from the first in-window observation to the first reach of P, or null if never
 *   UNITS: prices/extension in index points; times in ms; labels are 0/1.
 *
 * ── MISSING / DEGENERATE DATA → a safe explicit state ───────────────────────────────────────
 *   NO_FEATURES (the frozen open/prevClose/priorRange/direction are absent) / NO_PATH / NO_POINTS /
 *   NO_SESSION_DATE — null labels with a closed-vocabulary token; an outcome is never fabricated from a
 *   partial or out-of-window tape.
 *
 * RESEARCH / SHADOW ONLY: nothing in production imports this module (asserted by test); no state is written and
 * no decision, order or risk path reads it. Versioned: gaplabel-v1.
 */

import { sessionMidnightMs } from '../pre-open/pre-open-alignment';
import { MARKET_OPEN_START_MIN, MARKET_CLOSE_MIN } from '../pre-open/pre-open-session';
import { GapDatasetReport } from './gap-dataset';
import { IntradaySessionPath } from './gap-candidates';

export const GAP_LABEL_VERSION = 'gaplabel-v1';

/** Labels may read the outcome only inside this window; features are frozen at the cutoff. */
export const GAP_LABEL_FEATURE_CUTOFF = 'OPEN (09:15 IST)';

export type GapLabelStatus = 'OK' | 'UNAVAILABLE' | 'DISABLED';
export const GAP_LABEL_STATUSES: readonly GapLabelStatus[] = ['OK', 'UNAVAILABLE', 'DISABLED'];

/** Closed, published refusal vocabulary (declaration order is the canonical order). */
export const GAP_LABEL_REFUSALS = ['NO_SESSION_DATE', 'NO_FEATURES', 'NO_PATH', 'NO_POINTS'] as const;
export type GapLabelRefusal = (typeof GAP_LABEL_REFUSALS)[number];

/** Closed leakage-violation vocabulary for the audit. */
export const LEAKAGE_CODES = ['BAD_WINDOW', 'OUT_OF_WINDOW_OBSERVATION', 'FEATURE_NOT_FROZEN', 'WINDOW_AFTER_CLOSE'] as const;
export type LeakageCode = (typeof LEAKAGE_CODES)[number];

export interface GapLabelConfig {
	enabled: boolean;
}

export const DEFAULT_GAP_LABEL_CONFIG: GapLabelConfig = { enabled: true };

export const GAP_LABEL_SPEC = {
	feature: 'GapLabels',
	version: GAP_LABEL_VERSION,
	question: 'Given the frozen features and the session outcome window, what are the six gap labels?',
	features: 'frozen at OPEN from row 85: open, prevClose, priorRange, gapDirection — no other, no post-open column',
	outcomeWindow: 'observations with openMs <= instantMs <= closeMs of the SAME sessionDate; anything else is ignored and counted',
	labels: 'fade (origin reached), follow (favourable excursion >= priorRange), midpointReach, fullFill, maximumExtensionPoints, timeToTargetMs',
	units: 'prices/extension in index points; times in ms; labels are 0/1',
	leakage: 'detectLabelLeakage() independently re-checks the window and the frozen-feature subset; the gate-8 test runs it over the archive',
	refuses: [...GAP_LABEL_REFUSALS] as string[],
	missingData: 'absent frozen features, no path/points or an unusable date ⇒ null labels with a closed-vocabulary token',
};

export const describeGapLabels = (c: GapLabelConfig = DEFAULT_GAP_LABEL_CONFIG): string =>
	[
		`${GAP_LABEL_VERSION}: six gap outcome labels from FROZEN pre-open features and the in-window session tape.`,
		`fade/fullFill = price reached the gap origin; follow = favourable excursion >= priorRange (structural);`,
		`midpointReach, maximumExtensionPoints and timeToTargetMs complete the set.`,
		`Features are frozen at ${GAP_LABEL_FEATURE_CUTOFF}; observations outside the outcome window are ignored and counted,`,
		`and detectLabelLeakage() re-checks the boundary. enabled=${c.enabled}.`,
	].join(' ');

export interface GapLabels {
	fade: 0 | 1;
	follow: 0 | 1;
	midpointReach: 0 | 1;
	fullFill: 0 | 1;
	maximumExtensionPoints: number;
	timeToTargetMs: number | null;
}

export interface GapLabelRow {
	sessionDate: string;
	instrument: string;
	status: GapLabelStatus;
	reason: GapLabelRefusal | null;
	reasonDetail: string | null;
	cutoff: string;
	window: { openMs: number | null; closeMs: number | null; observationsUsed: number; outsideWindowIgnored: number };
	labels: GapLabels | null;
}

export interface GapLabelReport {
	version: string;
	enabled: boolean;
	config: GapLabelConfig;
	spec: typeof GAP_LABEL_SPEC;
	cutoff: string;
	upstreamDatasetVersion: string | null;
	rows: GapLabelRow[];
	counts: Record<GapLabelStatus, number>;
	refusalCounts: Record<GapLabelRefusal, number>;
	coverage: { datasetRowsIn: number; ok: number; unavailable: number; disabled: number; fade: number; follow: number; midpointReach: number; fullFill: number; observationsIgnored: number };
	reviewerSummary: string;
	digest: string;
}

export interface LeakageViolation {
	sessionDate: string;
	instrument: string;
	code: LeakageCode;
	detail: string;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const key = (r: { sessionDate: string; instrument: string }): string => `${r.sessionDate}|${r.instrument}`;

export function buildGapLabels(dataset: GapDatasetReport, paths: IntradaySessionPath[], config: Partial<GapLabelConfig> = {}): GapLabelReport {
	const cfg: GapLabelConfig = { ...DEFAULT_GAP_LABEL_CONFIG, ...config };
	const pathIndex = new Map<string, IntradaySessionPath>();
	for (const p of paths ?? []) pathIndex.set(key(p), p);

	const rows: GapLabelRow[] = (dataset?.rows ?? []).map((d) => {
		const base = { sessionDate: d.sessionDate, instrument: d.instrument, cutoff: GAP_LABEL_FEATURE_CUTOFF, window: { openMs: null as number | null, closeMs: null as number | null, observationsUsed: 0, outsideWindowIgnored: 0 } };
		const no = (reason: GapLabelRefusal, detail: string): GapLabelRow => ({ ...base, status: 'UNAVAILABLE', reason, reasonDetail: detail, labels: null });

		if (!cfg.enabled) return { ...base, status: 'DISABLED' as const, reason: null, reasonDetail: 'the component is disabled; no label was computed for this row', labels: null };
		if (!/^\d{4}-\d{2}-\d{2}$/.test(String(d.sessionDate))) return no('NO_SESSION_DATE', `"${d.sessionDate}" is not a usable session date`);
		const f = d.features;
		// FROZEN FEATURES ONLY: open, prevClose, priorRange and gapDirection come from row 85.
		if (!f || !isNum(f.open) || !isNum(f.prevClose) || !isNum(f.priorRange) || (f.gapDirection !== 'UP' && f.gapDirection !== 'DOWN')) {
			return no('NO_FEATURES', 'the frozen features (open, prevClose, priorRange, gapDirection) are not all present, so the outcome cannot be measured against them');
		}
		const midnight = sessionMidnightMs(d.sessionDate);
		if (midnight === null) return no('NO_SESSION_DATE', `"${d.sessionDate}" is not a usable session date`);
		const openMs = midnight + MARKET_OPEN_START_MIN * 60_000;
		const closeMs = midnight + MARKET_CLOSE_MIN * 60_000;
		base.window.openMs = openMs;
		base.window.closeMs = closeMs;

		const path = pathIndex.get(key(d));
		if (!path) return no('NO_PATH', 'no intraday path was supplied for this session');
		const all = path.points ?? [];
		if (!all.length) return no('NO_POINTS', 'the path holds no observations');
		// OUTCOME WINDOW: only this session's observations inside [open, close] may be used.
		const inWindow = all.filter((p) => isNum(p.instantMs) && isNum(p.price) && p.price > 0 && p.instantMs >= openMs && p.instantMs <= closeMs).sort((a, b) => a.instantMs - b.instantMs);
		base.window.outsideWindowIgnored = all.length - inWindow.length;
		if (!inWindow.length) return no('NO_POINTS', 'the path holds no observation inside the session outcome window');
		base.window.observationsUsed = inWindow.length;

		const open = f.open as number;
		const origin = f.prevClose as number;
		const priorRange = f.priorRange as number;
		const direction = f.gapDirection as 'UP' | 'DOWN';
		const midpoint = (open + origin) / 2;
		const favourable = (price: number): number => (direction === 'UP' ? price - open : open - price);
		const reached = (price: number, level: number): boolean => (direction === 'UP' ? price <= level : price >= level);

		const startMs = inWindow[0].instantMs;
		let maximumExtensionPoints = 0;
		let fullFill = false;
		let midpointReach = false;
		let timeToTargetMs: number | null = null;
		for (const p of inWindow) {
			maximumExtensionPoints = Math.max(maximumExtensionPoints, favourable(p.price));
			if (reached(p.price, midpoint)) midpointReach = true;
			if (reached(p.price, origin)) {
				fullFill = true;
				if (timeToTargetMs === null) timeToTargetMs = p.instantMs - startMs;
			}
		}
		const labels: GapLabels = {
			fade: fullFill ? 1 : 0,
			follow: maximumExtensionPoints >= priorRange ? 1 : 0,
			midpointReach: midpointReach ? 1 : 0,
			fullFill: fullFill ? 1 : 0,
			maximumExtensionPoints: Number(maximumExtensionPoints.toFixed(6)),
			timeToTargetMs,
		};
		return { ...base, status: 'OK' as const, reason: null, reasonDetail: null, labels };
	});

	const ordered = [...rows].sort((x, y) => {
		if (x.sessionDate !== y.sessionDate) return x.sessionDate < y.sessionDate ? -1 : 1;
		return x.instrument < y.instrument ? -1 : x.instrument > y.instrument ? 1 : 0;
	});

	const counts: Record<GapLabelStatus, number> = { OK: 0, UNAVAILABLE: 0, DISABLED: 0 };
	const refusalCounts = Object.fromEntries(GAP_LABEL_REFUSALS.map((r) => [r, 0])) as Record<GapLabelRefusal, number>;
	let fade = 0, follow = 0, midpointReach = 0, fullFill = 0, observationsIgnored = 0;
	for (const r of ordered) {
		counts[r.status] += 1;
		if (r.reason) refusalCounts[r.reason] += 1;
		observationsIgnored += r.window.outsideWindowIgnored;
		if (r.labels) {
			fade += r.labels.fade; follow += r.labels.follow; midpointReach += r.labels.midpointReach; fullFill += r.labels.fullFill;
		}
	}

	return {
		version: GAP_LABEL_VERSION,
		enabled: cfg.enabled,
		config: cfg,
		spec: GAP_LABEL_SPEC,
		cutoff: GAP_LABEL_FEATURE_CUTOFF,
		upstreamDatasetVersion: dataset?.version ?? null,
		rows: ordered,
		counts,
		refusalCounts,
		coverage: { datasetRowsIn: (dataset?.rows ?? []).length, ok: counts.OK, unavailable: counts.UNAVAILABLE, disabled: counts.DISABLED, fade, follow, midpointReach, fullFill, observationsIgnored },
		reviewerSummary: describeGapLabels(cfg),
		digest: JSON.stringify(ordered.map((r) => [r.sessionDate, r.instrument, r.status, r.reason, r.labels ? [r.labels.fade, r.labels.follow, r.labels.midpointReach, r.labels.fullFill, r.labels.maximumExtensionPoints, r.labels.timeToTargetMs] : null])),
	};
}

/**
 * Independent leakage audit (the row's timestamp test, callable from a test or a replay):
 *   * every labelled row's window must exist and end at/before the session close (WINDOW_AFTER_CLOSE / BAD_WINDOW);
 *   * the frozen features used must be the row-85 subset (FEATURE_NOT_FROZEN);
 *   * every observation the path offers inside the reported window count must be within [open, close] — an
 *     observation outside it that was nonetheless counted is OUT_OF_WINDOW_OBSERVATION.
 * It is deliberately independent of buildGapLabels' own filtering: it re-derives the window from the dates.
 */
export function detectLabelLeakage(labelReport: GapLabelReport, paths: IntradaySessionPath[]): LeakageViolation[] {
	const pathIndex = new Map<string, IntradaySessionPath>();
	for (const p of paths ?? []) pathIndex.set(key(p), p);
	const violations: LeakageViolation[] = [];
	for (const r of labelReport?.rows ?? []) {
		if (r.status !== 'OK') continue;
		if (!isNum(r.window.openMs) || !isNum(r.window.closeMs) || r.window.openMs >= r.window.closeMs) {
			violations.push({ sessionDate: r.sessionDate, instrument: r.instrument, code: 'BAD_WINDOW', detail: `window is malformed (${r.window.openMs}..${r.window.closeMs})` });
			continue;
		}
		const midnight = sessionMidnightMs(r.sessionDate);
		const expectedClose = midnight === null ? null : midnight + MARKET_CLOSE_MIN * 60_000;
		if (expectedClose !== null && r.window.closeMs > expectedClose) {
			violations.push({ sessionDate: r.sessionDate, instrument: r.instrument, code: 'WINDOW_AFTER_CLOSE', detail: `window ends ${r.window.closeMs} after the session close ${expectedClose}` });
		}
		if (r.window.observationsUsed <= 0) {
			violations.push({ sessionDate: r.sessionDate, instrument: r.instrument, code: 'BAD_WINDOW', detail: 'an OK label reports no observations used' });
		}
		const path = pathIndex.get(key(r));
		if (path) {
			// every observation counted must be inside the window; the audit recomputes from the raw path
			const inside = (path.points ?? []).filter((p) => isNum(p.instantMs) && p.instantMs >= (r.window.openMs as number) && p.instantMs <= (r.window.closeMs as number)).length;
			if (inside !== r.window.observationsUsed) {
				violations.push({ sessionDate: r.sessionDate, instrument: r.instrument, code: 'OUT_OF_WINDOW_OBSERVATION', detail: `used ${r.window.observationsUsed} observation(s) but only ${inside} lie inside the window` });
			}
		}
	}
	return violations;
}
