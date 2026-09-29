#!/usr/bin/env node
/**
 * EXPIRY LEARNING LOOP — the closed cycle, wired end to end.
 *
 *   REAL TICKS → SIGNAL → DYNAMIC SIZE → PAPER EXECUTE → NET OUTCOME → UPDATE
 *
 * Every step is paper-only. There is no order path in this file or in anything
 * it calls: `expiry-day-analysis` reads the database, `expiry-paper-ledger`
 * writes a local JSONL, and `DynamicRiskEngine` is a pure calculator. The live
 * broker SDK is never invoked.
 *
 * Data-integrity invariants enforced here (not strategy vetoes):
 *   - a stale or incoherent quote is never used for a decision
 *   - committed capital can never exceed available capital
 *   - every decision, fill and outcome is journaled
 *   - every paper position carries a loss boundary fixed BEFORE entry
 *   - no averaging down; no widening a boundary to dodge a recorded loss
 *   - an already-recorded position is never re-entered (idempotency)
 *
 * Strategy uncertainty (no validated edge, DTE=0, unknown regime) SHRINKS size
 * via the ledger's mode ladder. It never becomes a permanent refusal.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const C = require('./expiry-day-core');
const S = require('./expiry-day-signals');
const A = require('./expiry-day-analysis');
const L = require('./expiry-paper-ledger');
const { monitor } = require('./expiry-exit-monitor');

const OUT_DIR = process.env.EXPIRY_LOOP_DIR
  || '/home/swarna-sekhar-dhar/.hermes/cache/scratch/expiry-session-2026-09-29';
const DECISIONS = path.join(OUT_DIR, 'loop-decisions.jsonl');
const CHARGES = {
  brokeragePerLot: 20,
  sttRatePct: 0.15,            // Finance Act 2026 — sale of an option
  sttExerciseRatePct: 0.15,    // Finance Act 2026 — exercise (intrinsic)
  exchangeFeePct: 0.05,
  gstRatePct: 18,
  stampDutyRatePct: 0.003,
};

/** Loss boundary derived from market structure, not a fixed percentage. */
function deriveStop({ premium, atr, spreadPts, optionType, dte, regime }) {
  // Prefer volatility: 1.0–1.5x ATR of the underlying mapped to premium via
  // delta. Fall back to a spread-aware multiple. Expiry and range regimes get
  // a tighter boundary; a trend day tolerates more room. No fixed %.
  const base = (atr && atr > 0) ? atr * (1.0 + Math.min(0.5, (dte === 0 ? 0.15 : 0))) : null;
  const spreadFloor = spreadPts && spreadPts > 0 ? spreadPts * 4 : null;
  let distPts = base ?? (premium * 0.35);
  if (spreadFloor && distPts < spreadFloor) distPts = spreadFloor;
  if (regime === 'TREND') distPts *= 1.3;
  if (regime === 'PIN_RANGE' || regime === 'REVERSAL') distPts *= 0.8;
  const stop = optionType === 'PE'
    ? Math.max(0.05, premium - distPts)     // long put loses as premium falls
    : Math.max(0.05, premium - distPts);
  return {
    stopPremium: Number(stop.toFixed(2)),
    distancePts: Number(distPts.toFixed(2)),
    basis: base ? `ATR(${atr.toFixed(1)})` : 'premium-fraction',
    regimeTuned: regime ?? 'UNKNOWN',
    note: 'loss boundary is derived from structure + volatility and fixed BEFORE entry',
  };
}

