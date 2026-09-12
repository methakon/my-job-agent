/**
 * GATE 7 #7 (roadmap row 77) — SEPARATE DIRECTION, EXPECTED MOVEMENT, IV REGIME AND HOLDING PERIOD.
 *
 * Single responsibility: assemble the four selection dimensions as FOUR SEPARATE, independently-sourced fields
 * in one structured brief — and REFUSE to emit a brief while any of them is missing. It deliberately computes
 * NO combined score and makes NO choice of option: collapsing these dimensions into one number is exactly the
 * failure mode this row exists to prevent. PURE: no clock, no I/O, no DB, no network, no AI, no randomness.
 *
 * ── PINNED DEFINITION (inputs, transformation, output, timestamp boundary, failure) ────────
 *   direction        caller-supplied (LONG | SHORT) with its source (e.g. the row-48 gap decision). Never derived
 *                    here, never inferred from price.
 *   expectedMovement a magnitude in INDEX POINTS with its source (e.g. prior-session range / ATR). Must be
 *                    finite and > 0; a 0 or negative expected move is refused, never clamped.
 *   ivRegime         DERIVED from a supplied implied vol and realised vol by SIGN ONLY:
 *                      IV_RICH  when iv > rv, IV_CHEAP when iv < rv, BALANCED when equal.
 *                    There is NO margin threshold — a tuned band would invent a decision boundary.
 *   holdingPeriod    caller-supplied enum (INTRADAY | OVERNIGHT | MULTI_DAY) with its source.
 *   OUTPUT: one brief per (underlying, session) with the four fields, each carrying its own source; `missing`
 *   lists whichever are absent. Nothing is blended; there is no score, rank or pick in the output.
 *   TIMESTAMP BOUNDARY: the caller supplies the session date and every input; the module reads no clock and
 *   imposes no window of its own.
 *
 * ── MISSING / DEGENERATE DATA → a safe explicit state ───────────────────────────────────────
 *   NO_DIRECTION / NO_MOVEMENT / NO_IV_REGIME / NO_HOLDING (that dimension absent or invalid) and
 *   NO_SESSION_DATE — status UNAVAILABLE with `missing` populated and a null brief; a partial brief is never
 *   emitted as if it were complete.
 *
 * RESEARCH / SHADOW ONLY: nothing in production imports this module (asserted by test); no state is written and
 * no decision, order or risk path reads it. Versioned: selbrief-v1.
 */

export const SELECTION_BRIEF_VERSION = 'selbrief-v1';

export type SelectionBriefStatus = 'OK' | 'UNAVAILABLE' | 'DISABLED';
export const SELECTION_BRIEF_STATUSES: readonly SelectionBriefStatus[] = ['OK', 'UNAVAILABLE', 'DISABLED'];

/** Closed, published refusal vocabulary (declaration order is the canonical order). */
export const SELECTION_BRIEF_REFUSALS = ['NO_SESSION_DATE', 'NO_DIRECTION', 'NO_MOVEMENT', 'NO_IV_REGIME', 'NO_HOLDING'] as const;
export type SelectionBriefRefusal = (typeof SELECTION_BRIEF_REFUSALS)[number];

export type TradeDirection = 'LONG' | 'SHORT';
export const TRADE_DIRECTIONS: readonly TradeDirection[] = ['LONG', 'SHORT'];

export type HoldingPeriod = 'INTRADAY' | 'OVERNIGHT' | 'MULTI_DAY';
export const HOLDING_PERIODS: readonly HoldingPeriod[] = ['INTRADAY', 'OVERNIGHT', 'MULTI_DAY'];

export type IvRegime = 'IV_RICH' | 'IV_CHEAP' | 'BALANCED';
export const IV_REGIMES: readonly IvRegime[] = ['IV_RICH', 'IV_CHEAP', 'BALANCED'];

export interface SelectionBriefInput {
	underlying: string;
	sessionDate: string;
	/** Each dimension carries the provenance of ITS OWN source — they are never merged. */
	direction?: { value: TradeDirection | null; source: string | null } | null;
	expectedMovement?: { points: number | null; source: string | null } | null;
	ivRegime?: { iv: number | null; rv: number | null; source: string | null } | null;
	holdingPeriod?: { value: HoldingPeriod | null; source: string | null } | null;
}

