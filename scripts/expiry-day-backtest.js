#!/usr/bin/env node
/**
 * expiry-day backtest — honest measurement of the setups A–H.
 *
 * Verified data reality on 2026-09-29:
 *   - NIFTY/BANKNIFTY 2026-09-29 is the FIRST expiry day we have ever captured.
 *     `unified_market_snapshots_history` has index tapes for 2026-09-09 … 09-28
 *     and NONE of those dates is an expiry day (last-Tuesday / weekly Tuesday).
 *   - `unified_option_quotes_history` has option ladders only for 09-09 … 09-28.
 *   - No index-futures tape, no breadth feed, no order-book depth on the index.
 *
 * Therefore this backtest currently has ZERO expiry sessions to measure and its
 * correct, non-fabricated output is INSUFFICIENT_DATA with an explicit
 * collection plan. It computes real statistics the moment expiry sessions
 * exist — it does not simulate, interpolate or extrapolate them.
 */
'use strict';

const C = require('./expiry-day-core');
const { INDEXES } = require('./expiry-day-analysis');

/**
 * Numeric-only extraction. Number(null) is 0 and Number('') is 0, so a naive
 * .map(Number) silently turns "this trade never hit its target" into a
 * 0-minute time-to-target and drags every average down.
 */
function numOnly(values) {
  return values
    .filter((v) => v !== null && v !== undefined && v !== '')
    .map(Number)
    .filter(Number.isFinite);
}

/** Metrics for one set of hypothetical trades. Pure. */
function tradeMetrics(trades) {
  const n = trades.length;
  if (!n) {
    return { n: 0, winRate: null, expectancy: null, profitFactor: null, avgReturn: null, medianReturn: null, maxDrawdownPts: null, note: 'no occurrences' };
  }
  const rets = numOnly(trades.map((t) => t.returnPts)).sort((a, b) => a - b);
  const wins = rets.filter((r) => r > 0);
  const losses = rets.filter((r) => r <= 0);
  const grossWin = wins.reduce((a, r) => a + r, 0);
  const grossLoss = Math.abs(losses.reduce((a, r) => a + r, 0));
  const equity = []; let eq = 0; let peak = 0; let maxDd = 0;
  for (const r of rets) { eq += r; peak = Math.max(peak, eq); maxDd = Math.max(maxDd, peak - eq); }
  const mae = numOnly(trades.map((t) => t.maePts));
  const mfe = numOnly(trades.map((t) => t.mfePts));
  const ttTarget = numOnly(trades.map((t) => t.timeToTargetMin));
  const ttInval = numOnly(trades.map((t) => t.timeToInvalidationMin));
  const slip = numOnly(trades.map((t) => t.slippagePts));
  const median = (a) => (a.length ? (a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2) : null);
  return {
    n,
    winRate: C.r2(wins.length / n, 4),
    avgReturn: C.r2(rets.reduce((a, r) => a + r, 0) / n, 3),
    medianReturn: C.r2(median(rets), 3),
    avgWin: wins.length ? C.r2(grossWin / wins.length, 3) : null,
    avgLoss: losses.length ? C.r2(grossLoss / losses.length, 3) : null,
    profitFactor: grossLoss > 0 ? C.r2(grossWin / grossLoss, 3) : (grossWin > 0 ? 'INFINITE_NO_LOSSES' : null),
    expectancy: C.r2(rets.reduce((a, r) => a + r, 0) / n, 3),
    maxDrawdownPts: C.r2(maxDd, 3),
    avgMAE: mae.length ? C.r2(mae.reduce((a, x) => a + x, 0) / mae.length, 3) : null,
    avgMFE: mfe.length ? C.r2(mfe.reduce((a, x) => a + x, 0) / mfe.length, 3) : null,
    avgSlippagePts: slip.length ? C.r2(slip.reduce((a, x) => a + x, 0) / slip.length, 3) : null,
    medianTimeToTargetMin: ttTarget.length ? C.r2(median(ttTarget), 1) : null,
    medianTimeToInvalidationMin: ttInval.length ? C.r2(median(ttInval), 1) : null,
    falseBreakRate: trades.filter((t) => t.falseBreak === true).length / n,
  };
}

/**
 * Chronological split for walk-forward validation. Strictly time-ordered, and
 * it NEVER tunes on the out-of-sample slice.
 */
