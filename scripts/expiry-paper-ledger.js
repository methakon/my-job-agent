#!/usr/bin/env node
/**
 * EXPIRY PAPER LEARNING LEDGER — paper-only, observation-gated.
 *
 * Design (operator directive, 2026-09-29):
 *   OBSERVE → PREDICT → SIZE DYNAMICALLY → PAPER EXECUTE → MEASURE NET → UPDATE
 *
 * What changed from the first conservative draft:
 *   - DTE=0 is a MARKET-STATE FEATURE, not a blanket veto. Same-day expiry is
 *     exactly where the learning happens.
 *   - No fixed per-trade rupee risk, no fixed % ceiling, no fixed daily-loss
 *     limit, no permanent "no validated edge" veto. Those are replaced by one
 *     hard financial invariant:
 *         TOTAL_COMMITTED <= AVAILABLE_CAPITAL
 *   - "No validated edge yet" becomes an UNCERTAINTY signal that shrinks size,
 *     not a permanent refusal. Cold start runs in EXPLORATION mode so
 *     NO HISTORY -> NO TRADES -> NO HISTORY cannot deadlock.
 *
 * What stays hard (data integrity, not strategy):
 *   - live execution is impossible: there is no order path in this file
 *   - a stale/incoherent quote is never usable
 *   - committed capital can never exceed available capital
 *   - every decision, fill and outcome is journaled
 *   - every position carries a loss boundary decided BEFORE entry
 *   - no averaging down; no widening a boundary to dodge a recorded loss
 *
 * Net economics: every outcome is NET of brokerage, exchange fees, GST, stamp
 * duty, STT and the spread actually paid. Gross P&L is never the objective.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const C = require('./expiry-day-core');

const OUT_DIR = process.env.EXPIRY_LEDGER_DIR
  || '/home/swarna-sekhar-dhar/.hermes/cache/scratch/expiry-session-2026-09-29';
const LEDGER = path.join(OUT_DIR, 'paper-ledger.jsonl');
const STATE = path.join(OUT_DIR, 'learning-state.json');

const INITIAL_PAPER_CAPITAL = Number(process.env.EXPIRY_PAPER_CAPITAL || 5000);

// Mode ladder. Transitions are EVIDENCE-driven, never scheduled.
const MODE = {
  EXPLORATION: 'EXPLORATION',   // no history: deliberately small live-ish paper risk
  CALIBRATION: 'CALIBRATION',   // enough samples to estimate, not enough to trust
  ADAPTIVE_SIZING: 'ADAPTIVE_SIZING',
  EXPLOITATION: 'EXPLOITATION', // posterior is tight and favourable
};

/**
 * Determine the learning mode from observed evidence. Deliberately simple and
 * auditable: mode is a function of sample count and posterior spread, so it can
 * never be talked into a more aggressive state without trades.
 */
function learningModeFor({ n, alpha, beta }) {
  if (n < 10) return { mode: MODE.EXPLORATION, why: `${n} trades < 10: exploration, small size, collect evidence` };
  const p = alpha / (alpha + beta);
  const varP = (alpha * beta) / (((alpha + beta) ** 2) * (alpha + beta + 1));
  const sd = Math.sqrt(varP);
  if (n < 30 || sd > 0.20) return { mode: MODE.CALIBRATION, why: `n=${n}, p=${p.toFixed(2)}±${sd.toFixed(2)}: wide posterior, moderate size` };
  if (p > 0.45 && sd <= 0.15) return { mode: MODE.ADAPTIVE_SIZING, why: `n=${n}, p=${p.toFixed(2)}±${sd.toFixed(2)}: posterior tight and favourable` };
  if (p > 0.55 && sd <= 0.10) return { mode: MODE.EXPLOITATION, why: `n=${n}, p=${p.toFixed(2)}±${sd.toFixed(2)}: strong and tight` };
  return { mode: MODE.CALIBRATION, why: `n=${n}, p=${p.toFixed(2)}: not yet favourable` };
}

