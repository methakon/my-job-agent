#!/usr/bin/env node
/**
 * expiry-day analysis — data access + orchestration (READ-ONLY against the DB).
 *
 * Every query here is a SELECT. The module produces classifications and
 * explanations; it never writes to a trading table and never places an order.
 *
 * DATA CLOCK: `ts` on unified_* rows is IST wall clock while the MySQL server
 * runs NOW() in UTC, so all freshness is computed against the IST clock
 * (expiry-day-core.istNowMs), never against SQL NOW().
 */
'use strict';

const mysql = require('mysql2/promise');
require('dotenv').config();
const C = require('./expiry-day-core');
const R = require('./expiry-day-regime');
const S = require('./expiry-day-signals');
const { tagSetups } = require('./expiry-day-setups');

// Symbol ALIASES are required, not cosmetic: the index tape has been written
// under more than one symbol for the same index (e.g. NSE:NIFTY50 on
// 2026-09-28 vs NSE:NIFTY50-INDEX on 2026-09-24). Querying a single string
// silently returns zero ticks, which then reads as "no market activity"
// instead of "wrong key". We union the aliases and keep the freshest tape.
const INDEXES = {
  NIFTY: { symbol: 'NSE:NIFTY50-INDEX', aliases: ['NSE:NIFTY50-INDEX', 'NSE:NIFTY50', 'NIFTY50'], label: 'NIFTY' },
  BANKNIFTY: { symbol: 'NSE:NIFTYBANK-INDEX', aliases: ['NSE:NIFTYBANK-INDEX', 'NSE:NIFTYBANK', 'NIFTYBANK'], label: 'BANKNIFTY' },
  SENSEX: { symbol: 'BSE:SENSEX-INDEX', aliases: ['BSE:SENSEX-INDEX', 'BSE:SENSEX', 'SENSEX'], label: 'SENSEX' },
};

// Symbol prefixes per index for the EXPIRING series, WITHOUT trailing
// wildcards (the wildcard is applied per-pattern at query time). The namespace
// differs by BROKER and both are live simultaneously:
//   FYERS  → month+year      e.g. NSE:NIFTY26SEP22800CE   (2026-09-29 expiry)
//   Upstox → day+month+year  e.g. NSE:NIFTY29SEP22800CE   (SAME contract)
// Matching only one namespace silently returns an EMPTY chain and reads as
// "no option data" when the other broker is streaming it.
// `anchor` additionally enforces the index boundary: LIKE has no word
// boundary, so 'NSE:NIFTY29SEP%' would also match 'NSE:BANKNIFTY29SEP…'.
const OPTION_SERIES = {
  NIFTY: {
    prefixes: ['NSE:NIFTY26SEP', 'NSE:NIFTY29SEP', 'NSE_INDEX:NIFTY26SEP', 'NSE_INDEX:NIFTY29SEP'],
    anchor: 'NSE:NIFTY',          // never matches NSE:BANKNIFTY
  },
  BANKNIFTY: {
    prefixes: ['NSE:BANKNIFTY26SEP', 'NSE:BANKNIFTY29SEP', 'NSE_INDEX:BANKNIFTY26SEP', 'NSE_INDEX:BANKNIFTY29SEP'],
    anchor: 'NSE:BANKNIFTY',
  },
  SENSEX: {
    prefixes: ['BSE:SENSEX26O01', 'BSE:SENSEX01OCT', 'BSE_INDEX:SENSEX26O01', 'BSE_INDEX:SENSEX01OCT', 'BSE:SENSEX26SEP'],
    anchor: 'BSE:SENSEX',
  },
};

function dbConfig() {
  return {
    host: process.env.MYSQL_HOST,
    port: Number(process.env.MYSQL_PORT || 3307),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: 'myjob_agent',
    timezone: 'Z',
  };
}

async function withDb(fn) {
  const conn = await mysql.createConnection(dbConfig());
  try { return await fn(conn); } finally { await conn.end(); }
}

// ───────────────────────────── index tape ────────────────────────────────

/** All tape symbols that may hold this index (canonical + historical aliases). */
function tapeSymbols(idx) {
  return idx.aliases?.length ? idx.aliases : [idx.symbol];
}

