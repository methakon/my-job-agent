/**
 * GATE 8 #1 (roadmap row 85) — THE CURRENT NIFTY/BANKNIFTY GAP DATABASE (feature side).
 *
 * Single responsibility: assemble the gate-4 gap evidence into ONE versioned, deterministic DATASET — one row
 * per (session, instrument) with a FROZEN feature vector — and declare exactly where the feature cutoff is.
 * It carries FEATURES ONLY: outcome labels are a separate concern (rows 87/89/…), so no post-decision value can
 * enter here by accident. PURE: no clock, no I/O, no DB, no network, no AI, no randomness.
 *
 * ── THE FEATURE CUTOFF (the reason this dataset is safe) ───────────────────────────────────
 *   Every column is knowable AT THE 09:15 OPEN (the decision cutoff). The row is built by CONSUMING the earlier
 *   gate-4 reports rather than re-deriving anything, and the columns are exactly:
 *     gapClass, gapDirection, gapPct, gapRatio, gapAbs, open, prevClose, priorRange   (row 38 taxonomy)
 *     gapRangePos                                                                     (row 41)
 *     fadeScore, followScore                                                          (row 44)
 *     decisionSide, tradeDirection, decisionReason                                    (row 48)
 *   The session's own high/low/close are NEVER read here, and no label is attached — a dataset row is a
 *   SNAPSHOT of what was knowable at the open.
 *
 * ── INPUTS / OUTPUT SCHEMA / TIMESTAMPS / FAILURE ──────────────────────────────────────────
 *   Inputs: the row-38 assessment report, the row-41 range-pos result, the row-44 score report and the row-48
 *   decision report (all reports, so their versions travel). A row is emitted per session present in the
 *   assessment input; a missing dependent row leaves that COLUMN null with a per-cell reason, never a guess.
 *   Timestamps: sessionDate is the row's only time key; no clock is read.
 *   Failure: NO_SESSIONS (nothing supplied) / NO_SESSION_DATE (an unusable date) ⇒ UNAVAILABLE; the dataset is
 *   enable/disable-able and its digest is a function of the DATA alone.
 *
 * RESEARCH / SHADOW ONLY: nothing in production imports this module (asserted by test); no state is written and
 * no decision, order or risk path reads it. Versioned: gapdb-v1.
 */

import { SessionGapAssessment } from './gap-taxonomy';
import { GapRangePosResult } from './gap-range-pos';
import { GapScoreReport } from './gap-scores';
import { GapDecisionReport } from './gap-decision';

export const GAP_DATASET_VERSION = 'gapdb-v1';

/** Every feature column is knowable at this instant — the decision cutoff. */
export const GAP_DATASET_FEATURE_CUTOFF = 'OPEN (09:15 IST)';

/** The exact feature columns, pinned so a drive-by addition is visible (labels are NOT here). */
export const GAP_DATASET_FEATURES = [
	'gapClass', 'gapDirection', 'gapPct', 'gapRatio', 'gapAbs', 'open', 'prevClose', 'priorRange',
	'gapRangePos', 'fadeScore', 'followScore', 'decisionSide', 'tradeDirection', 'decisionReason',
] as const;
export type GapDatasetFeature = (typeof GAP_DATASET_FEATURES)[number];

export type GapDatasetStatus = 'OK' | 'UNAVAILABLE' | 'DISABLED';
export const GAP_DATASET_STATUSES: readonly GapDatasetStatus[] = ['OK', 'UNAVAILABLE', 'DISABLED'];

/** Closed, published refusal vocabulary (declaration order is the canonical order). */
export const GAP_DATASET_REFUSALS = ['NO_SESSIONS', 'NO_SESSION_DATE'] as const;
export type GapDatasetRefusal = (typeof GAP_DATASET_REFUSALS)[number];

export interface GapDatasetInput {
	assessments: SessionGapAssessment[];
	rangePos: GapRangePosResult;
	scores: GapScoreReport;
	decisions: GapDecisionReport;
}

export interface GapDatasetConfig {
	enabled: boolean;
}

export const DEFAULT_GAP_DATASET_CONFIG: GapDatasetConfig = { enabled: true };

export const GAP_DATASET_SPEC = {
	feature: 'GapDataset',
	version: GAP_DATASET_VERSION,
	question: 'What was knowable about each session gap AT THE OPEN, as one frozen dataset row?',
	cutoff: GAP_DATASET_FEATURE_CUTOFF,
	columns: [...GAP_DATASET_FEATURES] as string[],
	inputs: 'the row-38 taxonomy report, the row-41 range-pos result, the row-44 score report and the row-48 decision report (consumed, never re-derived)',
	timestamps: 'sessionDate is the only time key; no clock is read and no post-open value is used',
	labels: 'NONE — labels are a separate row (87/89/…) so no outcome can leak into the feature side',
	failure: 'no sessions ⇒ NO_SESSIONS; an unusable session date ⇒ NO_SESSION_DATE; a missing dependent row leaves that column null with a per-cell reason',
};

