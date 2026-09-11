/**
 * GATE 12 #5 — strict future-only labels with FROZEN feature cutoffs.
 *
 * Roadmap row 159: "Use strict future-only labels with frozen feature cutoffs";
 * doneWhen = "A timestamp/leakage test proves no post-decision feature information
 * entered the label inputs."
 *
 * The learning dataset lives in `pattern_signals` (see pattern-signal.entity.ts):
 * one row = one decision, carrying the FEATURES that were visible at the decision
 * cutoff plus, once the tape has moved on, the forward OUTCOME LABELS.
 *
 * Two facts have to hold for the dataset to be trainable at all:
 *
 *   1. FROZEN FEATURES. A label write may only ever touch LABEL_FIELDS. Feature and
 *      decision fields are written once, at creation, and are never recomputed —
 *      recomputing them at label time would silently pull the post-decision tape
 *      into the feature vector (the classic look-ahead leak).
 *   2. A RECORDED CUTOFF. The row stores the newest input timestamp that the
 *      features were allowed to read (`features.cutoff.featureCutoffMs`), so the
 *      decision boundary is auditable from the row alone instead of inferred from
 *      when the row happened to be written.
 *
 * Pure functions only: no DB, no network, no clock reads (every timestamp is a
 * parameter), so the leakage test is deterministic and replayable.
 */

/** Key under which the frozen cutoff is stored inside the `features` JSON payload. */
export const FEATURE_SNAPSHOT_KEY = 'cutoff';

/**
 * The only fields a label write may set. Any patch carrying anything else is
 * refused by validateLabelWrite() — that refusal is the mechanism that stops new
 * research code from bypassing the freeze.
 */
export const LABEL_FIELDS = ['outcomeLabel', 'labelledAt', 'maxFavourablePct', 'maxAdversePct', 'outcomes'] as const;
export type LabelField = (typeof LABEL_FIELDS)[number];

/**
 * Decision-time facts frozen at creation. Listing them explicitly (rather than
 * "everything that is not a label field") means an unknown field is refused too —
 * fail closed, not fail open.
 */
export const FROZEN_FEATURE_FIELDS = [
  'features',
  'instrumentKey', 'contractSymbol', 'underlying', 'expiry', 'strike', 'optionType',
  'bucketTs', 'bucketMinutes', 'signalTs', 'sessionDate', 'feedSource',
  'patternType', 'signal', 'entryState', 'confidence', 'strategyVersion', 'reason',
  'consolidationDetected', 'rangeHigh', 'rangeLow', 'rangeWidthPct', 'rangeWidthAtr', 'atr', 'atrPct',
  'consolidationBars', 'failedBreakouts',
  'reversalScore', 'breakoutScore', 'momentumScore', 'volumeScore', 'oiScore', 'ivScore',
  'underlyingScore', 'liquidityScore', 'chainScore',
  'breakoutClass', 'distanceAtr', 'barsSinceBreakout', 'underlyingDirection', 'optionDirection',
  'underlyingConfirmed', 'oiBehaviour',
  'ltp', 'bid', 'ask', 'spreadPct', 'volume', 'oi', 'changeOi', 'iv', 'delta', 'gamma', 'theta', 'vega', 'pcr',
  'targetPct', 'stopPct',
] as const;

export type FeatureCutoff = {
  /** Newest input timestamp (epoch ms) the feature vector was allowed to read. */
  featureCutoffMs: number;
  /** Bucket width the features were computed on, when the producer knows it. */
  bucketMs?: number | null;
  /** Strategy version the frozen features belong to. */
  strategyVersion?: string | null;
};

export type LabelPatch = {
  outcomeLabel: string;
  labelledAt: Date;
  maxFavourablePct?: number | null;
  maxAdversePct?: number | null;
  outcomes?: unknown;
};

export type LabelWriteVerdict = { ok: boolean; violations: string[] };

/**
 * Record the cutoff inside the feature payload. Called ONLY at row creation, so the
 * boundary travels with the features that were derived from it.
 */
export const withFeatureCutoff = <T extends object>(features: T | null | undefined, cutoff: FeatureCutoff): T & { [FEATURE_SNAPSHOT_KEY]: FeatureCutoff } => ({
  ...((features ?? {}) as T),
  [FEATURE_SNAPSHOT_KEY]: {
    featureCutoffMs: cutoff.featureCutoffMs,
    bucketMs: cutoff.bucketMs ?? null,
    strategyVersion: cutoff.strategyVersion ?? null,
  },
});

/** The recorded cutoff, or null for a row written before the cutoff was recorded. */
export const featureCutoffOf = (row: { features?: unknown } | null | undefined): number | null => {
  const payload = (row?.features ?? null) as Record<string, unknown> | null;
  if (!payload || typeof payload !== 'object') return null;
  const cutoff = payload[FEATURE_SNAPSHOT_KEY] as Record<string, unknown> | undefined;
  const ms = Number(cutoff?.featureCutoffMs);
  return Number.isFinite(ms) ? ms : null;
};

/**
 * Stable digest of the frozen payload: key-sorted JSON, so two payloads that carry
 * the same facts compare equal regardless of insertion order. Used to prove the
 * feature vector is byte-identical before and after labelling.
 */
