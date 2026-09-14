/**
 * ROW 57 — GATE 5 #8 "Track trade intensity / activity regime."
 *
 * doneWhen: "A report can reproduce the metric from archived data and shows the sample size/coverage used."
 * instr:    "Define the observation window and metric before collecting results. Record both the
 *            measurement and the sample/data-quality context so later comparisons are fair."
 *
 * PINNED SEMANTICS (tradeint-v1)
 *   Observation window : one INSTRUMENT SESSION = (instrumentKey, sessionDate). Consecutive snapshots of
 *                        that session ordered by (ts, sequenceNumber). The window actually observed
 *                        (first→last snapshot) is REPORTED per session — market hours are never assumed,
 *                        because the archive is not guaranteed to lie inside them.
 *   Metric             : SNAPSHOT-DERIVED trade intensity, I = deltaVolume × 60 / dt, expressed in
 *                        CONTRACTS PER MINUTE, where deltaVolume is the difference of the ARCHIVED
 *                        CUMULATIVE `volume` field between two consecutive snapshots of the same
 *                        instrument session, and dt is the seconds between their timestamps.
 *                        This is an AVERAGE over the snapshot gap — it is NOT a trade-tape intensity and
 *                        no per-print timing is implied.
 *   Activity regime    : label of each interval against the MEDIAN of that instrument session's PRIOR
 *                        intervals only (no look-ahead): QUIET (I < quietFactor*median), NORMAL,
 *                        ACTIVE (I > activeFactor*median). Needs >= minHistory prior intervals.
 *
 * REFUSALS (closed vocabulary — every refusal carries null intensity AND null regime, never a
 * fabricated 0, because "no progression recorded" is not the same fact as "no trading happened"):
 *   NO_VOLUME            this or the previous snapshot has no numeric `volume`
 *   NO_TIMESTAMP         this or the previous snapshot has no usable forward-ordered timestamp (dt <= 0)
 *   NO_VOLUME_PROGRESS   cumulative volume did NOT advance (delta = 0): the source carries no
 *                        per-interval activity, so NO intensity exists
 *   VOLUME_RESET         cumulative volume went BACKWARDS: session/restart boundary, refused not guessed
 *   INSUFFICIENT_HISTORY < minHistory prior intervals => no regime label (intensity is still kept)
 *   NO_SESSION_DATE      the snapshot cannot be attributed to a session date
 *   SOURCE_MIXED         the same instrumentKey+sessionDate carries more than one source, so the
 *                        cumulative series is not one continuous series => the whole session is refused
 *
 * RESEARCH / SHADOW ONLY — never traded, never imported by production, never marks a roadmap row DONE.
 * PURE: no clock, no I/O, no DB, no network, no AI, no randomness. Every input is an argument.
 * Provenance is echoed verbatim; no value is invented, repaired, normalised or extrapolated.
 */

export const TRADE_INTENSITY_VERSION = 'tradeint-v1';

export type IntensityStatus = 'OK' | 'UNAVAILABLE';
export type ActivityRegime = 'QUIET' | 'NORMAL' | 'ACTIVE';
export type IntensityRefusal =
	| 'NO_VOLUME'
	| 'NO_TIMESTAMP'
	| 'NO_VOLUME_PROGRESS'
	| 'VOLUME_RESET'
	| 'INSUFFICIENT_HISTORY'
	| 'NO_SESSION_DATE'
	| 'SOURCE_MIXED';

export const INTENSITY_REFUSALS: readonly IntensityRefusal[] = [
	'NO_VOLUME',
	'NO_TIMESTAMP',
	'NO_VOLUME_PROGRESS',
	'VOLUME_RESET',
	'INSUFFICIENT_HISTORY',
	'NO_SESSION_DATE',
	'SOURCE_MIXED',
];

export interface IntensitySnapshot {
	instrumentKey: string;
	source: string;
	sessionDate?: string | null;
	ts?: string | Date | null;
	volume?: number | null;
	sequenceNumber?: number | null;
}

export interface TradeIntensityConfig {
	enabled: boolean;
	minHistory: number;
	quietFactor: number;
	activeFactor: number;
}

export const DEFAULT_TRADE_INTENSITY_CONFIG: TradeIntensityConfig = {
	enabled: true,
	minHistory: 5,
	quietFactor: 0.5,
	activeFactor: 2,
};

