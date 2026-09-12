/**
 * GATE 5 #5 (roadmap row 54) — TRACK SPREAD AND SPREAD SHOCK.
 *
 * Single responsibility: from a series of L1 quotes, report each quote's spread and how far it sits from the
 * BASELINE spread built from that instrument's immediately PRECEDING quotes — over an explicit observation
 * window, with the sample size and coverage stated, and a safe explicit state when the baseline is not yet
 * established. PURE: no clock, no I/O, no DB, no network, no AI, no randomness.
 *
 * ── PINNED DEFINITION (metric, window, units, edges) ───────────────────────────────────────
 *   spread          = ask − bid                       (index points)
 *   mid             = (bid + ask) / 2
 *   relativeSpread  = spread / mid                    (dimensionless)
 *   baseline        = the MEDIAN spread of the PRIOR `baselineWindow` quotes for the SAME instrument in the
 *                     SAME session, ordered by their own timestamps — never including the quote being judged
 *                     and never a later quote (so there is no look-ahead by construction).
 *   spreadShockAbs  = spread − baseline               (index points)
 *   spreadShockRatio= spread / baseline               (dimensionless; > 1 = wider than usual)
 *
 *   WINDOW: quotes are grouped by (instrumentKey, sessionDate) and ordered by source timestamp (then the
 *   echoed sequence number and the quote's own values, so the order is total and deterministic). A quote with
 *   no usable timestamp cannot be placed in the series: it is reported with the spread but NO shock baseline.
 *   UNITS: prices/spread in index points; ratios dimensionless.
 *
 * ── MISSING / DEGENERATE DATA → a safe explicit state ───────────────────────────────────────
 *   NO_QUOTES / NO_SESSION_DATE / INVALID_QUOTE (bid/ask absent, non-finite or <= 0) / CROSSED_BOOK (bid > ask)
 *   — null values with a closed-vocabulary token.
 *   INSUFFICIENT_BASELINE / NO_TIMESTAMP — the SPREAD is still reported and the shock is null with an explicit
 *   reason; a shock is never fabricated from too few prior quotes.
 *
 * RESEARCH / SHADOW ONLY: nothing in production imports this module (asserted by test); no state is written
 * and no decision, order or risk path reads it. Versioned: spreadshock-v1.
 */

export const SPREAD_SHOCK_VERSION = 'spreadshock-v1';

export type SpreadStatus = 'OK' | 'UNAVAILABLE' | 'DISABLED';
export const SPREAD_STATUSES: readonly SpreadStatus[] = ['OK', 'UNAVAILABLE', 'DISABLED'];

/** Closed, published refusal vocabulary for a quote that cannot yield a spread (declaration order canonical). */
export const SPREAD_REFUSALS = ['NO_QUOTES', 'NO_SESSION_DATE', 'INVALID_QUOTE', 'CROSSED_BOOK'] as const;
export type SpreadRefusal = (typeof SPREAD_REFUSALS)[number];

/** Why a spread is known but its shock is not. Closed vocabulary. */
export const SHOCK_REASONS = ['NO_TIMESTAMP', 'INSUFFICIENT_BASELINE'] as const;
export type ShockReason = (typeof SHOCK_REASONS)[number];

export type QuoteBasis = 'EVENT' | 'SNAPSHOT' | 'UNKNOWN';

export interface SpreadQuote {
	instrumentKey: string;
	source: string;
	/** The session the quote belongs to; a baseline never crosses sessions. */
	sessionDate: string;
	bid: number | null;
	ask: number | null;
	/** Provenance, echoed through unchanged (never used to compute). */
	sourceTimestamp?: Date | string | null;
	receivedTimestamp?: Date | string | null;
	sequenceNumber?: number | null;
	dataQuality?: string | null;
	basis?: QuoteBasis;
}

export interface SpreadShockConfig {
	enabled: boolean;
	/** How many PRIOR quotes form the baseline window (a window length, not a fitted threshold). */
	baselineWindow: number;
	/** Minimum prior quotes before a shock is reported at all. */
	minBaseline: number;
}

