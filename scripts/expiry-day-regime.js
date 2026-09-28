#!/usr/bin/env node
/**
 * Expiry-day REGIME classifier — pure, deterministic.
 *
 * Separates the three regimes the playbook cares about, and refuses to
 * classify when the evidence does not support one:
 *
 *   PIN_RANGE   price oscillates inside a corridor, realised < implied,
 *               repeated boundary rejection, VWAP chops, volume unconvincing
 *   TREND       the opening range breaks AND holds, VWAP is maintained in the
 *               direction of travel, volume expands, structure persists
 *   REVERSAL    a break occurred, then failed: VWAP lost against the move,
 *               opposite-side momentum, price back inside the range
 *   UNKNOWN     not enough bars / not enough evidence — a first-class outcome
 *
 * Every hypothesis is a claim to be validated on our own Indian index data. We
 * have no historical expiry sessions yet (see expiry-day-backtest.js), so these
 * are STRUCTURED OBSERVATIONS, not validated edge.
 */
'use strict';

const C = require('./expiry-day-core');

const REGIME = {
  PIN_RANGE: 'PIN_RANGE',
  TREND: 'TREND',
  REVERSAL: 'REVERSAL',
  UNKNOWN: 'UNKNOWN',
};

/**
 * Evidence checks, each returning {name, pass, weight, detail}. Weights are
 * deliberately modest and roughly equal so no single check can carry a regime
 * on its own — a wall or a max-pain level must never be sufficient by itself.
 */
function regimeEvidence({
  bars,
  or,                 // openingRangeState
  vwap,               // vwapReclaimState
  impliedMovePts,     // ATM straddle implied move (points); null if unavailable
  corridor,           // {low, high} reference corridor (e.g. wall band); optional
  volumeBaseline,     // median bar volume; null ⇒ volume checks abstain
  wallRejections,     // {up: n, down: n} counts of touches rejected at walls
  vwapCrosses,        // number of VWAP crossings over the session so far
}) {
  const ev = [];
  const add = (name, pass, weight, detail) => ev.push({ name, pass, weight, detail });

  // 1. opening range resolved?
  add('OR_RESOLVED', !!or?.ready, 1, or?.ready ? `OR ${or.orLow}-${or.orHigh}` : `bars=${or?.barsSeen ?? 0}`);

  // 2. break held beyond the range?
  add('BREAK_HELD', or?.held === true, 2, `closePos=${or?.closePos} barsOutside=${or?.barsOutside} retest=${or?.held !== true && or?.closePos !== 'INSIDE'}`);
  // 3. or still contained inside the range?
  add('CONTAINED_IN_RANGE', or?.closePos === 'INSIDE', 2, `closePos=${or?.closePos}`);

  // 4. VWAP maintained in the direction of travel?
  add('VWAP_WITH_MOVE', ['HOLDING_ABOVE', 'RECLAIM', 'FLIP_RECLAIM'].includes(vwap?.state), 1, `vwap=${vwap?.state}`);

  // 5. VWAP lost against the move (reversal)?
  add('VWAP_LOST', ['REJECT', 'FLIP_REJECT', 'HOLDING_BELOW'].includes(vwap?.state), 1, `vwap=${vwap?.state}`);

  // 6. realised range below the implied move ⇒ pin/range leaning
  const realised = C.realisedRange(bars);
  const withinImplied = (impliedMovePts && realised) ? realised.range <= impliedMovePts : null;
  add('REALISED_BELOW_IMPLIED', withinImplied === true ? true : null, 2,
    realised ? `realised=${realised.range} implied=${impliedMovePts ?? 'n/a'}` : 'no bars');

  // 7. repeated boundary rejection (pin signature)
  const rej = wallRejections || { up: 0, down: 0 };
  add('BOUNDARY_REJECTIONS', rej.up + rej.down >= 2, 2, `up=${rej.up} down=${rej.down}`);

  // 8. VWAP chop: many crossings, no persistence ⇒ pin signature
  add('VWAP_CHOP', (vwapCrosses ?? 0) >= 3, 1, `crosses=${vwapCrosses ?? 0}`);

  // 9. volume expanding with the move (trend signature)
  let volExpanding = null;
  if (volumeBaseline && bars && bars.length >= 3) {
    const recent = bars.slice(-2).map((b) => b.volume);
    volExpanding = recent.every((v) => v > volumeBaseline);
  }
  add('VOLUME_EXPANDING', volExpanding, 2, volExpanding === null ? 'abstain (no baseline)' : `recent=${bars.slice(-2).map((b) => b.volume).join(',')} baseline=${volumeBaseline}`);

  // 10. volume not confirming direction (pin signature)
  add('VOLUME_UNCONFIRMED', volExpanding === false ? true : null, 1, volExpanding === false ? 'recent volume below baseline' : 'abstain');

  // 11. a break that failed ⇒ reversal signature
  add('BREAK_FAILED', or?.breakFailed === true, 2, `breakFailed=${or?.breakFailed}`);

  // 12. directional persistence
  const pers = C.directionalPersistence(bars || [], 6);
  add('PERSISTENT_DIRECTION', Math.abs(pers.score) >= 0.5, 1, `score=${pers.score} dominant=${pers.dominant}`);

  // 13. corridor containment (walls band) — supporting only, never decisive
  if (corridor && realised) {
    const inside = realised.high <= corridor.high + (corridor.high - corridor.low) * 0.15
      && realised.low >= corridor.low - (corridor.low - corridor.high) * 0.15;
    add('INSIDE_WALL_CORRIDOR', inside, 1, `range=${realised.low}-${realised.high} corridor=${corridor.low}-${corridor.high}`);
  }

  return ev;
}

