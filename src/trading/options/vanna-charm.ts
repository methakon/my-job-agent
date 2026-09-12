/**
 * GATE 7 #6 (roadmap row 75) — VANNA / CHARM AS SECONDARY EXPLANATORY FEATURES.
 *
 * Single responsibility: derive the two second-order sensitivities — VANNA (∂delta/∂σ) and CHARM
 * (∂delta/∂t, delta decay) — for each option contract from the SAME local BSM model the desk already uses
 * (row 71), and state explicitly when a contract cannot support them. PURE: no clock, no I/O, no DB, no
 * network, no AI, no randomness.
 *
 * ── WHY FINITE DIFFERENCES (and not a hand-copied closed form) ──────────────────────────────
 *   Sign conventions for vanna/charm differ between textbooks, and a wrong sign is invisible in a table. This
 *   module therefore differentiates the REUSED local greeks numerically with a central difference, so its
 *   output is consistent with the row-71 delta BY CONSTRUCTION:
 *     vanna          = ( delta(σ + volStep) − delta(σ − volStep) ) / (2 × volStep)      [per unit vol]
 *     vannaPerVolPt  = vanna × 0.01                                                      (per 1 vol point)
 *     charm          = −( delta(T + timeStep) − delta(T − timeStep) ) / (2 × timeStep)   [per YEAR]
 *     charmPerDay    = charm / 365                                                       (per calendar day)
 *   `volStep` (absolute vol) and `timeStep` (years) are numeric-method step sizes — documented constants, not
 *   tuned thresholds. The tests check the module's value against a WIDER independent central difference.
 *
 * ── INPUT AVAILABILITY / TIMESTAMP BOUNDARY ────────────────────────────────────────────────
 *   Needs: spot, strike, option type, IV (>0), and an expiry AFTER the session date with enough time left for
 *   the time step (`years > timeStep`) — otherwise the time derivative is undefined and is refused
 *   (SMALL_T), never clamped to a boundary value that would invent sensitivity.
 *   The contract's timestamp semantics stay those of its inputs; this module reads no clock.
 *
 * ── MISSING / DEGENERATE DATA → a safe explicit state ───────────────────────────────────────
 *   NO_QUOTES / NO_SPOT / NO_IV / NO_EXPIRY (expiry not after the session) / SMALL_T (not enough time left for
 *   the derivative step) / NO_GREEKS (the local model returned nothing) — null values with a closed-vocabulary
 *   token; a sensitivity is never fabricated.
 *
 * RESEARCH / SHADOW ONLY: nothing in production imports this module (asserted by test); it writes no state and
 * no decision, order or risk path reads it. Versioned: vannacharm-v1.
 */

import { bsmGreeks } from '../bsm-greeks';

export const VANNA_CHARM_VERSION = 'vannacharm-v1';

export type VannaCharmStatus = 'OK' | 'UNAVAILABLE' | 'DISABLED';
export const VANNA_CHARM_STATUSES: readonly VannaCharmStatus[] = ['OK', 'UNAVAILABLE', 'DISABLED'];

/** Closed, published refusal vocabulary (declaration order is the canonical order). */
export const VANNA_CHARM_REFUSALS = ['NO_QUOTES', 'NO_SPOT', 'NO_IV', 'NO_EXPIRY', 'SMALL_T', 'NO_GREEKS'] as const;
export type VannaCharmRefusal = (typeof VANNA_CHARM_REFUSALS)[number];

export interface VannaCharmQuote {
	underlying: string;
	sessionDate: string;
	expiry: string;
	strike: number | null;
	optionType: string | null;
	iv: number | null;
	source?: string | null;
	sourceTimestamp?: Date | string | null;
}

export interface VannaCharmConfig {
	enabled: boolean;
	/** Risk-free annual rate for the local model (documented constant). */
	rate: number;
	/** Central-difference step in ABSOLUTE volatility (e.g. 0.0005 = 5 bp). */
	volStep: number;
	/** Central-difference step for time, in DAYS (e.g. 0.5 = 12 h). */
	timeStepDays: number;
}

export const DEFAULT_VANNA_CHARM_CONFIG: VannaCharmConfig = { enabled: true, rate: 0.065, volStep: 0.0005, timeStepDays: 0.5 };

