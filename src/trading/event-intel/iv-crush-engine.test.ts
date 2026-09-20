import { measureIVCrush } from './iv-crush-engine';
import { IVCrushInput } from './event-types';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeIVCrushInput(overrides: Partial<IVCrushInput> = {}): IVCrushInput {
  return {
    preEventATMIV: overrides.preEventATMIV ?? 30,
    postEventATMIV: overrides.postEventATMIV ?? 20,
    actualSpotMove: overrides.actualSpotMove ?? 100,
    impliedMove: overrides.impliedMove ?? 80,
    thetaLoss: overrides.thetaLoss ?? 5,
    spread: overrides.spread ?? 2,
    slippage: overrides.slippage ?? 1,
    optionDelta: overrides.optionDelta ?? 0.5,
    optionVega: overrides.optionVega ?? 0.3,
    positionSize: overrides.positionSize ?? 1,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('IV Crush Engine — Measurement', () => {
  describe('direction and profitability', () => {
    it('direction correct but IV crush overwhelmed Delta → not profitable', () => {
      // Delta gains 0.5 * 100 = 50, but vega loss 0.3 * (30-20) = 3
      // Actually, if IV drops from 30 to 20, vega PnL = 0.3 * (20-30) = -3
      // Delta PnL = 0.5 * 100 = 50
      // So this would be profitable. Let me make IV drop more.
      const result = measureIVCrush(makeIVCrushInput({
        preEventATMIV: 50,
        postEventATMIV: 10, // massive IV crush
        actualSpotMove: 50,
        impliedMove: 40,
        optionDelta: 0.3,
        optionVega: 0.5,
        thetaLoss: 2,
        spread: 1,
        slippage: 0.5,
      }));

      // Delta PnL = 0.3 * 50 = 15
      // Vega PnL = 0.5 * (10 - 50) = -20
      // Theta PnL = -2
      // Transaction cost = 1 + 0.5 = 1.5
      // Net = 15 - 20 - 2 - 1.5 = -8.5 → not profitable
      expect(result.ivCrushOverwhelmedDelta).toBe(true);
      expect(result.optionProfitable).toBe(false);
    });

    it('direction correct and IV held → profitable', () => {
      const result = measureIVCrush(makeIVCrushInput({
        preEventATMIV: 30,
        postEventATMIV: 28, // small IV crush
        actualSpotMove: 100,
        impliedMove: 50,
        optionDelta: 0.5,
        optionVega: 0.3,
        thetaLoss: 1,
        spread: 1,
        slippage: 0.5,
      }));

      // Delta PnL = 0.5 * 100 = 50
      // Vega PnL = 0.3 * (28 - 30) = -0.6
      // Theta PnL = -1
      // Transaction cost = 1 + 0.5 = 1.5
      // Net = 50 - 0.6 - 1 - 1.5 = 46.9 → profitable
      expect(result.directionCorrect).toBe(true);
      expect(result.optionProfitable).toBe(true);
      expect(result.netPnl).toBeGreaterThan(0);
    });

    it('theta overwhelmed the move → not profitable despite correct direction', () => {
      const result = measureIVCrush(makeIVCrushInput({
        preEventATMIV: 30,
        postEventATMIV: 29,
        actualSpotMove: 10,
        impliedMove: 5,
        optionDelta: 0.3,
        optionVega: 0.1,
        thetaLoss: 8, // high theta
        spread: 1,
        slippage: 0.5,
      }));

      // Delta PnL = 0.3 * 10 = 3
      // Vega PnL = 0.1 * (29 - 30) = -0.1
      // Theta PnL = -8
      // Transaction cost = 1.5
      // Net = 3 - 0.1 - 8 - 1.5 = -6.6
      expect(result.thetaOverwhelmedMove).toBe(true);
      expect(result.optionProfitable).toBe(false);
    });

    it('spread/slippage destroyed edge → not profitable', () => {
      const result = measureIVCrush(makeIVCrushInput({
        preEventATMIV: 30,
        postEventATMIV: 29,
        actualSpotMove: 10,
        impliedMove: 8,
        optionDelta: 0.3,
        optionVega: 0.1,
        thetaLoss: 1,
        spread: 5,    // huge spread
        slippage: 3,   // huge slippage
      }));

      // Delta PnL = 0.3 * 10 = 3
      // Vega PnL = 0.1 * -1 = -0.1
      // Theta PnL = -1
      // Transaction cost = 5 + 3 = 8
      // Net = 3 - 0.1 - 1 - 8 = -6.1
      expect(result.transactionCostsDestroyedEdge).toBe(true);
      expect(result.optionProfitable).toBe(false);
    });

    it('all factors favorable → profitable', () => {
      const result = measureIVCrush(makeIVCrushInput({
        preEventATMIV: 20,
        postEventATMIV: 19, // tiny IV crush
        actualSpotMove: 200,
        impliedMove: 50,
        optionDelta: 0.7,
        optionVega: 0.1,
        thetaLoss: 0.5,
        spread: 0.5,
        slippage: 0.2,
      }));

      expect(result.directionCorrect).toBe(true);
      expect(result.ivCrushOverwhelmedDelta).toBe(false);
      expect(result.thetaOverwhelmedMove).toBe(false);
      expect(result.transactionCostsDestroyedEdge).toBe(false);
      expect(result.optionProfitable).toBe(true);
    });
  });

  describe('IV change measurement', () => {
    it('pre/post IV change correctly measured', () => {
      const result = measureIVCrush(makeIVCrushInput({
        preEventATMIV: 40,
        postEventATMIV: 25,
      }));

      // Vega PnL = 0.3 * (25 - 40) = -4.5
      expect(result.vegaPnl).toBeCloseTo(-4.5, 1);
    });

    it('IV increase → positive vega PnL', () => {
      const result = measureIVCrush(makeIVCrushInput({
        preEventATMIV: 20,
        postEventATMIV: 35,
        optionVega: 0.3,
      }));

      // Vega PnL = 0.3 * (35 - 20) = 4.5
      expect(result.vegaPnl).toBeCloseTo(4.5, 1);
    });
  });

  describe('breakdown', () => {
    it('breakdown is non-empty string', () => {
      const result = measureIVCrush(makeIVCrushInput());
      expect(typeof result.breakdown).toBe('string');
      expect(result.breakdown.length).toBeGreaterThan(0);
    });

    it('netPnl is sum of components', () => {
      const result = measureIVCrush(makeIVCrushInput());
      const expected = result.deltaPnl + result.vegaPnl + result.thetaPnl + result.transactionCostPnl;
      expect(result.netPnl).toBeCloseTo(expected, 2);
    });
  });
});
