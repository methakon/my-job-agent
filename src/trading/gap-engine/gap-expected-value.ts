/**
 * GATE 4 #10 (roadmap row 47) — EXPECTED VALUE AFTER SPREAD, SLIPPAGE AND FEES.
 *
 * Single responsibility: turn ONE priced trade plan plus an EXPLICIT probability input into the net
 * expected value that remains after the round-trip friction (spread + slippage) and the statutory/ broker
 * fee schedule — and say so explicitly when any required input is absent. PURE: no clock, no I/O, no DB,
 * no network, no AI, no randomness. Everything it needs is an argument.
 *
 * ── PINNED DEFINITION (inputs, transformation, units, boundaries) ──────────────────────────
 *   plan       = direction (LONG/SHORT), entryPrice, targetPrice, stopPrice, units, segment
 *                (future|option), and the two MARKET-STRUCTURE friction inputs per unit:
 *                spreadPoints (bid/ask paid to enter and exit) and slippagePoints.
 *                pWin is an INPUT, never estimated here, and carries its provenance (`source`).
 *   geometry   = rewardPoints = |target − entry|; riskPoints = |entry − stop| (the R of the trade);
 *                rewardRiskRatio = rewardPoints / riskPoints.
 *   fees       = the PINNED fee schedule (EV_FEE_SCHEDULE, versioned) applied to a ROUND TRIP:
 *                a BUY leg and a SELL leg, each costed on the ENTRY notional (price × units) — a single
 *                documented notional so a winner and a loser are charged the same fees; brokerage is the
 *                TRUE lower-of for futures and flat for options (mirrors the production desk's rule).
 *   costs      = costPoints = spreadPoints + slippagePoints + feesRupees / units   (per unit, points)
 *   EV         = grossEvPoints = pWin × rewardPoints − (1 − pWin) × riskPoints
 *                netEvPoints   = grossEvPoints − costPoints
 *                expectancyPerUnitRisk = netEvPoints / riskPoints
 *                breakEvenProbability  = (riskPoints + costPoints) / (rewardPoints + riskPoints)
 *
 *   UNITS: prices and geometry in index points; friction in index points per unit; fees in rupees and
 *   converted to points via /units; probabilities dimensionless in [0, 1].
 *
 *   TIMESTAMP BOUNDARY: this is a PURE calculator over a plan that the caller has already timestamped;
 *   it reads no session clock and makes no claim about WHEN the plan is valid. Any look-ahead discipline
 *   belongs to the module that DERIVES a plan (the caller must supply entry/target/stop/friction/pWin
 *   knowable at decision time).
 *
 * ── MISSING / DEGENERATE DATA → a safe explicit state ───────────────────────────────────────
 *   INVALID_GEOMETRY (non-finite price/units, units <= 0, or target/stop on the wrong side of entry)
 *   / ZERO_RISK (|entry − stop| = 0, so expectancy-per-risk is undefined)
 *   / NO_PROBABILITY (pWin absent) / INVALID_PROBABILITY (pWin outside [0, 1])
 *   / NO_FRICTION (spread or slippage absent) / INVALID_FRICTION (negative or non-finite)
 *   — a refusal still reports the geometry and/or probability it could validate, and EV is null, never a
 *   fabricated number. A zero/absent friction input is NEVER silently treated as "no friction".
 *
 * RESEARCH / SHADOW ONLY: nothing in production imports this module (asserted by test); no state is
 * written and no decision, order or risk path reads it. Versioned: gapev-v1.
 */

import { FailedOrbCandidate } from './gap-candidates';

export const GAP_EXPECTED_VALUE_VERSION = 'gapev-v1';

export type EvDirection = 'LONG' | 'SHORT';
export const EV_DIRECTIONS: readonly EvDirection[] = ['LONG', 'SHORT'];

export type EvCostSegment = 'future' | 'option';
export const EV_SEGMENTS: readonly EvCostSegment[] = ['future', 'option'];

