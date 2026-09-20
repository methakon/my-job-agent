/**
 * ITEM 171 — Purging when labels overlap.
 *
 * doneWhen: "timestamp/leakage test proves no post-decision info."
 *
 * PURE: no clock, no I/O, no DB, no network, no randomness.
 * RESEARCH / SHADOW ONLY: nothing in production imports this module.
 *
 * Purging removes training samples whose labels depend on future data
 * that overlaps with validation/test windows. This prevents look-ahead
 * bias when labels have a forward-looking horizon.
 *
 * For example, if labels are based on "price 5 minutes from now" and
 * a training sample's label window extends into the validation period,
 * that sample must be purged to avoid data leakage.
 */

// ── Types ─────────────────────────────────────────────────────────────

export const PURGE_VERSION = 'purge-v1';

export interface PurgeInput {
  /** Sample timestamps (ms). */
  readonly timestamps: readonly number[];
  /** Label horizon: how far ahead each label looks (ms). */
  readonly labelHorizonMs: number;
  /** Validation start timestamp. Samples whose label window overlaps this are purged. */
  readonly valStartMs: number;
  /** Optional: test start timestamp for double-purging. */
  readonly testStartMs?: number;
}

export interface PurgeResult {
  readonly version: string;
  /** Indices of samples that survived purging (safe to use in training). */
  readonly safeIndices: readonly number[];
  /** Indices of samples that were purged. */
  readonly purgedIndices: readonly number[];
  /** Number of samples purged. */
  readonly purgedCount: number;
  /** Total samples. */
  readonly totalCount: number;
  /** Purge ratio. */
  readonly purgeRatio: number;
}

/**
 * Purge training samples whose label windows overlap with validation/test.
 *
 * A sample at time T with horizon H has label window [T, T+H].
 * If this window overlaps with the validation window [valStart, ...],
 * the sample is purged because its label depends on data from the
 * validation period.
 *
 * Deterministic: same inputs → same purge result, always.
 */
export function purgeOverlappingLabels(input: PurgeInput): PurgeResult {
  const { timestamps, labelHorizonMs, valStartMs } = input;
  const testStartMs = input.testStartMs ?? Infinity;

  const safeIndices: number[] = [];
  const purgedIndices: number[] = [];

  for (let i = 0; i < timestamps.length; i++) {
    const labelEnd = timestamps[i] + labelHorizonMs;

    // Check overlap with validation window: if label end exceeds val start, label depends on val data
    const overlapsVal = labelEnd > valStartMs;
    // Check overlap with test window
    const overlapsTest = testStartMs < Infinity && labelEnd > testStartMs;

    if (overlapsVal || overlapsTest) {
      purgedIndices.push(i);
    } else {
      safeIndices.push(i);
    }
  }

  return {
    version: PURGE_VERSION,
    safeIndices,
    purgedIndices,
    purgedCount: purgedIndices.length,
    totalCount: timestamps.length,
    purgeRatio: timestamps.length > 0 ? purgedIndices.length / timestamps.length : 0,
  };
}

/**
 * Verify that purging was successful: no safe sample's label window
 * overlaps with the validation period.
 */
export function verifyPurgeSuccess(
  purgeResult: PurgeResult,
  timestamps: readonly number[],
  labelHorizonMs: number,
  valStartMs: number,
): { valid: boolean; violations: number[] } {
  const violations: number[] = [];
  for (const idx of purgeResult.safeIndices) {
    const labelEnd = timestamps[idx] + labelHorizonMs;
    if (labelEnd > valStartMs) {
      violations.push(idx);
    }
  }
  return { valid: violations.length === 0, violations };
}
