import { generateForecast, decideFromForecast, ForecastInput } from './event-forecast';
import {
  ForecastDistribution,
  EventStateMachineState,
  EventLifecycle,
  EventOntology,
  Event,
  EventVersion,
  EventRawRecord,
  EventEvidence,
  SourceTier,
  OptionChainFeatures,
  SpotFuturesFeatures,
  IVFeatures,
  SkewFeatures,
  TermStructureFeatures,
  GreeksFeatures,
  FlowFeatures,
  LiquidityFeatures,
  StructureFeatures,
} from './event-types';
import { SurpriseResult } from './event-surprise';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeOptionFeatures(overrides: Partial<OptionChainFeatures> = {}): OptionChainFeatures {
  return {
    spotFutures: overrides.spotFutures ?? { spot: 22000, futures: 22100, basis: 100, returns1d: 0.01, gapPct: 0.2, momentum5d: 0.5, vwapDistancePct: 0.1, realizedVolatility: 15, futuresVolume: 50000, futuresOI: 100000 } as SpotFuturesFeatures,
    iv: overrides.iv ?? { atmIV: 18, ivPercentile: 60, ivRank: 50, eventPremium: 2, ivChange1d: 0.5, ivByStrike: new Map(), ivByExpiry: new Map() } as IVFeatures,
    skew: overrides.skew ?? { twentyFiveDeltaRR: -0.5, putCallSkew: 0.8, skewChange1d: 0.1 } as SkewFeatures,
    termStructure: overrides.termStructure ?? { frontIV: 20, backIV: 22, slope: 0.5, curvature: 0.1, eventExpiryPremium: 1 } as TermStructureFeatures,
    greeks: overrides.greeks ?? { delta: 0.5, gamma: 0.02, vega: 0.3, theta: -5, vanna: null, volga: null, charm: null } as GreeksFeatures,
    flow: overrides.flow ?? { totalVolume: 180000, oiChange: 5000, volumeToOIRatio: 0.18, callPutImbalance: 1.25 } as FlowFeatures,
    liquidity: overrides.liquidity ?? { bidAskSpreadPct: 0.1, depth: 500, staleQuoteCount: 2, executionStress: 0.2 } as LiquidityFeatures,
    structures: overrides.structures ?? { atmStraddle: 300, strangle: 500, expectedMove: 1.5, breakEvenMove: 2.0 } as StructureFeatures,
  };
}

function makeSurprise(overrides: Partial<SurpriseResult> = {}): SurpriseResult {
  return {
    rawSurprise: overrides.rawSurprise ?? 0,
    standardizedSurprise: overrides.standardizedSurprise ?? 0,
    surprisePercentile: overrides.surprisePercentile ?? 50,
    surpriseDirection: overrides.surpriseDirection ?? 'NEUTRAL',
    revisionSurprise: overrides.revisionSurprise ?? 0,
    forecastDispersion: overrides.forecastDispersion ?? 50,
    noveltyScore: overrides.noveltyScore ?? 0.3,
    marketImpliedProbabilityChange: overrides.marketImpliedProbabilityChange ?? 0,
    preEventPositioning: overrides.preEventPositioning ?? 0.2,
  };
}

function makeEvent(overrides: Partial<Event> = {}): Event {
  const now = Date.now();
  const rawRecord: EventRawRecord = {
    sourceId: 'test', sourceName: 'Test', sourceTier: 'TIER2_MARKET_DATA' as SourceTier,
    sourceType: 'press_release', sourceUrl: 'https://example.com',
    sourcePublishedAt: now - 1000, sourceUpdatedAt: 0, receivedAt: now - 900, processedAt: now - 800,
    title: 'RBI policy', body: 'RBI policy', language: 'en',
    rawPayloadHash: 'hash1', eventFingerprint: 'fp1',
  };
  const evidence: EventEvidence = { rawRecord, addedAtMs: now, sourceTier: 'TIER2_MARKET_DATA' };
  return {
    id: overrides.id ?? 'test-event-001',
    ontology: overrides.ontology ?? ('MACRO' as EventOntology),
    lifecycle: overrides.lifecycle ?? ('OFFICIAL' as EventLifecycle),
    versions: overrides.versions ?? [{ version: 1, evidence: [evidence], createdAtMs: now, lifecycle: 'OFFICIAL' as EventLifecycle, reasonCode: 'initial' }] as readonly EventVersion[],
    currentState: overrides.currentState ?? 'S4_ASSIMILATED',
    detectedAtMs: overrides.detectedAtMs ?? (now - 3600000),
    lastUpdatedAtMs: overrides.lastUpdatedAtMs ?? now,
  };
}

