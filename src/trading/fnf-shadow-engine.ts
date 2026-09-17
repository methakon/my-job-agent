/**
 * FNF Shadow Engine — pre-entry shadow evaluation + continuous position monitoring.
 *
 * PRE-ENTRY: Every candidate that reaches the final entry stage must receive
 * a shadow-entry evaluation. Compares ENTER_NOW vs WAIT vs ALTERNATIVE_ENTRY.
 *
 * POST-ENTRY: On every fresh valid market snapshot, refresh all position metrics
 * and calculate counterfactual shadow actions.
 */

export enum ShadowAction {
  ENTER_NOW = 'ENTER_NOW',
  WAIT = 'WAIT',
  ALTERNATIVE = 'ALTERNATIVE_ENTRY',
  NO_TRADE = 'NO_TRADE',
  SHADOW_HOLD = 'SHADOW_HOLD',
  SHADOW_EXIT = 'SHADOW_EXIT',
  SHADOW_REDUCE = 'SHADOW_REDUCE',
  SHADOW_HEDGE = 'SHADOW_HEDGE',
  SHADOW_RECOVERY = 'SHADOW_RECOVERY',
  SHADOW_REENTRY = 'SHADOW_REENTRY',
  SHADOW_WAIT = 'SHADOW_WAIT',
}

export interface ShadowMarketData {
  premium: number;
  bid: number | null;
  ask: number | null;
  spreadPct: number;
  volume: number;
  openInterest: number;
  oiChange: number | null;
  iv: number | null;
  ivChange: number | null;
  dte: number;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  underlyingSpot: number;
  underlyingSma20: number | null;
  underlyingSma5: number | null;
  quoteAgeMin: number;
  maxStaleMin: number;
}

export interface ShadowEntryInput {
  market: ShadowMarketData;
  entryPremium: number;
  stopPerUnit: number;
  targetPerUnit: number;
  trapScore: number;
  regimeConfidence: number;
  underlyingConfirmed: boolean;
  chainConfirmed: boolean;
}

export interface ShadowEntryResult {
  action: ShadowAction;
  ev: number;
  expectedMove: number;
  liquidityCost: number;
  reasons: string[];
}

export function fnfShadowEntry(input: ShadowEntryInput): ShadowEntryResult {
  const { market, entryPremium, stopPerUnit, targetPerUnit } = input;
  const reasons: string[] = [];

  // Liquidity cost
  const spreadCost = market.spreadPct * entryPremium / 100;
  const liquidityCost = spreadCost;

  // Expected move estimation (simplified)
  const iv = market.iv ?? 0.20;
  const dteFactor = Math.sqrt(Math.max(market.dte, 1) / 365);
  const expectedMove = entryPremium * iv * dteFactor;

  // EV estimation: (probability of target - probability of stop) * avg_win - avg_loss
  const pTarget = Math.min(0.6, Math.max(0.1, 1 - (stopPerUnit / (stopPerUnit + targetPerUnit))));
  const pStop = 1 - pTarget;
  const ev = pTarget * targetPerUnit - pStop * stopPerUnit - liquidityCost;

  // ── Data quality gate ──
  if (market.quoteAgeMin > market.maxStaleMin) {
    reasons.push(`quote stale: ${market.quoteAgeMin}min > ${market.maxStaleMin}min`);
    return { action: ShadowAction.NO_TRADE, ev: 0, expectedMove, liquidityCost, reasons };
  }

  // ── Trap gate ──
  if (input.trapScore > 70) {
    reasons.push(`trap score ${input.trapScore.toFixed(0)} > 70 — high trap risk`);
    return { action: ShadowAction.NO_TRADE, ev: 0, expectedMove, liquidityCost, reasons };
  }

  // ── EV gate ──
  if (ev < 0) {
    reasons.push(`EV ${ev.toFixed(2)} < 0 — negative expected value`);
    return { action: ShadowAction.NO_TRADE, ev, expectedMove, liquidityCost, reasons };
  }

  // ── Regime / confirmation gate ──
  if (input.regimeConfidence < 40) {
    reasons.push(`regime confidence ${input.regimeConfidence.toFixed(0)} < 40`);
  }
  if (!input.underlyingConfirmed) {
    reasons.push('underlying trend unconfirmed');
  }
  if (!input.chainConfirmed) {
    reasons.push('chain data unconfirmed');
  }

  // ── Wait vs Enter decision ──
  if (ev < expectedMove * 0.3) {
    reasons.push(`EV ${ev.toFixed(2)} too small vs expected move ${expectedMove.toFixed(2)} — wait for better entry`);
    return { action: ShadowAction.WAIT, ev, expectedMove, liquidityCost, reasons };
  }

  if (input.trapScore > 40) {
    reasons.push(`trap score ${input.trapScore.toFixed(0)} elevated — prefer waiting`);
    return { action: ShadowAction.WAIT, ev, expectedMove, liquidityCost, reasons };
  }

  if (market.spreadPct > 2.0) {
    reasons.push(`spread ${market.spreadPct.toFixed(1)}% wide — prefer tighter entry`);
    return { action: ShadowAction.WAIT, ev, expectedMove, liquidityCost, reasons };
  }

  reasons.push(`EV ${ev.toFixed(2)}, exp_move ${expectedMove.toFixed(2)}, liquidity_cost ${liquidityCost.toFixed(2)}`);
  return { action: ShadowAction.ENTER_NOW, ev, expectedMove, liquidityCost, reasons };
}

