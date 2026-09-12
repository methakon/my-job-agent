#!/usr/bin/env node
/**
 * GATE 5 #4 (roadmap row 53) — replay microprice + queue imbalance over the ARCHIVE.
 *
 * Loads REAL canonical L1 quotes that carry sizes (source UPSTOX / UPSTOX_LIVE) for one market session and
 * computes the features; a small FYERS sample is included to show the honest NO_SIZES state, because the
 * FYERS rows persist bid/ask WITHOUT sizes. Descriptive evidence only — nothing here selects, ranks or tunes.
 *
 * BASIS NOTE: the Upstox feed is REST-polled (~10-20 s), so these are SNAPSHOTS, not an event stream; the
 * module records that basis and never presents it as event-based order flow.
 *
 * usage: node scripts/micro-imbalance-replay.js [--date 2026-09-11] [--limit 20000] [--samples 8]
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mysql = require('mysql2/promise');

const ROOT = path.join(__dirname, '..');
const M = require(path.join(ROOT, 'dist', 'trading', 'microstructure', 'micro-imbalance'));

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
  const samples = Number(argOf('samples', '8'));
  const db = await mysql.createConnection({
    host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT || 3307),
    user: env.MYSQL_USER, password: env.MYSQL_PASSWORD, database: 'myjob_agent', connectTimeout: 20000,
  });

  const [sized] = await db.query(
    'SELECT instrumentKey, source, bid, ask, bidQty, askQty, sourceTimestamp, receivedTimestamp, sequenceNumber, dataQuality ' +
    'FROM unified_option_quotes WHERE ts >= ? AND ts < ? AND bidQty IS NOT NULL AND askQty IS NOT NULL ORDER BY ts ASC LIMIT ?',
    [`${date} 09:15:00`, `${date} 15:30:00`, limit],
  );
  const [unsized] = await db.query(
    'SELECT instrumentKey, source, bid, ask, bidQty, askQty, sourceTimestamp, receivedTimestamp, sequenceNumber, dataQuality ' +
    'FROM unified_option_quotes WHERE ts >= ? AND ts < ? AND source = ? LIMIT 50',
    [`${date} 09:15:00`, `${date} 15:30:00`, 'FYERS_LIVE'],
  );
  await db.end();

  const toQuote = (r) => ({
    instrumentKey: r.instrumentKey, source: r.source, basis: 'SNAPSHOT',
    bid: r.bid === null ? null : Number(r.bid), ask: r.ask === null ? null : Number(r.ask),
    bidQty: r.bidQty === null ? null : Number(r.bidQty), askQty: r.askQty === null ? null : Number(r.askQty),
    sourceTimestamp: r.sourceTimestamp, receivedTimestamp: r.receivedTimestamp,
    sequenceNumber: r.sequenceNumber === null ? null : Number(r.sequenceNumber), dataQuality: r.dataQuality ?? null,
  });

  const rep = M.evaluateMicroImbalance([...sized.map(toQuote), ...unsized.map(toQuote)], {});
  const c = rep.coverage;

  console.log(`\n=== row 53 microprice + queue-imbalance replay — canonical unified_option_quotes, ${date} 09:15-15:30 IST ===`);
  console.log(`feature   : ${rep.version}`);
  console.log(`reviewer  : ${rep.reviewerSummary}`);
  console.log(`\nSAMPLE SIZE: ${c.ok} quote(s) with a ${rep.version} value`);
  console.log(`coverage   : quotesIn=${c.quotesIn} ok=${c.ok} unavailable=${c.unavailable} withSizes=${c.withSizes} basis=${JSON.stringify(c.byBasis)}`);
  console.log(`refusals   : ${JSON.stringify(rep.refusalCounts)}`);
  const total = rep.queueImbalanceBins.reduce((a, b) => a + b, 0);
  console.log(`\nqueue-imbalance distribution [descriptive, ${total} value(s)] over 10 bins of [-1,+1]:`);
  for (let i = 0; i < rep.queueImbalanceBins.length; i += 1) {
    const lo = (-1 + (i * 2) / 10).toFixed(1);
    const hi = (-1 + ((i + 1) * 2) / 10).toFixed(1);
    const n = rep.queueImbalanceBins[i];
    console.log(`  [${lo}, ${hi})${i === 9 ? ']' : ' '}  ${String(n).padStart(6)}  ${total ? ((n / total) * 100).toFixed(1) + '%' : 'n/a'}`);
  }

  const ok_rows = rep.observations.filter((o) => o.status === 'OK');
  console.log(`\nfirst ${Math.min(samples, ok_rows.length)} valued quote(s):`);
  for (const o of ok_rows.slice(0, samples)) {
    const v = o.values;
    console.log(`  ${o.instrumentKey}  ${o.source}  mid=${v.mid} spread=${v.spread}  microprice=${v.microprice} (offset ${v.micropriceOffsetPoints > 0 ? '+' : ''}${v.micropriceOffsetPoints})  QI=${v.queueImbalance > 0 ? '+' : ''}${v.queueImbalance}`);
  }
  const refused = rep.observations.filter((o) => o.status === 'UNAVAILABLE');
  if (refused.length) {
    const by = {};
    for (const r of refused) by[r.reason] = (by[r.reason] ?? 0) + 1;
    console.log(`\nrefused quote(s) by reason: ${JSON.stringify(by)}  (e.g. ${refused[0].source}: ${refused[0].reason} — ${refused[0].reasonDetail})`);
  }

  const digest = crypto.createHash('sha256').update(rep.digest).digest('hex').slice(0, 16);
  console.log(`\nREPLAY_DIGEST_SHA256 ${digest}`);
  console.log('NOTE: the size-weighted features are a function of ONE quote each — no lookback, no smoothing,');
  console.log('      sizes echoed verbatim, and a size-less quote is refused rather than imputed.');
})().catch((e) => {
  console.error('REPLAY FAILED', e.code || '', e.message || '', e.sqlMessage ? `\n  sql: ${e.sqlMessage}` : '');
  process.exit(1);
});