export const describeGapDataset = (c: GapDatasetConfig = DEFAULT_GAP_DATASET_CONFIG): string =>
	[
		`${GAP_DATASET_VERSION}: one frozen feature vector per (session, instrument), knowable at ${GAP_DATASET_FEATURE_CUTOFF}.`,
		`Columns: ${GAP_DATASET_FEATURES.join(', ')}.`,
		`Consumes the row-38/41/44/48 reports; a missing dependency leaves a null column with a reason, never a guess.`,
		`NO labels are attached here, so no outcome can leak into the feature side. enabled=${c.enabled}.`,
	].join(' ');

export interface GapDatasetRow {
	sessionDate: string;
	instrument: string;
	status: GapDatasetStatus;
	reason: GapDatasetRefusal | null;
	reasonDetail: string | null;
	/** Frozen feature vector, or null in every non-OK state. */
	features: Record<GapDatasetFeature, number | string | null> | null;
	/** Per-column provenance: which upstream row supplied it, or why it is absent. */
	provenance: Record<string, string>;
	/** The cutoff declaration, echoed so a reviewer never has to infer it. */
	cutoff: string;
}

export interface GapDatasetReport {
	version: string;
	enabled: boolean;
	config: GapDatasetConfig;
	spec: typeof GAP_DATASET_SPEC;
	cutoff: string;
	upstream: { taxonomyVersion: string | null; rangePosVersion: string | null; scoresVersion: string | null; decisionVersion: string | null };
	rows: GapDatasetRow[];
	counts: Record<GapDatasetStatus, number>;
	refusalCounts: Record<GapDatasetRefusal, number>;
	coverage: { sessionsIn: number; rowsOut: number; ok: number; unavailable: number; disabled: number; withDecision: number; withScores: number; withRangePos: number };
	reviewerSummary: string;
	digest: string;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const key = (r: { sessionDate: string; instrument: string }): string => `${r.sessionDate}|${r.instrument}`;

export function buildGapDataset(input: GapDatasetInput, config: Partial<GapDatasetConfig> = {}): GapDatasetReport {
	const cfg: GapDatasetConfig = { ...DEFAULT_GAP_DATASET_CONFIG, ...config };

	const rpIndex = new Map<string, { status: string; gapRangePos: number | null; reason?: string | null }>();
	for (const o of input?.rangePos?.observations ?? []) rpIndex.set(key(o), { status: o.status, gapRangePos: o.gapRangePos, reason: o.reason });
	const fadeIndex = new Map<string, { status: string; score: number | null; reason?: string | null }>();
	for (const o of input?.scores?.fade?.observations ?? []) fadeIndex.set(key(o), { status: o.status, score: o.score, reason: o.reason });
	const followIndex = new Map<string, { status: string; score: number | null; reason?: string | null }>();
	for (const o of input?.scores?.follow?.observations ?? []) followIndex.set(key(o), { status: o.status, score: o.score, reason: o.reason });
	const decisionIndex = new Map<string, { status: string; decision: string; side: string | null; tradeDirection: string | null; reason: string | null }>();
	for (const o of input?.decisions?.decisions ?? []) decisionIndex.set(key(o), { status: o.status, decision: o.decision, side: o.side, tradeDirection: o.tradeDirection, reason: o.reason });

	const assessments = input?.assessments ?? [];
	const rows: GapDatasetRow[] = assessments.map((a) => {
		const base = { sessionDate: a?.sessionDate ?? '', instrument: a?.instrument ?? '', cutoff: GAP_DATASET_FEATURE_CUTOFF };
		if (!cfg.enabled) {
			return { ...base, status: 'DISABLED' as const, reason: null, reasonDetail: 'the dataset is disabled; no feature row was assembled', features: null, provenance: {} };
		}
		if (!/^\d{4}-\d{2}-\d{2}$/.test(String(a?.sessionDate ?? ''))) {
			return { ...base, status: 'UNAVAILABLE' as const, reason: 'NO_SESSION_DATE' as const, reasonDetail: `"${a?.sessionDate}" is not a usable YYYY-MM-DD session date`, features: null, provenance: {} };
		}
		const provenance: Record<string, string> = {};
		const col = (name: GapDatasetFeature, value: number | string | null, source: string): number | string | null => {
			provenance[name] = value === null ? `absent: ${source}` : source;
			return value;
		};
		const rp = rpIndex.get(key(a));
		const fade = fadeIndex.get(key(a));
		const follow = followIndex.get(key(a));
		const dec = decisionIndex.get(key(a));
		const features: Record<GapDatasetFeature, number | string | null> = {
			gapClass: col('gapClass', a.status === 'OK' ? (a.class ?? null) : null, 'row38:taxonomy'),
			gapDirection: col('gapDirection', a.status === 'OK' ? (a.direction ?? null) : null, 'row38:taxonomy'),
			gapPct: col('gapPct', isNum(a.gapPct) ? a.gapPct : null, 'row38:taxonomy'),
			gapRatio: col('gapRatio', isNum(a.gapRatio) ? a.gapRatio : null, 'row38:taxonomy'),
			gapAbs: col('gapAbs', isNum(a.gapAbs) ? a.gapAbs : null, 'row38:taxonomy'),
			open: col('open', isNum(a.measures?.open) ? (a.measures.open as number) : null, 'row38:taxonomy.measures'),
			prevClose: col('prevClose', isNum(a.measures?.prevClose) ? (a.measures.prevClose as number) : null, 'row38:taxonomy.measures'),
			priorRange: col('priorRange', isNum(a.measures?.priorRange) ? (a.measures.priorRange as number) : null, 'row38:taxonomy.measures'),
			gapRangePos: col('gapRangePos', rp?.status === 'OK' && isNum(rp.gapRangePos) ? (rp.gapRangePos as number) : null, `row41:range-pos${rp ? ` (${rp.status}${rp.reason ? `/${rp.reason}` : ''})` : ' (no row)'}`),
			fadeScore: col('fadeScore', fade?.status === 'OK' && isNum(fade.score) ? (fade.score as number) : null, `row44:fade${fade ? ` (${fade.status}${fade.reason ? `/${fade.reason}` : ''})` : ' (no row)'}`),
			followScore: col('followScore', follow?.status === 'OK' && isNum(follow.score) ? (follow.score as number) : null, `row44:follow${follow ? ` (${follow.status}${follow.reason ? `/${follow.reason}` : ''})` : ' (no row)'}`),
			decisionSide: col('decisionSide', dec?.status === 'OK' ? (dec.side ?? null) : null, `row48:decision${dec ? ` (${dec.status})` : ' (no row)'}`),
			tradeDirection: col('tradeDirection', dec?.status === 'OK' ? (dec.tradeDirection ?? null) : null, `row48:decision${dec ? ` (${dec.status})` : ' (no row)'}`),
			decisionReason: col('decisionReason', dec?.reason ?? (dec ? null : 'NO_ROW'), `row48:decision${dec ? '' : ' (no row)'}`),
		};
		return { ...base, status: 'OK' as const, reason: null, reasonDetail: null, features, provenance };
	});

	const ordered = [...rows].sort((x, y) => {
		if (x.sessionDate !== y.sessionDate) return x.sessionDate < y.sessionDate ? -1 : 1;
		return x.instrument < y.instrument ? -1 : x.instrument > y.instrument ? 1 : 0;
	});

	const counts: Record<GapDatasetStatus, number> = { OK: 0, UNAVAILABLE: 0, DISABLED: 0 };
	const refusalCounts = Object.fromEntries(GAP_DATASET_REFUSALS.map((r) => [r, 0])) as Record<GapDatasetRefusal, number>;
	let withDecision = 0;
	let withScores = 0;
	let withRangePos = 0;
	for (const r of ordered) {
		counts[r.status] += 1;
		if (r.reason) refusalCounts[r.reason] += 1;
		if (r.features) {
			if (r.features.decisionSide !== null) withDecision += 1;
			if (r.features.fadeScore !== null && r.features.followScore !== null) withScores += 1;
			if (r.features.gapRangePos !== null) withRangePos += 1;
		}
	}
	if (cfg.enabled && !assessments.length) refusalCounts.NO_SESSIONS = 1;

	return {
		version: GAP_DATASET_VERSION,
		enabled: cfg.enabled,
		config: cfg,
		spec: GAP_DATASET_SPEC,
		cutoff: GAP_DATASET_FEATURE_CUTOFF,
		upstream: {
			taxonomyVersion: null,
			rangePosVersion: input?.rangePos?.version ?? null,
			scoresVersion: input?.scores?.version ?? null,
			decisionVersion: input?.decisions?.version ?? null,
		},
		rows: ordered,
		counts,
		refusalCounts,
		coverage: { sessionsIn: assessments.length, rowsOut: ordered.length, ok: counts.OK, unavailable: counts.UNAVAILABLE, disabled: counts.DISABLED, withDecision, withScores, withRangePos },
		reviewerSummary: describeGapDataset(cfg),
		digest: JSON.stringify(ordered.map((r) => [r.sessionDate, r.instrument, r.status, r.features ? GAP_DATASET_FEATURES.map((f) => r.features![f]) : null])),
	};
}
