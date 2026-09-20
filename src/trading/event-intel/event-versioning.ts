/**
 * Event Versioning — Pure Functions for Deduplication and Versioning
 *
 * All functions are PURE: same inputs → same outputs, no side effects.
 * No I/O, no DB, no network, no randomness.
 *
 * SAFETY: All individual source observations are preserved for
 * corroboration/audit. Deduplication merges into canonical events
 * but never drops raw records.
 */

import {
  Event,
  EventEvidence,
  EventLifecycle,
  EventOntology,
  EventRawRecord,
  EventVersion,
  SourceTier,
} from './event-types';

// ── Deterministic Fingerprint ────────────────────────────────────────────────

/**
 * Calculate a deterministic fingerprint for an event from its content.
 *
 * PURE: Yes. Deterministic: Yes. Uses only inputs.
 *
 * The fingerprint is used to detect when two different raw records
 * describe the same real-world event. Normalizes text to lowercase,
 * strips punctuation, collapses whitespace, and hashes with sourceType.
 */
export function calculateEventFingerprint(
  title: string,
  body: string,
  sourceType: string,
): string {
  const normalizedTitle = normalizeText(title);
  const normalizedBody = normalizeText(body);
  const payload = `${normalizedTitle}|${normalizedBody}|${sourceType.toLowerCase()}`;
  return deterministicHash(payload);
}

/**
 * Normalize text for fingerprinting: lowercase, strip non-alphanumeric,
 * collapse whitespace, trim. Minor formatting differences don't create
 * separate fingerprints.
 */
function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Deterministic hash: FNV-1a + DJB2 combined, truncated to 16 hex chars.
 * Not cryptographic — used only for fingerprinting/dedup.
 */
function deterministicHash(input: string): string {
  // FNV-1a
  let fnv = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    fnv ^= input.charCodeAt(i);
    fnv = Math.imul(fnv, 0x01000193) >>> 0;
  }
  // DJB2
  let djb = 5381;
  for (let i = 0; i < input.length; i++) {
    djb = ((djb << 5) + djb + input.charCodeAt(i)) >>> 0;
  }
  const combined = ((fnv << 16) | (djb & 0xffff)) >>> 0;
  return combined.toString(16).padStart(8, '0');
}

// ── Canonical Event ID ──────────────────────────────────────────────────────

/**
 * Generate a deterministic canonical event ID from a raw record.
 * Uses date + content hash for stability across reprocessing.
 *
 * PURE: Yes. Deterministic: Yes.
 */
export function computeCanonicalEventId(
  record: EventRawRecord,
  _ontology?: EventOntology,
): string {
  const dateStr = new Date(record.sourcePublishedAt).toISOString().slice(0, 10);
  const hash = deterministicHash(`${record.title}|${record.sourceType}|${dateStr}`);
  return `EVT-${dateStr}-${hash}`;
}

/**
 * Internal alias — same logic as computeCanonicalEventId.
 */
function generateCanonicalEventId(record: EventRawRecord): string {
  return computeCanonicalEventId(record);
}

// ── Merge Similar Events ─────────────────────────────────────────────────────

/**
 * Check whether two raw records describe the same real-world event.
 *
 * PURE: Yes. Deterministic: Yes.
 *
 * Merges when: fingerprints match, OR titles are very similar and
 * source types are compatible. This allows different sources reporting
 * on the same event to be recognized without losing individual observations.
 */
export function mergeSimilarEvents(
  a: EventRawRecord,
  b: EventRawRecord,
): boolean {
  // Same fingerprint → definitely same event
  if (a.eventFingerprint === b.eventFingerprint) {
    return true;
  }

  // Same raw payload hash → identical content
  if (a.rawPayloadHash === b.rawPayloadHash) {
    return true;
  }

  // Cross-source similarity: same normalized title + compatible source types
  const titleA = normalizeText(a.title);
  const titleB = normalizeText(b.title);

  if (titleA === titleB && areCompatibleSourceTypes(a.sourceType, b.sourceType)) {
    return true;
  }

  // Subtitle containment for headlines where one adds detail to the other.
  // Only trigger when titles are DIFFERENT and one strictly contains the other.
  if (titleA !== titleB && titleA.length > 10 && titleB.length > 10) {
    if (titleA.includes(titleB) || titleB.includes(titleA)) {
      return true;
    }
  }

  return false;
}

/**
 * Check if two source types can report on the same event.
 * Press releases, news wires, and data feeds can all report the same thing.
 */
