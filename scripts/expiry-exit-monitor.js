#!/usr/bin/env node
/**
 * EXPIRY EXIT MONITOR — paper positions: mark, decide, close, learn.
 *
 * Runs on a tighter cadence than entry discovery so a position is never
 * unattended. For every open paper position it:
 *   1. reads a LIVE, FRESH quote for that exact contract
 *   2. marks it to market (MFE/MAE tracked monotonically)
 *   3. takes a DYNAMIC decision: HOLD | REDUCE | EXIT
 *   4. on EXIT, closes the position and writes the full training record
 *   5. releases committed capital and updates the posterior
 *
 * DYNAMIC, NOT FIXED. There is no fixed target %, stop %, ₹ loss or holding
 * time. The only non-negotiable is the loss boundary that was fixed BEFORE
 * entry, and it is never widened — a wider boundary would fabricate a better
 * result than the market gave.
 *
 * Exit reasons are LABELS for learning, not hard-coded vetoes:
 *   STOP | EXPECTANCY_DECAY | REGIME_CHANGE | LIQUIDITY_DETERIORATION
 *   | CONFIDENCE_COLLAPSE | TIME_EXPIRY_EFFECT | END_OF_SESSION
 *   | SYSTEM_SAFETY
 * Which of these preserve gains, cut losses, exit too early or too late is
 * exactly what the outcome buckets are for.
 *
 * Data integrity: a stale or missing quote NEVER produces a fill. No broker SDK
 * is imported. No live order can be generated.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const C = require('./expiry-day-core');
const L = require('./expiry-paper-ledger');

const OUT_DIR = process.env.EXPIRY_EXIT_DIR
  || '/home/swarna-sekhar-dhar/.hermes/cache/scratch/expiry-session-2026-09-29';
const EXITS = path.join(OUT_DIR, 'exit-decisions.jsonl');

const EXIT_REASON = {
  STOP: 'STOP',
  EXPECTANCY_DECAY: 'EXPECTANCY_DECAY',
  REGIME_CHANGE: 'REGIME_CHANGE',
  LIQUIDITY_DETERIORATION: 'LIQUIDITY_DETERIORATION',
  CONFIDENCE_COLLAPSE: 'CONFIDENCE_COLLAPSE',
  TIME_EXPIRY_EFFECT: 'TIME_EXPIRY_EFFECT',
  END_OF_SESSION: 'END_OF_SESSION',
  SYSTEM_SAFETY: 'SYSTEM_SAFETY',
};

/** Fraction of the position to release on a REDUCE. Never all, never zero. */
const REDUCE_FRACTION = 0.5;

/**
 * Minimum time a position is observed before a non-structural exit may fire.
 * The loss boundary set at entry is NOT subject to this — it is enforceable
 * from the first mark. This only prevents a decision being taken on a quote
 * that is the entry print itself.
 */
const MIN_HOLD_MINUTES = 2;

function log(rec) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.appendFileSync(EXITS, `${JSON.stringify(rec)}\n`);
}

/**
 * Evaluate one position and decide. Pure — no I/O, no side effects — so the
 * decision logic is directly testable against any market state.
 *
 * `ctx` carries the CURRENT market state (never the entry state):
 *   premium, bid, ask, spreadPctOfMid, volume, openInterest, spot,
 *   regime, agreementShare, freshnessBucket, dataAgeMs, minutesToClose,
 *   sessionOpen
 */
