/**
 * FNF Exit Engine — four independent exit reasons + profit protection.
 *
 * Exit reasons:
 *   THESIS_EXIT      — thesis invalidated
 *   RISK_EXIT        — hard loss/portfolio limit breach
 *   EV_EXIT          — holding no longer has positive/required EV
 *   OPPORTUNITY_EXIT — superior opportunity exists
 */

import { PositionHealthState } from './fnf-position-health';

export enum ExitReason {
  THESIS = 'THESIS',
  RISK = 'RISK',
  EV = 'EV',
  OPPORTUNITY = 'OPPORTUNITY',
}

export interface ExitDecisionInput {
  currentPremium: number;
  entryPremium: number;
  stopPrice: number;
  targetPrice: number;
  healthState: string;
  thesisValid: boolean;
  underlyingConfirmed: boolean;
  unrealizedPnlPerUnit: number;
  maePerUnit: number;
  mfePerUnit: number;
  dte: number;
  currentEv: number;
  exitEv: number;
  nextBestEv: number;
  inProfit: boolean;
  profitExceedsThreshold: boolean;
  spreadPct: number | null;
}

export interface ExitDecision {
  shouldExit: boolean;
  exitReason: ExitReason | null;
  action: string;
  detail: string;
}

export function fnfEvaluateExit(input: ExitDecisionInput): ExitDecision {
  // 1. THESIS_EXIT: thesis invalidated
  if (!input.thesisValid) {
    return {
      shouldExit: true,
      exitReason: ExitReason.THESIS,
      action: 'EXIT',
      detail: `THESIS_EXIT: thesis invalidated — do not wait for stop`,
    };
  }

  // 2. RISK_EXIT: hard breach (below stop)
  if (input.currentPremium <= input.stopPrice) {
    return {
      shouldExit: true,
      exitReason: ExitReason.RISK,
      action: 'EXIT',
      detail: `RISK_EXIT: premium ${input.currentPremium.toFixed(2)} <= stop ${input.stopPrice.toFixed(2)}`,
    };
  }

  // 2b. RISK_EXIT: health state is BLACK
  if (input.healthState === PositionHealthState.BLACK) {
    return {
      shouldExit: true,
      exitReason: ExitReason.RISK,
      action: 'EXIT',
      detail: `RISK_EXIT: health state BLACK — mandatory exit`,
    };
  }

  // 3. EV_EXIT: negative EV on current hold
  if (input.currentEv < 0 && input.exitEv > 0) {
    return {
      shouldExit: true,
      exitReason: ExitReason.EV,
      action: 'EXIT',
      detail: `EV_EXIT: current EV ${input.currentEv.toFixed(2)} < 0, exit EV ${input.exitEv.toFixed(2)} > 0`,
    };
  }

  // 4. OPPORTUNITY_EXIT: superior opportunity exists
  if (input.nextBestEv > input.currentEv * 2 && input.nextBestEv > 5) {
    return {
      shouldExit: true,
      exitReason: ExitReason.OPPORTUNITY,
      action: 'EXIT',
      detail: `OPPORTUNITY_EXIT: next best EV ${input.nextBestEv.toFixed(2)} >> current ${input.currentEv.toFixed(2)}`,
    };
  }

  // Profit protection
  if (input.profitExceedsThreshold && input.mfePerUnit > 0) {
    // In profit lock — protect gains
    return {
      shouldExit: false,
      exitReason: null,
      action: 'TRAIL',
      detail: `PROFIT_PROTECT: MFE ₹${input.mfePerUnit.toFixed(1)}, trailing stop active`,
    };
  }

  // Target hit
  if (input.currentPremium >= input.targetPrice) {
    return {
      shouldExit: true,
      exitReason: ExitReason.RISK,
      action: 'EXIT',
      detail: `TARGET_HIT: premium ${input.currentPremium.toFixed(2)} >= target ${input.targetPrice.toFixed(2)}`,
    };
  }

  // Near expiry — reduce risk
  if (input.dte <= 1 && input.inProfit) {
    return {
      shouldExit: true,
      exitReason: ExitReason.RISK,
      action: 'EXIT',
      detail: `EXPIRY_PROFIT: DTE=${input.dte}, in profit — exit before expiry`,
    };
  }

  // Default: hold
  return {
    shouldExit: false,
    exitReason: null,
    action: 'HOLD',
    detail: `HOLD: position healthy, thesis intact, no exit trigger`,
  };
}