/** Intraday LTP/volume observations for an index symbol on one IST date. */
async function fetchIndexTicks(conn, symbol, dateIso) {
  const symbols = Array.isArray(symbol) ? symbol : [symbol];
  const inList = symbols.map(() => 'symbol = ?').join(' OR ');
  const [rows] = await conn.query(
    `SELECT ts, ltp, volume, symbol FROM unified_market_snapshots_history
      WHERE (${inList}) AND ts >= ? AND ts < DATE_ADD(?, INTERVAL 1 DAY)
      ORDER BY ts ASC`,
    [...symbols, `${dateIso} 00:00:00`, `${dateIso} 00:00:00`],
  );
  return rows.map((r) => ({ ts: r.ts, ltp: Number(r.ltp), volume: Number(r.volume) || 0, symbol: r.symbol }));
}

/** Previous session's close/H/L/VWAP for an index (the day before dateIso). */
async function fetchPreviousSession(conn, idx, dateIso) {
  const [rows] = await conn.query(
    `SELECT DATE(ts) d, MIN(ltp) lo, MAX(ltp) hi, SUBSTRING_INDEX(GROUP_CONCAT(ltp ORDER BY ts DESC), ',', 1) close, SUM(volume) vol
       FROM unified_market_snapshots_history
      WHERE symbol IN (?) AND ts < ? AND ts >= DATE_SUB(?, INTERVAL 12 DAY)
      GROUP BY DATE(ts) ORDER BY d DESC LIMIT 1`,
    [[...tapeSymbols(idx)], `${dateIso} 00:00:00`, `${dateIso} 00:00:00`],
  );
  const r = rows[0];
  if (!r) return null;
  return { date: r.d, low: Number(r.lo), high: Number(r.hi), close: Number(r.close), volume: Number(r.vol) || 0 };
}

/** Latest option-chain snapshot for the expiring series, grouped by strike. */
async function fetchOptionChain(conn, prefixes, dateIso, underlyingPrefix) {
  // Each prefix is an EXACT string prefix (no trailing '%'). The wildcard is
  // applied per pattern, and an additional `underlyingPrefix` anchor enforces
  // the index boundary: LIKE has no word boundary, so 'NSE:NIFTY29SEP%' also
  // matches 'NSE:BANKNIFTY29SEP…'. That silently merged the BANKNIFTY ladder
  // into the NIFTY chain and made the ATM straddle unresolvable.
  const like = prefixes.map(() => 'instrumentKey LIKE ?').join(' OR ');
  const args = [...prefixes.map((p) => `${p}%`)];
  const anchor = underlyingPrefix ? 'AND u.instrumentKey LIKE ?' : '';
  if (underlyingPrefix) args.push(`${underlyingPrefix}%`);
  const [rows] = await conn.query(
    `SELECT u.instrumentKey, u.strike, u.optionType, u.ltp, u.bid, u.ask, u.bidQty, u.askQty,
            u.volume, u.oi, u.previousOi, u.changeOi, u.iv, u.delta, u.gamma, u.theta, u.vega,
            u.expiry, u.source, u.sourceTimestamp, u.receivedTimestamp, u.ts
       FROM unified_option_quotes u
       JOIN (SELECT instrumentKey, MAX(ts) mx FROM unified_option_quotes
              WHERE ts >= ? AND (${like}) GROUP BY instrumentKey) t
         ON t.instrumentKey = u.instrumentKey AND t.mx = u.ts
      ${anchor}`,
    [`${dateIso} 00:00:00`, ...args],
  );
  const byStrike = new Map();
  let source = null; let lastTs = null; let lastSourceTs = null;
  for (const r of rows) {
    const k = Number(r.strike);
    if (!byStrike.has(k)) byStrike.set(k, { strike: k, ce: null, pe: null });
    const leg = r.optionType === 'CE' ? 'ce' : 'pe';
    byStrike.get(k)[leg] = r;
    source = source || r.source;
    const tsMs = C.parseIstTs(r.ts);
    const stMs = C.parseIstTs(r.sourceTimestamp);
    if (tsMs && (lastTs === null || tsMs > lastTs)) lastTs = tsMs;
    if (stMs && (lastSourceTs === null || stMs > lastSourceTs)) lastSourceTs = stMs;
  }
  const chain = [...byStrike.values()].sort((a, b) => a.strike - b.strike).map((s) => ({
    strike: s.strike,
    ceOi: Number(s.ce?.oi) || 0, peOi: Number(s.pe?.oi) || 0,
    ceChg: Number(s.ce?.changeOi) || 0, peChg: Number(s.pe?.changeOi) || 0,
    ceVol: Number(s.ce?.volume) || 0, peVol: Number(s.pe?.volume) || 0,
    ceLtp: Number(s.ce?.ltp) || 0, peLtp: Number(s.pe?.ltp) || 0,
    ce: s.ce, pe: s.pe,
  }));
  return { chain, source, rows: rows.length, lastTs: lastTs ? new Date(lastTs).toISOString().slice(0, 19).replace('T', ' ') : null, lastSourceTs: lastSourceTs ? new Date(lastSourceTs).toISOString().slice(0, 19).replace('T', ' ') : null };
}

