/**
 * Event Distance Computation (Item 290)
 *
 * Computes time-to-next-event and days-since-last for each event type.
 * Built on top of the event-calendar adapter.
 *
 * Key outputs:
 *   - timeToNextEvent: hours until next event of each type
 *   - daysSinceLastEvent: days since last event of each type
 *   - proximityScore: combined metric for event-dense vs sparse periods
 *
 * All computation functions are PURE — take calendar data in, return results.
 */

import {
  AdapterMode,
  AdapterHealth,
  ExternalDataAdapter,
} from './types';

import {
  EventCalendar,
  EventCalendarAdapter,
  EventType,
  MarketEvent,
} from './event-calendar';

// ─── Types ──────────────────────────────────────────────────────────────────

export type EventDistanceEntry = {
  type: EventType;
  nextEvent: MarketEvent | null;
  prevEvent: MarketEvent | null;
  hoursToNext: number | null;    // null if no upcoming event
  daysSinceLast: number | null;  // null if no past event
  importance: 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE';
};

export type EventDistanceResult = {
  entries: EventDistanceEntry[];
  proximityScore: number;  // 0-1, higher = more events clustered nearby
  nextHighEvent: MarketEvent | null;
  hoursToHighEvent: number | null;
  timestamp: number;
};

// ─── Pure computation functions ──────────────────────────────────────────────

const MS_PER_HOUR = 3600000;
const MS_PER_DAY = 86400000;

/** Compute distance entries for all event types present in the calendar */
export function computeEventDistances(
  calendar: EventCalendar,
  refTimeMs: number,
): EventDistanceResult {
  const events = calendar.events;
  const typeSet = new Set<EventType>();
  for (const e of events) typeSet.add(e.type);

  const entries: EventDistanceEntry[] = [];

  for (const type of typeSet) {
    const typeEvents = events
      .filter((e) => e.type === type)
      .sort((a, b) => a.scheduledAt - b.scheduledAt);

    // Find next and previous relative to refTime
    let nextEvent: MarketEvent | null = null;
    let prevEvent: MarketEvent | null = null;

    for (const e of typeEvents) {
      if (e.scheduledAt > refTimeMs && !nextEvent) {
        nextEvent = e;
      }
      if (e.scheduledAt <= refTimeMs) {
        prevEvent = e; // last one before refTime
      }
    }

    const hoursToNext = nextEvent
      ? round1((nextEvent.scheduledAt - refTimeMs) / MS_PER_HOUR)
      : null;
    const daysSinceLast = prevEvent
      ? round1((refTimeMs - prevEvent.scheduledAt) / MS_PER_DAY)
      : null;

    const importance = nextEvent?.importance ?? prevEvent?.importance ?? 'NONE';

    entries.push({
      type,
      nextEvent,
      prevEvent,
      hoursToNext,
      daysSinceLast,
      importance,
    });
  }

  // Proximity score: weighted by importance, inversely by distance
  let scoreSum = 0;
  let weightSum = 0;
  for (const entry of entries) {
    const impWeight = entry.importance === 'HIGH' ? 3 : entry.importance === 'MEDIUM' ? 2 : 1;
    if (entry.hoursToNext !== null && entry.hoursToNext >= 0) {
      // Closer events → higher score (inverse, capped at 72h)
      const closeness = Math.max(0, 1 - entry.hoursToNext / 72);
      scoreSum += closeness * impWeight;
      weightSum += impWeight;
    }
  }
  const proximityScore = weightSum > 0 ? round4(scoreSum / weightSum) : 0;

  // Find the nearest high-importance event
  const highEntries = entries.filter((e) => e.importance === 'HIGH' && e.hoursToNext !== null);
  highEntries.sort((a, b) => (a.hoursToNext ?? Infinity) - (b.hoursToNext ?? Infinity));
  const nextHighEvent = highEntries[0]?.nextEvent ?? null;
  const hoursToHighEvent = highEntries[0]?.hoursToNext ?? null;

  return {
    entries,
    proximityScore,
    nextHighEvent,
    hoursToHighEvent,
    timestamp: refTimeMs,
  };
}

// ─── Adapter ────────────────────────────────────────────────────────────────

export class EventDistanceAdapter implements ExternalDataAdapter {
  readonly name = 'event-distance';
  private mode: AdapterMode;
  private health: AdapterHealth = { ok: true, lastFetchAt: null, errorCount: 0, mode: 'mock' };
  private calendarAdapter: EventCalendarAdapter;

  constructor(mode: AdapterMode = 'mock') {
    this.mode = mode;
    this.health.mode = mode;
    this.calendarAdapter = new EventCalendarAdapter(mode);
  }

  getMode(): AdapterMode { return this.mode; }
  getHealth(): AdapterHealth { return { ...this.health }; }
  dispose(): void {
    this.calendarAdapter.dispose();
  }

  /** Compute event distances for the given reference time */
  compute(refTimeMs?: number): EventDistanceResult {
    if (this.mode === 'disabled') {
      return {
        entries: [],
        proximityScore: 0,
        nextHighEvent: null,
        hoursToHighEvent: null,
        timestamp: refTimeMs ?? Date.now(),
      };
    }

    const now = refTimeMs ?? Date.now();
    const calendar = this.calendarAdapter.fetchCalendar(now);
    const result = computeEventDistances(calendar, now);
    this.health.lastFetchAt = now;
    return result;
  }

  /** Get only HIGH importance event distances */
  computeHighImportance(refTimeMs?: number): EventDistanceEntry[] {
    const result = this.compute(refTimeMs);
    return result.entries.filter((e) => e.importance === 'HIGH');
  }
}

// ─── Factory ────────────────────────────────────────────────────────────────

export function createEventDistanceAdapter(mode: AdapterMode = 'mock'): EventDistanceAdapter {
  return new EventDistanceAdapter(mode);
}

function round1(n: number): number { return Math.round(n * 10) / 10; }
function round4(n: number): number { return Math.round(n * 10000) / 10000; }
