#!/usr/bin/env node
/**
 * GATE 4 #4 (roadmap row 41) — replay GapRangePos over the ARCHIVE.
 *
 * Descriptive evidence only: it prints what the feature WAS on the archived sessions. Nothing here
 * selects, ranks or tunes; the component has no threshold to tune.
 *
 * Chain: archived daily rows → shared session-series adapter → GapRangePos.
 * Session labelling and bar selection live in the shared loader and adapter
 * (scripts/lib/gap-archive.js and src/trading/gap-engine/gap-session-series.ts).
 *
 * Usage: node scripts/gap-range-pos-replay.js [--instrument NSE:NIFTY50-INDEX] [--samples 12] [--disabled]
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mysql = require('mysql2/promise');

const ROOT = path.join(__dirname, '..');
const { loadArchivedSeries } = require('./lib/gap-archive.js');
const G = require(path.join(ROOT, 'dist', 'trading', 'gap-engine', 'gap-range-pos'));

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
  const samples = Number(argOf('samples', '12'));
  const db = await mysql.createConnection({
    host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT || 3307),
    user: env.MYSQL_USER, password: env.MYSQL_PASSWORD, database: 'myjob_agent', connectTimeout: 12000,
  });

  const { rawBars, series } = await loadArchivedSeries(db, instrument);
  await db.end();

  const disabled = hasFlag('disabled');
  const result = G.assessGapRangePosSeries(series.sessions, disabled ? { enabled: false } : {});

  console.log(`\n=== row 41 GapRangePos replay — ${instrument} ===`);
  console.log(`feature         : ${result.version}`);
  console.log(`archive rows    : ${rawBars.length} (one bar per session)`);
  console.log(`series          : ${series.coverage.sessionsOut} sessions  ${series.coverage.firstSession} .. ${series.coverage.lastSession}`);
  console.log(`reviewer        : ${result.reviewerSummary}`);

  if (disabled) {
    console.log(`\nDISABLED PATH: no GapRangePos was computed (status DISABLED on ${result.coverage.disabled} input row(s)).`);
    return;
  }

  const c = result.coverage;
  console.log(`\ncoverage        : sessionsIn=${c.sessionsIn} OK=${c.ok} UNAVAILABLE=${c.unavailable}`);
  console.log(`                  first OK ${c.firstOkSession} .. last OK ${c.lastOkSession}`);
  console.log(`refusals        : ${JSON.stringify(result.refusalCounts)}`);

  const values = result.observations.map((o) => o.gapRangePos).filter((v) => typeof v === 'number');
  if (values.length) {
    const sorted = [...values].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const below = values.filter((v) => v < 0).length;
    const inside = values.filter((v) => v >= 0 && v <= 1).length;
    const above = values.filter((v) => v > 1).length;
    console.log(`\nGapRangePos distribution [descriptive only]`);
    console.log(`  n=${values.length}  min ${sorted[0].toFixed(3)}  median ${median.toFixed(3)}  max ${sorted[sorted.length - 1].toFixed(3)}`);
    console.log(`  opened below the prior range (<0): ${below}   inside [0..1]: ${inside}   above (>1): ${above}`);
  } else {
    console.log('\nGapRangePos distribution: no OK rows in this window — reported as found.');
  }

  const tail = result.observations.slice(-Math.min(samples, result.observations.length));
  console.log(`\nlast ${tail.length} sessions:`);
  for (const o of tail) {
    const note = o.status === 'OK'
      ? `GapRangePos=${o.gapRangePos.toFixed(3)}  (open ${o.measures.open} vs prior ${o.measures.priorLow}..${o.measures.priorHigh})`
      : `${o.status} (${o.reason})`;
    console.log(`  ${o.sessionDate}  ${note}`);
  }

  const digest = crypto.createHash('sha256').update(result.digest).digest('hex').slice(0, 16);
  console.log(`\nREPLAY_DIGEST_SHA256 ${digest}  (observations ${result.observations.length}, digest ${result.digest.length} chars)`);
  console.log('NOTE: the values above are descriptive evidence recorded as found; the component holds no');
  console.log('      threshold and nothing here selects, ranks or tunes.');
})().catch((e) => {
  console.error('REPLAY FAILED', e.code || '', e.message || '', e.sqlMessage ? `\n  sql: ${e.sqlMessage}` : '');
  process.exit(1);
});