function areCompatibleSourceTypes(a: string, b: string): boolean {
  const compatibleGroups: ReadonlyArray<ReadonlySet<string>> = [
    new Set(['press_release', 'news_wire', 'official_statement', 'regulatory_filing']),
    new Set(['data_release', 'economic_calendar', 'government_data']),
    new Set(['social_media', 'blog', 'forum']),
  ];

  for (const group of compatibleGroups) {
    if (group.has(a) && group.has(b)) {
      return true;
    }
  }
  return false;
}

// ── Event Deduplication ──────────────────────────────────────────────────────

/**
 * Deduplicate a batch of raw records into canonical events.
 *
 * PURE: Yes. Deterministic: Yes.
 *
 * Process:
 * 1. Compute fingerprint for each record
 * 2. Group records with matching fingerprints or similar titles
 * 3. For each group, create a canonical Event with one EventVersion
 * 4. All raw records are preserved in the version's evidence array
 *
 * Returns events sorted by detection time (earliest first).
 */
export function deduplicateEvents(
  events: readonly EventRawRecord[],
): readonly Event[] {
  if (events.length === 0) return [];

  // Compute fingerprints for all records
  const indexed = events.map((record, idx) => ({
    idx,
    record,
    fingerprint: record.eventFingerprint ||
      calculateEventFingerprint(record.title, record.body, record.sourceType),
  }));

  // Union-find for grouping similar events
  const parent = new Map<number, number>();
  for (let i = 0; i < indexed.length; i++) {
    parent.set(i, i);
  }

  function find(x: number): number {
    if (parent.get(x) !== x) {
      parent.set(x, find(parent.get(x)!));
    }
    return parent.get(x)!;
  }

  function union(x: number, y: number): void {
    const rx = find(x);
    const ry = find(y);
    if (rx !== ry) {
      parent.set(rx, ry);
    }
  }

  // Group by fingerprint equality
  const fingerprintIndex = new Map<string, number[]>();
  for (const item of indexed) {
    const existing = fingerprintIndex.get(item.fingerprint);
    if (existing) {
      for (const j of existing) {
        union(item.idx, j);
      }
      existing.push(item.idx);
    } else {
      fingerprintIndex.set(item.fingerprint, [item.idx]);
    }
  }

  // Also merge by pairwise similarity (for cross-source duplicates)
  for (let i = 0; i < events.length; i++) {
    for (let j = i + 1; j < events.length; j++) {
      if (mergeSimilarEvents(events[i], events[j])) {
        union(i, j);
      }
    }
  }

  // Build groups from union-find
  const groups = new Map<number, EventRawRecord[]>();
  for (const item of indexed) {
    const root = find(item.idx);
    const group = groups.get(root);
    if (group) {
      group.push(item.record);
    } else {
      groups.set(root, [item.record]);
    }
  }

  // Create canonical events from groups
  const canonicalEvents: Event[] = [];
  for (const groupRecords of groups.values()) {
    // Sort by sourcePublishedAt to find earliest
    const sorted = [...groupRecords].sort(
      (a, b) => a.sourcePublishedAt - b.sourcePublishedAt,
    );

    const earliest = sorted[0];
    const canonicalId = generateCanonicalEventId(earliest);

    // Build evidence from ALL records (preserves individual observations)
    const evidence: EventEvidence[] = sorted.map((record) => ({
      rawRecord: record,
      addedAtMs: record.processedAt,
      sourceTier: record.sourceTier,
    }));

    // Initial version with all evidence from the group
    const version: EventVersion = {
      version: 1,
      evidence,
      createdAtMs: earliest.processedAt,
      lifecycle: determineInitialLifecycle(sorted),
      reasonCode: 'INITIAL_DETECTION',
    };

    const event: Event = {
      id: canonicalId,
      ontology: 'MACRO', // Will be classified downstream by event-ontology.ts
      lifecycle: version.lifecycle,
      versions: [version],
      currentState: 'S0_DETECTED',
      detectedAtMs: earliest.sourcePublishedAt,
      lastUpdatedAtMs: earliest.processedAt,
    };

    canonicalEvents.push(event);
  }

  // Sort by detection time
  return canonicalEvents.sort((a, b) => a.detectedAtMs - b.detectedAtMs);
}

/**
 * Determine the initial lifecycle from a group of records.
 * If any source is TIER1, it's more likely official.
 */
function determineInitialLifecycle(records: readonly EventRawRecord[]): EventLifecycle {
  const hasTier1 = records.some((r) => r.sourceTier === 'TIER1_AUTHORITATIVE');
  if (hasTier1) return 'OFFICIAL';

  const hasTier2 = records.some((r) => r.sourceTier === 'TIER2_MARKET_DATA');
  if (hasTier2) return 'PRELIMINARY';

  return 'RUMOR';
}

