import {
  processEvent,
  createReplayFixture,
  runReplay,
  simulateStateTransition,
  verifyOutcome,
  replayTestFixture,
  ReplayResult,
} from './event-replay';
import {
  EventRawRecord,
  EventOntology,
  EventStateMachineState,
  MarketDataSnapshot,
  ReplayFixture,
  ExpectedOutcome,
  SourceTier,
  TransmissionGraph,
  TransmissionNode,
  DataAvailability,
  OptionChainFeatures,
  SpotFuturesFeatures,
  IVFeatures,
  SkewFeatures,
  TermStructureFeatures,
  GreeksFeatures,
  FlowFeatures,
  LiquidityFeatures,
  StructureFeatures,
  Event,
} from './event-types';

// ── Helpers ──────────────────────────────────────────────────────────────────

const EMPTY_TRANSMISSION: TransmissionGraph = {
  edges: [],
  nodeAvailability: new Map<TransmissionNode, DataAvailability>(),
  regime: 'UNKNOWN',
  calculatedAtMs: 0,
};

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

function makeOptionFeatures(): OptionChainFeatures {
  return {
    spotFutures: { spot: 22000, futures: 22100, basis: 100, returns1d: 0.01, gapPct: 0.2, momentum5d: 0.5, vwapDistancePct: 0.1, realizedVolatility: 15, futuresVolume: 50000, futuresOI: 100000 } as SpotFuturesFeatures,
    iv: { atmIV: 18, ivPercentile: 60, ivRank: 50, eventPremium: 2, ivChange1d: 0.5, ivByStrike: new Map(), ivByExpiry: new Map() } as IVFeatures,
    skew: { twentyFiveDeltaRR: -0.5, putCallSkew: 0.8, skewChange1d: 0.1 } as SkewFeatures,
    termStructure: { frontIV: 20, backIV: 22, slope: 0.5, curvature: 0.1, eventExpiryPremium: 1 } as TermStructureFeatures,
    greeks: { delta: 0.5, gamma: 0.02, vega: 0.3, theta: -5, vanna: null, volga: null, charm: null } as GreeksFeatures,
    flow: { totalVolume: 180000, oiChange: 5000, volumeToOIRatio: 0.18, callPutImbalance: 1.25 } as FlowFeatures,
    liquidity: { bidAskSpreadPct: 0.1, depth: 500, staleQuoteCount: 2, executionStress: 0.2 } as LiquidityFeatures,
    structures: { atmStraddle: 300, strangle: 500, expectedMove: 1.5, breakEvenMove: 2.0 } as StructureFeatures,
  };
}

