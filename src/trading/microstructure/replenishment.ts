/**
 * ITEM 56 — Track replenishment after consumption.
 *
 * doneWhen: "A report shows replenishment ratio and time-to-replenish with sample size."
 *
 * PINNED SEMantics (replenish-v1)
 *   Observation window: one instrument session = (instrumentKey, sessionDate).
 *   Replenishment ratio: volume replenished after a consumption event / volume consumed.
 *   Time to replenish:   ms from consumption event to when volume returns to pre-consumption level.
 *
 * PURE: no clock, no I/O, no DB, no network, no AI, no randomness.
 * RESEARCH / SHADOW ONLY.
 */

export const REPLENISHMENT_VERSION = 'replenish-v1';

export type ReplenishmentStatus = 'OK' | 'UNAVAILABLE' | 'DISABLED';
export type ReplenishmentRefusal =
  | 'NO_EVENTS'
  | 'INSUFFICIENT_DATA'
  | 'NO_CONSUMPTION';

export interface VolumeEvent {
  readonly instrumentKey: string;
  readonly sessionDate: string;
  readonly timestampMs: number;
  /** Cumulative volume at this observation. */
  readonly cumulativeVolume: number;
  /** Volume consumed (delta from previous if negative delta indicates consumption). */
  readonly deltaVolume: number;
}

export interface ReplenishmentConfig {
  readonly enabled: boolean;
  /** Minimum consumption events to produce a report. */
  readonly minConsumptionEvents: number;
}

export const DEFAULT_REPLENISHMENT_CONFIG: ReplenishmentConfig = {
  enabled: true,
  minConsumptionEvents: 1,
};

export interface ConsumptionEvent {
  readonly timestampMs: number;
  readonly volumeConsumed: number;
  readonly preConsumptionVolume: number;
  readonly replenishedVolume: number | null;
  readonly timeToReplenishMs: number | null;
  readonly replenishmentRatio: number | null;
}

export interface ReplenishmentResult {
  readonly version: string;
  readonly status: ReplenishmentStatus;
  readonly refusal: ReplenishmentRefusal | null;
  readonly instrumentKey: string;
  readonly sessionDate: string;
  readonly totalEvents: number;
  readonly consumptionEvents: readonly ConsumptionEvent[];
  readonly avgReplenishmentRatio: number | null;
  readonly avgTimeToReplenishMs: number | null;
  readonly reviewerSummary: string;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Detect consumption events: negative deltaVolume indicates consumption.
 * Replenishment is tracked by monitoring if cumulative volume returns
 * to pre-consumption level within the session.
 */
function detectConsumptionAndReplenishment(
  sortedEvents: readonly VolumeEvent[],
): ConsumptionEvent[] {
  const results: ConsumptionEvent[] = [];

  for (let i = 0; i < sortedEvents.length; i++) {
    const ev = sortedEvents[i];
    if (ev.deltaVolume >= 0) continue; // Not a consumption event

    const volumeConsumed = Math.abs(ev.deltaVolume);
    const preConsumptionVolume = ev.cumulativeVolume;

    // Look forward for replenishment: cumulative volume returns to preConsumptionVolume
    let replenishedVolume: number | null = null;
    let timeToReplenishMs: number | null = null;

    for (let j = i + 1; j < sortedEvents.length; j++) {
      const later = sortedEvents[j];
      if (later.cumulativeVolume >= preConsumptionVolume) {
        replenishedVolume = later.cumulativeVolume - ev.cumulativeVolume;
        timeToReplenishMs = later.timestampMs - ev.timestampMs;
        break;
      }
    }

    const replenishmentRatio =
      volumeConsumed > 0 && replenishedVolume !== null
        ? Number((replenishedVolume / volumeConsumed).toFixed(6))
        : null;

    results.push({
      timestampMs: ev.timestampMs,
      volumeConsumed,
      preConsumptionVolume,
      replenishedVolume,
      timeToReplenishMs,
      replenishmentRatio,
    });
  }

  return results;
}

/**
 * Compute replenishment metrics for one instrument session.
 */
export function computeReplenishment(
  events: readonly VolumeEvent[],
  config: Partial<ReplenishmentConfig> = {},
): ReplenishmentResult {
  const cfg = { ...DEFAULT_REPLENISHMENT_CONFIG, ...config };

  const key = events[0]?.instrumentKey ?? '';
  const sessionDate = events[0]?.sessionDate ?? '';

  const refuse = (reason: ReplenishmentRefusal): ReplenishmentResult => ({
    version: REPLENISHMENT_VERSION,
    status: 'UNAVAILABLE',
    refusal: reason,
    instrumentKey: key,
    sessionDate,
    totalEvents: events.length,
    consumptionEvents: [],
    avgReplenishmentRatio: null,
    avgTimeToReplenishMs: null,
    reviewerSummary: `${REPLENISHMENT_VERSION}: refusal=${reason}`,
  });

  if (!cfg.enabled) {
    return {
      version: REPLENISHMENT_VERSION,
      status: 'DISABLED',
      refusal: null,
      instrumentKey: key,
      sessionDate,
      totalEvents: events.length,
      consumptionEvents: [],
      avgReplenishmentRatio: null,
      avgTimeToReplenishMs: null,
      reviewerSummary: `${REPLENISHMENT_VERSION}: disabled`,
    };
  }

  if (events.length === 0) return refuse('NO_EVENTS');

  const validEvents = events.filter(
    (e) => isNum(e.timestampMs) && isNum(e.cumulativeVolume) && isNum(e.deltaVolume),
  );
  if (validEvents.length < 2) return refuse('INSUFFICIENT_DATA');

  const sorted = [...validEvents].sort((a, b) => a.timestampMs - b.timestampMs);
  const consumptionEvents = detectConsumptionAndReplenishment(sorted);

  if (consumptionEvents.length < cfg.minConsumptionEvents) return refuse('NO_CONSUMPTION');

  const ratios = consumptionEvents.filter((e) => e.replenishmentRatio !== null).map((e) => e.replenishmentRatio!);
  const times = consumptionEvents.filter((e) => e.timeToReplenishMs !== null).map((e) => e.timeToReplenishMs!);

  const avgRatio = ratios.length > 0 ? ratios.reduce((a, b) => a + b, 0) / ratios.length : null;
  const avgTime = times.length > 0 ? times.reduce((a, b) => a + b, 0) / times.length : null;

  return {
    version: REPLENISHMENT_VERSION,
    status: 'OK',
    refusal: null,
    instrumentKey: key,
    sessionDate,
    totalEvents: events.length,
    consumptionEvents,
    avgReplenishmentRatio: avgRatio !== null ? Number(avgRatio.toFixed(6)) : null,
    avgTimeToReplenishMs: avgTime !== null ? Number(avgTime.toFixed(2)) : null,
    reviewerSummary: [
      `${REPLENISHMENT_VERSION}: ${consumptionEvents.length} consumption events,`,
      `avg ratio=${avgRatio?.toFixed(2) ?? 'N/A'}, avg time=${avgTime?.toFixed(0) ?? 'N/A'}ms`,
    ].join(' '),
  };
}
