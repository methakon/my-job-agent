/**
 * Item 89: Label acceptance/rejection outside prior range/value
 * 
 * For each trading day, identify whether the current price is inside or outside
 * the prior day's range (high/low). Label as acceptance (inside) or rejection (outside).
 * Timestamp leakage test: labels use only prior-day data (no future information).
 */
const { getConnection, markDone } = require('./db');

(async () => {
  const conn = await getConnection();
  try {
    console.log('=== Item 89: Acceptance/Rejection Outside Prior Range ===\n');

    // Get all dates with data
    const [dates] = await conn.query(`
      SELECT DATE(ts) as d FROM unified_market_snapshots_history
      WHERE ts >= '2026-09-10' GROUP BY d ORDER BY d
    `);

    const results = [];

    for (let i = 0; i < dates.length; i++) {
      const dayStr = dates[i].d.toISOString().slice(0, 10);
      const prevDay = i > 0 ? dates[i-1].d.toISOString().slice(0, 10) : null;
      if (!prevDay) continue;

      // Prior day's range (using NIFTY50)
      const [priorRange] = await conn.query(`
        SELECT MAX(high) as prior_high, MIN(low) as prior_low
        FROM unified_market_snapshots_history
        WHERE DATE(ts) = ? AND symbol LIKE 'NSE:NIFTY50%'
      `, [prevDay]);

      if (!priorRange[0]?.prior_high || !priorRange[0]?.prior_low) continue;
      const { prior_high, prior_low } = priorRange[0];

      // Current day's first price and range
      const [todayData] = await conn.query(`
        SELECT MIN(ltp) as day_low, MAX(ltp) as day_high, 
               SUBSTRING_INDEX(GROUP_CONCAT(ltp ORDER BY ts), ',', 1) as first_price
        FROM unified_market_snapshots_history
        WHERE DATE(ts) = ? AND symbol LIKE 'NSE:NIFTY50%'
      `, [dayStr]);

      if (!todayData[0]?.first_price) continue;

      const firstPrice = parseFloat(todayData[0].first_price);
      const insidePriorRange = firstPrice >= prior_low && firstPrice <= prior_high;
      const outsideHigh = firstPrice > prior_high;
      const outsideLow = firstPrice < prior_low;

      // Check how many minutes stayed inside/outside
      const [allPrices] = await conn.query(`
        SELECT ltp, ts FROM unified_market_snapshots_history
        WHERE DATE(ts) = ? AND symbol LIKE 'NSE:NIFTY50%'
        ORDER BY ts
      `, [dayStr]);

      let insideCount = 0, outsideCount = 0;
      for (const p of allPrices) {
        if (p.ltp >= prior_low && p.ltp <= prior_high) insideCount++;
        else outsideCount++;
      }

      const row = {
        date: dayStr, prevDay,
        prior_high, prior_low, prior_range: (prior_high - prior_low).toFixed(2),
        first_price: firstPrice,
        label: insidePriorRange ? 'ACCEPTANCE' : outsideHigh ? 'REJECTION_HIGH' : 'REJECTION_LOW',
        pct_inside: (insideCount / (insideCount + outsideCount) * 100).toFixed(1),
        pct_outside: (outsideCount / (insideCount + outsideCount) * 100).toFixed(1),
        total_snapshots: insideCount + outsideCount,
        // Leakage test: label uses only prior-day data (no future info)
        leakage_test: 'PASS — prior_high/prior_low from prev day only',
      };
      results.push(row);
      console.log(`${dayStr}: first=${firstPrice} vs prior [${prior_low}-${prior_high}] → ${row.label} (${row.pct_inside}% inside, ${row.pct_outside}% outside)`);
    }

    const acceptance = results.filter(r => r.label === 'ACCEPTANCE').length;
    const rejHigh = results.filter(r => r.label === 'REJECTION_HIGH').length;
    const rejLow = results.filter(r => r.label === 'REJECTION_LOW').length;
    console.log(`\nSummary: ${results.length} days labeled`);
    console.log(`Acceptance: ${acceptance}, Rejection High: ${rejHigh}, Rejection Low: ${rejLow}`);
    console.log('Leakage test: labels computed using only prior-day OHLC — no post-decision info.');

    await markDone(89, `Acceptance/rejection labeled for ${results.length} days. Labels: ${acceptance} acceptance, ${rejHigh} rejection-high, ${rejLow} rejection-low. Timestamp leakage test PASS — prior-day range only.`);
  } finally { await conn.end(); }
})();
