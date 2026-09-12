/**
 * GATE 5 input-capture (design prototype, roadmap rows 50/51/52) — FYERS DEPTH MAPPING.
 *
 * Single responsibility: deterministically turn a FYERS v3 depth payload's `bid`/`ask` arrays into the BEST
 * level (price + size) and a canonical, versioned depth block — and REFUSE anything it does not recognise
 * rather than guessing. PURE: no clock, no I/O, no DB, no network, no AI, no randomness.
 *
 * WHY THIS EXISTS (see docs/GATE5_CAPTURE_SCOPE.md): today the FYERS subscription is quote-only
 * (`subscribe(symbols, isDepth=false, …)`), so sizes are never delivered, and the canonical mapper reads
 * scalar `bid_size`/`ask_size` keys which a depth payload does not carry. This module is the missing mapping,
 * prepared and unit-tested OFFLINE so that Monday's capture only has to (a) subscribe the depth channel and
 * (b) call this. It is NOT wired into any feed (asserted by test).
 *
 * ── PINNED SHAPE (what it accepts) ─────────────────────────────────────────────────────────
 *   level, array form  = [price, size, orders?]            e.g. [[24000, 75, 3], [23999.5, 150, 5]]
 *   level, object form = {price|bid|bidPrice, quantity|qty|size, orders|numOrders|n?}
 *   price must be a finite number > 0; size a finite number >= 0 (0 is a REAL size here — unlike the quote
 *   path, it is never turned into "absent"); orders optional (null when absent).
 *   levels are ordered BEST-FIRST (bids descending price, asks ascending), indexed 1..n; at most `maxLevels`
 *   (default 5) are kept — truncation of a longer book is allowed, PADDING a shorter one is not.
 *
 * ── MISSING / DEGENERATE DATA → a safe explicit state ───────────────────────────────────────
 *   NO_DEPTH (absent or a scalar — a scalar bid/ask is the QUOTE form, not depth) / UNKNOWN_SHAPE (a shape
 *   this mapper does not recognise) / EMPTY_SIDE / MALFORMED_LEVEL / NON_FINITE / CROSSED_BOOK
 *   — status UNAVAILABLE with a null depth block; a partial book is NEVER produced.
 *
 * RESEARCH / SHADOW ONLY: nothing in production imports this module (asserted by test). Versioned:
 * fyersdepth-v1; the block it emits is depth-v1.
 */

export const FYERS_DEPTH_MAPPING_VERSION = 'fyersdepth-v1';
export const DEPTH_VERSION = 'depth-v1';

export type DepthStatus = 'OK' | 'UNAVAILABLE';
export const DEPTH_REFUSALS = ['NO_DEPTH', 'UNKNOWN_SHAPE', 'EMPTY_SIDE', 'MALFORMED_LEVEL', 'NON_FINITE', 'CROSSED_BOOK'] as const;
export type DepthRefusal = (typeof DEPTH_REFUSALS)[number];

export interface DepthLevel {
	/** 1-based, after best-first ordering. */
	level: number;
	price: number;
	qty: number;
	orders: number | null;
}

export interface CanonicalDepthBlock {
	depthVersion: typeof DEPTH_VERSION;
	providerInstrumentId: string | null;
	providerPayloadHash: string | null;
	bids: DepthLevel[];
	asks: DepthLevel[];
	bidLevels: number;
	askLevels: number;
	sourceTimestampSemantics: 'QUOTE';
}

export interface DepthMappingInput {
	bid?: unknown;
	ask?: unknown;
	providerInstrumentId?: string | null;
	providerPayloadHash?: string | null;
	/** Kept levels per side; the provider publishes 5. Truncation only — never padding. */
	maxLevels?: number;
}

export interface DepthMappingResult {
	version: typeof FYERS_DEPTH_MAPPING_VERSION;
	status: DepthStatus;
	reason: DepthRefusal | null;
	reasonDetail: string | null;
	/** Best level derived from the book, or null in every non-OK state. */
	best: { bid: number; ask: number; bidQty: number; askQty: number } | null;
	depth: CanonicalDepthBlock | null;
}

export const FYERS_DEPTH_MAPPING_SPEC = {
	feature: 'FyersDepthMapping',
	version: FYERS_DEPTH_MAPPING_VERSION,
	depthVersion: DEPTH_VERSION,
	accepts: 'bid/ask as [price, size, orders?] arrays or {price,quantity,orders?} objects; a scalar bid/ask is the QUOTE form, not depth',
	ordering: 'bids best-first (descending price), asks best-first (ascending price); 1-based level index',
	neverManufactures: 'a missing level is never padded, a zero size is a real size (never "absent"), and an unrecognised shape invalidates the whole block',
	refuses: [...DEPTH_REFUSALS] as string[],
	provenance: 'providerInstrumentId and the provider payload hash are carried on the block; timestamp semantics are QUOTE',
	note: 'prepared offline for the Monday depth capture; not wired to any feed',
};

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const num = (v: unknown): number | null => {
	if (v === null || v === undefined || v === '') return null;
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
};