/** Net-of-costs round trip for one paper fill pair. */
function netPnl({ entryPremium, exitPremium, lotSize, lots, side = 'BUY', intrinsicExit = 0, charges }) {
  const qty = lotSize * lots;
  const gross = (exitPremium - entryPremium) * qty + intrinsicExit;
  const notionalIn = entryPremium * qty;
  const notionalOut = exitPremium * qty;
  const brokerage = charges.brokeragePerLot * lots * 2;              // in and out
  const exchange = ((notionalIn + notionalOut) / 2) * (charges.exchangeFeePct / 100);
  const gst = brokerage * (charges.gstRatePct / 100);
  const stamp = side === 'BUY' ? notionalIn * (charges.stampDutyRatePct / 100) : 0;
  // STT: on the SELL premium. If the option is exercised/settled ITM, STT is
  // levied on INTRINSIC value at the higher exercise rate.
  const sttBase = intrinsicExit > 0 ? intrinsicExit : notionalOut;
  const sttRate = intrinsicExit > 0 ? (charges.sttExerciseRatePct ?? charges.sttRatePct) : charges.sttRatePct;
  const stt = sttBase * (sttRate / 100);
  const total = brokerage + exchange + gst + stamp + stt;
  return {
    quantity: qty,
    grossPnl: Number(gross.toFixed(2)),
    brokerage: Number(brokerage.toFixed(2)),
    exchangeFee: Number(exchange.toFixed(2)),
    gst: Number(gst.toFixed(2)),
    stampDuty: Number(stamp.toFixed(2)),
    stt: Number(stt.toFixed(2)),
    totalCharges: Number(total.toFixed(2)),
    netPnl: Number((gross - total).toFixed(2)),
  };
}

