/**
 * Dhartrades Dynamic Bayesian Fractional-Kelly Position Sizing & Risk Engine
 *
 * Implements:
 * 1. CAPITAL_IN_HAND continuous calculation (initial capital + net realized P&L - charges).
 * 2. Hard Safety Invariants (Paper-only, Idempotency, Data Freshness, Capital Ceiling, Structural Stop).
 * 3. Bayesian Beta(alpha, beta) posterior win-rate (p_hat) and win/loss ratio (b_hat) per regime/setup bucket.
 * 4. Sample-size & calibration-scheduled Kelly shrinkage curve (kelly_shrinkage(n_trades)).
 * 5. Position Notional & Lot Sizing without static percentage caps.
 * 6. Dynamic ATR/Volatility-based Structural Stop calculation.
 */

export interface ChargesConfig {
  brokeragePerLot: number;   // e.g. ₹20 per lot
  sttRatePct: number;        // e.g. 0.0625% on sell premium
  exchangeFeePct: number;    // e.g. 0.05%
  gstRatePct: number;        // 18% on (brokerage + exchange fee)
  stampDutyRatePct: number;  // 0.003% on buy premium
}

export const DEFAULT_CHARGES: ChargesConfig = {
  brokeragePerLot: 20.0,
  sttRatePct: 0.0625,
  exchangeFeePct: 0.05,
  gstRatePct: 18.0,
  stampDutyRatePct: 0.003,
};

export interface RegimeSetupKey {
  regime: string; // e.g. 'TREND', 'RANGE', 'REVERSAL', 'DEFAULT'
  setupType: string; // e.g. 'BREAKOUT', 'GAP_FADE', 'MEAN_REVERSION', 'DEFAULT'
}

export interface PosteriorState {
  alpha: number; // Beta distribution alpha parameter (starts at 1)
  beta: number;  // Beta distribution beta parameter (starts at 1)
  wins: number[]; // Array of win R-multiples
  losses: number[]; // Array of loss R-multiples (positive values)
  nTrades: number;
}

export interface PositionSizingInput {
  symbol: string;
  underlying: string;
  expiry: string;
  regime?: string;
  setupType?: string;
  premium: number;
  lotSize: number;
  atr?: number;
  structuralStopPrice?: number;
  entryPrice?: number;
  side: 'BUY' | 'SELL';
  openPositionsNotional?: number;
  quoteAgeSec?: number;
  maxStaleSec?: number;
  isDuplicateOrder?: boolean;
  attemptedRealOrder?: boolean;
  nowMs?: number;
}

export interface PositionSizingResult {
  allowed: boolean;
  lots: number;
  quantity: number;
  positionNotional: number;
  sizeFraction: number;
  kRaw: number;
  kClipped: number;
  shrinkage: number;
  pHat: number;
  bHat: number;
  capitalInHand: number;
  remainingHeadroom: number;
  structuralStopPrice: number | null;
  stopPerUnit: number | null;
  plannedRisk: number;
  refusals: string[];
  rejectionCategory: 'HARD_SAFETY_VETO' | 'AFFORDABILITY_NO_TRADE' | 'STRATEGY_ADVISORY' | 'NONE';
}

export class DynamicRiskEngine {
  private initialCapital: number;
  private grossRealizedPnl: number = 0;
  private totalCharges: number = 0;
  private activeOrders: Set<string> = new Set();
  private posteriors: Map<string, PosteriorState> = new Map();
  private kellyCap: number = 0.5; // Upper bound on raw Kelly (safety rail)
  private chargesConfig: ChargesConfig;

  constructor(initialCapital = 100000, chargesConfig = DEFAULT_CHARGES, kellyCap = 0.5) {
    this.initialCapital = initialCapital;
    this.chargesConfig = chargesConfig;
    this.kellyCap = kellyCap;
  }

  /**
   * Recompute CAPITAL_IN_HAND continuously
   */
  public getCapitalInHand(): number {
    const netPnl = this.grossRealizedPnl - this.totalCharges;
    return Math.max(0, this.initialCapital + netPnl);
  }

  /**
   * Calculate transaction charges for a trade
   */
  public calculateCharges(premium: number, lotSize: number, lots: number, side: 'BUY' | 'SELL'): number {
    const notional = premium * lotSize * lots;
    const brokerage = this.chargesConfig.brokeragePerLot * lots;
    const exchangeFee = notional * (this.chargesConfig.exchangeFeePct / 100);
    const gst = (brokerage + exchangeFee) * (this.chargesConfig.gstRatePct / 100);
    const stampDuty = side === 'BUY' ? notional * (this.chargesConfig.stampDutyRatePct / 100) : 0;
    const stt = side === 'SELL' ? notional * (this.chargesConfig.sttRatePct / 100) : 0;
    return brokerage + exchangeFee + gst + stampDuty + stt;
  }

