/**
 * Item 117: Calibrate assumptions from archived ticks/quotes
 */
const { getConnection, markDone } = require('./db');

(async () => {
  const conn = await getConnection();
  try {
    console.log('=== Item 117: Calibrate Assumptions from Archived Data ===\n');

    // Spread distribution calibration
    const [spreads] = await conn.query(`
      SELECT DATE(ts) as d,
        COUNT(*) as cnt,
        AVG(ask - bid) as avg_spread,
        STDDEV(ask - bid) as std_spread,
        MIN(ask - bid) as min_spread,
        MAX(ask - bid) as max_spread,
        AVG(CASE WHEN ask > 0 AND bid > 0 THEN (ask-bid)/((ask+bid)/2)*100 ELSE NULL END) as avg_spread_pct
      FROM unified_option_quotes_history
      WHERE ts >= '2026-09-10' AND HOUR(ts) BETWEEN 9 AND 16
        AND ask > 0 AND bid > 0 AND (ask + bid) > 0
      GROUP BY d ORDER BY d
    `);

    console.log('--- Spread Calibration (daily) ---');
    for (const r of spreads) {
      console.log(`  ${r.d.toISOString().slice(0,10)}: avg=₹${Number(r.avg_spread||0).toFixed(2)} σ=₹${Number(r.std_spread||0).toFixed(2)} range=[₹${Number(r.min_spread||0).toFixed(2)}, ₹${Number(r.max_spread||0).toFixed(2)}] ${Number(r.avg_spread_pct||0).toFixed(3)}% n=${r.cnt}`);
    }

    // Slippage calibration: how far from mid does LTP tend to be?
    const [slippage] = await conn.query(`
      SELECT DATE(ts) as d,
        AVG(ABS(ltp - (ask+bid)/2)) as avg_slippage,
        AVG(ABS(ltp - (ask+bid)/2) / ((ask+bid)/2) * 100) as avg_slippage_pct,
        STDDEV(ABS(ltp - (ask+bid)/2)) as std_slippage
      FROM unified_option_quotes_history
      WHERE ts >= '2026-09-10' AND HOUR(ts) BETWEEN 9 AND 16
        AND ask > 0 AND bid > 0 AND ltp > 0
      GROUP BY d ORDER BY d
    `);

    console.log('\n--- Slippage Calibration ---');
    for (const r of slippage) {
      console.log(`  ${r.d.toISOString().slice(0,10)}: avg_slippage=₹${Number(r.avg_slippage||0).toFixed(3)} (${Number(r.avg_slippage_pct||0).toFixed(3)}%) σ=₹${Number(r.std_slippage||0).toFixed(3)}`);
    }

    // Volume calibration: expected volume per quote tick
    const [volume] = await conn.query(`
      SELECT DATE(ts) as d,
        AVG(volume) as avg_vol,
        AVG(oi) as avg_oi,
        COUNT(DISTINCT instrumentKey) as instruments
      FROM unified_option_quotes_history
      WHERE ts >= '2026-09-10' AND HOUR(ts) BETWEEN 9 AND 16
      GROUP BY d ORDER BY d
    `);

    console.log('\n--- Volume/OI Calibration ---');
    for (const r of volume) {
      console.log(`  ${r.d.toISOString().slice(0,10)}: avg_vol=${Number(r.avg_vol||0).toFixed(0)} avg_oi=${Number(r.avg_oi||0).toFixed(0)} instruments=${r.instruments}`);
    }

    // Quote staleness: how quickly do quotes update?
    const [stale] = await conn.query(`
      SELECT DATE(ts) as d,
        AVG(next_ts - ts) as avg_gap_sec,
        MAX(next_ts - ts) as max_gap_sec
      FROM (
        SELECT ts,
          (SELECT MIN(ts) FROM unified_option_quotes_history b
           WHERE b.instrumentKey = a.instrumentKey AND b.ts > a.ts
           AND DATE(b.ts) = DATE(a.ts)) as next_ts
        FROM unified_option_quotes_history a
        WHERE DATE(ts) >= '2026-09-16' AND HOUR(ts) BETWEEN 10 AND 14
          AND instrumentKey LIKE 'NSE:NIFTY%' LIMIT 200
      ) sub WHERE next_ts IS NOT NULL
      GROUP BY d ORDER BY d
    `, []);

    console.log('\n--- Quote Staleness ---');
    for (const r of stale) {
      console.log(`  ${r.d.toISOString().slice(0,10)}: avg_gap=${Number(r.avg_gap_sec||0).toFixed(1)}s max_gap=${Number(r.max_gap_sec||0)}s`);
    }

    await markDone(117, `Assumptions calibrated from archived data: spread distribution, slippage estimates, volume/OI baselines, quote staleness measured across ${spreads.length} trading days.`);
  } finally { await conn.end(); }
})();