export const DEFAULT_SPREAD_SHOCK_CONFIG: SpreadShockConfig = { enabled: true, baselineWindow: 20, minBaseline: 5 };

export const SPREAD_SHOCK_SPEC = {
	feature: 'SpreadAndShock',
	version: SPREAD_SHOCK_VERSION,
	question: 'What is each quote spread, and how far is it from its instrument recent baseline?',
	metric: 'spread = ask − bid; relativeSpread = spread/mid; baseline = MEDIAN spread of the prior window; shockAbs = spread − baseline; shockRatio = spread/baseline',
	window:
		'grouped by (instrumentKey, sessionDate), ordered by source timestamp; the baseline is the median of the PRIOR ' +
		'baselineWindow quotes only — never the quote itself and never a later one (no look-ahead)',
	units: 'prices and spread in index points; ratios dimensionless',
	thresholds: 'none — the ratio and the difference are reported; no shock is declared "significant" here',
	refuses: [...SPREAD_REFUSALS] as string[],
	shockUnavailable: 'a quote with no usable timestamp, or with fewer than minBaseline prior quotes, reports its spread with a null shock and one of ' + SHOCK_REASONS.join(' / '),
	provenance: 'source, source/received timestamps, sequence number, data quality and the EVENT/SNAPSHOT basis are echoed through unchanged',
};

export const describeSpreadShock = (c: SpreadShockConfig = DEFAULT_SPREAD_SHOCK_CONFIG): string =>
	[
		`${SPREAD_SHOCK_VERSION}: spread = ask − bid and relativeSpread = spread/mid per quote,`,
		`with spreadShockAbs/Ratio against the MEDIAN spread of the prior ${c.baselineWindow} quotes for the same instrument and session.`,
		`The baseline uses only PRIOR quotes, so there is no look-ahead; fewer than ${c.minBaseline} prior quotes reports`,
		`the spread with a null shock (INSUFFICIENT_BASELINE) rather than a fabricated one. No threshold is tuned. enabled=${c.enabled}.`,
	].join(' ');

export interface SpreadValues {
	mid: number;
	spread: number;
	relativeSpread: number;
}

export interface SpreadShockValues {
	baselineSpread: number;
	baselineCount: number;
	spreadShockAbs: number;
	spreadShockRatio: number;
}

export interface SpreadObservation {
	instrumentKey: string;
	source: string;
	sessionDate: string | null;
	status: SpreadStatus;
	reason: SpreadRefusal | null;
	reasonDetail: string | null;
	basis: QuoteBasis;
	values: SpreadValues | null;
	shock: SpreadShockValues | null;
	shockReason: ShockReason | null;
	evidence: {
		bid: number | null;
		ask: number | null;
		sourceTimestamp: string | null;
		receivedTimestamp: string | null;
		sequenceNumber: number | null;
		dataQuality: string | null;
	};
}