  /**
   * Get or initialize Beta posterior state for a regime/setup bucket
   */
  public getPosterior(regime = 'DEFAULT', setupType = 'DEFAULT'): PosteriorState {
    const key = `${regime.toUpperCase()}_${setupType.toUpperCase()}`;
    if (!this.posteriors.has(key)) {
      this.posteriors.set(key, {
        alpha: 1, // Uninformative prior Beta(1,1)
        beta: 1,
        wins: [],
        losses: [],
        nTrades: 0,
      });
    }
    return this.posteriors.get(key)!;
  }

  /**
   * Record a trade outcome and update Bayesian posteriors
   */
  public recordTradeOutcome(params: {
    regime?: string;
    setupType?: string;
    grossPnl: number;
    premium: number;
    lotSize: number;
    lots: number;
    side: 'BUY' | 'SELL';
    outcomeR: number; // Realized R-multiple
  }): void {
    const { regime = 'DEFAULT', setupType = 'DEFAULT', grossPnl, premium, lotSize, lots, side, outcomeR } = params;

    const charges = this.calculateCharges(premium, lotSize, lots, side);
    this.grossRealizedPnl += grossPnl;
    this.totalCharges += charges;

    const state = this.getPosterior(regime, setupType);
    state.nTrades += 1;

    if (outcomeR > 0) {
      state.alpha += 1;
      state.wins.push(outcomeR);
    } else {
      state.beta += 1;
      state.losses.push(Math.abs(outcomeR));
    }
  }

  /**
   * Compute rolling win probability estimate (p_hat)
   */
  public computePHat(state: PosteriorState): number {
    return state.alpha / (state.alpha + state.beta);
  }

  /**
   * Compute rolling win/loss ratio estimate (b_hat)
   */
  public computeBHat(state: PosteriorState): number {
    if (state.wins.length === 0 || state.losses.length === 0) {
      return 1.0; // Default prior win/loss ratio
    }
    const meanWin = state.wins.reduce((a, b) => a + b, 0) / state.wins.length;
    const meanLoss = state.losses.reduce((a, b) => a + b, 0) / state.losses.length;
    return meanLoss > 0 ? Math.max(0.1, meanWin / meanLoss) : 1.0;
  }

  /**
   * Compute sample-size & calibration-scheduled Kelly shrinkage factor
   * Monotonic curve: small n -> ~0.15..0.25 (eighth/quarter Kelly); large n -> 0.85 (full Kelly)
   */
  public computeKellyShrinkage(nTrades: number, calibrationScore = 0.5): number {
    const sMin = 0.15; // Minimum shrinkage for n=0
    const sMax = 0.85; // Upper shrinkage limit
    const tau = 25.0;  // Half-life scale parameter in number of trades

    const sampleFactor = 1 - Math.exp(-nTrades / tau);
    const calibFactor = 0.8 + 0.4 * Math.min(1, Math.max(0, calibrationScore));

    return Math.min(sMax, Math.max(sMin, (sMin + (sMax - sMin) * sampleFactor) * calibFactor));
  }