export type EvStatus = 'OK' | 'UNAVAILABLE' | 'DISABLED';
export const EV_STATUSES: readonly EvStatus[] = ['OK', 'UNAVAILABLE', 'DISABLED'];

/** Closed, published refusal vocabulary (declaration order is the canonical order). */
export const EV_REFUSALS = [
	'INVALID_GEOMETRY',
	'ZERO_RISK',
	'NO_PROBABILITY',
	'INVALID_PROBABILITY',
	'NO_FRICTION',
	'INVALID_FRICTION',
] as const;
export type EvRefusal = (typeof EV_REFUSALS)[number];

/**
 * The fee schedule this version pins. Values mirror the production FYERS desk model
 * (src/trading/fnf-trading.service.ts, verified 2026-09-04): futures brokerage = lower of 0.03% ×
 * turnover or ₹20; options = flat ₹20 per executed order; STT sell-side only (futures 0.01%, options
 * 0.05% of premium); NSE txn (futures 0.00183%, options 0.03553%); stamp duty buy-side (futures 0.002%,
 * options 0.003%); SEBI ₹10/crore; GST 18% on (brokerage + txn + SEBI). Changing any value REQUIRES a
 * new id.
 */
export const EV_FEE_SCHEDULE_VERSION = 'fyers-2026-09-04';

export interface FeeRates {
	brokeragePct: number;
	brokerageFlat: number;
	sttSellPct: number;
	exchangeTxnPct: number;
	stampBuyPct: number;
}

export interface EvFeeSchedule {
	future: FeeRates;
	option: FeeRates;
	gstPct: number;
	sebiPct: number;
}

export const DEFAULT_EV_FEE_SCHEDULE: EvFeeSchedule = {
	future: { brokeragePct: 0.0003, brokerageFlat: 20, sttSellPct: 0.0001, exchangeTxnPct: 0.0000183, stampBuyPct: 0.00002 },
	option: { brokeragePct: 0, brokerageFlat: 20, sttSellPct: 0.0005, exchangeTxnPct: 0.0003553, stampBuyPct: 0.00003 },
	gstPct: 0.18,
	sebiPct: 0.000001,
};

export interface GapExpectedValueConfig {
	enabled: boolean;
	feeSchedule: EvFeeSchedule;
}

export const DEFAULT_GAP_EXPECTED_VALUE_CONFIG: GapExpectedValueConfig = {
	enabled: true,
	feeSchedule: DEFAULT_EV_FEE_SCHEDULE,
};

export const GAP_EXPECTED_VALUE_SPEC = {
	feature: 'GapExpectedValue',
	version: GAP_EXPECTED_VALUE_VERSION,
	question: 'After spread, slippage and the fee schedule, what net expected value does one priced plan carry, given an explicit probability?',
	inputs: 'direction, entry/target/stop, units, segment, spreadPoints, slippagePoints, and pWin with its provenance — all supplied by the caller',
	transformation: 'reward = |target − entry|; risk = |entry − stop|; gross = pWin × reward − (1 − pWin) × risk; cost = spread + slippage + round-trip fees/units; net = gross − cost',
	fees: `pinned schedule ${EV_FEE_SCHEDULE_VERSION}, round trip costed on the entry notional; futures brokerage is the true lower-of, options flat; STT sell-side only`,
	units: 'prices and geometry in index points; friction in index points per unit; fees in rupees converted via /units; probabilities in [0, 1]',
	boundaries: 'pure calculator over a caller-timestamped plan; it reads no session clock and the caller owns look-ahead discipline',
	thresholds: 'none — no probability, friction or fee value is chosen from historical outcomes',
	refuses: [...EV_REFUSALS] as string[],
	missingData: 'invalid geometry / zero risk / absent-or-invalid probability / absent-or-invalid friction ⇒ a null EV with a closed-vocabulary token; a zero or absent friction input is never treated as no friction',
};

