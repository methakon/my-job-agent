/**
 * ITEM 169 — Walk-forward time-respecting train/validation/test split.
 *
 * doneWhen: "result stored with experiment ID."
 *
 * PURE: no clock, no I/O, no DB, no network, no randomness.
 * RESEARCH / SHADOW ONLY: nothing in production imports this module.
 *
 * Walk-forward validation ensures no future data leaks into training.
 * Each fold trains on a window of past data and validates on the
 * next window, respecting chronological order.
 */

// ── Types ─────────────────────────────────────────────────────────────

export const WALK_FORWARD_VERSION = 'wf-v1';

export interface WalkForwardFold {
  readonly foldIndex: number;
  /** Indices into the original dataset for training. */
  readonly trainIndices: readonly number[];
  /** Indices for validation. */
  readonly valIndices: readonly number[];
  /** Indices for test (optional, if test window is specified). */
  readonly testIndices: readonly number[];
  /** Timestamp range of training data (start, end in ms). */
  readonly trainTimeRange: readonly [number, number];
  /** Timestamp range of validation data. */
  readonly valTimeRange: readonly [number, number];
}

export interface WalkForwardConfig {
  /** Number of training windows (folds). */
  readonly nFolds: number;
  /** Minimum training window size (number of samples). */
  readonly minTrainSize: number;
  /** Validation window size (number of samples). */
  readonly valSize: number;
  /** Test window size (number of samples). 0 = no separate test. */
  readonly testSize: number;
  /** Step size between folds (number of samples). If 0, equals valSize (no gap). */
  readonly stepSize?: number;
}

export interface WalkForwardSplit {
  readonly version: string;
  readonly config: WalkForwardConfig;
  readonly folds: readonly WalkForwardFold[];
  readonly totalSamples: number;
  readonly sampleTimestamps: readonly number[];
}

export type WalkForwardRefusal = 'INSUFFICIENT_DATA' | 'CONFIG_ERROR';
export type WalkForwardResult =
  | { readonly ok: true; readonly value: WalkForwardSplit }
  | { readonly ok: false; readonly reason: WalkForwardRefusal };

/**
 * Generate walk-forward train/validation/test splits.
 *
 * Ensures strict chronological ordering: train < val < test.
 * No future data ever appears in the training set.
 *
 * Deterministic: same config + same timestamps → same splits, always.
 */
export function generateWalkForwardSplits(
  timestamps: readonly number[],
  config: WalkForwardConfig,
): WalkForwardResult {
  const n = timestamps.length;
  const { nFolds, minTrainSize, valSize, testSize } = config;
  const step = config.stepSize ?? valSize;

  if (n < minTrainSize + valSize + testSize) {
    return { ok: false, reason: 'INSUFFICIENT_DATA' };
  }
  if (minTrainSize <= 0 || valSize <= 0 || nFolds <= 0) {
    return { ok: false, reason: 'CONFIG_ERROR' };
  }

  const folds: WalkForwardFold[] = [];

  for (let f = 0; f < nFolds; f++) {
    const trainEnd = minTrainSize + f * step;
    const valEnd = trainEnd + valSize;
    const testEnd = valEnd + testSize;

    if (testEnd > n) break; // Not enough data for this fold

    const trainIndices = Array.from({ length: trainEnd }, (_, i) => i);
    const valIndices = Array.from({ length: valSize }, (_, i) => trainEnd + i);
    const testIndices = testSize > 0
      ? Array.from({ length: testSize }, (_, i) => trainEnd + valSize + i)
      : [];

    folds.push({
      foldIndex: f,
      trainIndices,
      valIndices,
      testIndices,
      trainTimeRange: [timestamps[0], timestamps[trainEnd - 1]],
      valTimeRange: [timestamps[trainEnd], timestamps[valEnd - 1]],
    });
  }

  return {
    ok: true,
    value: {
      version: WALK_FORWARD_VERSION,
      config,
      folds,
      totalSamples: n,
      sampleTimestamps: [...timestamps],
    },
  };
}

/**
 * Validate that a walk-forward split has no temporal leakage.
 * Returns true if all folds respect chronological ordering.
 */
export function validateNoTemporalLeakage(split: WalkForwardSplit): boolean {
  for (const fold of split.folds) {
    const trainMax = Math.max(...fold.trainIndices);
    const valMin = Math.min(...fold.valIndices);
    const valMax = Math.max(...fold.valIndices);
    const testMin = fold.testIndices.length > 0 ? Math.min(...fold.testIndices) : Infinity;

    // Train must come before val, val before test
    if (trainMax >= valMin) return false;
    if (valMax >= testMin) return false;

    // Timestamps must also be monotonically increasing
    if (fold.trainTimeRange[1] >= fold.valTimeRange[0]) return false;
  }
  return true;
}
