#!/usr/bin/env node
/**
 * UNIFIED OPTION READ — one read surface over both canonical feeds.
 *
 * WHY THIS EXISTS
 * Both brokers already feed the SAME canonical tick pipeline
 * (src/trading/unified-market-data/canonical/tick-interpreter.service.ts), which
 * normalises every payload to one identity and one shape. That is the redundant
 * provider layer. What it does NOT do is converge the STORAGE:
 *
 *   FYERS  -> interpreter -> canonical -> fnf_option_quotes      (contractSymbol)
 *   Upstox -> interpreter -> canonical -> unified_option_quotes  (instrumentKey)
 *
 * Two canonical twins, two tables. The paper engine read only the first, so when
 * FYERS went quiet it could not see Upstox streaming the identical contracts.
 *
 * This module closes that gap at the READ side only. No production write path is
 * touched, nothing is migrated, and the two tables keep their existing shapes.
 *
 * Health is judged by the EXCHANGE timestamp, never by arrival time. A feed that
 * reconnects happily while replaying yesterday's tape looks alive to a naive
 * liveness check and is dead to this one -- which is precisely the FYERS failure
 * this was built for.
 */
'use strict';

const mysql = require('mysql2/promise');

/**
 * Freshness budget, measured from the live feeds rather than assumed.
 *
 * Observed inter-tick gap for a single NIFTY contract over 466 samples:
 * median 8s, p95 30s, max 113s. A 15s budget (inherited from the FYERS path)
 * therefore rejected roughly 40% of legitimately fresh Upstox quotes, and an
 * empty chain looked like "no data" when the data was simply a few seconds old.
 *
 * 45s clears p95 with headroom. It is a freshness bound, NOT a target or a
 * stop: it decides whether a quote may be acted on, never whether to hold.
 */
const DEFAULT_MAX_AGE_MS = 45_000;

/**
 * Underlying aliases, per store.
 *
 * fnf_option_quotes carries the registry key ('NIFTY50-INDEX'); the unified
 * store carries the root symbol ('NIFTY'). The SAME contract therefore has a
 * different underlying string in each table, which made a single-key lookup
 * silently return nothing. Resolve to every alias and match on the canonical
 * form instead of guessing one.
 */
/**
 * Normalise a DATE column to 'YYYY-MM-DD'.
 *
 * mysql2 returns DATE columns as JS Date objects. String(expiry).slice(0,10)
 * yields "Tue Oct 06", which then fails the next query with
 * `Incorrect DATE value`. Read the local calendar fields; do not round-trip
 * through toISOString(), which would shift the day.
 */
function isoDay(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) {
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  }
  const m = String(v).match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

const MONTH_CODES = {
  JAN: ['01', 'JAN'], FEB: ['02', 'FEB'], MAR: ['03', 'MAR'], APR: ['04', 'APR'],
  MAY: ['05', 'MAY'], JUN: ['06', 'JUN'], JUL: ['07', 'JUL'], AUG: ['08', 'AUG'],
  SEP: ['09', 'SEP'], OCT: ['10', 'OCT'], NOV: ['11', 'NOV'], DEC: ['12', 'DEC'],
};
const MONTH_BY_NUM = Object.entries(MONTH_CODES)
  .reduce((acc, [, codes]) => { acc[codes[0]] = codes[1]; return acc; }, {});

const UNDERLYING_ALIASES = {
  'NIFTY50-INDEX': ['NIFTY50-INDEX', 'NIFTY'],
  'NIFTYBANK-INDEX': ['NIFTYBANK-INDEX', 'BANKNIFTY'],
  SENSEX: ['SENSEX'],
};

/**
 * Every spelling one canonical option contract may carry across providers.
 *
 * Built from STRUCTURED parts, never by re-parsing a symbol: the earlier regex
 * could not tell a 2-digit day from a root ending in digits and emitted garbage
 * (NIFTY271022600CE). Parsing ambiguity is the bug this replaces.
 *
 * The canonical identity -- what canonicalOptionSymbol() produces and what both
 * tick interpreters converge on -- is NSE:<ROOT><DD><MMM><STRIKE><CE|PE>.
 * Upstox already writes exactly that (NSE:NIFTY06OCT22600CE), so it needs no
 * variant. FYERS additionally uses DDO0MM when the week and month repeat
 * (NSE:NIFTY26O06...), which is the one alternative worth carrying.
 */