// ── Post-Entry Position Monitoring ──────────────────────────────────────────

export interface PositionMonitorSnapshot {
  currentPremium: number;
  entryPremium: number;
  stopPrice: number;
  targetPrice: number;
  mae: number;
  mfe: number;
  currentPnlPerUnit: number;
  unrealizedPnlPerUnit: number;
  dte: number;
  underlyingSpot: number;
  underlyingSma20: number | null;
  delta: number | null;
  iv: number | null;
  volume: number;
  spreadPct: number;
  quoteAgeMin: number;
  maxStaleMin: number;
  trapScore: number;
  healthState: string;
  thesisValid: boolean;
  currentEv: number;
}

export interface ShadowMonitorResult {
  action: ShadowAction;
  reason: string;
  score: number;
  details: Record<string, unknown>;
}

export function fnfShadowMonitor(snap: PositionMonitorSnapshot): ShadowMonitorResult {
  const details: Record<string, unknown> = {};

  // 1. Below stop → EXIT
  if (snap.currentPremium <= snap.stopPrice) {
    return {
      action: ShadowAction.SHADOW_EXIT,
      reason: `below stop: ${snap.currentPremium.toFixed(2)} <= ${snap.stopPrice.toFixed(2)}`,
      score: 100,
      details: { trigger: 'stop_breach' },
    };
  }

  // 2. Target hit → EXIT
  if (snap.currentPremium >= snap.targetPrice) {
    return {
      action: ShadowAction.SHADOW_EXIT,
      reason: `target reached: ${snap.currentPremium.toFixed(2)} >= ${snap.targetPrice.toFixed(2)}`,
      score: 95,
      details: { trigger: 'target_hit' },
    };
  }

  // 3. Data quality failure → EXIT
  if (snap.quoteAgeMin > snap.maxStaleMin * 3) {
    return {
      action: ShadowAction.SHADOW_EXIT,
      reason: `data critically stale: ${snap.quoteAgeMin}min`,
      score: 95,
      details: { trigger: 'data_failure' },
    };
  }

  // 4. Thesis invalidated → EXIT
  if (!snap.thesisValid) {
    return {
      action: ShadowAction.SHADOW_EXIT,
      reason: 'thesis invalidated',
      score: 90,
      details: { trigger: 'thesis_exit' },
    };
  }

  // 5. High trap score + in loss → EXIT
  if (snap.trapScore > 70 && snap.currentPnlPerUnit < 0) {
    return {
      action: ShadowAction.SHADOW_EXIT,
      reason: `high trap score ${snap.trapScore.toFixed(0)} + in loss`,
      score: 85,
      details: { trigger: 'trap_exit' },
    };
  }

  // 6. ORANGE/RED health → REDUCE
  if (snap.healthState === 'RED' || snap.healthState === 'ORANGE') {
    return {
      action: ShadowAction.SHADOW_REDUCE,
      reason: `health ${snap.healthState} — reduce position`,
      score: 75,
      details: { trigger: 'health_reduce' },
    };
  }

  // 7. Profit lock: MFE > 1.5x original risk → TRAIL/HOLD
  const originalRisk = snap.entryPremium - snap.stopPrice;
  if (snap.mfe > originalRisk * 1.5 && snap.currentPnlPerUnit > 0) {
    return {
      action: ShadowAction.SHADOW_HOLD,
      reason: `profit lock: MFE ₹${snap.mfe.toFixed(1)} > 1.5x risk`,
      score: 60,
      details: { trigger: 'profit_trail' },
    };
  }

  // 8. Near expiry + small profit → EXIT
  if (snap.dte <= 1 && snap.currentPnlPerUnit > 0) {
    return {
      action: ShadowAction.SHADOW_EXIT,
      reason: `expiry exit: DTE=${snap.dte}, profit ₹${snap.currentPnlPerUnit.toFixed(1)}`,
      score: 70,
      details: { trigger: 'expiry_exit' },
    };
  }

  // 9. Negative EV → EXIT
  if (snap.currentEv < 0) {
    return {
      action: ShadowAction.SHADOW_EXIT,
      reason: `negative EV: ${snap.currentEv.toFixed(2)}`,
      score: 65,
      details: { trigger: 'ev_exit' },
    };
  }

  // 10. YELLOW health → WAIT (increased monitoring)
  if (snap.healthState === 'YELLOW') {
    return {
      action: ShadowAction.SHADOW_WAIT,
      reason: 'YELLOW health — monitoring intensified',
      score: 40,
      details: { trigger: 'health_watch' },
    };
  }

  // Default: HOLD
  return {
    action: ShadowAction.SHADOW_HOLD,
    reason: 'position healthy — hold',
    score: 10,
    details: { trigger: 'default_hold' },
  };
}
