#!/usr/bin/env node
/**
 * GATE 7 #5 (roadmap row 73) — replay GEX / gamma-flip over the ARCHIVE.
 *
 * Uses the Upstox canonical chain (OI + IV; the only source that carries them) and the session spot from the
 * FYERS index tape (median ltp — a deterministic, documented choice). gamma is computed LOCALLY via the row-71
 * BSM module. The participant-position assumption is stated explicitly on every run and is a MODEL INPUT.
 *
 * usage: node scripts/gamma-exposure-replay.js [--date 2026-09-11] [--assumption CALLS_LONG_PUTS_SHORT] [--limit 300000] [--strikes 6]
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mysql = require('mysql2/promise');

const ROOT = path.join(__dirname, '..');
const M = require(path.join(ROOT, 'dist', 'trading', 'options', 'gamma-exposure'));

const env = {};
for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const argv = process.argv.slice(2);
const argOf = (name, dflt) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt; };

(async () => {
  const date = argOf('date', '2026-09-11');
  const convention = argOf('assumption', 'CALLS_LONG_PUTS_SHORT');
  const limit = Number(argOf('limit', '300000'));
  const strikes = Number(argOf('strikes', '6'));
  const db = await mysql.createConnection({
    host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT || 3307),
    user: env.MYSQL_USER, password: env.MYSQL_PASSWORD, database: 'myjob_agent', connectTimeout: 20000,
  });
  const [rows] = await db.query(
    "SELECT underlying, DATE_FORMAT(expiry,'%Y-%m-%d') AS expiry, strike, optionType, oi, iv, source, DATE_FORMAT(ts,'%Y-%m-%d %H:%i:%s') AS ts " +
    "FROM unified_option_quotes WHERE source='UPSTOX' AND iv IS NOT NULL AND oi > 0 AND ts >= ? AND ts < ? ORDER BY ts ASC LIMIT ?",
    [`${date} 09:15:00`, `${date} 15:30:00`, limit],
  );
  const [spotRows] = await db.query(
    "SELECT symbol, ltp FROM unified_market_snapshots WHERE source='FYERS_LIVE' AND ts >= ? AND ts < ? AND symbol IN ('NSE:NIFTY50-INDEX','BSE:SENSEX-INDEX')",
    [`${date} 09:15:00`, `${date} 15:30:00`],
  );
  await db.end();

  const latest = new Map();
  for (const r of rows) latest.set(`${r.underlying}|${r.expiry}|${r.strike}|${r.optionType}`, r);
  const quotes = [...latest.values()].map((r) => ({ underlying: r.underlying, sessionDate: date, expiry: r.expiry, strike: r.strike === null ? null : Number(r.strike), optionType: r.optionType, oi: r.oi === null ? null : Number(r.oi), iv: r.iv === null ? null : Number(r.iv), source: r.source }));

  // session spot = MEDIAN ltp per underlying (deterministic; no interpolation, no clock)
  const UNDERLYING_OF = { 'NSE:NIFTY50-INDEX': 'NIFTY50', 'BSE:SENSEX-INDEX': 'SENSEX' };
  const byUnderlying = new Map();
  for (const r of spotRows) {
    const u = UNDERLYING_OF[r.symbol]; if (!u || r.ltp === null) continue;
    if (!byUnderlying.has(u)) byUnderlying.set(u, []);
    byUnderlying.get(u).push(Number(r.ltp));
  }
  const spots = [...byUnderlying.entries()].map(([underlying, xs]) => { const s = xs.sort((a, b) => a - b); const m = Math.floor(s.length / 2); return { underlying, spot: s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }; });

  const assumption = { convention, label: 'modelled: textbook dealer convention (explicit)' };
  const rep = M.evaluateGex(quotes, spots, assumption, {});
  const c = rep.coverage;

  console.log(`\n=== row 73 GEX replay — ${date} 09:15-15:30 IST ===`);
  console.log(`feature    : ${rep.version}   ASSUMPTION: ${assumption.convention} (${assumption.label})`);
  console.log(`reviewer   : ${rep.reviewerSummary}`);
  console.log(`\ncoverage   : surfacesIn=${c.surfacesIn} ok=${c.ok} unavailable=${c.unavailable} contractsUsed=${c.contractsUsed} flips=${c.flips}`);
  console.log(`refusals   : ${JSON.stringify(rep.refusalCounts)}`);
  console.log(`spots      : ${spots.map((s) => `${s.underlying}=${s.spot}`).join(', ') || 'none'}`);

  for (const s of rep.surfaces) {
    if (s.status !== 'OK') { console.log(`\n${s.underlying}: ${s.status} (${s.reason})`); continue; }
    console.log(`\n${s.underlying}  ${s.sessionDate}  expiry=${s.expiry}  spot=${s.spot}  strikes=${s.byStrike.length}`);
    console.log(`  TOTAL GEX = ${s.totalGex}  (index-point² per 1% move, under ${assumption.convention})`);
    const top = [...s.byStrike].sort((a, b) => Math.abs(b.gex) - Math.abs(a.gex)).slice(0, strikes);
    for (const cell of top) console.log(`  strike ${cell.strike}  gex=${cell.gex}  (call ${cell.callGex} / put ${cell.putGex}, ${cell.contracts} contract(s))`);
    console.log(`  gamma flip: ${s.gammaFlip ? `${s.gammaFlip.lowerStrike} ⇄ ${s.gammaFlip.upperStrike} (bracketing strikes, not interpolated)` : `none (${s.flipReason})`}`);
  }

  const digest = crypto.createHash('sha256').update(rep.digest).digest('hex').slice(0, 16);
  console.log(`\nREPLAY_DIGEST_SHA256 ${digest}`);
  console.log('NOTE: gamma is LOCAL (row-71 BSM, IV/100), OI is used as stored (no lot multiplier invented), and');
  console.log('      the positioning assumption is a stated MODEL INPUT — never a claim about real positioning.');
})().catch((e) => {
  console.error('REPLAY FAILED', e.code || '', e.message || '', e.sqlMessage ? `\n  sql: ${e.sqlMessage}` : '');
  process.exit(1);
});
