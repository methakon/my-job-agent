#!/usr/bin/env node
/**
 * GATE 6 #1 (roadmap row 60) — replay the value profile over the ARCHIVE.
 *
 * Descriptive evidence only: it prints the POC / value area / nodes that WERE derivable from archived
 * sessions, and — just as importantly — which BASIS each used and how many sessions were refused.
 * Nothing here selects, ranks or tunes; the component's thresholds are structural defaults.
 *
 * MEASURED INPUT CAVEAT: only source='fyers-history' rows carry volume on this archive; every live
 * `fyers` and `yahoo` row stores 0.00. So AUTO is expected to choose TPO almost everywhere — that is
 * the finding, reported rather than hidden.
 *
 * Usage: node scripts/value-profile-replay.js [--instrument NSE:NIFTY50-INDEX] [--since 2021-01-01]
 *                                           [--samples 8] [--basis AUTO|VOLUME|TPO] [--disabled]
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mysql = require('mysql2/promise');

const ROOT = path.join(__dirname, '..');
const { loadArchivedProfilePaths } = require('./lib/gap-archive.js');
const V = require(path.join(ROOT, 'dist', 'trading', 'value-profile', 'value-profile'));

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
  const since = argOf('since', '2021-01-01');
  const samples = Number(argOf('samples', '8'));
  const basis = argOf('basis', 'AUTO');
  const db = await mysql.createConnection({
    host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT || 3307),
    user: env.MYSQL_USER, password: env.MYSQL_PASSWORD, database: 'myjob_agent', connectTimeout: 12000,
  });
  const paths = await loadArchivedProfilePaths(db, instrument, { since });
  await db.end();

  const disabled = hasFlag('disabled');
  const rep = V.buildValueProfiles(paths, disabled ? { enabled: false } : { basis });

  console.log(`\n=== row 60 value-profile replay — ${instrument} ===`);
  console.log(`feature         : ${rep.version}`);
  console.log(`sessions loaded : ${paths.length} (market-hours rows since ${since})`);
  console.log(`reviewer        : ${rep.reviewerSummary}`);

  if (disabled) {
    console.log(`\nDISABLED PATH: no profile was computed (DISABLED on ${rep.coverage.disabled} input row(s)).`);
    return;
  }

  const c = rep.coverage;
  console.log(`\ncoverage        : sessionsIn=${c.sessionsIn} OK=${c.ok} (VOLUME=${c.volume}, TPO=${c.tpo}) UNAVAILABLE=${c.unavailable}`);
  console.log(`refusals        : ${JSON.stringify(rep.refusalCounts)}`);

  const ok_profiles = rep.profiles.filter((p) => p.status === 'OK');
  if (!ok_profiles.length) {
    console.log('\nno session produced a value area — reported as found (the refusal counts above say why).');
  } else {
    const withVolume = ok_profiles.filter((p) => p.basis === 'VOLUME').length;
    console.log(`\nBASIS FINDING   : ${withVolume}/${ok_profiles.length} profiles used VOLUME; the rest used TPO`);
    console.log('                  (only source=\'fyers-history\' rows carry volume on this archive).');
    console.log(`\nlast ${Math.min(samples, ok_profiles.length)} profile(s):`);
    for (const p of ok_profiles.slice(-samples)) {
      console.log(`  ${p.sessionDate}  basis=${p.basis}  levels=${p.levels}  POC=${p.poc.priceLow}..${p.poc.priceHigh}  VAL=${p.val}  VAH=${p.vah}  share=${(p.valueAreaActivityShare * 100).toFixed(1)}%  HVN=${p.hvn.length}  LVN=${p.lvn.length}  obs=${p.observationsUsed}`);
    }
    const covered = ok_profiles.filter((p) => p.observationsWithVolume > 0).length;
    console.log(`\nsessions with ANY usable volume: ${covered}`);
  }

  const digest = crypto.createHash('sha256').update(rep.digest).digest('hex').slice(0, 16);
  console.log(`\nREPLAY_DIGEST_SHA256 ${digest}  (profiles ${rep.profiles.length}, digest ${rep.digest.length} chars)`);
  console.log('NOTE: descriptive evidence recorded as found; the value area uses a documented 70% rule and a');
  console.log('      data-derived HVN/LVN separator, and nothing here selects, ranks or tunes.');
})().catch((e) => {
  console.error('REPLAY FAILED', e.code || '', e.message || '', e.sqlMessage ? `\n  sql: ${e.sqlMessage}` : '');
  process.exit(1);
});
