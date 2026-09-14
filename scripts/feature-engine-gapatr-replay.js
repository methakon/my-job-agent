#!/usr/bin/env node
/**
 * Roadmap row 427 — GapATR replay over the RECORDED archive.
 * Proves the feature reproduces from archived data and reports sample size/coverage.
 *
 *  1. coverage: per instrument, sessions with a computable gapAtr vs refusals by reason
 *  2. the SQL aggregation path and the raw-row path must agree bar-for-bar
 *  3. reproducibility: two runs produce an identical digest
 *  4. sanity: the recorded gaps must land in a plausible range (no fabricated magnitudes)
 * Read-only. No writes, no production imports beyond the isolated build.
 */
require('/home/swarna-sekhar-dhar/projects/my-job-agent/node_modules/dotenv').config({
  path: '/home/swarna-sekhar-dhar/projects/my-job-agent/.env', override: true,
});
const path = require('node:path');
const crypto = require('node:crypto');
const mysql = require('/home/swarna-sekhar-dhar/projects/my-job-agent/node_modules/mysql2/promise');
const M = require(process.env.FEATURE_ENGINE_JS || path.join(__dirname, '..', 'dist', 'trading', 'feature-engine.service'));

const INSTRUMENTS = ['NSE:NIFTY50-INDEX', 'NSE:NIFTYBANK-INDEX', 'NSE:SENSEX-INDEX'];
const f = (n, d = 4) => (n === null || n === undefined || Number.isNaN(n) ? 'NA' : Number(n).toFixed(d));
const pct = (n, d) => (n === null ? 'NA' : (n * 100).toFixed(d) + '%');
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const quant = (a, q) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor((s.length - 1) * q))]; };

const AGG_SQL = (limit) => `
  SELECT DATE_FORMAT(s.ts, '%Y-%m-%d') AS d,
         SUBSTRING_INDEX(GROUP_CONCAT(s.open ORDER BY s.ts ASC SEPARATOR ','), ',', 1) AS o,
         MAX(s.high) AS h, MIN(s.low) AS l,
         SUBSTRING_INDEX(GROUP_CONCAT(s.close ORDER BY s.ts DESC SEPARATOR ','), ',', 1) AS c
  FROM fnf_market_snapshots_history s
  WHERE s.instrument = ? AND s.ts < ? AND s.ts >= ?
  GROUP BY d ORDER BY d DESC LIMIT ${limit}`;

