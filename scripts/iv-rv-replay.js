#!/usr/bin/env node
/**
 * GATE 7 #1 (roadmap row 66) — replay IV-RV over the ARCHIVE.
 *
 * IV comes from the Upstox option chain (canonical `unified_option_quotes`, source UPSTOX — the only source
 * that carries IV); the price tape comes from the FYERS index snapshots (`unified_market_snapshots`, ltp per
 * tick). For one session it reports, per underlying, the median IV reference and the annualised realised
 * volatility with the sample size/coverage. Descriptive evidence only — nothing is selected or tuned.
 *
 * usage: node scripts/iv-rv-replay.js [--date 2026-09-11] [--min-prices 10] [--limit 30000]
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mysql = require('mysql2/promise');

const ROOT = path.join(__dirname, '..');
const M = require(path.join(ROOT, 'dist', 'trading', 'options', 'iv-rv'));

const env = {};
for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const argv = process.argv.slice(2);
const argOf = (name, dflt) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt; };
const IST = (wallClock) => Date.parse(String(wallClock).replace(' ', 'T') + '+05:30');

(async () => {
  const date = argOf('date', '2026-09-11');
  const minPrices = Number(argOf('min-prices', '10'));
  const limit = Number(argOf('limit', '30000'));
  const db = await mysql.createConnection({
    host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT || 3307),
    user: env.MYSQL_USER, password: env.MYSQL_PASSWORD, database: 'myjob_agent', connectTimeout: 20000,
  });
  const [ivRows] = await db.query(
    "SELECT underlying, expiry, strike, optionType, iv, source, DATE_FORMAT(ts,'%Y-%m-%d %H:%i:%s') AS ts " +
    "FROM unified_option_quotes WHERE source='UPSTOX' AND iv IS NOT NULL AND ts >= ? AND ts < ? LIMIT ?",
    [`${date} 09:15:00`, `${date} 15:30:00`, limit],
  );
  const [priceRows] = await db.query(
    "SELECT symbol, ltp, DATE_FORMAT(ts,'%Y-%m-%d %H:%i:%s') AS ts FROM unified_market_snapshots " +
    "WHERE source='FYERS_LIVE' AND ts >= ? AND ts < ? AND symbol IN ('NSE:NIFTY50-INDEX','BSE:SENSEX-INDEX') LIMIT ?",
    [`${date} 09:15:00`, `${date} 15:30:00`, limit],
  );
  await db.end();

  // the index symbol's canonical underlying name used by the option chain
  const UNDERLYING_OF = { 'NSE:NIFTY50-INDEX': 'NIFTY50', 'BSE:SENSEX-INDEX': 'SENSEX' };
  const ivs = ivRows.map((r) => ({ underlying: r.underlying, expiry: r.expiry, strike: r.strike === null ? null : Number(r.strike), optionType: r.optionType, iv: r.iv === null ? null : Number(r.iv), source: r.source, sourceTimestamp: r.ts }));
  const prices = priceRows.map((r) => ({ underlying: UNDERLYING_OF[r.symbol] ?? r.symbol, instantMs: IST(r.ts), price: r.ltp === null ? null : Number(r.ltp), source: 'FYERS_LIVE' }));

  const rep = M.evaluateIvRv(ivs, prices, { minPrices });
  const c = rep.coverage;

  console.log(`\n=== row 66 IV-RV replay — ${date} 09:15-15:30 IST ===`);
  console.log(`feature   : ${rep.version}  (IV source: UPSTOX canonical chain; tape: FYERS_LIVE index ltp)`);
  console.log(`reviewer  : ${rep.reviewerSummary}`);
  console.log(`\nSAMPLE SIZE: ${c.ok} underlying(s) with both an IV reference and an RV`);
  console.log(`coverage   : underlyingsIn=${c.underlyingsIn} ok=${c.ok} unavailable=${c.unavailable} ivObservations=${c.ivObservations} priceObservations=${c.priceObservations} excludedIv=${c.excludedIv}`);
  console.log(`refusals   : ${JSON.stringify(rep.refusalCounts)}`);
  console.log('\nper underlying:');
  for (const o of rep.observations) {
    if (o.values) {
      console.log(`  ${o.underlying.padEnd(9)} IV ref=${o.iv.ivReference}% (n=${o.iv.ivCount}, range ${o.iv.ivMin}..${o.iv.ivMax})  RV=${(o.values.rvAnnualised * 100).toFixed(2)}%  IV-RV=${(o.values.ivMinusRv * 100).toFixed(2)}pp  ratio=${o.values.ivToRvRatio}  prices=${o.prices.usedPrices} over ${(o.prices.elapsedSeconds / 3600).toFixed(1)}h`);
    } else {
      console.log(`  ${o.underlying.padEnd(9)} ${o.status} (${o.reason}: ${o.reasonDetail})  ivCount=${o.iv.ivCount} prices=${o.prices.usedPrices}`);
    }
  }

  const digest = crypto.createHash('sha256').update(rep.digest).digest('hex').slice(0, 16);
  console.log(`\nREPLAY_DIGEST_SHA256 ${digest}`);
  console.log('NOTE: the IV reference is a median of the chain (no ATM matching invented) and the RV annualises');
  console.log('      from ACTUAL elapsed timestamps with only the 365-day calendar constant; no threshold is tuned.');
})().catch((e) => {
  console.error('REPLAY FAILED', e.code || '', e.message || '', e.sqlMessage ? `\n  sql: ${e.sqlMessage}` : '');
  process.exit(1);
});
