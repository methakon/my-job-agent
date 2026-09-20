/**
 * Item 111: Record spread, slippage, fill probability and quote age
 */
const { getConnection, markDone } = require('./db');

(async () => {
  const conn = await getConnection();
  try {
    console.log('=== Item 111: Spread, Slippage, Fill Probability, Quote Age ===\n');

    const [busyDay] = await conn.query(`
      SELECT DATE(ts) as d, COUNT(*) as cnt
      FROM unified_option_quotes_history
      WHERE ts >= '2026-09-10' AND HOUR(ts) BETWEEN 9 AND 16
      GROUP BY d ORDER BY cnt DESC LIMIT 1
    `);

    const dayStr = busyDay[0]?.d?.toISOString().slice(0, 10);
    console.log(`Analyzing busiest day: ${dayStr} (${busyDay[0]?.cnt} quotes)\n`);

    const [spreadStats] = await conn.query(`
      SELECT
        COUNT(*) as total,
        AVG(ask - bid) as avg_spread,
        STDDEV(ask - bid) as std_spread,
        AVG(CASE WHEN ask > 0 AND bid > 0 THEN (ask - bid) / ((ask + bid)/2) * 100 ELSE NULL END) as avg_spread_pct,
        AVG(ABS(ltp - (ask + bid)/2)) as avg_slippage,
        AVG(CASE WHEN ask > 0 AND bid > 0 THEN ABS(ltp - (ask + bid)/2) / ((ask + bid)/2) * 100 ELSE NULL END) as avg_slippage_pct,
        SUM(CASE WHEN ask - bid <= 0.1 THEN 1 ELSE 0 END) as tight_spread_count,
        SUM(CASE WHEN ask - bid > 0.5 THEN 1 ELSE 0 END) as wide_spread_count
      FROM unified_option_quotes_history
      WHERE DATE(ts) = ? AND HOUR(ts) BETWEEN 9 AND 16
        AND ask > 0 AND bid > 0
    `, [dayStr]);

    const s = spreadStats[0];
    console.log(`Total quotes: ${s.total}`);
    console.log(`Avg spread: ₹${Number(s.avg_spread||0).toFixed(2)} (${Number(s.avg_spread_pct||0).toFixed(3)}%)`);
    console.log(`Std spread: ₹${Number(s.std_spread||0).toFixed(2)}`);
    console.log(`Tight (≤₹0.10): ${s.tight_spread_count} (${(s.tight_spread_count/s.total*100).toFixed(1)}%)`);
    console.log(`Wide (>₹0.50): ${s.wide_spread_count} (${(s.wide_spread_count/s.total*100).toFixed(1)}%)`);
    console.log(`Avg slippage from mid: ₹${Number(s.avg_slippage||0).toFixed(3)} (${Number(s.avg_slippage_pct||0).toFixed(3)}%)`);

    const [fillProbs] = await conn.query(`
      SELECT
        CASE
          WHEN (ask - bid) / ((ask + bid)/2) * 100 < 0.5 THEN 'HIGH_FILL'
          WHEN (ask - bid) / ((ask + bid)/2) * 100 < 2.0 THEN 'MEDIUM_FILL'
          ELSE 'LOW_FILL'
        END as fill_category,
        COUNT(*) as cnt, AVG(volume) as avg_vol, AVG(oi) as avg_oi
      FROM unified_option_quotes_history
      WHERE DATE(ts) = ? AND HOUR(ts) BETWEEN 9 AND 16 AND ask > 0 AND bid > 0
      GROUP BY fill_category
    `, [dayStr]);

    console.log(`\n--- Fill Probability ---`);
    for (const f of fillProbs) {
      console.log(`  ${f.fill_category}: ${f.cnt} (${(f.cnt/s.total*100).toFixed(1)}%) avg_vol=${Number(f.avg_vol||0).toFixed(0)} avg_oi=${Number(f.avg_oi||0).toFixed(0)}`);
    }

    // Quote freshness (simple approach)
    const [freshnessSimple] = await conn.query(`
      SELECT AVG(next_ts - ts) as avg_gap_sec, MIN(next_ts - ts) as min_gap_sec, MAX(next_ts - ts) as max_gap_sec
      FROM (
        SELECT ts,
          (SELECT MIN(ts) FROM unified_option_quotes_history b
           WHERE b.instrumentKey = a.instrumentKey AND b.ts > a.ts
           AND DATE(b.ts) = ? AND HOUR(b.ts) BETWEEN 9 AND 16) as next_ts
        FROM unified_option_quotes_history a
        WHERE DATE(ts) = ? AND HOUR(ts) BETWEEN 9 AND 16
          AND instrumentKey LIKE 'NSE:NIFTY%' LIMIT 500
      ) sub WHERE next_ts IS NOT NULL
    `, [dayStr, dayStr]);

    console.log(`\n--- Quote Freshness ---`);
    if (freshnessSimple[0]?.avg_gap_sec) {
      console.log(`Avg gap between quotes: ${Number(freshnessSimple[0].avg_gap_sec).toFixed(1)}s`);
      console.log(`Min: ${freshnessSimple[0].min_gap_sec}s, Max: ${freshnessSimple[0].max_gap_sec}s`);
    }

    const [crossDay] = await conn.query(`
      SELECT DATE(ts) as d,
        AVG(ask - bid) as avg_spread,
        AVG(CASE WHEN ask > 0 AND bid > 0 THEN (ask-bid)/((ask+bid)/2)*100 ELSE NULL END) as spread_pct,
        COUNT(*) as cnt
      FROM unified_option_quotes_history
      WHERE ts >= '2026-09-10' AND HOUR(ts) BETWEEN 9 AND 16 AND ask > 0 AND bid > 0
      GROUP BY d ORDER BY d
    `);

    console.log(`\n--- Cross-Day Spread ---`);
    for (const r of crossDay) {
      console.log(`  ${r.d.toISOString().slice(0,10)}: ₹${Number(r.avg_spread||0).toFixed(2)} (${Number(r.spread_pct||0).toFixed(3)}%) n=${r.cnt}`);
    }

    await markDone(111, `Spread/slippage/fill-prob/quote-age recorded for ${s.total} quotes on busiest day + cross-day summary for ${crossDay.length} days.`);
  } finally { await conn.end(); }
})();
