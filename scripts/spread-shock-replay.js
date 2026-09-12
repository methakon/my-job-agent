#!/usr/bin/env node
/**
 * GATE 5 #5 (roadmap row 54) — replay spread and spread shock over the ARCHIVE.
 *
 * For one market session it computes each canonical quote's spread and its shock against the median spread of
 * that instrument's PRIOR quotes in the same session, reporting the SAMPLE SIZE and coverage behind the
 * numbers (the row's doneWhen). Descriptive evidence only — nothing is selected, ranked or tuned.
 *
 * BASIS NOTE: FYERS arrives over a WebSocket (EVENT) and Upstox is REST-polled (SNAPSHOT); the basis is
 * recorded per row and never presented as the other.
 *
 * usage: node scripts/spread-shock-replay.js [--date 2026-09-11] [--limit 20000] [--samples 6]
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mysql = require('mysql2/promise');

const ROOT = path.join(__dirname, '..');
const M = require(path.join(ROOT, 'dist', 'trading', 'microstructure', 'spread-shock'));

const env = {};
for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const argv = process.argv.slice(2);
const argOf = (name, dflt) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt; };

(async () => {
  const date = argOf('date', '2026-09-11');
  const limit = Number(argOf('limit', '20000'));
  const samples = Number(argOf('samples', '6'));
  const db = await mysql.createConnection({
    host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT || 3307),
    user: env.MYSQL_USER, password: env.MYSQL_PASSWORD, database: 'myjob_agent', connectTimeout: 20000,
  });
  const [rows] = await db.query(
    "SELECT instrumentKey, source, DATE_FORMAT(ts,'%Y-%m-%d') AS sessionDate, bid, ask, sourceTimestamp, receivedTimestamp, sequenceNumber, dataQuality " +
    'FROM unified_option_quotes WHERE ts >= ? AND ts < ? AND bid IS NOT NULL AND ask IS NOT NULL ORDER BY ts ASC LIMIT ?',
    [`${date} 09:15:00`, `${date} 15:30:00`, limit],
  );
  await db.end();

  const quotes = rows.map((r) => ({
    instrumentKey: r.instrumentKey, source: r.source, sessionDate: r.sessionDate,
    basis: r.source === 'FYERS_LIVE' ? 'EVENT' : 'SNAPSHOT',
    bid: Number(r.bid), ask: Number(r.ask),
    sourceTimestamp: r.sourceTimestamp, receivedTimestamp: r.receivedTimestamp,
    sequenceNumber: r.sequenceNumber === null ? null : Number(r.sequenceNumber), dataQuality: r.dataQuality ?? null,
  }));
  const rep = M.evaluateSpreadShock(quotes, {});
  const c = rep.coverage;

  console.log(`\n=== row 54 spread + spread-shock replay — canonical unified_option_quotes, ${date} 09:15-15:30 IST ===`);
  console.log(`feature   : ${rep.version}`);
  console.log(`reviewer  : ${rep.reviewerSummary}`);
  console.log(`\nSAMPLE SIZE: ${c.ok} spread(s), of which ${c.withShock} carry a shock against a baseline`);
  console.log(`coverage   : quotesIn=${c.quotesIn} ok=${c.ok} unavailable=${c.unavailable} withShock=${c.withShock} sessions=${c.sessions} instruments=${c.instruments}`);
  console.log(`refusals   : ${JSON.stringify(rep.refusalCounts)}`);
  console.log(`shock gaps : ${JSON.stringify(rep.shockReasonCounts)}  (INSUFFICIENT_BASELINE = fewer than 5 prior quotes; NO_TIMESTAMP = unorderable)`);
  console.log(`\nspreadShockRatio distribution [descriptive, ${c.withShock} value(s)]:`);
  for (const b of rep.shockRatioBins) console.log(`  ${b.label.padEnd(8)}  ${String(b.n).padStart(6)}  ${c.withShock ? ((b.n / c.withShock) * 100).toFixed(1) + '%' : 'n/a'}`);

  const shocked = rep.observations.filter((o) => o.shock);
  console.log(`\nfirst ${Math.min(samples, shocked.length)} shocked quote(s):`);
  for (const o of shocked.slice(0, samples)) {
    console.log(`  ${o.sessionDate} ${o.instrumentKey}  ${o.source}/${o.basis}  spread=${o.values.spread} (baseline ${o.shock.baselineSpread} of ${o.shock.baselineCount})  shockAbs=${o.shock.spreadShockAbs}  ratio=${o.shock.spreadShockRatio}`);
  }

  const digest = crypto.createHash('sha256').update(rep.digest).digest('hex').slice(0, 16);
  console.log(`\nREPLAY_DIGEST_SHA256 ${digest}`);
  console.log('NOTE: the baseline is the median of the PRIOR quotes only (no look-ahead); the shock is reported');
  console.log('      as a ratio and a difference with no significance threshold, and provenance is echoed verbatim.');
})().catch((e) => {
  console.error('REPLAY FAILED', e.code || '', e.message || '', e.sqlMessage ? `\n  sql: ${e.sqlMessage}` : '');
  process.exit(1);
});