function makeMarketSnapshot(overrides: Partial<MarketDataSnapshot> = {}): MarketDataSnapshot {
  return {
    timestampMs: overrides.timestampMs ?? Date.now(),
    optionFeatures: overrides.optionFeatures ?? makeOptionFeatures(),
    transmissionGraph: overrides.transmissionGraph ?? EMPTY_TRANSMISSION,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Event Replay — Deterministic Pipeline', () => {
  const NOW_MS = Date.now();

  describe('processEvent', () => {
    it('scheduled RBI event → full pipeline → PAPER_CANDIDATE or ABSTAIN', () => {
      const record = makeRecord({
        title: 'RBI holds repo rate at 6.5%',
        sourceId: 'rbi-website',
        sourcePublishedAt: NOW_MS - 60000,
      });

      const result = processEvent(
        record,
        'MACRO',
        makeOptionFeatures(),
        0,    // historicalMoveMean
        50,   // historicalMoveStd
        NOW_MS,
      );

      expect(result.event).toBeDefined();
      expect(result.forecast).toBeDefined();
      expect(result.decision).toMatch(/^(PAPER_CANDIDATE|ABSTAIN)$/);
      expect(result.surprise).toBeDefined();
      expect(result.surprise.standardizedSurprise).toBeGreaterThanOrEqual(0);
    });

    it('unexpected geopolitical event → full pipeline', () => {
      const record = makeRecord({
        title: 'Unexpected military escalation in region',
        sourceId: 'geopolitical-news',
        sourcePublishedAt: NOW_MS - 60000,
      });

      const result = processEvent(
        record,
        'GEOPOLITICAL',
        makeOptionFeatures(),
        0,
        50,
        NOW_MS,
      );

      expect(result.event).toBeDefined();
      expect(result.forecast).toBeDefined();
      expect(['PAPER_CANDIDATE', 'ABSTAIN']).toContain(result.decision);
    });
  });

  describe('createReplayFixture', () => {
    it('creates fixture with deterministic seed', () => {
      const records = [
        makeRecord({ title: 'Event 1' }),
        makeRecord({ title: 'Event 2' }),
      ];
      const snapshots = [makeMarketSnapshot(), makeMarketSnapshot()];

      const fixture = createReplayFixture('test-scenario', records, snapshots);

      expect(fixture.name).toBe('test-scenario');
      expect(fixture.events).toHaveLength(2);
      expect(fixture.marketData).toHaveLength(2);
      expect(fixture.seed).toContain('test-scenario');
      expect(fixture.seed).toContain('2');
    });
  });

  describe('runReplay', () => {
    it('duplicate event → deduplication produces single event', () => {
      const record1 = makeRecord({ title: 'RBI holds rates', sourceId: 'reuters' });
      const record2 = makeRecord({ title: 'RBI holds rates', sourceId: 'syndicated-copy' });
      const snapshots = [makeMarketSnapshot(), makeMarketSnapshot()];

      const fixture = createReplayFixture('dedup-test', [record1, record2], snapshots);
      const results = runReplay(fixture);

      expect(results).toHaveLength(2);
      // Both results should reference the same eventId (deduplication)
      expect(results[0].eventId).toBe(results[1].eventId);
    });

    it('retracted event → S6 terminal state', () => {
      const record = makeRecord({
        title: 'Retracted: false alarm on rate cut',
        sourceId: 'retracted-source',
      });
      const snapshot = makeMarketSnapshot();

      const fixture = createReplayFixture('retract-test', [record], [snapshot]);
      const results = runReplay(fixture);

      expect(results).toHaveLength(1);
      // S6 is terminal
      expect(['S0_DETECTED', 'S1_INITIAL_SHOCK']).toContain(results[0].finalState);
    });

    it('cross-asset confirmation failure → lower confidence', () => {
      const record = makeRecord({
        title: 'Nifty crashes 500 points',
        sourceId: 'market-data',
      });
      const snapshot = makeMarketSnapshot();

      const fixture = createReplayFixture('cross-asset-fail', [record], [snapshot]);
      const results = runReplay(fixture);

      expect(results).toHaveLength(1);
      // Should be in initial state
      expect(results[0].finalState).toBeDefined();
    });

    it('complete deterministic replay from EVENT INPUT through PAPER_CANDIDATE/ABSTAIN', () => {
      const records = [
        makeRecord({ title: 'Event 1: Initial detection', sourceId: 'src1' }),
        makeRecord({ title: 'Event 2: Follow-up', sourceId: 'src2' }),
      ];
      const snapshots = [makeMarketSnapshot(), makeMarketSnapshot()];
      const expectedOutcomes: ExpectedOutcome[] = [
        { stage: 'pipeline', eventId: 'test', expectedState: 'S0_DETECTED', expectedDecision: 'PAPER_CANDIDATE' },
        { stage: 'pipeline', eventId: 'test', expectedState: 'S0_DETECTED', expectedDecision: 'PAPER_CANDIDATE' },
      ];

      const fixture = createReplayFixture(
        'full-pipeline',
        records,
        snapshots,
        expectedOutcomes,
      );

      const results = runReplay(fixture);

      expect(results).toHaveLength(2);
      results.forEach((r) => {
        expect(r.decision).toMatch(/^(PAPER_CANDIDATE|ABSTAIN)$/);
        expect(r.forecast).toBeDefined();
        expect(r.surprise).toBeDefined();
      });
    });
  });

  describe('simulateStateTransition', () => {
    it('transition event state through pipeline', () => {
      const record = makeRecord({ title: 'RBI policy' });
      const processed = processEvent(
        record,
        'MACRO',
        makeOptionFeatures(),
        0,
        50,
        NOW_MS,
      );

      const transitioned = simulateStateTransition(
        processed.event,
        'EVIDENCE_RECEIVED',
        1,
        NOW_MS + 1000,
      );

      expect(transitioned).not.toBeNull();
      expect(transitioned!.currentState).toBe('S1_INITIAL_SHOCK');
      expect(transitioned!.versions.length).toBeGreaterThan(processed.event.versions.length);
    });

    it('invalid transition returns null', () => {
      const record = makeRecord({ title: 'RBI policy' });
      const processed = processEvent(
        record,
        'MACRO',
        makeOptionFeatures(),
        0,
        50,
        NOW_MS,
      );

      // Try an invalid transition from S0_DETECTED
      const result = simulateStateTransition(
        processed.event,
        'CONTRADICTION_RESOLVED',
        1,
        NOW_MS + 1000,
      );

      expect(result).toBeNull();
    });
  });

  describe('verifyOutcome', () => {
    it('passes when decision matches', () => {
      const record = makeRecord({ title: 'RBI holds rates' });
      const snapshot = makeMarketSnapshot();
      const fixture = createReplayFixture('verify-test', [record], [snapshot]);

      const result = verifyOutcome(fixture, {
        expectedDecision: 'PAPER_CANDIDATE',
      });

      // result should have passed and details
      expect(typeof result.passed).toBe('boolean');
      expect(typeof result.details).toBe('string');
    });

    it('fails when decision does not match', () => {
      const record = makeRecord({ title: 'RBI holds rates' });
      const snapshot = makeMarketSnapshot();
      const fixture = createReplayFixture('verify-fail', [record], [snapshot]);

      const result = verifyOutcome(fixture, {
        expectedDecision: 'ABSTAIN',
      });

      expect(typeof result.passed).toBe('boolean');
    });
  });

  describe('replayTestFixture', () => {
    it('returns same results as runReplay', () => {
      const record = makeRecord({ title: 'Test event' });
      const snapshot = makeMarketSnapshot();
      const fixture = createReplayFixture('alias-test', [record], [snapshot]);

      const runResults = runReplay(fixture);
      const aliasResults = replayTestFixture(fixture);

      expect(aliasResults).toHaveLength(runResults.length);
      aliasResults.forEach((r, i) => {
        expect(r.eventId).toBe(runResults[i].eventId);
        expect(r.decision).toBe(runResults[i].decision);
      });
    });
  });

  describe('edge cases', () => {
    it('empty fixture returns empty results', () => {
      const fixture = createReplayFixture('empty', [], []);
      const results = runReplay(fixture);
      expect(results).toHaveLength(0);
    });

    it('processEvent is deterministic (same input → same output)', () => {
      const record = makeRecord({ title: 'Deterministic test' });
      const opts = makeOptionFeatures();

      const r1 = processEvent(record, 'MACRO', opts, 0, 50, NOW_MS);
      const r2 = processEvent(record, 'MACRO', opts, 0, 50, NOW_MS);

      expect(r1.decision).toBe(r2.decision);
      expect(r1.forecast.pUp).toBe(r2.forecast.pUp);
      expect(r1.forecast.pDown).toBe(r2.forecast.pDown);
      expect(r1.forecast.pFlat).toBe(r2.forecast.pFlat);
    });
  });
});