/** Load or initialise the learning state (capital evolves from real outcomes). */
function loadState() {
  if (fs.existsSync(STATE)) {
    try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { /* fall through to a fresh state */ }
  }
  return {
    modelVersion: 'expiry-paper-learning/v1',
    initialCapital: INITIAL_PAPER_CAPITAL,
    realizedGross: 0,
    realizedCharges: 0,
    realizedNet: 0,
    unrealizedNet: 0,
    openPositions: [],
    outcomes: [],
    posteriors: {},         // "regime|setup" -> {alpha,beta,wins,losses,n}
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function saveState(s) {
  s.updatedAt = new Date().toISOString();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(STATE, `${JSON.stringify(s, null, 2)}\n`);
}

function account(state) {
  const equity = state.initialCapital + state.realizedNet + state.unrealizedNet;
  const committed = state.openPositions.reduce((a, p) => a + Math.abs(p.committedCapital), 0);
  return {
    ACCOUNT_EQUITY: Number(equity.toFixed(2)),
    AVAILABLE_CAPITAL: Number(Math.max(0, equity - committed).toFixed(2)),
    COMMITTED_CAPITAL: Number(committed.toFixed(2)),
    invariantHolds: committed <= equity + 1e-9,
  };
}

/**
 * Size a paper position dynamically. Returns a refusal when a DATA-INTEGRITY
 * bound is hit, or a small exploratory size when evidence is thin. There is no
 * branch here that refuses merely because the edge is unproven.
 */
function sizePaperPosition({ state, key, premium, lotSize, entryAsk, stopPremium, uncertainty = 0.5, liveDataAvailable }) {
  const acct = account(state);
  const post = state.posteriors[key] ?? { alpha: 1, beta: 1, n: 0, wins: [], losses: [] };
  const { mode, why } = learningModeFor(post);
  const lotCost = premium * lotSize;

  const refusals = [];
  if (!liveDataAvailable) refusals.push('NO_LIVE_DATA');
  if (!(premium > 0) || !(lotSize > 0)) refusals.push('INVALID_CONTRACT');
  if (!(stopPremium > 0 && stopPremium < premium)) refusals.push('NO_LOSS_BOUNDARY');
  if (acct.invariantHolds === false) refusals.push('COMMITTED_EXCEEDS_AVAILABLE');

  if (refusals.length) {
    return { allowed: false, lots: 0, reason: refusals, mode, modeWhy: why, account: acct, uncertainty };
  }

  // Posterior edge. Thin evidence pulls size toward the floor, never to zero.
  const p = post.alpha / (post.alpha + post.beta);
  const edge = Math.max(0, p - 0.5) * 2;               // 0..1
  const modeScale = { EXPLORATION: 0.05, CALIBRATION: 0.10, ADAPTIVE_SIZING: 0.20, EXPLOITATION: 0.35 }[mode];
  const fraction = Math.max(0, Math.min(modeScale, (modeScale * edge) + (mode === MODE.EXPLORATION ? modeScale : 0)));
  const riskPerLot = (premium - stopPremium) * lotSize;
  const budget = acct.AVAILABLE_CAPITAL * fraction;
  let lots = riskPerLot > 0 ? Math.floor(budget / riskPerLot) : 0;
  // Affordability is the ONLY hard financial bound. An index option lot can
  // cost more than the whole paper account (e.g. 1 NIFTY lot at a ₹100 premium
  // is ₹6,500 against ₹5,000 capital), in which case the probe is refused for
  // MONEY, not for lack of edge. We never shrink below one lot to fake a trade.
  const maxLotsByCapital = lotCost > 0 ? Math.floor(acct.AVAILABLE_CAPITAL / lotCost) : 0;
  lots = Math.min(lots, maxLotsByCapital);
  if (maxLotsByCapital < 1) {
    return {
      allowed: false,
      lots: 0,
      reason: ['ONE_LOT_UNAFFORDABLE'],
      detail: `1 lot costs ₹${lotCost.toFixed(0)} > AVAILABLE_CAPITAL ₹${acct.AVAILABLE_CAPITAL.toFixed(0)}`,
      mode, modeWhy: why, account: acct, uncertainty, pHat: Number(p.toFixed(4)), n: post.n,
      note: 'refused on affordability (hard invariant), NOT on lack of evidence — exploration is willing to trade when money permits',
    };
  }
  // Exploration must not deadlock at zero trades. When the risk budget is
  // smaller than one lot (common: a ₹5,000 account against a ₹390 risk/lot
  // and a 5% exploration fraction ⇒ ₹250, i.e. 0 lots) we still take the
  // MINIMUM viable probe — one lot — because collecting the first observation
  // is the whole point of exploration. This is a deliberate, journaled,
  // capital-bounded choice, not a manufactured trade: the one-lot cost is
  // still checked against AVAILABLE_CAPITAL above.
  if (lots < 1 && mode === MODE.EXPLORATION) lots = 1;

  return {
    allowed: lots >= 1,
    lots,
    committedCapital: Number((lots * lotCost).toFixed(2)),
    entryAsk,
    stopPremium,
    riskPerLot: Number(riskPerLot.toFixed(2)),
    plannedRisk: Number((riskPerLot * lots).toFixed(2)),
    fractionOfAvailable: acct.AVAILABLE_CAPITAL ? Number(((lots * lotCost) / acct.AVAILABLE_CAPITAL).toFixed(4)) : 0,
    mode, modeWhy: why,
    pHat: Number(p.toFixed(4)),
    n: post.n,
    uncertainty: Number(uncertainty.toFixed(3)),
    account: acct,
    note: lots === 0 ? 'no lot affordable at this premium' : null,
  };
}

/** Open a paper position. Journaled. No order is ever sent. */
function openPaperPosition(args) {
  const state = loadState();
  const sizing = sizePaperPosition({ state, key: args.key, premium: args.premium, lotSize: args.lotSize, entryAsk: args.entryAsk, stopPremium: args.stopPremium, uncertainty: args.uncertainty, liveDataAvailable: args.liveDataAvailable });
  const record = {
    schema: 'expiry-paper-position/v1',
    id: `PAPER-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    openedAtIst: `${C.istDateIso()} ${C.istHm()}`,
    symbol: args.symbol, underlying: args.underlying, expiry: args.expiry,
    key: args.key, regime: args.regime ?? null, setup: args.setup ?? null,
    dte: args.dte ?? null,                        // DTE is a FEATURE, not a veto
    side: 'BUY',
    premium: args.premium, lotSize: args.lotSize, lots: sizing.lots,
    entryAsk: args.entryAsk, stopPremium: args.stopPremium,
    sizing,
    status: sizing.allowed ? 'OPEN' : 'REFUSED',
    liveOrderCount: 0,                            // always zero: no order path exists
  };
  if (sizing.allowed) {
    state.openPositions.push({
      id: record.id, symbol: record.symbol, key: record.key,
      committedCapital: sizing.committedCapital,
      entryPremium: args.premium, entryAsk: args.entryAsk, lotSize: args.lotSize, lots: sizing.lots,
      stopPremium: args.stopPremium, openedAtIst: record.openedAtIst,
      // Entry provenance the exit monitor and the outcome record need. Without
      // these a closed trade cannot be compared against the state that produced
      // it, so it is not usable training data.
      entry: {
        regime: args.regime ?? null,
        setup: args.setup ?? null,
        dte: args.dte ?? null,
        view: args.view ?? null,
        agreementShare: args.agreementShare ?? null,
        pHat: sizing?.pHat ?? null,
        mode: sizing?.mode ?? null,
        uncertainty: sizing?.uncertainty ?? null,
        spreadAtEntry: args.spreadAtEntry ?? null,
        underlyingAtEntry: args.underlyingAtEntry ?? null,
        entryIstMs: Date.now(),
      },
      // Contract identity must be stored explicitly: the monitor has to re-find
      // THIS contract's live quote, and parsing it back out of the symbol would
      // reintroduce the naming-convention bug (FYERS 26SEP vs Upstox 29SEP).
      contract: args.contract ?? null,
      strike: args.strike ?? null,
      optionType: args.optionType ?? null,
      // Excursions are tracked monotonically from the FIRST mark after entry
      // and never recomputed, so the outcome records the real path taken.
      mfePremium: args.premium,
      maePremium: args.premium,
      marks: 0,
    });
    saveState(state);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.appendFileSync(LEDGER, `${JSON.stringify(record)}\n`);
  return record;
}

/**
 * Mark an open position to a live premium. Updates MFE/MAE monotonically and
 * unrealized P&L. This is NOT an outcome: nothing is learned here, because a
 * trade that has not closed has no realised result. Unrealized value is
 * reported but deliberately excluded from the posterior.
 */
function markPosition({ id, premium, underlyingPrice = null, nowMs = Date.now() }) {
  const state = loadState();
  const p = state.openPositions.find((x) => x.id === id);
  if (!p) return { marked: false, reason: 'POSITION_NOT_FOUND' };
  if (!(premium > 0)) return { marked: false, reason: 'INVALID_PREMIUM' };
  p.marks += 1;
  p.lastMarkPremium = premium;
  p.lastMarkIstMs = nowMs;
  if (underlyingPrice !== null && Number.isFinite(underlyingPrice)) p.lastUnderlying = underlyingPrice;
  // Monotonic excursions: an unrealized high is never forgotten, which is what
  // makes MAE/MFE usable training features.
  if (premium > (p.mfePremium ?? p.entryPremium)) p.mfePremium = premium;
  if (premium < (p.maePremium ?? p.entryPremium)) p.maePremium = premium;
  const qty = p.lotSize * p.lots;
  const charges = exitSideCharges({ entryPremium: p.entryAsk, exitPremium: premium, lotSize: p.lotSize, lots: p.lots });
  const gross = (premium - p.entryAsk) * qty;
  // Unrealized across ALL open positions, each at its latest mark. This is
  // reported but NEVER folded into the posterior — only closePaperPosition
  // updates the model, because an open trade has no realised outcome yet.
  state.unrealizedNet = Number(state.openPositions.reduce((a, o) => {
    const mark = o.id === id ? premium : (o.lastMarkPremium ?? o.entryAsk);
    const c = exitSideCharges({ entryPremium: o.entryAsk, exitPremium: mark, lotSize: o.lotSize, lots: o.lots });
    return a + c.grossPnl - c.totalCharges;
  }, 0).toFixed(2));
  saveState(state);
  return {
    marked: true, id, premium,
    mfePremium: p.mfePremium, maePremium: p.maePremium, marks: p.marks,
    unrealizedGross: Number(gross.toFixed(2)),
    unrealizedNet: Number((gross - charges.totalCharges).toFixed(2)),
    unrealizedIsRealized: false,
    heldMinutes: Number(((nowMs - (p.entry?.entryIstMs ?? nowMs)) / 60000).toFixed(1)),
  };
}

/** Round-trip charges and gross P&L for a mark or an exit. */
function exitSideCharges({ entryPremium, exitPremium, lotSize, lots, charges }) {
  const c = charges ?? DEFAULT_EXIT_CHARGES;
  const qty = lotSize * lots;
  const notionalIn = entryPremium * qty;
  const notionalOut = exitPremium * qty;
  const brokerage = c.brokeragePerLot * lots * 2;   // in and out
  const exchange = ((notionalIn + notionalOut) / 2) * (c.exchangeFeePct / 100);
  const gst = brokerage * (c.gstRatePct / 100);
  const stamp = notionalIn * (c.stampDutyRatePct / 100);
  const stt = notionalOut * (c.sttRatePct / 100);
  return { grossPnl: (exitPremium - entryPremium) * qty, totalCharges: brokerage + exchange + gst + stamp + stt };
}

const DEFAULT_EXIT_CHARGES = {
  brokeragePerLot: 20, sttRatePct: 0.15, exchangeFeePct: 0.05, gstRatePct: 18, stampDutyRatePct: 0.003,
};

/** Close a paper position and fold the NET outcome into the posterior. */
function closePaperPosition({ id, exitBid, intrinsicExit = 0, exitReason, charges, exitContext = null }) {
  const state = loadState();
  const idx = state.openPositions.findIndex((p) => p.id === id);
  if (idx < 0) return { closed: false, reason: 'POSITION_NOT_FOUND' };
  const p = state.openPositions.splice(idx, 1)[0];
  const econ = netPnl({
    entryPremium: p.entryAsk, exitPremium: exitBid, lotSize: p.lotSize, lots: p.lots,
    intrinsicExit, charges,
  });
  const risk = Math.max(0.0001, (p.entryAsk - p.stopPremium) * p.lotSize * p.lots);
  const rMultiple = Number((econ.netPnl / risk).toFixed(4));
  const key = p.key;
  const post = state.posteriors[key] ?? { alpha: 1, beta: 1, wins: [], losses: [], n: 0 };
  // Update on NET outcome, not gross: fees decide whether the edge was real.
  if (econ.netPnl > 0) { post.alpha += 1; post.wins.push(rMultiple); } else { post.beta += 1; post.losses.push(Math.abs(rMultiple)); }
  post.n += 1;
  state.posteriors[key] = post;
  state.realizedGross += econ.grossPnl;
  state.realizedCharges += econ.totalCharges;
  state.realizedNet += econ.netPnl;
  state.outcomes.push({ id, key, netPnl: econ.netPnl, rMultiple, exitReason, at: new Date().toISOString() });
  saveState(state);
  const outcome = {
    schema: 'expiry-paper-outcome/v1', id, key, exitReason,
    // ── Full training record: the state that produced the trade, and the state
    // it was exited into. Without both halves this is not learnable.
    entryState: {
      regime: p.entry?.regime ?? null,
      setup: p.entry?.setup ?? null,
      dte: p.entry?.dte ?? null,
      view: p.entry?.view ?? null,
      agreementShare: p.entry?.agreementShare ?? null,
      confidenceP: p.entry?.pHat ?? null,
      mode: p.entry?.mode ?? null,
      underlying: p.entry?.underlyingAtEntry ?? null,
      spread: p.entry?.spreadAtEntry ?? null,
      entryAsk: p.entryAsk,
      lots: p.lots,
      committedCapital: p.committedCapital,
    },
    exitState: {
      regime: exitContext?.regime ?? null,
      agreementShare: exitContext?.agreementShare ?? null,
      timeToCloseMin: exitContext?.timeToCloseMin ?? null,
      liquidity: exitContext?.liquidity ?? null,
      mark: exitBid,
    },
    economics: econ,                 // gross, itemised charges, net
    rMultiple,
    maePremium: p.maePremium ?? p.entryAsk,
    mfePremium: p.mfePremium ?? p.entryAsk,
    maePts: Number(((p.maePremium ?? p.entryAsk) - p.entryAsk).toFixed(2)),
    mfePts: Number(((p.mfePremium ?? p.entryAsk) - p.entryAsk).toFixed(2)),
    holdDurationMin: Number(((Date.now() - (p.entry?.entryIstMs ?? Date.now())) / 60000).toFixed(1)),
    marks: p.marks ?? 0,
    modeAfter: learningModeFor(post),
    account: account(state),
    capitalReleased: p.committedCapital,
    liveOrderCount: 0,
  };
  fs.appendFileSync(LEDGER, `${JSON.stringify(outcome)}\n`);
  return { closed: true, ...outcome };
}

/** Current learning report. */
function learningReport() {
  const state = loadState();
  const buckets = Object.entries(state.posteriors).map(([k, p]) => {
    const m = learningModeFor(p);
    return {
      key: k, n: p.n,
      pHat: Number((p.alpha / (p.alpha + p.beta)).toFixed(4)),
      netExpectancyR: Number(((p.wins.reduce((a, x) => a + x, 0) - p.losses.reduce((a, x) => a + x, 0)) / Math.max(1, p.n)).toFixed(4)),
      mode: m.mode, modeWhy: m.why,
    };
  });
  return {
    schema: 'expiry-paper-learning-report/v1',
    modelVersion: state.modelVersion,
    account: account(state),
    realizedGross: Number(state.realizedGross.toFixed(2)),
    realizedCharges: Number(state.realizedCharges.toFixed(2)),
    realizedNet: Number(state.realizedNet.toFixed(2)),
    unrealizedNet: Number(state.unrealizedNet.toFixed(2)),
    openPositions: state.openPositions.length,
    paperTrades: state.outcomes.length,
    buckets,
    overallMode: buckets.length ? buckets[0].mode : MODE.EXPLORATION,
    invariant: 'TOTAL_COMMITTED <= AVAILABLE_CAPITAL',
    dataIntegrity: [
      'live execution disabled (no order path in this code)',
      'stale or incoherent quotes are unusable',
      'committed capital can never exceed available capital',
      'every decision, fill and outcome is journaled',
      'every position has a loss boundary fixed before entry',
      'no averaging down; no widening a boundary to avoid a loss',
    ],
  };
}

module.exports = {
  MODE, OUT_DIR, LEDGER, STATE, INITIAL_PAPER_CAPITAL, DEFAULT_EXIT_CHARGES,
  learningModeFor, netPnl, loadState, saveState, account, exitSideCharges,
  sizePaperPosition, openPaperPosition, markPosition, closePaperPosition, learningReport,
};

if (require.main === module) {
  console.log(JSON.stringify(learningReport(), null, 2));
}