export const VANNA_CHARM_SPEC = {
	feature: 'VannaCharm',
	version: VANNA_CHARM_VERSION,
	question: 'What are each contract vanna (∂delta/∂σ) and charm (∂delta/∂t) from the local BSM model?',
	method: 'central finite difference on the REUSED row-71 local greeks: vanna = Δdelta/Δσ per unit vol; charm = −Δdelta/ΔT per year',
	units: 'vanna per unit vol (and ×0.01 per vol point); charm per year (and /365 per calendar day)',
	inputAvailability: 'spot, strike, option type, IV > 0, and expiry after the session with years > timeStep; otherwise refused',
	timestampBoundary: 'no clock is read; the contract keeps its own timestamp semantics',
	steps: 'volStep (absolute vol) and timeStepDays are documented numeric-method steps, not tuned thresholds',
	refuses: [...VANNA_CHARM_REFUSALS] as string[],
	missingData: 'no quotes/spot/IV, an expiry not after the session, too little time left for the derivative step, or no local greeks ⇒ null values with a closed-vocabulary token',
};

export const describeVannaCharm = (c: VannaCharmConfig = DEFAULT_VANNA_CHARM_CONFIG): string =>
	[
		`${VANNA_CHARM_VERSION}: vanna (∂delta/∂σ) and charm (∂delta/∂t) by central difference on the reused local greeks.`,
		`Steps: volStep=${c.volStep} (absolute vol), timeStep=${c.timeStepDays} day(s); rate=${c.rate}.`,
		`Values are refused (null) when the inputs cannot support them — no clamping, no fabricated sensitivity.`,
		`Every row returns one of ${VANNA_CHARM_REFUSALS.join(' / ')} on failure. enabled=${c.enabled}.`,
	].join(' ');

export interface VannaCharmValues {
	vanna: number;
	vannaPerVolPoint: number;
	charm: number;
	charmPerDay: number;
}

export interface VannaCharmObservation {
	underlying: string;
	sessionDate: string;
	expiry: string;
	strike: number | null;
	optionType: string | null;
	status: VannaCharmStatus;
	reason: VannaCharmRefusal | null;
	reasonDetail: string | null;
	values: VannaCharmValues | null;
	evidence: { spot: number | null; iv: number | null; years: number | null; source: string | null; sourceTimestamp: string | null };
}

