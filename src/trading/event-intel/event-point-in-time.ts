/**
 * Event Point-in-Time — Leakage detection for event intelligence.
 *
 * Ensures that decisions at time T only use information available at T.
 * Detects:
 *   - Future information leakage (using T+1 data at T)
 *   - Revision leakage (using T+2 revisions at T)
 *   - Duplicate headline leakage (same headline counted twice)
 *   - Timestamp normalization (source time vs server time)
 *
 * All functions are PURE.
 */

import { EventRawRecord, EventOntology, SourceTier } from './event-types';
import { computeCanonicalEventId } from './event-versioning';

// ── Types ───────────────────────────────────────────────────────────────────

export interface PITCheckInput {
  /** Timestamp of the decision point (ms). */
  readonly decisionTimeMs: number;
  /** Available raw records at decision time. */
  readonly availableRecords: readonly EventRawRecord[];
  /** All records including future ones (for testing leakage). */
  readonly allRecords: readonly EventRawRecord[];
  /** The event ontology. */
  readonly ontology: EventOntology;
}

export interface PITCheckResult {
  /** Whether the check passed (no leakage). */
  readonly passed: boolean;
  /** Number of leaked records detected. */
  readonly leakedCount: number;
  /** IDs of leaked records. */
  readonly leakedRecordIds: readonly string[];
  /** Whether duplicate headline leakage was detected. */
  readonly duplicateHeadlineDetected: boolean;
  /** Normalized timestamps (source → server mapping). */
  readonly timestampNormalization: ReadonlyArray<{
    readonly sourceId: string;
    readonly sourceTimeMs: number;
    readonly serverTimeMs: number;
    readonly deltaMs: number;
  }>;
}

// ── Pure functions ──────────────────────────────────────────────────────────

/**
 * Normalize a source timestamp. Maps source-published time to a
 * canonical server time, preserving the original for audit.
 */
export function normalizeTimestamp(
  sourcePublishedAt: number,
  receivedAt: number,
  processedAt: number,
): { sourceTimeMs: number; serverTimeMs: number; deltaMs: number } {
  // Server time is when the system processed it; source time is when it was published
  const serverTimeMs = processedAt;
  const sourceTimeMs = sourcePublishedAt;
  return {
    sourceTimeMs,
    serverTimeMs,
    deltaMs: serverTimeMs - sourceTimeMs,
  };
}

/**
 * Check for point-in-time leakage.
 * Only records with sourcePublishedAt <= decisionTimeMs should be available.
 */
export function checkPITLeakage(input: PITCheckInput): PITCheckResult {
  // Records that should be available (published before or at decision time)
  const legitimateRecords = input.allRecords.filter(
    (r) => r.sourcePublishedAt <= input.decisionTimeMs,
  );

  // Records that leaked (published after decision time but present in available)
  const leakedRecords = input.availableRecords.filter(
    (r) => r.sourcePublishedAt > input.decisionTimeMs,
  );

  // Duplicate headline detection: same canonical ID from different sources
  const canonicalIds = new Map<string, string[]>();
  for (const r of input.availableRecords) {
    const id = computeCanonicalEventId(r, input.ontology);
    if (!canonicalIds.has(id)) canonicalIds.set(id, []);
    canonicalIds.get(id)!.push(r.sourceId);
  }

  const duplicateHeadlineDetected = Array.from(canonicalIds.values()).some(
    (ids) => ids.length > 1,
  );

  // Timestamp normalization for all available records
  const timestampNormalization = input.availableRecords.map((r) => ({
    sourceId: r.sourceId,
    sourceTimeMs: r.sourcePublishedAt,
    serverTimeMs: r.processedAt,
    deltaMs: r.processedAt - r.sourcePublishedAt,
  }));

  return {
    passed: leakedRecords.length === 0,
    leakedCount: leakedRecords.length,
    leakedRecordIds: leakedRecords.map((r) => r.sourceId),
    duplicateHeadlineDetected,
    timestampNormalization,
  };
}

/**
 * Check if a revision from the future is being used at an earlier time.
 */
export function checkRevisionLeakage(
  currentVersion: number,
  revisionRecords: readonly EventRawRecord[],
  decisionTimeMs: number,
): { leakageDetected: boolean; futureRevisions: readonly EventRawRecord[] } {
  const futureRevisions = revisionRecords.filter(
    (r) => r.sourcePublishedAt > decisionTimeMs,
  );

  return {
    leakageDetected: futureRevisions.length > 0,
    futureRevisions,
  };
}
