#!/usr/bin/env node
/**
 * GATE 7 #6 (roadmap row 75) — replay vanna / charm over the ARCHIVE.
 *
 * Uses the Upstox canonical chain (IV) and the FYERS session-median spot, and reports the second-order
 * sensitivities per contract with the coverage. Descriptive evidence only — no production behaviour involved.
 *
 * usage: node scripts/vanna-charm-replay.js [--date 2026-09-11] [--limit 200000] [--samples 8]
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mysql = require('mysql2/promise');

const ROOT = path.join(__dirname, '..');
const M = require(path.join(ROOT, 'dist', 'trading', 'options', 'vanna-charm'));

const env = {};
for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const argv = process.argv.slice(2);
const argOf = (name, dflt) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt; };

(async () => {
  const date = argOf('date', '2026-09-11');
  const limit = Number(argOf('limit', '200000'));
  const samples = Number(argOf('samples', '8'));
  const db = await mysql.createConnection({
    host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT || 3307),
    user: env.MYSQL_USER, password: env.MYSQL_PASSWORD, database: 'myjob_agent', connectTimeout: 20000,
  });
  const [rows] = await db.query(
    "SELECT underlying, DATE_FORMAT(expiry,'%Y-%m-%d') AS expiry, strike, optionType, iv, source, DATE_FORMAT(ts,'%Y-%m-%d %H:%i:%s') AS ts " +
    "FROM unified_option_quotes WHERE source='UPSTOX' AND iv IS NOT NULL AND iv > 0 AND ts >= ? AND ts < ? ORDER BY ts ASC LIMIT ?",
    [`${date} 09:15:00`, `${date} 15:30:00`, limit],
  );
  const [spotRows] = await db.query(
    "SELECT symbol, ltp FROM unified_market_snapshots WHERE source='FYERS_LIVE' AND ts >= ? AND ts < ? AND symbol IN ('NSE:NIFTY50-INDEX','BSE:SENSEX-INDEX')",
    [`${date} 09:15:00`, `${date} 15:30:00`],
  );
  await db.end();

  const latest = new Map();
  for (const r of rows) latest.set(`${r.underlying}|${r.expiry}|${r.strike}|${r.optionType}`, r);
  const quotes = [...latest.values()].map((r) => ({ underlying: r.underlying, sessionDate: date, expiry: r.expiry, strike: r.strike === null ? null : Number(r.strike), optionType: r.optionType, iv: r.iv === null ? null : Number(r.iv), source: r.source, sourceTimestamp: r.ts }));

  const UNDERLYING_OF = { 'NSE:NIFTY50-INDEX': 'NIFTY50', 'BSE:SENSEX-INDEX': 'SENSEX' };
  const byUnderlying = new Map();
  for (const r of spotRows) { const u = UNDERLYING_OF[r.symbol]; if (!u || r.ltp === null) continue; if (!byUnderlying.has(u)) byUnderlying.set(u, []); byUnderlying.get(u).push(Number(r.ltp)); }
  const spots = [...byUnderlying.entries()].map(([underlying, xs]) => { const s = xs.sort((a, b) => a - b); const m = Math.floor(s.length / 2); return { underlying, spot: s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }; });

  const rep = M.evaluateVannaCharm(quotes, spots, {});
  const c = rep.coverage;

  console.log(`\n=== row 75 vanna / charm replay — ${date} 09:15-15:30 IST ===`);
  console.log(`feature   : ${rep.version}`);
  console.log(`reviewer  : ${rep.reviewerSummary}`);
  console.log(`\nSAMPLE SIZE: ${c.ok} contract(s) with vanna/charm`);
  console.log(`coverage   : quotesIn=${c.quotesIn} ok=${c.ok} unavailable=${c.unavailable} disabled=${c.disabled}`);
  console.log(`refusals   : ${JSON.stringify(rep.refusalCounts)}`);
  const okRows = rep.observations.filter((o) => o.status === 'OK');
  console.log(`\nfirst ${Math.min(samples, okRows.length)} contract(s):`);
  for (const o of okRows.slice(0, samples)) {
    console.log(`  ${o.underlying} ${o.expiry} ${o.strike}${o.optionType}  spot=${o.evidence.spot} iv=${o.evidence.iv}% T=${o.evidence.years}y  vanna=${o.values.vanna} (${o.values.vannaPerVolPoint}/vol pt)  charm=${o.values.charm}/yr (${o.values.charmPerDay}/day)`);
  }
  if (rep.observations.some((o) => o.status !== 'OK')) {
    const by = {}; for (const o of rep.observations.filter((x) => x.status !== 'OK')) by[o.reason] = (by[o.reason] ?? 0) + 1;
    console.log(`\nrefused by reason: ${JSON.stringify(by)} (e.g. ${rep.observations.find((o) => o.status !== 'OK').reasonDetail})`);
  }

  const digest = crypto.createHash('sha256').update(rep.digest).digest('hex').slice(0, 16);
  console.log(`\nREPLAY_DIGEST_SHA256 ${digest}`);
  console.log('NOTE: vanna/charm are central differences on the REUSED local greeks (steps 0.0005 vol / 0.5 day), so');
  console.log('      they are consistent with the desk greeks by construction; unsupported contracts are refused.');
})().catch((e) => {
  console.error('REPLAY FAILED', e.code || '', e.message || '', e.sqlMessage ? `\n  sql: ${e.sqlMessage}` : '');
  process.exit(1);
});
