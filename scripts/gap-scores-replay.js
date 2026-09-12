#!/usr/bin/env node
/**
 * GATE 4 #7 (roadmap row 44) — replay FadeScore / FollowScore over the ARCHIVE.
 *
 * Descriptive evidence only: it prints the distribution of each score over archived sessions.
 * Nothing here selects, ranks, tunes or compares sessions; the weighting is equal and structural.
 *
 * Chain: archived daily rows → session-series adapter → taxonomy (row 38) + GapRangePos (row 41)
 *        → the two independent score blocks.
 *
 * Usage: node scripts/gap-scores-replay.js [--instrument NSE:NIFTY50-INDEX] [--samples 10]
 *                                         [--no-fade] [--no-follow]
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mysql = require('mysql2/promise');

const ROOT = path.join(__dirname, '..');
const { loadArchivedSeries } = require('./lib/gap-archive.js');
const TAX = require(path.join(ROOT, 'dist', 'trading', 'gap-engine', 'gap-taxonomy'));
const RP = require(path.join(ROOT, 'dist', 'trading', 'gap-engine', 'gap-range-pos'));
const S = require(path.join(ROOT, 'dist', 'trading', 'gap-engine', 'gap-scores'));

const env = {};
for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const argOf = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : dflt;
};
const hasFlag = (name) => process.argv.includes(`--${name}`);

(async () => {
  const instrument = argOf('instrument', 'NSE:NIFTY50-INDEX');
  const samples = Number(argOf('samples', '10'));
  const db = await mysql.createConnection({
    host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT || 3307),
    user: env.MYSQL_USER, password: env.MYSQL_PASSWORD, database: 'myjob_agent', connectTimeout: 12000,
  });
  const { rawBars, series } = await loadArchivedSeries(db, instrument);
  await db.end();

  const assessments = TAX.assessGapSeries(series.sessions, {}).assessments;
  const rangePos = RP.assessGapRangePosSeries(series.sessions, {});
  const rep = S.evaluateGapScores(assessments, rangePos, {
    fade: { enabled: !hasFlag('no-fade') },
    follow: { enabled: !hasFlag('no-follow') },
  });

  console.log(`\n=== row 44 FadeScore / FollowScore replay — ${instrument} ===`);
  console.log(`feature         : ${rep.version}`);
  console.log(`series          : ${rawBars.length} archived bars → ${series.coverage.sessionsOut} sessions  ${series.coverage.firstSession} .. ${series.coverage.lastSession}`);
  console.log(`taxonomy        : ${assessments.filter((a) => a.status === 'OK').length} assessed`);
  console.log(`reviewer        : ${rep.reviewerSummary}`);

  for (const block of [rep.fade, rep.follow]) {
    const c = block.coverage;
    console.log(`\n-- ${block.side}${block.enabled ? '' : ' (DISABLED)'} — components: ${S.SCORE_COMPONENTS[block.side].join(' + ')} (max ${block.maxScore}) --`);
    console.log(`   inputs=${c.inputsIn} OK=${c.ok} NOT_APPLICABLE=${c.notApplicable} UNAVAILABLE=${c.unavailable} DISABLED=${c.disabled}`);
    if (!block.enabled) continue;
    const total = block.distribution.reduce((a, b) => a + b, 0);
    console.log(`   distribution [descriptive only, ${total} scored session(s)]:`);
    for (let i = 0; i <= block.maxScore; i += 1) {
      const n = block.distribution[i];
      const pct = total ? `${((n / total) * 100).toFixed(1)}%` : 'n/a';
      console.log(`     score ${i}/${block.maxScore}: ${String(n).padStart(5)}  ${pct}`);
    }
    const tail = block.observations.filter((o) => o.status === 'OK').slice(-samples);
    if (tail.length) {
      console.log(`   last ${tail.length} scored session(s):`);
      for (const o of tail) {
        const on = Object.entries(o.components ?? {}).filter(([, v]) => v).map(([k]) => k).join(',') || 'none';
        console.log(`     ${o.sessionDate}  ${block.side}=${o.score}/${o.maxScore}  dir=${o.direction}  gapRatio=${o.evidence.gapRatio === null ? '-' : o.evidence.gapRatio.toFixed(3)}  pos=${o.evidence.gapRangePos === null ? '-' : o.evidence.gapRangePos.toFixed(3)}  [${on}]`);
      }
    }
  }

  const digest = crypto.createHash('sha256').update(rep.digest).digest('hex').slice(0, 16);
  console.log(`\nREPLAY_DIGEST_SHA256 ${digest}`);
  console.log('NOTE: the distributions above are descriptive evidence recorded as found; every component weighs 1,');
  console.log('      nothing is tuned against outcomes, and no session is ranked against another.');
})().catch((e) => {
  console.error('REPLAY FAILED', e.code || '', e.message || '', e.sqlMessage ? `\n  sql: ${e.sqlMessage}` : '');
  process.exit(1);
});
