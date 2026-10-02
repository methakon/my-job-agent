#!/usr/bin/env node
/**
 * PORTED EXIT LOGIC — dynamic, with an ATR trail ratchet.
 *
 * Logic ported from /home/swarna-sekhar-dhar/projects/cpp-trading-agent
 *   src/trading/upstox-live-paper/upstox-live-paper-entry-policy.ts (evaluateExitV1)
 *   src/trading/fnf-position-health.ts        (health state machine)
 *   src/trading/fnf-trap-detection.ts         (traps)
 * READ ONLY: nothing in that project was modified.
 *
 * The valuable part of their exit design is the TRAIL RATCHET: the stop is
 * recomputed each pass from the running high-water mark, so a winner's boundary
 * rises with the position, and it can only ever ratchet UP — their code
 * explicitly clamps `if (stop < initialStop) stop = initialStop`, which is the
 * same anti-widening rule this engine already enforces.
 *
 * ── What is DELIBERATELY different ──────────────────────────────────────
 * Their TIME_STOP at 15:15 on expiry day is a fixed holding-time veto, which is
 * forbidden here. It is ported as TIME_PRESSURE: it does not by itself close
 * anything, it raises urgency so the OTHER conditions (expectancy decay, time to
 * settlement) become far more likely to fire before the close.
 *
 * Their HEALTH machine maps to my REDUCE action: ORANGE reduces, BLACK exits.
 * A health state is evidence, not a verdict, so ORANGE reduces rather than
 * exits — which is exactly the HOLD/REDUCE/EXIT vocabulary this engine uses.
 *
 * Their traps map to my exit reasons. A trap that is DATA_QUALITY still means
 * "no decision", never "exit" — missing data must never manufacture a fill.
 */
'use strict';

const EXIT_REASON = {
  TRAIL: 'TRAIL_2X_ATR',
  STRUCTURAL_STOP: 'STRUCTURAL_STOP',
  SETUP_INVALIDATED: 'SETUP_INVALIDATED',
  REVERSAL_EXHAUSTION: 'REVERSAL_EXHAUSTION',
  HEALTH_BLACK: 'HEALTH_BLACK',
  TRAP: 'TRAP',
  EXPECTANCY_DECAY: 'EXPECTANCY_DECAY',
  TIME_PRESSURE: 'TIME_PRESSURE',
  END_OF_SESSION: 'END_OF_SESSION',
};

const EXIT_THRESHOLDS = {
  trailAtrMultiple: 2.0,
  minReversalScore: 0.60,
  // health
  maeBlackFraction: 0.80,        // MAE beyond this fraction of original risk
  staleBlackMultiplier: 2.0,     // quote age vs the staleness budget
  wideSpreadPct: 5.0,
  yellowDte: 3,
  // traps
  trapQuoteAgeMultiplier: 1.0,
  thetaDecayDte: 2,
  thetaDecayDelta: 0.10,
  liquidityTrapSpreadPct: 3.0,
  liquidityTrapVolume: 100,
};

/**
 * The trail ratchet, ported.
 *
 * `highestLtp` is the running high-water mark since entry, so the trail is
 * reconstructed from the path taken rather than accumulated — which means a
 * restart cannot lose the trail.
 */
function ratchetedStop({ initialStop, entryPrice, ltp, highestLtp, optionAtr, trailAtrMultiple = EXIT_THRESHOLDS.trailAtrMultiple }) {
  const highest = Number.isFinite(Number(highestLtp)) ? Number(highestLtp) : ltp;
  let stop = (Number.isFinite(Number(initialStop)) && Number(initialStop) > 0) ? Number(initialStop) : entryPrice;
  if (Number.isFinite(Number(optionAtr)) && Number(optionAtr) > 0) {
    const trailed = highest - trailAtrMultiple * Number(optionAtr);
    if (trailed > stop) stop = trailed;
  }
  // Anti-widen clamp, ported verbatim in spirit: the boundary never relaxes.
  const widened = stop < initialStop;
  if (widened) stop = initialStop;
  return { stop: Number(stop.toFixed(4)), trailedAboveInitial: stop > initialStop, widestPrevented: widened };
}

/**
 * Position health, ported from fnf-position-health.ts.
 * GREEN hold · YELLOW watch · ORANGE reduce · BLACK exit.
 */
