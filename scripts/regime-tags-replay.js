#!/usr/bin/env node
/**
 * ROW 123 — GATE 10 #1 regime tags: replay over the RECORDED archive.
 *
 * Demonstrates the behaviour on real data and reports sample size/coverage:
 *  1. coverage — how often each tag family resolves, and the per-instrument split
 *  2. distribution of every tag
 *  3. do the tags actually separate outcomes? (gap-fill rate and |close−open| per tag, with n)
 *  4. real-data leakage check — zeroing every session AFTER t must not move the regime entering t
 *  5. reproducibility — two runs, identical digest
 * Read-only. No writes, no production imports beyond the isolated build.
 */
require('/home/swarna-sekhar-dhar/projects/my-job-agent/node_modules/dotenv').config({
  path: '/home/swarna-sekhar-dhar/projects/my-job-agent/.env', override: true,
});
const path = require('node:path');
const crypto = require('node:crypto');
const mysql = require('/home/swarna-sekhar-dhar/projects/my-job-agent/node_modules/mysql2/promise');
const M = require(process.env.REGIME_TAGS_JS || path.join(__dirname, '..', 'dist', 'trading', 'regime', 'regime-tags'));

const INSTRUMENTS = ['NSE:NIFTY50-INDEX', 'NSE:NIFTYBANK-INDEX', 'NSE:SENSEX-INDEX'];
const pct = (n, d = 1) => (n === null ? 'NA' : (n * 100).toFixed(d) + '%');
const f = (n, d = 4) => (n === null || Number.isNaN(n) ? 'NA' : Number(n).toFixed(d));
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);

const lines = [];
const say = (s) => { lines.push(s); console.log(s); };