export interface IntensityObservation {
	instrumentKey: string;
	source: string;
	sessionDate: string;
	fromTs: string | null;
	toTs: string | null;
	dtSeconds: number | null;
	deltaVolume: number | null;
	intensity: number | null;
	status: IntensityStatus;
	reason: IntensityRefusal | null;
	regime: ActivityRegime | null;
	regimeReason: 'INSUFFICIENT_HISTORY' | null;
	baselineMedian: number | null;
	priorObservations: number;
}

export interface SessionCoverage {
	source: string;
	instrumentKey: string;
	sessionDate: string;
	firstTs: string | null;
	lastTs: string | null;
	snapshots: number;
	intervals: number;
	decided: number;
	positiveDeltas: number;
	zeroDeltas: number;
	negativeDeltas: number;
	medianDtSeconds: number | null;
	regimeCounts: Record<ActivityRegime, number>;
	refusedForSourceMix: boolean;
	insideMarketHoursIst: boolean;
}

export interface TradeIntensityReport {
	version: string;
	enabled: boolean;
	config: TradeIntensityConfig;
	spec: typeof TRADE_INTENSITY_SPEC;
	snapshotsIn: number;
	observations: IntensityObservation[];
	counts: { sessions: number; intervals: number; decided: number; refused: number };
	refusalCounts: Record<string, number>;
	regimeCounts: Record<ActivityRegime, number>;
	sessions: SessionCoverage[];
	sourceProgression: Record<string, { snapshots: number; positiveDeltas: number; zeroDeltas: number; negativeDeltas: number; advances: boolean }>;
	coverage: {
		sessions: number;
		instruments: number;
		sources: string[];
		observedWindows: Array<{ source: string; sessionDate: string; firstTs: string | null; lastTs: string | null }>;
		observedWindowOutsideMarketHours: number;
		medianDtSecondsAcrossSessions: number | null;
	};
	reviewerSummary: string;
	digest: string;
}

export const TRADE_INTENSITY_SPEC = {
	feature: 'TradeIntensityAndActivityRegime',
	version: TRADE_INTENSITY_VERSION,
	roadmapRow: 'GATE 5 #8 / row 57',
	question: 'How intense is trading activity per instrument session, and is a given interval quiet, normal or active?',
	observationWindow: 'one instrument session = (instrumentKey, sessionDate); consecutive snapshots ordered by ts then sequenceNumber; the observed first→last window is reported per session and market hours are never assumed',
	metric: 'intensity = deltaVolume × 60 / dtSeconds  (archived CUMULATIVE delta over the snapshot gap; contracts per minute)',
	units: 'contracts per minute',
	regime: 'against the median of the PRIOR intervals of the same instrument session only: QUIET < quietFactor×median, NORMAL otherwise, ACTIVE > activeFactor×median',
	edges: 'deltaVolume = 0 ⇒ NO_VOLUME_PROGRESS (no intensity exists); deltaVolume < 0 ⇒ VOLUME_RESET; dt ≤ 0 ⇒ NO_TIMESTAMP; non-numeric volume ⇒ NO_VOLUME; mixed sources in one session ⇒ SOURCE_MIXED; < minHistory priors ⇒ INSUFFICIENT_HISTORY for the regime only',
	refuses: INTENSITY_REFUSALS,
	missingData: 'every refusal keeps intensity = null AND regime = null; nothing is interpolated, carried across sessions or defaulted to zero',
	provenance: 'source, instrumentKey, sessionDate and timestamps are echoed verbatim; the report states each observed window and flags windows outside 09:15-15:30 IST instead of assuming market hours',
	lookahead: 'NONE — a regime at interval i uses only intervals < i of the same session',
	scope: 'RESEARCH / SHADOW ONLY — no production importer, no effect on trading/risk/capital/execution',
} as const;

const SEP = '\u0000';
const IST_OFFSET_MS = 5.5 * 3600 * 1000;

