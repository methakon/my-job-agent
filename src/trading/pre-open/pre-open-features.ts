/**
 * GATE 2 — pre-open observation validation, per-field quality and derived
 * opening features. PURE and DETERMINISTIC: the same historical input always
 * produces the same derived result (item 13/14). No clock read, no randomness,
 * no I/O — `nowMs` is always passed in, so live capture and replay share one
 * code path.
 *
 * MISSING-DATA CONTRACT (item 6): nothing is ever guessed. A price of 0 for an
 * indicative field is the source's "no auction" SENTINEL, not a real price, and
 * a negative/non-finite value is INVALID. Any feature whose inputs are not
 * usable returns status 'UNAVAILABLE' with a reason — never 0, never a
 * carry-forward of an older value.
 *
 * FORMULAS (documented, versioned as PRE_OPEN_FEATURES_VERSION):
 *   gapPoints          = indicativePrice - previousClose
 *   gapPct             = (indicativePrice - previousClose) / previousClose * 100
 *   auctionImbalance   = buyQuantity - sellQuantity
 *   auctionImbalancePct = (buyQuantity - sellQuantity) / max(buyQuantity + sellQuantity, EPSILON)
 *
 * OAI — OPEN AUCTION IMBALANCE (GATE 2 item 2, roadmap row 21)
 *   OAI = (BuyQty - SellQty) / (BuyQty + SellQty)
 *
 * `auctionImbalancePct` IS the roadmap's OAI; the payload also carries it under the
 * roadmap name (`oai`) so the roadmap term is traceable in the stored/replayed data.
 * They are the SAME object — one computation, two names — and a test asserts the
 * identity, so the two can never drift apart.
 *
 *   units   : dimensionless ratio in [-1, +1] (+1 all buy, -1 all sell, 0 balanced)
 *   window  : auction phases only (PRE_OPEN / OPEN_AUCTION). Outside that window the
 *             source's buy/sell totals are live market depth, so it reports
 *             UNAVAILABLE/'outside_auction_phase' rather than a fabricated imbalance.
 *   edge    : buy+sell == 0 → UNAVAILABLE ('no auction imbalance to measure'), never 0;
 *             either side missing/non-finite → UNAVAILABLE; both sides 0 → UNAVAILABLE.
 *             The IMBALANCE_EPSILON denominator guard exists only so a degenerate zero
 *             total cannot produce NaN/Infinity — that case is already refused above,
 *             so the guard never distorts a legitimate live value.
 *
 * Auction features are defined ONLY inside an auction phase (PRE_OPEN /
 * OPEN_AUCTION). Outside that window the source's buy/sell totals are live
 * market depth, not auction imbalance, so the features report UNAVAILABLE with
 * reason 'outside_auction_phase' — reusing them would silently fabricate meaning.
 */

import { SessionPhase, isAuctionPhase } from './pre-open-session';

/**
 * Bump when the derived payload's SHAPE or semantics change, so a stored row can be
 * audited against the definition that produced it.
 *   po-v1 → gapPoints/gapPct/auctionImbalance/auctionImbalancePct
 *   po-v2 → + `oai` (roadmap name for auctionImbalancePct; same computation)
 */
export const PRE_OPEN_FEATURES_VERSION = 'po-v2';

/** Denominator guard for auctionImbalancePct. */
export const IMBALANCE_EPSILON = 1;

/** An event timestamp ahead of receive time by more than this is INVALID. */
export const FUTURE_TOLERANCE_MS = 120_000;

/**
 * Plausibility floor. A live feed cannot legitimately stamp a current session
 * with a placeholder/epoch timestamp (1970, 0001-01-01, a boot-time default), so
 * such a value is INVALID rather than "very old but usable".
 */
export const MIN_PLAUSIBLE_EVENT_MS = Date.parse('2020-01-01T00:00:00+05:30');

/** Staleness ceiling used when a caller does not supply its own. */
export const DEFAULT_STALE_MAX_AGE_MS = 120_000;

export type FieldQuality = 'OK' | 'MISSING' | 'ABSENT' | 'SENTINEL_ZERO' | 'INVALID' | 'OUT_OF_PHASE';
export type ObservationQuality = 'COMPLETE' | 'PARTIAL' | 'UNAVAILABLE' | 'STALE' | 'INVALID';
export type DerivedStatus = 'OK' | 'UNAVAILABLE';

export type DepthLevel = { price: number | null; quantity: number | null } | null;