export interface SelectionBriefConfig {
	enabled: boolean;
}

export const DEFAULT_SELECTION_BRIEF_CONFIG: SelectionBriefConfig = { enabled: true };

export const SELECTION_BRIEF_SPEC = {
	feature: 'SelectionBrief',
	version: SELECTION_BRIEF_VERSION,
	question: 'Are direction, expected movement, IV regime and holding period each known and kept SEPARATE before any option is selected?',
	dimensions: 'direction (caller), expectedMovement in index points (caller), ivRegime (derived by SIGN ONLY from iv vs rv), holdingPeriod (caller)',
	transformation: 'no transformation across dimensions — the four are reported side by side with their own sources; there is NO combined score, rank or pick',
	output: '{direction, expectedMovement, ivRegime, holdingPeriod, missing[]} — nothing is blended',
	timestampBoundary: 'the caller supplies the session date and every input; no clock is read',
	thresholds: 'none — ivRegime uses only the sign of (iv − rv); no margin band exists',
	refuses: [...SELECTION_BRIEF_REFUSALS] as string[],
	missingData: 'any absent/invalid dimension ⇒ UNAVAILABLE with `missing` populated and a null brief; a partial brief is never presented as complete',
};

export const describeSelectionBrief = (c: SelectionBriefConfig = DEFAULT_SELECTION_BRIEF_CONFIG): string =>
	[
		`${SELECTION_BRIEF_VERSION}: keeps direction, expected movement, IV regime and holding period as FOUR separate`,
		`fields with their own sources — no combined score, no rank and no option pick.`,
		`ivRegime is derived by SIGN ONLY (IV_RICH / IV_CHEAP / BALANCED) with no margin threshold.`,
		`A brief is emitted only when ALL FOUR are present and valid; otherwise UNAVAILABLE lists what is missing.`,
		`Refusals: ${SELECTION_BRIEF_REFUSALS.join(' / ')}. enabled=${c.enabled}.`,
	].join(' ');

export interface SelectionBrief {
	underlying: string;
	sessionDate: string;
	direction: { value: TradeDirection; source: string | null };
	expectedMovement: { points: number; source: string | null };
	ivRegime: { value: IvRegime; iv: number; rv: number; source: string | null };
	holdingPeriod: { value: HoldingPeriod; source: string | null };
}

export interface SelectionBriefRow {
	underlying: string;
	sessionDate: string;
	status: SelectionBriefStatus;
	reason: SelectionBriefRefusal | null;
	reasonDetail: string | null;
	/** Every dimension that was absent or invalid — the point of the row. */
	missing: SelectionBriefRefusal[];
	brief: SelectionBrief | null;
}

