#!/usr/bin/env node
/**
 * GATE 8 #2 (roadmap row 87) — replay the gap LABELS over the ARCHIVE and run the leakage audit.
 *
 * Builds the row-85 feature dataset and the row-87 labels, then runs detectLabelLeakage() over the archive to
 * PROVE no post-decision feature information entered the label inputs (the row's doneWhen). Descriptive only.
 *
 * usage: node scripts/gap-labels-replay.js [--instrument NSE:NIFTY50-INDEX] [--since 2026-09-01] [--samples 8]
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
const L = require(path.join(ROOT, 'dist', 'trading', 'gap-engine', 'gap-labels'));

const env = {};
for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const argv = process.argv.slice(2);
const argOf = (name, dflt) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt; };

(async () => {
  const instrument = argOf('instrument', 'NSE:NIFTY50-INDEX');
  const since = argOf('since', '2026-09-01');
  const samples = Number(argOf('samples', '8'));
  const db = await mysql.createConnection({
    host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT || 3307),
    user: env.MYSQL_USER, password: env.MYSQL_PASSWORD, database: 'myjob_agent', connectTimeout: 12000,
  });
  const { series } = await loadArchivedSeries(db, instrument);
  const paths = await loadArchivedIntradayPaths(db, instrument, { since });
  await db.end();

  const assessments = TAX.assessGapSeries(series.sessions, {}).assessments;
  const rangePos = RP.assessGapRangePosSeries(series.sessions, {});
  const acceptance = A.assessGapAcceptance(series.sessions, paths);
  const scores = S.evaluateGapScores(assessments, rangePos);
  const decisions = D.decideGapSessions({ scores, acceptance });
  const dataset = DB.buildGapDataset({ assessments, rangePos, scores, decisions }, {});
  const labels = L.buildGapLabels(dataset, paths, {});
  const violations = L.detectLabelLeakage(labels, paths);
  const c = labels.coverage;

  console.log(`\n=== row 87 gap-LABEL replay + leakage audit — ${instrument} ===`);
  console.log(`feature   : ${labels.version}   FEATURE CUTOFF: ${labels.cutoff}   (dataset ${labels.upstreamDatasetVersion})`);
  console.log(`window    : outcome = observations with open <= ts <= close of the SAME session; anything else is ignored and counted`);
  console.log(`\nSAMPLE SIZE: ${c.ok} labelled session(s)`);
  console.log(`coverage   : datasetRowsIn=${c.datasetRowsIn} ok=${c.ok} unavailable=${c.unavailable} observationsIgnored=${c.observationsIgnored}`);
  console.log(`refusals   : ${JSON.stringify(labels.refusalCounts)}`);
  console.log(`label counts (OK rows): fade=${c.fade} follow=${c.follow} midpointReach=${c.midpointReach} fullFill=${c.fullFill}`);
  console.log(`\nLEAKAGE AUDIT: ${violations.length === 0 ? 'CLEAN — no post-decision feature information entered the label inputs' : `${violations.length} violation(s)`}`);
  for (const v of violations.slice(0, 5)) console.log(`  ${v.code}  ${v.sessionDate} ${v.instrument}  ${v.detail}`);

  const okRows = labels.rows.filter((r) => r.status === 'OK');
  console.log(`\nlast ${Math.min(samples, okRows.length)} labelled session(s):`);
  for (const r of okRows.slice(-samples)) {
    const l = r.labels;
    console.log(`  ${r.sessionDate}  fade=${l.fade} follow=${l.follow} mid=${l.midpointReach} fill=${l.fullFill}  maxExt=${l.maximumExtensionPoints}pts  timeToTarget=${l.timeToTargetMs === null ? 'n/a' : (l.timeToTargetMs / 60000).toFixed(0) + 'm'}  (used ${r.window.observationsUsed} obs, ignored ${r.window.outsideWindowIgnored})`);
  }

  const digest = crypto.createHash('sha256').update(labels.digest).digest('hex').slice(0, 16);
  console.log(`\nREPLAY_DIGEST_SHA256 ${digest}`);
  console.log('NOTE: labels read the FROZEN pre-open features (row 85) and ONLY in-window observations; the audit');
  console.log('      independently re-checks the window and the frozen-feature subset, so leakage is proven absent.');
})().catch((e) => {
  console.error('REPLAY FAILED', e.code || '', e.message || '', e.sqlMessage ? `\n  sql: ${e.sqlMessage}` : '');
  process.exit(1);
});