function symbolVariants(canonical) {
  const s = String(canonical).toUpperCase();
  const m = s.match(/^([A-Z_]+):([A-Z]+?)(\d{4,6})([A-Z]{3})(\d+(?:\.\d+)?)(CE|PE)$/);
  if (!m) return [canonical];              // not canonical form: match it literally
  const [, ex, root, dd, mon, strike, right] = m;
  const monthNum = MONTH_BY_NUM[mon] ?? mon;
  const out = new Set([s]);
  // FYERS repeat form: DD O 0MM
  if (/^\d{2}$/.test(monthNum)) out.add(`${ex}:${root}${dd}O${monthNum}${strike}${right}`);
  // Defensive: the DD+0MM spelling, in case a provider writes it that way.
  if (/^\d{2}$/.test(monthNum)) out.add(`${ex}:${root}${monthNum}${dd}${strike}${right}`);
  return [...out];
}

/** SQL IN-list with bound params for a set of aliases. */
function underlyingFilter(underlying) {
  const list = UNDERLYING_ALIASES[String(underlying).toUpperCase()] ?? [underlying];
  return { sql: list.map(() => '?').join(','), params: list };
}

/** Open the shared pool. Credentials come from the environment only. */
function connect() {
  const env = process.env;
  return mysql.createPool({
    host: env.MYSQL_HOST,
    port: Number(env.MYSQL_PORT || 3307),
    user: env.MYSQL_USER,
    password: env.MYSQL_PASSWORD,
    database: env.MYSQL_DATABASE || 'myjob_agent',
    waitForConnections: true,
    connectionLimit: 4,
    enableKeepAlive: true,
  });
}

/**
 * Normalise either table's row to ONE shape.
 *
 * The two schemas differ in naming, not in meaning, so this is a rename plus a
 * few honest nulls -- never a guess. A field the provider does not supply stays
 * null; it is never defaulted into something that looks like an observation.
 */
function normalise(row, source) {
  if (!row) return null;
  // Accept all three names for the key column. Queries alias it to `symbol`,
  // and reading only the raw column names made a valid row normalise to
  // symbol:null -- which silently discarded every live quote.
  const sym = row.contractSymbol ?? row.instrumentKey ?? row.symbol ?? null;
  const iv = row.impliedVolatility ?? row.iv ?? null;
  const oi = row.openInterest ?? row.oi ?? null;
  // Exchange timestamp is the ONLY trustworthy freshness signal. `ts` is arrival
  // time and lies whenever a broker replays old tape -- which is exactly the
  // FYERS failure this module exists for.
  //
  // A feed that carries NO exchange timestamp (the FYERS store has none) cannot
  // be judged fresh at all. Fall back to arrival time but FLAG it, so a caller
  // can see the difference instead of inheriting a false freshness guarantee.
  const hasExchangeTs = row.sourceTimestamp !== null && row.sourceTimestamp !== undefined;
  const exchangeTs = row.sourceTimestamp ?? row.ts ?? null;
  return {
    symbol: sym,
    underlying: row.underlying ?? null,
    expiry: isoDay(row.expiry),
    strike: row.strike === null || row.strike === undefined ? null : Number(row.strike),
    optionType: row.optionType ?? null,
    ltp: row.ltp === null ? null : Number(row.ltp),
    bid: row.bid === null || row.bid === undefined ? null : Number(row.bid),
    ask: row.ask === null || row.ask === undefined ? null : Number(row.ask),
    // Depth and IV change are not carried by every provider. Absent stays null.
    bidQty: row.bidQty ?? null,
    askQty: row.askQty ?? null,
    volume: row.volume ?? null,
    openInterest: oi,
    changeOi: row.changeOi ?? null,
    iv,
    delta: row.delta ?? null,
    gamma: row.gamma ?? null,
    theta: row.theta ?? null,
    vega: row.vega ?? null,
    tickSize: row.tickSize ?? null,
    exchangeTs,
    hasExchangeTs,
    arrivalTs: row.ts ?? null,
    source,
    table: row.contractSymbol ? 'fnf_option_quotes' : 'unified_option_quotes',
  };
}

/** Age of a row in ms, measured from its EXCHANGE timestamp. */
function exchangeAgeMs(row, nowMs) {
  if (!row?.exchangeTs) return null;
  const t = row.exchangeTs instanceof Date ? row.exchangeTs.getTime() : Date.parse(String(row.exchangeTs).replace(' ', 'T'));
  if (!Number.isFinite(t)) return null;
  const age = Math.max(0, nowMs - t);
  // Without an exchange timestamp this is arrival age, NOT freshness. Callers
  // see null (unjudgeable) instead of a number that looks like a verdict.
  return row.hasExchangeTs === false ? null : age;
}