/** The normalized values an adapter hands to validation. */
export type PreOpenSourceValues = {
  instrumentKey: string;
  symbol?: string | null;
  underlying?: string | null;
  exchange?: string | null;
  eventTime: Date | null;
  previousClose: number | null;
  referencePrice: number | null;
  indicativePrice: number | null;
  indicativeQuantity: number | null;
  imbalanceTotal: number | null;
  imbalanceMarket: number | null;
  buyQuantity: number | null;
  sellQuantity: number | null;
  lastPrice: number | null;
  volume: number | null;
  depthBestBid?: DepthLevel;
  depthBestAsk?: DepthLevel;
  /** Source keys the payload actually carried (absent ≠ present-but-null). */
  presentKeys?: string[];
};

export type AssessContext = {
  nowMs: number;
  staleMaxAgeMs: number;
  phase: SessionPhase;
};

export type AssessedObservation = {
  quality: ObservationQuality;
  fieldQuality: Record<string, FieldQuality>;
  reasons: string[];
  dataAgeMs: number | null;
};

export const finiteOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** A usable price is finite and strictly positive (0 is the no-auction sentinel). */
export const isUsablePrice = (v: number | null): boolean => v !== null && Number.isFinite(v) && v > 0;

/** A usable quantity is finite and non-negative. */
export const isUsableQty = (v: number | null): boolean => v !== null && Number.isFinite(v) && v >= 0;

const round = (v: number, dp = 6): number => Number(v.toFixed(dp));

/**
 * Classify one raw source field. `absent` is true when the payload did not
 * carry the key at all; that is a different fact from "carried, but null".
 */
export function classifyField(
  raw: unknown,
  opts: { kind: 'price' | 'qty'; absent: boolean; inAuctionPhase: boolean; required: boolean },
): FieldQuality {
  if (opts.absent) return 'ABSENT';
  const n = finiteOrNull(raw);
  if (n === null) return opts.required ? 'MISSING' : 'MISSING';
  if (opts.kind === 'price' && n === 0) return 'SENTINEL_ZERO';
  if (opts.kind === 'price' && n < 0) return 'INVALID';
  if (opts.kind === 'qty' && n < 0) return 'INVALID';
  if (!opts.inAuctionPhase) return 'OUT_OF_PHASE';
  return 'OK';
}

/**
 * Validate a normalized observation and decide its overall quality.
 *
 * INVALID     timestamp missing/unparseable, or ahead of receive time
 * STALE       event older than staleMaxAgeMs
 * COMPLETE    in an auction phase with usable previous close, IEP and both quantities
 * PARTIAL     in an auction phase with some — but not all — usable auction values
 * UNAVAILABLE no usable auction value (includes every non-auction phase)
 */
export function assessObservation(values: PreOpenSourceValues, ctx: AssessContext): AssessedObservation {
  const reasons: string[] = [];
  const present = new Set(values.presentKeys ?? []);
  const inPhase = isAuctionPhase(ctx.phase);
  const has = (k: string): boolean => (values.presentKeys ? present.has(k) : true);

  const eventMs = values.eventTime ? values.eventTime.getTime() : null;
  let dataAgeMs: number | null = null;
  if (eventMs !== null && Number.isFinite(eventMs)) dataAgeMs = ctx.nowMs - eventMs;

  const fieldQuality: Record<string, FieldQuality> = {
    previousClose: classifyField(values.previousClose, { kind: 'price', absent: !has('prev_close_price'), inAuctionPhase: true, required: true }),
    referencePrice: classifyField(values.referencePrice, { kind: 'price', absent: !has('reference_price'), inAuctionPhase: true, required: false }),
    indicativePrice: classifyField(values.indicativePrice, { kind: 'price', absent: !has('indicative_equilibrium_price'), inAuctionPhase: inPhase, required: true }),
    buyQuantity: classifyField(values.buyQuantity, { kind: 'qty', absent: !has('total_buy_quantity'), inAuctionPhase: inPhase, required: true }),
    sellQuantity: classifyField(values.sellQuantity, { kind: 'qty', absent: !has('total_sell_quantity'), inAuctionPhase: inPhase, required: true }),
    indicativeQuantity: classifyField(values.indicativeQuantity, { kind: 'qty', absent: !has('indicative_equilibrium_quantity'), inAuctionPhase: inPhase, required: false }),
    lastPrice: classifyField(values.lastPrice, { kind: 'price', absent: !has('last_price'), inAuctionPhase: true, required: false }),
  };

  // --- timestamp validity first: an unusable timestamp makes the row unauditable
  if (eventMs === null || !Number.isFinite(eventMs)) {
    fieldQuality.eventTime = 'INVALID';
    reasons.push('event timestamp missing or unparseable');
    return { quality: 'INVALID' as ObservationQuality, fieldQuality, reasons, dataAgeMs: null };
  }
  fieldQuality.eventTime = 'OK';
  if (eventMs < MIN_PLAUSIBLE_EVENT_MS) {
    fieldQuality.eventTime = 'INVALID';
    reasons.push('event timestamp is not plausible for a live session (placeholder/epoch value)');
    return { quality: 'INVALID' as ObservationQuality, fieldQuality, reasons, dataAgeMs };
  }
  if (eventMs > ctx.nowMs + FUTURE_TOLERANCE_MS) {
    fieldQuality.eventTime = 'INVALID';
    reasons.push('event timestamp ahead of receive time (look-ahead guard)');
    return { quality: 'INVALID' as ObservationQuality, fieldQuality, reasons, dataAgeMs };
  }
  if (dataAgeMs !== null && dataAgeMs > ctx.staleMaxAgeMs) {
    reasons.push(`stale observation (age ${dataAgeMs}ms > ${ctx.staleMaxAgeMs}ms)`);
    return { quality: 'STALE' as ObservationQuality, fieldQuality, reasons, dataAgeMs };
  }

  if (!inPhase) {
    reasons.push(`outside_auction_phase (${ctx.phase}) — auction values are not defined here`);
    return { quality: 'UNAVAILABLE' as ObservationQuality, fieldQuality, reasons, dataAgeMs };
  }

  const iepOk = isUsablePrice(values.indicativePrice);
  const prevOk = isUsablePrice(values.previousClose);
  const buyOk = isUsableQty(values.buyQuantity);
  const sellOk = isUsableQty(values.sellQuantity);
  const qtySum = (values.buyQuantity ?? 0) + (values.sellQuantity ?? 0);
  const imbalanceUsable = buyOk && sellOk && qtySum > 0;

  if (!iepOk) reasons.push('indicative equilibrium price not published/usable');
  if (!buyOk) reasons.push('buy quantity not published/usable');
  if (!sellOk) reasons.push('sell quantity not published/usable');

  if (iepOk && prevOk && imbalanceUsable) return { quality: 'COMPLETE', fieldQuality, reasons, dataAgeMs };
  // A previous close on its own is not auction evidence: PARTIAL needs at least
  // one genuine auction reading, otherwise the row carries no pre-open signal.
  if (iepOk || imbalanceUsable) return { quality: 'PARTIAL', fieldQuality, reasons, dataAgeMs };
  return { quality: 'UNAVAILABLE', fieldQuality, reasons, dataAgeMs };
}

