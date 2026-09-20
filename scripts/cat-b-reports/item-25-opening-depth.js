/**
 * Item 25: Measure opening depth, spread shock and first 30-60 second flow
 */
const { getConnection, markDone } = require('./db');

(async () => {
  const conn = await getConnection();
  try {
    console.log('=== Item 25: Opening Depth, Spread Shock, First 30-60s Flow ===\n');

    const [dates] = await conn.query(`
      SELECT DATE(ts) as d, COUNT(*) as cnt
      FROM unified_option_quotes_history
      WHERE ts >= '2026-09-10' AND HOUR(ts) BETWEEN 9 AND 16
      GROUP BY d HAVING cnt > 1000 ORDER BY d
    `);

    const results = [];

    for (const { d } of dates) {
      const dayStr = d.toISOString().slice(0, 10);

      const [earliest] = await conn.query(`
        SELECT MIN(ts) as t0 FROM unified_option_quotes_history
        WHERE DATE(ts) = ? AND HOUR(ts) BETWEEN 9 AND 16
      `, [dayStr]);
      if (!earliest[0]?.t0) continue;
      const t0 = earliest[0].t0;

      const [open30] = await conn.query(`
        SELECT COUNT(*) as sample, AVG(ask - bid) as avg_spread,
               AVG(CASE WHEN ask > 0 AND bid > 0 THEN (ask-bid)/((ask+bid)/2)*100 ELSE NULL END) as spread_pct
        FROM unified_option_quotes_history
        WHERE DATE(ts) = ? AND ts >= ? AND ts <= DATE_ADD(?, INTERVAL 30 SECOND)
          AND ask > 0 AND bid > 0
      `, [dayStr, t0, t0]);

      const [open60] = await conn.query(`
        SELECT COUNT(*) as sample, AVG(ask - bid) as avg_spread,
               AVG(CASE WHEN ask > 0 AND bid > 0 THEN (ask-bid)/((ask+bid)/2)*100 ELSE NULL END) as spread_pct
        FROM unified_option_quotes_history
        WHERE DATE(ts) = ? AND ts >= DATE_ADD(?, INTERVAL 30 SECOND)
          AND ts <= DATE_ADD(?, INTERVAL 60 SECOND)
          AND ask > 0 AND bid > 0
      `, [dayStr, t0, t0]);

      const [normal] = await conn.query(`
        SELECT COUNT(*) as sample, AVG(ask - bid) as avg_spread,
               AVG(CASE WHEN ask > 0 AND bid > 0 THEN (ask-bid)/((ask+bid)/2)*100 ELSE NULL END) as spread_pct
        FROM unified_option_quotes_history
        WHERE DATE(ts) = ? AND ts >= DATE_ADD(?, INTERVAL 5 MINUTE)
          AND ts <= DATE_ADD(?, INTERVAL 10 MINUTE)
          AND ask > 0 AND bid > 0
      `, [dayStr, t0, t0]);

      const [vol60] = await conn.query(`
        SELECT SUM(volume) as vol FROM unified_option_quotes_history
        WHERE DATE(ts) = ? AND ts >= ? AND ts <= DATE_ADD(?, INTERVAL 1 MINUTE)
      `, [dayStr, t0, t0]);

      const [vol5m] = await conn.query(`
        SELECT SUM(volume) as vol FROM unified_option_quotes_history
        WHERE DATE(ts) = ? AND ts >= DATE_ADD(?, INTERVAL 1 MINUTE)
          AND ts <= DATE_ADD(?, INTERVAL 6 MINUTE)
      `, [dayStr, t0, t0]);

      const o30s = Number(open30[0]?.avg_spread || 0);
      const o60s = Number(open60[0]?.avg_spread || 0);
      const nrm = Number(normal[0]?.avg_spread || 0);
      const shock = nrm > 0 ? (o30s / nrm).toFixed(2) : 'N/A';

      console.log(`${dayStr}: spread@30s=₹${o30s.toFixed(2)} → @60s=₹${o60s.toFixed(2)} → normal=₹${nrm.toFixed(2)} shock=${shock}x vol60s=${vol60[0]?.vol||0} vol5m=${vol5m[0]?.vol||0}`);
      results.push({ day: dayStr, o30s, o60s, nrm, shock, vol60: vol60[0]?.vol||0, vol5m: vol5m[0]?.vol||0 });
    }

    console.log(`\nReport covers ${results.length} trading days.`);
    console.log('Spread shock ratio > 1.0 means opening spread was wider than normal.');

    await markDone(25, `Opening spread/shock measured across ${results.length} days. 30s/60s spreads, shock ratio vs T+5-10min baseline, first-60s volume flow computed.`);
  } finally { await conn.end(); }
})();
