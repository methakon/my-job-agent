#!/usr/bin/env node
/**
 * GATE 4 #6 (roadmap row 43) — replay early gap acceptance/rejection over the ARCHIVE.
 *
 * Descriptive evidence only: it prints what the early state WAS on archived sessions. Nothing here
 * selects, ranks or tunes; the component's thresholds are structural defaults.
 *
 * Chain: archived daily rows → shared session-series adapter → sessions;
 *        archived intraday rows → shared loader → paths;  the two are joined by (sessionDate, instrument).
 *
 * Intraday coverage is THIN (the loader starts at 2026-09-01), so an honest refusal count is a
 * valid outcome — the replay reports what it found and never manufactures a session.
 *
 * Usage: node scripts/gap-acceptance-replay.js [--instrument NSE:NIFTY50-INDEX] [--since 2026-09-01]
 *                                              [--samples 12] [--disabled]
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mysql = require('mysql2/promise');

const ROOT = path.join(__dirname, '..');
const { loadArchivedSeries, loadArchivedIntradayPaths } = require('./lib/gap-archive.js');
const A = require(path.join(ROOT, 'dist', 'trading', 'gap-engine', 'gap-acceptance'));

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
const hm = (ms) => (ms === null ? 'n/a' : new Date(ms).toISOString().slice(11, 16) + 'Z');

(async () => {
  const instrument = argOf('instrument', 'NSE:NIFTY50-INDEX');
  const since = argOf('since', '2026-09-01');
  const samples = Number(argOf('samples', '12'));
  const db = await mysql.createConnection({
    host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT || 3307),
    user: env.MYSQL_USER, password: env.MYSQL_PASSWORD, database: 'myjob_agent', connectTimeout: 12000,
  });

  const { rawBars, series } = await loadArchivedSeries(db, instrument);
  const paths = await loadArchivedIntradayPaths(db, instrument, { since });
  await db.end();

  const disabled = hasFlag('disabled');
  const result = A.assessGapAcceptance(series.sessions, paths, disabled ? { enabled: false } : {});

  console.log(`\n=== row 43 early gap acceptance/rejection replay — ${instrument} ===`);
  console.log(`feature         : ${result.version}`);
  console.log(`sessions        : ${rawBars.length} archived bars → ${series.coverage.sessionsOut} sessions  ${series.coverage.firstSession} .. ${series.coverage.lastSession}`);
  console.log(`intraday paths  : ${paths.length} session(s) with market-hours rows since ${since}`);
  console.log(`reviewer        : ${result.reviewerSummary}`);

  if (disabled) {
    console.log(`\nDISABLED PATH: no state was computed (DISABLED on ${result.coverage.disabled} input row(s)).`);
    return;
  }

  const c = result.coverage;
  console.log(`\ncoverage        : sessionsIn=${c.sessionsIn} OK=${c.ok} ACCEPTED=${c.accepted} REJECTED=${c.rejected} NOT_APPLICABLE=${c.notApplicable} UNAVAILABLE=${c.unavailable}`);
  console.log(`refusals        : ${JSON.stringify(result.refusalCounts)}`);

  const decided = result.observations.filter((o) => o.status === 'OK');
  if (!decided.length) {
    console.log('\nno session could be decided from the archived intraday coverage — reported as found (the refusal counts above say why).');
  } else {
    console.log(`\nlast ${Math.min(samples, decided.length)} decided session(s):`);
    for (const o of decided.slice(-samples)) {
      const when = o.state === 'REJECTED' ? ` first origin touch ${hm(o.evidence.firstRejectionAtMs)}` : ' origin never touched';
      console.log(`  ${o.sessionDate}  ${o.state}  dir=${o.direction}  gap=${o.evidence.gapAbs}  origin=${o.originLevel}  windowObs=${o.evidence.observationsInWindow}${when}`);
    }
  }

  const refused = result.observations.filter((o) => o.reason);
  if (refused.length) {
    console.log(`\nrefused sessions (${refused.length}) — first ${Math.min(samples, refused.length)}:`);
    for (const o of refused.slice(0, samples)) console.log(`  ${o.sessionDate}  ${o.reason}`);
  }

  const digest = crypto.createHash('sha256').update(result.digest).digest('hex').slice(0, 16);
  console.log(`\nREPLAY_DIGEST_SHA256 ${digest}  (observations ${result.observations.length}, digest ${result.digest.length} chars)`);
  console.log('NOTE: descriptive evidence recorded as found; nothing here selects, ranks or tunes, and no');
  console.log('      production decision, order or risk path reads this component.');
})().catch((e) => {
  console.error('REPLAY FAILED', e.code || '', e.message || '', e.sqlMessage ? `\n  sql: ${e.sqlMessage}` : '');
  process.exit(1);
});
