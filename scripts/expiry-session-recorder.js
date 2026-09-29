#!/usr/bin/env node
/**
 * EXPIRY SESSION RECORDER — 2026-09-29 observation + paper validation ONLY.
 *
 * Invariants this script is built to enforce, not merely respect:
 *   LIVE_EXECUTION = DISABLED   PAPER_MODE = ENABLED
 *   POLICY_PERMITS = false      canPlaceOrder = false   STRATEGY_ARMED = false
 *   CAPITAL_AT_RISK = 0
 *
 * It READS the database (SELECT only) and APPENDS to two local JSONL files in
 * the scratch directory. It never writes to a trading table, never places an
 * order, and never touches .env, PM2, credentials or risk limits.
 *
 * Each tick records what is actually available and marks what is not:
 *   - every unavailable input is recorded as UNAVAILABLE with a reason
 *   - no futures / breadth / dealer-gamma / IV value is ever synthesised
 *
 * DTE policy: UNCHANGED. The existing `dte < 1` exclusion stays active, and
 * every candidate blocked by it is counted under DTE_ZERO_BLOCK. The metadata
 * defect is reported separately as EXPIRY_METADATA_ERROR = CLEARED.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const C = require('./expiry-day-core');
const S = require('./expiry-day-signals');
const A = require('./expiry-day-analysis');

const SESSION_DATE = process.env.EXPIRY_SESSION_DATE || '2026-09-29';
const OUT_DIR = process.env.EXPIRY_SESSION_DIR || '/home/swarna-sekhar-dhar/.hermes/cache/scratch/expiry-session-2026-09-29';
const CYCLES = path.join(OUT_DIR, 'cycles.jsonl');
const META = path.join(OUT_DIR, 'meta.json');

// Paper-validation accounting constants (operator-specified).
const PAPER_CAPITAL_INR = 5000;
const PAPER_RISK_PER_TRADE_INR = 500;

const SAFETY = {
  LIVE_EXECUTION: 'DISABLED',
  PAPER_MODE: 'ENABLED',
  POLICY_PERMITS: false,
  canPlaceOrder: false,
  STRATEGY_ARMED: false,
  CAPITAL_AT_RISK_INR: 0,
  DTE_POLICY: 'UNCHANGED — dte < 1 remains active (same-day expiry contracts are not entry-eligible)',
  DTE_ZERO_BLOCK: 'ACTIVE',
  EXPIRY_METADATA_ERROR: 'CLEARED',
};

/** Session phase from the IST wall clock. */
function sessionPhase(nowMs = Date.now()) {
  const m = C.istMinutesOfDay(C.istNowDate(nowMs));
  if (m < 9 * 60) return 'PRE_OPEN';
  if (m < 9 * 60 + 15) return 'PRE_OPEN_AUCTION';
  if (m < 9 * 60 + 30) return 'OPENING_30M';
  if (m < 10 * 60) return 'MORNING';
  if (m < 11 * 60) return 'MORNING_1';
  if (m < 13 * 60) return 'MIDDAY';
  if (m < 14 * 60) return 'AFTERNOON_1';
  if (m < 15 * 60 + 15) return 'LATE_SESSION';
  if (m <= 15 * 60 + 30) return 'CLOSE_WINDOW';
  return 'POST_CLOSE';
}

/** Count DTE=0 blocks using the SAME logic as the runtime gate (dte < 1). */
function dteZeroBlocks(contracts, todayIso) {
  let zero = 0; let past = 0; let future = 0; const blocked = [];
  for (const c of contracts) {
    if (!c.expiry) { past += 1; continue; }
    const dte = Math.floor((Date.parse(`${String(c.expiry).slice(0, 10)}T00:00:00Z`) - Date.parse(`${todayIso}T00:00:00Z`)) / 86_400_000);
    if (dte < 0) { past += 1; blocked.push({ symbol: c.symbol, expiry: c.expiry, dte, reason: 'EXPIRY_IN_PAST' }); }
    else if (dte < 1) { zero += 1; blocked.push({ symbol: c.symbol, expiry: c.expiry, dte, reason: 'DTE_ZERO_EXPIRY_DAY' }); }
    else { future += 1; }
  }
  return { dteZero: zero, expiryInPast: past, dteFuture: future, blockedByGate: blocked };
}

