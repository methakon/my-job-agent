/**
 * GATE 7 #5 (roadmap row 73) — GEX / GAMMA-FLIP WITH EXPLICIT PARTICIPANT-POSITION ASSUMPTIONS.
 *
 * Single responsibility: aggregate per-strike gamma exposure from the archived option chain — gamma computed
 * LOCALLY (the row-71 BSM module, reused) from each contract's strike, IV, expiry and the session spot — under
 * ONE explicitly stated participant-position assumption, and locate the gamma flip when the cumulative profile
 * crosses zero. PURE: no clock, no I/O, no DB, no network, no AI, no randomness.
 *
 * ── THE ASSUMPTION IS MANDATORY (this is the row's whole point) ─────────────────────────────
 *   GEX depends on WHO is long gamma. This module REFUSES to compute anything without an explicit assumption
 *   (`assumptions` input) and echoes it on every row and the report, so a reader can never mistake a modelled
 *   convention for measured positioning:
 *     ALL_LONG           every contract's OI is assumed LONG gamma   (+1 calls and puts)
 *     ALL_SHORT          every contract's OI is assumed SHORT gamma  (−1 calls and puts)
 *     CALLS_LONG_PUTS_SHORT  calls long, puts short (the textbook dealer convention) — +1 calls, −1 puts
 *   The assumption is a MODEL INPUT, not a fact: nothing here claims to know real positioning.
 *
 * ── PINNED DEFINITION (formula, units, window, edges) ───────────────────────────────────────
 *   years        = (expiry − sessionDate) in calendar days / 365      (expiry must be after the session)
 *   gamma        = bsmGreeks({spot, strike, years, rate}, optionType, iv).gamma   (row-71 module; null ⇒ excluded)
 *   gex(contract)= sign(assumption, optionType) × gamma × oi × spot² × 0.01
 *                  — the standard "per 1% underlying move" notional convention. OI is used AS STORED
 *                  (contracts); no lot multiplier is applied because the canonical rows do not carry one.
 *   UNITS: gex in index-point² per 1% move (a documented convention, not rupees).
 *   WINDOW: one session + one expiry per call; the caller supplies them. No clock is read.
 *   GAMMA FLIP: the strikes where the CUMULATIVE gex (strikes ascending) changes sign. Reported as the pair of
 *   adjacent strikes bracketing the crossing — NEVER interpolated to a single price — or null (`NO_FLIP`) when
 *   the cumulative profile does not cross zero.
 *
 * ── MISSING / DEGENERATE DATA → a safe explicit state ───────────────────────────────────────
 *   NO_ASSUMPTIONS (the required assumption was not supplied) / NO_QUOTES / NO_SPOT /
 *   NO_EXPIRY (expiry not after the session) / DISABLED — null aggregates with a closed-vocabulary token.
 *   NO_FLIP is reported for the flip field only; the aggregate GEX remains available.
 *
 * RESEARCH / SHADOW ONLY: nothing in production imports this module (asserted by test); no state is written
 * and no decision, order or risk path reads it. Versioned: gex-v1.
 */

import { bsmGreeks } from '../bsm-greeks';

export const GEX_VERSION = 'gex-v1';

export type GexStatus = 'OK' | 'UNAVAILABLE' | 'DISABLED';
export const GEX_STATUSES: readonly GexStatus[] = ['OK', 'UNAVAILABLE', 'DISABLED'];

/** Closed, published refusal vocabulary (declaration order is the canonical order). */
export const GEX_REFUSALS = ['NO_ASSUMPTIONS', 'NO_QUOTES', 'NO_SPOT', 'NO_EXPIRY', 'NO_GAMMA'] as const;
export type GexRefusal = (typeof GEX_REFUSALS)[number];

export type DealerConvention = 'ALL_LONG' | 'ALL_SHORT' | 'CALLS_LONG_PUTS_SHORT';
export const DEALER_CONVENTIONS: readonly DealerConvention[] = ['ALL_LONG', 'ALL_SHORT', 'CALLS_LONG_PUTS_SHORT'];

export interface GexAssumption {
	convention: DealerConvention;
	/** Free-text provenance for the assumption (e.g. 'modelled: textbook dealer convention'). */
	label: string;
}

export interface GexQuote {
	underlying: string;
	sessionDate: string;
	expiry: string;
	strike: number | null;
	optionType: string | null;
	oi: number | null;
	iv: number | null;
	source?: string | null;
}

export interface GexConfig {
	enabled: boolean;
	/** Risk-free annual rate passed to the local greeks; a documented constant, not fitted. */
	rate: number;
}

export const DEFAULT_GEX_CONFIG: GexConfig = { enabled: true, rate: 0.065 };