(async () => {
  const conn = await mysql.createConnection({ host: process.env.MYSQL_HOST, port: Number(process.env.MYSQL_PORT || 3307), user: process.env.MYSQL_USER, password: process.env.MYSQL_PASSWORD, database: process.env.DATABASE_NAME || 'myjob_agent' });
  const load = async (instrument) => (await conn.query(
    `SELECT DATE_FORMAT(ts,'%Y-%m-%d') d, open, high, low, close, volume FROM fnf_market_snapshots_history
     WHERE source IS NULL AND instrument = ? AND ts < '2026-01-01' AND high > low AND close > 0 AND open > 0
     ORDER BY ts`, [instrument]))[0];

  const tag = (bars, t) => M.regimeEntering({
    priorSessions: bars.slice(0, t).map((b) => ({ sessionDate: b.sessionDate, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume })),
    open: bars[t].open,
  });

  const families = ['trend', 'range', 'volatility', 'liquidity', 'openingState'];
  const counts = {}; for (const fam of families) counts[fam] = {};
  const perInstrument = {};
  const outcomeAgg = {}; // family -> tag -> {n, fill, absret}
  const digest = crypto.createHash('sha256');
  let total = 0;
  const leakageChecks = [];

  for (const instrument of INSTRUMENTS) {
    const rows = await load(instrument);
    const bars = rows.map((r) => ({ sessionDate: String(r.d).slice(0, 10), open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close), volume: r.volume === null ? null : Number(r.volume) }));
    let tagged = 0, resolved = 0;
    for (let t = 1; t < bars.length; t++) {
      const res = tag(bars, t);
      total += 1;
      tagged += 1;
      if (families.every((fam) => res[fam] !== 'UNKNOWN')) resolved += 1;
      for (const fam of families) counts[fam][res[fam]] = (counts[fam][res[fam]] || 0) + 1;
      digest.update(`${instrument}|${bars[t].sessionDate}|${families.map((fam) => res[fam]).join(',')}|${res.context.gapAtr === null ? 'NA' : res.context.gapAtr.toFixed(6)}\n`);

      // outcomes, for the "do the tags separate anything" question
      const prevClose = bars[t - 1].close;
      const fill = bars[t].low <= prevClose && bars[t].high >= prevClose ? 1 : 0;
      const absret = Math.abs((bars[t].close - bars[t].open) / bars[t].open);
      for (const fam of families) {
        const k = res[fam];
        outcomeAgg[fam] = outcomeAgg[fam] || {};
        outcomeAgg[fam][k] = outcomeAgg[fam][k] || { n: 0, fill: 0, absret: 0 };
        outcomeAgg[fam][k].n += 1; outcomeAgg[fam][k].fill += fill; outcomeAgg[fam][k].absret += absret;
      }
      if (t === 300) {
        const zeros = bars.map((b, i) => (i > t ? { ...b, open: 0, high: 0, low: 0, close: 0, volume: 0 } : b));
        leakageChecks.push(JSON.stringify(tag(bars, t)) === JSON.stringify(tag(zeros, t)));
      }
    }
    perInstrument[instrument] = { sessions: tagged, fullyResolved: resolved, coverage: resolved / tagged };
  }

  say('=== 1. coverage over the recorded daily archive (2021-08 → 2025-12) ===');
  for (const [inst, c] of Object.entries(perInstrument)) say(`${inst.padEnd(20)} sessions tagged=${c.sessions}  all five tags resolved=${c.fullyResolved} (${pct(c.coverage)})`);
  say(`TOTAL sessions tagged: ${total}`);
  say('\nper-family resolution:');
  for (const fam of families) {
    const unknown = counts[fam].UNKNOWN || 0;
    say(`  ${fam.padEnd(13)} resolved ${pct((total - unknown) / total)}  unknown=${unknown}  -> ${Object.entries(counts[fam]).filter(([k]) => k !== 'UNKNOWN').map(([k, v]) => `${k}=${v}`).join(' ')}`);
  }

  say('\n=== 2. tag distribution (all instruments) ===');
  for (const fam of families) say(`${fam.padEnd(13)} ` + Object.entries(counts[fam]).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}(${pct(v / total)})`).join('  '));

  say('\n=== 3. do the tags separate outcomes? (gap-fill rate | mean |close-open|, with n) ===');
  for (const fam of ['volatility', 'range', 'liquidity', 'openingState', 'trend']) {
    const rows = Object.entries(outcomeAgg[fam]).filter(([k]) => k !== 'UNKNOWN').map(([k, v]) => ({ k, n: v.n, fill: v.fill / v.n, absret: v.absret / v.n }));
    const fills = rows.map((r) => r.fill), rets = rows.map((r) => r.absret);
    say(`${fam}:`);
    for (const r of rows) say(`    ${r.k.padEnd(15)} n=${String(r.n).padEnd(5)} gapFill=${pct(r.fill)}  mean|ret|=${f(r.absret)}`);
    say(`    spread across tags: gapFill ${pct(Math.max(...fills) - Math.min(...fills))}   mean|ret| ${f(Math.max(...rets) - Math.min(...rets))} (larger = the tag separates outcomes)`);
  }

  say('\n=== 4. real-data leakage check ===');
  const leakOk = leakageChecks.every(Boolean);
  say(`zeroing every session AFTER t (t=300) leaves the regime entering t identical: ${leakOk ? 'PASS' : 'FAIL'} (${leakageChecks.length}/${INSTRUMENTS.length} instruments)`);

  // reproducibility
  const d1 = digest.digest('hex').slice(0, 16);
  const digest2 = crypto.createHash('sha256');
  for (const instrument of INSTRUMENTS) {
    const rows = await load(instrument);
    const bars = rows.map((r) => ({ sessionDate: String(r.d).slice(0, 10), open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close), volume: r.volume === null ? null : Number(r.volume) }));
    for (let t = 1; t < bars.length; t++) {
      const res = tag(bars, t);
      digest2.update(`${instrument}|${bars[t].sessionDate}|${families.map((fam) => res[fam]).join(',')}|${res.context.gapAtr === null ? 'NA' : res.context.gapAtr.toFixed(6)}\n`);
    }
  }
  const d2 = digest2.digest('hex').slice(0, 16);
  say(`\n=== 5. reproducibility ===\ndigest run 1 = ${d1}\ndigest run 2 = ${d2}\nidentical: ${d1 === d2 ? 'PASS' : 'FAIL'}`);

  say('\nNOTE — data limitations, not inferred behaviour:');
  say('  * liquidity is a PROXY from recorded session volume; this archive has no order book, bid/ask size or trade tape.');
  say('  * every tag is computed from sessions STRICTLY BEFORE t plus t\'s own open, so nothing after 09:15 on t is used.');

  await conn.end();
  require('node:fs').writeFileSync(process.env.COMMANDCODE_SCRATCHPAD + '/regime-tags-replay.txt', lines.join('\n'));
})().catch((e) => { console.error('REGIME REPLAY FAILED', e); process.exit(1); });