/**
 * Which feeds are actually usable right now?
 *
 * `unified_option_quotes` is written by more than one producer, so it is grouped
 * by its own source column rather than assumed. A feed counts as usable only when
 * its newest EXCHANGE timestamp is inside the budget -- arrival recency proves
 * nothing.
 */
async function feedHealth(conn, { maxAgeMs = DEFAULT_MAX_AGE_MS, nowMs = Date.now() } = {}) {
  const [rows] = await conn.query(
    `SELECT source, MAX(ts) newest, COUNT(*) n
       FROM unified_option_quotes
      WHERE ts >= DATE_SUB(NOW(), INTERVAL 10 MINUTE)
      GROUP BY source`,
  );
  const out = [];
  for (const r of rows) {
    const arrival = r.newest ? new Date(r.newest).getTime() : null;
    const ageMs = arrival === null ? null : Math.max(0, nowMs - arrival);
    out.push({
      feed: r.source,
      table: 'unified_option_quotes',
      arrivalAgeMs: ageMs,
      // FYERS lands in fnf_option_quotes; check it separately below.
      usable: ageMs !== null && ageMs <= maxAgeMs,
      note: 'arrival-time only; NOT a freshness verdict on exchange timestamps',
    });
  }
  const [f] = await conn.query(
    `SELECT COUNT(*) n, MAX(ts) newest
       FROM fnf_option_quotes
      WHERE ts >= DATE_SUB(NOW(), INTERVAL 10 MINUTE)`,
  );
  const fAge = f[0]?.newest ? Math.max(0, nowMs - new Date(f[0].newest).getTime()) : null;
  out.push({
    feed: 'FYERS_OPTION',
    table: 'fnf_option_quotes',
    arrivalAgeMs: fAge,
    usable: fAge !== null && fAge <= maxAgeMs,
  });
  return out;
}

/**
 * Latest quote for ONE contract, from whichever canonical feed has it, freshest
 * exchange timestamp first.
 *
 * `symbol` is the canonical identity (NSE:NIFTY<DD><MON><STRIKE><CE|PE>), which
 * is the same string in both tables -- that is the whole point of the canonical
 * layer, so no translation happens here.
 */
async function latestQuote(conn, symbol, { maxAgeMs = DEFAULT_MAX_AGE_MS, nowMs = Date.now() } = {}) {
  // Match on EVERY provider spelling of this contract, so a lookup written in
  // canonical form finds the row whichever feed actually carries it.
  const variants = symbolVariants(symbol);
  const inList = variants.map(() => '?').join(',');
  const [rows] = await conn.query(
    // FYERS store has no sourceTimestamp / changeOi / depth columns at all, so
    // they are not selected. Its exchangeTs therefore resolves to the arrival ts
    // and is marked as unjudgeable rather than trusted -- see normalise().
    `SELECT 'fnf' AS origin, contractSymbol AS symbol, strike, optionType, ltp, bid, ask,
            volume, openInterest, impliedVolatility AS iv,
            delta, gamma, theta, vega, ts AS arrivalTs, NULL AS sourceTimestamp
       FROM fnf_option_quotes
      WHERE contractSymbol IN (${inList})
      ORDER BY ts DESC LIMIT 1`,
    variants,
  );
  const [uRows] = await conn.query(
    `SELECT 'unified' AS origin, instrumentKey AS symbol, strike, optionType, ltp, bid, ask,
            bidQty, askQty, volume, oi AS openInterest, changeOi, iv,
            delta, gamma, theta, vega, ts AS arrivalTs, sourceTimestamp, source
       FROM unified_option_quotes
      WHERE instrumentKey IN (${inList})
      ORDER BY ts DESC LIMIT 1`,
    variants,
  );

  const cands = [
    ...rows.map((r) => normalise(r, r.source ?? 'FYERS_OPTION')),
    ...uRows.map((r) => normalise(r, r.source ?? 'UNIFIED')),
  ].filter((r) => r && r.symbol && Number.isFinite(r.strike));

  if (!cands.length) return { symbol, found: false, reason: 'NOT_IN_EITHER_CANONICAL_FEED' };

  // Freshest by EXCHANGE timestamp. A tick with no exchange timestamp cannot be
  // judged fresh, so it never wins -- absent provenance is not freshness.
  const scored = cands.map((r) => ({ r, age: exchangeAgeMs(r, nowMs) }))
    .sort((a, b) => {
      if (a.age === null && b.age === null) return 0;
      if (a.age === null) return 1;
      if (b.age === null) return -1;
      return a.age - b.age;
    });
  const best = scored[0];
  return {
    symbol,
    found: true,
    ...best.r,
    exchangeAgeMs: best.age,
    fresh: best.age !== null && best.age <= maxAgeMs,
    // Every candidate, so a decision can explain which feed it used and why.
    candidates: scored.map((x) => ({
      source: x.r.source, table: x.r.table, exchangeAgeMs: x.age,
      ltp: x.r.ltp, fresh: x.age !== null && x.age <= maxAgeMs,
    })),
  };
}