/** Build the microstructure snapshot (walls, PCR, max pain, concentration). */
function microstructure(chain) {
  const totalCe = chain.reduce((a, r) => a + r.ceOi, 0);
  const totalPe = chain.reduce((a, r) => a + r.peOi, 0);
  const totalCeVol = chain.reduce((a, r) => a + r.ceVol, 0);
  const totalPeVol = chain.reduce((a, r) => a + r.peVol, 0);
  const walls = (() => {
    let callWall = null; let putWall = null;
    for (const r of chain) {
      if (!callWall || r.ceOi > callWall.oi) callWall = { strike: r.strike, oi: r.ceOi };
      if (!putWall || r.peOi > putWall.oi) putWall = { strike: r.strike, oi: r.peOi };
    }
    return { callWall, putWall };
  })();
  return {
    pcrOi: totalCe > 0 ? C.r2(totalPe / totalCe, 4) : null,
    pcrVol: totalCeVol > 0 ? C.r2(totalPeVol / totalCeVol, 4) : null,
    callOiTotal: totalCe, putOiTotal: totalPe,
    callVolTotal: totalCeVol, putVolTotal: totalPeVol,
    callChgTotal: chain.reduce((a, r) => a + r.ceChg, 0),
    putChgTotal: chain.reduce((a, r) => a + r.peChg, 0),
    walls,
    maxPain: C.maxPainStrikes(chain),
    concentration: C.oiConcentration(chain, 3),
    migrations: C.oiMigrations(chain, 5),
    strikes: chain.length,
  };
}

/** ATM straddle + implied move + ATM IV/skew from the chain. */
function optionMetrics(chain, spot, expiryIso) {
  const twoSided = chain.filter((r) => r.ceLtp > 0 && r.peLtp > 0);
  if (!twoSided.length || !Number.isFinite(spot)) return { atm: null, impliedMove: null, note: 'no two-sided quotes or no spot' };
  let atm = twoSided[0];
  for (const r of twoSided) if (Math.abs(r.strike - spot) < Math.abs(atm.strike - spot)) atm = r;
  const premium = atm.ceLtp + atm.peLtp;
  const ivs = chain.map((r) => Number(r.ce?.iv)).filter(Number.isFinite);
  const pvs = chain.map((r) => Number(r.pe?.iv)).filter(Number.isFinite);
  const atmIv = Number(atm.ce?.iv ?? atm.pe?.iv);
  const call25 = chain.find((r) => Number.isFinite(Number(r.ce?.iv)) && Math.abs(r.strike - spot) / spot <= 0.03);
  const put25 = chain.filter((r) => Number.isFinite(Number(r.pe?.iv))).sort((a, b) => Math.abs(b.strike - spot) - Math.abs(a.strike - spot))[0];
  return {
    atm: {
      strike: atm.strike, ceLtp: atm.ceLtp, peLtp: atm.peLtp, premium: C.r2(premium, 2),
      ceOi: atm.ceOi, peOi: atm.peOi, ceVol: atm.ceVol, peVol: atm.peVol,
      bid: atm.ce?.bid ?? null, ask: atm.ce?.ask ?? null,
      spread: C.spreadMetrics(atm.ce?.bid, atm.ce?.ask, atm.ce?.ltp),
      delta: C.r2(Number(atm.ce?.delta), 6), gamma: C.r2(Number(atm.ce?.gamma), 8),
      theta: C.r2(Number(atm.ce?.theta), 6), vega: C.r2(Number(atm.ce?.vega), 6),
    },
    impliedMove: C.impliedMoveFromStraddle(premium, spot),
    iv: {
      atm: Number.isFinite(atmIv) ? C.r2(atmIv, 2) : null,
      call25: call25 ? C.r2(Number(call25.ce?.iv), 2) : null,
      put25: put25 ? C.r2(Number(put25.pe?.iv), 2) : null,
      skew25d: (call25 && put25) ? C.r2(Number(call25.ce?.iv) - Number(put25.pe?.iv), 2) : null,
      mean: ivs.length ? C.r2(ivs.reduce((a, x) => a + x, 0) / ivs.length, 2) : null,
      meanPut: pvs.length ? C.r2(pvs.reduce((a, x) => a + x, 0) / pvs.length, 2) : null,
    },
    expiryIso: expiryIso ?? null,
  };
}

