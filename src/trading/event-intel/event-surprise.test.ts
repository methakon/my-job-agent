import { calculateSurprise, SurpriseInput, SurpriseResult } from './event-surprise';
import { ForecastDistribution } from './event-types';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeDistribution(overrides: Partial<ForecastDistribution> = {}): ForecastDistribution {
  return {
    pUp: overrides.pUp ?? 0.4,
    pDown: overrides.pDown ?? 0.35,
    pFlat: overrides.pFlat ?? 0.25,
    moveQuantiles: overrides.moveQuantiles ?? [20, 40, 60, 80, 100],
    timeToPeakQuantiles: overrides.timeToPeakQuantiles ?? [30, 60, 90],
    persistenceProbability: overrides.persistenceProbability ?? 0.6,
    ivChangeQuantiles: overrides.ivChangeQuantiles ?? [0.5, 1, 1.5, 2, 2.5],
    ivCrushProbability: overrides.ivCrushProbability ?? 0.3,
    skewChange: overrides.skewChange ?? 0.1,
    termStructureChange: overrides.termStructureChange ?? 0.05,
    liquidityStressProbability: overrides.liquidityStressProbability ?? 0.2,
    abstainProbability: overrides.abstainProbability ?? 0.2,
  };
}

function makeSurpriseInput(overrides: Partial<SurpriseInput> = {}): SurpriseInput {
  return {
    actual: overrides.actual ?? 0.5,
    consensusAtDecisionTime: overrides.consensusAtDecisionTime ?? 0.3,
    previous: overrides.previous ?? 0.25,
    revision: overrides.revision ?? false,
    forecastDistribution: overrides.forecastDistribution ?? makeDistribution(),
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Event Surprise — Calculation', () => {
  describe('basic surprise', () => {
    it('actual matches consensus → low surprise', () => {
      const result = calculateSurprise(makeSurpriseInput({
        actual: 0.3,
        consensusAtDecisionTime: 0.3,
      }));

      expect(result.rawSurprise).toBe(0);
      expect(result.surpriseDirection).toBe('NEUTRAL');
      expect(Math.abs(result.standardizedSurprise)).toBeLessThan(0.01);
    });

    it('actual far from consensus → high surprise', () => {
      const result = calculateSurprise(makeSurpriseInput({
        actual: 1.2,
        consensusAtDecisionTime: 0.3,
      }));

      expect(result.rawSurprise).toBeCloseTo(0.9, 1);
      expect(result.surpriseDirection).toBe('POSITIVE');
      expect(result.standardizedSurprise).toBeGreaterThan(0.01);
    });

    it('negative surprise when actual below consensus', () => {
      const result = calculateSurprise(makeSurpriseInput({
        actual: -0.5,
        consensusAtDecisionTime: 0.3,
      }));

      expect(result.rawSurprise).toBeCloseTo(-0.8, 1);
      expect(result.surpriseDirection).toBe('NEGATIVE');
    });
  });

  describe('magnitude ≠ surprise', () => {
    it('large event matching expectations → low surprise', () => {
      // CPI at 0.8%, consensus 0.8% — large but expected
      const result = calculateSurprise(makeSurpriseInput({
        actual: 0.8,
        consensusAtDecisionTime: 0.8,
      }));

      expect(result.rawSurprise).toBe(0);
      expect(result.standardizedSurprise).toBe(0);
    });

    it('small unexpected event → high surprise', () => {
      // CPI at 0.1%, consensus 0.8% — small but very unexpected
      const result = calculateSurprise(makeSurpriseInput({
        actual: 0.1,
        consensusAtDecisionTime: 0.8,
      }));

      expect(result.rawSurprise).toBeCloseTo(-0.7, 1);
      expect(result.surpriseDirection).toBe('NEGATIVE');
      expect(result.standardizedSurprise).toBeLessThan(0);
    });
  });

  describe('revision surprise', () => {
    it('revision from T+2 used at T → high revision surprise', () => {
      const result = calculateSurprise(makeSurpriseInput({
        actual: 0.7,
        consensusAtDecisionTime: 0.3,
        previous: 0.25,
        revision: true,
      }));

      expect(result.revisionSurprise).toBeCloseTo(Math.abs(0.7 - 0.25), 2);
      expect(result.revisionSurprise).toBeGreaterThan(0);
    });

    it('non-revision has zero revision surprise', () => {
      const result = calculateSurprise(makeSurpriseInput({
        revision: false,
      }));

      expect(result.revisionSurprise).toBe(0);
    });
  });

  describe('forecast dispersion', () => {
    it('wide consensus → higher dispersion', () => {
      const wideDist = makeDistribution({
        moveQuantiles: [10, 30, 50, 70, 100], // spread: 100 - 10 = 90
      });

      const result = calculateSurprise(makeSurpriseInput({
        forecastDistribution: wideDist,
      }));

      expect(result.forecastDispersion).toBeGreaterThan(50);
    });

    it('narrow consensus → lower dispersion', () => {
      const narrowDist = makeDistribution({
        moveQuantiles: [40, 45, 50, 55, 60], // spread: 60 - 40 = 20
      });

      const result = calculateSurprise(makeSurpriseInput({
        forecastDistribution: narrowDist,
      }));

      expect(result.forecastDispersion).toBeLessThan(40);
    });
  });

  describe('novelty score', () => {
    it('first-time event type (high surprise, low abstain) → higher novelty', () => {
      const result = calculateSurprise(makeSurpriseInput({
        actual: 1.5,
        consensusAtDecisionTime: 0.3,
        forecastDistribution: makeDistribution({ abstainProbability: 0.1 }),
      }));

      expect(result.noveltyScore).toBeGreaterThan(0.1);
    });

    it('recurring event (revision, low surprise) → lower novelty', () => {
      const result = calculateSurprise(makeSurpriseInput({
        actual: 0.35,
        consensusAtDecisionTime: 0.3,
        revision: true,
        forecastDistribution: makeDistribution({ abstainProbability: 0.5 }),
      }));

      expect(result.noveltyScore).toBeLessThan(0.3);
    });
  });

  describe('edge cases', () => {
    it('zero expected move → standardized surprise is 0', () => {
      const result = calculateSurprise(makeSurpriseInput({
        actual: 1.0,
        consensusAtDecisionTime: 0.3,
        forecastDistribution: makeDistribution({
          moveQuantiles: [0, 0, 0, 0, 0],
        }),
      }));

      expect(result.standardizedSurprise).toBe(0);
    });

    it('all fields present in result', () => {
      const result = calculateSurprise(makeSurpriseInput());

      expect(result).toHaveProperty('rawSurprise');
      expect(result).toHaveProperty('standardizedSurprise');
      expect(result).toHaveProperty('surprisePercentile');
      expect(result).toHaveProperty('surpriseDirection');
      expect(result).toHaveProperty('revisionSurprise');
      expect(result).toHaveProperty('forecastDispersion');
      expect(result).toHaveProperty('noveltyScore');
      expect(result).toHaveProperty('marketImpliedProbabilityChange');
      expect(result).toHaveProperty('preEventPositioning');
    });
  });
});
