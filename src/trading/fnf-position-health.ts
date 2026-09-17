/**
 * FNF Position Health State Machine.
 *
 * Deterministic state transitions for open positions:
 *   GREEN → YELLOW → ORANGE → RED → BLACK
 *   + PROFIT_LOCK (parallel state)
 */

export enum PositionHealthState {
  GREEN = 'GREEN',
  YELLOW = 'YELLOW',
  ORANGE = 'ORANGE',
  RED = 'RED',
  BLACK = 'BLACK',
  PROFIT_LOCK = 'PROFIT_LOCK',
}

export interface PositionHealthInput {
  currentPremium: number;
  entryPremium: number;
  stopPrice: number;
  targetPrice: number;
  unrealizedPnlPerUnit: number;
  maePerUnit: number;
  mfePerUnit: number;
  currentRiskPerUnit: number;   // currentPremium - stopPrice
  originalRiskPerUnit: number;  // entryPremium - stopPrice
  dte: number;
  underlyingSpot: number;
  underlyingSma20: number | null;
  delta: number | null;
  iv: number | null;
  quoteAgeMin: number;
  maxStaleMin: number;
  traps: {
    traps: Array<{ trapType: string; severity: string }>;
    highSeverity: boolean;
    hasTraps: boolean;
    score: number;
  };
  thesisValid: boolean;
  underlyingConfirmed: boolean;
  spreadPct: number | null;
  volume: number;
  inProfit: boolean;
  profitExceedsThreshold: boolean;
}

export interface PositionHealthOutput {
  state: PositionHealthState;
  shouldReduce: boolean;
  shouldExit: boolean;
  shouldHedge: boolean;
  reason: string;
  transition: { from: PositionHealthState; to: PositionHealthState } | null;
  detail: string;
}

export function fnfEvaluatePositionHealth(input: PositionHealthInput): PositionHealthOutput {
  // ── PROFIT_LOCK: parallel state, highest priority ──
  if (input.profitExceedsThreshold && input.mfePerUnit > input.originalRiskPerUnit * 1.5) {
    return {
      state: PositionHealthState.PROFIT_LOCK,
      shouldReduce: true,
      shouldExit: false,
      shouldHedge: false,
      reason: `MFE ${input.mfePerUnit.toFixed(1)} exceeds 1.5x original risk — protect profits`,
      transition: null,
      detail: `PROFIT_LOCK: MFE ₹${input.mfePerUnit.toFixed(1)} > 1.5x original risk ₹${input.originalRiskPerUnit.toFixed(1)}`,
    };
  }

  // ── BLACK: hard breach / data failure / extreme event ──
  if (input.currentRiskPerUnit < 0) {
    return {
      state: PositionHealthState.BLACK,
      shouldReduce: false,
      shouldExit: true,
      shouldHedge: false,
      reason: `below stop: current risk ${input.currentRiskPerUnit.toFixed(1)} < 0`,
      transition: null,
      detail: `BLACK: below stop — mandatory exit`,
    };
  }
  if (input.traps.highSeverity) {
    return {
      state: PositionHealthState.BLACK,
      shouldReduce: false,
      shouldExit: true,
      shouldHedge: false,
      reason: `high-severity trap: ${input.traps.traps.map(t => t.trapType).join(', ')}`,
      transition: null,
      detail: `BLACK: high-severity trap(s) — mandatory exit`,
    };
  }
  if (input.quoteAgeMin > input.maxStaleMin * 2) {
    return {
      state: PositionHealthState.BLACK,
      shouldReduce: false,
      shouldExit: true,
      shouldHedge: false,
      reason: `quote critically stale: ${input.quoteAgeMin}min`,
      transition: null,
      detail: `BLACK: data quality failure — mandatory exit`,
    };
  }
  if (input.volume === 0 && input.spreadPct !== null && input.spreadPct > 5) {
    return {
      state: PositionHealthState.BLACK,
      shouldReduce: false,
      shouldExit: true,
      shouldHedge: false,
      reason: `execution failure: zero volume + spread ${input.spreadPct.toFixed(1)}%`,
      transition: null,
      detail: `BLACK: liquidity failure — mandatory exit`,
    };
  }

  // ── RED: trap confirmed OR thesis invalidated + deteriorating ──
  if (!input.thesisValid && !input.underlyingConfirmed) {
    return {
      state: PositionHealthState.RED,
      shouldReduce: false,
      shouldExit: true,
      shouldHedge: false,
      reason: `thesis invalidated + underlying unconfirmed`,
      transition: null,
      detail: `RED: thesis invalidated — exit recommended`,
    };
  }

  // ── ORANGE: thesis weakened or significant deterioration ──
  if (!input.thesisValid || !input.underlyingConfirmed) {
    return {
      state: PositionHealthState.ORANGE,
      shouldReduce: true,
      shouldExit: false,
      shouldHedge: true,
      reason: !input.thesisValid ? 'thesis weakening' : 'underlying unconfirmed',
      transition: null,
      detail: `ORANGE: thesis/weakening — reduce or hedge`,
    };
  }
  if (input.maePerUnit > input.originalRiskPerUnit * 0.8) {
    return {
      state: PositionHealthState.ORANGE,
      shouldReduce: true,
      shouldExit: false,
      shouldHedge: true,
      reason: `MAE ${input.maePerUnit.toFixed(1)} approaching original risk ${input.originalRiskPerUnit.toFixed(1)}`,
      transition: null,
      detail: `ORANGE: MAE approaching risk limit`,
    };
  }

  // ── YELLOW: evidence weakening ──
  if (input.dte <= 3 || input.traps.hasTraps ||
      (input.underlyingSma20 !== null && input.underlyingSpot < input.underlyingSma20) ||
      (input.spreadPct !== null && input.spreadPct > 2.0)) {
    return {
      state: PositionHealthState.YELLOW,
      shouldReduce: false,
      shouldExit: false,
      shouldHedge: false,
      reason: `elevated risk factors: DTE=${input.dte}, traps=${input.traps.hasTraps}`,
      transition: { from: PositionHealthState.GREEN, to: PositionHealthState.YELLOW },
      detail: `YELLOW: monitoring intensified`,
    };
  }

  // ── GREEN: default healthy state ──
  return {
    state: PositionHealthState.GREEN,
    shouldReduce: false,
    shouldExit: false,
    shouldHedge: false,
    reason: 'thesis intact, normal risk',
    transition: null,
    detail: `GREEN: position healthy`,
  };
}