export interface VannaCharmReport {
	version: string;
	enabled: boolean;
	config: VannaCharmConfig;
	spec: typeof VANNA_CHARM_SPEC;
	observations: VannaCharmObservation[];
	counts: Record<VannaCharmStatus, number>;
	refusalCounts: Record<VannaCharmRefusal, number>;
	coverage: { quotesIn: number; ok: number; unavailable: number; disabled: number };
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
const dayGap = (from: string, to: string): number | null => {
	const a = Date.parse(`${from}T00:00:00Z`);
	const b = Date.parse(`${to}T00:00:00Z`);
	if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
	return Math.round((b - a) / 86_400_000);
};

export function evaluateVannaCharm(
	quotes: VannaCharmQuote[],
	spots: Array<{ underlying: string; spot: number | null }>,
	config: Partial<VannaCharmConfig> = {},
): VannaCharmReport {
	const cfg: VannaCharmConfig = { ...DEFAULT_VANNA_CHARM_CONFIG, ...config };
	const spotIndex = new Map<string, number>();
	for (const s of spots ?? []) if (isNum(s?.spot) && (s.spot as number) > 0) spotIndex.set(String(s.underlying), s.spot as number);
	const timeStepYears = cfg.timeStepDays / 365;

	const observations: VannaCharmObservation[] = (quotes ?? []).map((q) => {
		const evidence = { spot: null as number | null, iv: isNum(q?.iv) ? (q.iv as number) : null, years: null as number | null, source: q?.source ?? null, sourceTimestamp: isoOrNull(q?.sourceTimestamp) };
		const base = { underlying: q?.underlying ?? '', sessionDate: q?.sessionDate ?? '', expiry: q?.expiry ?? '', strike: isNum(q?.strike) ? (q.strike as number) : null, optionType: q?.optionType ?? null, evidence };
		const no = (reason: VannaCharmRefusal, detail: string): VannaCharmObservation => ({ ...base, status: 'UNAVAILABLE', reason, reasonDetail: detail, values: null });

		if (!cfg.enabled) return { ...base, status: 'DISABLED', reason: null, reasonDetail: 'the component is disabled; no sensitivity was computed for this contract', values: null };
		if (!q || typeof q !== 'object') return no('NO_QUOTES', 'no observation was supplied');
		if (!isNum(q.iv) || (q.iv as number) <= 0) return no('NO_IV', `a positive IV is required (got ${String(q.iv)})`);
		const spot = spotIndex.get(String(q.underlying));
		if (spot === undefined) return no('NO_SPOT', `no session spot was supplied for ${q.underlying}`);
		evidence.spot = spot;
		const optionType = q.optionType === 'CE' || q.optionType === 'PE' ? q.optionType : null;
		if (!optionType || !isNum(q.strike) || (q.strike as number) <= 0) return no('NO_QUOTES', 'strike and option right (CE/PE) are required');
		if (!/^\d{4}-\d{2}-\d{2}$/.test(String(q.sessionDate)) || !/^\d{4}-\d{2}-\d{2}$/.test(String(q.expiry))) return no('NO_EXPIRY', `session/expiry must be YYYY-MM-DD (got ${q.sessionDate} / ${q.expiry})`);
		const days = dayGap(String(q.sessionDate), String(q.expiry));
		if (days === null || days <= 0) return no('NO_EXPIRY', `expiry ${q.expiry} is not after session ${q.sessionDate}`);
		const years = days / 365;
		evidence.years = round6(years);
		if (years <= timeStepYears) return no('SMALL_T', `${days} day(s) to expiry is not enough for the ${cfg.timeStepDays}-day derivative step`);

		const iv = (q.iv as number) / 100; // the chain publishes IV as an annualised percent
		const g = (yearsAt: number, ivAt: number) => bsmGreeks({ spot, strike: q.strike as number, years: yearsAt, rate: cfg.rate }, optionType, ivAt);
		const dIvPlus = g(years, iv + cfg.volStep);
		const dIvMinus = g(years, iv - cfg.volStep);
		const dTPlus = g(years + timeStepYears, iv);
		const dTMinus = g(years - timeStepYears, iv);
		if (!dIvPlus || !dIvMinus || !dTPlus || !dTMinus || !isNum(dIvPlus.delta) || !isNum(dIvMinus.delta) || !isNum(dTPlus.delta) || !isNum(dTMinus.delta)) {
			return no('NO_GREEKS', 'the local model could not produce the neighbouring greeks needed for the central difference');
		}

		const vanna = (dIvPlus.delta - dIvMinus.delta) / (2 * cfg.volStep);
		const charm = -(dTPlus.delta - dTMinus.delta) / (2 * timeStepYears);
		return {
			...base,
			status: 'OK',
			reason: null,
			reasonDetail: null,
			values: { vanna: round6(vanna), vannaPerVolPoint: round6(vanna * 0.01), charm: round6(charm), charmPerDay: round6(charm / 365) },
		};
	});

	const counts: Record<VannaCharmStatus, number> = { OK: 0, UNAVAILABLE: 0, DISABLED: 0 };
	const refusalCounts = Object.fromEntries(VANNA_CHARM_REFUSALS.map((r) => [r, 0])) as Record<VannaCharmRefusal, number>;
	for (const o of observations) {
		counts[o.status] += 1;
		if (o.reason) refusalCounts[o.reason] += 1;
	}

	return {
		version: VANNA_CHARM_VERSION,
		enabled: cfg.enabled,
		config: cfg,
		spec: VANNA_CHARM_SPEC,
		observations,
		counts,
		refusalCounts,
		coverage: { quotesIn: observations.length, ok: counts.OK, unavailable: counts.UNAVAILABLE, disabled: counts.DISABLED },
		reviewerSummary: describeVannaCharm(cfg),
		digest: JSON.stringify(observations.map((o) => [o.underlying, o.expiry, o.strike, o.optionType, o.status, o.reason, o.values ? o.values.vanna : null, o.values ? o.values.charm : null])),
	};
}