function positionHealth({ entryPrice, currentPremium, initialStop, maePts, mfePts, quoteAgeMin, maxStaleMin, volume, spreadPct, dte, traps = [], thesisValid = true, underlyingConfirmed = true }) {
  const originalRisk = Math.max(0.0001, entryPrice - initialStop);
  const reasons = [];

  if (thesisValid === false && underlyingConfirmed === false) reasons.push('thesis invalid and underlying unconfirmed');
  else if (thesisValid === false || underlyingConfirmed === false) reasons.push('thesis or underlying unconfirmed');
  if (Number(maePts) < 0 && Math.abs(maePts) > originalRisk * EXIT_THRESHOLDS.maeBlackFraction) {
    reasons.push(`adverse excursion ${Math.abs(maePts).toFixed(2)} is ${(Math.abs(maePts) / originalRisk * 100).toFixed(0)}% of original risk`);
  }

  const dataBlack = (quoteAgeMin !== null && quoteAgeMin !== undefined && maxStaleMin > 0
    && quoteAgeMin > maxStaleMin * EXIT_THRESHOLDS.staleBlackMultiplier);
  if (dataBlack) reasons.push(`quote ${quoteAgeMin.toFixed(1)}min old (budget ${maxStaleMin}min)`);
  if (volume === 0 && spreadPct !== null && spreadPct > EXIT_THRESHOLDS.wideSpreadPct) {
    reasons.push(`no volume and spread ${spreadPct.toFixed(1)}%`);
  }
  const highSeverity = traps.filter((t) => t.severity === 'high' || t.severity === 'critical');

  let state = 'GREEN';
  if (dataBlack || highSeverity.length) state = 'BLACK';
  else if (reasons.length) state = 'ORANGE';
  else if ((dte !== null && dte !== undefined && dte <= EXIT_THRESHOLDS.yellowDte)
    || traps.length
    || (spreadPct !== null && spreadPct > 2.0)) state = 'YELLOW';

  return { state, reasons, highSeverityCount: highSeverity.length, originalRisk: Number(originalRisk.toFixed(2)) };
}

/** Traps, ported. Data-quality traps NEVER justify a fill. */
function detectTraps({ dte, delta, quoteAgeMin, maxStaleMin, volume, spreadPct, iv }) {
  const traps = [];
  if (quoteAgeMin !== null && quoteAgeMin !== undefined && maxStaleMin > 0
    && quoteAgeMin > maxStaleMin * EXIT_THRESHOLDS.trapQuoteAgeMultiplier) {
    traps.push({ name: 'data_quality', severity: 'critical', score: 95, why: `quote ${quoteAgeMin.toFixed(1)}min old` });
  }
  if (dte !== null && dte <= EXIT_THRESHOLDS.thetaDecayDte
    && delta !== null && delta !== undefined && Math.abs(delta) < EXIT_THRESHOLDS.thetaDecayDelta) {
    traps.push({ name: 'theta_decay', severity: dte === 0 ? 'critical' : 'high', score: dte === 0 ? 90 : 70, why: `dte ${dte}, |delta| ${Math.abs(delta).toFixed(3)}` });
  }
  if (spreadPct !== null && spreadPct > EXIT_THRESHOLDS.liquidityTrapSpreadPct
    && volume !== null && volume < EXIT_THRESHOLDS.liquidityTrapVolume) {
    traps.push({ name: 'liquidity_trap', severity: 'high', score: 75, why: `spread ${spreadPct.toFixed(1)}% on ${volume} volume` });
  }
  if (iv !== null && iv !== undefined && dte !== null && dte <= 1) {
    // informational only; never a veto on its own
    if (dte <= 1) traps.push({ name: 'pin_risk', severity: 'low', score: 40, why: `dte ${dte}` });
  }
  const aggregate = traps.length ? Math.min(100, traps.reduce((a, t) => a + t.score, 0) / traps.length) : 0;
  return { traps, aggregateScore: aggregate };
}

/**
 * Full exit decision. Every condition is evaluated; the order is the source's,
 * with the one forbidden fixed rule demoted to a pressure signal.
 */
