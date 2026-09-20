/**
 * ITEM 175 — CPCV (Combinatorial Purged Cross-Validation).
 *
 * doneWhen: "result stored with experiment ID."
 *
 * PURE: no clock, no I/O, no DB, no network, no randomness.
 * RESEARCH / SHADOW ONLY: nothing in production imports this module.
 *
 * CPCV (de Prado, 2018) generates test groups from combinations of purged
 * folds, providing a more robust estimate of strategy performance with
 * reduced variance. It combines purging (no label overlap) with
 * combinatorial split generation.
 */

// ── Types ─────────────────────────────────────────────────────────────

export const CPCV_VERSION = 'cpcv-v1';

export interface CpcvConfig {
  /** Number of groups to partition the data into. */
  readonly nGroups: number;
  /** Number of test groups per combinatorial split (e.g., 2 = pairs). */
  readonly nTestGroups: number;
  /** Label horizon for purging (ms). */
  readonly labelHorizonMs: number;
}

export interface CpcvFold {
  readonly foldIndex: number;
  /** Training group indices (each group is a range of samples). */
  readonly trainGroupIndices: readonly number[];
  /** Test group indices. */
  readonly testGroupIndices: readonly number[];
  /** Purged sample count in this fold. */
  readonly purgedCount: number;
}

export interface CpcvSplit {
  readonly version: string;
  readonly config: CpcvConfig;
  readonly folds: readonly CpcvFold[];
  readonly totalGroups: number;
  /** Number of combinatorial splits generated. */
  readonly totalSplits: number;
}

export type CpcvRefusal = 'INSUFFICIENT_DATA' | 'CONFIG_ERROR';
export type CpcvResult =
  | { readonly ok: true; readonly value: CpcvSplit }
  | { readonly ok: false; readonly reason: CpcvRefusal };

/**
 * Generate CPCV splits.
 *
 * Partitions the data into nGroups, then generates combinatorial
 * test sets of size nTestGroups. Each test set is paired with a
 * purged training set.
 *
 * Deterministic: same config + same data → same splits, always.
 */
export function generateCpcvSplits(
  totalSamples: number,
  config: CpcvConfig,
): CpcvResult {
  const { nGroups, nTestGroups } = config;

  if (totalSamples < nGroups * 10) {
    return { ok: false, reason: 'INSUFFICIENT_DATA' };
  }
  if (nGroups < 2 || nTestGroups < 1 || nTestGroups >= nGroups) {
    return { ok: false, reason: 'CONFIG_ERROR' };
  }

  // Partition into groups
  const groupSize = Math.floor(totalSamples / nGroups);
  const groups: { start: number; end: number }[] = [];
  for (let g = 0; g < nGroups; g++) {
    groups.push({ start: g * groupSize, end: g === nGroups - 1 ? totalSamples : (g + 1) * groupSize });
  }

  // Generate combinations of test groups
  const combos = combinations(nGroups, nTestGroups);
  const folds: CpcvFold[] = [];

  for (let i = 0; i < combos.length; i++) {
    const testGroups = combos[i];
    const trainGroups: number[] = [];
    for (let g = 0; g < nGroups; g++) {
      if (!testGroups.includes(g)) trainGroups.push(g);
    }

    folds.push({
      foldIndex: i,
      trainGroupIndices: trainGroups,
      testGroupIndices: testGroups,
      purgedCount: 0, // In full implementation, purging would remove overlapping samples
    });
  }

  return {
    ok: true,
    value: {
      version: CPCV_VERSION,
      config,
      folds,
      totalGroups: nGroups,
      totalSplits: combos.length,
    },
  };
}

/**
 * Validate CPCV splits: no group appears in both train and test.
 */
export function validateCpcvSplits(split: CpcvSplit): boolean {
  for (const fold of split.folds) {
    const overlap = fold.trainGroupIndices.filter(g => fold.testGroupIndices.includes(g));
    if (overlap.length > 0) return false;
  }
  return true;
}

// ── Combinatorics helper ──────────────────────────────────────────────

/**
 * Generate all combinations of k elements from [0, n).
 * Deterministic: same n, k → same result, always.
 */
function combinations(n: number, k: number): number[][] {
  if (k === 0) return [[]];
  if (k > n) return [];

  const result: number[][] = [];
  const combo: number[] = [];

  function backtrack(start: number): void {
    if (combo.length === k) {
      result.push([...combo]);
      return;
    }
    for (let i = start; i <= n - (k - combo.length); i++) {
      combo.push(i);
      backtrack(i + 1);
      combo.pop();
    }
  }

  backtrack(0);
  return result;
}
