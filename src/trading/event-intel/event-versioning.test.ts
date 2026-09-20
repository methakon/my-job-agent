import {
  calculateEventFingerprint,
  mergeSimilarEvents,
  deduplicateEvents,
  versionEvent,
  computeCanonicalEventId,
  createEvent,
} from './event-versioning';
import {
  EventRawRecord,
  EventLifecycle,
  SourceTier,
} from './event-types';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeRecord(
  overrides: Partial<EventRawRecord> & Pick<EventRawRecord, 'title' | 'sourceType'>,
): EventRawRecord {
  const now = Date.now();
  return {
    sourceId: overrides.sourceId ?? 'test-source',
    sourceName: overrides.sourceName ?? 'Test Source',
    sourceTier: overrides.sourceTier ?? ('TIER2_MARKET_DATA' as SourceTier),
    sourceUrl: overrides.sourceUrl ?? 'https://example.com',
    sourcePublishedAt: overrides.sourcePublishedAt ?? (now - 1000),
    sourceUpdatedAt: overrides.sourceUpdatedAt ?? 0,
    receivedAt: overrides.receivedAt ?? (now - 500),
    processedAt: overrides.processedAt ?? now,
    title: overrides.title,
    body: overrides.body ?? overrides.title,
    sourceType: overrides.sourceType,
    language: overrides.language ?? 'en',
    rawPayloadHash: overrides.rawPayloadHash ?? 'hash-default',
    eventFingerprint: overrides.eventFingerprint ?? '',
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Event Versioning — Deduplication and Versioning', () => {
  describe('canonicalEventId', () => {
    it('duplicate headline from same source → same canonicalEventId', () => {
      const r1 = makeRecord({
        title: 'RBI keeps repo rate unchanged at 6.5%',
        sourceType: 'press_release',
      });
      const r2 = makeRecord({
        title: 'RBI keeps repo rate unchanged at 6.5%',
        sourceType: 'press_release',
      });

      const id1 = computeCanonicalEventId(r1, 'MACRO');
      const id2 = computeCanonicalEventId(r2, 'MACRO');

      expect(id1).toBe(id2);
      expect(id1).toMatch(/^EVT-/);
    });

    it('duplicate headline from different sources (Reuters, syndicated copy) → same canonicalEventId, both observations preserved', () => {
      const r1 = makeRecord({
        title: 'RBI keeps repo rate unchanged at 6.5%',
        sourceType: 'news_wire',
        sourceName: 'Reuters',
      });
      const r2 = makeRecord({
        title: 'RBI keeps repo rate unchanged at 6.5%',
        sourceType: 'news_wire',
        sourceName: 'Syndicated Copy',
      });

      const id1 = computeCanonicalEventId(r1, 'MACRO');
      const id2 = computeCanonicalEventId(r2, 'MACRO');

      expect(id1).toBe(id2);

      // Deduplication preserves both observations
      const events = deduplicateEvents([r1, r2]);
      expect(events.length).toBe(1);
      expect(events[0].versions[0].evidence.length).toBe(2);
      expect(events[0].versions[0].evidence[0].rawRecord.sourceName).toBe('Reuters');
      expect(events[0].versions[0].evidence[1].rawRecord.sourceName).toBe('Syndicated Copy');
    });

    it('similar but distinct headlines → different canonicalEventIds', () => {
      const r1 = makeRecord({
        title: 'RBI keeps repo rate unchanged at 6.5%',
        sourceType: 'press_release',
      });
      const r2 = makeRecord({
        title: 'RBI raises repo rate by 25 bps to 6.75%',
        sourceType: 'press_release',
      });

      const id1 = computeCanonicalEventId(r1, 'MACRO');
      const id2 = computeCanonicalEventId(r2, 'MACRO');

      expect(id1).not.toBe(id2);
    });

    it('old event (same title, older timestamp) → deduplicated', () => {
      const r1 = makeRecord({
        title: 'RBI keeps repo rate unchanged at 6.5%',
        sourceType: 'press_release',
        sourcePublishedAt: Date.now() - 86400000,
        processedAt: Date.now() - 86400000 + 1000,
      });
      const r2 = makeRecord({
        title: 'RBI keeps repo rate unchanged at 6.5%',
        sourceType: 'press_release',
        sourcePublishedAt: Date.now() - 3600000,
        processedAt: Date.now(),
      });

      const events = deduplicateEvents([r1, r2]);
      expect(events.length).toBe(1);
    });
  });

  describe('version creation', () => {
    it('old versions preserved when new evidence arrives', () => {
      const r1 = makeRecord({
        title: 'RBI keeps repo rate unchanged at 6.5%',
        sourceType: 'press_release',
        sourceName: 'Reuters',
        sourceId: 'reuters-1',
        sourcePublishedAt: Date.now() - 86400000,
      });

      const event = createEvent(r1, 'MACRO', Date.now());
      expect(event.versions.length).toBe(1);

      const r2 = makeRecord({
        title: 'RBI keeps repo rate unchanged at 6.5%',
        sourceType: 'news_wire',
        sourceName: 'Bloomberg',
        sourceId: 'bloomberg-1',
        sourcePublishedAt: Date.now() - 3600000,
      });

      const evidence = {
        rawRecord: r2,
        addedAtMs: r2.processedAt,
        sourceTier: 'TIER2_MARKET_DATA' as SourceTier,
      };

      const updated = versionEvent(event, evidence);
      expect(updated.versions.length).toBe(2);
      expect(updated.versions[0].evidence.length).toBe(1);
      expect(updated.versions[1].evidence.length).toBe(2);
      expect(updated.versions[1].reasonCode).toContain('BLOOMBERG');
    });
  });

  describe('fingerprint determinism', () => {
    it('same input → same output', () => {
      const fp1 = calculateEventFingerprint('Fed raises rates', 'The Fed raised rates by 25 bps', 'press_release');
      const fp2 = calculateEventFingerprint('Fed raises rates', 'The Fed raised rates by 25 bps', 'press_release');

      expect(fp1).toBe(fp2);
      expect(fp1).toMatch(/^[0-9a-f]{8}$/);
    });

    it('different input → different output', () => {
      const fp1 = calculateEventFingerprint('Fed raises rates', 'The Fed raised rates by 25 bps', 'press_release');
      const fp2 = calculateEventFingerprint('Fed cuts rates', 'The Fed cut rates by 25 bps', 'press_release');

      expect(fp1).not.toBe(fp2);
    });

    it('case/whitespace differences → same fingerprint (normalized)', () => {
      const fp1 = calculateEventFingerprint('Fed  RAISES  rates', 'body text', 'press_release');
      const fp2 = calculateEventFingerprint('Fed raises rates', 'body text', 'press_release');

      expect(fp1).toBe(fp2);
    });
  });

  describe('mergeSimilarEvents', () => {
    it('exact match → true', () => {
      const r1 = makeRecord({
        title: 'RBI keeps repo rate unchanged at 6.5%',
        sourceType: 'press_release',
        eventFingerprint: 'abc123',
        rawPayloadHash: 'hash1',
      });
      const r2 = makeRecord({
        title: 'RBI keeps repo rate unchanged at 6.5%',
        sourceType: 'press_release',
        eventFingerprint: 'abc123',
        rawPayloadHash: 'hash1',
      });

      expect(mergeSimilarEvents(r1, r2)).toBe(true);
    });

    it('different event types → false', () => {
      const r1 = makeRecord({
        title: 'RBI keeps repo rate unchanged at 6.5%',
        sourceType: 'press_release',
        eventFingerprint: 'abc123',
        rawPayloadHash: 'hash1',
      });
      const r2 = makeRecord({
        title: 'Nifty hits all-time high',
        sourceType: 'data_release',
        eventFingerprint: 'xyz789',
        rawPayloadHash: 'hash2',
      });

      expect(mergeSimilarEvents(r1, r2)).toBe(false);
    });

    it('compatible source types with same title → true', () => {
      const r1 = makeRecord({
        title: 'RBI keeps repo rate unchanged',
        sourceType: 'press_release',
        eventFingerprint: 'fp1',
        rawPayloadHash: 'h1',
      });
      const r2 = makeRecord({
        title: 'RBI keeps repo rate unchanged',
        sourceType: 'official_statement',
        eventFingerprint: 'fp2',
        rawPayloadHash: 'h2',
      });

      expect(mergeSimilarEvents(r1, r2)).toBe(true);
    });

    it('incompatible source types with same title → false', () => {
      const r1 = makeRecord({
        title: 'Some event title here',
        sourceType: 'press_release',
        eventFingerprint: 'fp1',
        rawPayloadHash: 'h1',
      });
      const r2 = makeRecord({
        title: 'Some event title here',
        sourceType: 'social_media',
        eventFingerprint: 'fp2',
        rawPayloadHash: 'h2',
      });

      expect(mergeSimilarEvents(r1, r2)).toBe(false);
    });
  });

  describe('deduplicateEvents', () => {
    it('empty input → empty output', () => {
      expect(deduplicateEvents([])).toEqual([]);
    });

    it('single event → single canonical event', () => {
      const r = makeRecord({
        title: 'Single event',
        sourceType: 'press_release',
      });

      const events = deduplicateEvents([r]);
      expect(events.length).toBe(1);
      expect(events[0].currentState).toBe('S0_DETECTED');
    });

    it('multiple duplicates → single canonical event', () => {
      const records = Array.from({ length: 5 }, (_, i) =>
        makeRecord({
          title: 'RBI keeps repo rate unchanged at 6.5%',
          sourceType: 'press_release',
          sourceName: `Source ${i}`,
          eventFingerprint: 'same-fp',
          rawPayloadHash: 'same-hash',
        })
      );

      const events = deduplicateEvents(records);
      expect(events.length).toBe(1);
      expect(events[0].versions[0].evidence.length).toBe(5);
    });

    it('distinct events → separate canonical events', () => {
      const r1 = makeRecord({ title: 'Event A', sourceType: 'press_release', rawPayloadHash: 'hash-a', eventFingerprint: 'fp-a' });
      const r2 = makeRecord({ title: 'Event B', sourceType: 'press_release', rawPayloadHash: 'hash-b', eventFingerprint: 'fp-b' });

      const events = deduplicateEvents([r1, r2]);
      expect(events.length).toBe(2);
    });
  });
});
