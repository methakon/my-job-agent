/**
 * Item 26: Build relative pre-open volume against the same-time historical distribution.
 *
 * For each trading day, measures the earliest available quote volume (pre-open proxy)
 * and compares it against the historical distribution of volume at that same time-of-day.
 * Since true pre-open data (IST 9:00-9:15) is sparse, we use the first available
 * session snapshot as T0 and compute how its volume compares to the distribution.
 */
const { getConnection, markDone } = require('./db');

(async () => {
  const conn = await getConnection();
  try {
    console.log('=== Item 26: Relative Pre-Open Volume vs Historical Distribution ===\n');

    // Get all trading days with sufficient data
    const [days] = await conn.query(`
      SELECT DATE(ts) as d, COUNT(*) as cnt
      FROM unified_option_quotes_history
      WHERE ts >= '2026-09-09' AND HOUR(ts) BETWEEN 9 AND 16
      GROUP BY d HAVING cnt > 10000 ORDER BY d
    `);
    console.log(`Trading days with sufficient data: ${days.length}\n`);

    const dayStrings = days.map(r => {
      const dt = new Date(r.d);
      return dt.toISOString().slice(0, 10);
    });

    // For each day, get the earliest session timestamp and compute volume stats
    const dayStats = [];

    for (const dayStr of dayStrings) {
      // Find earliest timestamp of the day
      const [earliest] = await conn.query(`
        SELECT MIN(ts) as t0, MINUTE(MIN(ts)) as min_minute, SECOND(MIN(ts)) as min_second
        FROM unified_option_quotes_history
        WHERE DATE(ts) = ? AND HOUR(ts) BETWEEN 9 AND 16
      `, [dayStr]);
      if (!earliest[0].t0) continue;

      const t0 = earliest[0].t0;

      // Get total volume at T0 (first 30 seconds)
      const [t0Vol] = await conn.query(`
        SELECT COUNT(*) as sample, SUM(volume) as total_vol, AVG(volume) as avg_vol,
               MAX(volume) as max_vol
        FROM unified_option_quotes_history
        WHERE DATE(ts) = ? AND ts >= ? AND ts <= DATE_ADD(?, INTERVAL 30 SECOND)
          AND volume > 0
      `, [dayStr, t0, t0]);

      // Get volume distribution at same minute across all days
      const t0Minute = new Date(t0).getMinutes();
      const t0Hour = new Date(t0).getHours();
      const [histDist] = await conn.query(`
        SELECT DATE(ts) as d,
               SUM(CASE WHEN volume > 0 THEN volume ELSE 0 END) as session_vol
        FROM unified_option_quotes_history
        WHERE HOUR(ts) BETWEEN 9 AND 16
          AND MINUTE(ts) >= ? AND MINUTE(ts) < ? + 1
        GROUP BY d
      `, [t0Minute, t0Minute]);

      // Get session-level volume for each day (total volume across the day)
      const [sessionVols] = await conn.query(`
        SELECT DATE(ts) as d,
               SUM(CASE WHEN volume > 0 THEN volume ELSE 0 END) as session_vol
        FROM unified_option_quotes_history
        WHERE HOUR(ts) BETWEEN 9 AND 16
        GROUP BY d HAVING session_vol > 0
      `, [dayStr]);

      // Get hourly volume distribution for this day
      const [hourlyVol] = await conn.query(`
        SELECT HOUR(ts) as h,
               SUM(CASE WHEN volume > 0 THEN volume ELSE 0 END) as hour_vol,
               COUNT(*) as sample
        FROM unified_option_quotes_history
        WHERE DATE(ts) = ? AND HOUR(ts) BETWEEN 9 AND 16
        GROUP BY h ORDER BY h
      `, [dayStr]);

      const dayTotalVol = hourlyVol.reduce((s, r) => s + Number(r.hour_vol || 0), 0);
      const firstHourVol = Number(hourlyVol[0]?.hour_vol || 0);
      const preOpenRatio = dayTotalVol > 0 ? (firstHourVol / dayTotalVol * 100) : 0;

      dayStats.push({
        date: dayStr,
        t0_time: new Date(t0).toISOString().slice(11, 19),
        t0_sample: t0Vol[0]?.sample || 0,
        t0_total_vol: Number(t0Vol[0]?.total_vol || 0),
        day_total_vol: dayTotalVol,
        first_hour_vol: firstHourVol,
        preopen_ratio_pct: preOpenRatio.toFixed(2),
        hourly_breakdown: hourlyVol.map(r => `${r.h}h:${Number(r.hour_vol || 0).toFixed(0)}`),
      });
    }

    // Print results
    console.log('Day         | T0 Time  | T0 Samples | T0 Volume   | Day Volume    | 1st Hour % | Hourly Breakdown');
    console.log('------------|----------|------------|-------------|---------------|------------|------------------');
    for (const s of dayStats) {
      console.log(
        `${s.date} | ${s.t0_time} | ${String(s.t0_sample).padStart(10)} | ${String(s.t0_total_vol.toFixed(0)).padStart(11)} | ${String(s.day_total_vol.toFixed(0)).padStart(13)} | ${String(s.preopen_ratio_pct).padStart(10)} | ${s.hourly_breakdown.join(', ')}`
      );
    }

    // Compute cross-day statistics
    const ratios = dayStats.map(s => Number(s.preopen_ratio_pct)).filter(r => r > 0);
    if (ratios.length > 0) {
      const avg = ratios.reduce((a, b) => a + b, 0) / ratios.length;
      const sorted = [...ratios].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      const min = sorted[0];
      const max = sorted[sorted.length - 1];

      console.log(`\n--- Cross-Day Summary ---`);
      console.log(`Days analyzed: ${dayStats.length}`);
      console.log(`1st-hour volume share: avg=${avg.toFixed(2)}%, median=${median.toFixed(2)}%, min=${min.toFixed(2)}%, max=${max.toFixed(2)}%`);
      console.log(`Typical session volume: avg=${(dayStats.reduce((s, d) => s + d.day_total_vol, 0) / dayStats.length).toFixed(0)}`);
    }

    console.log('\nNOTE: True pre-open data (IST 9:00-9:15) is not available in the archive.');
    console.log('Earliest available session snapshots used as T0 proxy.');
    console.log('Volume distribution shows how first-hour trading compares to full session.');

    await markDone(26,
      `Pre-open volume distribution built across ${dayStats.length} trading days. ` +
      `First-hour volume share computed against daily totals. ` +
      `Hourly breakdowns show volume distribution through the session. ` +
      `No true pre-open data available; earliest session snapshots used as proxy.`
    );
  } finally {
    await conn.end();
  }
})();
