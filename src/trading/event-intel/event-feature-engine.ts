/**
 * @module event-feature-engine
 * @purpose Extract option-chain features from market data for event intelligence
 * @purity Pure functions — no database, no I/O
 * @safety Paper-trading only. Features are evidence, not trading signals.
 *
 * Extracts: SPOT/FUTURES, IV, SKEW, TERM STRUCTURE, GREEKS, FLOW, LIQUIDITY, STRUCTURES
 */

import {
  OptionChainFeatures,
  SpotFuturesFeatures,
  IVFeatures,
  SkewFeatures,
  TermStructureFeatures,
  GreeksFeatures,
  FlowFeatures,
  LiquidityFeatures,
  StructureFeatures,
} from './event-types';

/**
 * Raw market data input shape — flexible to accommodate different data sources.
 */
export interface RawMarketData {
  spot?: number;
  spotPrevClose?: number;
  spotOpen?: number;
  spotHigh?: number;
  spotLow?: number;
  spotVolume?: number;
  spotOI?: number;

  futures?: number;
  futuresPrevClose?: number;
  futuresVolume?: number;
  futuresOI?: number;

  // IV data
  atmIV?: number;
  ivByStrike?: Record<number, number>;
  ivByExpiry?: Record<string, number>;
  ivPercentile?: number;
  ivRank?: number;
  previousATMIV?: number;

  // Skew
  rr25Delta?: number;
  previousRR25Delta?: number;
  putCallSkew?: number;

  // Term structure
  frontIV?: number;
  backIV?: number;
  previousFrontIV?: number;
  previousBackIV?: number;

  // Greeks (ATM)
  delta?: number;
  gamma?: number;
  vega?: number;
  theta?: number;
  vanna?: number | null;
  volga?: number | null;
  charm?: number | null;

  // Flow
  callVolume?: number;
  putVolume?: number;
  callOI?: number;
  putOI?: number;
  callOIChange?: number;
  putOIChange?: number;

  // Liquidity
  bid?: number;
  ask?: number;
  spread?: number;
  depth?: number;

  // Timestamps
  timestamp?: number;
  quoteTimestamp?: number;

  // Additional context
  vwap?: number;
  indiaVix?: number;
}

/**
 * Extract option-chain features from raw market data.
 *
 * @param marketData - Raw market data from any source
 * @returns OptionChainFeatures with all computed features
 * @pure Yes — no side effects
 */
export function extractOptionChainFeatures(
  marketData: RawMarketData,
): OptionChainFeatures {
  return {
    spotFutures: extractSpotFuturesFeatures(marketData),
    iv: extractIVFeatures(marketData),
    skew: extractSkewFeatures(marketData),
    termStructure: extractTermStructureFeatures(marketData),
    greeks: extractGreeksFeatures(marketData),
    flow: extractFlowFeatures(marketData),
    liquidity: extractLiquidityFeatures(marketData),
    structures: extractStructures(marketData),
  };
}

function extractSpotFuturesFeatures(data: RawMarketData): SpotFuturesFeatures {
  const spot = data.spot ?? 0;
  const prevClose = data.spotPrevClose ?? spot;
  const open = data.spotOpen ?? spot;
  const high = data.spotHigh ?? spot;
  const low = data.spotLow ?? spot;
  const futures = data.futures ?? spot;

  const returns1d = prevClose > 0 ? (spot - prevClose) / prevClose : 0;
  const gapPct = prevClose > 0 ? (open - prevClose) / prevClose : 0;
  const vwapDistancePct = data.vwap ? (spot - data.vwap) / data.vwap : 0;
  const basis = futures - spot;

  return {
    spot,
    futures,
    basis,
    returns1d,
    gapPct,
    momentum5d: returns1d, // Simplified — in production use multi-period
    vwapDistancePct,
    realizedVolatility: 0, // Would need historical data
    futuresVolume: data.futuresVolume ?? 0,
    futuresOI: data.futuresOI ?? 0,
  };
}