export const GEX_SPEC = {
	feature: 'GammaExposure',
	version: GEX_VERSION,
	question: 'What is the per-strike gamma exposure and where is the gamma flip, under ONE explicit positioning assumption?',
	assumption: 'MANDATORY: ALL_LONG | ALL_SHORT | CALLS_LONG_PUTS_SHORT, echoed on every row — a model input, never a claim about real positioning',
	formula: 'years = (expiry − sessionDate)/365; gamma = local BSM (row 71); gex = sign(assumption, optionType) × gamma × oi × spot² × 0.01',
	units: 'gex in index-point² per 1% move (a documented convention); OI as stored (contracts); no lot multiplier applied',
	gammaFlip: 'the adjacent strikes bracketing a zero-crossing of the cumulative gex, never interpolated; NO_FLIP when the profile does not cross',
	thresholds: 'none — only the documented 1%-move convention and the risk-free rate constant',
	refuses: [...GEX_REFUSALS] as string[],
	missingData: 'no assumption, no quotes, no spot, an expiry not after the session, or no computable gamma ⇒ null aggregates with a closed-vocabulary token',
};

export const describeGex = (c: GexConfig = DEFAULT_GEX_CONFIG): string =>
	[
		`${GEX_VERSION}: per-strike gamma exposure from locally computed gamma (row 71 BSM) × OI × spot² × 0.01,`,
		`under ONE REQUIRED participant-position assumption (${DEALER_CONVENTIONS.join(' / ')}) that is echoed, not assumed.`,
		`The gamma flip is the adjacent strikes bracketing the zero-crossing of the cumulative profile and is`,
		`never interpolated; a profile that does not cross reports NO_FLIP. No threshold is tuned. enabled=${c.enabled}.`,
	].join(' ');

export interface StrikeGex {
	strike: number;
	gex: number;
	callGex: number;
	putGex: number;
	contracts: number;
}

export interface SurfaceGex {
	underlying: string;
	sessionDate: string;
	expiry: string | null;
	status: GexStatus;
	reason: GexRefusal | null;
	reasonDetail: string | null;
	assumption: GexAssumption | null;
	spot: number | null;
	totalGex: number | null;
	byStrike: StrikeGex[];
	gammaFlip: { lowerStrike: number; upperStrike: number } | null;
	flipReason: 'NO_FLIP' | null;
	excluded: { noGamma: number; noOi: number };
}