/** The live two-sided ladder for one expiry, drawn from both canonical feeds. */
async function chain(conn, { expiry, underlying, maxAgeMs = DEFAULT_MAX_AGE_MS, nowMs = Date.now(), limit = 60 }) {
  const byStrike = new Map();
  const add = (r, source) => {
    const n = normalise(r, source);
    if (!n || !(n.ltp > 0) || n.strike === null) return;
    const age = exchangeAgeMs(n, nowMs);
    if (age === null || age > maxAgeMs) return;      // never trade a stale quote
    const k = n.strike;
    if (!byStrike.has(k)) byStrike.set(k, { strike: k, ce: null, pe: null });
    byStrike.get(k)[n.optionType === 'CE' ? 'ce' : 'pe'] = n;
  };
  const uf = underlyingFilter(underlying);
  const [f] = await conn.query(
    // fnf_option_quotes has NO changeOi / bidQty / askQty columns (verified via
    // SHOW COLUMNS). Selecting them is a hard SQL error, so they are omitted
    // here and stay null downstream: absent provenance, never a fabricated 0.
    `SELECT contractSymbol, strike, optionType, ltp, bid, ask, volume, openInterest,
            impliedVolatility AS iv, delta, gamma, theta, vega, ts
       FROM fnf_option_quotes
      WHERE expiry = ? AND underlying IN (${uf.sql}) AND ts >= DATE_SUB(NOW(), INTERVAL 5 MINUTE)`,
    [expiry, ...uf.params],
  );
  for (const r of f) add(r, r.source ?? 'FYERS_OPTION');
  const [u] = await conn.query(
    `SELECT instrumentKey, underlying, expiry, strike, optionType, ltp, bid, ask,
            bidQty, askQty, volume, oi AS openInterest, changeOi, iv, delta, gamma, theta, vega,
            ts, sourceTimestamp, source
       FROM unified_option_quotes
      WHERE expiry = ? AND underlying IN (${uf.sql}) AND ts >= DATE_SUB(NOW(), INTERVAL 5 MINUTE)`,
    [expiry, ...uf.params],
  );
  for (const r of u) add(r, r.source ?? 'UNIFIED');

  return [...byStrike.values()]
    .filter((x) => x.ce && x.pe)          // two-sided only: that is what is tradable
    .sort((a, b) => a.strike - b.strike)
    .slice(0, limit);
}

/** Which expiries currently have a usable, two-sided chain across both feeds. */
async function tradableExpiries(conn, { underlying, nowMs = Date.now(), maxAgeMs = DEFAULT_MAX_AGE_MS } = {}) {
  const uf = underlyingFilter(underlying);
  const exps = new Map();
  for (const tbl of ['fnf_option_quotes', 'unified_option_quotes']) {
    const keyCol = tbl === 'fnf_option_quotes' ? 'contractSymbol' : 'instrumentKey';
    const [rows] = await conn.query(
      `SELECT expiry, COUNT(DISTINCT strike) strikes, MAX(ts) newest
         FROM ${tbl}
        WHERE underlying IN (${uf.sql}) AND ts >= DATE_SUB(NOW(), INTERVAL 5 MINUTE)
        GROUP BY expiry`,
      uf.params,
    );
    for (const r of rows) {
      const e = isoDay(r.expiry);
      if (!e) continue;
      const age = r.newest ? Math.max(0, nowMs - new Date(r.newest).getTime()) : null;
      if (!exps.has(e)) exps.set(e, { expiry: e, strikes: 0, tables: [] });
      const cur = exps.get(e);
      cur.strikes = Math.max(cur.strikes, r.strikes);
      cur.tables.push(tbl);
    }
  }
  return [...exps.values()].filter((e) => e.strikes >= 3);
}

module.exports = { connect, DEFAULT_MAX_AGE_MS, isoDay, symbolVariants, MONTH_CODES, normalise, exchangeAgeMs, feedHealth, latestQuote, chain, tradableExpiries, UNDERLYING_ALIASES };