/** Dealer-gamma PROXY with its assumption stated explicitly. */
function dealerGammaProxy(chain, spot, expiryIso, { daysToExpiry = 0 } = {}) {
  // We do not know which side of the book is long. Standard practice assumes
  // customers are net short calls / long puts, making dealers long gamma. This
  // is an ASSUMPTION, so the output is a context line with zero directional vote.
  const rows = chain.filter((r) => Number.isFinite(Number(r.ce?.gamma)));
  if (!rows.length || !Number.isFinite(spot) || rows.length < 5) return null;
  let netGamma = 0;
  let totalOi = 0;
  for (const r of rows) {
    const g = Number(r.ce.gamma) * Number(r.ce.oi || 0);
    const p = Number(r.pe.gamma) * Number(r.pe.oi || 0);
    netGamma += g - p;          // customers long puts ⇒ dealers short put gamma
    totalOi += Number(r.ce.oi || 0) + Number(r.pe.oi || 0);
  }
  const closest = rows.reduce((best, r) => (Math.abs(r.strike - spot) < Math.abs(best.strike - spot) ? r : best), rows[0]);
  return {
    assumption: 'customers net long puts / short calls ⇒ dealers long gamma (UNVERIFIABLE from public data)',
    netGamma: C.r2(netGamma, 2),
    netGammaSign: netGamma > 0 ? 'POSITIVE_DEALER_LONG_GAMMA' : 'NEGATIVE_DEALER_SHORT_GAMMA',
    gammaFlip: closest.strike,
    daysToExpiry,
    note: 'sign is assumption-dependent; used as regime context only, never as a directional vote',
  };
}

// ───────────────────────────── the cycle ─────────────────────────────────

/**
 * Run one full observation cycle for one index on one date.
 * Returns a JSON-serialisable report (no order, no sizing).
 */