function decideExit({ position, ctx }) {
  const reasons = [];
  const heldMin = ctx.heldMinutes ?? 0;

  // ── 0. Data integrity first: no quote, no decision. Never a false fill.
  if (!(ctx.premium > 0)) return { action: 'HOLD', reason: null, blockedBy: 'NO_LIVE_PREMIUM' };
  if (ctx.freshnessBucket === 'STALE' || ctx.freshnessBucket === 'UNKNOWN') {
    return { action: 'HOLD', reason: null, blockedBy: `QUOTE_${ctx.freshnessBucket || 'UNKNOWN'}`, dataAgeMs: ctx.dataAgeMs ?? null };
  }
  if (!(ctx.bid > 0) || !(ctx.ask > 0)) return { action: 'HOLD', reason: null, blockedBy: 'NO_TWO_SIDED_QUOTE' };

  const entry = position.entryAsk;
  const stop = position.stopPremium;      // fixed at entry; never adjusted here
  const movePts = ctx.premium - entry;
  const movePct = entry > 0 ? (movePts / entry) : 0;
  const stopDistance = Math.max(0.01, entry - stop);
  const rNow = movePts / stopDistance;     // current R, vs the boundary set at entry
  const spreadCost = (ctx.ask - ctx.bid);
  const mfePts = (position.mfePremium ?? entry) - entry;

  // ── 1. The structural boundary is the one hard exit. It is never widened.
  if (ctx.bid <= stop) {
    return { action: 'EXIT', reason: EXIT_REASON.STOP, rNow, movePct, rMultiple: Number(rNow.toFixed(3)), why: `bid ${ctx.bid} <= fixed boundary ${stop} (set at entry, never widened)` };
  }

  // ── 2. Liquidity deterioration: the exit becomes untradeable, not unprofitable.
  const spreadPct = ctx.spreadPctOfMid;
  if (Number.isFinite(spreadPct) && spreadPct > (ctx.spreadCeilingPct ?? 12)) {
    return { action: 'REDUCE', reason: EXIT_REASON.LIQUIDITY_DETERIORATION, rNow, movePct, why: `spread ${spreadPct.toFixed(1)}% exceeds the level where the position can be traded at size` };
  }
  if (Number.isFinite(ctx.volume) && ctx.volume <= 0) {
    return { action: 'REDUCE', reason: EXIT_REASON.LIQUIDITY_DETERIORATION, rNow, movePct, why: 'no volume in the contract — exit is not fillable at size' };
  }

  // ── 3. Expectancy decay: a position that ran far in our favour and gave it
  //    all back has stopped paying for its risk. Learned, not a fixed target.
  const giveBack = mfePts > 0 ? (mfePts - movePts) / mfePts : 0;
  if (mfePts > 0 && giveBack > 0.6 && rNow < 0.25) {
    return { action: 'REDUCE', reason: EXIT_REASON.EXPECTANCY_DECAY, rNow, movePct, why: `gave back ${(giveBack * 100).toFixed(0)}% of a ${mfePts.toFixed(2)}-pt run; remaining edge no longer pays for the risk` };
  }

  // ── 4. Confidence collapse: the market stopped agreeing with the thesis.
  const entryAgree = position.entry?.agreementShare ?? null;
  if (Number.isFinite(entryAgree) && Number.isFinite(ctx.agreementShare) && entryAgree > 0 && ctx.agreementShare < entryAgree * 0.6) {
    return { action: 'REDUCE', reason: EXIT_REASON.CONFIDENCE_COLLAPSE, rNow, movePct, why: `agreement fell ${entryAgree.toFixed(2)} → ${ctx.agreementShare.toFixed(2)} since entry` };
  }

  // ── 5. Regime change: the setup's premise no longer holds.
  const entryRegime = position.entry?.regime ?? null;
  if (entryRegime && ctx.regime && entryRegime !== ctx.regime) {
    return { action: 'REDUCE', reason: EXIT_REASON.REGIME_CHANGE, rNow, movePct, why: `regime ${entryRegime} → ${ctx.regime}` };
  }

  // ── 6. Time / expiry effect: time decay accelerates through the session and
  //    is severe on expiry day. A position carried into the settlement window
  //    holds materially different risk than the one that was opened.
  if (ctx.minutesToClose !== null && ctx.minutesToClose !== undefined && ctx.minutesToClose <= (ctx.exitWindowMin ?? 20)) {
    return { action: 'EXIT', reason: EXIT_REASON.TIME_EXPIRY_EFFECT, rNow, movePct, why: `${ctx.minutesToClose} min to close: the position is now in the settlement window` };
  }
  if (position.entry?.dte === 0 && heldMin > (ctx.maxSameDayHoldMin ?? 240)) {
    return { action: 'EXIT', reason: EXIT_REASON.TIME_EXPIRY_EFFECT, rNow, movePct, why: `DTE=0 position held ${heldMin.toFixed(0)} min` };
  }

  // ── 7. Profit is realised only after costs. A "winner" that cannot clear the
  //    round trip is not a winner, and holding it to hope is how edge leaks.
  if (movePts > 0) {
    const roundTrip = (ctx.chargesPerPoint ?? 0) + spreadCost;
    if (movePts < roundTrip) {
      return { action: 'REDUCE', reason: EXIT_REASON.EXPECTANCY_DECAY, rNow, movePct, why: `gross +${movePts.toFixed(2)} is inside the round-trip cost (${roundTrip.toFixed(2)}); the position cannot pay for itself` };
    }
  }

  return {
    action: 'HOLD', reason: null, rNow, movePct,
    why: 'no exit condition met; boundary intact and edge still paying',
  };
}