/** Which inputs genuinely exist, and which are unavailable — never invented. */
async function availability(conn, dateIso) {
  const one = async (sql, args = []) => (await conn.query(sql, args))[0];
  const idx = await one(
    `SELECT COUNT(*) n, MIN(ts) mn, MAX(ts) mx FROM unified_market_snapshots_history
      WHERE (symbol IN ('NSE:NIFTY50-INDEX','NSE:NIFTY50','NIFTY50','NSE:NIFTYBANK-INDEX','NSE:NIFTYBANK','NIFTYBANK','BSE:SENSEX-INDEX','BSE:SENSEX','SENSEX'))
        AND ts >= ? AND ts < DATE_ADD(?, INTERVAL 1 DAY)`, [`${dateIso} 00:00:00`, `${dateIso} 00:00:00`]);
  const opt = await one(
    `SELECT COUNT(*) n, COUNT(DISTINCT instrumentKey) syms, MAX(ts) mx FROM unified_option_quotes WHERE ts >= ? AND ts < DATE_ADD(?, INTERVAL 1 DAY)`,
    [`${dateIso} 00:00:00`, `${dateIso} 00:00:00`]);
  const greeks = await one(
    `SELECT SUM(iv IS NOT NULL) iv_n, SUM(delta IS NOT NULL) delta_n, SUM(gamma IS NOT NULL) gamma_n,
            SUM(bid IS NOT NULL) bid_n, SUM(ask IS NOT NULL) ask_n, SUM(oi IS NOT NULL) oi_n, SUM(changeOi IS NOT NULL) oi_chg_n
       FROM unified_option_quotes WHERE ts >= ? AND ts < DATE_ADD(?, INTERVAL 1 DAY)`,
    [`${dateIso} 00:00:00`, `${dateIso} 00:00:00`]);
  const fut = await one(`SELECT COUNT(*) n FROM unified_option_quotes WHERE instrumentKey LIKE '%FUT%' OR instrumentKey LIKE '%IDX%'`);
  const preopen = await one(`SELECT COUNT(*) n FROM pre_open_observations WHERE sessionDate = ?`, [dateIso]);
  return {
    index_ticks: { available: Number(idx[0].n) > 0, rows: Number(idx[0].n), first: idx[0].mn, last: idx[0].mx },
    option_quotes: { available: Number(opt[0].n) > 0, rows: Number(opt[0].n), symbols: Number(opt[0].syms || 0), last: opt[0].mx },
    greeks: {
      iv: Number(greeks[0].iv_n || 0), delta: Number(greeks[0].delta_n || 0), gamma: Number(greeks[0].gamma_n || 0),
      bid: Number(greeks[0].bid_n || 0), ask: Number(greeks[0].ask_n || 0),
      oi: Number(greeks[0].oi_n || 0), oiChange: Number(greeks[0].oi_chg_n || 0),
    },
    futures: { available: Number(fut[0].n) > 0, rows: Number(fut[0].n), reason: Number(fut[0].n) > 0 ? null : 'NO_FUTURES_TAPE_CAPTURED' },
    breadth: { available: false, reason: 'NO_COMPONENT_FEED_CAPTURED' },
    market_depth: { available: Number(greeks[0].bid_n || 0) > 0, scope: 'option ladder only; index depth not captured' },
    dealer_gamma: { available: false, reason: 'DEALER_BOOK_SIGN_NOT_OBSERVABLE — only a stated-assumption proxy exists' },
    pre_open: { available: Number(preopen[0].n) > 0, rows: Number(preopen[0].n) },
  };
}

/**
 * Normalise a MySQL DATE/DATETIME value to YYYY-MM-DD.
 * mysql2 returns DATE columns as a JS Date; String(date).slice(0,10) yields
 * "Tue Sep 29", which silently broke the DTE parse and made every contract look
 * like future-dated. Same defect class as the dry-run tool.
 */
