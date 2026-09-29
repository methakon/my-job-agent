#!/usr/bin/env node
/**
 * Expiry-day SETUPS A–H — observation/playbook definitions.
 *
 * Every setup is a HYPOTHESIS. None is armed. Each declares what it needs,
 * what confirms it, what kills it, and the data it requires — so a future
 * backtest can test the same definition rather than a moving target.
 *
 * A setup only ever produces a "candidate" tag. Sizing is NOT specified here
 * (deliberately): the existing FNF risk engine remains the sole sizing
 * authority, with its ceilings unchanged.
 */
'use strict';

const { VIEW } = require('./expiry-day-signals');

const SETUPS = {
  A_ORB_VWAP: {
    id: 'A_ORB_VWAP',
    name: 'Opening Range Breakout + VWAP confirmation',
    direction: 'TREND',
    regimeRequired: 'TREND',
    prerequisites: [
      'opening range (default 15 min) resolved',
      'close beyond OR boundary + buffer (not an intrabar poke)',
      'at least 2 closes outside the range',
    ],
    confirmation: [
      'VWAP held in the direction of the break (HOLDING_ABOVE / HOLDING_BELOW)',
      'volume at or above session baseline on the break bars',
    ],
    invalidation: [
      'close back inside the opening range',
      'VWAP lost against the direction of travel',
    ],
    expectedBehaviour: 'Continuation in the break direction while the retest holds.',
    dataRequired: ['index ticks (5m bars)', 'VWAP', 'volume', 'opening range'],
    historicalTestRequired: true,
    paperTradingRequired: true,
  },
  B_ORB_DOWN_VWAP: {
    id: 'B_ORB_DOWN_VWAP',
    name: 'Opening Range Breakdown + VWAP confirmation',
    direction: 'BEARISH',
    regimeRequired: 'TREND',
    prerequisites: ['opening range resolved', 'close below OR low − buffer', 'at least 2 closes outside'],
    confirmation: ['VWAP below and maintained', 'volume confirms on the break'],
    invalidation: ['close back inside the range', 'VWAP reclaimed'],
    expectedBehaviour: 'Continuation lower while the retest of the broken support holds.',
    dataRequired: ['index ticks (5m bars)', 'VWAP', 'volume', 'opening range'],
    historicalTestRequired: true,
    paperTradingRequired: true,
  },
  C_FAILED_BREAK: {
    id: 'C_FAILED_BREAK',
    name: 'Failed breakout + VWAP reversal',
    direction: 'REVERSAL',
    regimeRequired: 'REVERSAL',
    prerequisites: ['a genuine close beyond the OR boundary occurred', 'price has closed back inside the range'],
    confirmation: ['VWAP flip against the original break', 'opposite-side bar persistence'],
    invalidation: ['a fresh close beyond the range in the original direction'],
    expectedBehaviour: 'Mean-reversion back into the range against the failed break.',
    dataRequired: ['index ticks (5m bars)', 'VWAP', 'opening range'],
    historicalTestRequired: true,
    paperTradingRequired: true,
  },
  D_WALL_REJECTION: {
    id: 'D_WALL_REJECTION',
    name: 'Major OI-wall rejection + price-action confirmation',
    direction: 'RANGE',
    regimeRequired: 'PIN_RANGE',
    prerequisites: ['spot inside the wall corridor', 'an excursion beyond a wall that closed back inside'],
    confirmation: ['price-action rejection bar', 'VWAP reclaim toward the corridor midline'],
    invalidation: ['a close beyond the wall and hold (corridor broken)'],
    expectedBehaviour: 'Rejection of the wall level, price returning toward the corridor interior.',
    dataRequired: ['OI ladder (OI_STALE-aware)', 'index ticks', 'VWAP'],
    historicalTestRequired: true,
    paperTradingRequired: true,
    note: 'Walls are a RANGE/mean-reversion concept; they are never used as a directional breakout trigger on their own.',
  },
  E_WALL_BREAKOUT: {
    id: 'E_WALL_BREAKOUT',
    name: 'Wall breakout + volume confirmation + retest',
    direction: 'TREND',
    regimeRequired: 'TREND',
    prerequisites: ['close beyond a major OI wall with a buffer', 'wall level was a corridor boundary'],
    confirmation: ['volume expansion', 'retest of the broken wall holds', 'VWAP maintained beyond the wall'],
    invalidation: ['close back inside the corridor'],
    expectedBehaviour: 'Continuation after the wall is accepted by price.',
    dataRequired: ['OI ladder', 'index ticks', 'VWAP', 'volume'],
    historicalTestRequired: true,
    paperTradingRequired: true,
    note: 'Acceptance, not a poke. Single-bar breaches are treated as noise until volume and retest agree.',
  },
  F_ATM_MEAN_REVERSION: {
    id: 'F_ATM_MEAN_REVERSION',
    name: 'ATM / pin mean reversion',
    direction: 'RANGE',
    regimeRequired: 'PIN_RANGE',
    prerequisites: ['regime classified PIN_RANGE', 'realised range below implied move', 'price oscillating around a major strike'],
    confirmation: ['VWAP chop (multiple crossings)', 'boundary rejections', 'no volume-confirmed direction'],
    invalidation: ['a close beyond the range boundary', 'volume-expanding directional break'],
    expectedBehaviour: 'Fade excursions toward the corridor interior / magnet zone.',
    dataRequired: ['OI ladder', 'index ticks', 'VWAP', 'implied move'],
    historicalTestRequired: true,
    paperTradingRequired: true,
  },
  G_TREND_CONTINUATION: {
    id: 'G_TREND_CONTINUATION',
    name: 'Trend continuation after the first 15/30 minutes',
    direction: 'TREND',
    regimeRequired: 'TREND',
    prerequisites: ['regime already TREND after the first 15–30 min', 'pullback toward VWAP or broken level'],
    confirmation: ['VWAP reclaim in the trend direction', 'volume on the continuation bar'],
    invalidation: ['loss of VWAP', 'range re-entry'],
    expectedBehaviour: 'Second leg of an established intraday trend.',
    dataRequired: ['index ticks (5m bars)', 'VWAP', 'volume'],
    historicalTestRequired: true,
    paperTradingRequired: true,
  },
  H_NO_TRADE: {
    id: 'H_NO_TRADE',
    name: 'No trade — conflicting or insufficient evidence',
    direction: 'NO_TRADE',
    regimeRequired: 'ANY',
    prerequisites: ['signal conflict', 'insufficient usable buckets', 'stale data', 'cost gate fails', 'policy not approved'],
    confirmation: ['any critical gate in evaluateTradeable() fails'],
    invalidation: ['a later, cleaner cycle supplies agreeing evidence'],
    expectedBehaviour: 'Sit out. This is a SUCCESS outcome, not a failure.',
    dataRequired: ['any'],
    historicalTestRequired: false,
    paperTradingRequired: true,
  },
};