export const describeGapExpectedValue = (c: GapExpectedValueConfig = DEFAULT_GAP_EXPECTED_VALUE_CONFIG): string =>
	[
		`${GAP_EXPECTED_VALUE_VERSION}: net expected value of one priced plan after spread, slippage and fees.`,
		`reward = |target − entry|, risk = |entry − stop|, gross = pWin × reward − (1 − pWin) × risk,`,
		`cost = spreadPoints + slippagePoints + round-trip fees / units (fees from schedule ${EV_FEE_SCHEDULE_VERSION}, costed on the entry notional),`,
		`net = gross − cost; expectancy per unit risk = net / risk; break-even probability = (risk + cost) / (reward + risk).`,
		`pWin and the two friction inputs are REQUIRED and supplied by the caller — this module never estimates them.`,
		`Missing or degenerate input refuses with one of ${EV_REFUSALS.join(' / ')} and a null EV. enabled=${c.enabled}.`,
	].join(' ');

// ── shapes ──────────────────────────────────────────────────────────────────

export interface GapEvPlan {
	sessionDate: string;
	instrument: string;
	direction: EvDirection;
	entryPrice: number;
	targetPrice: number;
	stopPrice: number;
	units: number;
	/** Defaults to 'future'. */
	segment?: EvCostSegment;
	/** Round-trip bid/ask cost in index points PER UNIT. Required. */
	spreadPoints?: number | null;
	/** Round-trip slippage in index points PER UNIT. Required. */
	slippagePoints?: number | null;
	/** Probability the TARGET is reached before the STOP. Required. */
	pWin?: number | null;
	/** Where pWin came from (e.g. an assumption label or a model id). Required with pWin. */
	probabilitySource?: string | null;
}

export interface PlanGeometry {
	rewardPoints: number;
	riskPoints: number;
	rewardRiskRatio: number;
	breakEvenProbabilityFrictionless: number;
}

export interface PlanCosts {
	spreadPoints: number;
	slippagePoints: number;
	feesRupees: number;
	feesPoints: number;
	totalPoints: number;
}

export interface PlanEv {
	grossEvPoints: number;
	netEvPoints: number;
	expectancyPerUnitRisk: number;
	breakEvenProbability: number;
}

export interface PlanExpectedValue {
	sessionDate: string;
	instrument: string;
	status: EvStatus;
	reason: EvRefusal | null;
	reasonDetail: string | null;
	direction: EvDirection | null;
	segment: EvCostSegment | null;
	units: number | null;
	probability: { pWin: number | null; source: string | null };
	geometry: PlanGeometry | null;
	costs: PlanCosts | null;
	ev: PlanEv | null;
	evidence: Record<string, number | null>;
}

export interface GapExpectedValueReport {
	version: string;
	enabled: boolean;
	config: GapExpectedValueConfig;
	feeScheduleVersion: string;
	spec: typeof GAP_EXPECTED_VALUE_SPEC;
	plans: PlanExpectedValue[];
	counts: Record<EvStatus, number>;
	refusalCounts: Record<EvRefusal, number>;
	/** Over the OK rows: how many carried positive / zero / negative net EV. */
	distribution: { positive: number; zero: number; negative: number };
	coverage: { plansIn: number; ok: number; unavailable: number; disabled: number; sampleSize: number };
	reviewerSummary: string;
	digest: string;
}

// ── fee model ───────────────────────────────────────────────────────────────

/** FYERS cost for ONE executed leg, on the given notional. Mirrors the production desk rule exactly. */
export const legCostRupees = (notional: number, side: 'BUY' | 'SELL', rates: FeeRates, gstPct: number, sebiPct: number): number => {
	const n = Math.max(notional, 0);
	// TRUE lower-of: the flat fee wins only when it is the smaller charge.
	const brokerage = rates.brokeragePct > 0 ? Math.min(Math.max(rates.brokeragePct * n, 0), rates.brokerageFlat) : Math.min(rates.brokerageFlat, n);
	const stt = side === 'SELL' ? rates.sttSellPct * n : 0;
	const exchangeTxn = rates.exchangeTxnPct * n;
	const sebi = sebiPct * n;
	// GST applies to brokerage + exchange txn + SEBI (taxable services), not STT/stamp.
	const gst = gstPct * (brokerage + exchangeTxn + sebi);
	const stamp = side === 'BUY' ? rates.stampBuyPct * n : 0;
	return brokerage + stt + exchangeTxn + gst + sebi + stamp;
};

