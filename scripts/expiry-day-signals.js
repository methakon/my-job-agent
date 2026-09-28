#!/usr/bin/env node
/**
 * Expiry-day SIGNAL engine — pure, deterministic.
 *
 * Two strictly separated stages, because "bullish" and "buy a call" are
 * different questions:
 *
 *   STAGE 1  classifyDirection()  → an evidence-weighted MARKET VIEW with a
 *            confidence that is explicitly marked uncalibrated until we have
 *            historical expiry sessions.
 *   STAGE 2  evaluateTradeable()  → whether that view is even ACTABLE: location,
 *            liquidity, spread, IV, time, move-vs-cost, chase, R:R and policy.
 *            Any NO ⇒ NO TRADE, regardless of how bullish the view is.
 *
 * Design rules enforced here:
 *  - No single factor (max pain, PCR, a wall, IV) can set direction. Each is
 *    one bucket among many, and buckets with stale/missing data contribute
 *    ZERO, never a neutral vote.
 *  - Conflicting evidence produces WAIT_FOR_CONFIRMATION, not a forced side.
 *  - The engine never places, sizes or prices an order; it produces an
 *    explanation and an eligibility verdict.
 */
'use strict';

const C = require('./expiry-day-core');

const BUCKETS = [
  'PRICE_ACTION_SCORE', 'VOLUME_SCORE', 'VWAP_SCORE', 'OPENING_RANGE_SCORE',
  'FUTURES_BASIS_SCORE', 'OI_CHANGE_SCORE', 'OI_WALL_SCORE', 'IV_SCORE',
  'STRADDLE_SCORE', 'ORDERBOOK_SCORE', 'BREADTH_SCORE', 'MOMENTUM_SCORE',
  'GAP_SCORE', 'EXPIRY_MICROSTRUCTURE_SCORE', 'DELTA_HEDGING_SCORE',
];

const VIEW = {
  BULLISH: 'BULLISH', BEARISH: 'BEARISH', RANGE: 'RANGE',
  REVERSAL: 'REVERSAL', NO_TRADE: 'NO_TRADE',
};

/** One evidence record. `score` in [-1, 1]; `weight` scales it. */
function bucket(name, { score, confidence, dataAgeMs, bucket: fresh, reason, usable = true, at = null }) {
  const w = usable ? C.freshnessWeight(fresh) : 0;
  const s = usable && Number.isFinite(score) ? Math.max(-1, Math.min(1, score)) : 0;
  return {
    name,
    score: s,
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
    weight: w,
    contribution: Number((s * w).toFixed(6)),
    dataAgeMs: dataAgeMs ?? null,
    freshness: fresh ?? C.FRESHNESS.UNKNOWN,
    usable,
    reason: reason || 'no reason recorded',
    at,
  };
}

// ───────────────────────── individual bucket builders ─────────────────────

