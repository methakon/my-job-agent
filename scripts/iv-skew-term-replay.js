#!/usr/bin/env node
/**
 * GATE 7 #3 (roadmap row 69) — replay skew and term-structure over the ARCHIVE.
 *
 * Builds the row-67 surface from the Upstox canonical chain (latest observation per contract) and derives
 * each slice's IV-vs-strike skew and the term slope/curvature, reporting the coverage. Descriptive only.
 *
 * usage: node scripts/iv-skew-term-replay.js [--date 2026-09-11] [--limit 300000]
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mysql = require('mysql2/promise');

const ROOT = path.join(__dirname, '..');
const S = require(path.join(ROOT, 'dist', 'trading', 'options', 'iv-surface'));
const M = require(path.join(ROOT, 'dist', 'trading', 'options', 'iv-skew-term'));

const env = {};
for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const argv = process.argv.slice(2);
const argOf = (name, dflt) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt; };

(async () => {
  const date = argOf('date', '2026-09-11');
  const limit = Number(argOf('limit', '300000'));
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

  const latest = new Map();
  for (const r of rows) latest.set(`${r.underlying}|${r.expiry}|${r.strike}|${r.optionType}`, r);
  const points = [...latest.values()].map((r) => ({ underlying: r.underlying, sessionDate: date, expiry: r.expiry, strike: r.strike === null ? null : Number(r.strike), optionType: r.optionType, iv: r.iv === null ? null : Number(r.iv), source: r.source, sourceTimestamp: r.ts }));

  const surface = S.evaluateIvSurface(points, {});
  const rep = M.evaluateIvSkewTerm(surface, {});
  const c = rep.coverage;

  console.log(`\n=== row 69 skew + term-structure replay — ${date} 09:15-15:30 IST ===`);
  console.log(`feature   : ${rep.version}  (consumes ${rep.upstreamSurfaceVersion})`);
  console.log(`reviewer  : ${rep.reviewerSummary}`);
  console.log(`\ncoverage   : surfacesIn=${c.surfacesIn} ok=${c.ok} unavailable=${c.unavailable} slicesWithSkew=${c.slicesWithSkew} termSlopes=${c.slopes} curvatures=${c.curvatures}`);
  console.log(`refusals   : ${JSON.stringify(rep.refusalCounts)}`);

  for (const s of rep.surfaces) {
    if (s.status !== 'OK') { console.log(`\n${s.underlying}: ${s.status} (${s.reason})`); continue; }
    console.log(`\n${s.underlying}  ${s.sessionDate}  expiries=${s.term.expiryCount}`);
    for (const sl of s.slices) {
      console.log(`  ${sl.expiry}  strikes=${sl.strikeCount} IV(med)=${sl.ivMedian}  skew=${sl.skewPer100 ?? 'n/a'}% per 100 strike pts${sl.reason ? ` (${sl.reason})` : ''}`);
    }
    console.log(`  term: days=${s.term.daysTotal ?? 'n/a'} slope=${s.term.slopePerDay ?? 'n/a'}%/day curvature=${s.term.curvature ?? 'n/a'}${s.term.reason ? ` (${s.term.reason})` : ''}`);
  }

  const digest = crypto.createHash('sha256').update(rep.digest).digest('hex').slice(0, 16);
  console.log(`\nREPLAY_DIGEST_SHA256 ${digest}`);
  console.log('NOTE: the skew is a plain OLS slope (no ATM match, no wing picking) and the term slope uses each');
  console.log('      expiry SLICE MEDIAN IV; too few strikes/expiries refuses rather than interpolating.');
})().catch((e) => {
  console.error('REPLAY FAILED', e.code || '', e.message || '', e.sqlMessage ? `\n  sql: ${e.sqlMessage}` : '');
  process.exit(1);
});