/** Round-trip fees (BUY leg + SELL leg), both costed on the ENTRY notional — one documented notional. */
export const roundTripFeesRupees = (entryPrice: number, units: number, segment: EvCostSegment, schedule: EvFeeSchedule): number => {
	const notional = Math.max(entryPrice, 0) * Math.max(units, 0);
	const r = schedule[segment] ?? schedule.future;
	return legCostRupees(notional, 'BUY', r, schedule.gstPct, schedule.sebiPct) + legCostRupees(notional, 'SELL', r, schedule.gstPct, schedule.sebiPct);
};

// ── evaluation ──────────────────────────────────────────────────────────────

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const round6 = (v: number): number => Number(v.toFixed(6));

const byPlan = (plans: GapEvPlan[]): GapEvPlan[] =>
	[...plans].sort((a, b) => {
		if (a.sessionDate !== b.sessionDate) return a.sessionDate < b.sessionDate ? -1 : 1;
		if (a.instrument !== b.instrument) return a.instrument < b.instrument ? -1 : 1;
		if (a.direction !== b.direction) return a.direction < b.direction ? -1 : 1;
		const ka = `${a.entryPrice}|${a.targetPrice}|${a.stopPrice}|${a.units}|${a.segment ?? ''}`;
		const kb = `${b.entryPrice}|${b.targetPrice}|${b.stopPrice}|${b.units}|${b.segment ?? ''}`;
		return ka < kb ? -1 : ka > kb ? 1 : 0;
	});

type GeometryResult = { geometry: PlanGeometry | null; refusal: EvRefusal | null; detail: string | null };

const geometryOf = (p: GapEvPlan): GeometryResult => {
	if (!isNum(p.entryPrice) || !isNum(p.targetPrice) || !isNum(p.stopPrice) || !isNum(p.units) || p.units <= 0) {
		return { geometry: null, refusal: 'INVALID_GEOMETRY', detail: 'entry/target/stop must be finite and units must be > 0' };
	}
	// Non-strict: a target/stop ON the entry passes this check and is caught below as ZERO_RISK / zero
	// reward, so "stop == entry" reports its own token instead of a generic geometry error.
	const wrongSide = p.direction === 'LONG'
		? !(p.targetPrice >= p.entryPrice && p.stopPrice <= p.entryPrice)
		: !(p.targetPrice <= p.entryPrice && p.stopPrice >= p.entryPrice);
	if (wrongSide) {
		return { geometry: null, refusal: 'INVALID_GEOMETRY', detail: `a ${p.direction} plan needs the target on the favourable side of entry and the stop on the adverse side (entry=${p.entryPrice}, target=${p.targetPrice}, stop=${p.stopPrice})` };
	}
	const rewardPoints = Math.abs(p.targetPrice - p.entryPrice);
	const riskPoints = Math.abs(p.entryPrice - p.stopPrice);
	if (!(riskPoints > 0)) return { geometry: null, refusal: 'ZERO_RISK', detail: 'the stop equals the entry, so expectancy per unit risk is undefined' };
	return {
		geometry: {
			rewardPoints: round6(rewardPoints),
			riskPoints: round6(riskPoints),
			rewardRiskRatio: round6(rewardPoints / riskPoints),
			breakEvenProbabilityFrictionless: round6(riskPoints / (riskPoints + rewardPoints)),
		},
		refusal: null,
		detail: null,
	};
};

