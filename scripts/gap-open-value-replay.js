#!/usr/bin/env node
/**
 * GATE 6 #5 (roadmap row 64) — replay gap opens above/below value, with acceptance/rejection, over the ARCHIVE.
 *
 * Descriptive evidence only: it classifies where each session OPENED relative to the PRIOR session's value
 * area and whether a gap open was accepted or rejected — and, as the row's doneWhen requires, prints the
 * SAMPLE SIZE and coverage behind every number.
 *
 * Chain: archived intraday rows → value profile (row 60) → gap-open value (row 64).
 *
 * COVERAGE CAVEAT (measured): only ~28 archived sessions yield an OK value profile, and a gap open needs a
 * PRIOR profiled session for the same instrument — so the sample is small. That is reported, never padded.
 *
 * Usage: node scripts/gap-open-value-replay.js [--instrument NSE:NIFTY50-INDEX] [--since 2021-01-01]
 *                                             [--samples 8]
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mysql = require('mysql2/promise');

const ROOT = path.join(__dirname, '..');
const { loadArchivedProfilePaths } = require('./lib/gap-archive.js');
const V = require(path.join(ROOT, 'dist', 'trading', 'value-profile', 'value-profile'));
const G = require(path.join(ROOT, 'dist', 'trading', 'value-profile', 'gap-open-value'));

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
  const sessions = paths.map((p) => ({ sessionDate: p.sessionDate, instrument: p.instrument }));
  const rep = G.buildGapOpenValue(sessions, profiles, paths);

  console.log(`\n=== row 64 gap-open-value replay — ${instrument} ===`);
  console.log(`feature         : ${rep.version}  (upstream profiles ${rep.upstreamProfileVersion})`);
  console.log(`profiles (row60): ${profiles.coverage.ok} OK of ${profiles.coverage.sessionsIn} (schema-wide)`);
  console.log(`reviewer        : ${rep.reviewerSummary}`);

  const c = rep.coverage;
  console.log(`\nSAMPLE SIZE     : ${c.sampleSize} judged gap open(s) — the number of openings described`);
  console.log(`coverage        : sessionsIn=${c.sessionsIn} profilesIn=${c.profilesIn} referenceAreas=${c.referenceAreas}`);
  console.log(`                  aboveValue=${c.aboveValue} belowValue=${c.belowValue} insideValue=${c.insideValue} notApplicable=${c.notApplicable} unavailable=${c.unavailable}`);
  console.log(`refusals        : ${JSON.stringify(rep.refusalCounts)}`);
  console.log(`outcomes        : ${JSON.stringify(rep.outcomeCounts)}`);
  console.log(`METRIC by location:`);
  for (const loc of ['ABOVE_VALUE', 'BELOW_VALUE']) {
    const m = rep.locationOutcomeCounts[loc];
    console.log(`  ${loc.padEnd(12)} ACCEPTED=${m.ACCEPTED} REJECTED=${m.REJECTED} REVISITED=${m.REVISITED}`);
  }

  const judged = rep.observations.filter((o) => o.status === 'OK');
  if (!judged.length) {
    console.log('\nno gap open could be judged — reported as found (the sample size above is 0, with the reason).');
  } else {
    console.log(`\nlast ${Math.min(samples, judged.length)} judged session(s):`);
    for (const o of judged.slice(-samples)) {
      const gap = o.gapPoints === null ? 'n/a' : o.gapPoints.toFixed(1);
      const back = o.timeToReturnMs === null ? 'held' : `return@+${(o.timeToReturnMs / 60_000).toFixed(0)}m`;
      console.log(`  ${o.sessionDate}  open=${o.evidence.open} vs [${o.evidence.val},${o.evidence.vah}]  ${o.location.padEnd(12)} gap=${gap}pts  ${o.outcome.padEnd(9)} ${back}`);
    }
  }

  const digest = crypto.createHash('sha256').update(rep.digest).digest('hex').slice(0, 16);
  console.log(`\nREPLAY_DIGEST_SHA256 ${digest}  (judged ${judged.length})`);
  console.log('NOTE: descriptive evidence recorded as found; the open and acceptance rules have no tolerance,');
  console.log('      an open exactly on an edge counts as INSIDE, and nothing here selects, ranks or tunes.');
})().catch((e) => {
  console.error('REPLAY FAILED', e.code || '', e.message || '', e.sqlMessage ? `\n  sql: ${e.sqlMessage}` : '');
  process.exit(1);
});