export interface SelectionBriefReport {
	version: string;
	enabled: boolean;
	config: SelectionBriefConfig;
	spec: typeof SELECTION_BRIEF_SPEC;
	rows: SelectionBriefRow[];
	counts: Record<SelectionBriefStatus, number>;
	refusalCounts: Record<SelectionBriefRefusal, number>;
	coverage: { inputsIn: number; ok: number; unavailable: number; disabled: number; missingDimensionCounts: Record<SelectionBriefRefusal, number> };
	reviewerSummary: string;
	digest: string;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const round6 = (v: number): number => Number(v.toFixed(6));

/** IV regime by SIGN ONLY — no margin, no band, no threshold. */
export const ivRegimeOf = (iv: number, rv: number): IvRegime => (iv > rv ? 'IV_RICH' : iv < rv ? 'IV_CHEAP' : 'BALANCED');

export function evaluateSelectionBrief(inputs: SelectionBriefInput[], config: Partial<SelectionBriefConfig> = {}): SelectionBriefReport {
	const cfg: SelectionBriefConfig = { ...DEFAULT_SELECTION_BRIEF_CONFIG, ...config };

	const rows: SelectionBriefRow[] = (inputs ?? []).map((input) => {
		const base = { underlying: input?.underlying ?? '', sessionDate: input?.sessionDate ?? '' };
		if (!cfg.enabled) return { ...base, status: 'DISABLED' as const, reason: null, reasonDetail: 'the component is disabled; no brief was assembled', missing: [], brief: null };
		if (!input || typeof input !== 'object') return { ...base, status: 'UNAVAILABLE' as const, reason: 'NO_SESSION_DATE' as const, reasonDetail: 'no input was supplied', missing: [...SELECTION_BRIEF_REFUSALS], brief: null };

		const missing: SelectionBriefRefusal[] = [];
		const badDate = !/^\d{4}-\d{2}-\d{2}$/.test(String(input.sessionDate ?? ''));
		if (badDate) missing.push('NO_SESSION_DATE');

		const direction = input.direction?.value === 'LONG' || input.direction?.value === 'SHORT' ? input.direction.value : null;
		if (!direction) missing.push('NO_DIRECTION');
		const points = isNum(input.expectedMovement?.points) && (input.expectedMovement?.points as number) > 0 ? (input.expectedMovement?.points as number) : null;
		if (points === null) missing.push('NO_MOVEMENT');
		const iv = isNum(input.ivRegime?.iv) ? (input.ivRegime?.iv as number) : null;
		const rv = isNum(input.ivRegime?.rv) ? (input.ivRegime?.rv as number) : null;
		if (iv === null || rv === null) missing.push('NO_IV_REGIME');
		const holding = input.holdingPeriod?.value && HOLDING_PERIODS.includes(input.holdingPeriod.value) ? input.holdingPeriod.value : null;
		if (!holding) missing.push('NO_HOLDING');

		if (missing.length) {
			const reason = missing[0];
			return { ...base, status: 'UNAVAILABLE' as const, reason, reasonDetail: `the brief cannot be emitted while these dimensions are missing/invalid: ${missing.join(', ')}`, missing, brief: null };
		}

		return {
			...base,
			status: 'OK' as const,
			reason: null,
			reasonDetail: null,
			missing: [],
			brief: {
				underlying: base.underlying,
				sessionDate: base.sessionDate,
				direction: { value: direction as TradeDirection, source: input.direction?.source ?? null },
				expectedMovement: { points: round6(points as number), source: input.expectedMovement?.source ?? null },
				ivRegime: { value: ivRegimeOf(iv as number, rv as number), iv: round6(iv as number), rv: round6(rv as number), source: input.ivRegime?.source ?? null },
				holdingPeriod: { value: holding as HoldingPeriod, source: input.holdingPeriod?.source ?? null },
			},
		};
	});

	const counts: Record<SelectionBriefStatus, number> = { OK: 0, UNAVAILABLE: 0, DISABLED: 0 };
	const refusalCounts = Object.fromEntries(SELECTION_BRIEF_REFUSALS.map((r) => [r, 0])) as Record<SelectionBriefRefusal, number>;
	const missingDimensionCounts = Object.fromEntries(SELECTION_BRIEF_REFUSALS.map((r) => [r, 0])) as Record<SelectionBriefRefusal, number>;
	// Canonical order so the digest is a function of the DATA, not of the caller's input order.
	const ordered = [...rows].sort((a, b) => {
		if (a.sessionDate !== b.sessionDate) return a.sessionDate < b.sessionDate ? -1 : 1;
		return a.underlying < b.underlying ? -1 : a.underlying > b.underlying ? 1 : 0;
	});
	for (const r of ordered) {
		counts[r.status] += 1;
		if (r.reason) refusalCounts[r.reason] += 1;
		for (const m of r.missing) missingDimensionCounts[m] += 1;
	}

	return {
		version: SELECTION_BRIEF_VERSION,
		enabled: cfg.enabled,
		config: cfg,
		spec: SELECTION_BRIEF_SPEC,
		rows: ordered,
		counts,
		refusalCounts,
		coverage: { inputsIn: ordered.length, ok: counts.OK, unavailable: counts.UNAVAILABLE, disabled: counts.DISABLED, missingDimensionCounts },
		reviewerSummary: describeSelectionBrief(cfg),
		digest: JSON.stringify(ordered.map((r) => [r.underlying, r.sessionDate, r.status, r.reason, r.missing, r.brief ? [r.brief.direction.value, r.brief.expectedMovement.points, r.brief.ivRegime.value, r.brief.holdingPeriod.value] : null])),
	};
}
