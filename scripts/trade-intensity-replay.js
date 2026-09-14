#!/usr/bin/env node
/**
 * GATE 5 #8 (roadmap row 57) — REPLAY: trade intensity / activity regime from the archive.
 *
 * READ-ONLY. Reproduces the tradeint-v1 metric from unified_option_quotes and reports the sample size
 * AND the data-quality context (source, cadence, observed windows, volume progression) so later
 * comparisons are fair. Excludes the 1980-01-01 sentinel rows. No synthetic data, no live-market claim.
 *
 *   node scripts/trade-intensity-replay.js [--limit N] [--source UPSTOX]
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ROOT = path.join(__dirname, '..');
require(path.join(ROOT, 'node_modules', 'dotenv')).config({ path: path.join(ROOT, '.env') });
const mysql = require(path.join(ROOT, 'node_modules', 'mysql2/promise'));
const M = require(path.join(ROOT, 'dist', 'trading', 'microstructure', 'trade-intensity'));

const argOf = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const LIMIT = Number(argOf('limit', 600000));
const SOURCE = argOf('source', null);

(async () => {
  const db = await mysql.createConnection({
    host: process.env.MYSQL_HOST, port: Number(process.env.MYSQL_PORT || 3307),
    user: process.env.MYSQL_USER, password: process.env.MYSQL_PASSWORD, database: 'myjob_agent', connectTimeout: 20000,
  });

  const where = ["volume > 0", "ts >= '2000-01-01'"];
  const params = [];
  if (SOURCE) { where.push('source = ?'); params.push(SOURCE); }
  const sql =
    "SELECT source, instrumentKey, DATE_FORMAT(ts,'%Y-%m-%d') AS sessionDate, ts, volume, sequenceNumber " +
    `FROM unified_option_quotes WHERE ${where.join(' AND ')} ORDER BY instrumentKey, ts LIMIT ?`;
  params.push(LIMIT);

  console.log(`=== row 57 trade-intensity replay — unified_option_quotes (volume > 0, sentinel 1980-01-01 excluded)${SOURCE ? `, source=${SOURCE}` : ''} ===`);
  const [rows] = await db.query(sql, params);
  await db.end();
  console.log(`rows fetched     : ${rows.length}${rows.length === LIMIT ? ' (LIMIT reached — raise --limit for full coverage)' : ''}`);

  const snaps = rows.map((r) => ({
    instrumentKey: r.instrumentKey, source: r.source, sessionDate: r.sessionDate,
    ts: r.ts, volume: r.volume === null ? null : Number(r.volume),
    sequenceNumber: r.sequenceNumber === null ? null : Number(r.sequenceNumber),
  }));
  const rep = M.evaluateTradeIntensity(snaps);

  console.log(`feature          : ${rep.version}`);
  console.log(`reviewer         : ${rep.reviewerSummary}`);
  console.log(`\nSAMPLE SIZE  : ${rep.snapshotsIn} archived snapshot(s) over ${rep.coverage.sessions} instrument session(s) ` +
    `(${rep.coverage.instruments} instrument key(s), source(s): ${rep.coverage.sources.join(', ') || 'none'})`);
  console.log(`coverage     : intervals=${rep.counts.intervals} decided=${rep.counts.decided} refused=${rep.counts.refused} ` +
    `medianCadence=${rep.coverage.medianDtSecondsAcrossSessions === null ? 'n/a' : rep.coverage.medianDtSecondsAcrossSessions + 's'} ` +
    `sessionsOutsideMarketHours=${rep.coverage.observedWindowOutsideMarketHours}/${rep.coverage.sessions}`);
  console.log(`refusals     : ${JSON.stringify(rep.refusalCounts)}`);
  console.log(`regimes      : QUIET=${rep.regimeCounts.QUIET} NORMAL=${rep.regimeCounts.NORMAL} ACTIVE=${rep.regimeCounts.ACTIVE}`);

  console.log(`\nvolume progression per source (does the cumulative series advance AT ALL?):`);
  for (const [src, p] of Object.entries(rep.sourceProgression).sort()) {
    console.log(`  ${src.padEnd(14)} snapshots=${String(p.snapshots).padEnd(7)} +delta=${String(p.positiveDeltas).padEnd(7)} =delta=${String(p.zeroDeltas).padEnd(7)} -delta=${String(p.negativeDeltas).padEnd(6)} advances=${p.advances}`);
  }

  const decided = rep.observations.filter((o) => o.status === 'OK');
  if (decided.length) {
    const vals = decided.map((o) => o.intensity).sort((a, b) => a - b);
    const q = (f) => vals[Math.min(vals.length - 1, Math.floor(vals.length * f))];
    console.log(`\nintensity (contracts/min, ${vals.length} decided): min=${vals[0].toFixed(2)} p25=${q(0.25).toFixed(2)} median=${q(0.5).toFixed(2)} p75=${q(0.75).toFixed(2)} p95=${q(0.95).toFixed(2)} max=${vals[vals.length - 1].toFixed(2)}`);
    const bins = [[0, 1], [1, 10], [10, 100], [100, 1000], [1000, 10000], [10000, Infinity]];
    for (const [lo, hi] of bins) {
      const n = vals.filter((v) => v >= lo && v < hi).length;
      console.log(`  ${String(lo).padStart(6)}-${hi === Infinity ? '∞' : hi}: ${String(n).padStart(6)}  ${((n / vals.length) * 100).toFixed(1)}%`);
    }
  }

  console.log(`\nfirst 6 observations:`);
  for (const o of rep.observations.slice(0, 6)) {
    console.log(`  ${o.sessionDate} ${o.source}/${o.instrumentKey} ${o.fromTs} -> ${o.toTs} dt=${o.dtSeconds}s dVol=${o.deltaVolume} I=${o.intensity === null ? 'null' : o.intensity.toFixed(2)} regime=${o.regime ?? 'null'} reason=${o.reason ?? '-'}`);
  }

  const observed = [...new Set(rep.coverage.observedWindows.map((w) => `${w.sessionDate} ${w.source} ${w.firstTs}..${w.lastTs}`))].sort();
  console.log(`\nobserved windows (${observed.length}):`);
  for (const w of observed.slice(0, 8)) console.log(`  ${w}`);
  if (observed.length > 8) console.log(`  … ${observed.length - 8} more`);

  console.log(`\nREPLAY_DIGEST_SHA256 ${crypto.createHash('sha256').update(rep.digest).digest('hex').slice(0, 16)}`);
  console.log('NOTE: intensity is a SNAPSHOT-derived average = ΔarchivedCumulativeVolume × 60 / Δt (contracts/min) over the');
  console.log('      snapshot gap — NOT a trade-tape intensity. Δ=0 ⇒ NO_VOLUME_PROGRESS (no intensity exists, never a 0);');
  console.log('      Δ<0 ⇒ VOLUME_RESET; regimes compare each interval with the MEDIAN of that session\'s PRIOR intervals only.');
  console.log('      Windows outside 09:15-15:30 IST are reported as observed and are NOT claimed as market microstructure.');
})().catch((e) => { console.error('REPLAY FAILED', e.code || '', e.message || '', e.sqlMessage ? `\n  sql: ${e.sqlMessage}` : ''); process.exit(1); });