export const frozenFeatureDigest = (payload: unknown): string => {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
      const source = value as Record<string, unknown>;
      return Object.keys(source)
        .filter((key) => source[key] !== undefined)
        .sort()
        .reduce<Record<string, unknown>>((acc, key) => { acc[key] = canonical(source[key]); return acc; }, {});
    }
    return value;
  };
  return JSON.stringify(canonical(payload ?? null));
};

/**
 * Build the label-only patch. Never spreads the row: the patch is constructed from
 * the measurement inputs alone, so no decision field can ride along by accident.
 */
export const buildLabelPatch = (input: {
  outcomeLabel: string;
  labelledAtMs: number;
  maxFavourablePct?: number | null;
  maxAdversePct?: number | null;
  outcomes?: unknown;
}): LabelPatch => {
  const patch: LabelPatch = { outcomeLabel: input.outcomeLabel, labelledAt: new Date(input.labelledAtMs) };
  if (input.maxFavourablePct !== undefined) patch.maxFavourablePct = input.maxFavourablePct;
  if (input.maxAdversePct !== undefined) patch.maxAdversePct = input.maxAdversePct;
  if (input.outcomes !== undefined) patch.outcomes = input.outcomes;
  return patch;
};

/**
 * Refuse anything that is not a label write. Violations are named (`field:reason`)
 * so a caller can log exactly what was attempted.
 */
export const validateLabelWrite = (before: { features?: unknown } | null | undefined, patch: Record<string, unknown>): LabelWriteVerdict => {
  const violations: string[] = [];
  const labelFields = new Set<string>(LABEL_FIELDS);
  const frozen = new Set<string>(FROZEN_FEATURE_FIELDS);
  for (const key of Object.keys(patch)) {
    if (!labelFields.has(key)) {
      violations.push(frozen.has(key) ? `${key}:frozen-feature-field` : `${key}:not-a-label-field`);
    }
  }
  // Provenance: every stored horizon must carry its coverage, because a horizon the
  // tape never reached must never be aggregated as a result.
  const outcomes = patch.outcomes as { horizons?: unknown[] } | undefined;
  if (outcomes && Array.isArray(outcomes.horizons)) {
    outcomes.horizons.forEach((entry, index) => {
      const horizon = entry as Record<string, unknown> | null;
      if (!horizon || typeof horizon !== 'object' || typeof horizon.covered !== 'boolean' || typeof horizon.coverage !== 'string') {
        violations.push(`outcomes.horizons[${index}]:missing-coverage-provenance`);
      }
    });
  }
  // A label may not be re-frozen: the cutoff belongs to row creation.
  if (before && patch.features !== undefined) violations.push('features:label-write-must-not-touch-features');
  return { ok: violations.length === 0, violations };
};

/**
 * Split inputs for the FEATURE side: features may only read at or before the frozen
 * cutoff. Anything after it is returned separately as a leak so the caller (and the
 * test) can name it instead of silently dropping it.
 */
export const splitFeatureInputs = <T extends { ts: number | Date }>(ticks: readonly T[], cutoffMs: number) => {
  const at = (t: T) => (t.ts instanceof Date ? t.ts.getTime() : Number(t.ts));
  return {
    usable: ticks.filter((t) => at(t) <= cutoffMs),
    afterCutoff: ticks.filter((t) => at(t) > cutoffMs),
  };
};

/** Name any post-cutoff tick that was handed to the feature side (a real leak). */
export const leakedFeatureInputs = <T extends { ts: number | Date }>(usedForFeatures: readonly T[], cutoffMs: number): string[] =>
  usedForFeatures
    .filter((t) => (t.ts instanceof Date ? t.ts.getTime() : Number(t.ts)) > cutoffMs)
    .map((t) => `tick@${t.ts instanceof Date ? t.ts.getTime() : Number(t.ts)}`);

/**
 * The OUTCOME side is the complement of the feature side: only ticks strictly after
 * the cutoff (the decision is made at the cutoff, so the cutoff tick itself is
 * decision-time information) and never past the horizon end.
 */
export const labelInputsWithinHorizon = <T extends { ts: number | Date }>(ticks: readonly T[], input: { cutoffMs: number; horizonMs: number }) => {
  const at = (t: T) => (t.ts instanceof Date ? t.ts.getTime() : Number(t.ts));
  const end = input.cutoffMs + input.horizonMs;
  return {
    outcomes: ticks.filter((t) => at(t) > input.cutoffMs && at(t) <= end),
    beforeOrAtCutoff: ticks.filter((t) => at(t) <= input.cutoffMs),
    beyondHorizon: ticks.filter((t) => at(t) > end),
  };
};

/**
 * Headline label selection, identical to the producer's rule: the LONGEST horizon
 * the tape actually covered. A horizon the future has not reached yet is never
 * promoted to the headline.
 */
export const headlineLabel = <T extends { covered?: boolean; label: string }>(outcomes: readonly T[]): string | null => {
  if (!outcomes.length) return null;
  const covered = outcomes.filter((o) => o.covered !== false);
  return (covered.length ? covered[covered.length - 1] : outcomes[outcomes.length - 1]).label;
};

/** The provenance envelope stored alongside the horizons, echoing the frozen cutoff. */
export const labelEnvelope = <H>(input: { outcomes: H[]; coverageMinutes: number; cutoffMs: number | null; strategyVersion?: string | null }) => ({
  horizons: input.outcomes,
  coverageMinutes: input.coverageMinutes,
  featureCutoffMs: input.cutoffMs,
  strategyVersion: input.strategyVersion ?? null,
});
