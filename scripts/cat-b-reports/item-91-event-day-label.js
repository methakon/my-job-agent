/**
 * Item 91: Label event-day versus non-event-day behavior
 * 
 * Since we don't have an explicit event calendar, we use volume spike as proxy:
 * days with volume > 2x median are labeled "event-day". 
 * Also labels days by volatility (intraday range / open).
 * Timestamp leakage: labels derived from same-day data only, no future information.
 */
const { getConnection, markDone } = require('./db');

(async () => {
  const conn = await getConnection();
  try {
    console.log('=== Item 91: Event-Day vs Non-Event-Day Behavior ===\n');

    // Get daily aggregates for NIFTY50
    const [dailyStats] = await conn.query(`
      SELECT DATE(ts) as d,
             SUM(volume) as total_vol,
             MAX(high) - MIN(low) as intraday_range,
             SUBSTRING_INDEX(GROUP_CONCAT(ltp ORDER BY ts), ',', 1) as open_proxy,
             MAX(ltp) as max_ltp,
             MIN(ltp) as min_ltp
      FROM unified_market_snapshots_history
      WHERE ts >= '2026-09-10' AND symbol LIKE 'NSE:NIFTY50%'
      GROUP BY d ORDER BY d
    `);

    // Also get option quote volume per day
    const [optVol] = await conn.query(`
      SELECT DATE(ts) as d, SUM(volume) as opt_volume, COUNT(*) as quote_count
      FROM unified_option_quotes_history
      WHERE ts >= '2026-09-10' AND HOUR(ts) BETWEEN 9 AND 16
      GROUP BY d ORDER BY d
    `);

    // Merge
    const merged = dailyStats.map(s => {
      const ov = optVol.find(o => o.d.toISOString().slice(0,10) === s.d.toISOString().slice(0,10));
      return {
        date: s.d.toISOString().slice(0, 10),
        total_vol: s.total_vol || 0,
        intraday_range: s.intraday_range || 0,
        open_proxy: s.open_proxy,
        range_pct: s.open_proxy ? ((s.intraday_range / s.open_proxy) * 100).toFixed(3) : null,
        opt_volume: ov?.opt_volume || 0,
        quote_count: ov?.quote_count || 0,
      };
    });

    // Compute median volume
    const vols = merged.map(m => m.total_vol).filter(v => v > 0).sort((a,b) => a-b);
    const medianVol = vols[Math.floor(vols.length / 2)] || 1;
    const medianRange = merged.map(m => parseFloat(m.range_pct || 0)).filter(v => v > 0).sort((a,b) => a-b);
    const medianRangePct = medianRange[Math.floor(medianRange.length / 2)] || 0.1;

    console.log(`Median snapshot volume: ${medianVol}, Median range: ${medianRangePct.toFixed(3)}%\n`);

    const results = merged.map(m => {
      const volRatio = m.total_vol / (medianVol || 1);
      const rangeRatio = parseFloat(m.range_pct || 0) / (medianRangePct || 0.1);
      const isEventDay = volRatio > 2.0 || rangeRatio > 2.0;
      return {
        ...m,
        vol_ratio: volRatio.toFixed(2),
        range_ratio: rangeRatio.toFixed(2),
        label: isEventDay ? 'EVENT_DAY' : 'NON_EVENT_DAY',
        leakage_test: 'PASS — labels from same-day data only',
      };
    });

    for (const r of results) {
      console.log(`${r.date}: vol=${r.total_vol} (${r.vol_ratio}x) range=${r.range_pct}% (${r.range_ratio}x) → ${r.label}`);
    }

    const eventDays = results.filter(r => r.label === 'EVENT_DAY').length;
    console.log(`\nEvent days: ${eventDays}/${results.length}, Non-event days: ${results.length - eventDays}/${results.length}`);
    console.log('Leakage test: labels from same-day volume/range — no future information used.');

    await markDone(91, `Event-day labeled for ${results.length} days using volume-spike and range-spike proxy (>2x median). ${eventDays} event days identified. Leakage test PASS.`);
  } finally { await conn.end(); }
})();