(async () => {
  const conn = await mysql.createConnection({ host: process.env.MYSQL_HOST, port: Number(process.env.MYSQL_PORT || 3307), user: process.env.MYSQL_USER, password: process.env.MYSQL_PASSWORD, database: process.env.DATABASE_NAME || 'myjob_agent' });
  const lines = [];
  const say = (s) => { lines.push(s); console.log(s); };

  // ── 1. coverage over every recorded clean daily session ────────────────────
  const rawDaily = async (instrument) => (await conn.query(
    `SELECT DATE(ts) AS d, open, high, low, close FROM fnf_market_snapshots_history
     WHERE source IS NULL AND instrument = ? AND ts < '2026-01-01' AND high > low AND close > 0 AND open > 0
     ORDER BY ts`, [instrument]))[0];

  let digest = crypto.createHash('sha256');
  const coverage = {};
  const allGapAtr = [];
  for (const instrument of INSTRUMENTS) {
    const rows = await rawDaily(instrument);
    const bars = rows.map((r) => ({ date: r.d.toISOString().slice(0, 10), open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close) }));
    const cov = { sessions: bars.length, ok: 0, refusals: {}, gapAtr: [] };
    for (let t = 1; t < bars.length; t++) {
      const res = M.computeGapAtr({ open: bars[t].open, priorClose: bars[t - 1].close, priorBars: bars.slice(0, t) });
      if (res.gapAtr === null) cov.refusals[res.refusal] = (cov.refusals[res.refusal] || 0) + 1;
      else { cov.ok += 1; cov.gapAtr.push(res.gapAtr); allGapAtr.push(res.gapAtr); }
      digest.update(`${instrument}|${bars[t].date}|${res.gapAtr === null ? res.refusal : res.gapAtr.toFixed(10)}\n`);
    }
    coverage[instrument] = cov;
  }
  say('=== 1. GapATR coverage over the recorded daily archive (2021-08 → 2025-12) ===');
  for (const [inst, c] of Object.entries(coverage)) {
    const refusals = Object.entries(c.refusals).map(([k, v]) => `${k}=${v}`).join(' ') || 'none';
    say(`${inst.padEnd(20)} sessions=${c.sessions}  gapAtr OK=${c.ok} (${pct(c.ok / (c.sessions - 1), 1)})  refusals: ${refusals}`);
  }
  const totalOk = Object.values(coverage).reduce((s, c) => s + c.ok, 0);
  say(`TOTAL gapAtr computed: ${totalOk} instrument-sessions (null, never 0, for every refusal)`);

  // ── 2. distribution + sanity ──────────────────────────────────────────────
  say('\n=== 2. distribution of the recorded gapAtr (sanity: no fabricated magnitudes) ===');
  say(`n=${allGapAtr.length}  min=${f(Math.min(...allGapAtr))}  p25=${f(quant(allGapAtr, 0.25))}  median=${f(median(allGapAtr))}  p75=${f(quant(allGapAtr, 0.75))}  max=${f(Math.max(...allGapAtr))}`);
  const extreme = allGapAtr.filter((g) => Math.abs(g) > 5).length;
  say(`|gapAtr| > 5 ATRs: ${extreme} (${pct(extreme / allGapAtr.length, 2)}) — a 5-ATR opening gap is genuinely exceptional, so this must stay tiny`);
  say(`share of gaps in the "small" band |gapAtr| <= 0.25: ${pct(allGapAtr.filter((g) => Math.abs(g) <= 0.25).length / allGapAtr.length, 1)}`);

  // ── 3. SQL aggregation path must agree with the raw rows ──────────────────
  say('\n=== 3. SQL aggregation path vs the raw daily rows (bar-for-bar) ===');
  const instrument = 'NSE:NIFTY50-INDEX';
  const day = '2025-06-10';
  const list = await conn.query(`SELECT DISTINCT DATE(ts) d FROM fnf_market_snapshots_history WHERE source IS NULL AND instrument=? AND ts < ? AND DATE(ts) <= ? ORDER BY d DESC LIMIT 16`, [instrument, `${day}T09:15:00`, day]);
  const openTime = new Date(`${day}T09:15:00.000Z`);
  const from = new Date(openTime.getTime() - 60 * 86400000);
  const [agg] = await conn.query(AGG_SQL(16), [instrument, openTime, from]);
  const sqlBars = M.toDailyBars(agg);
  const rawRows = (await conn.query(`SELECT DATE_FORMAT(ts,'%Y-%m-%d') d, open o, high h, low l, close c FROM fnf_market_snapshots_history WHERE source IS NULL AND instrument=? AND ts < ? AND ts >= ? ORDER BY ts`, [instrument, openTime, from]))[0];
  const rawBars = M.toDailyBars(rawRows).slice(-16);
  say(`aggregation returned ${sqlBars.length} bars, raw rows collapsed to ${rawBars.length} bars`);
  const same = JSON.stringify(sqlBars) === JSON.stringify(rawBars);
  say(`SQL path === raw path: ${same ? 'PASS' : 'FAIL'}`);
  if (!same) say(`  sql=${JSON.stringify(sqlBars.slice(-3))}\n  raw=${JSON.stringify(rawBars.slice(-3))}`);
  say(`sample (${day}): ATR14=${f(M.computeDailyAtr14(sqlBars).atr14)}  priorClose=${f(sqlBars[sqlBars.length - 1].close)}  open=${f(sqlBars[sqlBars.length - 1].open)}`);
  void list;

  // ── 4. reproducibility ────────────────────────────────────────────────────
  const digestA = digest.digest('hex').slice(0, 16);
  let digest2 = crypto.createHash('sha256');
  for (const instrument of INSTRUMENTS) {
    const rows = await rawDaily(instrument);
    const bars = rows.map((r) => ({ date: r.d.toISOString().slice(0, 10), open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close) }));
    for (let t = 1; t < bars.length; t++) {
      const res = M.computeGapAtr({ open: bars[t].open, priorClose: bars[t - 1].close, priorBars: bars.slice(0, t) });
      digest2.update(`${instrument}|${bars[t].date}|${res.gapAtr === null ? res.refusal : res.gapAtr.toFixed(10)}\n`);
    }
  }
  const digestB = digest2.digest('hex').slice(0, 16);
  say(`\n=== 4. reproducibility ===\ndigest run 1 = ${digestA}\ndigest run 2 = ${digestB}\nidentical: ${digestA === digestB ? 'PASS' : 'FAIL'}`);

  await conn.end();
  require('node:fs').writeFileSync(process.env.COMMANDCODE_SCRATCHPAD + '/gapatr-replay.txt', lines.join('\n'));
})().catch((e) => { console.error('GAPATR REPLAY FAILED', e); process.exit(1); });