export interface SpreadShockReport {
	version: string;
	enabled: boolean;
	config: SpreadShockConfig;
	spec: typeof SPREAD_SHOCK_SPEC;
	observations: SpreadObservation[];
	counts: Record<SpreadStatus, number>;
	refusalCounts: Record<SpreadRefusal, number>;
	shockReasonCounts: Record<ShockReason, number>;
	/** Distribution of the OK rows' spreadShockRatio over documented bins; descriptive only. */
	shockRatioBins: { label: string; n: number }[];
	coverage: {
		quotesIn: number;
		ok: number;
		unavailable: number;
		disabled: number;
		/** Rows for which a baseline was available and a shock reported — the sample size of the shock metric. */
		withShock: number;
		sessions: number;
		instruments: number;
	};
	reviewerSummary: string;
	digest: string;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const round6 = (v: number): number => Number(v.toFixed(6));
const tsMs = (v: Date | string | null | undefined): number | null => {
	if (v === null || v === undefined) return null;
	if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.getTime();
	const t = Date.parse(String(v));
	return Number.isFinite(t) ? t : null;
};
const isoOrNull = (v: Date | string | null | undefined): string | null => {
	const t = tsMs(v);
	return t === null ? null : new Date(t).toISOString();
};
/** Median of a non-empty numeric array (even count ⇒ mean of the two middle values). Deterministic. */
const median = (xs: number[]): number => {
	const s = [...xs].sort((a, b) => a - b);
	const m = Math.floor(s.length / 2);
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export function evaluateSpreadShock(quotes: SpreadQuote[], config: Partial<SpreadShockConfig> = {}): SpreadShockReport {
	const cfg: SpreadShockConfig = { ...DEFAULT_SPREAD_SHOCK_CONFIG, ...config };

	// 1) validate + spread per quote
	const rows: SpreadObservation[] = (quotes ?? []).map((q) => {
		const evidence = {
			bid: isNum(q?.bid) ? (q.bid as number) : null,
			ask: isNum(q?.ask) ? (q.ask as number) : null,
			sourceTimestamp: isoOrNull(q?.sourceTimestamp),
			receivedTimestamp: isoOrNull(q?.receivedTimestamp),
			sequenceNumber: isNum(q?.sequenceNumber) ? (q.sequenceNumber as number) : null,
			dataQuality: q?.dataQuality ?? null,
		};
		const common = {
			instrumentKey: q?.instrumentKey ?? '',
			source: q?.source ?? '',
			sessionDate: q?.sessionDate ?? null,
			basis: (q?.basis ?? 'UNKNOWN') as QuoteBasis,
			evidence,
		};
		const no = (reason: SpreadRefusal, detail: string): SpreadObservation => ({ ...common, status: 'UNAVAILABLE', reason, reasonDetail: detail, values: null, shock: null, shockReason: null });
		if (!cfg.enabled) return { ...common, status: 'DISABLED', reason: null, reasonDetail: 'the component is disabled; no spread was computed for this quote', values: null, shock: null, shockReason: null };
		if (!q || typeof q !== 'object') return no('NO_QUOTES', 'no observation was supplied');
		if (!/^\d{4}-\d{2}-\d{2}$/.test(String(q.sessionDate ?? ''))) return no('NO_SESSION_DATE', `"${q.sessionDate}" is not a usable YYYY-MM-DD session date`);
		const bid = isNum(q.bid) ? q.bid : null;
		const ask = isNum(q.ask) ? q.ask : null;
		if (bid === null || ask === null || bid <= 0 || ask <= 0) return no('INVALID_QUOTE', `bid and ask must both be finite and > 0 (bid=${bid}, ask=${ask})`);
		if (bid > ask) return no('CROSSED_BOOK', `bid ${bid} > ask ${ask}`);
		const mid = (bid + ask) / 2;
		const spread = ask - bid;
		return { ...common, status: 'OK', reason: null, reasonDetail: null, values: { mid: round6(mid), spread: round6(spread), relativeSpread: round6(spread / mid) }, shock: null, shockReason: null };
	});

	// 2) shock: per (instrument, session), order deterministically, baseline = median of the PRIOR window only
	const groups = new Map<string, SpreadObservation[]>();
	for (const r of rows) if (r.status === 'OK' && r.sessionDate) {
		const k = `${r.instrumentKey}|${r.sessionDate}`;
		if (!groups.has(k)) groups.set(k, []);
		groups.get(k)!.push(r);
	}
	for (const list of groups.values()) {
		list.sort((a, b) => {
			const ta = tsMs(a.evidence.sourceTimestamp);
			const tb = tsMs(b.evidence.sourceTimestamp);
			// rows with no timestamp cannot be ordered: they are handled below and kept out of the series
			if (ta === null || tb === null) return ta === null && tb === null ? 0 : ta === null ? 1 : -1;
			if (ta !== tb) return ta - tb;
			const sa = a.evidence.sequenceNumber ?? -1;
			const sb = b.evidence.sequenceNumber ?? -1;
			if (sa !== sb) return sa - sb;
			const ka = `${a.evidence.bid}|${a.evidence.ask}`;
			const kb = `${b.evidence.bid}|${b.evidence.ask}`;
			return ka < kb ? -1 : ka > kb ? 1 : 0;
		});
		const window: number[] = [];
		for (const r of list) {
			if (tsMs(r.evidence.sourceTimestamp) === null) { r.shockReason = 'NO_TIMESTAMP'; continue; }
			if (window.length >= cfg.minBaseline) {
				const baseline = median(window.slice(-cfg.baselineWindow));
				const spread = (r.values as SpreadValues).spread;
				r.shock = { baselineSpread: round6(baseline), baselineCount: Math.min(window.length, cfg.baselineWindow), spreadShockAbs: round6(spread - baseline), spreadShockRatio: round6(baseline > 0 ? spread / baseline : 0) };
			} else {
				r.shockReason = 'INSUFFICIENT_BASELINE';
			}
			window.push((r.values as SpreadValues).spread);
		}
	}

	// 3) canonical order + counts
	const ordered = [...rows].sort((a, b) => {
		const keyOf = (r: SpreadObservation): string => `${r.sessionDate ?? ''}|${r.instrumentKey}|${r.source}|${r.evidence.sourceTimestamp ?? ''}|${r.evidence.sequenceNumber ?? ''}|${r.evidence.bid ?? ''}|${r.evidence.ask ?? ''}`;
		const ka = keyOf(a);
		const kb = keyOf(b);
		return ka < kb ? -1 : ka > kb ? 1 : 0;
	});
	const counts: Record<SpreadStatus, number> = { OK: 0, UNAVAILABLE: 0, DISABLED: 0 };
	const refusalCounts = Object.fromEntries(SPREAD_REFUSALS.map((r) => [r, 0])) as Record<SpreadRefusal, number>;
	const shockReasonCounts = Object.fromEntries(SHOCK_REASONS.map((r) => [r, 0])) as Record<ShockReason, number>;
	const binDefs = [
		{ label: '< 0.5', test: (x: number) => x < 0.5 },
		{ label: '0.5–0.8', test: (x: number) => x >= 0.5 && x < 0.8 },
		{ label: '0.8–1.2', test: (x: number) => x >= 0.8 && x < 1.2 },
		{ label: '1.2–2', test: (x: number) => x >= 1.2 && x < 2 },
		{ label: '2–4', test: (x: number) => x >= 2 && x < 4 },
		{ label: '>= 4', test: (x: number) => x >= 4 },
	];
	const bins = binDefs.map((b) => ({ label: b.label, n: 0 }));
	let withShock = 0;
	const sessions = new Set<string>();
	const instruments = new Set<string>();
	for (const r of ordered) {
		counts[r.status] += 1;
		if (r.reason) refusalCounts[r.reason] += 1;
		if (r.shockReason) shockReasonCounts[r.shockReason] += 1;
		if (r.sessionDate) sessions.add(r.sessionDate);
		if (r.instrumentKey) instruments.add(r.instrumentKey);
		if (r.shock) {
			withShock += 1;
			const x = r.shock.spreadShockRatio;
			const i = binDefs.findIndex((b) => b.test(x));
			if (i >= 0) bins[i].n += 1;
		}
	}

	return {
		version: SPREAD_SHOCK_VERSION,
		enabled: cfg.enabled,
		config: cfg,
		spec: SPREAD_SHOCK_SPEC,
		observations: ordered,
		counts,
		refusalCounts,
		shockReasonCounts,
		shockRatioBins: bins,
		coverage: { quotesIn: ordered.length, ok: counts.OK, unavailable: counts.UNAVAILABLE, disabled: counts.DISABLED, withShock, sessions: sessions.size, instruments: instruments.size },
		reviewerSummary: describeSpreadShock(cfg),
		digest: JSON.stringify(ordered.map((r) => [r.sessionDate, r.instrumentKey, r.source, r.status, r.reason, r.shockReason, r.values ? r.values.spread : null, r.shock ? r.shock.spreadShockRatio : null])),
	};
}
