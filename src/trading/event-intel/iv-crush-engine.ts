/**
 * IV Crush Engine — Measures whether IV crush destroyed the trade edge.
 *
 * An option trade can have correct direction but still lose money if:
 *   - IV crush (vega loss) overwhelmed delta gains
 *   - Theta loss overwhelmed the spot move
 *   - Spread/slippage destroyed the remaining edge
 *
 * All functions are PURE.
 */

import { IVCrushInput, IVCrushResult } from './event-types';

// ── Pure functions ──────────────────────────────────────────────────────────

/**
 * Measure IV crush impact on an option trade.
 *
 * P&L components:
 *   deltaPnl = positionSize * delta * spotMove
 *   vegaPnl   = positionSize * vega * (postIV - preIV)
 *   thetaPnl  = -thetaLoss (already negative)
 *   txnCost   = -(spread + slippage) * positionSize
 *   netPnl    = deltaPnl + vegaPnl + thetaPnl + txnCost
 */
export function measureIVCrush(input: IVCrushInput): IVCrushResult {
  const deltaPnl = input.positionSize * input.optionDelta * input.actualSpotMove;
  const vegaPnl = input.positionSize * input.optionVega * (input.postEventATMIV - input.preEventATMIV);
  const thetaPnl = -Math.abs(input.thetaLoss);
  const transactionCostPnl = -(input.spread + input.slippage) * input.positionSize;
  const netPnl = deltaPnl + vegaPnl + thetaPnl + transactionCostPnl;

  // Direction correct = spot move aligns with delta sign
  const directionCorrect =
    (input.optionDelta > 0 && input.actualSpotMove > 0) ||
    (input.optionDelta < 0 && input.actualSpotMove < 0);

  // Did IV crush overwhelm delta gains?
  const ivCrushOverwhelmedDelta = directionCorrect && vegaPnl < -Math.abs(deltaPnl);

  // Did theta overwhelm the move?
  const thetaOverwhelmedMove = directionCorrect && Math.abs(thetaPnl) > Math.abs(deltaPnl);

  // Did transaction costs destroy the edge?
  const transactionCostsDestroyedEdge =
    directionCorrect && Math.abs(transactionCostPnl) > Math.abs(deltaPnl + vegaPnl);

  const optionProfitable = netPnl > 0;

  const breakdown = [
    `delta=${deltaPnl.toFixed(2)}`,
    `vega=${vegaPnl.toFixed(2)}`,
    `theta=${thetaPnl.toFixed(2)}`,
    `txnCost=${transactionCostPnl.toFixed(2)}`,
    `net=${netPnl.toFixed(2)}`,
    directionCorrect ? 'DIR_CORRECT' : 'DIR_WRONG',
    ivCrushOverwhelmedDelta ? 'IV_CRUSHED_DELTA' : '',
    thetaOverwhelmedMove ? 'THETA_KILLED' : '',
    transactionCostsDestroyedEdge ? 'EDGE_DESTROYED' : '',
  ]
    .filter(Boolean)
    .join(' | ');

  return {
    directionCorrect,
    optionProfitable,
    ivCrushOverwhelmedDelta,
    thetaOverwhelmedMove,
    transactionCostsDestroyedEdge,
    netPnl: Math.round(netPnl * 100) / 100,
    deltaPnl: Math.round(deltaPnl * 100) / 100,
    vegaPnl: Math.round(vegaPnl * 100) / 100,
    thetaPnl: Math.round(thetaPnl * 100) / 100,
    transactionCostPnl: Math.round(transactionCostPnl * 100) / 100,
    breakdown,
  };
}