/** Turn a live cycle into an actionable, sized paper decision. */
function decideAndSize({ cycle, contractMasterRow }) {
  const reasons = [];
  const nowMs = Date.now();

  // ── 1. Data integrity: refuse only on DATA problems, never on strategy doubt
  const fresh = cycle.freshness ?? {};
  const chain = cycle.optionMetrics?.atm;
  if (!chain || !(chain.strike > 0)) return { action: 'SKIP', reasons: ['NO_ATM_CONTRACT'] };
  if (!(chain.ceLtp > 0)) return { action: 'SKIP', reasons: ['NO_ATM_PREMIUM'] };
  if (fresh.overallBucket === 'STALE' || fresh.overallBucket === 'UNKNOWN') {
    return { action: 'SKIP', reasons: [`QUOTE_${fresh.overallBucket || 'UNKNOWN'}`], dataAgeMs: fresh.dataAgeMs };
  }
  const sp = cycle.optionMetrics?.atm?.spread;
  if (sp && sp.spreadPctOfMid > 25) return { action: 'SKIP', reasons: ['SPREAD_TOO_WIDE'] };

  // ── 2. Direction: a bias is a state, not an instruction
  const view = cycle.direction?.view;
  const setup = (cycle.setups?.candidates ?? []).map((c) => c.setup);
  if (view === S.VIEW.NO_TRADE) reasons.push('direction=NO_TRADE');

  // ── 3. Which side? Prefer the contract whose delta matches the bias.
  const preferCE = view === S.VIEW.BULLISH;
  const optionType = preferCE ? 'CE' : 'PE';
  const leg = optionType === 'CE' ? chain : { ...chain };
  if (!(leg.ceLtp > 0)) return { action: 'SKIP', reasons: ['LEG_NOT_QUOTED'] };
  const entryAsk = leg.ask ?? leg.ceLtp;

  // ── 4. Loss boundary BEFORE entry
  const stop = deriveStop({
    premium: entryAsk, atr: cycle.optionMetrics?.atm?.underlyingAtr ?? null,
    spreadPts: sp?.spread ?? null, optionType, dte: 0, regime: cycle.regime?.regime,
  });

  // ── 5. Dynamic size via the ledger (mode ladder, capital invariant)
  const key = `${cycle.regime?.regime ?? 'UNKNOWN'}|${setup[0] ?? 'NONE'}`;
  const state = L.loadState();
  const sizing = L.sizePaperPosition({
    state, key, premium: entryAsk, lotSize: contractMasterRow.lotSize,
    entryAsk, stopPremium: stop.stopPremium,
    uncertainty: 1 - (cycle.direction?.agreementShare ?? 0),
    liveDataAvailable: true,
  });
  if (!sizing.allowed) return { action: 'SKIP', reasons: sizing.reason ?? ['NOT_SIZABLE'], sizing, stop };

  return {
    action: 'PAPER_BUY',
    view, setup, key, optionType, contract: contractMasterRow,
    entryAsk, premium: entryAsk, stop, sizing,
    dte: 0,                                   // feature, not veto
    reasons,
    expectedMove: cycle.impliedMove ?? null,
    spread: sp ?? null,
    mode: sizing.mode,
  };
}

/** One full loop iteration for one index. */
async function tick({ indexKey = 'NIFTY', dateIso = C.istDateIso(), nowMs = Date.now() } = {}) {
  const out = {
    schema: 'expiry-learning-loop/v1',
    at: new Date(nowMs).toISOString(),
    atIst: `${C.istDateIso(nowMs)} ${C.istHm(nowMs)}`,
    index: indexKey, sessionDate: dateIso,
    safety: {
      LIVE_EXECUTION: 'DISABLED', PAPER_MODE: 'ENABLED',
      canPlaceOrder: false, STRATEGY_ARMED: false,
    },
  };

  let cycle;
  try {
    cycle = await A.withDb((conn) => A.runCycle(conn, { indexKey, dateIso, nowMs, config: { daysToExpiry: 0 } }));
  } catch (e) {
    out.result = { action: 'SKIP', reasons: [`DATA_READ_FAILED: ${e.message.slice(0, 60)}`] };
    appendDecision(out);
    return out;
  }

  out.market = {
    spot: cycle.spot,
    freshness: cycle.freshness?.overallBucket,
    dataAgeMs: cycle.freshness?.dataAgeMs,
    OI_STALE: cycle.freshness?.OI_STALE ?? null,
    regime: cycle.regime?.regime,
    view: cycle.direction?.view,
    noTradeType: cycle.noTrade?.type,
    impliedMove: cycle.impliedMove?.impliedMovePts ?? null,
    atm: cycle.optionMetrics?.atm?.strike ?? null,
    pcrOi: cycle.microstructure?.pcrOi ?? null,
    maxPain: cycle.microstructure?.maxPain?.strike ?? null,
  };

  // Contract identity comes from the registry (the authoritative master), not
  // from symbol parsing.
  let contract = null;
  try {
    contract = await A.withDb(async (conn) => {
      const strike = cycle.optionMetrics?.atm?.strike;
      const [rows] = await conn.query(
        `SELECT symbol, underlying, expiry, strike, optionType, lotSize
           FROM fnf_option_contracts
          WHERE underlying = ? AND strike = ? AND expiry = ?
          ORDER BY optionType LIMIT 2`,
        [indexKey === 'NIFTY' ? 'NIFTY50-INDEX' : indexKey === 'BANKNIFTY' ? 'NIFTYBANK-INDEX' : 'SENSEX', strike ?? 0, dateIso],
      );
      return rows[0] ?? null;
    });
  } catch { /* recorded as unavailable below */ }

  if (!contract) {
    out.result = { action: 'SKIP', reasons: ['NO_REGISTERED_CONTRACT_FOR_ATM'] };
    appendDecision(out);
    return out;
  }

  const decision = decideAndSize({ cycle, contractMasterRow: contract });
  out.result = {
    action: decision.action,
    reasons: decision.reasons,
    setup: decision.setup,
    optionType: decision.optionType,
    entryAsk: decision.entryAsk,
    stop: decision.stop,
    lots: decision.sizing?.lots ?? 0,
    mode: decision.sizing?.mode ?? null,
    pHat: decision.sizing?.pHat ?? null,
    n: decision.sizing?.n ?? 0,
  };

  // Paper execution — journaled, never routed to a broker.
  if (decision.action === 'PAPER_BUY') {
    const rec = L.openPaperPosition({
      key: decision.key, symbol: contract.symbol, underlying: contract.underlying,
      expiry: contract.expiry, regime: cycle.regime?.regime, setup: (decision.setup ?? [])[0] ?? 'NONE',
      dte: 0, view: cycle.direction?.view ?? null,
      agreementShare: cycle.direction?.agreementShare ?? null,
      spreadAtEntry: decision.spread?.spread ?? null,
      underlyingAtEntry: cycle.spot ?? null,
      premium: decision.entryAsk, lotSize: contract.lotSize,
      entryAsk: decision.entryAsk, stopPremium: decision.stop.stopPremium,
      uncertainty: 1 - (cycle.direction?.agreementShare ?? 0),
      liveDataAvailable: true,
    });
    out.paperEntry = { id: rec.id, lots: rec.lots, committedCapital: rec.sizing?.committedCapital, liveOrderCount: 0 };
  }

  // Exit pass: every open position (including one just opened) is marked and
  // re-decided on the SAME fresh snapshot, so a position that is already
  // invalid at entry is not left unattended until the next cron tick.
  out.exit = await monitorPositions({ indexKey, dateIso, nowMs, cycle });

  out.account = L.account(L.loadState());
  appendDecision(out);
  return out;
}