const base = (p: GapEvPlan) => ({
	sessionDate: p.sessionDate,
	instrument: p.instrument,
	direction: p.direction ?? null,
	segment: (p.segment ?? 'future') as EvCostSegment,
	units: isNum(p.units) ? p.units : null,
	probability: { pWin: isNum(p.pWin) ? p.pWin : null, source: p.probabilitySource ?? null },
	evidence: {
		entryPrice: isNum(p.entryPrice) ? p.entryPrice : null,
		targetPrice: isNum(p.targetPrice) ? p.targetPrice : null,
		stopPrice: isNum(p.stopPrice) ? p.stopPrice : null,
		spreadPoints: isNum(p.spreadPoints) ? (p.spreadPoints as number) : null,
		slippagePoints: isNum(p.slippagePoints) ? (p.slippagePoints as number) : null,
	} as Record<string, number | null>,
});

function evaluateOne(p: GapEvPlan, cfg: GapExpectedValueConfig): PlanExpectedValue {
	const common = base(p);

	if (!cfg.enabled) {
		return { ...common, status: 'DISABLED', reason: null, reasonDetail: 'the component is disabled; no geometry or EV was computed for this input', geometry: null, costs: null, ev: null };
	}

	const g = geometryOf(p);
	if (g.refusal) return { ...common, status: 'UNAVAILABLE', reason: g.refusal, reasonDetail: g.detail, geometry: g.geometry, costs: null, ev: null };

	if (!isNum(p.pWin)) {
		return { ...common, status: 'UNAVAILABLE', reason: 'NO_PROBABILITY', reasonDetail: 'pWin was not supplied; this calculator never estimates it (a probability is an input, not an output)', geometry: g.geometry, costs: null, ev: null };
	}
	if (p.pWin < 0 || p.pWin > 1) {
		return { ...common, status: 'UNAVAILABLE', reason: 'INVALID_PROBABILITY', reasonDetail: `pWin=${p.pWin} is outside [0, 1]`, geometry: g.geometry, costs: null, ev: null };
	}

	if (!isNum(p.spreadPoints) || !isNum(p.slippagePoints)) {
		return { ...common, status: 'UNAVAILABLE', reason: 'NO_FRICTION', reasonDetail: 'spreadPoints and slippagePoints are required; an absent friction input is never treated as zero friction', geometry: g.geometry, costs: null, ev: null };
	}
	if (p.spreadPoints < 0 || p.slippagePoints < 0) {
		return { ...common, status: 'UNAVAILABLE', reason: 'INVALID_FRICTION', reasonDetail: `spreadPoints=${p.spreadPoints} and slippagePoints=${p.slippagePoints} must be >= 0`, geometry: g.geometry, costs: null, ev: null };
	}

	const geo = g.geometry as PlanGeometry;
	const units = p.units;
	const segment = (p.segment ?? 'future') as EvCostSegment;
	const feesRupees = roundTripFeesRupees(p.entryPrice, units, segment, cfg.feeSchedule);
	const feesPoints = feesRupees / units;
	const totalPoints = p.spreadPoints + p.slippagePoints + feesPoints;
	const grossEvPoints = p.pWin * geo.rewardPoints - (1 - p.pWin) * geo.riskPoints;
	const netEvPoints = grossEvPoints - totalPoints;

	return {
		...common,
		status: 'OK',
		reason: null,
		reasonDetail: null,
		geometry: geo,
		costs: {
			spreadPoints: round6(p.spreadPoints),
			slippagePoints: round6(p.slippagePoints),
			feesRupees: round6(feesRupees),
			feesPoints: round6(feesPoints),
			totalPoints: round6(totalPoints),
		},
		ev: {
			grossEvPoints: round6(grossEvPoints),
			netEvPoints: round6(netEvPoints),
			expectancyPerUnitRisk: round6(netEvPoints / geo.riskPoints),
			breakEvenProbability: round6((geo.riskPoints + totalPoints) / (geo.riskPoints + geo.rewardPoints)),
		},
	};
}

/**
 * Evaluate every plan. Input order is irrelevant; rows are emitted in canonical order and the digest is a
 * function of the DATA alone.
 */
