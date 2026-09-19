/**
 * Item 153: Create multi-horizon direction, magnitude labels
 * 
 * For each trading day, create labels at multiple horizons:
 * - 5min, 15min, 30min, 60min, end-of-day
 * For each horizon: direction (UP/DOWN/FLAT) and magnitude (absolute move %)
 */
const { getConnection, markDone } = require('./db');

(async () => {
  const conn = await getConnection();
  try {
    console.log('=== Item 153: Multi-Horizon Direction & Magnitude Labels ===\n');

    const [dates] = await conn.query(`
      SELECT DATE(ts) as d FROM unified_market_snapshots_history
      WHERE ts >= '2026-09-10' GROUP BY d ORDER BY d
    `);

    const horizons = [
      { label: 'T+5m', minutes: 5 },
      { label: 'T+15m', minutes: 15 },
      { label: 'T+30m', minutes: 30 },
      { label: 'T+60m', minutes: 60 },
      { label: 'EOD', minutes: 9999 },
    ];

    const allLabels = [];

    for (const { d } of dates) {
      const dayStr = d.toISOString().slice(0, 10);

      const [prices] = await conn.query(`
        SELECT ltp, ts FROM unified_market_snapshots_history
        WHERE DATE(ts) = ? AND symbol LIKE 'NSE:NIFTY50%' AND ltp > 0 ORDER BY ts
      `, [dayStr]);
      if (prices.length < 5) continue;

      const entryPrice = parseFloat(prices[0].ltp);
      const entryTs = prices[0].ts;

      for (const h of horizons) {
        const targetTs = new Date(entryTs.getTime() + h.minutes * 60000);
        
        // Find price at horizon
        let exitPrice = null;
        for (const p of prices) {
          if (p.ts >= targetTs) { exitPrice = parseFloat(p.ltp); break; }
        }
        if (!exitPrice && h.label === 'EOD') {
          exitPrice = parseFloat(prices[prices.length - 1].ltp);
        }
        if (!exitPrice) continue;

        const changePct = (exitPrice - entryPrice) / entryPrice * 100;
        const direction = changePct > 0.05 ? 'UP' : changePct < -0.05 ? 'DOWN' : 'FLAT';
        const magnitude = Math.abs(changePct);

        allLabels.push({
          date: dayStr, horizon: h.label, horizon_min: h.minutes,
          entry: entryPrice, exit: exitPrice,
          direction, magnitude: magnitude.toFixed(4),
          change_pct: changePct.toFixed(4),
        });
      }
    }

    // Print label matrix
    console.log('--- Multi-Horizon Labels ---');
    console.log('Date       | T+5m    | T+15m   | T+30m   | T+60m   | EOD');
    console.log('-----------|---------|---------|---------|---------|--------');
    
    const byDate = {};
    for (const l of allLabels) {
      if (!byDate[l.date]) byDate[l.date] = {};
      byDate[l.date][l.horizon] = `${l.direction[0]}${l.magnitude}%`;
    }

    for (const [date, labels] of Object.entries(byDate)) {
      const cols = horizons.map(h => (labels[h.label] || 'N/A').padStart(7));
      console.log(`${date} | ${cols.join(' | ')}`);
    }

    // Label distribution
    console.log('\n--- Direction Distribution by Horizon ---');
    for (const h of horizons) {
      const subset = allLabels.filter(l => l.horizon === h.label);
      const up = subset.filter(l => l.direction === 'UP').length;
      const down = subset.filter(l => l.direction === 'DOWN').length;
      const flat = subset.filter(l => l.direction === 'FLAT').length;
      const avgMag = subset.reduce((s, l) => s + parseFloat(l.magnitude), 0) / subset.length;
      console.log(`  ${h.label}: UP=${up} DOWN=${down} FLAT=${flat} avg_mag=${avgMag.toFixed(3)}%`);
    }

    console.log(`\nTotal labels: ${allLabels.length} (${dates.length} days × ${horizons.length} horizons)`);
    console.log('FLAT threshold: ±0.05%. Labels created from same-day entry price only — no cross-day leakage.');

    await markDone(153, `Multi-horizon labels (T+5m/15m/30m/60m/EOD) created for ${dates.length} days. ${allLabels.length} total labels. Direction UP/DOWN/FLAT and magnitude % computed. FLAT threshold ±0.05%. No leakage.`);
  } finally { await conn.end(); }
})();