/**
 * Sum weights of passing checks. Abstentions (pass === null) are EXCLUDED from
 * the denominator: a check that cannot be evaluated carries no information, so
 * letting it dilute the score would let missing data veto a real trend. They
 * are still reported separately so the omission is visible.
 */
function scoreChecks(ev) {
  const passing = ev.filter((e) => e.pass === true);
  const abstained = ev.filter((e) => e.pass === null);
  const decidable = ev.filter((e) => e.pass !== null);
  const total = decidable.reduce((a, e) => a + e.weight, 0);
  const score = passing.reduce((a, e) => a + e.weight, 0);
  return {
    score,
    total,
    pctOfAvailable: total ? Number((score / total * 100).toFixed(1)) : 0,
    abstainedWeight: ev.reduce((a, e) => a + (e.pass === null ? e.weight : 0), 0),
    passingChecks: passing.map((e) => e.name),
    abstainedChecks: abstained.map((e) => e.name),
    failingChecks: ev.filter((e) => e.pass === false).map((e) => e.name),
  };
}

/**
 * Classify the regime. Thresholds are the ONLY tunable knobs and they are
 * inputs, so a backtest can sweep them explicitly rather than hiding a
 * fitted constant inside the engine.
 */
function classifyRegime(input, thresholds = {}) {
  const {
    trendMinPct = 45,       // share of available weight needed to call a trend
    pinMinPct = 45,
    minBars = 6,            // below this we refuse to classify
  } = thresholds;

  const bars = input.bars || [];
  if (bars.length < minBars) {
    return {
      regime: REGIME.UNKNOWN,
      reason: 'INSUFFICIENT_BARS',
      detail: `${bars.length} bar(s); need ${minBars}`,
      evidence: [], score: null, confidence: 0, validated: false,
    };
  }

  const ev = regimeEvidence(input);
  const sc = scoreChecks(ev);
  const has = (n) => ev.find((e) => e.name === n);

  // TREND needs a HELD break plus volume/structure agreement. A trend cannot be
  // called from a single poke, and never from a wall level alone.
  const trendOk = has('BREAK_HELD')?.pass === true
    && has('OR_RESOLVED')?.pass === true
    && (has('VOLUME_EXPANDING')?.pass === true || has('PERSISTENT_DIRECTION')?.pass === true)
    && sc.pctOfAvailable >= trendMinPct;

  // REVERSAL needs an actual failed break or a lost VWAP with containment.
  const reversalOk = (has('BREAK_FAILED')?.pass === true || has('VWAP_LOST')?.pass === true)
    && (has('CONTAINED_IN_RANGE')?.pass === true || has('VWAP_LOST')?.pass === true);

  // PIN needs containment + sub-implied realised movement + rejection/chop.
  const pinOk = has('CONTAINED_IN_RANGE')?.pass === true
    && (has('REALISED_BELOW_IMPLIED')?.pass === true || has('VWAP_CHOP')?.pass === true || has('BOUNDARY_REJECTIONS')?.pass === true)
    && sc.pctOfAvailable >= pinMinPct;

  let regime = REGIME.UNKNOWN;
  let reason = 'NO_CLEAR_REGIME';
  if (trendOk && !reversalOk) { regime = REGIME.TREND; reason = 'HELD_BREAK_WITH_CONFIRMATION'; }
  else if (reversalOk) { regime = REGIME.REVERSAL; reason = 'FAILED_BREAK_OR_VWAP_LOST'; }
  else if (pinOk && !trendOk) { regime = REGIME.PIN_RANGE; reason = 'CONTAINED_BELOW_IMPLIED'; }

  // Confidence is a share of available evidence, capped and explicitly marked
  // UNVALIDATED: with zero historical expiry sessions we have no calibration.
  const confidence = Math.round(Math.min(100, sc.pctOfAvailable));

  return {
    regime,
    reason,
    evidence: ev,
    score: sc,
    confidence,
    confidenceIsCalibrated: false,
    confidenceNote: 'share of available checks passed; NOT calibrated against historical expiry outcomes (no expiry sessions captured yet)',
    validated: false,
    validationNote: 'regime rules are hypotheses until out-of-sample tested on Indian index expiry data',
    directionHint: regime === REGIME.TREND
      ? (has('BREAK_HELD')?.detail?.includes('UP') ? 'UP' : 'UNSPECIFIED')
      : 'NONE',
  };
}

