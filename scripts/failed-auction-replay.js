#!/usr/bin/env node
/**
 * GATE 6 #3 (roadmap row 62) — replay failed-auction detection over the ARCHIVE.
 *
 * Descriptive evidence only. Chain: archived daily rows → sessions; archived intraday rows →
 * value profile (row 60) → failed-auction detection (row 62).
 *
 * COVERAGE CAVEAT (measured): only ~28 archived sessions yield a value profile, and a session needs a
 * tape covering BOTH the open and the close to be judged at all — so few sessions can be decided. The
 * refusal counts below say why; nothing is proxied to make the replay look populated.
 *
 * Usage: node scripts/failed-auction-replay.js [--instrument NSE:NIFTY50-INDEX] [--since 2021-01-01] [--samples 8]
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mysql = require('mysql2/promise');

const ROOT = path.join(__dirname, '..');
const { loadArchivedSeries, loadArchivedProfilePaths } = require('./lib/gap-archive.js');
const V = require(path.join(ROOT, 'dist', 'trading', 'value-profile', 'value-profile'));
const F = require(path.join(ROOT, 'dist', 'trading', 'value-profile', 'failed-auction'));

const env = {};
for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const argOf = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : dflt;
};
const hm = (ms) => (ms === null ? 'n/a' : new Date(ms).toISOString().slice(11, 16) + 'Z');

(async () => {
  const instrument = argOf('instrument', 'NSE:NIFTY50-INDEX');
  const since = argOf('since', '2021-01-01');
  const samples = Number(argOf('samples', '8'));
  const db = await mysql.createConnection({
    host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT || 3307),
    user: env.MYSQL_USER, password: env.MYSQL_PASSWORD, database: 'myjob_agent', connectTimeout: 12000,
  });
  const { series } = await loadArchivedSeries(db, instrument);
  const paths = await loadArchivedProfilePaths(db, instrument, { since });
  await db.end();

  const profiles = V.buildValueProfiles(paths);
  const rep = F.detectFailedAuctions(series.sessions, profiles, paths);

  console.log(`\n=== row 62 failed-auction replay — ${instrument} ===`);
  console.log(`feature         : ${rep.version}`);
  console.log(`sessions        : ${series.coverage.sessionsOut}`);
  console.log(`profiles (row60): ${profiles.coverage.ok} OK of ${profiles.coverage.sessionsIn}`);
  console.log(`reviewer        : ${rep.reviewerSummary}`);

  const c = rep.coverage;
  console.log(`\ncoverage        : sessionsIn=${c.sessionsIn} OK=${c.ok} (FAILED=${c.failed}, HELD=${c.held}, REVISITED=${c.revisited}) NOT_APPLICABLE=${c.notApplicable} UNAVAILABLE=${c.unavailable}`);
  console.log(`refusals        : ${JSON.stringify(rep.refusalCounts)}`);

  const decided = rep.observations.filter((o) => o.status === 'OK');
  if (!decided.length) {
    console.log('\nno session could be judged — reported as found (the refusal counts above say why).');
  } else {
    console.log(`\nlast ${Math.min(samples, decided.length)} decided session(s):`);
    for (const o of decided.slice(-samples)) {
      console.log(`  ${o.sessionDate}  ${o.state.padEnd(19)} dir=${o.direction}  area=${o.evidence.val}..${o.evidence.vah}  excursion=${hm(o.evidence.firstExcursionAtMs)}  return=${hm(o.evidence.firstReturnInsideAtMs)}  outside=${o.evidence.observationsOutside}`);
    }
  }

  const digest = crypto.createHash('sha256').update(rep.digest).digest('hex').slice(0, 16);
  console.log(`\nREPLAY_DIGEST_SHA256 ${digest}  (observations ${rep.observations.length})`);
  console.log('NOTE: descriptive evidence recorded as found; nothing here selects, ranks or tunes.');
})().catch((e) => {
  console.error('REPLAY FAILED', e.code || '', e.message || '', e.sqlMessage ? `\n  sql: ${e.sqlMessage}` : '');
  process.exit(1);
});