  /**
   * Calculate position sizing using dynamic fractional Kelly
   */
  public calculatePositionSize(input: PositionSizingInput): PositionSizingResult {
    const refusals: string[] = [];
    const capitalInHand = this.getCapitalInHand();
    const openNotional = input.openPositionsNotional || 0;
    const remainingHeadroom = Math.max(0, capitalInHand - openNotional);

    // ── HARD VETOES (Section 2: Data Integrity & Safety Invariants) ─────────

    // 1. Paper-Only Invariant
    if (input.attemptedRealOrder) {
      refusals.push('HARD_SAFETY_VETO: REAL_ORDER_ROUTING_PROHIBITED');
    }

    // 2. Idempotency Invariant
    if (input.isDuplicateOrder || this.activeOrders.has(input.symbol)) {
      refusals.push('HARD_SAFETY_VETO: DUPLICATE_ORDER_IDEMPOTENCY_BREACH');
    }

    // 3. Quote Freshness / Data Integrity Invariant
    const quoteAge = input.quoteAgeSec ?? 0;
    const maxStale = input.maxStaleSec ?? 15;
    if (quoteAge > maxStale) {
      refusals.push(`HARD_SAFETY_VETO: STALE_QUOTE_DATA (age ${quoteAge}s > ${maxStale}s)`);
    }

    // 4. Structural Stop Requirement
    let stopPrice: number | null = input.structuralStopPrice ?? null;
    let stopPerUnit: number | null = null;
    const entryPrice = input.entryPrice ?? input.premium;

    if (!stopPrice && input.atr && input.atr > 0) {
      stopPrice = input.side === 'BUY' ? Math.max(0.05, entryPrice - 1.5 * input.atr) : entryPrice + 1.5 * input.atr;
    }

    if (!stopPrice || stopPrice <= 0) {
      refusals.push('HARD_SAFETY_VETO: STRUCTURAL_STOP_MISSING');
    } else {
      stopPerUnit = Math.abs(entryPrice - stopPrice);
    }

    // If hard safety vetoes failed, return immediately
    if (refusals.length > 0) {
      return {
        allowed: false,
        lots: 0,
        quantity: 0,
        positionNotional: 0,
        sizeFraction: 0,
        kRaw: 0,
        kClipped: 0,
        shrinkage: 0,
        pHat: 0.5,
        bHat: 1.0,
        capitalInHand,
        remainingHeadroom,
        structuralStopPrice: stopPrice,
        stopPerUnit,
        plannedRisk: 0,
        refusals,
        rejectionCategory: 'HARD_SAFETY_VETO',
      };
    }

    // ── DYNAMIC BAYESIAN FRACTIONAL KELLY SIZING (Section 3 & 4) ───────────

    const state = this.getPosterior(input.regime, input.setupType);
    const pHat = this.computePHat(state);
    const bHat = this.computeBHat(state);

    // Raw Kelly: k_raw = p_hat - (1 - p_hat) / b_hat
    const kRaw = pHat - (1 - pHat) / bHat;
    const kClipped = Math.max(0, Math.min(this.kellyCap, kRaw));

    const shrinkage = this.computeKellyShrinkage(state.nTrades);
    const sizeFraction = kClipped * shrinkage;

    const targetNotional = sizeFraction * capitalInHand;
    const maxAvailableNotional = Math.min(targetNotional, remainingHeadroom);

    const outlayPerLot = input.premium * input.lotSize;

    // Check affordability
    if (outlayPerLot > remainingHeadroom || outlayPerLot <= 0) {
      refusals.push(`AFFORDABILITY_NO_TRADE: CAPITAL_IN_HAND (${capitalInHand.toFixed(2)}) insufficient for 1 lot (${outlayPerLot.toFixed(2)})`);
      return {
        allowed: false,
        lots: 0,
        quantity: 0,
        positionNotional: 0,
        sizeFraction,
        kRaw,
        kClipped,
        shrinkage,
        pHat,
        bHat,
        capitalInHand,
        remainingHeadroom,
        structuralStopPrice: stopPrice,
        stopPerUnit,
        plannedRisk: 0,
        refusals,
        rejectionCategory: 'AFFORDABILITY_NO_TRADE',
      };
    }

    // Calculate dynamic lot count
    const lots = Math.floor(maxAvailableNotional / outlayPerLot);

    if (lots < 1) {
      refusals.push(`AFFORDABILITY_NO_TRADE: Sized notional (${maxAvailableNotional.toFixed(2)}) below single lot outlay (${outlayPerLot.toFixed(2)})`);
      return {
        allowed: false,
        lots: 0,
        quantity: 0,
        positionNotional: 0,
        sizeFraction,
        kRaw,
        kClipped,
        shrinkage,
        pHat,
        bHat,
        capitalInHand,
        remainingHeadroom,
        structuralStopPrice: stopPrice,
        stopPerUnit,
        plannedRisk: 0,
        refusals,
        rejectionCategory: 'AFFORDABILITY_NO_TRADE',
      };
    }

    const totalOutlay = lots * outlayPerLot;
    const plannedRisk = lots * input.lotSize * (stopPerUnit ?? input.premium);

    return {
      allowed: true,
      lots,
      quantity: lots * input.lotSize,
      positionNotional: totalOutlay,
      sizeFraction,
      kRaw,
      kClipped,
      shrinkage,
      pHat,
      bHat,
      capitalInHand,
      remainingHeadroom,
      structuralStopPrice: stopPrice,
      stopPerUnit,
      plannedRisk,
      refusals: [],
      rejectionCategory: 'NONE',
    };
  }
}
