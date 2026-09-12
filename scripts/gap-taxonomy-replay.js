#!/usr/bin/env node
/**
 * GATE 4 #1 (roadmap row 38) — REPLAY the gap taxonomy over ARCHIVED sessions.
 *
 * Source: `fnf_market_snapshots_history` daily rows, one bar per session (stamped 09:15 IST in
 * the historical series), intraday rows for recent sessions. The bar is picked per session by
 * the WIDEST high-low span (then earliest timestamp) — the same rule the adapter enforces.
 *
 * TWO MEASURED FACTS DRIVE THE INPUT MODEL (both verified 2026-09-12 against independent data):
 *   1. the feed's `close` column is the broker's PREVIOUS close, not the session's own close
 *      (the 2026-09-11 row quotes 23477.80 = the index tape's 2026-09-10 close, and
 *      NIFTYBANK quotes 56471.90 vs tape 56471.95), so the adapter takes close(S) from the
 *      NEXT session's quote and marks the newest session INCOMPLETE rather than guessing;
 *   2. sessions are labelled by the broker `ts` (IST) inside the market window — NOT by
 *      createdAt, which carries over past midnight (rows written at 00:xx–02:xx IST re-state
 *      the previous session's bar).
 *
 * Usage: node scripts/gap-taxonomy-replay.js [--instrument NSE:NIFTY50-INDEX] [--recent 120] [--disabled]
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mysql = require('mysql2/promise');

const ROOT = path.join(__dirname, '..');
const SERIES = require(path.join(ROOT, 'dist', 'trading', 'gap-engine', 'gap-session-series'));
const TAX = require(path.join(ROOT, 'dist', 'trading', 'gap-engine', 'gap-taxonomy'));

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
  const recent = Number(argOf('recent', '120'));
  const db = await mysql.createConnection({
    host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT || 3307),
    user: env.MYSQL_USER, password: env.MYSQL_PASSWORD, database: 'myjob_agent', connectTimeout: 12000,
  });

  // one bar per session: widest span wins, earliest timestamp breaks the tie
  const [rows] = await db.query(
    `WITH bars AS (
       SELECT DATE_FORMAT(\`ts\`,'%Y-%m-%d') AS d,
              \`open\` AS o, high AS h, low AS l, \`close\` AS c,
              DATE_FORMAT(\`ts\`,'%Y-%m-%d %H:%i:%s') AS src,
              ROW_NUMBER() OVER (PARTITION BY DATE(\`ts\`) ORDER BY (high - low) DESC, \`ts\` ASC) AS rn
       FROM fnf_market_snapshots_history
       WHERE instrument = ? AND TIME(\`ts\`) BETWEEN '09:15:00' AND '15:30:00'
     ) SELECT d, o, h, l, c, src FROM bars WHERE rn = 1 ORDER BY d ASC`, [instrument]);

  const rawBars = rows.map((r) => ({
    instrument,
    sessionDate: String(r.d),
    open: Number(r.o), high: Number(r.h), low: Number(r.l), quotedClose: Number(r.c),
    sourceId: String(r.src),
  }));

  const series = SERIES.buildSessionSeries(instrument, rawBars);
  const disabled = hasFlag('disabled');
  const result = TAX.assessGapSeries(series.sessions, disabled ? { enabled: false } : {});

  console.log(`instrument      : ${instrument}`);
  console.log(`raw rows (1/session, widest bar): ${rawBars.length}`);
  console.log(`series          : ${series.coverage.sessionsOut} sessions  ${series.coverage.firstSession} .. ${series.coverage.lastSession}`);
  console.log(`                  complete=${series.coverage.completeSessions} closed=${series.coverage.closedSessions} excluded=${series.exclusions.length}`);
  if (series.exclusions.length) console.log(`exclusions      : ${JSON.stringify(series.exclusions.slice(0, 4))}`);
  console.log(`taxonomy        : ${result.version} enabled=${result.enabled}`);
  console.log(`reviewer        : ${result.reviewerSummary}`);
  console.log(`coverage        : ${JSON.stringify(result.coverage)}`);
  console.log(`class counts    : ${JSON.stringify(result.counts)}`);

  if (disabled) {
    console.log('\nDISABLED PATH: no assessment was computed (the switch is independent of every other argument).');
    await db.end();
    return;
  }

  // integrity: does the previous session's own row agree with the close quoted on the next row?
  const ok2 = result.assessments.filter((a) => a.measures.prevCloseAgrees === 1).length;
  const mismatch = result.assessments.filter((a) => a.measures.prevCloseAgrees === 0).length;
  const unknown = result.assessments.filter((a) => a.measures.prevCloseAgrees === null).length;
  console.log(`integrity       : prevClose agrees=${ok2} mismatch=${mismatch} unknown=${unknown}`);
  if (mismatch) {
    const sample = result.assessments.filter((a) => a.measures.prevCloseAgrees === 0).slice(0, 3);
    for (const a of sample) console.log(`   mismatch ${a.sessionDate}: quoted ${a.measures.prevClose} vs prior-row close ${a.measures.prevCloseFromPriorSession}`);
  }

  const tail = result.assessments.slice(-Math.min(recent, result.assessments.length));
  console.log(`\n=== last ${tail.length} assessed sessions ===`);
  console.log('  date        class                  dir   gap%     ratio   fill      zone');
  for (const a of tail) {
    if (a.status !== 'OK') {
      console.log(`  ${a.sessionDate}  UNAVAILABLE (${a.reason})`);
      continue;
    }
    console.log(
      `  ${a.sessionDate}  ${String(a.class).padEnd(22)} ${String(a.direction).padEnd(5)} ` +
      `${a.gapPct === null ? '-' : a.gapPct.toFixed(2).padStart(6)}  ${a.gapRatio === null ? '-' : a.gapRatio.toFixed(2).padStart(6)}  ` +
      `${String(a.fillState).padEnd(9)} ${a.zone ? `${a.zone.low.toFixed(1)}..${a.zone.high.toFixed(1)}` : '-'}`,
    );
  }

  const interactions = result.assessments.filter((a) => a.olderGapInteraction.sessionDates.length);
  console.log(`\nolder-open-gap interactions: ${interactions.length} session(s)`);
  for (const a of interactions.slice(-5)) console.log(`  ${a.sessionDate} -> entered ${a.olderGapInteraction.sessionDates.join(', ')}`);

  const digestHash = crypto.createHash('sha256').update(result.digest).digest('hex').slice(0, 16);
  console.log(`\nREPLAY_DIGEST_SHA256 ${digestHash}  (assessments ${result.assessments.length}, digest ${result.digest.length} chars)`);
  await db.end();
})().catch((e) => { console.error('REPLAY FAILED', e.code || '', e.message || '', e.sqlMessage ? `\n  sql: ${e.sqlMessage}` : ''); process.exit(1); });
