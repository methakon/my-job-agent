#!/usr/bin/env node
/**
 * GATE 4 #2 (roadmap row 39) — REPLAY both gap hypotheses over the ARCHIVE.
 *
 * Descriptive evidence only: this prints what HAPPENED per hypothesis. Nothing here selects,
 * tunes or optimises a threshold, and no default in the engine is derived from these numbers.
 *
 * Chain: archived daily rows → shared session-series adapter → taxonomy → hypotheses.
 * Session labelling, bar selection and the close/prevClose rule all live in the shared loader
 * and adapter (see scripts/lib/gap-archive.js and src/trading/gap-engine/gap-session-series.ts).
 *
 * Usage:
 *   node scripts/gap-hypotheses-replay.js [--instrument NSE:NIFTY50-INDEX] [--samples 12]
 *                                         [--no-gap-fill] [--no-gap-and-go]
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mysql = require('mysql2/promise');

const ROOT = path.join(__dirname, '..');
const { loadArchivedSeries } = require('./lib/gap-archive.js');
const TAX = require(path.join(ROOT, 'dist', 'trading', 'gap-engine', 'gap-taxonomy'));
const HYP = require(path.join(ROOT, 'dist', 'trading', 'gap-engine', 'gap-hypotheses'));

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
const pct = (v) => (v === null ? 'n/a' : `${(v * 100).toFixed(1)}%`);

(async () => {
  const instrument = argOf('instrument', 'NSE:NIFTY50-INDEX');
  const samples = Number(argOf('samples', '12'));
  const db = await mysql.createConnection({
    host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT || 3307),
    user: env.MYSQL_USER, password: env.MYSQL_PASSWORD, database: 'myjob_agent', connectTimeout: 12000,
  });

  const { rawBars, series } = await loadArchivedSeries(db, instrument);
  const taxonomy = TAX.assessGapSeries(series.sessions, {});
  const config = {
    GAP_FILL: { enabled: !hasFlag('no-gap-fill') },
    GAP_AND_GO: { enabled: !hasFlag('no-gap-and-go') },
  };
  const report = HYP.evaluateGapHypotheses(taxonomy.assessments, config);

  console.log(`instrument      : ${instrument}`);
  console.log(`archive rows    : ${rawBars.length} (one bar per session)`);
  console.log(`series          : ${series.coverage.sessionsOut} sessions ${series.coverage.firstSession} .. ${series.coverage.lastSession}`);
  console.log(`taxonomy        : ${taxonomy.version} material gaps=${taxonomy.coverage.materialGaps} filled=${taxonomy.coverage.filled} open=${taxonomy.coverage.openGaps}`);
  console.log(`hypotheses      : ${report.version}`);
  console.log(`reviewer        : ${report.reviewerSummary}`);

  for (const block of [report.gapFill, report.gapAndGo]) {
    const c = block.coverage;
    console.log(`\n=== ${block.spec.hypothesis} ${block.enabled ? '' : '(DISABLED)'} ===`);
    console.log(`  asserts     : ${block.spec.asserts}`);
    console.log(`  realized    : ${block.spec.realizedWhen}`);
    console.log(`  considered  : ${c.sessionsConsidered}   evaluable: ${c.evaluable}`);
    console.log(`  REALIZED    : ${c.realized}   NOT_REALIZED: ${c.notRealized}   realizedRate: ${pct(c.realizedRate)}`);
    console.log(`  unavailable : ${c.unavailable}   not applicable (no material gap): ${c.notApplicable}`);
    if (!block.enabled) continue;

    const evaluable = block.observations.filter((o) => o.status === 'OK');
    const byDirection = { UP: [0, 0], DOWN: [0, 0] };
    for (const o of evaluable) {
      const dir = (taxonomy.assessments.find((a) => a.sessionDate === o.sessionDate) || {}).direction;
      if (!dir || !byDirection[dir]) continue;
      byDirection[dir][0] += 1;
      if (o.outcome === 'REALIZED') byDirection[dir][1] += 1;
    }
    for (const dir of ['UP', 'DOWN']) {
      const [n, r] = byDirection[dir];
      console.log(`  ${dir.padEnd(4)}        : ${r}/${n} realized ${n ? `(${((r / n) * 100).toFixed(1)}%)` : ''}`);
    }

    if (block.spec.hypothesis === 'GAP_AND_GO') {
      const rs = evaluable.map((o) => o.evidence.descriptiveRMultiple).filter((v) => typeof v === 'number');
      if (rs.length) {
        const sorted = [...rs].sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)];
        console.log(`  descriptive R (entry=open, risk=gap, reward=session extreme): min ${sorted[0].toFixed(2)} median ${median.toFixed(2)} max ${sorted[sorted.length - 1].toFixed(2)}  [descriptive only]`);
      }
    }

    const tail = block.observations.slice(-Math.min(samples, block.observations.length));
    console.log(`  last ${tail.length} sessions:`);
    for (const o of tail) {
      const note = o.status === 'OK'
        ? `${String(o.outcome).padEnd(12)} gapPts=${o.evidence.gapPts === null || o.evidence.gapPts === undefined ? '-' : o.evidence.gapPts.toFixed(2)}${o.evidence.sessionExtensionPts !== undefined && o.evidence.sessionExtensionPts !== null ? ` extPts=${o.evidence.sessionExtensionPts.toFixed(2)}` : ''}`
        : `${o.status} (${String(o.reason).slice(0, 70)})`;
      console.log(`    ${o.sessionDate}  ${note}`);
    }
  }

  console.log('\n=== overlap of the two independent hypotheses (evaluated by both) ===');
  console.log(`  both realized: ${report.combination.bothRealized}   only GAP_FILL: ${report.combination.onlyGapFill}   only GAP_AND_GO: ${report.combination.onlyGapAndGo}   neither: ${report.combination.neither}`);
  console.log('  (the two are NOT complements: a filled gap cannot also hold, and an immaterial session belongs to neither)');

  const digestHash = crypto.createHash('sha256').update(report.digest).digest('hex').slice(0, 16);
  console.log(`\nREPLAY_DIGEST_SHA256 ${digestHash}  (digest ${report.digest.length} chars)`);
  console.log('NOTE: historical rates above are descriptive evidence recorded as found; no threshold in the');
  console.log('      engine is selected, tuned or re-derived from them.');
  await db.end();
})().catch((e) => { console.error('REPLAY FAILED', e.code || '', e.message || '', e.sqlMessage ? `\n  sql: ${e.sqlMessage}` : ''); process.exit(1); });