const builders = {
  PRICE_ACTION_SCORE: (i) => {
    if (!i.bars || i.bars.length < 3) return bucket('PRICE_ACTION_SCORE', { score: 0, usable: false, reason: 'insufficient bars' });
    const last = i.bars[i.bars.length - 1];
    const range = last.range || 1;
    const bodyScore = range > 0 ? last.body / range : 0;
    const dir = Math.sign(last.close - i.bars[i.bars.length - 3].close);
    return bucket('PRICE_ACTION_SCORE', {
      score: bodyScore * 0.5 + dir * 0.5,
      confidence: Math.min(0.7, i.bars.length / 12),
      dataAgeMs: i.dataFresh?.overallBucket === C.FRESHNESS.FRESH ? 0 : null,
      bucket: i.dataFresh?.overallBucket ?? C.FRESHNESS.UNKNOWN,
      reason: `last bar bodyRatio=${bodyScore.toFixed(2)} 2-bar drift=${dir}`,
    });
  },
  VOLUME_SCORE: (i) => {
    const b = i.bars || [];
    if (b.length < 3) return bucket('VOLUME_SCORE', { score: 0, usable: false, reason: 'insufficient bars for volume' });
    const vols = b.map((x) => Number(x.volume) || 0);
    if (vols.every((v) => v === 0)) return bucket('VOLUME_SCORE', { score: 0, usable: false, reason: 'volume absent on all bars (no confirmation available)' });
    const recent = vols.slice(-2);
    const base = vols.slice(0, -2);
    const mean = base.length ? base.reduce((a, x) => a + x, 0) / base.length : 0;
    const rel = mean > 0 ? (recent.reduce((a, x) => a + x, 0) / recent.length) / mean : null;
    if (rel === null) return bucket('VOLUME_SCORE', { score: 0, usable: false, reason: 'no baseline volume' });
    const up = b[b.length - 1].body >= 0 ? 1 : -1;
    return bucket('VOLUME_SCORE', {
      score: Math.max(-1, Math.min(1, (rel - 1))) * up,
      confidence: Math.min(0.6, base.length / 10),
      bucket: i.dataFresh?.overallBucket ?? C.FRESHNESS.UNKNOWN,
      reason: `recent/base=${rel.toFixed(2)} bar direction=${up >= 0 ? 'up' : 'down'}`,
    });
  },
  VWAP_SCORE: (i) => {
    if (!i.vwapState) return bucket('VWAP_SCORE', { score: 0, usable: false, reason: 'no VWAP (zero volume or no bars)' });
    const map = { HOLDING_ABOVE: 0.6, RECLAIM: 0.8, FLIP_RECLAIM: 1, AT_VWAP: 0, HOLDING_BELOW: -0.6, REJECT: -0.8, FLIP_REJECT: -1, UNKNOWN: 0 };
    const s = map[i.vwapState.state] ?? 0;
    return bucket('VWAP_SCORE', {
      score: s, confidence: 0.5, bucket: i.dataFresh?.overallBucket ?? C.FRESHNESS.FRESH,
      reason: `vwap state=${i.vwapState.state} crosses=${i.vwapState.crosses ?? 'n/a'}`,
      usable: i.vwapState.state !== 'UNKNOWN',
    });
  },
  OPENING_RANGE_SCORE: (i) => {
    const or = i.or;
    if (!or?.ready) return bucket('OPENING_RANGE_SCORE', { score: 0, usable: false, reason: `opening range not resolved (${or?.reason ?? 'no bars'})` });
    let s = 0;
    if (or.closePos === 'UP' && or.held === true) s = 0.9;
    else if (or.closePos === 'DOWN' && or.held === true) s = -0.9;
    else if (or.breakFailed) s = 0;                       // conflict is handled by REVERSAL
    else if (or.closePos === 'INSIDE') s = 0;
    else s = or.closePos === 'UP' ? 0.3 : -0.3;
    return bucket('OPENING_RANGE_SCORE', {
      score: s, confidence: 0.6, bucket: i.dataFresh?.overallBucket ?? C.FRESHNESS.FRESH,
      reason: `closePos=${or.closePos} held=${or.held} barsOutside=${or.barsOutside}`,
    });
  },
  // No index-futures tick history exists in our store (verified 2026-09-29), so
  // this bucket abstains honestly rather than inventing a basis.
  FUTURES_BASIS_SCORE: (i) => {
    if (i.futures && Number.isFinite(i.futures.price) && Number.isFinite(i.spot)) {
      const basisPct = ((i.futures.price - i.spot) / i.spot) * 100;
      return bucket('FUTURES_BASIS_SCORE', {
        score: Math.max(-1, Math.min(1, basisPct / 0.5)),
        confidence: 0.5, bucket: i.futuresFresh ?? C.FRESHNESS.FRESH,
        reason: `basis=${basisPct.toFixed(3)}%`,
      });
    }
    return bucket('FUTURES_BASIS_SCORE', { score: 0, usable: false, reason: 'NO FUTURES DATA CAPTURED — bucket abstains (cannot fabricate basis)' });
  },
  OI_CHANGE_SCORE: (i) => {
    if (i.dataFresh?.OI_STALE) return bucket('OI_CHANGE_SCORE', { score: 0, usable: false, reason: `OI_STALE (optionChainAge=${i.dataFresh.optionChainAgeMs}ms) — OI evidence removed` });
    const ch = i.oiChange;
    if (!ch || !Number.isFinite(ch.callChange) || !Number.isFinite(ch.putChange)) {
      return bucket('OI_CHANGE_SCORE', { score: 0, usable: false, reason: 'OI change unavailable' });
    }
    const total = ch.callChange + ch.putChange;
    if (total === 0) return bucket('OI_CHANGE_SCORE', { score: 0, usable: true, reason: 'no net OI build/unwind', confidence: 0.3 });
    // Call OI building with price up = supportive; call OI unwinding with price
    // up = short-cover (weaker). We only score the OI leg, direction comes from
    // price buckets — a single OI reading never sets direction.
    const skew = (ch.callChange - ch.putChange) / Math.max(1, Math.abs(ch.callChange) + Math.abs(ch.putChange));
    return bucket('OI_CHANGE_SCORE', {
      score: skew * 0.4, confidence: 0.4,
      bucket: i.dataFresh?.optionChainBucket ?? C.FRESHNESS.UNKNOWN,
      reason: `callChg=${ch.callChange} putChg=${ch.putChange} skew=${skew.toFixed(2)}`,
    });
  },
  OI_WALL_SCORE: (i) => {
    const spot = i.spot;
    const w = i.walls;
    if (!Number.isFinite(spot) || !w?.callWall || !w?.putWall) {
      return bucket('OI_WALL_SCORE', { score: 0, usable: false, reason: 'walls unavailable' });
    }
    // Walls only ever MODULATE conviction (as a corridor), never direction:
    // a price between the walls is a range observation, not a side.
    const inside = spot > w.putWall.strike && spot < w.callWall.strike;
    return bucket('OI_WALL_SCORE', {
      score: 0, confidence: 0.2, usable: true,
      bucket: i.dataFresh?.optionChainBucket ?? C.FRESHNESS.UNKNOWN,
      reason: inside
        ? `spot INSIDE wall corridor ${w.putWall.strike}-${w.callWall.strike} (range observation, no directional vote)`
        : `spot OUTSIDE wall corridor (${w.putWall.strike}-${w.callWall.strike}) — corridor broken, range thesis weakened`,
    });
  },
  IV_SCORE: (i) => {
    if (i.dataFresh?.optionChainBucket === C.FRESHNESS.UNKNOWN || !Number.isFinite(i.iv?.atm)) {
      return bucket('IV_SCORE', { score: 0, usable: false, reason: 'ATM IV unavailable' });
    }
    // Expired-today IV is a COST input, not a direction input. Neutral score
    // by design; the value is used later by the tradeability gate.
    return bucket('IV_SCORE', {
      score: 0, confidence: 0.5, usable: true,
      bucket: i.dataFresh?.optionChainBucket,
      reason: `ATM IV=${i.iv.atm.toFixed(2)}% skew25d=${i.iv.skew25d ?? 'n/a'}% (cost input, no directional vote)`,
    });
  },
  STRADDLE_SCORE: (i) => {
    const m = i.impliedMove;
    if (!m) return bucket('STRADDLE_SCORE', { score: 0, usable: false, reason: 'no ATM straddle (one leg unquoted)' });
    const realised = C.realisedRange(i.bars);
    const ratio = realised && m.impliedMovePts > 0 ? realised.range / m.impliedMovePts : null;
    // Below implied ⇒ compression/range lean; above ⇒ expansion. Signed by the
    // drift, but the magnitude is capped and never decisive alone.
    const drift = i.bars && i.bars.length > 1 ? Math.sign(i.bars[i.bars.length - 1].close - i.bars[0].open) : 0;
    return bucket('STRADDLE_SCORE', {
      score: ratio === null ? 0 : Math.max(-1, Math.min(1, (ratio - 1))) * 0.5 * (drift || 1),
      confidence: 0.4, bucket: i.dataFresh?.overallBucket ?? C.FRESHNESS.FRESH,
      reason: `realised/implied=${ratio === null ? 'n/a' : ratio.toFixed(2)} drift=${drift}`,
    });
  },
  ORDERBOOK_SCORE: (i) => {
    const q = i.quote;
    if (!q || !Number.isFinite(q.bidQty) || !Number.isFinite(q.askQty) || (q.bidQty + q.askQty) === 0) {
      return bucket('ORDERBOOK_SCORE', { score: 0, usable: false, reason: 'no top-of-book quantity (index tape has no bid/ask)' });
    }
    const imb = (q.bidQty - q.askQty) / (q.bidQty + q.askQty);
    return bucket('ORDERBOOK_SCORE', {
      score: Math.max(-1, Math.min(1, imb)), confidence: 0.3,
      bucket: i.dataFresh?.optionChainBucket ?? C.FRESHNESS.UNKNOWN,
      reason: `top-of-book imbalance=${imb.toFixed(3)} (bidQty=${q.bidQty} askQty=${q.askQty})`,
    });
  },
  // No breadth/OHLC component feed is captured (verified 2026-09-29).
  BREADTH_SCORE: () => bucket('BREADTH_SCORE', { score: 0, usable: false, reason: 'NO BREADTH DATA CAPTURED — bucket abstains (no component feed)' }),
  MOMENTUM_SCORE: (i) => {
    const p = C.directionalPersistence(i.bars || [], 6);
    if (p.total === 0) return bucket('MOMENTUM_SCORE', { score: 0, usable: false, reason: 'no closed bars to measure momentum' });
    return bucket('MOMENTUM_SCORE', {
      score: p.score, confidence: Math.min(0.5, p.total / 12),
      bucket: i.dataFresh?.overallBucket ?? C.FRESHNESS.FRESH,
      reason: `persistence=${p.score.toFixed(2)} (up ${p.up}/down ${p.down})`,
    });
  },
  GAP_SCORE: (i) => {
    if (!i.gap) return bucket('GAP_SCORE', { score: 0, usable: false, reason: 'no opening gap computed' });
    // A gap is a location fact, not a direction vote: it tells you where price
    // opened relative to the implied range, nothing more.
    return bucket('GAP_SCORE', {
      score: 0, confidence: 0.25, usable: true,
      reason: `${i.gap.class} (${i.gap.pct}%), open sits ${i.gap.position}`,
    });
  },
  // Expiry-microstructure: max pain / PCR / concentration / straddle all live
  // here as ONE weak, range-leaning bucket — explicitly not a direction source.
  EXPIRY_MICROSTRUCTURE_SCORE: (i) => {
    const m = i.microstructure;
    if (!m) return bucket('EXPIRY_MICROSTRUCTURE_SCORE', { score: 0, usable: false, reason: 'no OI microstructure snapshot' });
    const pcr = m.pcrOi;
    if (!Number.isFinite(pcr)) return bucket('EXPIRY_MICROSTRUCTURE_SCORE', { score: 0, usable: false, reason: 'PCR unavailable' });
    // PCR is a positioning/range statistic. Scoring it as a directional vote is
    // the exact failure mode this engine must avoid, so it scores 0 by design
    // and is reported as context only.
    return bucket('EXPIRY_MICROSTRUCTURE_SCORE', {
      score: 0, confidence: 0.2, usable: true,
      bucket: i.dataFresh?.optionChainBucket ?? C.FRESHNESS.UNKNOWN,
      reason: `PCR(OI)=${pcr} maxPain=${m.maxPain?.strike ?? 'n/a'} concentration(call)=${m.concentration?.callConcentrationPct ?? 'n/a'}% — context only, no directional vote`,
    });
  },
  // Dealer-gamma proxy from the OI ladder, clearly labelled an assumption.
  DELTA_HEDGING_SCORE: (i) => {
    const g = i.dealerGamma;
    if (!g) return bucket('DELTA_HEDGING_SCORE', { score: 0, usable: false, reason: 'no gamma estimate (needs sign of dealer book, which is NOT observable)' });
    return bucket('DELTA_HEDGING_SCORE', {
      score: 0, confidence: 0.15, usable: true,
      reason: `netGammaAssumption=${g.assumption} sign=${g.netGammaSign ?? 'n/a'} flip=${g.gammaFlip ?? 'n/a'} — assumption-dependent, low weight`,
    });
  },
};

