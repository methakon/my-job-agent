/**
 * Item 107: Simulate passive limit orders with no-fill and partial-fill states.
 *
 * Simulates placing limit orders at various price levels relative to the spread
 * and measures fill rates, partial fill probabilities, and unfilled risk.
 * Passive orders sit at bid (buy) or ask (sell) and wait for counterparty.
 */
const { getConnection, markDone } = require('./db');

(async () => {
  const conn = await getConnection();
  try {
    console.log('=== Item 107: Passive Limit Order Simulation ===\n');

    const [instruments] = await conn.query(`
      SELECT instrumentKey, COUNT(*) as total_events,
             COUNT(DISTINCT DATE(ts)) as days_active
      FROM unified_option_quotes_history
      WHERE ts >= '2026-09-09' AND HOUR(ts) BETWEEN 9 AND 16
        AND bid > 0 AND ask > 0 AND bidQty > 0 AND askQty > 0
      GROUP BY instrumentKey
      HAVING total_events > 500 AND days_active >= 2
      ORDER BY total_events DESC
      LIMIT 10
    `);

    console.log(`Analyzing ${instruments.length} instruments\n`);

    // Define passive order strategies
    const strategies = [
      { name: 'Bid (at bid)', getBid: (q) => Number(q.bid), getAsk: (q) => null },
      { name: 'Mid-Point', getBid: (q) => (Number(q.bid) + Number(q.ask)) / 2, getAsk: (q) => (Number(q.bid) + Number(q.ask)) / 2 },
      { name: 'Inside Spread', getBid: (q) => Number(q.bid) + (Number(q.ask) - Number(q.bid)) * 0.25, getAsk: (q) => Number(q.ask) - (Number(q.ask) - Number(q.bid)) * 0.25 },
      { name: '1-tick Better', getBid: (q) => Number(q.bid) + 0.05, getAsk: (q) => Number(q.ask) - 0.05 },
    ];

    for (const strat of strategies) {
      console.log(`\n--- Strategy: ${strat.name} ---`);

      const stratResults = [];

      for (const inst of instruments) {
        const [quotes] = await conn.query(`
          SELECT ts, ltp, bid, ask, bidQty, askQty, volume
          FROM unified_option_quotes_history
          WHERE instrumentKey = ? AND HOUR(ts) BETWEEN 9 AND 16
            AND bid > 0 AND ask > 0 AND bidQty > 0 AND askQty > 0
          ORDER BY ts
        `, [inst.instrumentKey]);

        if (quotes.length < 10) continue;

        let totalOrders = 0;
        let fullFills = 0;
        let partialFills = 0;
        let noFills = 0;
        let fillTimes = [];
        let orderPrices = [];
        let fillPrices = [];

        for (let i = 0; i < quotes.length - 1; i++) {
          const q = quotes[i];
          const spread = Number(q.ask) - Number(q.bid);
          if (spread <= 0) continue;

          // Passive buy limit order
          const buyPrice = strat.getBid(q);
          if (buyPrice === null || buyPrice <= 0 || buyPrice >= Number(q.ask)) continue;

          totalOrders++;
          orderPrices.push(buyPrice);

          let filled = false;
          let fillTime = null;
          let filledQty = 0;

          // Look ahead up to 30 snapshots
          for (let j = i + 1; j < Math.min(i + 30, quotes.length); j++) {
            const future = quotes[j];
            // Fill if future bid >= our limit price (counterparty hits our order)
            if (Number(future.bid) >= buyPrice) {
              if (!filled) {
                filled = true;
                fillTime = new Date(future.ts) - new Date(q.ts);
                fillPrices.push(Number(future.bid));
              }
              // Partial fill: if ask drops below our price, we get filled on remaining
              if (Number(future.ask) <= buyPrice) {
                filledQty = Number(future.askQty);
              }
            }
          }

          if (filled) {
            if (filledQty > 0) {
              partialFills++;
            } else {
              fullFills++;
            }
            fillTimes.push(fillTime);
          } else {
            noFills++;
          }
        }

        const fillRate = totalOrders > 0 ? ((fullFills + partialFills) / totalOrders * 100) : 0;
        const avgFillTime = fillTimes.length > 0
          ? fillTimes.reduce((a, b) => a + b, 0) / fillTimes.length / 1000
          : 0;
        const avgOrderPrice = orderPrices.length > 0
          ? orderPrices.reduce((a, b) => a + b, 0) / orderPrices.length
          : 0;
        const avgFillPrice = fillPrices.length > 0
          ? fillPrices.reduce((a, b) => a + b, 0) / fillPrices.length
          : 0;
        const priceImprovement = fillPrices.length > 0 && orderPrices.length > 0
          ? avgOrderPrice - avgFillPrice
          : 0;

        stratResults.push({
          instrument: inst.instrumentKey,
          days: inst.days_active,
          totalOrders,
          fullFills,
          partialFills,
          noFills,
          fillRate: fillRate.toFixed(1),
          avgFillTimeSec: avgFillTime.toFixed(1),
          avgOrderPrice: avgOrderPrice.toFixed(2),
          avgFillPrice: avgFillPrice.toFixed(2),
          priceImprovement: priceImprovement.toFixed(3),
        });
      }

      // Print strategy results
      console.log('Instrument                 | Days | Orders | Full | Partial | NoFill | Fill%  | AvgTTF(s) | AvgOrdPx | AvgFillPx | PriceImpr');
      console.log('---------------------------|------|--------|------|---------|--------|--------|-----------|----------|-----------|----------');
      for (const r of stratResults) {
        console.log(
          `${r.instrument.padEnd(26)}| ${String(r.days).padStart(4)} | ${String(r.totalOrders).padStart(6)} | ${String(r.fullFills).padStart(4)} | ${String(r.partialFills).padStart(7)} | ${String(r.noFills).padStart(6)} | ${String(r.fillRate).padStart(6)} | ${String(r.avgFillTimeSec).padStart(9)} | ${String(r.avgOrderPrice).padStart(8)} | ${String(r.avgFillPrice).padStart(9)} | ${String(r.priceImprovement).padStart(8)}`
        );
      }

      // Strategy aggregate
      const totalOrd = stratResults.reduce((s, r) => s + r.totalOrders, 0);
      const totalFull = stratResults.reduce((s, r) => s + r.fullFills, 0);
      const totalPartial = stratResults.reduce((s, r) => s + r.partialFills, 0);
      const totalNoFill = stratResults.reduce((s, r) => s + r.noFills, 0);
      const overallFillRate = totalOrd > 0 ? ((totalFull + totalPartial) / totalOrd * 100) : 0;

      console.log(`  Aggregate: ${totalOrd} orders, ${totalFull} full / ${totalPartial} partial / ${totalNoFill} no-fill (${overallFillRate.toFixed(1)}% fill rate)`);
    }

    // Final summary
    console.log(`\n--- Final Summary ---`);
    console.log(`4 passive strategies simulated: At-Bid, Mid-Point, Inside-Spread, 1-tick-Better`);
    console.log(`Fill rates, partial fills, no-fills, and price improvement computed.`);
    console.log(`Look-ahead window: 30 snapshots per order.`);
    console.log(`Higher fill rates indicate more aggressive passive placement.`);
    console.log(`Price improvement shows execution quality vs order placement.`);

    await markDone(107,
      `Passive limit order simulation across ${instruments.length} instruments, 4 strategies. ` +
      `Fill rates, partial/no-fill states, time-to-fill, and price improvement computed. ` +
      `Strategies: At-Bid, Mid-Point, Inside-Spread, 1-tick-Better.`
    );
  } finally {
    await conn.end();
  }
})();