/**
 * Count wall rejections from bars: excursions beyond a level that closed back
 * inside. This is the measurable form of "rejected at the wall" — it never
 * assumes the wall holds, it counts what price actually did.
 */
function countBoundaryRejections(bars, level, side = 'UP') {
  if (!level || !bars || bars.length < 2) return 0;
  let n = 0;
  for (const b of bars) {
    const poked = side === 'UP' ? b.high > level : b.low < level;
    const closedBack = side === 'UP' ? b.close <= level : b.close >= level;
    if (poked && closedBack) n += 1;
  }
  return n;
}

/** Count VWAP crossings across bars. */
function countVwapCrosses(bars) {
  if (!bars || bars.length < 2) return 0;
  let n = 0;
  for (let i = 1; i < bars.length; i += 1) {
    const a = bars[i - 1].close - bars[i - 1].vwap;
    const b = bars[i].close - bars[i].vwap;
    if (Number.isFinite(a) && Number.isFinite(b) && Math.sign(a) !== Math.sign(b) && a !== 0 && b !== 0) n += 1;
  }
  return n;
}

/** Median bar volume — the volume baseline. Null when volume is absent. */
function medianVolume(bars) {
  const v = (bars || []).map((b) => Number(b.volume)).filter((x) => Number.isFinite(x) && x > 0);
  if (!v.length) return null;
  const s = [...v].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

module.exports = {
  REGIME, classifyRegime, regimeEvidence, scoreChecks,
  countBoundaryRejections, countVwapCrosses, medianVolume,
};