export function evaluateGapExpectedValue(plans: GapEvPlan[], config: Partial<GapExpectedValueConfig> = {}): GapExpectedValueReport {
	const cfg: GapExpectedValueConfig = { ...DEFAULT_GAP_EXPECTED_VALUE_CONFIG, ...config, feeSchedule: { ...DEFAULT_GAP_EXPECTED_VALUE_CONFIG.feeSchedule, ...(config.feeSchedule ?? {}) } };
	const ordered = byPlan(plans ?? []);
	const rows = ordered.map((p) => evaluateOne(p, cfg));

	const counts: Record<EvStatus, number> = { OK: 0, UNAVAILABLE: 0, DISABLED: 0 };
	const refusalCounts = Object.fromEntries(EV_REFUSALS.map((r) => [r, 0])) as Record<EvRefusal, number>;
	const distribution = { positive: 0, zero: 0, negative: 0 };
	for (const r of rows) {
		counts[r.status] += 1;
		if (r.reason) refusalCounts[r.reason] += 1;
		if (r.status === 'OK' && r.ev) {
			if (r.ev.netEvPoints > 0) distribution.positive += 1;
			else if (r.ev.netEvPoints < 0) distribution.negative += 1;
			else distribution.zero += 1;
		}
	}

	return {
		version: GAP_EXPECTED_VALUE_VERSION,
		enabled: cfg.enabled,
		config: cfg,
		feeScheduleVersion: EV_FEE_SCHEDULE_VERSION,
		spec: GAP_EXPECTED_VALUE_SPEC,
		plans: rows,
		counts,
		refusalCounts,
		distribution,
		coverage: { plansIn: ordered.length, ok: counts.OK, unavailable: counts.UNAVAILABLE, disabled: counts.DISABLED, sampleSize: counts.OK },
		reviewerSummary: describeGapExpectedValue(cfg),
		digest: JSON.stringify(rows.map((r) => [r.sessionDate, r.instrument, r.status, r.reason, r.direction, r.segment, r.ev ? r.ev.netEvPoints : null, r.ev ? r.ev.breakEvenProbability : null])),
	};
}

// ── plan derivation from a GATE 4 candidate (real archived geometry) ──────────

export const PLAN_DERIVATION_SPEC = {
	from: 'FAILED_ORB candidate (row 40)',
	rule: 'fade the failed breakout: entry = the re-entry price; target = the OPPOSITE edge of the opening range; stop = the excursion extreme on the breakout side (high + excursion for an UP breakout, low − excursion for a DOWN breakout)',
	direction: 'opposite of the breakout direction (an UP breakout that re-entered is SHORT; a DOWN breakout is LONG)',
	note: 'uses only fields the candidate already exposes; a non-candidate or a row without openingRange/breakout/reEntry yields null — no plan is invented',
};

/**
 * Derive ONE priced plan from a FAILED_ORB candidate. Returns null when the row is not a candidate or
 * lacks the levels. Friction and probability are deliberately left absent — they are caller inputs.
 */
export function planFromFailedOrb(c: FailedOrbCandidate): GapEvPlan | null {
	if (c.isCandidate !== true || !c.direction || !c.openingRange || !c.breakout || !c.reEntry || !isNum(c.excursion)) return null;
	const { low, high } = c.openingRange;
	if (!isNum(low) || !isNum(high) || !isNum(c.reEntry.price)) return null;
	if (c.direction === 'UP') {
		// breakout up then failed ⇒ fade DOWN (SHORT): stop above the excursion extreme
		return { sessionDate: c.sessionDate, instrument: c.instrument, direction: 'SHORT', entryPrice: c.reEntry.price, targetPrice: low, stopPrice: high + c.excursion, units: 1, segment: 'future' };
	}
	// breakout down then failed ⇒ fade UP (LONG): stop below the excursion extreme
	return { sessionDate: c.sessionDate, instrument: c.instrument, direction: 'LONG', entryPrice: c.reEntry.price, targetPrice: high, stopPrice: low - c.excursion, units: 1, segment: 'future' };
}