/** Live context for one open position, built from a market snapshot. */
function contextFor(position, snapshot, nowMs = Date.now()) {
  const entryIstMs = position.entry?.entryIstMs ?? null;
  return {
    premium: snapshot.ltp,
    bid: snapshot.bid,
    ask: snapshot.ask,
    spreadPctOfMid: snapshot.spreadPctOfMid ?? null,
    volume: snapshot.volume ?? null,
    openInterest: snapshot.openInterest ?? null,
    spot: snapshot.spot ?? null,
    regime: snapshot.regime ?? null,
    agreementShare: snapshot.agreementShare ?? null,
    freshnessBucket: snapshot.freshnessBucket ?? 'UNKNOWN',
    dataAgeMs: snapshot.dataAgeMs ?? null,
    minutesToClose: snapshot.minutesToClose ?? null,
    // Real elapsed time since entry. A placeholder date would make every
    // hold-duration feature wrong, which would poison the exit-quality data.
    heldMinutes: entryIstMs ? Number(((nowMs - entryIstMs) / 60000).toFixed(1)) : null,
    minutesSinceEntry: entryIstMs ? Math.max(0, (nowMs - entryIstMs) / 60000) : null,
    chargesPerPoint: snapshot.chargesPerPoint ?? 0.06,
  };
}

/**
 * Run the monitor over every open position.
 * `quoteFor(position)` must return a live snapshot or null; a null (stale,
 * missing, unquoted) produces a HOLD, never a fabricated fill.
 */
async function monitor({ quoteFor, nowMs = Date.now() } = {}) {
  const state = L.loadState();
  const open = state.openPositions ?? [];
  const results = [];
  const closedIds = new Set();      // idempotency within a single pass
  const decisions = [];

  for (const p of open) {
    if (closedIds.has(p.id)) continue;
    let snap = null;
    try { snap = await quoteFor(p, nowMs); } catch { snap = null; }

    if (!snap) {
      const d = { id: p.id, action: 'HOLD', blockedBy: 'NO_LIVE_QUOTE', symbol: p.symbol };
      decisions.push(d);
      results.push({ ...d, note: 'no live quote — no fill, no mark, no learning update' });
      continue;
    }

    // 1. Mark to market BEFORE deciding: excursions are features.
    const mark = L.markPosition({ id: p.id, premium: snap.ltp, underlyingPrice: snap.spot ?? null, nowMs });

    // 2. Decide
    const ctx = contextFor(p, snap, nowMs);

    // A position cannot be judged on the same tick it was opened. The mark used
    // here is the ENTRY price, not a later observation, so any exit decision
    // would rest on zero elapsed time -- and that is how a position one second
    // old was closed for LIQUIDITY_DETERIORATION on a bad quote read. The loss
    // boundary still applies immediately; nothing else does.
    const ageMin = ctx.minutesSinceEntry;
    // Apply the window only when the age is actually known. A missing entry
    // timestamp is a data gap, not evidence that the position is brand new, and
    // guessing either way would be a fabricated observation.
    const withinMinHold = Number.isFinite(ageMin) && ageMin < MIN_HOLD_MINUTES;
    const decision = withinMinHold
      ? {
        action: 'HOLD', reason: null, rNow: null, movePct: 0,
        why: `opened ${ageMin} min ago; below the ${MIN_HOLD_MINUTES}-min observation window`,
      }
      : decideExit({ position: { ...p, mfePremium: mark.mfePremium, maePremium: mark.maePremium }, ctx });
    const rec = {
      id: p.id, symbol: p.symbol, key: p.key,
      action: decision.action, reason: decision.reason ?? null,
      rNow: decision.rNow ?? null, movePct: decision.movePct ?? null,
      why: decision.why ?? null, blockedBy: decision.blockedBy ?? null,
      mark: { premium: snap.ltp, bid: snap.bid, ask: snap.ask, mfe: mark.mfePremium, mae: mark.maePremium },
      heldMinutes: mark.heldMinutes,
      unrealizedIsRealized: false,
      at: new Date(nowMs).toISOString(),
    };
    decisions.push(rec);

    // 3. Execute the exit, if any.
    if (decision.action === 'EXIT' || decision.action === 'REDUCE') {
      // A REDUCE on a ONE-LOT position cannot be partial — there is nothing
      // left to keep. Flooring 1 x 50% gives 0, which previously fell through
      // to a FULL close, so a "reduce" silently became an exit. On a single-lot
      // position the honest outcome is a full EXIT.
      const partialLots = Math.floor(p.lots * REDUCE_FRACTION);
      const isPartial = decision.action === 'REDUCE' && partialLots >= 1 && partialLots < p.lots;
      if (isPartial) {
        const partial = closePartial({ position: p, lotsToClose: partialLots, exitBid: snap.bid, exitReason: decision.reason, snapshot: snap, nowMs });
        closedIds.add(p.id);
        results.push({ ...rec, closed: partial });
      } else {
        if (decision.action === 'REDUCE') {
          rec.reason = rec.reason ?? EXIT_REASON.EXPECTANCY_DECAY;
          rec.why = `${rec.why}; single-lot position cannot be reduced — exiting fully`;
        }
        const out = L.closePaperPosition({
          id: p.id, exitBid: snap.bid, exitReason: rec.reason,
          charges: L.DEFAULT_EXIT_CHARGES,
          exitContext: {
            regime: snap.regime, agreementShare: snap.agreementShare,
            timeToCloseMin: ctx.minutesToClose, liquidity: snap.volume,
          },
        });
        closedIds.add(p.id);
        results.push({ ...rec, closed: out });
      }
    }
  }

  log({ at: new Date(nowMs).toISOString(), openCount: open.length, decisions, results });
  return {
    openAtStart: open.length,
    processed: decisions.length,
    holds: decisions.filter((d) => d.action === 'HOLD').length,
    exits: decisions.filter((d) => d.action === 'EXIT').length,
    reduces: decisions.filter((d) => d.action === 'REDUCE').length,
    blockedNoQuote: decisions.filter((d) => d.blockedBy === 'NO_LIVE_QUOTE').length,
    decisions, results,
    account: L.account(L.loadState()),
    safety: { LIVE_EXECUTION: 'DISABLED', PAPER_MODE: 'ENABLED', canPlaceOrder: false },
  };
}

