/**
 * ITEM 95 — Gap fill metrics: fill probability, time-to-fill, midpoint, MAE/MFE, tail loss.
 *
 * doneWhen: "A report shows fill probability, time-to-fill, midpoint, MAE/MFE, and tail loss with sample size."
 *
 * PINNED SEMantics (gapmetrics-v1)
 *   Fill probability:      fraction of gaps where price reaches the origin (fully filled).
 *   Time-to-fill:          ms from open to first fill event, or null if not filled.
 *   Midpoint:              (open + origin) / 2 — the halfway point.
 *   MAE (Maximum Adverse Excursion): largest move AGAINST the gap direction from open.
 *   MFE (Maximum Favourable Excursion): largest move WITH the gap direction from open.
 *   Tail loss:             worst-case loss beyond a percentile threshold.
 *
 * PURE: no clock, no I/O, no DB, no network, no AI, no randomness.
 * RESEARCH / SHADOW ONLY.
 */

export const GAP_METRICS_VERSION = 'gapmetrics-v1';

export type GapMetricsStatus = 'OK' | 'UNAVAILABLE' | 'DISABLED';
export type GapMetricsRefusal = 'NO_SESSIONS' | 'INSUFFICIENT_DATA';

export interface GapSessionPath {
  readonly instrumentKey: string;
  readonly sessionDate: string;
  readonly origin: number;
  readonly open: number;
  /** Intraday observations (timestampMs, price). Must be chronological. */
  readonly observations: readonly { readonly timestampMs: number; readonly price: number }[];
}

export interface GapMetricsConfig {
  readonly enabled: boolean;
  /** Percentile threshold for tail loss calculation (e.g., 95 = 95th percentile). */
  readonly tailLossPercentile: number;
}

export const DEFAULT_GAP_METRICS_CONFIG: GapMetricsConfig = {
  enabled: true,
  tailLossPercentile: 95,
};

export interface PerSessionMetrics {
  readonly instrumentKey: string;
  readonly sessionDate: string;
  readonly gapDirection: 'UP' | 'DOWN';
  readonly filled: boolean;
  readonly timeToFillMs: number | null;
  readonly midpoint: number;
  readonly mae: number;
  readonly mfe: number;
  readonly maxExtensionPoints: number;
}

export interface GapMetricsResult {
  readonly version: string;
  readonly status: GapMetricsStatus;
  readonly refusal: GapMetricsRefusal | null;
  readonly sessions: readonly PerSessionMetrics[];
  readonly fillProbability: number | null;
  readonly avgTimeToFillMs: number | null;
  readonly avgMAE: number | null;
  readonly avgMFE: number | null;
  readonly tailLoss: number | null;
  readonly totalSessions: number;
  readonly filledSessions: number;
  readonly reviewerSummary: string;
}

/**
 * Compute per-session gap metrics.
 */
function computeSessionMetrics(session: GapSessionPath): PerSessionMetrics {
  const gapDirection = session.open >= session.origin ? 'UP' : 'DOWN';
  const midpoint = (session.open + session.origin) / 2;

  let filled = false;
  let timeToFillMs: number | null = null;
  let mae = 0;
  let mfe = 0;

  for (const obs of session.observations) {
    const excursionFromOpen = obs.price - session.open;
    const favourable = gapDirection === 'UP' ? excursionFromOpen : -excursionFromOpen;
    const adverse = -favourable;

    if (adverse > mae) mae = adverse;
    if (favourable > mfe) mfe = favourable;

    if (!filled) {
      const reachedOrigin =
        gapDirection === 'UP' ? obs.price <= session.origin : obs.price >= session.origin;
      if (reachedOrigin) {
        filled = true;
        timeToFillMs = obs.timestampMs - session.observations[0].timestampMs;
      }
    }
  }

  return {
    instrumentKey: session.instrumentKey,
    sessionDate: session.sessionDate,
    gapDirection,
    filled,
    timeToFillMs,
    midpoint: Number(midpoint.toFixed(6)),
    mae: Number(mae.toFixed(6)),
    mfe: Number(mfe.toFixed(6)),
    maxExtensionPoints: Number(mfe.toFixed(6)),
  };
}

