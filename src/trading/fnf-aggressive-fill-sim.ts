/**
 * ITEM 105 — Simulate aggressive fills at bid/ask not LTP.
 *
 * Extends DecisionSnapshot to support aggressive fill simulation at bid/ask prices
 * rather than assuming fills at LTP (Last Traded Price). This captures realistic
 * slippage: aggressive buyers hit the ask, aggressive sellers hit the bid.
 */

// ── Types from DecisionSnapshot (re-declared for self-containedness) ──────

export interface JournalFeature {
  underlying: string;
  spot: number;
  sma20: number;
  sma5: number;
  momentumFrac: number | null;
  bars: number;
  lastBarMs: number;
}

export interface JournalCandidate {
  symbol: string;
  premium: number;
  contractValue: number;
  spreadPct: number | null;
  delta: number | null;
  score: number;
  quoteTsMs?: number;
  quoteAgeMin?: number;
  bid?: number | null;
  ask?: number | null;
  mid?: number | null;
  ltp?: number;
  volume?: number;
  oi?: number;
  oiChange?: number | null;
  iv?: number | null;
  provider?: string;
  quality?: string;
}

export interface JournalCycle {
  startedAtMs: number;
  latencyMs: number | null;
  featureCutoffMs: number | null;
}

export interface DecisionSnapshot {
  decisionId: string;
  asOf: Date;
  portfolioId?: string | null;
  portfolio: {
    label: string;
    capital: number;
    ceiling: number;
    deployed: number;
    netPnl: number;
    headroom: number;
    autoTradeEnabled: boolean;
    fridayTradingEnabled: boolean;
  };
  underlying: string;
  direction: {
    dir: 'CE' | 'PE';
    reason: string;
    conf: number;
    spot: number;
    sma20: number;
    sma5: number;
  };
  optionContract: {
    symbol: string;
    underlying: string;
    strike: number;
    expiry: string;
    optionType: 'CE' | 'PE';
    lotSize: number;
  };
  dte: number;
  actualQuote: {
    ltp: number;
    bid: number | null;
    ask: number | null;
    mid: number | null;
    volume: number;
    oi: number;
    oiChange: number | null;
    iv: number | null;
    provider: string;
    quoteTs: Date;
    quoteAgeMin: number;
    quality: string;
    spreadPct: number | null;
  };
  localGreeks: {
    delta: number | null;
    gamma: number | null;
    theta: number | null;
    vega: number | null;
    iv: number | null;
  };
  providerGreeks: {
    delta: number | null;
    gamma: number | null;
    theta: number | null;
    vega: number | null;
  };
  candidateScoring: {
    atmScore: number;
    expiryScore: number;
    greeksScore: number;
    totalScore: number;
    rank: number;
    totalCandidates: number;
  };
  confidence: {
    raw: number;
    decayed: number;
    rate: number;
    ageHours: number;
    timingFactor: number;
  };
  sessionPhase: string;
  cycle: JournalCycle;
  features: JournalFeature[];
  dataWarnings: string[];
  rejected: string[];
  winnerSymbol: string;
  algoSource: string;
  buildSha: string;
  sessionId?: string;
}

// ── Aggressive Fill Simulation ─────────────────────────────────────────────

export const AGGRESSIVE_FILL_VERSION = 'aggressivefill-v1';

export type FillSide = 'BUY' | 'SELL';

export interface AggressiveFillInput {
  /** The decision snapshot containing the quote. */
  readonly snapshot: DecisionSnapshot;
  /** The side of the fill: BUY hits the ask, SELL hits the bid. */
  readonly side: FillSide;
  /** Quantity to fill (number of lots). */
  readonly quantity: number;
}

export interface AggressiveFillResult {
  readonly version: string;
  readonly decisionId: string;
  readonly symbol: string;
  readonly side: FillSide;
  readonly quantity: number;
  /** Fill price: ask for BUY, bid for SELL. */
  readonly fillPrice: number;
  /** Reference price (LTP) for comparison. */
  readonly referencePrice: number;
  /** Slippage in points relative to LTP. */
  readonly slippagePoints: number;
  /** Slippage in basis points relative to LTP. */
  readonly slippageBps: number;
  /** Slippage in basis points relative to mid (if available). */
  readonly slippageVsMidBps: number | null;
  /** Spread cost: half-spread paid for crossing. */
  readonly spreadCostPoints: number;
  /** Whether the fill was possible (bid/ask available). */
  readonly fillable: boolean;
  readonly reason: string;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Simulate an aggressive fill at bid/ask (not LTP).
 *
 * - BUY orders fill at ask (crossing the spread upward)
 * - SELL orders fill at bid (crossing the spread downward)
 * - If bid/ask are unavailable, falls back to LTP with a warning
 */
export function simulateAggressiveFill(input: AggressiveFillInput): AggressiveFillResult {
  const { snapshot, side, quantity } = input;
  const quote = snapshot.actualQuote;

  const fillPrice = side === 'BUY' ? quote.ask : quote.bid;
  const referencePrice = quote.ltp;

  if (!isNum(fillPrice) || fillPrice <= 0) {
    return {
      version: AGGRESSIVE_FILL_VERSION,
      decisionId: snapshot.decisionId,
      symbol: snapshot.optionContract.symbol,
      side,
      quantity,
      fillPrice: 0,
      referencePrice,
      slippagePoints: 0,
      slippageBps: 0,
      slippageVsMidBps: null,
      spreadCostPoints: 0,
      fillable: false,
      reason: `${side === 'BUY' ? 'ask' : 'bid'} is unavailable or non-positive`,
    };
  }

  const slippagePoints = fillPrice - referencePrice;
  const slippageBps = referencePrice > 0 ? (slippagePoints / referencePrice) * 10_000 : 0;

  const mid = quote.mid;
  const slippageVsMidBps =
    isNum(mid) && mid > 0 ? ((fillPrice - mid) / mid) * 10_000 : null;

  // Spread cost: half the spread for crossing
  const spreadCostPoints =
    isNum(quote.bid) && isNum(quote.ask) && quote.ask > quote.bid
      ? (quote.ask - quote.bid) / 2
      : 0;

  return {
    version: AGGRESSIVE_FILL_VERSION,
    decisionId: snapshot.decisionId,
    symbol: snapshot.optionContract.symbol,
    side,
    quantity,
    fillPrice: Number(fillPrice.toFixed(6)),
    referencePrice,
    slippagePoints: Number(slippagePoints.toFixed(6)),
    slippageBps: Number(slippageBps.toFixed(6)),
    slippageVsMidBps: slippageVsMidBps !== null ? Number(slippageVsMidBps.toFixed(6)) : null,
    spreadCostPoints: Number(spreadCostPoints.toFixed(6)),
    fillable: true,
    reason: `${side} at ${side === 'BUY' ? 'ask' : 'bid'}=${fillPrice}, slippage=${slippagePoints.toFixed(2)}pts`,
  };
}