/** One raw level → { price, qty, orders } or a refusal token. */
const parseLevel = (raw: unknown): { ok: true; price: number; qty: number; orders: number | null } | { ok: false; reason: DepthRefusal; detail: string } => {
	let price: number | null = null;
	let qty: number | null = null;
	let orders: number | null = null;
	if (Array.isArray(raw)) {
		if (raw.length < 2) return { ok: false, reason: 'MALFORMED_LEVEL', detail: `array level needs [price, size(, orders)] — got ${raw.length} element(s)` };
		price = num(raw[0]);
		qty = num(raw[1]);
		orders = raw.length > 2 ? num(raw[2]) : null;
	} else if (raw && typeof raw === 'object') {
		const r = raw as Record<string, unknown>;
		price = num(r.price ?? r.bid ?? r.bidPrice ?? r.ask ?? r.askPrice);
		qty = num(r.quantity ?? r.qty ?? r.size);
		orders = num(r.orders ?? r.numOrders ?? r.n);
	} else {
		return { ok: false, reason: 'MALFORMED_LEVEL', detail: 'a depth level must be an array or an object' };
	}
	if (price === null || qty === null) return { ok: false, reason: 'NON_FINITE', detail: `level price/size must be finite numbers (price=${price}, qty=${qty})` };
	if (price <= 0) return { ok: false, reason: 'MALFORMED_LEVEL', detail: `level price must be > 0 (got ${price})` };
	if (qty < 0) return { ok: false, reason: 'MALFORMED_LEVEL', detail: `level size cannot be negative (got ${qty})` };
	return { ok: true, price, qty, orders };
};

/** A whole side (array of levels) → ordered levels, or a refusal. Empty is a refusal, never an empty book. */
const parseSide = (raw: unknown, side: 'bid' | 'ask', maxLevels: number): { ok: true; levels: DepthLevel[] } | { ok: false; reason: DepthRefusal; detail: string } => {
	if (raw === null || raw === undefined || raw === '') return { ok: false, reason: 'NO_DEPTH', detail: `no ${side} depth supplied` };
	if (!Array.isArray(raw)) return { ok: false, reason: 'NO_DEPTH', detail: `a scalar ${side} is the QUOTE form, not depth` };
	if (!raw.length) return { ok: false, reason: 'EMPTY_SIDE', detail: `${side} depth array is empty` };
	const parsed: Array<{ price: number; qty: number; orders: number | null }> = [];
	for (const lvl of raw) {
		const p = parseLevel(lvl);
		if (!p.ok) return p;
		parsed.push({ price: p.price, qty: p.qty, orders: p.orders });
	}
	parsed.sort((a, b) => (side === 'bid' ? b.price - a.price : a.price - b.price));
	return { ok: true, levels: parsed.slice(0, maxLevels).map((l, i) => ({ level: i + 1, price: l.price, qty: l.qty, orders: l.orders })) };
};

export function mapFyersDepth(input: DepthMappingInput): DepthMappingResult {
	const version = FYERS_DEPTH_MAPPING_VERSION;
	const refuse = (reason: DepthRefusal, detail: string): DepthMappingResult => ({ version, status: 'UNAVAILABLE', reason, reasonDetail: detail, best: null, depth: null });

	if (!input || typeof input !== 'object') return refuse('NO_DEPTH', 'no payload supplied');
	const maxLevels = Number.isInteger(input.maxLevels) && (input.maxLevels as number) > 0 ? (input.maxLevels as number) : 5;
	// A payload with neither side as an array is not depth at all (the quote form carries scalars).
	if (!Array.isArray(input.bid) && !Array.isArray(input.ask)) return refuse('NO_DEPTH', 'neither bid nor ask is a depth array');

	const bids = parseSide(input.bid, 'bid', maxLevels);
	if (!bids.ok) return refuse(bids.reason, bids.detail);
	const asks = parseSide(input.ask, 'ask', maxLevels);
	if (!asks.ok) return refuse(asks.reason, asks.detail);

	const bestBid = bids.levels[0];
	const bestAsk = asks.levels[0];
	if (bestBid.price > bestAsk.price) return refuse('CROSSED_BOOK', `crossed book: best bid ${bestBid.price} > best ask ${bestAsk.price}`);

	return {
		version,
		status: 'OK',
		reason: null,
		reasonDetail: null,
		best: { bid: bestBid.price, ask: bestAsk.price, bidQty: bestBid.qty, askQty: bestAsk.qty },
		depth: {
			depthVersion: DEPTH_VERSION,
			providerInstrumentId: input.providerInstrumentId ?? null,
			providerPayloadHash: input.providerPayloadHash ?? null,
			bids: bids.levels,
			asks: asks.levels,
			bidLevels: bids.levels.length,
			askLevels: asks.levels.length,
			sourceTimestampSemantics: 'QUOTE',
		},
	};
}