/**
 * Compute gap metrics across sessions.
 */
export function computeGapMetrics(
  sessions: readonly GapSessionPath[],
  config: Partial<GapMetricsConfig> = {},
): GapMetricsResult {
  const cfg = { ...DEFAULT_GAP_METRICS_CONFIG, ...config };

  const refuse = (reason: GapMetricsRefusal): GapMetricsResult => ({
    version: GAP_METRICS_VERSION,
    status: 'UNAVAILABLE',
    refusal: reason,
    sessions: [],
    fillProbability: null,
    avgTimeToFillMs: null,
    avgMAE: null,
    avgMFE: null,
    tailLoss: null,
    totalSessions: 0,
    filledSessions: 0,
    reviewerSummary: `${GAP_METRICS_VERSION}: refusal=${reason}`,
  });

  if (!cfg.enabled) {
    return {
      version: GAP_METRICS_VERSION,
      status: 'DISABLED',
      refusal: null,
      sessions: [],
      fillProbability: null,
      avgTimeToFillMs: null,
      avgMAE: null,
      avgMFE: null,
      tailLoss: null,
      totalSessions: 0,
      filledSessions: 0,
      reviewerSummary: `${GAP_METRICS_VERSION}: disabled`,
    };
  }

  if (sessions.length === 0) return refuse('NO_SESSIONS');

  const sessionMetrics = sessions
    .filter((s) => s.observations.length >= 2)
    .map(computeSessionMetrics);

  if (sessionMetrics.length === 0) return refuse('INSUFFICIENT_DATA');

  const filledSessions = sessionMetrics.filter((m) => m.filled).length;
  const fillProbability = filledSessions / sessionMetrics.length;

  const fillTimes = sessionMetrics.filter((m) => m.timeToFillMs !== null).map((m) => m.timeToFillMs!);
  const avgTimeToFillMs =
    fillTimes.length > 0 ? fillTimes.reduce((a, b) => a + b, 0) / fillTimes.length : null;

  const avgMAE =
    sessionMetrics.reduce((s, m) => s + m.mae, 0) / sessionMetrics.length;
  const avgMFE =
    sessionMetrics.reduce((s, m) => s + m.mfe, 0) / sessionMetrics.length;

  // Tail loss: worst MAE beyond the configured percentile
  const sortedMAE = [...sessionMetrics].sort((a, b) => b.mae - a.mae);
  const pIdx = Math.min(
    sortedMAE.length - 1,
    Math.floor((cfg.tailLossPercentile / 100) * sortedMAE.length),
  );
  const tailLoss = sortedMAE[pIdx]?.mae ?? null;

  return {
    version: GAP_METRICS_VERSION,
    status: 'OK',
    refusal: null,
    sessions: sessionMetrics,
    fillProbability: Number(fillProbability.toFixed(6)),
    avgTimeToFillMs: avgTimeToFillMs !== null ? Number(avgTimeToFillMs.toFixed(2)) : null,
    avgMAE: Number(avgMAE.toFixed(6)),
    avgMFE: Number(avgMFE.toFixed(6)),
    tailLoss: tailLoss !== null ? Number(tailLoss.toFixed(6)) : null,
    totalSessions: sessionMetrics.length,
    filledSessions,
    reviewerSummary: [
      `${GAP_METRICS_VERSION}: ${sessionMetrics.length} sessions,`,
      `fill=${(fillProbability * 100).toFixed(1)}%,`,
      `MAE=${avgMAE.toFixed(2)}, MFE=${avgMFE.toFixed(2)},`,
      `tailLoss=${tailLoss?.toFixed(2) ?? 'N/A'}`,
    ].join(' '),
  };
}
