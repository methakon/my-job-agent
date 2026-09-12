#!/usr/bin/env node
/**
 * GATE 4 #10 (roadmap row 47) — replay expected value after spread, slippage and fees over the ARCHIVE.
 *
 * The GEOMETRY is real: each plan is derived from an archived FAILED_ORB candidate (row 40) — entry = the
 * re-entry price, target = the opposite opening-range edge, stop = the excursion extreme. That table needs
 * no assumption and is always printed.
 *
 * The PROBABILITY and the two FRICTION inputs do NOT exist in the archive. They are caller inputs, so by
 * default every plan is refused (NO_PROBABILITY / NO_FRICTION) and the EV is never fabricated. Supply
 * --p-win, --spread-points and --slippage-points to price the plans under those EXPLICIT, LABELLED
 * assumptions — the run is then reported as an ASSUMPTION, not a measurement.
 *
 * usage: node scripts/gap-expected-value-replay.js [--instrument NSE:NIFTY50-INDEX] [--since 2026-09-01]
 *        [--samples 12] [--p-win 0.5] [--spread-points 0.5] [--slippage-points 0.25] [--units 1] [--segment future]
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
const EV = require(path.join(REPO, 'dist', 'trading', 'gap-engine', 'gap-expected-value'));

const argv = process.argv.slice(2);
const argOf = (name, dflt) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt; };
const instrument = argOf('instrument', 'NSE:NIFTY50-INDEX');
const since = argOf('since', '2026-09-01');
const samples = Number(argOf('samples', 12));
const pWinArg = argOf('p-win', null);
const spreadArg = argOf('spread-points', null);
const slipArg = argOf('slippage-points', null);
const units = Number(argOf('units', '1'));
const segment = argOf('segment', 'future');
const assumed = pWinArg !== null && spreadArg !== null && slipArg !== null;
const n = (v) => (v === null || v === undefined ? 'n/a' : Number(v).toFixed(3));

(async () => {
  const db = await mysql.createConnection({
    host: process.env.MYSQL_HOST, port: Number(process.env.MYSQL_PORT), user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD, database: 'myjob_agent', connectTimeout: 30000,
  });
  const { series } = await loadArchivedSeries(db, instrument);
  const tax = TAX.assessGapSeries(series.sessions, {});
  const paths = await loadArchivedIntradayPaths(db, instrument, { since });
  await db.end();

  const candidates = C.buildGapCandidates({ assessments: tax.assessments, paths });
  const derived = candidates.failedOrb.results.map((c) => EV.planFromFailedOrb(c)).filter(Boolean);
  const plans = derived.map((p) => (assumed ? { ...p, units, segment, pWin: Number(pWinArg), probabilitySource: 'assumption:cli', spreadPoints: Number(spreadArg), slippagePoints: Number(slipArg) } : p));
  const rep = EV.evaluateGapExpectedValue(plans);

  console.log(`\n=== row 47 gap-expected-value replay — ${instrument} ===`);
  console.log(`feature        : ${rep.version}   fee schedule: ${rep.feeScheduleVersion}`);
  console.log(`reviewer       : ${rep.reviewerSummary}`);
  console.log(`\nFAILED_ORB (row 40): candidates=${candidates.failedOrb.coverage.candidates} of evaluated=${candidates.failedOrb.coverage.evaluated}`);
  console.log(`derived plans      : ${derived.length} (real geometry from archived candidates)`);

  console.log('\n-- GEOMETRY (real, assumption-free) --');
  console.log(`   plansIn=${rep.coverage.plansIn} withGeometry=${rep.plans.filter((p) => p.geometry).length} refused=${rep.coverage.unavailable}`);
  console.log(`   refusals: ${JSON.stringify(rep.refusalCounts)}`);
  for (const p of rep.plans.slice(-samples)) {
    const g = p.geometry;
    console.log(`     ${p.sessionDate}  ${p.direction.padEnd(5)} entry=${p.evidence.entryPrice} target=${p.evidence.targetPrice} stop=${p.evidence.stopPrice}  reward=${n(g?.rewardPoints)} risk=${n(g?.riskPoints)} R:R=${n(g?.rewardRiskRatio)} break-even(no friction)=${n(g?.breakEvenProbabilityFrictionless)}${p.reason ? '  [' + p.reason + ']' : ''}`);
  }

  if (!assumed) {
    console.log('\n-- EV: NOT COMPUTED --');
    console.log('   pWin, spreadPoints and slippagePoints are caller inputs and are NOT in the archive.');
    console.log('   Every plan is refused rather than priced on a fabricated probability or friction.');
    console.log('   Re-run with --p-win <0..1> --spread-points <pts> --slippage-points <pts> to price them');
    console.log('   under those EXPLICIT assumptions (the run is then an ASSUMPTION, not a measurement).');
  } else {
    console.log(`\n-- EV UNDER ASSUMPTION (pWin=${pWinArg}, spread=${spreadArg}pts, slippage=${slipArg}pts, units=${units}, segment=${segment}) --`);
    console.log('   ASSUMED INPUTS — this is a scenario, not a measured result.');
    console.log(`   SAMPLE SIZE: ${rep.coverage.sampleSize} priced plan(s)`);
    console.log(`   distribution: ${JSON.stringify(rep.distribution)}`);
    for (const p of rep.plans.slice(-samples)) {
      const c = p.costs, e = p.ev;
      console.log(`     ${p.sessionDate}  ${p.direction.padEnd(5)} cost=${n(c?.totalPoints)}pts (fees ₹${n(c?.feesRupees)})  grossEV=${n(e?.grossEvPoints)} netEV=${n(e?.netEvPoints)}  expectancy/risk=${n(e?.expectancyPerUnitRisk)}  break-even=${n(e?.breakEvenProbability)}`);
    }
  }

  const digest = crypto.createHash('sha256').update(rep.digest).digest('hex').slice(0, 16);
  console.log(`\nREPLAY_DIGEST_SHA256 ${digest}`);
  console.log('NOTE: the calculator estimates nothing — pWin and friction are inputs; no rule here selects, ranks or tunes.');
})().catch((e) => { console.error('REPLAY FAILED', e.code || '', e.message || '', e.sqlMessage ? `\n  sql: ${e.sqlMessage}` : ''); process.exit(1); });
