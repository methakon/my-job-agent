import { estimateHawkes, predictNextArrival } from './event-hawkes';
import { HawkesEstimate } from './event-types';

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Event Hawkes — Intensity Estimation', () => {
  describe('branching ratio', () => {
    it('uniform event times → low branching ratio', () => {
      // Events equally spaced — no self-excitation
      const uniformTimes = [0, 100, 200, 300, 400, 500, 600, 700, 800, 900];
      const result = estimateHawkes(uniformTimes);

      expect(result.branchingRatio).toBeLessThan(0.5);
      expect(result.branchingRatio).toBeGreaterThanOrEqual(0);
    });

    it('clustered event times → high branching ratio', () => {
      // Events clustered in bursts — high self-excitation
      const clusteredTimes = [
        0, 2, 5,       // cluster 1
        100, 102, 105, // cluster 2
        200, 202, 205, // cluster 3
        300, 302, 305, // cluster 4
      ];
      const result = estimateHawkes(clusteredTimes);

      expect(result.branchingRatio).toBeGreaterThan(0.3);
    });

    it('single event → low intensity', () => {
      const singleEvent = [100];
      const result = estimateHawkes(singleEvent);

      expect(result.branchingRatio).toBeGreaterThanOrEqual(0);
      expect(result.branchingRatio).toBeLessThanOrEqual(1);
    });
  });

  describe('predict next arrival', () => {
    it('predictNextArrival returns reasonable future time', () => {
      const times = [0, 5, 10, 15, 20];
      const hawkes = estimateHawkes(times);
      const nowMs = 50;
      const prediction = predictNextArrival(hawkes, 20, nowMs);

      expect(prediction.predictedArrivalTimeMs).toBeGreaterThan(nowMs);
      expect(prediction.intensityAtPrediction).toBeGreaterThanOrEqual(0);
    });

    it('predictNextArrival after clustered events → sooner arrival', () => {
      const clustered = [0, 2, 5, 8, 10, 12, 15];
      const uniform = [0, 50, 100, 150, 200];

      const hawkesC = estimateHawkes(clustered);
      const hawkesU = estimateHawkes(uniform);

      const clusteredPrediction = predictNextArrival(hawkesC, 15, 15);
      const uniformPrediction = predictNextArrival(hawkesU, 200, 200);

      // Clustered should predict next event sooner
      const clusteredGap = clusteredPrediction.predictedArrivalTimeMs - 15;
      const uniformGap = uniformPrediction.predictedArrivalTimeMs - 200;

      expect(clusteredGap).toBeLessThan(uniformGap);
    });

    it('confidence interval is valid range', () => {
      const times = [0, 10, 20, 30, 40, 50];
      const hawkes = estimateHawkes(times);
      const prediction = predictNextArrival(hawkes, 50, 50);

      expect(prediction.confidenceInterval[0]).toBeLessThanOrEqual(prediction.confidenceInterval[1]);
      expect(prediction.confidenceInterval[0]).toBeGreaterThanOrEqual(50);
    });
  });

  describe('edge cases', () => {
    it('empty event times → returns baseline', () => {
      const result = estimateHawkes([]);

      expect(result.backgroundIntensity).toBeGreaterThanOrEqual(0);
      expect(result.branchingRatio).toBeGreaterThanOrEqual(0);
      expect(result.branchingRatio).toBeLessThanOrEqual(1);
    });

    it('highly regular events → branching ratio near zero', () => {
      // Perfectly periodic events
      const periodic = Array.from({ length: 100 }, (_, i) => i * 1000);
      const result = estimateHawkes(periodic);

      expect(result.branchingRatio).toBeLessThan(0.3);
    });

    it('results contain all required fields', () => {
      const result = estimateHawkes([0, 10, 20, 30, 40]);

      expect(result).toHaveProperty('backgroundIntensity');
      expect(result).toHaveProperty('currentJumpIntensity');
      expect(result).toHaveProperty('branchingRatio');
      expect(result).toHaveProperty('decayHalfLife');
      expect(result).toHaveProperty('totalIntensity');
      expect(typeof result.backgroundIntensity).toBe('number');
      expect(typeof result.currentJumpIntensity).toBe('number');
      expect(typeof result.branchingRatio).toBe('number');
      expect(typeof result.decayHalfLife).toBe('number');
      expect(typeof result.totalIntensity).toBe('number');
    });
  });
});