function splitWalkForward(sessions, { trainFrac = 0.6, valFrac = 0.2 } = {}) {
  const s = [...sessions].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  if (!s.length) return { train: [], validation: [], outOfSample: [], note: 'no sessions' };
  const nTrain = Math.floor(s.length * trainFrac);
  const nVal = Math.floor(s.length * valFrac);
  return {
    train: s.slice(0, nTrain),
    validation: s.slice(nTrain, nTrain + nVal),
    outOfSample: s.slice(nTrain + nVal),
    note: 'time-ordered split; thresholds tuned on TRAIN only, reported on VALIDATION and OUT-OF-SAMPLE separately',
  };
}

/** Flag a threshold as OVERFIT when it only works on the training slice. */
function overfitCheck({ trainMetric, oosMetric, minSample = 20 }) {
  if (trainMetric?.n === undefined || trainMetric.n === null) return { verdict: 'NOT_ASSESSABLE', reason: 'no training sample' };
  if (trainMetric.n < minSample) return { verdict: 'INSUFFICIENT_SAMPLE', reason: `${trainMetric.n} training occurrences < ${minSample}` };
  if (oosMetric?.n === undefined || oosMetric.n === null || oosMetric.n === 0) return { verdict: 'NO_OOS_DATA', reason: 'out-of-sample slice is empty' };
  const tr = trainMetric.expectancy ?? 0;
  const oo = oosMetric.expectancy ?? 0;
  const degrades = tr > 0 && oo <= 0;
  const shrinks = tr > 0 && oo < tr * 0.4;
  return {
    verdict: degrades ? 'OVERFIT' : shrinks ? 'DEGRADED' : 'STABLE',
    trainExpectancy: tr, oosExpectancy: oo,
    reason: degrades ? 'positive in train, non-positive out-of-sample'
      : shrinks ? 'out-of-sample expectancy below 40% of train' : 'sign and magnitude broadly hold',
  };
}

/**
 * Which expiry dates we actually hold index tapes for, and which of those are
 * expiry days. Pure given the tape's date list.
 */
function classifySessionDates(dates, { expiryDates = [] } = {}) {
  const ex = new Set(expiryDates);
  return dates.map((d) => ({ date: String(d).slice(0, 10), isExpiry: ex.has(String(d).slice(0, 10)) }));
}

/**
 * A backtest RUN report. When there are no expiry sessions the report is an
 * explicit refusal with a collection plan — that is the successful outcome.
 */
function buildRun({ indexKey, sessions, setupResults = {}, splits = null, thresholdsUsed = {} }) {
  const expirySessions = (sessions || []).filter((s) => s.isExpiry);
  const status = expirySessions.length >= 20 ? 'MEASURABLE' : 'INSUFFICIENT_DATA';
  return {
    index: indexKey,
    status,
    generatedAt: new Date().toISOString(),
    sessionInventory: {
      totalSessionsWithData: (sessions || []).length,
      expirySessions: expirySessions.length,
      minForConfidence: 20,
      byIndex: Object.fromEntries(Object.keys(INDEXES).map((k) => [k, 0])),
    },
    perSetup: Object.fromEntries(Object.entries(setupResults).map(([k, v]) => [k, tradeMetrics(v)])),
    walkForward: splits,
    thresholdsUsed,
    verdict: status === 'INSUFFICIENT_DATA'
      ? 'NO_VALIDATION_POSSIBLE — expiry sessions have not been captured yet. The setups remain HYPOTHESES and must not be armed.'
      : 'measurable; see per-setup metrics and the walk-forward slices',
    nextActions: status === 'INSUFFICIENT_DATA' ? [
      `Capture index ticks + option ladder on every NIFTY/BANKNIFTY Tuesday and SENSEX Thursday for at least 20 expiries (≈20 weeks).`,
      'Start an index-futures tape if FUTURES_BASIS is ever to be a live bucket (currently it abstains).',
      'Intraday component/breadth feed needed for BREADTH_SCORE (currently abstains).',
      'Only after ≥20 expiry sessions: run this backtest, then walk-forward TRAIN/VALIDATION/OOS, then paper-trade in shadow mode.',
    ] : ['review per-setup metrics', 'verify OOS stability', 'paper-trade before any arming decision'],
  };
}

module.exports = { tradeMetrics, splitWalkForward, overfitCheck, classifySessionDates, buildRun };
