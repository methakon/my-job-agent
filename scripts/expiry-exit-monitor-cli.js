#!/usr/bin/env node
/**
 * CLI driver for the exit monitor.
 *
 * Reads a live quote for each open paper position and applies the dynamic exit
 * decision. Paper only: there is no order path here or in the monitor, and no
 * broker SDK is imported.
 *
 * Silence when there is nothing to do, so a scheduled run is a true no-op.
 */
'use strict';

const C = require('./expiry-day-core');
const A = require('./expiry-day-analysis');
const L = require('./expiry-paper-ledger');
const { monitor } = require('./expiry-exit-monitor');

/**
 * Resolve a live quote for one open position.
 *
 * Uses the STORED contract identity (symbol + strike + option type), never the
 * symbol string parsed back into a strike — the FYERS `NSE:NIFTY26SEP22800CE`
 * and Upstox `NSE:NIFTY29SEP22800CE` namespaces describe the SAME contract, and
 * reconstructing a strike from either one is how a position silently stops
 * finding its own quote.
 */
async function quoteForPosition(conn, position) {
  const key = position.contract;
  const strike = position.strike;
  const type = position.optionType;
  if (!key || !Number.isFinite(Number(strike)) || !type) return null;
  // fnf_option_quotes is where the live FYERS feed persists (fnf-option-chain
  // .ingestQuote). unified_option_quotes is a separate store this feed never
  // writes, so a position monitoring against it could never find its own quote.
  const [rows] = await conn.query(
    `SELECT ltp, bid, ask, volume, openInterest, ts, provider
       FROM fnf_option_quotes
      WHERE contractSymbol = ? AND optionType = ?
      ORDER BY ts DESC LIMIT 1`,
    [key, type],
  );
  if (!rows.length) return null;
  const r = rows[0];
  const ltp = Number(r.ltp);
  const bid = Number(r.bid); const ask = Number(r.ask);
  if (!(ltp > 0)) return null;
  const twoSided = bid > 0 && ask > 0;
  const mid = twoSided ? (bid + ask) / 2 : ltp;
  return {
    ltp,
    bid: twoSided ? bid : null,
    ask: twoSided ? ask : null,
    spreadPctOfMid: twoSided ? Number((((ask - bid) / mid) * 100).toFixed(3)) : null,
    // FYERS supplies volume=0/oi=0 on every option tick, so 0 here means "not
    // reported", not "no trading". Recording that distinction prevents the
    // monitor from inventing a liquidity exit from missing data.
    volume: r.volume === null || r.volume === undefined ? null : Number(r.volume),
    volumeReported: r.volume !== null && r.volume !== undefined && Number(r.volume) > 0,
    openInterest: Number(r.openInterest) || 0,
    source: r.source,
    freshnessBucket: C.freshnessBucket(C.ageMs(r.ts)),
    dataAgeMs: C.ageMs(r.ts),
  };
}

async function main() {
  const state = L.loadState();
  const open = state.openPositions ?? [];
  if (!open.length) {
    // Nothing to supervise — stay quiet.
    return;
  }
  const nowMs = Date.now();
  const dateIso = C.istDateIso(nowMs);
  const mins = C.istMinutesOfDay(C.istNowDate(nowMs));
  const minutesToClose = 15 * 60 + 30 - mins;
  const closed = mins > 15 * 60 + 30;

  let regime = null; let agreement = null; let spot = null;
  try {
    const cycle = await A.withDb((conn) => A.runCycle(conn, { indexKey: 'NIFTY', dateIso, nowMs, config: { daysToExpiry: 0 } }));
    regime = cycle.regime?.regime ?? null;
    agreement = cycle.direction?.agreementShare ?? null;
    spot = cycle.spot ?? null;
  } catch { /* regime stays unknown; the decision handles that */ }

  const result = await monitor({
    nowMs,
    quoteFor: (position) => A.withDb(async (conn) => {
      const q = await quoteForPosition(conn, position);
      if (!q) return null;
      return { ...q, spot, regime, agreementShare: agreement, minutesToClose, chargesPerPoint: 0.06 };
    }),
  });

  console.log(`exit-monitor ${new Date(nowMs).toISOString()} open=${result.openAtStart} ` +
    `hold=${result.holds} exit=${result.exits} reduce=${result.reduces} noQuote=${result.blockedNoQuote} ` +
    `equity=${result.account.ACCOUNT_EQUITY} committed=${result.account.COMMITTED_CAPITAL}`);
  for (const d of result.decisions) {
    console.log(`  ${d.symbol} ${d.action}${d.reason ? ` (${d.reason})` : ''} ${d.why || d.blockedBy || ''}`);
  }
}

if (require.main === module) {
  main().catch((e) => { console.error('exit-monitor-cli failed:', e.message); process.exit(1); });
}