// ── Event Versioning ─────────────────────────────────────────────────────────

/**
 * Create a new version of an event with additional evidence.
 *
 * PURE: Yes. Deterministic: Yes.
 *
 * Preserves all previous versions and evidence. The new version
 * incorporates the new evidence alongside all existing evidence.
 * If the same source provides an update, it replaces (not duplicates)
 * the previous evidence from that source while creating a new version
 * for audit trail purposes.
 */
export function versionEvent(
  event: Event,
  newEvidence: EventEvidence,
): Event {
  const lastVersion = event.versions[event.versions.length - 1];

  // Check if this source already contributed evidence
  const alreadyHasSource = lastVersion.evidence.some(
    (e) => e.rawRecord.sourceId === newEvidence.rawRecord.sourceId,
  );

  if (alreadyHasSource) {
    // Update existing evidence in place, create new version for audit
    const updatedEvidence = lastVersion.evidence.map((e) =>
      e.rawRecord.sourceId === newEvidence.rawRecord.sourceId ? newEvidence : e,
    );

    const updatedVersion: EventVersion = {
      version: lastVersion.version + 1,
      evidence: updatedEvidence,
      createdAtMs: newEvidence.addedAtMs,
      lifecycle: newEvidence.rawRecord.sourceType === 'retraction'
        ? 'RETRACTED'
        : lastVersion.lifecycle,
      reasonCode: `SOURCE_UPDATE_${newEvidence.rawRecord.sourceName.toUpperCase().replace(/\s+/g, '_')}`,
    };

    return {
      ...event,
      versions: [...event.versions, updatedVersion],
      lastUpdatedAtMs: newEvidence.addedAtMs,
    };
  }

  // New source → new version with accumulated evidence from all sources
  const newVersion: EventVersion = {
    version: lastVersion.version + 1,
    evidence: [...lastVersion.evidence, newEvidence],
    createdAtMs: newEvidence.addedAtMs,
    lifecycle: newEvidence.rawRecord.sourceType === 'retraction'
      ? 'RETRACTED'
      : lastVersion.lifecycle,
    reasonCode: `EVIDENCE_FROM_${newEvidence.rawRecord.sourceName.toUpperCase().replace(/\s+/g, '_')}`,
  };

  return {
    ...event,
    versions: [...event.versions, newVersion],
    lifecycle: newVersion.lifecycle,
    lastUpdatedAtMs: newEvidence.addedAtMs,
  };
}

// ── Convenience Constructors ─────────────────────────────────────────────────

/**
 * Create a new Event from a raw record.
 *
 * PURE: Yes. Deterministic: Yes.
 */
export function createEvent(
  record: EventRawRecord,
  ontology: EventOntology,
  nowMs: number,
): Event {
  const canonicalId = computeCanonicalEventId(record, ontology);

  const evidence: EventEvidence = {
    rawRecord: record,
    addedAtMs: record.processedAt,
    sourceTier: record.sourceTier,
  };

  const version: EventVersion = {
    version: 1,
    evidence: [evidence],
    createdAtMs: record.processedAt,
    lifecycle: determineLifecycleFromTier(record.sourceTier),
    reasonCode: 'INITIAL_DETECTION',
  };

  return {
    id: canonicalId,
    ontology,
    lifecycle: version.lifecycle,
    versions: [version],
    currentState: 'S0_DETECTED',
    detectedAtMs: record.sourcePublishedAt,
    lastUpdatedAtMs: nowMs,
  };
}

/**
 * Create a new version of an event (alias for versionEvent with array evidence).
 *
 * PURE: Yes. Deterministic: Yes.
 */
export function createVersion(
  event: Event,
  evidenceArray: EventEvidence[],
  lifecycle: EventLifecycle,
  reasonCode: string,
  nowMs: number,
): Event {
  // Merge all evidence into the last version's evidence
  const lastVersion = event.versions[event.versions.length - 1];
  const mergedEvidence = [...lastVersion.evidence, ...evidenceArray];

  const newVersion: EventVersion = {
    version: lastVersion.version + 1,
    evidence: mergedEvidence,
    createdAtMs: nowMs,
    lifecycle,
    reasonCode,
  };

  return {
    ...event,
    versions: [...event.versions, newVersion],
    lifecycle,
    lastUpdatedAtMs: nowMs,
  };
}

function determineLifecycleFromTier(tier: SourceTier): EventLifecycle {
  switch (tier) {
    case 'TIER1_AUTHORITATIVE':
      return 'OFFICIAL';
    case 'TIER2_MARKET_DATA':
      return 'PRELIMINARY';
    default:
      return 'RUMOR';
  }
}