/** Deterministic idempotency key — repeated source ticks collapse onto one row. */
export function preOpenDedupeKey(input: {
  instrumentKey: string;
  sessionDate: string;
  sessionPhase: string;
  source: string;
  eventTime: Date | null;
  receivedAtMs: number;
}): string {
  const eventMs = input.eventTime ? input.eventTime.getTime() : null;
  const stamp = eventMs !== null && Number.isFinite(eventMs)
    ? `e${eventMs}`
    : `r${Math.floor(input.receivedAtMs / 1000)}`;
  return `${input.instrumentKey}|${input.sessionDate}|${input.sessionPhase}|${input.source}|${stamp}`.slice(0, 190);
}

export type DerivedValue = { value: number | null; status: DerivedStatus; reason: string | null };

export type FeatureInput = {
  instrumentKey: string;
  sessionDate: string;
  sessionPhase: SessionPhase;
  eventTime: Date | null;
  previousClose: number | null;
  indicativePrice: number | null;
  buyQuantity: number | null;
  sellQuantity: number | null;
};

export type PreOpenFeatures = {
  instrumentKey: string;
  sessionDate: string;
  sessionPhase: SessionPhase;
  asOfEventTime: string | null;
  featuresVersion: string;
  gapPoints: DerivedValue;
  gapPct: DerivedValue;
  auctionImbalance: DerivedValue;
  auctionImbalancePct: DerivedValue;
  /** Roadmap name for `auctionImbalancePct` (GATE 2 item 2) — the SAME DerivedValue object. */
  oai: DerivedValue;
  unavailable: string[];
};

export type FeatureContext = {
  /** Assessment already stored with the observation, when available. */
  observationQuality?: ObservationQuality;
  /** The instant the caller is asking at — enables staleness/look-ahead gating. */
  asOfMs?: number;
  staleMaxAgeMs?: number;
};

/**
 * Why a derivation must refuse to produce anything. Applied before any formula,
 * so a stale or invalidated reading is never served as a live opening signal
 * (item 6). PARTIAL passes: individual fields may still be genuinely present.
 */
