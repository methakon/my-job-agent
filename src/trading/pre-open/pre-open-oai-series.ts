/**
 * GATE 2 item 3 (roadmap row 22) — STORE the OAI time-series metrics:
 * level, slope, acceleration and persistence.
 *
 * doneWhen: "A historical record contains the value, timestamp/context and version
 * needed to reproduce or audit it."
 *
 * Roadmap instruction: "preserve the value used at decision time rather than
 * recomputing it later." So the capture path computes this block ONCE, at the moment
 * the observation is stored, and writes it onto the row (`pre_open_observations.derived`).
 * Reading it back later never recomputes anything.
 *
 * DEFINITIONS (all pinned here, versioned as OAI_SERIES_VERSION):
 *
 *   level        = the newest usable OAI in the window            [ratio, -1..+1]
 *   slope        = (last - first) / elapsedMinutes                [ratio per MINUTE]
 *   acceleration = (slopeLastLeg - slopePrevLeg) / meanLegMinutes [ratio per MINUTE^2]
 *   persistence  = (# usable samples whose OAI sign equals the newest sample's sign)
 *                  / (# usable samples with a non-zero OAI)        [fraction, 0..1]
 *
 *   - "sign" of 0 is neutral: it is excluded from the persistence denominator and
 *     never counts as agreeing with the newest direction (a flat book is not a
 *     persistent imbalance).
 *   - slope needs 2 usable samples; acceleration needs 3; persistence needs at least
 *     one non-zero OAI. Anything less returns UNAVAILABLE with a reason — never 0,
 *     never NaN, never Infinity.
 *
 * WINDOW AND LOOK-AHEAD. Samples are taken from the SAME session and the SAME auction
 * phase window (default 15 minutes back from the cutoff, i.e. the 09:00-09:15
 * auction). Samples with an event time after the cutoff are excluded — the metric is
 * what was knowable AT the cutoff. Duplicate timestamps collapse to their last value,
 * and input order does not matter: the series is sorted by event time, so replay is
 * deterministic.
 *
 * PURE: no clock, no I/O, no randomness — `cutoffMs` is always passed in.
 */

import { DerivedValue, unavailable, ok } from './pre-open-features';
import { SessionPhase } from './pre-open-session';

export const OAI_SERIES_VERSION = 'oais-v1';

/** Default look-back window: the 09:00-09:15 pre-open auction. */
export const DEFAULT_SERIES_WINDOW_MS = 15 * 60_000;

/** Hard bound on samples considered, so a pathological store cannot blow up a poll. */
export const MAX_SERIES_SAMPLES = 240;

/** An OAI value must be a ratio; anything outside [-1,+1] (beyond float noise) is not one. */
const OAI_BOUNDS_TOLERANCE = 1e-6;

export type OaiSample = { atMs: number; oai: number };

export type OaiSeriesMetrics = {
  version: string;
  /** Event time of the newest sample included — the decision cutoff these describe. */
  cutoffMs: number | null;
  sessionPhase: SessionPhase | null;
  /** Samples actually used (after filtering/dedupe), oldest first. */
  sampleCount: number;
  windowStartMs: number | null;
  windowEndMs: number | null;
  level: DerivedValue;
  /** Units: OAI ratio per minute. */
  slope: DerivedValue;
  /** Units: OAI ratio per minute squared. */
  acceleration: DerivedValue;
  /** Fraction of non-zero samples agreeing with the newest sample's direction. */
  persistence: DerivedValue;
  steps: { considered: number; refused: number; afterCutoff: number; outOfWindow: number };
  reasons: string[];
};

/** Last value per distinct timestamp, ascending — order-independent and replay-stable. */
const normalise = (samples: readonly OaiSample[], input: { cutoffMs: number; windowMs: number }) => {
  const byTime = new Map<number, number>();
  const counters = { refused: 0, afterCutoff: 0, outOfWindow: 0 };
  for (const sample of samples) {
    const at = Number(sample.atMs);
    const value = Number(sample.oai);
    if (!Number.isFinite(at) || !Number.isFinite(value) || Math.abs(value) > 1 + OAI_BOUNDS_TOLERANCE) {
      counters.refused += 1;
      continue;
    }
    if (at > input.cutoffMs) { counters.afterCutoff += 1; continue; }
    if (at < input.cutoffMs - input.windowMs) { counters.outOfWindow += 1; continue; }
    byTime.set(at, value);
  }
  const ordered = [...byTime.entries()].sort((a, b) => a[0] - b[0]).map(([atMs, oai]) => ({ atMs, oai }));
  return { ordered: ordered.slice(-MAX_SERIES_SAMPLES), counters };
};