/**
 * STAGE 1 — classify the market.
 * Returns a weighted view, the conflict flag, and an explicit NO_TRADE when
 * evidence is insufficient or in conflict.
 */
function classifyDirection(input, cfg = {}) {
  const {
    minUsableBuckets = 4,
    conflictThreshold = 0.55,   // |net| below this share of gross ⇒ conflict
    minNetForView = 0.12,
  } = cfg;

  const records = BUCKETS.map((name) => (builders[name] ? builders[name](input) : bucket(name, { score: 0, usable: false, reason: 'no builder' })));
  const usable = records.filter((r) => r.usable);
  const net = records.reduce((a, r) => a + r.contribution, 0);
  const gross = records.reduce((a, r) => a + Math.abs(r.contribution), 0);
  const bulls = usable.filter((r) => r.contribution > 0.05);
  const bears = usable.filter((r) => r.contribution < -0.05);
  const share = gross > 0 ? Math.abs(net) / gross : 0;
  const signalConflict = bulls.length > 0 && bears.length > 0 && share < conflictThreshold;
  const freshness = input.dataFresh?.overallBucket ?? C.FRESHNESS.UNKNOWN;

  const reasons = [];
  if (usable.length < minUsableBuckets) reasons.push(`only ${usable.length} usable evidence bucket(s), need ${minUsableBuckets}`);
  if (freshness === C.FRESHNESS.UNKNOWN) reasons.push('data freshness UNKNOWN');
  if (freshness === C.FRESHNESS.STALE) reasons.push(`data STALE (age=${input.dataFresh?.dataAgeMs}ms)`);
  if (signalConflict) reasons.push(`bullish buckets=${bulls.length} bearish=${bears.length}, agreement=${(share * 100).toFixed(0)}% < ${(conflictThreshold * 100).toFixed(0)}%`);

  let view = VIEW.NO_TRADE;
  if (reasons.length === 0) {
    if (input.regime?.regime === 'PIN_RANGE') view = VIEW.RANGE;
    else if (input.regime?.regime === 'REVERSAL') view = VIEW.REVERSAL;
    else if (Math.abs(net) >= minNetForView) view = net > 0 ? VIEW.BULLISH : VIEW.BEARISH;
    else reasons.push(`net evidence ${net.toFixed(3)} below minNetForView ${minNetForView}`);
  }

  return {
    view,
    netEvidence: Number(net.toFixed(6)),
    grossEvidence: Number(gross.toFixed(6)),
    agreementShare: Number(share.toFixed(4)),
    signalConflict,
    bullishEvidence: bulls.map((r) => r.name),
    bearishEvidence: bears.map((r) => r.name),
    neutralEvidence: usable.filter((r) => Math.abs(r.contribution) <= 0.05).map((r) => r.name),
    unusableBuckets: records.filter((r) => !r.usable).map((r) => r.name),
    confidence: Math.round(Math.min(100, share * 100)),
    confidenceIsCalibrated: false,
    confidenceNote: 'agreement share of contributing buckets, NOT calibrated to hit-rate; needs historical expiry sessions',
    buckets: records,
    whyNoTrade: reasons,
    dataFreshness: input.dataFresh ?? null,
    stage: 'DIRECTION_ONLY_NOT_A_TRADE',
  };
}

