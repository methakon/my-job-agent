/**
 * Item 181: Run cost/slippage/latency stress
 * 
 * Stress test with varying cost/slippage/latency parameters on daily PnL.
 */
const { getConnection, markDone } = require('./db');

(async () => {
  const conn = await getConnection();
  try {
    console.log('=== Item 181: Cost/Slippage/Latency Stress ===\n');

    // Get daily PnL — use actual data hours for NIFTY50 (starts ~12:00, peaks ~14-15)
    const [dailyData] = await conn.query(`
      SELECT DATE(ts) as d,
        MIN(CASE WHEN HOUR(ts) = 12 THEN ltp END) as entry_price,
        MAX(CASE WHEN HOUR(ts) = 14 THEN ltp END) as mid_price,
        MAX(CASE WHEN HOUR(ts) = 15 THEN ltp END) as exit_price
      FROM unified_market_snapshots_history
      WHERE ts >= '2026-09-10' AND symbol = 'NIFTY50'
      GROUP BY d HAVING entry_price IS NOT NULL AND exit_price IS NOT NULL
      ORDER BY d
    `);

    console.log(`Base trades: ${dailyData.length} days (entry=12:00, exit=15:00)\n`);

    // Slippage stress levels
    const slippages = [0, 0.05, 0.1, 0.2, 0.5];
    console.log('--- Slippage Stress (applied to both entry and exit) ---');
    for (const slip of slippages) {
      let totalPnl = 0;
      for (const day of dailyData) {
        const entry = Number(day.entry_price);
        const exit = Number(day.exit_price);
        const pnlPct = ((exit - entry) / entry * 100) - (slip * 2);
        totalPnl += pnlPct;
      }
      const avgPnl = (totalPnl / dailyData.length);
      console.log(`  Slippage ${slip}%: avg daily PnL = ${avgPnl.toFixed(4)}% (total: ${totalPnl.toFixed(4)}%)`);
    }

    // Latency stress: assume price moves against us proportionally
    console.log('\n--- Latency Stress (price adversarial at entry) ---');
    const latencies = [0, 0.02, 0.05, 0.1];
    for (const lat of latencies) {
      let totalPnl = 0;
      for (const day of dailyData) {
        const entry = Number(day.entry_price);
        const exit = Number(day.exit_price);
        const pnlPct = ((exit - entry) / entry * 100) - lat;
        totalPnl += pnlPct;
      }
      const avgPnl = (totalPnl / dailyData.length);
      console.log(`  Latency cost ${lat}%: avg daily PnL = ${avgPnl.toFixed(4)}%`);
    }

    // Combined worst-case
    console.log('\n--- Combined Worst Case (slippage + latency + spread) ---');
    const spread = 0.1; // assumed spread cost
    for (const slip of [0.1, 0.2]) {
      for (const lat of [0.05, 0.1]) {
        let totalPnl = 0;
        for (const day of dailyData) {
          const entry = Number(day.entry_price);
          const exit = Number(day.exit_price);
          const pnlPct = ((exit - entry) / entry * 100) - slip * 2 - lat - spread;
          totalPnl += pnlPct;
        }
        const avgPnl = (totalPnl / dailyData.length);
        const profitable = dailyData.filter(d => {
          const entry = Number(d.entry_price);
          const exit = Number(d.exit_price);
          return ((exit - entry) / entry * 100) - slip * 2 - lat - spread > 0;
        }).length;
        console.log(`  slip=${slip}% lat=${lat}% spread=${spread}%: avg=${avgPnl.toFixed(4)}% profitable=${profitable}/${dailyData.length}`);
      }
    }

    await markDone(181, `Cost/slippage/latency stress tested across ${slippages.length} slippage levels, ${latencies.length} latency levels, and combined worst-case scenarios. ${dailyData.length} base trading days analyzed.`);
  } finally { await conn.end(); }
})();