export function featureBlockReason(input: FeatureInput, ctx: FeatureContext = {}): string | null {
  const q = ctx.observationQuality;
  if (q === 'STALE') return 'source reading is stale';
  if (q === 'INVALID') return 'source reading timestamp is invalid/unauditable';
  if (q === 'UNAVAILABLE') return 'source reading carries no auction data';
  if (ctx.asOfMs === undefined) return null;
  const eventMs = input.eventTime ? input.eventTime.getTime() : null;
  if (eventMs === null || !Number.isFinite(eventMs)) return 'event timestamp missing or unparseable';
  if (eventMs < MIN_PLAUSIBLE_EVENT_MS) return 'event timestamp is not plausible (placeholder/epoch value)';
  if (eventMs > ctx.asOfMs + FUTURE_TOLERANCE_MS) return 'event timestamp is after the read instant (look-ahead)';
  const age = ctx.asOfMs - eventMs;
  if (age > (ctx.staleMaxAgeMs ?? DEFAULT_STALE_MAX_AGE_MS)) return `stale observation (age ${age}ms)`;
  return null;
}

const unavailable = (reason: string): DerivedValue => ({ value: null, status: 'UNAVAILABLE', reason });
const ok = (value: number): DerivedValue => ({ value: round(value), status: 'OK', reason: null });

/**
 * Derive opening features from ONE observation. Deliberately takes no "now" and
 * no later observation, so it cannot see the future: an earlier decision can
 * never be reconstructed with a later opening price (item 4).
 */
export function derivePreOpenFeatures(input: FeatureInput, ctx: FeatureContext = {}): PreOpenFeatures {
  const unavailableList: string[] = [];
  const inPhase = isAuctionPhase(input.sessionPhase);

  const block = featureBlockReason(input, ctx);
  if (block) {
    const blocked = unavailable(`observation quality gate: ${block}`);
    return {
      instrumentKey: input.instrumentKey,
      sessionDate: input.sessionDate,
      sessionPhase: input.sessionPhase,
      asOfEventTime: input.eventTime ? input.eventTime.toISOString() : null,
      featuresVersion: PRE_OPEN_FEATURES_VERSION,
      gapPoints: blocked,
      gapPct: blocked,
      auctionImbalance: blocked,
      auctionImbalancePct: blocked,
      oai: blocked,
      unavailable: ['gapPoints', 'gapPct', 'auctionImbalance', 'auctionImbalancePct', 'oai'],
    };
  }

  let gapPoints: DerivedValue;
  let gapPct: DerivedValue;
  if (!inPhase) {
    gapPoints = unavailable(`outside_auction_phase (${input.sessionPhase})`);
    gapPct = unavailable(`outside_auction_phase (${input.sessionPhase})`);
  } else if (!isUsablePrice(input.indicativePrice)) {
    gapPoints = unavailable('indicative_equilibrium_price unavailable');
    gapPct = unavailable('indicative_equilibrium_price unavailable');
  } else if (!isUsablePrice(input.previousClose)) {
    gapPoints = unavailable('previous_close unavailable');
    gapPct = unavailable('previous_close unavailable');
  } else {
    const prev = input.previousClose as number;
    const iep = input.indicativePrice as number;
    gapPoints = ok(iep - prev);
    gapPct = ok(((iep - prev) / prev) * 100);
  }
  if (gapPct.status === 'UNAVAILABLE') unavailableList.push('gapPoints', 'gapPct');

  let auctionImbalance: DerivedValue;
  let auctionImbalancePct: DerivedValue;
  const buy = input.buyQuantity;
  const sell = input.sellQuantity;
  const qtySum = (buy ?? 0) + (sell ?? 0);
  if (!inPhase) {
    auctionImbalance = unavailable(`outside_auction_phase (${input.sessionPhase})`);
    auctionImbalancePct = unavailable(`outside_auction_phase (${input.sessionPhase})`);
  } else if (!isUsableQty(buy) || !isUsableQty(sell) || qtySum <= 0) {
    const why = !isUsableQty(buy) || !isUsableQty(sell)
      ? 'buy/sell quantity unavailable'
      : 'buy+sell quantity is zero — no auction imbalance to measure';
    auctionImbalance = unavailable(why);
    auctionImbalancePct = unavailable(why);
  } else {
    auctionImbalance = ok((buy as number) - (sell as number));
    auctionImbalancePct = ok(((buy as number) - (sell as number)) / Math.max(qtySum, IMBALANCE_EPSILON));
  }
  if (auctionImbalance.status === 'UNAVAILABLE') unavailableList.push('auctionImbalance', 'auctionImbalancePct', 'oai');

  return {
    instrumentKey: input.instrumentKey,
    sessionDate: input.sessionDate,
    sessionPhase: input.sessionPhase,
    asOfEventTime: input.eventTime ? input.eventTime.toISOString() : null,
    featuresVersion: PRE_OPEN_FEATURES_VERSION,
    gapPoints,
    gapPct,
    auctionImbalance,
    auctionImbalancePct,
    // OAI (GATE 2 item 2 / row 21) = the same DerivedValue object, deliberately NOT a
    // second computation: one formula, two names, and the test asserts the identity.
    oai: auctionImbalancePct,
    unavailable: unavailableList,
  };
}