// ───────────────────── STAGE 2: tradeability gate ─────────────────────────

/**
 * Separates "the market looks bullish" from "there is a tradeable long here".
 * Ten explicit questions, any critical NO ⇒ NO TRADE. No sizing, no order.
 */
function evaluateTradeable(direction, entry, policy = {}) {
  const {
    maxSpreadPctOfMid = 5,
    minRemainingMinutes = 20,
    minExpectedMoveVsCost = 1.5,
    minRiskReward = 1.5,
    requireFreshness = C.FRESHNESS.AGING,   // at least AGING to act
    capitalFilter = null,                    // passed through, never reinterpreted
  } = policy;

  const checks = [];
  const add = (id, ok, critical, detail) => checks.push({ id, pass: ok === true, critical: !!critical, detail });

  // 1. direction confirmed?
  add('DIRECTION_CONFIRMED', direction.view === VIEW.BULLISH || direction.view === VIEW.BEARISH, true,
    `view=${direction.view} agreement=${direction.agreementShare}`);
  // 2. no signal conflict
  add('NO_SIGNAL_CONFLICT', direction.signalConflict === false, true, `conflict=${direction.signalConflict}`);
  // 3. data fresh enough to act on
  const fb = direction.dataFreshness?.overallBucket ?? C.FRESHNESS.UNKNOWN;
  add('DATA_FRESH', fb === C.FRESHNESS.FRESH || fb === C.FRESHNESS.AGING, true, `bucket=${fb} age=${direction.dataFreshness?.dataAgeMs}ms`);
  // 4. location acceptable
  add('LOCATION_OK', entry?.locationAcceptable === true, true, entry?.locationDetail ?? 'not evaluated');
  // 5. contract liquid
  add('LIQUID', (entry?.volume ?? 0) >= (policy.minVolume ?? 1) && (entry?.openInterest ?? 0) >= (policy.minOpenInterest ?? 1), true,
    `vol=${entry?.volume} oi=${entry?.openInterest}`);
  // 6. spread acceptable
  const sp = entry?.spreadPctOfMid;
  add('SPREAD_OK', Number.isFinite(sp) && sp <= maxSpreadPctOfMid, true, `spread=${sp}% limit=${maxSpreadPctOfMid}%`);
  // 7. IV sane (not absurdly rich for a long premium entry)
  add('IV_OK', Number.isFinite(entry?.iv) && entry.iv > 0 && entry.iv <= (policy.maxIv ?? 200), true, `iv=${entry?.iv}`);
  // 8. enough session left
  add('TIME_OK', (entry?.minutesToClose ?? 0) >= minRemainingMinutes, true, `minutesToClose=${entry?.minutesToClose} need ${minRemainingMinutes}`);
  // 9. expected move large enough to beat spread + slippage + fees
  add('MOVE_VS_COST', Number.isFinite(entry?.expectedMovePoints) && entry.expectedMovePoints >= (entry?.roundTripCostPoints ?? Infinity) * minExpectedMoveVsCost, true,
    `expectedMove=${entry?.expectedMovePoints} roundTripCost=${entry?.roundTripCostPoints} need ≥${minExpectedMoveVsCost}×`);
  // 10. the move has not already happened (no chasing)
  add('NOT_EXTENDED', entry?.alreadyMovedPct === undefined || entry.alreadyMovedPct <= (policy.maxAlreadyMovedPct ?? 1.5), true, `alreadyMoved=${entry?.alreadyMovedPct}%`);
  // 11. risk/reward
  add('RISK_REWARD_OK', Number.isFinite(entry?.riskReward) && entry.riskReward >= minRiskReward, true, `R:R=${entry?.riskReward} need ${minRiskReward}`);
  // 12. existing policy permits
  add('POLICY_PERMITS', policy.permitsExpiryStrategy === true, true,
    `permitsExpiryStrategy=${policy.permitsExpiryStrategy} (NOT approved by operator)`);

  const failed = checks.filter((c) => !c.pass);
  const criticalFailed = failed.filter((c) => c.critical);
  return {
    tradeable: criticalFailed.length === 0,
    verdict: criticalFailed.length === 0 ? 'ELIGIBLE_FOR_PAPER_ONLY' : 'NO_TRADE',
    checks,
    blocking: criticalFailed.map((c) => c.id),
    allFailed: failed.map((c) => c.id),
    capitalFilterNote: capitalFilter
      ? 'capital filter applied downstream by the existing FNF risk engine, unchanged and not reinterpreted here'
      : 'no capital filter supplied; the existing FNF risk engine remains the sole authority',
    stage: 'ENTRY_SEPARATE_FROM_DIRECTION',
  };
}

module.exports = { BUCKETS, VIEW, bucket, builders, classifyDirection, evaluateTradeable };
