#!/usr/bin/env node
/**
 * GATE 6 #4 (roadmap row 63) — replay value migration across sessions over the ARCHIVE.
 *
 * Descriptive evidence only: it prints how the value area moved from one profiled session to the next,
 * and — as the row's doneWhen requires — the SAMPLE SIZE and coverage behind every number.
 *
 * Chain: archived intraday rows → value profile (row 60) → value migration (row 63).
 *
 * COVERAGE CAVEAT (measured): only ~28 archived sessions yield an OK value profile, and a migration
 * needs TWO CONSECUTIVE profiled sessions for the same instrument — so the sample is small. That is
 * reported, never padded.
 *
 * Usage: node scripts/value-migration-replay.js [--instrument NSE:NIFTY50-INDEX] [--since 2021-01-01]
 *                                             [--samples 8]
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mysql = require('mysql2/promise');

const ROOT = path.join(__dirname, '..');
const { loadArchivedProfilePaths } = require('./lib/gap-archive.js');
const V = require(path.join(ROOT, 'dist', 'trading', 'value-profile', 'value-profile'));
const M = require(path.join(ROOT, 'dist', 'trading', 'value-profile', 'value-migration'));

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
  const paths = await loadArchivedProfilePaths(db, instrument, { since });
  await db.end();

  const profiles = V.buildValueProfiles(paths);
  const rep = M.buildValueMigration(profiles);

  console.log(`\n=== row 63 value-migration replay — ${instrument} ===`);
  console.log(`feature         : ${rep.version}  (upstream profiles ${rep.upstreamProfileVersion})`);
  console.log(`profiles (row60): ${profiles.coverage.ok} OK of ${profiles.coverage.sessionsIn} (schema-wide)`);
  console.log(`reviewer        : ${rep.reviewerSummary}`);

  const c = rep.coverage;
  console.log(`\nstatus          : ${rep.status}${rep.reason ? ` (${rep.reason})` : ''}`);
  if (rep.reasonDetail) console.log(`reason          : ${rep.reasonDetail}`);
  console.log(`SAMPLE SIZE     : ${c.sampleSize} pair(s) — the number of migrations described`);
  console.log(`coverage        : sessionsIn=${c.sessionsIn} profilesIn=${c.profilesIn} okProfiles=${c.okProfiles} instruments=${c.instrumentCount} non-consecutivePairs=${c.sessionsNotConsecutive}`);
  console.log(`refusals        : ${JSON.stringify(rep.refusalCounts)}`);
  console.log(`state counts    : ${JSON.stringify(rep.stateCounts)}`);

  if (!rep.transitions.length) {
    console.log('\nno migration could be described — reported as found (the sample size above is 0, with the reason).');
  } else {
    console.log(`\nlast ${Math.min(samples, rep.transitions.length)} transition(s):`);
    for (const t of rep.transitions.slice(-samples)) {
      console.log(`  ${t.previousSessionDate} → ${t.sessionDate} (gap ${t.dayGap}d)  ${t.state.padEnd(9)} dVAL=${t.valDelta.toFixed(1)} dVAH=${t.vahDelta.toFixed(1)} overlap=${t.overlapPoints.toFixed(1)}pts (${(t.overlapOfUnion * 100).toFixed(1)}% of union)`);
    }
  }

  const digest = crypto.createHash('sha256').update(rep.digest).digest('hex').slice(0, 16);
  console.log(`\nREPLAY_DIGEST_SHA256 ${digest}  (transitions ${rep.transitions.length})`);
  console.log('NOTE: descriptive evidence recorded as found; overlap is descriptive, every state compares the');
  console.log('      two areas own edges, and nothing here selects, ranks or tunes.');
})().catch((e) => {
  console.error('REPLAY FAILED', e.code || '', e.message || '', e.sqlMessage ? `\n  sql: ${e.sqlMessage}` : '');
  process.exit(1);
});
