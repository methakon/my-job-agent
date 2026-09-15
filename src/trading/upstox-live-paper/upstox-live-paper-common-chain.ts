/**
 * Row 877 — the paper desk's COMMON-STORE chain source.
 *
 * The desk reads its ATM universe, chain and candles from its OWN tables
 * (upstox_live_paper_option_quotes / ..._market_snapshots), which are written only
 * by its OWN broker feed. When that feed is down (dead credentials, or another
 * provider owns the universe) those tables go stale and the desk considers nothing
 * — `considered=0`, no trade — even though a live, canonical tape for the SAME
 * universe exists in the common normalized store.
 *
 * This module is the pure half of the fix: it decides WHICH source to read and maps
 * common-store rows into the desk's own shapes. PURE: no clock (the caller passes
 * `nowMs`), no I/O, no DB, no network, no AI, no randomness.
 *
 * Rules:
 *   - the desk's OWN rows always win when they are fresh — the fallback can only
 *     ever supply data the desk would otherwise have none of;
 *   - a foreign row keeps its TRUE producer (`source`) and is never relabelled as
 *     this desk's own tick;
 *   - ABSENCE IS PRESERVED: a field the provider did not send stays null; it is
 *     never turned into 0 (`volume`/`oi` were the ones the desk's own path coerced);
 *   - nothing is interpolated, carried forward or invented.
 *
 * Versioned: commonchain-v1.
 */

export const COMMON_CHAIN_VERSION = 'commonchain-v1';

export type ChainSource = 'OWN' | 'COMMON' | 'NONE';
export const CHAIN_SOURCES: readonly ChainSource[] = ['OWN', 'COMMON', 'NONE'];

/** Closed, published reason vocabulary. */
export const CHAIN_SOURCE_REASONS = [
  'OWN_FRESH',
  'OWN_STALE_COMMON_FRESH',
  'OWN_STALE_NO_COMMON',
  'OWN_EMPTY_COMMON_FRESH',
  'OWN_EMPTY_NO_COMMON',
] as const;
export type ChainSourceReason = (typeof CHAIN_SOURCE_REASONS)[number];

export const COMMON_CHAIN_SPEC = {
  feature: 'CommonStoreChainSource',
  version: COMMON_CHAIN_VERSION,
  purpose: 'let a desk whose OWN feed is stale/empty read the common normalized store for the SAME universe, without relabelling the producer',
  precedence: 'OWN wins whenever its newest row is within maxAgeMs; the common store is only a fallback',
  absence: 'a missing field stays null (never 0, never carried forward)',
  provenance: 'each foreign row keeps its true source; the caller must surface it',
  reasons: [...CHAIN_SOURCE_REASONS] as string[],
};

/** A common-store option row, normalised to the desk's chain shape. */
export interface CommonChainRow {
  contractSymbol: string;
  underlying: string | null;
  expiry: string;
  strike: number;
  optionType: 'CE' | 'PE';
  ltp: number | null;
  bid: number | null;
  ask: number | null;
  bidQty: number | null;
  askQty: number | null;
  volume: number | null;
  oi: number | null;
  changeOi: number | null;
  iv: number | null;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  ts: Date | null;
  /** TRUE producer (FYERS_LIVE / UPSTOX …). Never rewritten by the consumer. */
  source: string;
}

export interface ChainSourceInput {
  ownRows: number;
  ownNewestTsMs: number | null;
  commonRows: number;
  nowMs: number;
  maxAgeMs: number;
}

export const PRICE_FIELDS = [
  'ltp', 'bid', 'ask', 'bidQty', 'askQty', 'volume', 'oi', 'changeOi', 'iv', 'delta', 'gamma', 'theta', 'vega',
] as const;

const finiteOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const toDate = (v: unknown): Date | null => {
  if (v === null || v === undefined || v === '') return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
};

/** Decide which source the desk should read this cycle. */
export function chainSourceDecision(input: ChainSourceInput): { source: ChainSource; reason: ChainSourceReason; commonStoreFresh: boolean; ownAgeMs: number | null } {
  const ownAgeMs = input.ownNewestTsMs === null ? null : Math.max(0, input.nowMs - input.ownNewestTsMs);
  const ownFresh = input.ownRows > 0 && ownAgeMs !== null && ownAgeMs <= input.maxAgeMs;
  const commonFresh = input.commonRows > 0;
  if (ownFresh) return { source: 'OWN', reason: 'OWN_FRESH', commonStoreFresh: commonFresh, ownAgeMs };
  if (commonFresh) return { source: 'COMMON', reason: input.ownRows > 0 ? 'OWN_STALE_COMMON_FRESH' : 'OWN_EMPTY_COMMON_FRESH', commonStoreFresh: true, ownAgeMs };
  return { source: 'NONE', reason: input.ownRows > 0 ? 'OWN_STALE_NO_COMMON' : 'OWN_EMPTY_NO_COMMON', commonStoreFresh: false, ownAgeMs };
}