/** Partial close: realise a fraction, keep the remainder open. */
function closePartial({ position, lotsToClose, exitBid, exitReason, snapshot, nowMs }) {
  const state = L.loadState();
  const p = state.openPositions.find((x) => x.id === position.id);
  if (!p) return { closed: false, reason: 'POSITION_NOT_FOUND' };
  const remainingLots = p.lots - lotsToClose;
  const partialCharges = L.exitSideCharges({
    entryPremium: p.entryAsk, exitPremium: exitBid, lotSize: p.lotSize, lots: lotsToClose, charges: L.DEFAULT_EXIT_CHARGES,
  });
  const state2 = state;
  // Realise only the closed portion; the rest keeps its excursion history.
  state2.realizedGross += partialCharges.grossPnl;
  state2.realizedCharges += partialCharges.totalCharges;
  state2.realizedNet += (partialCharges.grossPnl - partialCharges.totalCharges);
  if (remainingLots <= 0) {
    state2.openPositions = state2.openPositions.filter((x) => x.id !== position.id);
  } else {
    p.lots = remainingLots;
    p.committedCapital = Number((remainingLots * p.entryAsk * p.lotSize).toFixed(2));
    p.partialExits = (p.partialExits ?? []).concat([{ at: new Date(nowMs).toISOString(), reason: exitReason, lots: lotsToClose, net: Number((partialCharges.grossPnl - partialCharges.totalCharges).toFixed(2)) }]);
  }
  L.saveState(state2);
  const rec = {
    schema: 'expiry-paper-partial/v1', id: position.id, kind: 'REDUCE',
    lotsClosed: lotsToClose, lotsRemaining: remainingLots,
    exitBid, exitReason,
    economics: { grossPnl: Number(partialCharges.grossPnl.toFixed(2)), totalCharges: Number(partialCharges.totalCharges.toFixed(2)), netPnl: Number((partialCharges.grossPnl - partialCharges.totalCharges).toFixed(2)) },
    note: 'partial close realises net P&L and releases capital; the posterior is NOT updated until the position fully closes',
  };
  fs.appendFileSync(L.LEDGER, `${JSON.stringify(rec)}\n`);
  return { closed: true, partial: true, ...rec };
}

module.exports = { EXIT_REASON, REDUCE_FRACTION, decideExit, contextFor, monitor, closePartial, OUT_DIR, EXITS };

if (require.main === module) {
  console.log('exit-monitor is driven by scripts/expiry-exit-monitor-cli.js (needs a live quote source)');
}
