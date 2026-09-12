#!/usr/bin/env node
/**
 * GATE 4 #3 (roadmap row 40) — REPLAY both candidates over the ARCHIVE.
 *
 * Descriptive evidence only: it prints what the candidates were, never what to do about them.
 * Nothing here selects, ranks or tunes; the thresholds are the module's structural defaults.
 *
 *   GAP-FADE   : the archived daily-bar series (one bar per session) via the shared loader.
 *   FAILED-ORB : the archived INTRADAY rows, so the opening range comes from real observations —
 *                a path that does not cover the 09:15 open is refused with its measured lag
 *                rather than turned into a late-start proxy.
 *
 * usage: node scripts/gap-candidates-replay.js [--instrument NSE:NIFTY50-INDEX] [--since 2026-09-01]
 *                                               [--samples 12] [--disabled]
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPO = path.join(__dirname, '..');
process.chdir(REPO);
const dotenv = require(path.join(REPO, 'node_modules/dotenv'));
dotenv.config({ path: path.join(REPO, '.env') });
const mysql = require(path.join(REPO, 'node_modules/mysql2/promise'));

const { loadArchivedSeries, loadArchivedIntradayPaths } = require(path.join(REPO, 'scripts/lib/gap-archive.js'));
const TAX = require(path.join(REPO, 'dist', 'trading', 'gap-engine', 'gap-taxonomy'));
const C = require(path.join(REPO, 'dist', 'trading', 'gap-engine', 'gap-candidates'));

const argv = process.argv.slice(2);
const argOf = (name, dflt) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt; };
const instrument = argOf('instrument', 'NSE:NIFTY50-INDEX');
const since = argOf('since', '2026-09-01');
const samples = Number(argOf('samples', 12));
const disabled = argv.includes('--disabled');
const pct = (n, d) => (d ? `${((n / d) * 100).toFixed(1)}%` : 'n/a');
const hm = (ms) => new Date(ms).toISOString().slice(11, 16) + 'Z';

(async () => {
  const db = await mysql.createConnection({
    host: process.env.MYSQL_HOST, port: Number(process.env.MYSQL_PORT), user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD, database: 'myjob_agent', connectTimeout: 30000,
  });

  // ── daily bars → taxonomy → GAP-FADE ─────────────────────────────────────
  const { rawBars, series } = await loadArchivedSeries(db, instrument);
  const tax = TAX.assessGapSeries(series.sessions, {});
  const dryRun = C.describeCandidateConfig();

  // ── intraday rows → FAILED-ORB paths ─────────────────────────────────────
  const paths = await loadArchivedIntradayPaths(db, instrument, { since });
  await db.end();

  const config = disabled ? { gapFade: { enabled: false }, failedOrb: { enabled: false } } : undefined;
  const rep = C.buildGapCandidates({ assessments: tax.assessments, paths, config });

  console.log(`\n=== row 40 candidate replay — ${instrument} ===`);
  console.log(`config: ${dryRun}`);
  console.log(`daily bars in: ${rawBars.length}   series sessions: ${series.sessions.length}   series exclusions: ${series.exclusions.length}`);
  console.log(`taxonomy: assessed=${tax.coverage.assessed} material=${tax.coverage.materialGaps}`);
  console.log(`intraday paths in: ${paths.length}  (sessions with market-hours rows since ${since})`);

  const g = rep.gapFade, f = rep.failedOrb;
  console.log(`\n-- GAP_FADE (enabled=${g.config.enabled}) --`);
  console.log(`   inputs=${g.coverage.inputsIn} evaluated=${g.coverage.evaluated} CANDIDATES=${g.coverage.candidates} (${pct(g.coverage.candidates, g.coverage.evaluated)} of evaluated)`);
  console.log(`   not-applicable=${g.coverage.notApplicable} unavailable=${g.coverage.unavailable} disabled=${g.coverage.disabled}`);
  console.log(`   reasons: ${JSON.stringify(g.coverage.reasons)}`);
  console.log('   last candidates:');
  for (const r of g.results.filter((x) => x.isCandidate === true).slice(-samples)) {
    console.log(`     ${r.sessionDate}  dir=${r.direction}  target(prevClose)=${r.targetLevel}  invalidate(open)=${r.invalidationLevel}  gapPct=${r.evidence.gapPct?.toFixed(3)}  gapRatio=${r.evidence.gapRatio?.toFixed(3)}`);
  }

  console.log(`\n-- FAILED_ORB (enabled=${f.config.enabled}) --`);
  console.log(`   inputs=${f.coverage.inputsIn} evaluated=${f.coverage.evaluated} CANDIDATES=${f.coverage.candidates} (${pct(f.coverage.candidates, f.coverage.evaluated)} of evaluated)`);
  console.log(`   not-applicable=${f.coverage.notApplicable} unavailable=${f.coverage.unavailable} disabled=${f.coverage.disabled}`);
  console.log(`   reasons: ${JSON.stringify(f.coverage.reasons)}`);
  console.log('   every evaluated session:');
  for (const r of f.results.filter((x) => x.status === 'OK' || x.status === 'NOT_APPLICABLE')) {
    const range = r.openingRange ? `[${r.openingRange.low}..${r.openingRange.high}]` : 'n/a';
    const br = r.breakout ? `break ${hm(r.breakout.atMs)} @${r.breakout.price}` : 'no breakout';
    const re = r.reEntry ? `re-entry ${hm(r.reEntry.atMs)} @${r.reEntry.price}` : 'no re-entry';
    console.log(`     ${r.sessionDate}  ${r.isCandidate ? 'CANDIDATE' : r.status}  range=${range}  ${br}  ${re}  excursion=${r.excursion ?? 'n/a'}  ${r.reason ? '(' + r.reason + ')' : ''}`);
  }

  console.log(`\ncombination: ${JSON.stringify(rep.combination)}`);
  const digest = crypto.createHash('sha256').update(rep.digest).digest('hex').slice(0, 16);
  console.log(`REPLAY_DIGEST_SHA256 ${digest}`);
  console.log(`reviewer summary: ${rep.reviewerSummary}`);
  process.exit(0);
})().catch((e) => { console.error('REPLAY FAILED', e.code || '', e.message); process.exit(1); });