/** Deterministic median. */
function median(values: number[]): number | null {
	if (values.length === 0) return null;
	const s = [...values].sort((a, b) => a - b);
	const mid = Math.floor(s.length / 2);
	return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function toMs(ts: string | Date | null | undefined): number | null {
	if (ts === null || ts === undefined || ts === '') return null;
	if (ts instanceof Date) return Number.isNaN(ts.getTime()) ? null : ts.getTime();
	const parsed = new Date(ts);
	return Number.isNaN(parsed.getTime()) ? null : parsed.getTime();
}

function toIso(ts: string | Date | null | undefined): string | null {
	const ms = toMs(ts);
	return ms === null ? null : new Date(ms).toISOString();
}

/** Calendar date of the RAW archived timestamp in IST wall-clock (the archive's own convention). */
function istDateOf(ts: string | Date | null | undefined): string | null {
	const ms = toMs(ts);
	return ms === null ? null : new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** Market hours 09:15–15:30 IST on the raw IST wall-clock. */
function isInsideMarketHoursIst(ts: string | Date | null | undefined): boolean {
	const ms = toMs(ts);
	if (ms === null) return false;
	const ist = new Date(ms + IST_OFFSET_MS);
	const minutes = ist.getUTCHours() * 60 + ist.getUTCMinutes();
	return minutes >= 9 * 60 + 15 && minutes <= 15 * 60 + 30;
}

export function describeTradeIntensity(config: TradeIntensityConfig = DEFAULT_TRADE_INTENSITY_CONFIG): string {
	return (
		`${TRADE_INTENSITY_VERSION}: intensity = ΔcumulativeVolume × 60 / Δt (contracts/min) over consecutive ` +
		`snapshots of one (instrumentKey, sessionDate); Δ=0 ⇒ NO_VOLUME_PROGRESS, Δ<0 ⇒ VOLUME_RESET; regime vs ` +
		`the median of the session's PRIOR intervals (needs ≥ ${config.minHistory} priors): QUIET < ` +
		`${config.quietFactor}×median, ACTIVE > ${config.activeFactor}×median. Research/shadow only.`
	);
}

export function evaluateTradeIntensity(
	snapshots: IntensitySnapshot[],
	config: Partial<TradeIntensityConfig> = {},
): TradeIntensityReport {
	const cfg: TradeIntensityConfig = { ...DEFAULT_TRADE_INTENSITY_CONFIG, ...config };
	const zeroRefusals = (): Record<string, number> => Object.fromEntries(INTENSITY_REFUSALS.map((r) => [r, 0]));
	const base: TradeIntensityReport = {
		version: TRADE_INTENSITY_VERSION,
		enabled: cfg.enabled,
		config: cfg,
		spec: TRADE_INTENSITY_SPEC,
		snapshotsIn: 0,
		observations: [],
		counts: { sessions: 0, intervals: 0, decided: 0, refused: 0 },
		refusalCounts: zeroRefusals(),
		regimeCounts: { QUIET: 0, NORMAL: 0, ACTIVE: 0 },
		sessions: [],
		sourceProgression: {},
		coverage: { sessions: 0, instruments: 0, sources: [], observedWindows: [], observedWindowOutsideMarketHours: 0, medianDtSecondsAcrossSessions: null },
		reviewerSummary: `${TRADE_INTENSITY_VERSION}: disabled — nothing computed`,
		digest: JSON.stringify([]),
	};
	if (!cfg.enabled) return base;

	const list = Array.isArray(snapshots) ? snapshots.filter((s) => s && typeof s === 'object') : [];
	if (list.length === 0) {
		return { ...base, reviewerSummary: `${TRADE_INTENSITY_VERSION}: no snapshots supplied — no intensity exists` };
	}

	// group by (instrumentKey, sessionDate) — instrumentKey can contain '|', so never split a key string
	const groups = new Map<string, { instrumentKey: string; sessionDate: string; rows: IntensitySnapshot[] }>();
	const unkeyed: IntensitySnapshot[] = [];
	for (const s of list) {
		const date = s.sessionDate ?? istDateOf(s.ts);
		if (!date) { unkeyed.push(s); continue; }
		const gk = `${s.instrumentKey ?? '(missing)'}${SEP}${date}`;
		const g = groups.get(gk);
		if (g) g.rows.push(s);
		else groups.set(gk, { instrumentKey: s.instrumentKey ?? '(missing)', sessionDate: date, rows: [s] });
	}

	const observations: IntensityObservation[] = [];
	const sessions: SessionCoverage[] = [];
	const refusalCounts = zeroRefusals();
	const regimeCounts: Record<ActivityRegime, number> = { QUIET: 0, NORMAL: 0, ACTIVE: 0 };
	const sourceProgression: TradeIntensityReport['sourceProgression'] = {};

	for (const g of [...groups.values()].sort((a, b) => (a.instrumentKey + a.sessionDate < b.instrumentKey + b.sessionDate ? -1 : 1))) {
		const { instrumentKey, sessionDate } = g;
		const rows = [...g.rows].sort((a, b) => {
			const am = toMs(a.ts), bm = toMs(b.ts);
			if (am === null && bm !== null) return 1;
			if (bm === null && am !== null) return -1;
			if (am !== null && bm !== null && am !== bm) return am - bm;
			return (a.sequenceNumber ?? 0) - (b.sequenceNumber ?? 0);
		});

		const sourcesInSession = [...new Set(rows.map((r) => r.source).filter((s) => typeof s === 'string' && s.length > 0))].sort();
		const sourceMixed = sourcesInSession.length > 1;
		const sourceLabel = sourceMixed ? sourcesInSession.join('+') : sourcesInSession[0] ?? '(missing)';

		const intensities: number[] = [];
		const dtList: number[] = [];
		const regimeCountsSession: Record<ActivityRegime, number> = { QUIET: 0, NORMAL: 0, ACTIVE: 0 };
		let decided = 0, positiveDeltas = 0, zeroDeltas = 0, negativeDeltas = 0;

		for (let i = 1; i < rows.length; i += 1) {
			const prev = rows[i - 1];
			const cur = rows[i];
			const fromMs = toMs(prev.ts);
			const toMsCur = toMs(cur.ts);
			const fromIso = toIso(prev.ts);
			const toIso_ = toIso(cur.ts);
			const hasVolume = typeof prev.volume === 'number' && typeof cur.volume === 'number';
			const hasForwardTs = fromMs !== null && toMsCur !== null && toMsCur > fromMs;
			const dtSeconds = hasForwardTs ? (toMsCur - fromMs) / 1000 : null;
			const deltaVolume = hasVolume ? (cur.volume as number) - (prev.volume as number) : null;

			let reason: IntensityRefusal | null = null;
			let intensity: number | null = null;
			if (sourceMixed) reason = 'SOURCE_MIXED';
			else if (!hasVolume) reason = 'NO_VOLUME';
			else if (!hasForwardTs) reason = 'NO_TIMESTAMP';
			else if ((deltaVolume as number) < 0) reason = 'VOLUME_RESET';
			else if ((deltaVolume as number) === 0) reason = 'NO_VOLUME_PROGRESS';
			else intensity = ((deltaVolume as number) * 60) / (dtSeconds as number);

			if (reason === null) positiveDeltas += 1;
			else if (reason === 'NO_VOLUME_PROGRESS') zeroDeltas += 1;
			else if (reason === 'VOLUME_RESET') negativeDeltas += 1;
			if (dtSeconds !== null) dtList.push(dtSeconds);

			const priorObservations = intensities.length;
			const priorMedian = median(intensities.slice(0, priorObservations));
			let regime: ActivityRegime | null = null;
			let regimeReason: IntensityObservation['regimeReason'] = null;
			if (intensity !== null) {
				if (priorObservations >= cfg.minHistory && priorMedian !== null) {
					if (intensity < cfg.quietFactor * priorMedian) regime = 'QUIET';
					else if (intensity > cfg.activeFactor * priorMedian) regime = 'ACTIVE';
					else regime = 'NORMAL';
				} else {
					regimeReason = 'INSUFFICIENT_HISTORY';
				}
			}

			if (reason !== null) refusalCounts[reason] += 1;
			if (intensity !== null) { decided += 1; intensities.push(intensity); }
			if (regime !== null) { regimeCounts[regime] += 1; regimeCountsSession[regime] += 1; }

			observations.push({
				instrumentKey, source: sourceLabel, sessionDate,
				fromTs: fromIso, toTs: toIso_,
				dtSeconds, deltaVolume, intensity,
				status: intensity === null ? 'UNAVAILABLE' : 'OK',
				reason, regime, regimeReason,
				baselineMedian: priorMedian,
				priorObservations,
			});
		}

		sessions.push({
			source: sourceLabel, instrumentKey, sessionDate,
			firstTs: toIso(rows[0].ts), lastTs: toIso(rows[rows.length - 1].ts),
			snapshots: rows.length, intervals: Math.max(0, rows.length - 1),
			decided, positiveDeltas, zeroDeltas, negativeDeltas,
			medianDtSeconds: median(dtList),
			regimeCounts: regimeCountsSession,
			refusedForSourceMix: sourceMixed,
			insideMarketHoursIst: isInsideMarketHoursIst(rows[0].ts) && isInsideMarketHoursIst(rows[rows.length - 1].ts),
		});

		for (const src of sourceMixed ? [sourceLabel] : sourcesInSession.length ? sourcesInSession : ['(missing)']) {
			const p = sourceProgression[src] ?? { snapshots: 0, positiveDeltas: 0, zeroDeltas: 0, negativeDeltas: 0, advances: false };
			p.snapshots += rows.length;
			p.positiveDeltas += positiveDeltas;
			p.zeroDeltas += zeroDeltas;
			p.negativeDeltas += negativeDeltas;
			p.advances = p.positiveDeltas > 0;
			sourceProgression[src] = p;
		}
	}

	for (const s of unkeyed) {
		refusalCounts.NO_SESSION_DATE += 1;
		observations.push({
			instrumentKey: s.instrumentKey ?? '(missing)', source: s.source ?? '(missing)', sessionDate: '',
			fromTs: null, toTs: toIso(s.ts), dtSeconds: null, deltaVolume: null, intensity: null,
			status: 'UNAVAILABLE', reason: 'NO_SESSION_DATE', regime: null, regimeReason: null,
			baselineMedian: null, priorObservations: 0,
		});
	}

	const decidedCount = observations.filter((o) => o.status === 'OK').length;
	const refused = observations.length - decidedCount;
	const sessionDts = sessions.map((s) => s.medianDtSeconds).filter((v): v is number => typeof v === 'number');
	const windows = sessions
		.filter((s) => s.sessionDate)
		.map((s) => ({ source: s.source, sessionDate: s.sessionDate, firstTs: s.firstTs, lastTs: s.lastTs }))
		.sort((a, b) => (a.sessionDate + a.source < b.sessionDate + b.source ? -1 : 1));
	const outside = sessions.filter((s) => s.sessionDate && !s.insideMarketHoursIst).length;
	const sources = [...new Set(sessions.map((s) => s.source))].sort();
	const advancing = Object.keys(sourceProgression).filter((s) => sourceProgression[s].advances).sort();

	const coverage = {
		sessions: sessions.length,
		instruments: new Set(sessions.map((s) => s.instrumentKey)).size,
		sources,
		observedWindows: windows,
		observedWindowOutsideMarketHours: outside,
		medianDtSecondsAcrossSessions: median(sessionDts),
	};

	const reviewerSummary =
		`${TRADE_INTENSITY_VERSION}: ${decidedCount} intensity observation(s) over ${sessions.length} instrument session(s), ` +
		`${refused} refused; regimes QUIET=${regimeCounts.QUIET} NORMAL=${regimeCounts.NORMAL} ACTIVE=${regimeCounts.ACTIVE}; ` +
		`sources ${sources.join(',') || 'none'} (advancing cumulative volume: ${advancing.join(',') || 'none'}); ` +
		`observed windows outside 09:15-15:30 IST: ${outside}/${windows.length}. ${describeTradeIntensity(cfg)}`;

	return {
		version: TRADE_INTENSITY_VERSION,
		enabled: cfg.enabled,
		config: cfg,
		spec: TRADE_INTENSITY_SPEC,
		snapshotsIn: list.length,
		observations,
		counts: { sessions: sessions.length, intervals: observations.length, decided: decidedCount, refused },
		refusalCounts,
		regimeCounts,
		sessions,
		sourceProgression,
		coverage,
		reviewerSummary,
		digest: JSON.stringify(observations.map((o) => [o.source, o.instrumentKey, o.sessionDate, o.toTs, o.deltaVolume, o.intensity, o.regime])),
	};
}