function evaluateExit({
  ltp, entryPrice, initialStop, highestLtp, optionAtr,
  maePts, mfePts, quoteAgeMin, maxStaleMin, volume, spreadPct, volumeReported,
  dte = null, delta = null, iv = null,
  adverseReversalScore = null, setupInvalidated = false,
  nowIstMinutes = null, expiryIsToday = false, sessionCloseMinutes = 15 * 60 + 30,
  thresholds = {},
}) {
  const t = { ...EXIT_THRESHOLDS, ...thresholds };
  if (!(ltp > 0)) return { action: 'HOLD', reason: null, why: 'no live premium — no decision' };

  const { stop, trailedAboveInitial } = ratchetedStop({ initialStop, entryPrice, ltp, highestLtp, optionAtr, trailAtrMultiple: t.trailAtrMultiple });
  const { traps, aggregateScore } = detectTraps({ dte, delta, quoteAgeMin, maxStaleMin, volume, spreadPct, iv });

  // ── time pressure: NOT a veto, a multiplier on urgency
  let timePressure = 0;
  if (Number.isFinite(nowIstMinutes)) {
    const remaining = sessionCloseMinutes - nowIstMinutes;
    if (remaining <= 30) timePressure = 1;
    else if (remaining <= 60) timePressure = 0.6;
    if (expiryIsToday && remaining <= 45) timePressure = Math.max(timePressure, 0.8);
  }

  const health = positionHealth({
    entryPrice, currentPremium: ltp, initialStop, maePts, mfePts,
    quoteAgeMin, maxStaleMin, volume, spreadPct, dte, traps,
  });

  const base = {
    stop, trailedAboveInitial, health: health.state, healthReasons: health.reasons,
    traps: traps.map((x) => x.name), trapScore: aggregateScore, timePressure,
  };

  // 1. The structural/trailed boundary. Always first, always enforced.
  if (ltp <= stop) {
    return {
      ...base, action: 'EXIT',
      reason: trailedAboveInitial ? EXIT_REASON.TRAIL : EXIT_REASON.STRUCTURAL_STOP,
      why: `ltp ${ltp.toFixed(2)} ${ltp <= stop ? '<=' : '>'} boundary ${stop.toFixed(2)} (${trailedAboveInitial ? 'ratcheted 2×ATR above entry' : 'pre-entry structural boundary'})`,
    };
  }

  // 2. Data quality: NO decision, and emphatically NOT a fill.
  if (health.state === 'BLACK' && health.reasons.some((r) => r.includes('quote') && r.includes('old'))) {
    return { ...base, action: 'HOLD', reason: null, blockedBy: 'QUOTE_TOO_OLD', why: 'data too old to decide — never a fill on absent data' };
  }

  // 3. Black health from a real trap (not from staleness).
  if (health.state === 'BLACK') {
    return { ...base, action: 'EXIT', reason: EXIT_REASON.TRAP, why: `black health: ${health.reasons.join('; ')}` };
  }

  // 4. Setup invalidated.
  if (setupInvalidated === true) {
    return { ...base, action: 'EXIT', reason: EXIT_REASON.SETUP_INVALIDATED, why: 'the premise of the trade no longer holds' };
  }

  // 5. Adverse reversal in the option itself.
  if (Number.isFinite(Number(adverseReversalScore)) && Number(adverseReversalScore) >= t.minReversalScore) {
    return { ...base, action: 'EXIT', reason: EXIT_REASON.REVERSAL_EXHAUSTION, why: `adverse reversal ${Number(adverseReversalScore).toFixed(3)} ≥ ${t.minReversalScore}` };
  }

  // 6. Expectancy decay under time pressure — this is where the forbidden
  //    fixed time stop becomes a real, evidence-based exit.
  const stopDistance = Math.max(0.01, entryPrice - initialStop);
  const rNow = (ltp - entryPrice) / stopDistance;
  if (timePressure >= 0.8 && rNow < 0.25) {
    return { ...base, action: 'REDUCE', reason: EXIT_REASON.TIME_PRESSURE, why: `${timePressure >= 0.8 ? 'settlement window' : 'late session'} with R ${rNow.toFixed(3)} — the remainder no longer pays for its risk` };
  }

  // 7. Orange health reduces rather than exits: evidence, not a verdict.
  if (health.state === 'ORANGE') {
    return { ...base, action: 'REDUCE', reason: EXIT_REASON.EXPECTANCY_DECAY, why: `orange health: ${health.reasons.join('; ')}` };
  }

  return { ...base, action: 'HOLD', reason: null, why: 'no exit condition met; boundary intact and edge still paying' };
}

module.exports = { EXIT_REASON, EXIT_THRESHOLDS, ratchetedStop, positionHealth, detectTraps, evaluateExit };