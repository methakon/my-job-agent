#!/usr/bin/env node
/**
 * GATE 4 #5 (roadmap row 42) — replay the opening position vs the prior value area over the ARCHIVE.
 *
 * Descriptive evidence only. Chain: archived daily rows → session-series adapter (sessions);
 * archived intraday rows → value profile (row 60) → opening position (row 42).
 *
 * COVERAGE CAVEAT, measured: only ~28 archived sessions yield a value profile at all (the archive's
 * in-window density is recent-only), so the position is derivable for few sessions. The refusal counts
 * below are reported as found — nothing is proxied to make the replay look populated.
 *
 * Usage: node scripts/opening-position-replay.js [--instrument NSE:NIFTY50-INDEX] [--since 2021-01-01]
 *                                               [--samples 8]
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mysql = require('mysql2/promise');

const ROOT = path.join(__dirname, '..');
const { loadArchivedSeries, loadArchivedProfilePaths } = require('./lib/gap-archive.js');
const V = require(path.join(ROOT, 'dist', 'trading', 'value-profile', 'value-profile'));
const O = require(path.join(ROOT, 'dist', 'trading', 'gap-engine', 'opening-position'));

const env = {};
for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const argOf = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : dflt;
};

(async () => {
  const instrument = argOf('instrument', 'NSE:NIFTY50-INDEX');
  const since = argOf('since', '2021-01-01');
  const samples = Number(argOf('samples', '8'));
  const db = await mysql.createConnection({
    host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT || 3307),
    user: env.MYSQL_USER, password: env.MYSQL_PASSWORD, database: 'myjob_agent', connectTimeout: 12000,
  });
  const { series } = await loadArchivedSeries(db, instrument);
  const profilePaths = await loadArchivedProfilePaths(db, instrument, { since });
  await db.end();

  const profiles = V.buildValueProfiles(profilePaths);
  const rep = O.buildOpeningPositions(series.sessions, profiles);

  console.log(`\n=== row 42 opening-position replay — ${instrument} ===`);
  console.log(`feature         : ${rep.version}`);
  console.log(`sessions        : ${series.coverage.sessionsOut}`);
  console.log(`profiles (row60): ${profiles.coverage.ok} OK of ${profiles.coverage.sessionsIn} (VOLUME=${profiles.coverage.volume}, TPO=${profiles.coverage.tpo})`);
  console.log(`reviewer        : ${rep.reviewerSummary}`);

  const c = rep.coverage;
  console.log(`\ncoverage        : sessionsIn=${c.sessionsIn} OK=${c.ok} (ABOVE=${c.above}, INSIDE=${c.inside}, BELOW=${c.below}) UNAVAILABLE=${c.unavailable}`);
  console.log(`refusals        : ${JSON.stringify(rep.refusalCounts)}`);

  const decided = rep.observations.filter((o) => o.status === 'OK');
  if (!decided.length) {
    console.log('\nno session could be placed against a prior value area — reported as found.');
  } else {
    console.log(`\nlast ${Math.min(samples, decided.length)} position(s):`);
    for (const o of decided.slice(-samples)) {
      console.log(`  ${o.sessionDate}  ${o.state.padEnd(12)} pos=${o.pos.toFixed(3)}  open=${o.evidence.open}  prior(${o.priorSessionDate}) VAL=${o.evidence.val} VAH=${o.evidence.vah} basis=${o.evidence.priorBasis}`);
    }
  }

  const digest = crypto.createHash('sha256').update(rep.digest).digest('hex').slice(0, 16);
  console.log(`\nREPLAY_DIGEST_SHA256 ${digest}  (observations ${rep.observations.length})`);
  console.log('NOTE: descriptive evidence recorded as found; nothing here selects, ranks or tunes.');
})().catch((e) => {
  console.error('REPLAY FAILED', e.code || '', e.message || '', e.sqlMessage ? `\n  sql: ${e.sqlMessage}` : '');
  process.exit(1);
});
