#!/usr/bin/env node
/**
 * GATE 8 #1 (roadmap row 85) — replay the gap DATABASE over the ARCHIVE.
 *
 * Builds the whole gate-4 chain (row 38 taxonomy → 41 range-pos → 43 acceptance → 44 scores → 48 decision) and
 * assembles the frozen feature dataset, reporting coverage and the feature cutoff. Descriptive only.
 *
 * usage: node scripts/gap-dataset-replay.js [--instrument NSE:NIFTY50-INDEX] [--samples 6]
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mysql = require('mysql2/promise');

const ROOT = path.join(__dirname, '..');
const { loadArchivedSeries, loadArchivedIntradayPaths } = require('./lib/gap-archive.js');
const TAX = require(path.join(ROOT, 'dist', 'trading', 'gap-engine', 'gap-taxonomy'));
const RP = require(path.join(ROOT, 'dist', 'trading', 'gap-engine', 'gap-range-pos'));
const A = require(path.join(ROOT, 'dist', 'trading', 'gap-engine', 'gap-acceptance'));
const S = require(path.join(ROOT, 'dist', 'trading', 'gap-engine', 'gap-scores'));
const D = require(path.join(ROOT, 'dist', 'trading', 'gap-engine', 'gap-decision'));
const DB = require(path.join(ROOT, 'dist', 'trading', 'gap-engine', 'gap-dataset'));

const env = {};
for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const argv = process.argv.slice(2);
const argOf = (name, dflt) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt; };

(async () => {
  const instrument = argOf('instrument', 'NSE:NIFTY50-INDEX');
  const samples = Number(argOf('samples', '6'));
  const db = await mysql.createConnection({
    host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT || 3307),
    user: env.MYSQL_USER, password: env.MYSQL_PASSWORD, database: 'myjob_agent', connectTimeout: 12000,
  });
  const { rawBars, series } = await loadArchivedSeries(db, instrument);
  const paths = await loadArchivedIntradayPaths(db, instrument, { since: '2026-09-01' });
  await db.end();

  const assessments = TAX.assessGapSeries(series.sessions, {}).assessments;
  const rangePos = RP.assessGapRangePosSeries(series.sessions, {});
  const acceptance = A.assessGapAcceptance(series.sessions, paths);
  const scores = S.evaluateGapScores(assessments, rangePos);
  const decisions = D.decideGapSessions({ scores, acceptance });
  const rep = DB.buildGapDataset({ assessments, rangePos, scores, decisions }, {});
  const c = rep.coverage;

  console.log(`\n=== row 85 gap-database replay — ${instrument} ===`);
  console.log(`feature   : ${rep.version}   FEATURE CUTOFF: ${rep.cutoff}`);
  console.log(`reviewer  : ${rep.reviewerSummary}`);
  console.log(`series    : ${rawBars.length} archived bars → ${series.coverage.sessionsOut} sessions  ${series.coverage.firstSession} .. ${series.coverage.lastSession}`);
  console.log(`upstream  : rangePos=${rep.upstream.rangePosVersion} scores=${rep.upstream.scoresVersion} decision=${rep.upstream.decisionVersion}`);

  console.log(`\nSAMPLE SIZE: ${c.rowsOut} row(s) (${c.ok} OK)`);
  console.log(`coverage   : sessionsIn=${c.sessionsIn} ok=${c.ok} unavailable=${c.unavailable} withDecision=${c.withDecision} withScores=${c.withScores} withRangePos=${c.withRangePos}`);
  console.log(`refusals   : ${JSON.stringify(rep.refusalCounts)}`);
  console.log(`columns    : ${DB.GAP_DATASET_FEATURES.join(', ')}`);

  const okRows = rep.rows.filter((r) => r.status === 'OK');
  console.log(`\nlast ${Math.min(samples, okRows.length)} row(s):`);
  for (const r of okRows.slice(-samples)) {
    const f = r.features;
    console.log(`  ${r.sessionDate}  ${String(f.gapClass).padEnd(9)} ${String(f.gapDirection).padEnd(4)} gapRatio=${f.gapRatio ?? '-'} pos=${f.gapRangePos ?? '-'} fade=${f.fadeScore ?? '-'} follow=${f.followScore ?? '-'} → ${f.decisionSide ?? 'NO_TRADE'}${f.tradeDirection ? '/' + f.tradeDirection : ''}`);
  }

  const digest = crypto.createHash('sha256').update(rep.digest).digest('hex').slice(0, 16);
  console.log(`\nREPLAY_DIGEST_SHA256 ${digest}`);
  console.log('NOTE: every column is knowable AT THE OPEN; the session high/low/close are never read and NO label is');
  console.log('      attached, so no outcome can leak into the feature side by construction.');
})().catch((e) => {
  console.error('REPLAY FAILED', e.code || '', e.message || '', e.sqlMessage ? `\n  sql: ${e.sqlMessage}` : '');
  process.exit(1);
});
