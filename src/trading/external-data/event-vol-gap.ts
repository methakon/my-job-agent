/**
 * Event Volatility Gap (Item 293)
 *
 * Combines event distance with historical volatility to measure the
 * expected gap at upcoming events. This is a risk/positioning feature.
 *
 * Key computation:
 *   - expectedGap = eventVolScalar * historicalATR * sqrt(timeToEvent / annualizationFactor)
 *   - eventVolScalar: multiplier based on event type importance
 *   - Higher proximity + higher vol = larger expected gap
 *
 * All computation functions are PURE.
 */

import {
  AdapterMode,
  AdapterHealth,
  ExternalDataAdapter,
} from './types';

import {
  EventCalendarAdapter,
  EventType,
  MarketEvent,
} from './event-calendar';

import {
  EventDistanceAdapter,
  EventDistanceEntry,
  EventDistanceResult,
} from './event-distance';

// ─── Types ──────────────────────────────────────────────────────────────────

export type EventVolGapEntry = {
  eventType: EventType;
  event: MarketEvent;
  hoursToEvent: number;
  historicalATR: number;           // recent ATR (annualized vol proxy)
  eventVolScalar: number;          // importance-based multiplier
  expectedGapPct: number;          // expected gap as % of underlying
  expectedGapPoints: number;       // in index points (for NIFTY)
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'EXTREME';
  strikeSuggestion: number;        // suggested buffer in points
};

export type EventVolGapResult = {
  entries: EventVolGapEntry[];
  maxExpectedGap: number;          // % — largest expected gap
  aggregateRisk: number;           // 0-1 composite event risk score
  timestamp: number;
};

// ─── Constants ──────────────────────────────────────────────────────────────

/** Event-type importance scalars: how much each event type amplifies vol */
const EVENT_VOL_SCALAR: Record<EventType, number> = {
  RBI_POLICY: 1.8,
  GDP_RELEASE: 1.5,
  INFLATION_CPI: 1.4,
  INFLATION_WPI: 1.1,
  FII_FLOW: 1.0,
  DII_FLOW: 0.8,
  EARNINGS_NIFTY50: 1.3,
  BUDGET: 2.0,
  FOMC_MINUTES: 1.3,
  US_CPI: 1.4,
  US_NFP: 1.2,
  CRUDE_INVENTORY: 0.7,
  DIVIDEND_EX: 0.3,
  INDEX_REBALANCE: 0.5,
  OTHER: 0.6,
};

const ANNUALIZATION_FACTOR = Math.sqrt(252); // sqrt(trading days)

// ─── Pure computation functions ──────────────────────────────────────────────

/**
 * Compute expected gap for an event given its distance and historical vol.
 *
 * @param hoursToEvent - hours until the event
 * @param historicalATR - recent ATR as % of underlying (e.g. 1.2 = 1.2%)
 * @param eventScalar - importance multiplier from EVENT_VOL_SCALAR
 * @returns expected gap in % (absolute value)
 */
export function computeExpectedGap(
  hoursToEvent: number,
  historicalATR: number,
  eventScalar: number,
): number {
  if (hoursToEvent <= 0 || historicalATR <= 0) return 0;
  const daysToEvent = hoursToEvent / 24;
  // Gap expectation grows with sqrt(time) and event importance
  const expectedGap = eventScalar * historicalATR * Math.sqrt(daysToEvent) / ANNUALIZATION_FACTOR;
  return Math.round(expectedGap * 10000) / 10000;
}

/** Classify risk level based on expected gap percentage */
export function classifyGapRisk(expectedGapPct: number): EventVolGapEntry['riskLevel'] {
  if (expectedGapPct < 0.2) return 'LOW';
  if (expectedGapPct < 0.5) return 'MEDIUM';
  if (expectedGapPct < 1.0) return 'HIGH';
  return 'EXTREME';
}

/** Suggest a strike buffer (in points) for a NIFTY-size underlying */
export function suggestStrikeBuffer(
  expectedGapPct: number,
  underlyingPrice: number,
  safetyMargin: number = 1.5,
): number {
  const gapPoints = (expectedGapPct / 100) * underlyingPrice;
  return Math.ceil(gapPoints * safetyMargin);
}