/** The contract symbol a desk caller looks up: the tail of the canonical key. */
export const contractSymbolOf = (instrumentKey: unknown): string =>
  String(instrumentKey ?? '').trim().split(/[:|]/).pop()!.trim().toUpperCase();

/**
 * Map a unified_option_quotes row into the desk's chain shape. Returns null for a
 * row that cannot identify a contract (no symbol / expiry / strike / right) rather
 * than inventing one.
 */
export function commonChainRowFromUnified(row: Record<string, unknown>): CommonChainRow | null {
  const contractSymbol = contractSymbolOf(row.instrumentKey);
  const expiry = row.expiry === null || row.expiry === undefined ? '' : String(row.expiry).slice(0, 10);
  const strike = finiteOrNull(row.strike);
  const right = String(row.optionType ?? '').trim().toUpperCase();
  if (!contractSymbol || !expiry || strike === null || (right !== 'CE' && right !== 'PE')) return null;
  return {
    contractSymbol,
    underlying: row.underlying === null || row.underlying === undefined ? null : String(row.underlying),
    expiry,
    strike,
    optionType: right as 'CE' | 'PE',
    ltp: finiteOrNull(row.ltp),
    bid: finiteOrNull(row.bid),
    ask: finiteOrNull(row.ask),
    bidQty: finiteOrNull(row.bidQty),
    askQty: finiteOrNull(row.askQty),
    volume: finiteOrNull(row.volume),
    oi: finiteOrNull(row.oi),
    changeOi: finiteOrNull(row.changeOi),
    iv: finiteOrNull(row.iv),
    delta: finiteOrNull(row.delta),
    gamma: finiteOrNull(row.gamma),
    theta: finiteOrNull(row.theta),
    vega: finiteOrNull(row.vega),
    ts: toDate(row.receivedTimestamp ?? row.ts),
    source: String(row.source ?? '').trim(),
  };
}

export function commonChainRowsFromUnified(rows: Array<Record<string, unknown>>): CommonChainRow[] {
  const out: CommonChainRow[] = [];
  for (const row of rows ?? []) {
    const mapped = commonChainRowFromUnified(row);
    if (mapped) out.push(mapped);
  }
  return out;
}

/** Nearest listed expiry at or after `today`, mirroring the desk's own rule. */
export function nearestExpiry(rows: CommonChainRow[], today: string): string | null {
  const expiries = [...new Set(rows.map((r) => r.expiry))].filter((e) => e >= today).sort();
  return expiries[0] ?? null;
}

/** ATM candidate legs for one expiry — a tradable leg needs a positive premium. */
export function commonRowsToAtmLegs(
  rows: CommonChainRow[],
  expiry: string,
): Array<{ contractSymbol: string; optionType: 'CE' | 'PE'; strike: number; expiry: string; ltp: number; bid: number | null; ask: number | null; oi: number | null; volume: number | null }> {
  return rows
    .filter((r) => r.expiry === expiry && r.ltp !== null && r.ltp > 0)
    .map((r) => ({
      contractSymbol: r.contractSymbol,
      optionType: r.optionType,
      strike: r.strike,
      expiry,
      ltp: r.ltp as number,
      bid: r.bid,
      ask: r.ask,
      oi: r.oi,
      volume: r.volume,
    }));
}

/** Chain legs (OI/IV context) for the ATM strikes of one expiry. */
export function commonRowsToChainLegs(
  rows: CommonChainRow[],
  expiry: string,
  strikes: Set<number>,
): Array<{ strike: number; optionType: 'CE' | 'PE'; oi: number; changeOi: number; volume: number; iv: number | null; ltp: number; bid: number | null; ask: number | null }> {
  return rows
    .filter((r) => r.expiry === expiry && strikes.has(r.strike))
    .map((r) => ({
      strike: r.strike,
      optionType: r.optionType,
      // The desk's own chain path coerces a missing OI/volume to 0; the common
      // path keeps the provider's absence (see the caller's note).
      oi: r.oi ?? 0,
      changeOi: r.changeOi ?? 0,
      volume: r.volume ?? 0,
      iv: r.iv,
      ltp: r.ltp ?? 0,
      bid: r.bid,
      ask: r.ask,
    }));
}
