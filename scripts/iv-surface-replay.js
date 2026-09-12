#!/usr/bin/env node
/**
 * GATE 7 #2 (roadmap row 67) — replay the IV surface over the ARCHIVE.
 *
 * Loads the Upstox canonical chain's IV rows for one session (the only source that carries IV), keeps the
 * LATEST observation per (underlying, expiry, strike, option type) deterministically, and builds the surface
 * with its coverage. Descriptive evidence only.
 *
 * usage: node scripts/iv-surface-replay.js [--date 2026-09-11] [--limit 60000] [--slices 6]
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mysql = require('mysql2/promise');

const ROOT = path.join(__dirname, '..');
const M = require(path.join(ROOT, 'dist', 'trading', 'options', 'iv-surface'));

const env = {};
for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const argv = process.argv.slice(2);
const argOf = (name, dflt) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt; };

(async () => {
  const date = argOf('date', '2026-09-11');
  const limit = Number(argOf('limit', '60000'));
  const slices = Number(argOf('slices', '6'));
  const db = await mysql.createConnection({
    host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT || 3307),
    user: env.MYSQL_USER, password: env.MYSQL_PASSWORD, database: 'myjob_agent', connectTimeout: 20000,
  });
  const [rows] = await db.query(
    "SELECT underlying, expiry, strike, optionType, iv, source, DATE_FORMAT(ts,'%Y-%m-%d %H:%i:%s') AS ts " +
    "FROM unified_option_quotes WHERE source='UPSTOX' AND iv IS NOT NULL AND ts >= ? AND ts < ? ORDER BY ts ASC LIMIT ?",
    [`${date} 09:15:00`, `${date} 15:30:00`, limit],
  );
  await db.end();

  // LATEST observation per (underlying, expiry, strike, optionType) — deterministic, ordered by ts.
  const latest = new Map();
  for (const r of rows) {
    latest.set(`${r.underlying}|${r.expiry}|${r.strike}|${r.optionType}`, r);
  }
  const points = [...latest.values()].map((r) => ({
    underlying: r.underlying, sessionDate: date, expiry: r.expiry,
    strike: r.strike === null ? null : Number(r.strike), optionType: r.optionType,
    iv: r.iv === null ? null : Number(r.iv), source: r.source, sourceTimestamp: r.ts,
  }));

  const rep = M.evaluateIvSurface(points, {});
  const c = rep.coverage;

  console.log(`\n=== row 67 IV-surface replay — ${date} 09:15-15:30 IST (Upstox canonical chain) ===`);
  console.log(`feature   : ${rep.version}`);
  console.log(`reviewer  : ${rep.reviewerSummary}`);
  console.log(`\nSAMPLE SIZE: ${c.slices} expiry slice(s) across ${c.ok} surface(s)`);
  console.log(`coverage   : pointsIn=${c.pointsIn} (deduped latest per contract) surfaces=${c.surfaces} ok=${c.ok} unavailable=${c.unavailable} slices=${c.slices} withTerm=${c.withTerm} excludedIv=${c.excludedIv} excludedStrike=${c.excludedStrike}`);
  console.log(`refusals   : ${JSON.stringify(rep.refusalCounts)}`);

  for (const s of rep.surfaces) {
    if (s.status !== 'OK') { console.log(`\n${s.underlying}: ${s.status} (${s.reason}: ${s.reasonDetail})`); continue; }
    console.log(`\n${s.underlying}  ${s.sessionDate}  expiries=${s.expiryCount} termAvailable=${s.termAvailable} strikes=${s.strikeCoverage}  IV min/med/max=${s.ivMin}/${s.ivMedian}/${s.ivMax}`);
    for (const sl of s.slices.slice(0, slices)) {
      console.log(`  ${sl.expiry}  strikes=${sl.strikeCount} [${sl.strikeLow}..${sl.strikeHigh}]  IV ${sl.ivMin}..${sl.ivMax} (med ${sl.ivMedian})  CE=${sl.callCount} PE=${sl.putCount}  sufficient=${sl.sufficient}`);
    }
    if (s.slices.length > slices) console.log(`  … ${s.slices.length - slices} more slice(s)`);
  }

  const digest = crypto.createHash('sha256').update(rep.digest).digest('hex').slice(0, 16);
  console.log(`\nREPLAY_DIGEST_SHA256 ${digest}`);
  console.log('NOTE: one latest observation per contract; slices are never padded and a missing expiry is never');
  console.log('      interpolated — termAvailable simply says whether a term dimension exists in the data.');
})().catch((e) => {
  console.error('REPLAY FAILED', e.code || '', e.message || '', e.sqlMessage ? `\n  sql: ${e.sqlMessage}` : '');
  process.exit(1);
});
