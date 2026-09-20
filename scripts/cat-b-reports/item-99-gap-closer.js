/**
 * Item 99: Evaluate gap-closer ideas with explicit max holding periods and hard risk caps
 * 
 * Simulates gap-closer strategies: buy on gap, hold for N minutes max,
 * with hard stop loss. Tests multiple holding periods (5, 15, 30, 60 min)
 * and risk caps (0.5%, 1%, 2% of entry).
 */
const { getConnection, markDone } = require('./db');

(async () => {
  const conn = await getConnection();
  try {
    console.log('=== Item 99: Gap-Closer Evaluation with Holding Periods & Risk Caps ===\n');

    const [dates] = await conn.query(`
      SELECT DATE(ts) as d FROM unified_market_snapshots_history
      WHERE ts >= '2026-09-10' GROUP BY d ORDER BY d
    `);

    const holdingPeriods = [5, 15, 30, 60]; // minutes
    const riskCaps = [0.5, 1.0, 2.0]; // percent
    const results = [];

    for (let i = 0; i < dates.length; i++) {
      const dayStr = dates[i].d.toISOString().slice(0, 10);
      const prevDay = i > 0 ? dates[i-1].d.toISOString().slice(0, 10) : null;
      if (!prevDay) continue;

      // Prior close
      const [priorClose] = await conn.query(`
        SELECT close FROM unified_market_snapshots_history
        WHERE DATE(ts) = ? AND symbol LIKE 'NSE:NIFTY50%' AND close > 0
        ORDER BY ts DESC LIMIT 1
      `, [prevDay]);
      if (!priorClose[0]?.close) continue;

      // Today's prices
      const [prices] = await conn.query(`
        SELECT ltp, ts FROM unified_market_snapshots_history
        WHERE DATE(ts) = ? AND symbol LIKE 'NSE:NIFTY50%' AND ltp > 0
        ORDER BY ts
      `, [dayStr]);
      if (prices.length < 10) continue;

      const priorClosePrice = parseFloat(priorClose[0].close);
      const openPrice = parseFloat(prices[0].ltp);
      const gapPct = ((openPrice - priorClosePrice) / priorClosePrice * 100);

      // Only evaluate if there's a meaningful gap (>0.1%)
      if (Math.abs(gapPct) < 0.1) continue;

      const gapDirection = gapPct > 0 ? 'UP' : 'DOWN'; // gap up → closer bets on mean reversion (short/PE)
      
      for (const holdMin of holdingPeriods) {
        for (const riskCap of riskCaps) {
          // Find entry at open, exit at holdMin or risk cap
          const entryPrice = openPrice;
          const entryIdx = 0;

          let exitPrice = null;
          let exitReason = 'TIME';
          const stopLoss = riskCap / 100 * entryPrice;
          const stopDir = gapDirection === 'UP' ? -1 : 1; // mean reversion: bet against gap

          for (let j = entryIdx + 1; j < prices.length; j++) {
            const minsElapsed = (prices[j].ts - prices[entryIdx].ts) / 60000;
            if (minsElapsed > holdMin) {
              exitPrice = parseFloat(prices[j].ltp);
              exitReason = 'TIME';
              break;
            }
            // Check risk cap (mean reversion: profit if price moves back toward prior close)
            const moveAgainst = gapDirection === 'UP' 
              ? prices[j].ltp - entryPrice  // price going higher = against short
              : entryPrice - prices[j].ltp; // price going lower = against long
            if (moveAgainst > stopLoss) {
              exitPrice = parseFloat(prices[j].ltp);
              exitReason = 'STOP';
              break;
            }
          }
          if (!exitPrice && prices.length > 0) {
            exitPrice = parseFloat(prices[prices.length - 1].ltp);
          }

          // PnL: mean reversion direction
          const pnl = gapDirection === 'UP' 
            ? entryPrice - exitPrice  // short: profit if price drops
            : exitPrice - entryPrice; // long: profit if price rises
          const pnlPct = (pnl / entryPrice * 100);

          results.push({
            date: dayStr, gap_pct: gapPct.toFixed(3), gap_direction: gapDirection,
            hold_min: holdMin, risk_cap: riskCap,
            entry: entryPrice, exit: exitPrice, exit_reason: exitReason,
            pnl: pnlPct.toFixed(3),
            experiment_id: `GAP_CLOSE_${dayStr}_${holdMin}m_${riskCap}pct`,
          });
        }
      }
    }

    // Summary table
    console.log(`Total experiments: ${results.length}`);
    console.log('\n--- By Holding Period ---');
    for (const hp of holdingPeriods) {
      const subset = results.filter(r => r.hold_min === hp);
      const avgPnl = subset.reduce((s, r) => s + parseFloat(r.pnl), 0) / subset.length;
      const wins = subset.filter(r => parseFloat(r.pnl) > 0).length;
      const stops = subset.filter(r => r.exit_reason === 'STOP').length;
      console.log(`  ${hp}min: ${subset.length} trades, avg=${avgPnl.toFixed(3)}%, wins=${wins}/${subset.length}, stops=${stops}`);
    }

    console.log('\n--- By Risk Cap ---');
    for (const rc of riskCaps) {
      const subset = results.filter(r => r.risk_cap === rc);
      const avgPnl = subset.reduce((s, r) => s + parseFloat(r.pnl), 0) / subset.length;
      console.log(`  ${rc}%: ${subset.length} trades, avg=${avgPnl.toFixed(3)}%`);
    }

    await markDone(99, `Gap-closer evaluated across ${results.length} experiments (${holdingPeriods.length} holding periods × ${riskCaps.length} risk caps). Mean-reversion strategy tested. Avg PnL, win rate, stop-hit rate computed per configuration.`);
  } finally { await conn.end(); }
})();
