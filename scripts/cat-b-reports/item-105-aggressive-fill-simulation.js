/**
 * Item 105: Simulate aggressive fills at bid/ask rather than LTP.
 *
 * Shows how aggressive (market) fills at bid/ask compare to LTP-based fills.
 * Measures price improvement/deterioration, fill rates, and slippage
 * when executing at the actual bid/ask vs assuming LTP execution.
 */
const { getConnection, markDone } = require('./db');

(async () => {
  const conn = await getConnection();
  try {
    console.log('=== Item 105: Aggressive Fill Simulation at Bid/Ask ===\n');

    const [instruments] = await conn.query(`
      SELECT instrumentKey, COUNT(*) as total_events,
             COUNT(DISTINCT DATE(ts)) as days_active
      FROM unified_option_quotes_history
      WHERE ts >= '2026-09-09' AND HOUR(ts) BETWEEN 9 AND 16
        AND bid > 0 AND ask > 0 AND ltp > 0
      GROUP BY instrumentKey
      HAVING total_events > 500 AND days_active >= 2
      ORDER BY total_events DESC
      LIMIT 10
    `);

    console.log(`Analyzing ${instruments.length} instruments\n`);

    const results = [];

    for (const inst of instruments) {
      const [quotes] = await conn.query(`
        SELECT ts, ltp, bid, ask, bidQty, askQty, volume
        FROM unified_option_quotes_history
        WHERE instrumentKey = ? AND HOUR(ts) BETWEEN 9 AND 16
          AND bid > 0 AND ask > 0 AND ltp > 0
        ORDER BY ts
      `, [inst.instrumentKey]);

      if (quotes.length < 10) continue;

      let buyAtAsk = 0;
      let buyAtLTP = 0;
      let sellAtBid = 0;
      let sellAtLTP = 0;
      let totalSnapshots = 0;

      // Track price improvement vs deterioration
      let buySlippages = []; // positive = we paid more than midpoint
      let sellSlippages = []; // positive = we received less than midpoint

      // Track fill simulation results
      let buyFillResults = [];
      let sellFillResults = [];

      for (let i = 0; i < quotes.length; i++) {
        const q = quotes[i];
        const mid = (Number(q.bid) + Number(q.ask)) / 2;
        const spread = Number(q.ask) - Number(q.bid);
        totalSnapshots++;

        // BUY simulation: aggressive buy at ask
        const buyExecPrice = Number(q.ask);
        const buySlippage = buyExecPrice - mid; // positive = paid more than mid
        buySlippages.push(buySlippage);
        buyAtAsk++;

        // Would LTP have been better?
        if (Number(q.ltp) < buyExecPrice) {
          buyAtLTP++;
        }

        // SELL simulation: aggressive sell at bid
        const sellExecPrice = Number(q.bid);
        const sellSlippage = mid - sellExecPrice; // positive = received less than mid
        sellSlippages.push(sellSlippage);
        sellAtBid++;

        if (Number(q.ltp) > sellExecPrice) {
          sellAtLTP++;
        }

        // Fill simulation: what happens 5 snapshots later?
        if (i + 5 < quotes.length) {
          const future = quotes[i + 5];
          const futureMid = (Number(future.bid) + Number(future.ask)) / 2;

          // Buy P&L: we bought at ask, mark to future mid
          const buyPnL = futureMid - buyExecPrice;
          buyFillResults.push(buyPnL);

          // Sell P&L: we sold at bid, mark to future mid
          const sellPnL = sellExecPrice - futureMid;
          sellFillResults.push(sellPnL);
        }
      }

      const avg = arr => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
      const positive = arr => arr.filter(v => v > 0).length;
      const avgBuySlip = avg(buySlippages);
      const avgSellSlip = avg(sellSlippages);
      const avgBuyPnL = avg(buyFillResults);
      const avgSellPnL = avg(sellFillResults);
      const buyWinRate = buyFillResults.length > 0 ? (positive(buyFillResults) / buyFillResults.length * 100) : 0;
      const sellWinRate = sellFillResults.length > 0 ? (positive(sellFillResults) / sellFillResults.length * 100) : 0;

      results.push({
        instrument: inst.instrumentKey,
        days: inst.days_active,
        snapshots: totalSnapshots,
        avgBuySlip: avgBuySlip.toFixed(3),
        avgSellSlip: avgSellSlip.toFixed(3),
        ltpBeatAskPct: (buyAtLTP / totalSnapshots * 100).toFixed(1),
        ltpBeatBidPct: (sellAtLTP / totalSnapshots * 100).toFixed(1),
        avgBuyPnL: avgBuyPnL.toFixed(3),
        avgSellPnL: avgSellPnL.toFixed(3),
        buyWinRate: buyWinRate.toFixed(1),
        sellWinRate: sellWinRate.toFixed(1),
      });
    }

    console.log('Instrument                 | Days | Snaps | Avg Buy Slip | Avg Sell Slip | LTP<Ask% | LTP>Bid% | Avg Buy PnL | Avg Sell PnL | Buy Win% | Sell Win%');
    console.log('---------------------------|------|-------|-------------|--------------|----------|----------|-------------|--------------|----------|----------');
    for (const r of results) {
      console.log(
        `${r.instrument.padEnd(26)}| ${String(r.days).padStart(4)} | ${String(r.snapshots).padStart(5)} | ${String(r.avgBuySlip).padStart(11)} | ${String(r.avgSellSlip).padStart(12)} | ${String(r.ltpBeatAskPct).padStart(8)} | ${String(r.ltpBeatBidPct).padStart(8)} | ${String(r.avgBuyPnL).padStart(11)} | ${String(r.avgSellPnL).padStart(12)} | ${String(r.buyWinRate).padStart(8)} | ${String(r.sellWinRate).padStart(8)}`
      );
    }

    // Summary
    const avgBuySlipOverall = results.reduce((s, r) => s + Number(r.avgBuySlip), 0) / results.length;
    const avgSellSlipOverall = results.reduce((s, r) => s + Number(r.avgSellSlip), 0) / results.length;
    const avgBuyWinOverall = results.reduce((s, r) => s + Number(r.buyWinRate), 0) / results.length;
    const avgSellWinOverall = results.reduce((s, r) => s + Number(r.sellWinRate), 0) / results.length;

    console.log(`\n--- Aggregate Summary ---`);
    console.log(`Avg buy slippage (vs mid): ${avgBuySlipOverall.toFixed(3)}`);
    console.log(`Avg sell slippage (vs mid): ${avgSellSlipOverall.toFixed(3)}`);
    console.log(`Avg buy win rate (5-snap PnL): ${avgBuyWinOverall.toFixed(1)}%`);
    console.log(`Avg sell win rate (5-snap PnL): ${avgSellWinOverall.toFixed(1)}%`);
    console.log(`Aggressive fills at bid/ask show realistic execution vs LTP assumption.`);

    await markDone(105,
      `Aggressive fill simulation at bid/ask across ${results.length} instruments. ` +
      `Buy slippage avg: ${avgBuySlipOverall.toFixed(3)}, sell slippage avg: ${avgSellSlipOverall.toFixed(3)}. ` +
      `5-snapshot forward PnL win rates computed. ` +
      `LTP-based fill assumption compared to actual bid/ask execution.`
    );
  } finally {
    await conn.end();
  }
})();
