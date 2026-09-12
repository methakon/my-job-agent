#!/usr/bin/env node
/**
 * GATE 4 #11 (roadmap row 48) — replay the FADE / FOLLOW / NO TRADE decision over the ARCHIVE.
 *
 * Chain: archived daily rows → session-series adapter → taxonomy (row 38) + GapRangePos (row 41)
 *        → FadeScore/FollowScore (row 44) + acceptance/rejection state (row 43)  → decision (row 48).
 *        Optionally the FAILED-ORB-derived EV (row 47) is attached when probability/friction are supplied.
 *
 * Descriptive evidence only: it prints what the rule returned on real archived sessions, never what to do.
 * Nothing here selects, ranks or tunes.
 *
 * usage: node scripts/gap-decision-replay.js [--instrument NSE:NIFTY50-INDEX] [--since 2026-09-01]
 *        [--samples 12] [--require-ev] [--p-win 0.5] [--spread-points 0.5] [--slippage-points 0.25]
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mysql = require('mysql2/promise');

const ROOT = path.join(__dirname, '..');
const { loadArchivedSeries, loadArchivedIntradayPaths } = require('./lib/gap-archive.js');
const TAX = require(path.join(ROOT, 'dist', 'trading', 'gap-engine', 'gap-taxonomy'));
const RP = require(path.join(ROOT, 'dist', 'trading', 'gap-engine', 'gap-range-pos'));
const S = require(path.join(ROOT, 'dist', 'trading', 'gap-engine', 'gap-scores'));
const A = require(path.join(ROOT, 'dist', 'trading', 'gap-engine', 'gap-acceptance'));
const C = require(path.join(ROOT, 'dist', 'trading', 'gap-engine', 'gap-candidates'));
const EV = require(path.join(ROOT, 'dist', 'trading', 'gap-engine', 'gap-expected-value'));
const D = require(path.join(ROOT, 'dist', 'trading', 'gap-engine', 'gap-decision'));

const env = {};
for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const argv = process.argv.slice(2);
const argOf = (name, dflt) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt; };
const hasFlag = (name) => argv.includes(`--${name}`);

(async () => {
  const instrument = argOf('instrument', 'NSE:NIFTY50-INDEX');
  const since = argOf('since', '2026-09-01');
  const samples = Number(argOf('samples', '12'));
  const pWinArg = argOf('p-win', null);
  const spreadArg = argOf('spread-points', null);
  const slipArg = argOf('slippage-points', null);
  const evAssumed = pWinArg !== null && spreadArg !== null && slipArg !== null;

  const db = await mysql.createConnection({
    host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT || 3307),
    user: env.MYSQL_USER, password: env.MYSQL_PASSWORD, database: 'myjob_agent', connectTimeout: 12000,
  });
  const { rawBars, series } = await loadArchivedSeries(db, instrument);
  const paths = await loadArchivedIntradayPaths(db, instrument, { since });
  await db.end();

  const assessments = TAX.assessGapSeries(series.sessions, {}).assessments;
  const rangePos = RP.assessGapRangePosSeries(series.sessions, {});
  const scores = S.evaluateGapScores(assessments, rangePos);
  const acceptance = A.assessGapAcceptance(series.sessions, paths);

  let evReport = null;
  if (evAssumed) {
    const candidates = C.buildGapCandidates({ assessments, paths });
    const plans = candidates.failedOrb.results
      .map((c) => EV.planFromFailedOrb(c))
      .filter(Boolean)
      .map((p) => ({ ...p, units: 1, segment: 'future', pWin: Number(pWinArg), probabilitySource: 'assumption:cli', spreadPoints: Number(spreadArg), slippagePoints: Number(slipArg) }));
    evReport = EV.evaluateGapExpectedValue(plans);
  }

  const rep = D.decideGapSessions({ scores, acceptance, ev: evReport }, { requireEv: hasFlag('require-ev') });

  console.log(`\n=== row 48 gap-decision replay — ${instrument} ===`);
  console.log(`feature   : ${rep.version}   requireEv=${rep.config.requireEv}`);
  console.log(`upstream  : scores=${rep.upstream.scoresVersion} acceptance=${rep.upstream.acceptanceVersion} ev=${rep.upstream.evVersion ?? 'not supplied'}`);
  console.log(`series    : ${rawBars.length} archived bars → ${series.coverage.sessionsOut} sessions  ${series.coverage.firstSession} .. ${series.coverage.lastSession}`);
  console.log(`inputs    : scores fade OK=${scores.fade.coverage.ok} follow OK=${scores.follow.coverage.ok}; acceptance accepted=${acceptance.coverage.accepted} rejected=${acceptance.coverage.rejected}`);
  console.log(`reviewer  : ${rep.reviewerSummary}`);

  const c = rep.coverage;
  console.log(`\nDECISIONS  : FADE=${c.fade} FOLLOW=${c.follow} NO_TRADE=${c.noTrade}   (decided=${c.decided} of sessionsIn=${c.sessionsIn})`);
  console.log(`             evGate: passed=${c.evPassed} notSupplied=${c.evNotSupplied}${rep.upstream.evVersion ? '' : '  (no EV report attached)'}`);
  console.log(`reasons    : ${JSON.stringify(rep.reasonCounts)}`);

  if (!rep.decisions.length) {
    console.log('\nno session reached the decision stage — reported as found.');
  } else {
    console.log(`\nlast ${Math.min(samples, rep.decisions.length)} session(s):`);
    for (const d of rep.decisions.slice(-samples)) {
      const w = d.winner ? `${d.winner.side}=${d.winner.score}/${d.winner.maxScore}` : '-';
      console.log(`  ${d.sessionDate}  ${d.decision.padEnd(8)} ${(d.tradeDirection ?? '-').padEnd(5)} gap=${d.gapDirection ?? '-'}  winner=${w}  acceptance=${d.evidence.acceptanceState ?? '-'}  ev=${d.evidence.evNetPoints ?? 'n/a'}  ${d.reason ? '(' + d.reason + ')' : ''}`);
    }
  }

  const digest = crypto.createHash('sha256').update(rep.digest).digest('hex').slice(0, 16);
  console.log(`\nREPLAY_DIGEST_SHA256 ${digest}`);
  console.log('NOTE: descriptive evidence recorded as found; equal-weight counts and an exact state match,');
  console.log('      no threshold tuning, and every failure path is NO_TRADE — never a guessed side.');
})().catch((e) => {
  console.error('REPLAY FAILED', e.code || '', e.message || '', e.sqlMessage ? `\n  sql: ${e.sqlMessage}` : '');
  process.exit(1);
});
