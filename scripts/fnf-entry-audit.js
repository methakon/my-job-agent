#!/usr/bin/env node
/**
 * FNF entry provenance audit — answers "who opened the /fnf-trading trades, and
 * how?" from the engine DB rather than from the code path we assume is running.
 *
 * Read-only. Prints, in order:
 *   1. which hosts hold connections to the engine DB (a writer elsewhere shows up)
 *   2. every fnf_trades row with its provenance columns (algoSource/openedBy)
 *   3. duplicate trade groups and duplicated journal seconds (double-entry)
 *   4. the journal's action families + the newest cycles
 *   5. fnf_portfolios flags (autoTradeEnabled is what the session driver reads)
 *   6. market_data_feed_leases (which process owns the live feed)
 *
 * Usage: node scripts/fnf-entry-audit.js
 */
const path = require('path');
const ROOT = path.join(__dirname, '..');
require(path.join(ROOT, 'node_modules/dotenv')).config({ path: path.join(ROOT, '.env') });
const mysql = require(path.join(ROOT, 'node_modules/mysql2/promise'));

const iso = (v) => (v instanceof Date ? v.toISOString() : v);
const q = async (c, sql, fallback = []) => {
  try { const [rows] = await c.query(sql); return rows; } catch (e) { console.log(`  (query failed: ${e.message})`); return fallback; }
};

(async () => {
  const c = await mysql.createConnection({
    host: process.env.MYSQL_HOST, port: Number(process.env.MYSQL_PORT),
    user: process.env.MYSQL_USER, password: process.env.MYSQL_PASSWORD,
    database: process.env.LOCAL_DB_NAME || process.env.MYSQL_DATABASE,
  });

  console.log('=== 1. DB clock + connected hosts ===');
  const [clock] = await q(c, `SELECT NOW() AS db_now, UTC_TIMESTAMP() AS db_utc, @@session.time_zone AS tz`);
  console.log(`  db NOW()=${iso(clock?.db_now)} UTC_TIMESTAMP()=${iso(clock?.db_utc)} tz=${clock?.tz} | local host now=${new Date().toISOString()}`);
  const pl = await q(c, `SHOW FULL PROCESSLIST`);
  const hosts = {};
  for (const p of pl) hosts[p.Host] = (hosts[p.Host] || 0) + 1;
  console.log(`  ${pl.length} connections: ${Object.entries(hosts).map(([h, n]) => `${n}x ${h}`).join(', ')}`);

  console.log('=== 2. fnf_trades provenance ===');
  const trades = await q(c, `SELECT id, instrument, side, quantity, entryPrice, exitPrice, netPnl, status,
      algoSource, decisionParams, executionProvider, executionMode, orderedAt, closedAt
      FROM fnf_trades ORDER BY orderedAt ASC`);
  for (const t of trades) {
    let openedBy = '(none)';
    try { openedBy = String(JSON.parse(t.decisionParams ?? '{}').openedBy ?? '(none)'); } catch { /* keep */ }
    console.log(`  ${iso(t.orderedAt)} ${t.status.padEnd(6)} ${t.side} ${t.quantity} ${t.instrument} @ ${t.entryPrice} netPnl=${t.netPnl}`);
    console.log(`     algo=${t.algoSource} openedBy=${openedBy} provider=${t.executionProvider}/${t.executionMode} closedAt=${iso(t.closedAt)}`);
  }
  const [sum] = await q(c, `SELECT COUNT(*) AS n, SUM(CASE WHEN status='CLOSED' THEN netPnl ELSE 0 END) AS closed_net FROM fnf_trades`);
  console.log(`  rows=${sum?.n} closed-only netPnl=${sum?.closed_net}`);

  console.log('=== 3. double-entry evidence ===');
  const dups = await q(c, `SELECT instrument, side, quantity, entryPrice, COUNT(*) AS n, MIN(orderedAt) AS first_at, MAX(orderedAt) AS last_at
      FROM fnf_trades GROUP BY instrument, side, quantity, entryPrice HAVING n > 1`);
  console.log(`  duplicate trade groups: ${dups.length}`);
  for (const d of dups) console.log(`   ${d.instrument} ${d.side} ${d.quantity} @ ${d.entryPrice} x${d.n} ${iso(d.first_at)} → ${iso(d.last_at)}`);
  const [dupSec] = await q(c, `SELECT COUNT(*) AS n FROM (SELECT ts FROM fnf_decision_journal GROUP BY ts HAVING COUNT(*) > 1) t`);
  console.log(`  journal seconds carrying 2 cycles: ${dupSec?.n}`);

  console.log('=== 4. journal (engine cycles) ===');
  for (const r of await q(c, `SELECT actionFamily, COUNT(*) AS n, MIN(ts) AS first_ts, MAX(ts) AS last_ts FROM fnf_decision_journal GROUP BY actionFamily ORDER BY n DESC`)) {
    console.log(`  ${r.actionFamily}: ${r.n} rows, ${iso(r.first_ts)} → ${iso(r.last_ts)}`);
  }
  for (const r of await q(c, `SELECT ts, sessionPhase, actionFamily, winnerSymbol, algoSource FROM fnf_decision_journal ORDER BY ts DESC LIMIT 5`)) {
    console.log(`  newest cycle ${iso(r.ts)} phase=${r.sessionPhase} ${r.actionFamily} ${r.winnerSymbol || ''} (${r.algoSource})`);
  }

  console.log('=== 5. fnf_portfolios ===');
  for (const p of await q(c, `SELECT id, label, capital, ceiling, deployed, netPnl, autoTradeEnabled, fridayTradingEnabled FROM fnf_portfolios`)) {
    console.log(`  ${p.label} (${p.id}) capital=${p.capital} ceiling=${p.ceiling} deployed=${p.deployed} netPnl=${p.netPnl} autoTrade=${p.autoTradeEnabled} friday=${p.fridayTradingEnabled}`);
  }

  console.log('=== 6. feed leases ===');
  const leases = await q(c, `SELECT * FROM market_data_feed_leases`);
  if (!leases.length) console.log('  (none)');
  for (const l of leases) console.log(`  ${l.feedName} state=${l.state} host=${l.host} pid=${l.pid} universes=${l.universes} lastTick=${iso(l.lastTickAt)}`);
  await c.end();
})().catch((e) => { console.error('audit failed:', e.message); process.exit(1); });