async function runCycle(conn, { indexKey, dateIso, nowMs = Date.now(), config = {} }) {
  const idx = INDEXES[indexKey];
  const out = { index: indexKey, symbol: idx.symbol, dateIso, generatedAt: new Date(nowMs).toISOString(), istNow: C.istHm(nowMs) };
  if (!idx) return { ...out, error: 'UNKNOWN_INDEX' };

  const [ticks, prev, chainRes] = await Promise.all([
    fetchIndexTicks(conn, tapeSymbols(idx), dateIso),
    fetchPreviousSession(conn, tapeSymbols(idx), dateIso),
    fetchOptionChain(conn, OPTION_SERIES[indexKey]?.prefixes ?? [], dateIso, OPTION_SERIES[indexKey]?.anchor),
  ]);
  const chain = chainRes.chain;
  const last = ticks[ticks.length - 1] ?? null;
  const spot = last ? last.ltp : null;

  const dataFresh = C.datumFreshness({
    marketDataTimestamp: last?.ts ?? null,
    optionChainTimestamp: chainRes.lastTs,
    tickTimestamp: last?.ts ?? null,
    nowMs,
  });

  const bars = C.buildBars(ticks, 5, dateIso);
  const or = C.openingRangeState(bars, { orMinutes: config.orMinutes ?? 15, breakBufferPct: config.breakBufferPct ?? 0.10 });
  const vwap = bars.length ? C.vwapReclaimState(bars, bars[bars.length - 1].vwap, { barsBack: config.vwapBarsBack ?? 6 }) : { state: 'UNKNOWN' };

  // Opening gap vs the PREVIOUS session close.
  let gap = null;
  if (prev && prev.close > 0 && last) {
    const gapPct = ((last.ltp - prev.close) / prev.close) * 100;
    gap = { pct: C.r2(gapPct, 3), class: C.classifyGap(gapPct, config.gapThresholds ?? {}) };
  }

  const micro = chain.length ? microstructure(chain) : null;
  const opt = chain.length ? optionMetrics(chain, spot ?? NaN) : { atm: null, impliedMove: null };
  const proxy = chain.length ? dealerGammaProxy(chain, spot ?? NaN, dateIso, { daysToExpiry: config.daysToExpiry ?? 0 }) : null;

  const impliedMove = opt.impliedMove ?? null;
  const regime = R.classifyRegime({
    bars, or, vwap, impliedMovePts: impliedMove?.impliedMovePts ?? null,
    volumeBaseline: R.medianVolume(bars),
    wallRejections: micro ? {
      up: R.countBoundaryRejections(bars, micro.walls.callWall?.strike, 'UP'),
      down: R.countBoundaryRejections(bars, micro.walls.putWall?.strike, 'DOWN'),
    } : null,
    vwapCrosses: R.countVwapCrosses(bars),
    corridor: micro ? { low: micro.walls.putWall?.strike, high: micro.walls.callWall?.strike } : null,
  }, config.regimeThresholds ?? {});

  const direction = S.classifyDirection({
    bars, or, vwapState: vwap, regime,
    spot, dataFresh,
    walls: micro?.walls, microstructure: micro,
    impliedMove: impliedMove ? { impliedMovePts: impliedMove.impliedMovePts, ratio: null } : null,
    iv: opt.iv, quote: opt.atm ? { bidQty: opt.atm.ce?.bidQty ?? null, askQty: opt.atm.ce?.askQty ?? null } : null,
    oiChange: micro ? { callChange: micro.callChgTotal, putChange: micro.putChgTotal } : null,
    gap: gap && impliedMove ? {
      ...gap,
      position: C.openingPositionInImpliedRange(last.ltp, impliedMove.impliedLow, impliedMove.impliedHigh).position,
    } : gap,
    dealerGamma: proxy,
  }, config.signalConfig ?? {});

  const minutesToClose = (() => {
    const mins = C.istMinutesOfDay(C.istNowDate(nowMs));
    const close = 15 * 60 + 30;
    return dateIso === C.istDateIso(nowMs) ? close - mins : null;
  })();

  const entryView = {
    locationAcceptable: null,
    locationDetail: 'no candidate instrument selected in this observation cycle',
    volume: opt.atm?.ceVol ?? null,
    openInterest: opt.atm?.ceOi ?? null,
    spreadPctOfMid: opt.atm?.spread?.spreadPctOfMid ?? null,
    iv: opt.iv?.atm ?? null,
    minutesToClose,
    expectedMovePoints: impliedMove?.impliedMovePts ?? null,
    roundTripCostPoints: null,
    alreadyMovedPct: null,
    riskReward: null,
  };
  const tradeable = S.evaluateTradeable(direction, entryView, {
    permitsExpiryStrategy: false,          // NOT approved by the operator
    ...config.policy,
  });
  // Refine the NO_TRADE label WITHOUT changing behaviour or dropping detail:
  // whyNoTrade[] and blocking[] remain the auditable record.
  const noTrade = S.classifyNoTrade({
    view: direction.view,
    whyNoTrade: direction.whyNoTrade,
    blocking: tradeable.blocking,
    signalConflict: direction.signalConflict,
    regime: regime?.regime,
    validated: regime?.validated,
  });
  const setups = tagSetups({ direction, tradeable, regime, or, vwapState: vwap, walls: micro?.walls, spot, impliedMovePts: impliedMove?.impliedMovePts });

  return {
    ...out,
    data: {
      ticks: ticks.length, bars: bars.length, firstTick: ticks[0]?.ts ?? null, lastTick: last?.ts ?? null,
      chainRows: chainRes.rows, chainSource: chainRes.source, chainLastTs: chainRes.lastTs,
      previousSession: prev,
    },
    freshness: dataFresh,
    spot,
    gap,
    openingRange: or,
    vwap: { ...vwap, vwap: bars.length ? bars[bars.length - 1].vwap : null },
    bars: bars.map((b) => ({ t: b.bucketMinutes, o: b.open, h: b.high, l: b.low, c: b.close, v: b.volume, vwap: b.vwap })),
    realised: C.realisedRange(bars),
    impliedMove,
    optionMetrics: opt,
    microstructure: micro,
    dealerGammaProxy: proxy,
    regime,
    direction,
    tradeable,
    noTrade: {
      ...noTrade,
      // Behaviour is unchanged by this field: it is a label over the existing
      // verdict, and the full reason chain is preserved alongside it.
      verdict: tradeable.verdict,
      whyNoTrade: direction.whyNoTrade,
      blocking: tradeable.blocking,
    },
    setups,
    // Explicit, machine-readable statement: this engine never authorises a trade.
    authority: {
      canPlaceOrder: false,
      canSizePosition: false,
      canModifyRiskLimits: false,
      existingRiskEngineRemainsSoleAuthority: true,
      realOrderAllowedEnv: process.env.REAL_ORDER_ALLOWED ?? 'unset',
      note: 'EXPIRY STRATEGY NOT ARMED. All outputs are observations for operator review.',
    },
  };
}

module.exports = {
  INDEXES, OPTION_SERIES, dbConfig, withDb, fetchIndexTicks, fetchPreviousSession,
  fetchOptionChain, microstructure, optionMetrics, dealerGammaProxy, runCycle,
};