function makeForecastInput(overrides: Partial<ForecastInput> = {}): ForecastInput {
  return {
    event: overrides.event ?? makeEvent(),
    surprise: overrides.surprise ?? makeSurprise(),
    optionFeatures: overrides.optionFeatures ?? makeOptionFeatures(),
    currentState: overrides.currentState ?? 'S4_ASSIMILATED',
    historicalMoveMean: overrides.historicalMoveMean ?? 0,
    historicalMoveStd: overrides.historicalMoveStd ?? 50,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Event Forecast — Generation', () => {
  describe('probability distribution', () => {
    it('P(up), P(down), P(flat) sum to approximately 1', () => {
      const forecast = generateForecast(makeForecastInput());
      const sum = forecast.pUp + forecast.pDown + forecast.pFlat;
      expect(sum).toBeCloseTo(1.0, 1);
    });

    it('all probabilities are between 0 and 1', () => {
      const forecast = generateForecast(makeForecastInput());
      expect(forecast.pUp).toBeGreaterThanOrEqual(0);
      expect(forecast.pUp).toBeLessThanOrEqual(1);
      expect(forecast.pDown).toBeGreaterThanOrEqual(0);
      expect(forecast.pDown).toBeLessThanOrEqual(1);
      expect(forecast.pFlat).toBeGreaterThanOrEqual(0);
      expect(forecast.pFlat).toBeLessThanOrEqual(1);
    });
  });

  describe('move quantiles', () => {
    it('forecast includes move quantiles', () => {
      const forecast = generateForecast(makeForecastInput());
      expect(forecast.moveQuantiles).toBeDefined();
      expect(forecast.moveQuantiles.length).toBe(5);
      for (let i = 1; i < forecast.moveQuantiles.length; i++) {
        expect(forecast.moveQuantiles[i]).toBeGreaterThanOrEqual(forecast.moveQuantiles[i - 1]);
      }
    });
  });

  describe('IV crush probability', () => {
    it('forecast includes iv crush probability', () => {
      const forecast = generateForecast(makeForecastInput());
      expect(forecast.ivCrushProbability).toBeGreaterThanOrEqual(0);
      expect(forecast.ivCrushProbability).toBeLessThanOrEqual(1);
    });

    it('OFFICIAL lifecycle increases IV crush probability', () => {
      const official = generateForecast(makeForecastInput({
        event: makeEvent({ lifecycle: 'OFFICIAL' }),
      }));
      const rumor = generateForecast(makeForecastInput({
        event: makeEvent({ lifecycle: 'RUMOR' }),
      }));
      expect(official.ivCrushProbability).toBeGreaterThanOrEqual(rumor.ivCrushProbability);
    });
  });

  describe('abstain probability', () => {
    it('forecast includes abstain probability', () => {
      const forecast = generateForecast(makeForecastInput());
      expect(forecast.abstainProbability).toBeGreaterThanOrEqual(0);
      expect(forecast.abstainProbability).toBeLessThanOrEqual(1);
    });

    it('high abstain probability → PAPER_CANDIDATE not emitted', () => {
      const forecast = generateForecast(makeForecastInput({
        currentState: 'S3_CONTRADICTION',
        surprise: makeSurprise({ standardizedSurprise: 3 }),
        optionFeatures: makeOptionFeatures({
          iv: { atmIV: 30, ivPercentile: 80, ivRank: 70, eventPremium: 5, ivChange1d: 2, ivByStrike: new Map(), ivByExpiry: new Map() },
          liquidity: { bidAskSpreadPct: 1, depth: 100, staleQuoteCount: 10, executionStress: 0.8 },
        }),
      }));
      const decision = decideFromForecast(forecast, 0.5);
      expect(decision).toBe('ABSTAIN');
    });

    it('S3_CONTRADICTION increases abstain probability', () => {
      const contradiction = generateForecast(makeForecastInput({
        currentState: 'S3_CONTRADICTION',
      }));
      const assimilated = generateForecast(makeForecastInput({
        currentState: 'S4_ASSIMILATED',
      }));
      expect(contradiction.abstainProbability).toBeGreaterThanOrEqual(assimilated.abstainProbability);
    });
  });

  describe('forecast never outputs only CALL/PUT', () => {
    it('output always has all three probabilities', () => {
      const forecast = generateForecast(makeForecastInput());
      expect(forecast).toHaveProperty('pUp');
      expect(forecast).toHaveProperty('pDown');
      expect(forecast).toHaveProperty('pFlat');
      expect(typeof forecast.pUp).toBe('number');
      expect(typeof forecast.pDown).toBe('number');
      expect(typeof forecast.pFlat).toBe('number');
    });

    it('distribution is always a triple, never a single direction', () => {
      const extremeInput = makeForecastInput({
        surprise: makeSurprise({ standardizedSurprise: 5 }),
        optionFeatures: makeOptionFeatures({
          iv: { atmIV: 50, ivPercentile: 99, ivRank: 95, eventPremium: 10, ivChange1d: 5, ivByStrike: new Map(), ivByExpiry: new Map() },
        }),
      });
      const forecast = generateForecast(extremeInput);
      expect(forecast.pUp).toBeGreaterThanOrEqual(0);
      expect(forecast.pDown).toBeGreaterThanOrEqual(0);
      expect(forecast.pFlat).toBeGreaterThanOrEqual(0);
      const total = forecast.pUp + forecast.pDown + forecast.pFlat;
      expect(total).toBeGreaterThan(0);
    });
  });

  describe('decideFromForecast', () => {
    it('low abstain → PAPER_CANDIDATE', () => {
      const forecast: ForecastDistribution = {
        pUp: 0.4, pDown: 0.35, pFlat: 0.25,
        moveQuantiles: [20, 40, 60, 80, 100],
        timeToPeakQuantiles: [30, 60, 90],
        persistenceProbability: 0.6,
        ivChangeQuantiles: [0.5, 1, 1.5, 2, 2.5],
        ivCrushProbability: 0.3,
        skewChange: 0.1, termStructureChange: 0.05,
        liquidityStressProbability: 0.2, abstainProbability: 0.2,
      };
      expect(decideFromForecast(forecast, 0.5)).toBe('PAPER_CANDIDATE');
    });

    it('high abstain → ABSTAIN', () => {
      const forecast: ForecastDistribution = {
        pUp: 0.2, pDown: 0.2, pFlat: 0.6,
        moveQuantiles: [10, 20, 30, 40, 50],
        timeToPeakQuantiles: [20, 40, 60],
        persistenceProbability: 0.3,
        ivChangeQuantiles: [1, 2, 3, 4, 5],
        ivCrushProbability: 0.5,
        skewChange: 0.2, termStructureChange: 0.1,
        liquidityStressProbability: 0.5, abstainProbability: 0.8,
      };
      expect(decideFromForecast(forecast, 0.5)).toBe('ABSTAIN');
    });
  });

  describe('edge cases', () => {
    it('forecast is deterministic (same input → same output)', () => {
      const input = makeForecastInput();
      const f1 = generateForecast(input);
      const f2 = generateForecast(input);
      expect(f1.pUp).toBe(f2.pUp);
      expect(f1.pDown).toBe(f2.pDown);
      expect(f1.pFlat).toBe(f2.pFlat);
      expect(f1.abstainProbability).toBe(f2.abstainProbability);
    });

    it('high surprise increases abstain probability', () => {
      const low = generateForecast(makeForecastInput({
        surprise: makeSurprise({ standardizedSurprise: 0.5 }),
      }));
      const high = generateForecast(makeForecastInput({
        surprise: makeSurprise({ standardizedSurprise: 3 }),
      }));
      expect(high.abstainProbability).toBeGreaterThanOrEqual(low.abstainProbability);
    });
  });
});