function extractIVFeatures(data: RawMarketData): IVFeatures {
  const atmIV = data.atmIV ?? 0;
  const prevATMIV = data.previousATMIV ?? atmIV;
  const ivChange1d = atmIV - prevATMIV;

  // Convert Record to ReadonlyMap
  const ivByStrike = new Map<number, number>();
  if (data.ivByStrike) {
    for (const [k, v] of Object.entries(data.ivByStrike)) {
      ivByStrike.set(Number(k), v);
    }
  }
  const ivByExpiry = new Map<string, number>();
  if (data.ivByExpiry) {
    for (const [k, v] of Object.entries(data.ivByExpiry)) {
      ivByExpiry.set(k, v);
    }
  }

  return {
    atmIV,
    ivByStrike,
    ivByExpiry,
    ivPercentile: data.ivPercentile ?? 50,
    ivRank: data.ivRank ?? 50,
    eventPremium: ivChange1d,
    ivChange1d,
  };
}

function extractSkewFeatures(data: RawMarketData): SkewFeatures {
  const rr25 = data.rr25Delta ?? 0;
  const prevRR25 = data.previousRR25Delta ?? rr25;

  return {
    twentyFiveDeltaRR: rr25,
    putCallSkew: data.putCallSkew ?? 0,
    skewChange1d: rr25 - prevRR25,
  };
}

function extractTermStructureFeatures(data: RawMarketData): TermStructureFeatures {
  const front = data.frontIV ?? 0;
  const back = data.backIV ?? 0;
  const prevFront = data.previousFrontIV ?? front;

  return {
    frontIV: front,
    backIV: back,
    slope: back - front,
    curvature: 0, // Would need 3+ expiry points
    eventExpiryPremium: front - prevFront,
  };
}

function extractGreeksFeatures(data: RawMarketData): GreeksFeatures {
  return {
    delta: data.delta ?? 0,
    gamma: data.gamma ?? 0,
    vega: data.vega ?? 0,
    theta: data.theta ?? 0,
    vanna: data.vanna ?? null,
    volga: data.volga ?? null,
    charm: data.charm ?? null,
  };
}

function extractFlowFeatures(data: RawMarketData): FlowFeatures {
  const callVol = data.callVolume ?? 0;
  const putVol = data.putVolume ?? 0;
  const totalVolume = callVol + putVol;
  const callOI = data.callOI ?? 0;
  const putOI = data.putOI ?? 0;
  const totalOI = callOI + putOI;

  return {
    totalVolume,
    oiChange: (data.callOIChange ?? 0) + (data.putOIChange ?? 0),
    volumeToOIRatio: totalOI > 0 ? totalVolume / totalOI : 0,
    callPutImbalance: totalVolume > 0 ? (callVol - putVol) / totalVolume : 0,
  };
}

function extractLiquidityFeatures(data: RawMarketData): LiquidityFeatures {
  const bid = data.bid ?? 0;
  const ask = data.ask ?? 0;
  const mid = (bid + ask) / 2;
  const spreadPct = mid > 0 ? (ask - bid) / mid : (data.spread ?? 0);

  return {
    bidAskSpreadPct: spreadPct,
    depth: data.depth ?? 0,
    staleQuoteCount: data.quoteTimestamp
      ? (Date.now() - data.quoteTimestamp > 30_000 ? 1 : 0)
      : 0,
    executionStress: spreadPct > 0.005 ? 1.0 : spreadPct > 0.002 ? 0.5 : 0.1,
  };
}

function extractStructures(data: RawMarketData): StructureFeatures {
  const spot = data.spot ?? 0;
  const atmIV = data.atmIV ?? 0;

  // ATM straddle approximation: 2 * spot * atmIV * sqrt(T/252)
  const tDays = 1;
  const straddleApprox = 2 * spot * atmIV * Math.sqrt(tDays / 252);
  const strangleApprox = straddleApprox * 0.8;
  const expectedMove = straddleApprox / 2;
  const breakEvenMove = straddleApprox;

  return {
    atmStraddle: straddleApprox,
    strangle: strangleApprox,
    expectedMove,
    breakEvenMove,
  };
}