/**
 * Compute event-vol-gap for all upcoming high-importance events.
 *
 * @param distanceResult - output from EventDistanceAdapter.compute()
 * @param historicalATR - current ATR as % of underlying (e.g. 1.2 for 1.2%)
 * @param underlyingPrice - current underlying price (default: NIFTY ~24500)
 */
export function computeEventVolGaps(
  distanceResult: EventDistanceResult,
  historicalATR: number,
  underlyingPrice: number = 24500,
): EventVolGapResult {
  const entries: EventVolGapEntry[] = [];

  for (const dist of distanceResult.entries) {
    if (!dist.nextEvent || dist.hoursToNext === null) continue;
    if (dist.hoursToNext <= 0) continue;

    const scalar = EVENT_VOL_SCALAR[dist.type] ?? 0.6;
    const expectedGapPct = computeExpectedGap(dist.hoursToNext, historicalATR, scalar);
    const expectedGapPoints = Math.round((expectedGapPct / 100) * underlyingPrice);

    entries.push({
      eventType: dist.type,
      event: dist.nextEvent,
      hoursToEvent: dist.hoursToNext,
      historicalATR,
      eventVolScalar: scalar,
      expectedGapPct,
      expectedGapPoints,
      riskLevel: classifyGapRisk(expectedGapPct),
      strikeSuggestion: suggestStrikeBuffer(expectedGapPct, underlyingPrice),
    });
  }

  // Sort by expected gap descending
  entries.sort((a, b) => b.expectedGapPct - a.expectedGapPct);

  const maxExpectedGap = entries.length > 0 ? entries[0].expectedGapPct : 0;

  // Aggregate risk: normalized count of HIGH+ events
  const highRiskCount = entries.filter((e) => e.riskLevel === 'HIGH' || e.riskLevel === 'EXTREME').length;
  const aggregateRisk = entries.length > 0 ? Math.min(1, highRiskCount / Math.max(1, entries.length)) : 0;

  return {
    entries,
    maxExpectedGap: round4(maxExpectedGap),
    aggregateRisk: round4(aggregateRisk),
    timestamp: distanceResult.timestamp,
  };
}

// ─── Adapter ────────────────────────────────────────────────────────────────

export class EventVolGapAdapter implements ExternalDataAdapter {
  readonly name = 'event-vol-gap';
  private mode: AdapterMode;
  private health: AdapterHealth = { ok: true, lastFetchAt: null, errorCount: 0, mode: 'mock' };
  private distanceAdapter: EventDistanceAdapter;

  constructor(mode: AdapterMode = 'mock') {
    this.mode = mode;
    this.health.mode = mode;
    this.distanceAdapter = new EventDistanceAdapter(mode);
  }

  getMode(): AdapterMode { return this.mode; }
  getHealth(): AdapterHealth { return { ...this.health }; }
  dispose(): void {
    this.distanceAdapter.dispose();
  }

  /**
   * Compute event-vol-gap analysis.
   * @param historicalATR - recent ATR as % (e.g. 1.2 = 1.2%)
   * @param underlyingPrice - current underlying price
   */
  compute(
    historicalATR: number = 1.2,
    underlyingPrice: number = 24500,
  ): EventVolGapResult {
    if (this.mode === 'disabled') {
      return { entries: [], maxExpectedGap: 0, aggregateRisk: 0, timestamp: Date.now() };
    }

    const now = Date.now();
    const distanceResult = this.distanceAdapter.compute(now);
    const result = computeEventVolGaps(distanceResult, historicalATR, underlyingPrice);
    this.health.lastFetchAt = now;
    return result;
  }
}

// ─── Factory ────────────────────────────────────────────────────────────────

export function createEventVolGapAdapter(mode: AdapterMode = 'mock'): EventVolGapAdapter {
  return new EventVolGapAdapter(mode);
}

function round4(n: number): number { return Math.round(n * 10000) / 10000; }
