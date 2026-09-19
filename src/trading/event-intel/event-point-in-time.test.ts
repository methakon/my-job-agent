import {
  checkPITLeakage,
  normalizeTimestamp,
  checkRevisionLeakage,
  PITCheckInput,
} from './event-point-in-time';
import {
  EventRawRecord,
  EventOntology,
  SourceTier,
} from './event-types';
import { computeCanonicalEventId } from './event-versioning';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeRecord(overrides: Partial<EventRawRecord> & { title: string }): EventRawRecord {
  const now = Date.now();
  return {
    sourceId: overrides.sourceId ?? 'test-source',
    sourceName: overrides.sourceName ?? 'Test Source',
    sourceTier: overrides.sourceTier ?? ('TIER2_MARKET_DATA' as SourceTier),
    sourceType: overrides.sourceType ?? 'press_release',
    sourceUrl: overrides.sourceUrl ?? 'https://example.com',
    sourcePublishedAt: overrides.sourcePublishedAt ?? (now - 1000),
    sourceUpdatedAt: overrides.sourceUpdatedAt ?? 0,
    receivedAt: overrides.receivedAt ?? (now - 900),
    processedAt: overrides.processedAt ?? now,
    body: overrides.body ?? overrides.title,
    title: overrides.title,
    language: overrides.language ?? 'en',
    rawPayloadHash: overrides.rawPayloadHash ?? 'hash-default',
    eventFingerprint: overrides.eventFingerprint ?? '',
  };
}

const TEST_ONTOLOGY: EventOntology = 'MACRO';

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Event Point-in-Time — Leakage Detection', () => {
  const NOW_MS = 1700000000000;

  describe('decision at T with only T-1 info → PASS', () => {
    it('no leakage when all records are before decision time', () => {
      const record = makeRecord({
        title: 'RBI holds rates steady',
        sourcePublishedAt: NOW_MS - 3600000,
        processedAt: NOW_MS - 3000000,
      });

      const input: PITCheckInput = {
        decisionTimeMs: NOW_MS,
        availableRecords: [record],
        allRecords: [record],
        ontology: TEST_ONTOLOGY,
      };

      const result = checkPITLeakage(input);

      expect(result.passed).toBe(true);
      expect(result.leakedCount).toBe(0);
      expect(result.leakedRecordIds).toHaveLength(0);
    });
  });

  describe('decision at T using T+1 info → FAIL', () => {
    it('detects future information leakage', () => {
      const pastRecord = makeRecord({
        title: 'RBI holds rates',
        sourceId: 'past-source',
        sourcePublishedAt: NOW_MS - 3600000,
      });

      const futureRecord = makeRecord({
        title: 'RBI cuts rates by 25bp',
        sourceId: 'future-source',
        sourcePublishedAt: NOW_MS + 3600000, // 1 hour in the future
      });

      const input: PITCheckInput = {
        decisionTimeMs: NOW_MS,
        availableRecords: [pastRecord, futureRecord], // future record shouldn't be here
        allRecords: [pastRecord, futureRecord],
        ontology: TEST_ONTOLOGY,
      };

      const result = checkPITLeakage(input);

      expect(result.passed).toBe(false);
      expect(result.leakedCount).toBe(1);
      expect(result.leakedRecordIds).toContain('future-source');
    });
  });

  describe('revision from T+2 used at T → FAIL', () => {
    it('detects revision leakage', () => {
      const currentRecord = makeRecord({
        title: 'GDP growth 6.5%',
        sourceId: 'current-source',
        sourcePublishedAt: NOW_MS - 7200000,
      });

      const revisionRecord = makeRecord({
        title: 'GDP growth revised to 7.2%',
        sourceId: 'revision-source',
        sourcePublishedAt: NOW_MS + 7200000, // future revision
      });

      const input: PITCheckInput = {
        decisionTimeMs: NOW_MS,
        availableRecords: [currentRecord, revisionRecord],
        allRecords: [currentRecord, revisionRecord],
        ontology: TEST_ONTOLOGY,
      };

      const result = checkPITLeakage(input);

      expect(result.passed).toBe(false);
      expect(result.leakedCount).toBe(1);
      expect(result.leakedRecordIds).toContain('revision-source');
    });

    it('revision from T+2 used at T → checkRevisionLeakage', () => {
      const revisionRecord = makeRecord({
        title: 'GDP growth revised',
        sourceId: 'revision-source',
        sourcePublishedAt: NOW_MS + 7200000, // future
      });

      const result = checkRevisionLeakage(
        1,
        [revisionRecord],
        NOW_MS,
      );

      expect(result.leakageDetected).toBe(true);
      expect(result.futureRevisions).toHaveLength(1);
      expect(result.futureRevisions[0].sourceId).toBe('revision-source');
    });
  });

  describe('duplicate headline leakage detection', () => {
    it('detects same headline from multiple sources', () => {
      const record1 = makeRecord({
        title: 'RBI holds rates steady',
        sourceId: 'reuters',
      });

      const record2 = makeRecord({
        title: 'RBI holds rates steady',
        sourceId: 'syndicated-copy',
      });

      const input: PITCheckInput = {
        decisionTimeMs: NOW_MS,
        availableRecords: [record1, record2],
        allRecords: [record1, record2],
        ontology: TEST_ONTOLOGY,
      };

      const result = checkPITLeakage(input);

      expect(result.duplicateHeadlineDetected).toBe(true);
    });

    it('no duplicate when headlines are different', () => {
      const record1 = makeRecord({
        title: 'RBI holds rates steady',
        sourceId: 'reuters',
      });

      const record2 = makeRecord({
        title: 'RBI cuts rates by 25bp',
        sourceId: 'bloomberg',
      });

      const input: PITCheckInput = {
        decisionTimeMs: NOW_MS,
        availableRecords: [record1, record2],
        allRecords: [record1, record2],
        ontology: TEST_ONTOLOGY,
      };

      const result = checkPITLeakage(input);

      expect(result.duplicateHeadlineDetected).toBe(false);
    });
  });

  describe('timestamp normalization', () => {
    it('preserves source vs server times', () => {
      const record = makeRecord({
        title: 'RBI holds rates',
        sourcePublishedAt: NOW_MS - 10000,
        processedAt: NOW_MS - 5000,
      });

      const input: PITCheckInput = {
        decisionTimeMs: NOW_MS,
        availableRecords: [record],
        allRecords: [record],
        ontology: TEST_ONTOLOGY,
      };

      const result = checkPITLeakage(input);

      expect(result.timestampNormalization).toHaveLength(1);
      expect(result.timestampNormalization[0].sourceTimeMs).toBe(NOW_MS - 10000);
      expect(result.timestampNormalization[0].serverTimeMs).toBe(NOW_MS - 5000);
      expect(result.timestampNormalization[0].deltaMs).toBe(5000);
    });

    it('normalizeTimestamp returns correct mapping', () => {
      const result = normalizeTimestamp(
        NOW_MS - 10000,
        NOW_MS - 8000,
        NOW_MS - 5000,
      );

      expect(result.sourceTimeMs).toBe(NOW_MS - 10000);
      expect(result.serverTimeMs).toBe(NOW_MS - 5000);
      expect(result.deltaMs).toBe(5000);
    });
  });
});