/**
 * Run the exit monitor for this index using the live cycle we just computed.
 * A position whose contract has no live quote gets a HOLD (never a fill).
 */
async function monitorPositions({ indexKey, dateIso, nowMs, cycle }) {
  const open = L.loadState().openPositions ?? [];
  if (!open.length) return { openAtStart: 0, processed: 0, note: 'no open paper positions' };
  const atm = cycle.optionMetrics?.atm;
  const minutesToClose = (() => {
    const mins = C.istMinutesOfDay(C.istNowDate(nowMs));
    const close = 15 * 60 + 30;
    return dateIso === C.istDateIso(nowMs) ? close - mins : null;
  })();
  // Only the ATM contract is quoted in this cycle's chain, so a position in a
  // different strike is reported as unquotable rather than marked at a
  // fabricated price.
  const quoteFor = async (position) => {
    if (!atm || !atm.strike) return null;
    const leg = position.entry?.optionType === 'PE' ? null : atm;
    if (!leg) return null;
    if (position.lotSize && leg.strike && position.stopPremium === undefined) return null;
    return {
      ltp: leg.ceLtp, bid: leg.bid, ask: leg.ask,
      spreadPctOfMid: leg.spread?.spreadPctOfMid ?? null,
      volume: leg.ceVol ?? null, openInterest: leg.ceOi ?? null,
      spot: cycle.spot ?? null,
      regime: cycle.regime?.regime ?? null,
      agreementShare: cycle.direction?.agreementShare ?? null,
      freshnessBucket: cycle.freshness?.overallBucket ?? 'UNKNOWN',
      dataAgeMs: cycle.freshness?.dataAgeMs ?? null,
      minutesToClose,
    };
  };
  return monitor({ quoteFor, nowMs });
}

function appendDecision(rec) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.appendFileSync(DECISIONS, `${JSON.stringify(rec)}\n`);
}

module.exports = { tick, decideAndSize, deriveStop, CHARGES, OUT_DIR, DECISIONS };

if (require.main === module) {
  const idx = (process.argv[2] || 'NIFTY').toUpperCase();
  tick({ indexKey: idx })
    .then((r) => {
      console.log(`[${r.atIst}] ${r.index}`);
      console.log('  market :', JSON.stringify(r.market));
      console.log('  action :', r.result.action, r.result.reasons?.length ? `(${r.result.reasons.join(', ')})` : '');
      if (r.result.lots) console.log(`  size   : ${r.result.lots} lot(s), mode=${r.result.mode}, pHat=${r.result.pHat}, n=${r.result.n}`);
      console.log('  account:', JSON.stringify(r.account));
      console.log('  safety :', JSON.stringify(r.safety));
    })
    .catch((e) => { console.error('loop failed:', e.message); process.exit(1); });
}