function toIsoDate(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) {
    return new Date(v.getTime() - v.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
  }
  const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/** Contracts eligible for observation today, straight from the registry. */
async function loadContracts(conn) {
  const [rows] = await conn.query(
    `SELECT id, symbol, underlying, expiry, strike, optionType, lotSize
       FROM fnf_option_contracts WHERE expiry = ? ORDER BY underlying, strike, optionType`,
    [SESSION_DATE],
  );
  return rows.map((r) => ({
    id: r.id, symbol: r.symbol, underlying: r.underlying, expiry: toIsoDate(r.expiry),
    strike: Number(r.strike), optionType: r.optionType, lotSize: Number(r.lotSize),
  }));
}

function upsertMeta(patch) {
  let cur = {};
  if (fs.existsSync(META)) { try { cur = JSON.parse(fs.readFileSync(META, 'utf8')); } catch { cur = {}; } }
  const next = { ...cur, ...patch, updatedAt: new Date().toISOString() };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(META, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

async function tick({ nowMs = Date.now(), indexes = ['NIFTY', 'BANKNIFTY', 'SENSEX'] } = {}) {
  const istDate = C.istDateIso(nowMs);
  const phase = sessionPhase(nowMs);
  const record = {
    schema: 'expiry-session-cycle/v1',
    recordedAtUtc: new Date(nowMs).toISOString(),
    recordedAtIst: `${istDate} ${C.istHm(nowMs)}`,
    sessionDate: SESSION_DATE,
    istDate,
    phase,
    safety: SAFETY,
    paperAccount: {
      PAPER_CAPITAL_INR,
      PAPER_RISK_PER_TRADE_INR,
      note: 'CAPITAL_AT_RISK=0 reflects disabled live execution, NOT strategy performance',
    },
  };

  const cycles = [];
  const availabilityByIndex = {};
  let contracts = [];
  let dte = { dteZero: 0, expiryInPast: 0, dteFuture: 0, blockedByGate: [] };
  let contractMasterError = null;

  try {
    await A.withDb(async (conn) => {
      contracts = await loadContracts(conn);
      dte = dteZeroBlocks(contracts, SESSION_DATE);
      for (const idx of indexes) {
        availabilityByIndex[idx] = await availability(conn, istDate);
      }
    });
  } catch (e) {
    // Never let a tunnel blip abort the whole tick: record it and carry on.
    contractMasterError = e.message;
  }
  record.dbError = contractMasterError;
  record.contractMaster = {
    totalContracts: contracts.length,
    // Initial value is REQUIRED: with a flaky tunnel a read can legitimately
    // return zero contracts, and a bare reduce() throws 'Reduce of empty array',
    // losing the entire observation. An empty count is a fact, not a crash.
    byUnderlying: contracts.reduce((acc, c) => { acc[c.underlying] = (acc[c.underlying] ?? 0) + 1; return acc; }, {}),
    expiryMetadataError: 'CLEARED — 40 NIFTY/BANKNIFTY rows corrected to 2026-09-29; 0 remaining confirmed 2026-09-26 errors on NSE',
    sensexUnresolved: '62 BSE:SENSEX26SEP* rows remain EXPIRY_RECONCILIATION_UNRESOLVED and are NOT guessed',
    readError: contractMasterError,
  };
  record.dte = {
    DTE_ZERO_BLOCK: 'ACTIVE',
    dteZeroCount: dte.dteZero,
    expiryInPastCount: dte.expiryInPast,
    dteFutureCount: dte.dteFuture,
    gateLogic: 'dte < 1 excluded (UNCHANGED — same-day expiry contracts are not entry-eligible)',
    blockedSymbolsSample: dte.blockedByGate.slice(0, 12).map((b) => `${b.symbol} dte=${b.dte}`),
    blockedSymbolsTotal: dte.blockedByGate.length,
  };
  record.availability = availabilityByIndex;
  // Defensive: with a flaky tunnel a read can return zero rows, which must be
  // reported as unavailable rather than crashing the tick (an empty array here
  // previously threw 'Reduce of empty array' and lost the whole observation).
  if (!record.contractMaster.byUnderlying || Object.keys(record.contractMaster.byUnderlying).length === 0) {
    record.contractMaster.byUnderlying = {};
    record.contractMaster.readStatus = contractMasterError ? 'UNAVAILABLE_DB_ERROR' : 'UNAVAILABLE_NO_ROWS';
  }

  for (const idx of indexes) {
    try {
      const cycle = await A.withDb((conn) => A.runCycle(conn, { indexKey: idx, dateIso: istDate, nowMs, config: { daysToExpiry: 0 } }));
      cycles.push({
        index: idx,
        spot: cycle.spot,
        freshness: cycle.freshness,
        regime: { regime: cycle.regime?.regime, reason: cycle.regime?.reason, confidence: cycle.regime?.confidence, validated: cycle.regime?.validated },
        direction: {
          view: cycle.direction?.view,
          agreementShare: cycle.direction?.agreementShare,
          signalConflict: cycle.direction?.signalConflict,
          whyNoTrade: cycle.direction?.whyNoTrade,
          usableBuckets: (cycle.direction?.buckets ?? []).filter((b) => b.usable).length,
          abstainedBuckets: cycle.direction?.unusableBuckets,
        },
        noTrade: cycle.noTrade,
        tradeable: { verdict: cycle.tradeable?.verdict, tradeable: cycle.tradeable?.tradeable, blocking: cycle.tradeable?.blocking },
        optionMetrics: {
          atm: cycle.optionMetrics?.atm,
          impliedMove: cycle.impliedMove,
          iv: cycle.optionMetrics?.iv,
        },
        microstructure: cycle.microstructure ? {
          pcrOi: cycle.microstructure.pcrOi, pcrVol: cycle.microstructure.pcrVol,
          maxPain: cycle.microstructure.maxPain?.strike,
          callWall: cycle.microstructure.walls?.callWall?.strike,
          putWall: cycle.microstructure.walls?.putWall?.strike,
          callOiTotal: cycle.microstructure.callOiTotal, putOiTotal: cycle.microstructure.putOiTotal,
        } : null,
        openingRange: cycle.openingRange?.ready ? {
          orLow: cycle.openingRange.orLow, orHigh: cycle.openingRange.orHigh,
          closePos: cycle.openingRange.closePos, held: cycle.openingRange.held, breakFailed: cycle.openingRange.breakFailed,
        } : null,
        vwap: cycle.vwap,
        realised: cycle.realised,
        bars: cycle.data?.bars,
        ticks: cycle.data?.ticks,
        authority: cycle.authority,
      });
    } catch (e) {
      // The SSH tunnel to Oracle MySQL flaps intermittently during the session
      // (observed 6/10 successful probes). A dropped read must be recorded as
      // an unavailable observation, never silently written as a market fact.
      cycles.push({ index: idx, error: e.message, errorKind: e.code === 'ETIMEDOUT' || /ETIMEDOUT|timeout/i.test(e.message) ? 'DB_TUNNEL_TIMEOUT' : 'QUERY_ERROR' });
    }
  }
  record.cycles = cycles;

  // Paper entries: ZERO by construction. The DTE gate excludes every contract
  // expiring today, so the existing gates permit no entry. We record the reason
  // rather than relaxing a gate to manufacture activity.
  record.paper = {
    entryCount: 0,
    exitCount: 0,
    realizedPnlInr: 0,
    unrealizedPnlInr: 0,
    totalPnlInr: 0,
    rMultiple: null,
    maxDrawdownInr: 0,
    entryBlockReason: dte.dteZero > 0
      ? `DTE_ZERO_BLOCK_ACTIVE — all ${dte.dteZero} contract(s) expiring ${SESSION_DATE} have dte=0 and are excluded by the unchanged dte<1 gate`
      : 'NO_ELIGIBLE_CANDIDATE',
    liveOrderCount: 0,
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.appendFileSync(CYCLES, `${JSON.stringify(record)}\n`);
  upsertMeta({ sessionDate: SESSION_DATE, lastCycleIst: record.recordedAtIst, cycles: countCycles(), safety: SAFETY });
  return record;
}

function countCycles() {
  if (!fs.existsSync(CYCLES)) return 0;
  return fs.readFileSync(CYCLES, 'utf8').split('\n').filter(Boolean).length;
}

/** End-of-session roll-up over every recorded cycle. */
function report() {
  const lines = fs.existsSync(CYCLES) ? fs.readFileSync(CYCLES, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];
  const byType = {}; const byIndex = {};
  let dteZeroBlocks = 0; let conflicts = 0; let insufficient = 0; let unvalidated = 0; let safety = 0; let liquidity = 0; let risk = 0;
  let first = null; let last = null; const gaps = new Set();
  let paperEntries = 0; let paperExits = 0; let realized = 0; let unrealized = 0; let maxDd = 0;
  for (const c of lines) {
    first = first ?? c.recordedAtIst;
    last = c.recordedAtIst;
    for (const cy of c.cycles ?? []) {
      byIndex[cy.index] = (byIndex[cy.index] ?? 0) + 1;
      if (cy.direction?.signalConflict) conflicts += 1;
      const t = cy.noTrade?.type;
      if (t) { byType[t] = (byType[t] ?? 0) + 1; if (t === 'SAFETY') safety += 1; if (t === 'INSUFFICIENT_DATA') insufficient += 1; if (t === 'CONFLICTING_EVIDENCE') conflicts += 1; if (t === 'NO_VALIDATED_EDGE') unvalidated += 1; if (t === 'LIQUIDITY') liquidity += 1; if (t === 'RISK') risk += 1; }
      for (const b of cy.direction?.abstainedBuckets ?? []) gaps.add(`${b} (${cy.index})`);
    }
    dteZeroBlocks = Math.max(dteZeroBlocks, c.dte?.dteZeroCount ?? 0);
    paperEntries += c.paper?.entryCount ?? 0;
    paperExits += c.paper?.exitCount ?? 0;
    realized += c.paper?.realizedPnlInr ?? 0;
    unrealized = c.paper?.unrealizedPnlInr ?? 0;
    maxDd = Math.max(maxDd, c.paper?.maxDrawdownInr ?? 0);
  }
  const total = lines.length;
  return {
    SESSION_DATE,
    DATA_START: first ?? null,
    DATA_END: last ?? null,
    CYCLES_RECORDED: total,
    CONTRACTS_OBSERVED: lines[lines.length - 1]?.contractMaster?.totalContracts ?? 0,
    DTE_ZERO_BLOCK_COUNT: dteZeroBlocks,
    DTE_ZERO_BLOCK: 'ACTIVE',
    EXPIRY_METADATA_ERROR: 'CLEARED',
    NO_TRADE_COUNT: Object.values(byType).reduce((a, b) => a + b, 0),
    NO_TRADE_BY_TYPE: byType,
    SAFETY_VETO_COUNT: safety,
    LIQUIDITY_VETO_COUNT: liquidity,
    RISK_VETO_COUNT: risk,
    DATA_INSUFFICIENCY_COUNT: insufficient,
    CONFLICTING_EVIDENCE_COUNT: conflicts,
    UNVALIDATED_EDGE_COUNT: unvalidated,
    PAPER_ENTRY_COUNT: paperEntries,
    PAPER_EXIT_COUNT: paperExits,
    PAPER_REALIZED_PNL: realized,
    PAPER_UNREALIZED_PNL: unrealized,
    PAPER_TOTAL_PNL: realized + unrealized,
    PAPER_R_MULTIPLE: null,
    PAPER_MAX_DRAWDOWN: maxDd,
    PAPER_CAPITAL_INR: PAPER_CAPITAL_INR,
    PAPER_RISK_PER_TRADE_INR: PAPER_RISK_PER_TRADE_INR,
    LIVE_ORDER_COUNT: 0,
    DATA_GAPS: [...gaps],
    HISTORICAL_VALIDATION_STATUS: 'UNVALIDATED — verified historical expiry sessions = 0',
    STRATEGY_VALIDATION_STATUS: 'UNARMED / UNVALIDATED — evidence threshold 65, N=5, 12:00 rollover preference, 13:30 cutoff, +1R breakeven trailing all remain heuristic',
    UNVALIDATED_PARAMS: ['evidence threshold 65', 'N=5', '12:00 rollover preference', '13:30 cutoff', '+1R breakeven trailing'],
    CYCLES_BY_INDEX: byIndex,
    SAFETY,
    artifacts: { cycles: CYCLES, meta: META },
  };
}

module.exports = { SAFETY, tick, report, sessionPhase, dteZeroBlocks, countCycles, OUT_DIR, CYCLES, SESSION_DATE };

if (require.main === module) {
  const mode = process.argv[2] || 'tick';
  const done = mode === 'report' ? Promise.resolve(report()) : tick();
  done.then((r) => {
    if (mode === 'report') {
      console.log(JSON.stringify(r, null, 2));
    } else {
      console.log(`[${r.recordedAtIst}] phase=${r.phase} cycles=${r.cycles.length} dteZero=${r.dte.dteZeroCount} ` +
        r.cycles.map((c) => `${c.index}:${c.direction?.view ?? 'ERR'}/${c.noTrade?.type ?? '-'}`).join(' '));
    }
  }).catch((e) => { console.error('recorder failed:', e.message); process.exit(1); });
}
