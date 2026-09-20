/**
 * ITEM 45 — Event/catalyst gate for gap engine.
 *
 * doneWhen: "can run in research/shadow mode without changing production."
 *
 * PURE: no clock, no I/O, no DB, no network, no randomness.
 * RESEARCH / SHADOW ONLY: nothing in production imports this module.
 *
 * Purpose: Before accepting a gap trade, check whether an upcoming or
 * recent event/catalyst is likely to invalidate the gap hypothesis.
 * Events like earnings, policy decisions, or major economic releases
 * can cause erratic price action that makes gap trades unreliable.
 */

// ── Types ─────────────────────────────────────────────────────────────

export const EVENT_GATE_VERSION = 'evtgate-v1';

export interface EventCatalyst {
  /** Unique event identifier. */
  readonly id: string;
  /** Human-readable name (e.g. "NIFTY Earnings Q2"). */
  readonly name: string;
  /** Event type classification. */
  readonly type: 'EARNINGS' | 'POLICY' | 'ECONOMIC_DATA' | 'GEOPOLITICAL' | 'TECHNICAL' | 'OTHER';
  /** Epoch-ms when the event occurs. */
  readonly eventTimeMs: number;
  /** Estimated market impact (1-5 scale, 5 = highest). */
  readonly impactLevel: 1 | 2 | 3 | 4 | 5;
  /** Whether the market has already reacted to this event. */
  readonly alreadyPricedIn: boolean;
}

export interface EventGateInput {
  /** Current timestamp (ms). */
  readonly currentMs: number;
  /** Gap candidate direction: positive = UP gap. */
  readonly gapSize: number;
  /** Upcoming events in the window. */
  readonly events: readonly EventCatalyst[];
  /** How far ahead to look for events (ms). Default 4 hours. */
  readonly lookaheadMs?: number;
  /** How far back to look for recent events (ms). Default 1 hour. */
  readonly lookbackMs?: number;
  /** Maximum allowed event impact for the gap to pass (default 3). */
  readonly maxAllowedImpact?: number;
}

export type EventGateRefusal =
  | 'HIGH_IMPACT_EVENT_UPCOMING'
  | 'RECENT_EVENT_UNABSORBED'
  | 'EARNINGS_IN_WINDOW'
  | 'POLICY_DECISION_IN_WINDOW';

export type EventGateVerdict =
  | { readonly pass: true; readonly version: string; readonly nearbyEvents: readonly EventCatalyst[] }
  | { readonly pass: false; readonly version: string; readonly reason: EventGateRefusal; readonly blockingEvent: EventCatalyst };

// ── Core gate ─────────────────────────────────────────────────────────

/**
 * Assess whether upcoming or recent events should block a gap trade.
 *
 * Rules:
 *  1. EARNINGS or POLICY events within the lookahead always block.
 *  2. High-impact events (>= maxAllowedImpact) within lookahead block
 *     unless they are already priced in.
 *  3. Recent events (within lookback) that haven't been absorbed block
 *     (gap may be a reaction that hasn't settled).
 *
 * Deterministic: same inputs → same verdict, always.
 */
export function assessEventCatalystGate(input: EventGateInput): EventGateVerdict {
  const {
    currentMs,
    events,
    lookaheadMs = 4 * 60 * 60 * 1000,  // 4 hours
    lookbackMs = 1 * 60 * 60 * 1000,    // 1 hour
    maxAllowedImpact = 3,
  } = input;

  const upcoming = events.filter(e => {
    const diff = e.eventTimeMs - currentMs;
    return diff > 0 && diff <= lookaheadMs;
  });

  const recent = events.filter(e => {
    const diff = currentMs - e.eventTimeMs;
    return diff > 0 && diff <= lookbackMs;
  });

  // Check upcoming events
  for (const evt of upcoming) {
    // Earnings and policy always block
    if (evt.type === 'EARNINGS' || evt.type === 'POLICY') {
      return { pass: false, version: EVENT_GATE_VERSION, reason: evt.type === 'EARNINGS' ? 'EARNINGS_IN_WINDOW' : 'POLICY_DECISION_IN_WINDOW', blockingEvent: evt };
    }
    // High-impact events block unless already priced in
    if (evt.impactLevel >= maxAllowedImpact && !evt.alreadyPricedIn) {
      return { pass: false, version: EVENT_GATE_VERSION, reason: 'HIGH_IMPACT_EVENT_UPCOMING', blockingEvent: evt };
    }
  }

  // Check recent events
  for (const evt of recent) {
    if (!evt.alreadyPricedIn && evt.impactLevel >= maxAllowedImpact) {
      return { pass: false, version: EVENT_GATE_VERSION, reason: 'RECENT_EVENT_UNABSORBED', blockingEvent: evt };
    }
  }

  // All clear
  const nearbyEvents = [...upcoming, ...recent].filter(e => e.impactLevel >= 2);
  return { pass: true, version: EVENT_GATE_VERSION, nearbyEvents };
}
