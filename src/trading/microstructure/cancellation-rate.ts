/**
 * ITEM 55 — Track cancellation rate and quote-event intensity.
 *
 * doneWhen: "A report shows cancellation rate and quote-event intensity with sample size."
 *
 * PINNED SEMantics (cancelrate-v1)
 *   Observation window: one instrument session = (instrumentKey, sessionDate).
 *   Cancellation rate:   ratio of cancelled orders to total orders placed within the window.
 *   Quote-event intensity: number of quote events per minute in the observation window.
 *
 * PURE: no clock, no I/O, no DB, no network, no AI, no randomness.
 * RESEARCH / SHADOW ONLY.
 */

export const CANCELLATION_RATE_VERSION = 'cancelrate-v1';

export type CancellationStatus = 'OK' | 'UNAVAILABLE' | 'DISABLED';
export type CancellationRefusal =
  | 'NO_EVENTS'
  | 'NO_TIMESTAMPS'
  | 'ZERO_WINDOW'
  | 'INVALID_COUNTS';

export interface QuoteEvent {
  readonly instrumentKey: string;
  readonly sessionDate: string;
  readonly timestampMs: number;
  readonly isCancellation: boolean;
}

export interface CancellationRateConfig {
  readonly enabled: boolean;
  /** Minimum events required to compute a rate. */
  readonly minEvents: number;
}

export const DEFAULT_CANCELLATION_RATE_CONFIG: CancellationRateConfig = {
  enabled: true,
  minEvents: 2,
};

export interface CancellationRateResult {
  readonly version: string;
  readonly status: CancellationStatus;
  readonly refusal: CancellationRefusal | null;
  readonly instrumentKey: string;
  readonly sessionDate: string;
  readonly totalEvents: number;
  readonly cancellations: number;
  readonly fills: number;
  readonly cancellationRate: number | null;
  readonly quoteEventsPerMinute: number | null;
  readonly windowMs: number | null;
  readonly reviewerSummary: string;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Compute cancellation rate and quote-event intensity for one instrument session.
 */
export function computeCancellationRate(
  events: readonly QuoteEvent[],
  config: Partial<CancellationRateConfig> = {},
): CancellationRateResult {
  const cfg = { ...DEFAULT_CANCELLATION_RATE_CONFIG, ...config };

  const key = events[0]?.instrumentKey ?? '';
  const sessionDate = events[0]?.sessionDate ?? '';

  const refuse = (reason: CancellationRefusal, detail: string): CancellationRateResult => ({
    version: CANCELLATION_RATE_VERSION,
    status: 'UNAVAILABLE',
    refusal: reason,
    instrumentKey: key,
    sessionDate,
    totalEvents: events.length,
    cancellations: 0,
    fills: 0,
    cancellationRate: null,
    quoteEventsPerMinute: null,
    windowMs: null,
    reviewerSummary: `${CANCELLATION_RATE_VERSION}: ${detail}`,
  });

  if (!cfg.enabled) {
    return {
      version: CANCELLATION_RATE_VERSION,
      status: 'DISABLED',
      refusal: null,
      instrumentKey: key,
      sessionDate,
      totalEvents: events.length,
      cancellations: 0,
      fills: 0,
      cancellationRate: null,
      quoteEventsPerMinute: null,
      windowMs: null,
      reviewerSummary: `${CANCELLATION_RATE_VERSION}: disabled`,
    };
  }

  if (events.length === 0) return refuse('NO_EVENTS', 'no quote events provided');

  const timestamps = events.map((e) => e.timestampMs).filter(isNum);
  if (timestamps.length < 2) return refuse('NO_TIMESTAMPS', 'fewer than 2 usable timestamps');

  const sorted = [...timestamps].sort((a, b) => a - b);
  const windowMs = sorted[sorted.length - 1] - sorted[0];
  if (windowMs <= 0) return refuse('ZERO_WINDOW', 'window has zero duration');

  const cancellations = events.filter((e) => e.isCancellation).length;
  const fills = events.filter((e) => !e.isCancellation).length;
  const totalEvents = events.length;

  if (totalEvents < cfg.minEvents) {
    return refuse('NO_EVENTS', `only ${totalEvents} events, need >= ${cfg.minEvents}`);
  }

  const cancellationRate = totalEvents > 0 ? cancellations / totalEvents : 0;
  const windowMinutes = windowMs / 60_000;
  const quoteEventsPerMinute = windowMinutes > 0 ? totalEvents / windowMinutes : 0;

  return {
    version: CANCELLATION_RATE_VERSION,
    status: 'OK',
    refusal: null,
    instrumentKey: key,
    sessionDate,
    totalEvents,
    cancellations,
    fills,
    cancellationRate: Number(cancellationRate.toFixed(6)),
    quoteEventsPerMinute: Number(quoteEventsPerMinute.toFixed(6)),
    windowMs,
    reviewerSummary: [
      `${CANCELLATION_RATE_VERSION}: ${totalEvents} events, ${cancellations} cancellations,`,
      `rate=${(cancellationRate * 100).toFixed(2)}%, intensity=${quoteEventsPerMinute.toFixed(2)} events/min`,
      `over ${(windowMs / 60_000).toFixed(1)} min window.`,
    ].join(' '),
  };
}

/**
 * Compute cancellation rate for multiple sessions.
 */
export function computeCancellationRateReport(
  allEvents: readonly QuoteEvent[],
  config: Partial<CancellationRateConfig> = {},
): {
  version: string;
  config: CancellationRateConfig;
  results: readonly CancellationRateResult[];
  summary: {
    totalSessions: number;
    okSessions: number;
    avgCancellationRate: number | null;
    avgQuoteEventsPerMinute: number | null;
  };
} {
  const cfg = { ...DEFAULT_CANCELLATION_RATE_CONFIG, ...config };

  // Group by instrumentKey + sessionDate
  const groups = new Map<string, QuoteEvent[]>();
  for (const ev of allEvents) {
    const gkey = `${ev.instrumentKey}|${ev.sessionDate}`;
    const arr = groups.get(gkey) ?? [];
    arr.push(ev);
    groups.set(gkey, arr);
  }

  const results: CancellationRateResult[] = [];
  for (const [, events] of groups) {
    results.push(computeCancellationRate(events, config));
  }

  const okResults = results.filter((r) => r.status === 'OK');
  const avgCancellationRate =
    okResults.length > 0
      ? okResults.reduce((s, r) => s + (r.cancellationRate ?? 0), 0) / okResults.length
      : null;
  const avgQuoteEventsPerMinute =
    okResults.length > 0
      ? okResults.reduce((s, r) => s + (r.quoteEventsPerMinute ?? 0), 0) / okResults.length
      : null;

  return {
    version: CANCELLATION_RATE_VERSION,
    config: cfg,
    results,
    summary: {
      totalSessions: results.length,
      okSessions: okResults.length,
      avgCancellationRate: avgCancellationRate !== null ? Number(avgCancellationRate.toFixed(6)) : null,
      avgQuoteEventsPerMinute:
        avgQuoteEventsPerMinute !== null ? Number(avgQuoteEventsPerMinute.toFixed(6)) : null,
    },
  };
}
