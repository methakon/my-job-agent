/**
 * Item 95: Track fill probability, time-to-fill, midpoint probability, MAE/MFE and tail loss.
 *
 * Simulates market orders at each snapshot and measures:
 * - Fill probability (would the order fill at current bid/ask?)
 * - Time-to-fill (how long until price crosses the order level)
 * - Midpoint probability (how often LTP is at midpoint)
 * - MAE (Maximum Adverse Excursion) and MFE (Maximum Favorable Excursion)
 * - Tail loss (worst-case adverse move after entry)
 */
const { getConnection, markDone } = require('./db');

(async () => {
  const conn = await getConnection();
  try {
    console.log('=== Item 95: Fill Probability, Time-to-Fill, MAE/MFE & Tail Loss ===\n');

    // Get active instruments with enough data
    const [instruments] = await conn.query(`
      SELECT instrumentKey, COUNT(*) as total_events,
             COUNT(DISTINCT DATE(ts)) as days_active
      FROM unified_option_quotes_history
      WHERE ts >= '2026-09-09' AND HOUR(ts) BETWEEN 9 AND 16
        AND bid > 0 AND ask > 0
      GROUP BY instrumentKey
      HAVING total_events > 500 AND days_active >= 2
      ORDER BY total_events DESC
      LIMIT 10
    `);

    console.log(`Analyzing ${instruments.length} instruments\n`);

    const allResults = [];

    for (const inst of instruments) {
      const [quotes] = await conn.query(`
        SELECT ts, ltp, bid, ask, bidQty, askQty, volume, oi
        FROM unified_option_quotes_history
        WHERE instrumentKey = ? AND HOUR(ts) BETWEEN 9 AND 16
          AND bid > 0 AND ask > 0
        ORDER BY ts
      `, [inst.instrumentKey]);

      if (quotes.length < 10) continue;

      let buyFills = 0;
      let sellFills = 0;
      let totalSnapshots = 0;
      let midpointHits = 0;
      let buyTimeToFills = [];
      let sellTimeToFills = [];
      let buyMAEs = [];
      let buyMFEs = [];
      let sellMAEs = [];
      let sellMFEs = [];
      let buyTailLosses = [];
      let sellTailLosses = [];

      for (let i = 0; i < quotes.length - 1; i++) {
        const q = quotes[i];
        const mid = (Number(q.bid) + Number(q.ask)) / 2;
        const spread = Number(q.ask) - Number(q.bid);
        totalSnapshots++;

        // Midpoint probability
        if (spread > 0 && Math.abs(Number(q.ltp) - mid) < spread * 0.1) {
          midpointHits++;
        }

        // Buy at ask simulation
        const buyPrice = Number(q.ask);
        let buyFilled = false;
        let buyFillTime = null;
        let buyMaxAdverse = 0;
        let buyMaxFavorable = 0;
        let buyWorstLoss = 0;

        for (let j = i + 1; j < Math.min(i + 50, quotes.length); j++) {
          const future = quotes[j];
          const futureMid = (Number(future.bid) + Number(future.ask)) / 2;
          const adverseMove = buyPrice - futureMid;
          const favorableMove = futureMid - buyPrice;

          if (adverseMove > buyMaxAdverse) buyMaxAdverse = adverseMove;
          if (favorableMove > buyMaxFavorable) buyMaxFavorable = favorableMove;
          if (adverseMove > buyWorstLoss) buyWorstLoss = adverseMove;

          // Fill if future bid >= buy price (someone sells to us at ask)
          if (Number(future.bid) >= buyPrice && !buyFilled) {
            buyFilled = true;
            buyFillTime = new Date(future.ts) - new Date(q.ts);
          }
        }

        if (buyFilled) {
          buyFills++;
          buyTimeToFills.push(buyFillTime);
          buyMAEs.push(buyMaxAdverse);
          buyMFEs.push(buyMaxFavorable);
          buyTailLosses.push(buyWorstLoss);
        }

        // Sell at bid simulation
        const sellPrice = Number(q.bid);
        let sellFilled = false;
        let sellFillTime = null;
        let sellMaxAdverse = 0;
        let sellMaxFavorable = 0;
        let sellWorstLoss = 0;

        for (let j = i + 1; j < Math.min(i + 50, quotes.length); j++) {
          const future = quotes[j];
          const futureMid = (Number(future.bid) + Number(future.ask)) / 2;
          const adverseMove = futureMid - sellPrice;
          const favorableMove = sellPrice - futureMid;

          if (adverseMove > sellMaxAdverse) sellMaxAdverse = adverseMove;
          if (favorableMove > sellMaxFavorable) sellMaxFavorable = favorableMove;
          if (adverseMove > sellWorstLoss) sellWorstLoss = adverseMove;

          if (Number(future.ask) <= sellPrice && !sellFilled) {
            sellFilled = true;
            sellFillTime = new Date(future.ts) - new Date(q.ts);
          }
        }

        if (sellFilled) {
          sellFills++;
          sellTimeToFills.push(sellFillTime);
          sellMAEs.push(sellMaxAdverse);
          sellMFEs.push(sellMaxFavorable);
          sellTailLosses.push(sellWorstLoss);
        }
      }

      const avg = arr => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
      const p95 = arr => {
        if (arr.length === 0) return 0;
        const sorted = [...arr].sort((a, b) => a - b);
        return sorted[Math.floor(sorted.length * 0.95)];
      };

      allResults.push({
        instrument: inst.instrumentKey,
        days: inst.days_active,
        snapshots: totalSnapshots,
        buyFillProb: (buyFills / totalSnapshots * 100).toFixed(1),
        sellFillProb: (sellFills / totalSnapshots * 100).toFixed(1),
        avgBuyTTF: (avg(buyTimeToFills) / 1000).toFixed(1),
        avgSellTTF: (avg(sellTimeToFills) / 1000).toFixed(1),
        midpointProb: (midpointHits / totalSnapshots * 100).toFixed(1),
        avgBuyMAE: avg(buyMAEs).toFixed(2),
        avgBuyMFE: avg(buyMFEs).toFixed(2),
        avgSellMAE: avg(sellMAEs).toFixed(2),
        avgSellMFE: avg(sellMFEs).toFixed(2),
        p95BuyTail: p95(buyTailLosses).toFixed(2),
        p95SellTail: p95(sellTailLosses).toFixed(2),
      });
    }

    // Print
    console.log('Instrument                 | Days | Snaps | BuyFill% | SellFill% | BuyTTF(s) | SellTTF(s) | Mid% | BuyMAE | BuyMFE | SellMAE | SellMFE | BuyT95 | SellT95');
    console.log('---------------------------|------|-------|----------|-----------|-----------|------------|------|--------|--------|---------|---------|--------|--------');
    for (const r of allResults) {
      console.log(
        `${r.instrument.padEnd(26)}| ${String(r.days).padStart(4)} | ${String(r.snapshots).padStart(5)} | ${String(r.buyFillProb).padStart(8)} | ${String(r.sellFillProb).padStart(9)} | ${String(r.avgBuyTTF).padStart(9)} | ${String(r.avgSellTTF).padStart(10)} | ${String(r.midpointProb).padStart(4)} | ${String(r.avgBuyMAE).padStart(6)} | ${String(r.avgBuyMFE).padStart(6)} | ${String(r.avgSellMAE).padStart(7)} | ${String(r.avgSellMFE).padStart(7)} | ${String(r.p95BuyTail).padStart(6)} | ${String(r.p95SellTail).padStart(6)}`
      );
    }

    // Summary
    const avgBuyFill = allResults.reduce((s, r) => s + Number(r.buyFillProb), 0) / allResults.length;
    const avgSellFill = allResults.reduce((s, r) => s + Number(r.sellFillProb), 0) / allResults.length;
    const avgMid = allResults.reduce((s, r) => s + Number(r.midpointProb), 0) / allResults.length;

    console.log(`\n--- Aggregate Summary ---`);
    console.log(`Avg buy fill probability: ${avgBuyFill.toFixed(1)}%`);
    console.log(`Avg sell fill probability: ${avgSellFill.toFixed(1)}%`);
    console.log(`Avg midpoint probability: ${avgMid.toFixed(1)}%`);
    console.log(`MAE/MFE and tail loss (P95) computed per instrument.`);

    await markDone(95,
      `Fill probability, time-to-fill, midpoint probability, MAE/MFE, and tail loss ` +
      `computed across ${allResults.length} instruments. ` +
      `Buy fill avg: ${avgBuyFill.toFixed(1)}%, sell fill avg: ${avgSellFill.toFixed(1)}%. ` +
      `Midpoint probability avg: ${avgMid.toFixed(1)}%. P95 tail losses quantified.`
    );
  } finally {
    await conn.end();
  }
})();