/**
 * Build the stored block. The caller passes the samples it has (already scoped to one
 * instrument/session); this function owns the window, the ordering and the maths.
 */
export const buildOaiSeries = (input: {
  samples: readonly OaiSample[];
  sessionPhase: SessionPhase | null;
  cutoffMs: number;
  windowMs?: number;
}): OaiSeriesMetrics => {
  const windowMs = input.windowMs ?? DEFAULT_SERIES_WINDOW_MS;
  const { ordered, counters } = normalise(input.samples, { cutoffMs: input.cutoffMs, windowMs });
  const reasons: string[] = [];
  const windowStartMs = ordered.length ? ordered[0].atMs : null;
  const windowEndMs = ordered.length ? ordered[ordered.length - 1].atMs : null;

  const level = ordered.length
    ? ok(ordered[ordered.length - 1].oai)
    : unavailable('no usable OAI samples in the window');
  if (!ordered.length) reasons.push('series empty');

  // slope — ratio per minute over the whole window.
  let slope: DerivedValue;
  if (ordered.length < 2) {
    slope = unavailable(`needs 2 usable samples, has ${ordered.length}`);
  } else {
    const minutes = (ordered[ordered.length - 1].atMs - ordered[0].atMs) / 60_000;
    slope = minutes > 0
      ? ok((ordered[ordered.length - 1].oai - ordered[0].oai) / minutes)
      : unavailable('samples share one timestamp — a rate would be undefined');
  }
  if (slope.status === 'UNAVAILABLE') reasons.push(`slope: ${slope.reason}`);

  // acceleration — change of slope between the last two legs, per minute.
  let acceleration: DerivedValue;
  const legSlopes: { slopePerMin: number; minutes: number }[] = [];
  for (let i = 1; i < ordered.length; i += 1) {
    const minutes = (ordered[i].atMs - ordered[i - 1].atMs) / 60_000;
    if (minutes > 0) legSlopes.push({ slopePerMin: (ordered[i].oai - ordered[i - 1].oai) / minutes, minutes });
  }
  if (legSlopes.length < 2) {
    acceleration = unavailable(`needs 3 usable samples (2 legs), has ${ordered.length}`);
  } else {
    const last = legSlopes[legSlopes.length - 1];
    const prev = legSlopes[legSlopes.length - 2];
    const meanMinutes = (last.minutes + prev.minutes) / 2;
    acceleration = meanMinutes > 0
      ? ok((last.slopePerMin - prev.slopePerMin) / meanMinutes)
      : unavailable('leg durations are zero — an acceleration would be undefined');
  }
  if (acceleration.status === 'UNAVAILABLE') reasons.push(`acceleration: ${acceleration.reason}`);

  // persistence — how one-sided the imbalance has been, relative to the newest sign.
  let persistence: DerivedValue;
  const newest = ordered.length ? ordered[ordered.length - 1].oai : null;
  const nonZero = ordered.filter((s) => s.oai !== 0);
  if (newest === null) {
    persistence = unavailable('no usable OAI samples in the window');
  } else if (newest === 0 || nonZero.length === 0) {
    persistence = unavailable('newest OAI is neutral (0) — no direction to persist');
  } else {
    const agreeing = nonZero.filter((s) => Math.sign(s.oai) === Math.sign(newest)).length;
    persistence = ok(agreeing / nonZero.length);
  }
  if (persistence.status === 'UNAVAILABLE') reasons.push(`persistence: ${persistence.reason}`);

  return {
    version: OAI_SERIES_VERSION,
    cutoffMs: windowEndMs,
    sessionPhase: input.sessionPhase,
    sampleCount: ordered.length,
    windowStartMs,
    windowEndMs,
    level,
    slope,
    acceleration,
    persistence,
    steps: { considered: ordered.length, ...counters },
    reasons,
  };
};

/** Deterministic equality on the stored block (used by replay tests). */
export const seriesDigest = (metrics: OaiSeriesMetrics): string => JSON.stringify(metrics);