export interface GexReport {
	version: string;
	enabled: boolean;
	config: GexConfig;
	spec: typeof GEX_SPEC;
	assumption: GexAssumption | null;
	surfaces: SurfaceGex[];
	counts: Record<GexStatus, number>;
	refusalCounts: Record<GexRefusal, number>;
	coverage: { surfacesIn: number; ok: number; unavailable: number; disabled: number; quotesIn: number; contractsUsed: number; flips: number };
	reviewerSummary: string;
	digest: string;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const round6 = (v: number): number => Number(v.toFixed(6));
const dayGap = (from: string, to: string): number | null => {
	const a = Date.parse(`${from}T00:00:00Z`);
	const b = Date.parse(`${to}T00:00:00Z`);
	if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
	return Math.round((b - a) / 86_400_000);
};
const signOf = (convention: DealerConvention, optionType: string | null): number => {
	if (convention === 'ALL_LONG') return 1;
	if (convention === 'ALL_SHORT') return -1;
	return optionType === 'PE' ? -1 : 1; // CALLS_LONG_PUTS_SHORT
};

/**
 * Evaluate per-strike GEX for every (underlying, sessionDate, expiry) group. `spots` gives the session spot per
 * underlying (required — gamma cannot be computed without it). Deterministic: groups/strikes are canonically
 * ordered and the digest is a function of the DATA alone.
 */
export function evaluateGex(
	quotes: GexQuote[],
	spots: Array<{ underlying: string; spot: number | null }>,
	assumptions: GexAssumption | null,
	config: Partial<GexConfig> = {},
): GexReport {
	const cfg: GexConfig = { ...DEFAULT_GEX_CONFIG, ...config };
	const spotIndex = new Map<string, number>();
	for (const s of spots ?? []) if (isNum(s?.spot) && (s.spot as number) > 0) spotIndex.set(String(s.underlying), s.spot as number);

	const groups = new Map<string, GexQuote[]>();
	for (const q of quotes ?? []) {
		const k = `${String(q?.underlying ?? '').trim()}|${String(q?.sessionDate ?? '')}|${String(q?.expiry ?? '')}`;
		if (!groups.has(k)) groups.set(k, []);
		groups.get(k)!.push(q);
	}

	const surfaces: SurfaceGex[] = [...groups.keys()].sort().map((key) => {
		const [underlying, sessionDate, expiry] = key.split('|');
		const rows = groups.get(key)!;
		const excluded = { noGamma: 0, noOi: 0 };
		const empty = { underlying, sessionDate, expiry: expiry || null, assumption: assumptions ?? null, spot: spotIndex.get(underlying) ?? null, totalGex: null, byStrike: [] as StrikeGex[], gammaFlip: null, flipReason: null as 'NO_FLIP' | null, excluded };
		const no = (reason: GexRefusal, detail: string): SurfaceGex => ({ ...empty, status: 'UNAVAILABLE', reason, reasonDetail: detail });

		if (!cfg.enabled) return { ...empty, status: 'DISABLED' as const, reason: null, reasonDetail: 'the component is disabled; no GEX was computed for this group' };
		if (!assumptions || !DEALER_CONVENTIONS.includes(assumptions.convention)) return no('NO_ASSUMPTIONS', 'a participant-position assumption (ALL_LONG | ALL_SHORT | CALLS_LONG_PUTS_SHORT) is REQUIRED and was not supplied — positioning is never assumed silently');
		if (!/^\d{4}-\d{2}-\d{2}$/.test(sessionDate)) return no('NO_EXPIRY', `"${sessionDate}" is not a usable session date`);
		if (!rows.length) return no('NO_QUOTES', 'no quotes were supplied for this group');
		const years = /^\d{4}-\d{2}-\d{2}$/.test(expiry) ? (dayGap(sessionDate, expiry) ?? 0) / 365 : null;
		if (years === null || years <= 0) return no('NO_EXPIRY', `expiry "${expiry}" is not after session ${sessionDate}`);
		const spot = spotIndex.get(underlying);
		if (spot === undefined) return no('NO_SPOT', `no session spot was supplied for ${underlying}, so gamma cannot be computed`);

		const perStrike = new Map<number, StrikeGex>();
		let anyGamma = false;
		for (const q of rows) {
			if (!isNum(q.oi) || (q.oi as number) <= 0) { excluded.noOi += 1; continue; }
			if (!isNum(q.iv) || (q.iv as number) <= 0 || !isNum(q.strike) || !q.optionType) { excluded.noGamma += 1; continue; }
			const optionType = q.optionType === 'CE' || q.optionType === 'PE' ? q.optionType : null;
			if (!optionType) { excluded.noGamma += 1; continue; }
			// iv is supplied as an annualised PERCENT by the chain; the local BSM takes a fraction.
			const g = bsmGreeks({ spot, strike: q.strike as number, years, rate: cfg.rate }, optionType, (q.iv as number) / 100);
			if (!g || !isNum(g.gamma)) { excluded.noGamma += 1; continue; }
			anyGamma = true;
			const gex = signOf(assumptions.convention, optionType) * g.gamma * (q.oi as number) * spot * spot * 0.01;
			const strike = q.strike as number;
			if (!perStrike.has(strike)) perStrike.set(strike, { strike, gex: 0, callGex: 0, putGex: 0, contracts: 0 });
			const cell = perStrike.get(strike)!;
			cell.gex += gex;
			if (optionType === 'CE') cell.callGex += gex;
			else cell.putGex += gex;
			cell.contracts += 1;
		}
		if (!anyGamma) return no('NO_GAMMA', `no contract yielded a computable gamma (${excluded.noGamma} without usable IV/strike/right, ${excluded.noOi} without OI)`);

		const byStrike = [...perStrike.values()].sort((a, b) => a.strike - b.strike).map((c) => ({ strike: c.strike, gex: round6(c.gex), callGex: round6(c.callGex), putGex: round6(c.putGex), contracts: c.contracts }));
		const totalGex = round6(byStrike.reduce((a, c) => a + c.gex, 0));

		// gamma flip: the adjacent strikes bracketing a zero-crossing of the CUMULATIVE gex (never interpolated)
		let cumulative = 0;
		let flip: { lowerStrike: number; upperStrike: number } | null = null;
		for (let i = 0; i < byStrike.length; i += 1) {
			const prev = cumulative;
			cumulative += byStrike[i].gex;
			if (i > 0 && prev !== 0 && cumulative !== 0 && Math.sign(prev) !== Math.sign(cumulative) && !flip) {
				flip = { lowerStrike: byStrike[i - 1].strike, upperStrike: byStrike[i].strike };
			}
		}

		return { ...empty, status: 'OK' as const, reason: null, reasonDetail: null, totalGex, byStrike, gammaFlip: flip, flipReason: flip ? null : 'NO_FLIP' };
	});

	const counts: Record<GexStatus, number> = { OK: 0, UNAVAILABLE: 0, DISABLED: 0 };
	const refusalCounts = Object.fromEntries(GEX_REFUSALS.map((r) => [r, 0])) as Record<GexRefusal, number>;
	let contractsUsed = 0;
	let flips = 0;
	for (const s of surfaces) {
		counts[s.status] += 1;
		if (s.reason) refusalCounts[s.reason] += 1;
		contractsUsed += s.byStrike.reduce((a, c) => a + c.contracts, 0);
		if (s.gammaFlip) flips += 1;
	}

	return {
		version: GEX_VERSION,
		enabled: cfg.enabled,
		config: cfg,
		spec: GEX_SPEC,
		assumption: assumptions ?? null,
		surfaces,
		counts,
		refusalCounts,
		coverage: { surfacesIn: surfaces.length, ok: counts.OK, unavailable: counts.UNAVAILABLE, disabled: counts.DISABLED, quotesIn: (quotes ?? []).length, contractsUsed, flips },
		reviewerSummary: describeGex(cfg),
		digest: JSON.stringify(surfaces.map((s) => [s.underlying, s.sessionDate, s.expiry, s.status, s.reason, s.assumption?.convention ?? null, s.totalGex, s.gammaFlip, s.flipReason])),
	};
}