/**
 * Tag candidate setups from a classification + tradeability verdict. Pure.
 * Returns candidate tags with reasons; never a trade instruction.
 */
function tagSetups({ direction, tradeable, regime, or, vwapState, walls, spot, impliedMovePts }) {
  const out = [];
  const reg = regime?.regime ?? 'UNKNOWN';
  const upBreak = or?.closePos === 'UP';
  const dnBreak = or?.closePos === 'DOWN';

  if (direction?.view === VIEW.NO_TRADE || !tradeable?.tradeable) {
    out.push({ setup: SETUPS.H_NO_TRADE.id, why: tradeable?.blocking?.length ? `blocked: ${tradeable.blocking.join(', ')}` : 'direction view is NO_TRADE' });
  }
  if (reg === 'TREND' && upBreak && or?.held && ['HOLDING_ABOVE', 'RECLAIM', 'FLIP_RECLAIM'].includes(vwapState?.state)) {
    out.push({ setup: SETUPS.A_ORB_VWAP.id, why: 'held ORB up + VWAP maintained above' });
  }
  if (reg === 'TREND' && dnBreak && or?.held && ['HOLDING_BELOW', 'REJECT', 'FLIP_REJECT'].includes(vwapState?.state)) {
    out.push({ setup: SETUPS.B_ORB_DOWN_VWAP.id, why: 'held ORB down + VWAP maintained below' });
  }
  if (reg === 'REVERSAL' || or?.breakFailed) {
    out.push({ setup: SETUPS.C_FAILED_BREAK.id, why: 'failed/false opening-range break' });
  }
  if (reg === 'PIN_RANGE') {
    out.push({ setup: SETUPS.F_ATM_MEAN_REVERSION.id, why: 'PIN_RANGE regime' });
    if (walls && Number.isFinite(spot) && spot > walls.putWall.strike && spot < walls.callWall.strike) {
      out.push({ setup: SETUPS.D_WALL_REJECTION.id, why: 'spot inside wall corridor in a pin regime' });
    }
  }
  if (reg === 'TREND' && walls && Number.isFinite(spot) && (spot > walls.callWall.strike || spot < walls.putWall.strike)) {
    out.push({ setup: SETUPS.E_WALL_BREAKOUT.id, why: 'spot outside wall corridor with a held break (acceptance assumed)' });
  }
  if (reg === 'TREND' && or?.barsOutside >= 3) {
    out.push({ setup: SETUPS.G_TREND_CONTINUATION.id, why: 'sustained trend after the opening window' });
  }
  return { candidates: out, impliedMovePts, note: 'candidate tags only — no sizing, no order routing' };
}

module.exports = { SETUPS, tagSetups };
