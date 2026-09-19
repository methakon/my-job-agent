/**
 * Item 56: Track replenishment after consumption.
 *
 * Measures how quickly liquidity (bidQty/askQty) replenishes after being consumed.
 * When volume increases (trades happen), we track how long it takes for
 * bid/ask quantities to return to previous levels.
 */
const { getConnection, markDone } = require('./db');

(async () => {
  const conn = await getConnection();
  try {
    console.log('=== Item 56: Liquidity Replenishment After Consumption ===\n');

    // Get active instruments
    const [instruments] = await conn.query(`
      SELECT instrumentKey, COUNT(*) as total_events,
             COUNT(DISTINCT DATE(ts)) as days_active
      FROM unified_option_quotes_history
      WHERE ts >= '2026-09-09' AND HOUR(ts) BETWEEN 9 AND 16
        AND bidQty > 0 AND askQty > 0
      GROUP BY instrumentKey
      HAVING total_events > 200 AND days_active >= 2
      ORDER BY total_events DESC
      LIMIT 15
    `);

    console.log(`Analyzing ${instruments.length} instruments for replenishment patterns\n`);

    const results = [];

    for (const inst of instruments) {
      const [quotes] = await conn.query(`
        SELECT ts, bid, ask, bidQty, askQty, volume, oi
        FROM unified_option_quotes_history
        WHERE instrumentKey = ? AND HOUR(ts) BETWEEN 9 AND 16
          AND bidQty > 0 AND askQty > 0
        ORDER BY ts
      `, [inst.instrumentKey]);

      if (quotes.length < 5) continue;

      let bidConsumptions = 0;
      let askConsumptions = 0;
      let bidReplenishTimes = [];
      let askReplenishTimes = [];
      let bidPartialReplenish = 0;
      let askPartialReplenish = 0;

      for (let i = 1; i < quotes.length; i++) {
        const prev = quotes[i - 1];
        const curr = quotes[i];
        const spanMs = new Date(curr.ts) - new Date(prev.ts);

        // Bid consumption: bidQty dropped
        if (Number(curr.bidQty) < Number(prev.bidQty) && Number(prev.bidQty) > 0) {
          bidConsumptions++;
          const consumedQty = Number(prev.bidQty) - Number(curr.bidQty);
          
          // Look ahead for replenishment
          let replenished = false;
          for (let j = i + 1; j < Math.min(i + 20, quotes.length); j++) {
            const future = quotes[j];
            if (Number(future.bidQty) >= Number(prev.bidQty)) {
              const replenishTime = new Date(future.ts) - new Date(curr.ts);
              bidReplenishTimes.push(replenishTime);
              replenished = true;
              break;
            } else if (Number(future.bidQty) > Number(curr.bidQty)) {
              bidPartialReplenish++;
            }
          }
          if (!replenished && i + 20 < quotes.length) {
            // Check if partial replenishment happened
            const lastCheck = quotes[Math.min(i + 20, quotes.length - 1)];
            if (Number(lastCheck.bidQty) > Number(curr.bidQty)) {
              bidPartialReplenish++;
            }
          }
        }

        // Ask consumption: askQty dropped
        if (Number(curr.askQty) < Number(prev.askQty) && Number(prev.askQty) > 0) {
          askConsumptions++;
          
          let replenished = false;
          for (let j = i + 1; j < Math.min(i + 20, quotes.length); j++) {
            const future = quotes[j];
            if (Number(future.askQty) >= Number(prev.askQty)) {
              const replenishTime = new Date(future.ts) - new Date(curr.ts);
              askReplenishTimes.push(replenishTime);
              replenished = true;
              break;
            } else if (Number(future.askQty) > Number(curr.askQty)) {
              askPartialReplenish++;
            }
          }
          if (!replenished && i + 20 < quotes.length) {
            const lastCheck = quotes[Math.min(i + 20, quotes.length - 1)];
            if (Number(lastCheck.askQty) > Number(curr.askQty)) {
              askPartialReplenish++;
            }
          }
        }
      }

      const avgBidReplenish = bidReplenishTimes.length > 0
        ? bidReplenishTimes.reduce((a, b) => a + b, 0) / bidReplenishTimes.length / 1000
        : 0;
      const avgAskReplenish = askReplenishTimes.length > 0
        ? askReplenishTimes.reduce((a, b) => a + b, 0) / askReplenishTimes.length / 1000
        : 0;
      const bidFullReplenishRate = bidConsumptions > 0
        ? (bidReplenishTimes.length / bidConsumptions * 100)
        : 0;
      const askFullReplenishRate = askConsumptions > 0
        ? (askReplenishTimes.length / askConsumptions * 100)
        : 0;

      results.push({
        instrument: inst.instrumentKey,
        days: inst.days_active,
        events: quotes.length,
        bidConsumptions,
        askConsumptions,
        avgBidReplenishSec: avgBidReplenish.toFixed(1),
        avgAskReplenishSec: avgAskReplenish.toFixed(1),
        bidFullRate: bidFullReplenishRate.toFixed(0),
        askFullRate: askFullReplenishRate.toFixed(0),
        bidPartial: bidPartialReplenish,
        askPartial: askPartialReplenish,
      });
    }

    // Print results
    console.log('Instrument                      | Days | Evts | Bid Cons | Ask Cons | Bid Repl(s) | Ask Repl(s) | Bid Full% | Ask Full%');
    console.log('--------------------------------|------|------|----------|----------|-------------|-------------|-----------|----------');
    for (const r of results) {
      console.log(
        `${r.instrument.padEnd(31)}| ${String(r.days).padStart(4)} | ${String(r.events).padStart(4)} | ${String(r.bidConsumptions).padStart(8)} | ${String(r.askConsumptions).padStart(8)} | ${String(r.avgBidReplenishSec).padStart(11)} | ${String(r.avgAskReplenishSec).padStart(11)} | ${String(r.bidFullRate).padStart(8)}% | ${String(r.askFullRate).padStart(8)}%`
      );
    }

    // Aggregate
    const totalBidCons = results.reduce((s, r) => s + r.bidConsumptions, 0);
    const totalAskCons = results.reduce((s, r) => s + r.askConsumptions, 0);
    const avgBidR = results.filter(r => Number(r.avgBidReplenishSec) > 0);
    const avgAskR = results.filter(r => Number(r.avgAskReplenishSec) > 0);

    console.log(`\n--- Aggregate Summary ---`);
    console.log(`Total bid consumptions: ${totalBidCons}`);
    console.log(`Total ask consumptions: ${totalAskCons}`);
    if (avgBidR.length > 0) {
      const meanBid = avgBidR.reduce((s, r) => s + Number(r.avgBidReplenishSec), 0) / avgBidR.length;
      console.log(`Avg bid replenishment time: ${meanBid.toFixed(1)}s (across ${avgBidR.length} instruments)`);
    }
    if (avgAskR.length > 0) {
      const meanAsk = avgAskR.reduce((s, r) => s + Number(r.avgAskReplenishSec), 0) / avgAskR.length;
      console.log(`Avg ask replenishment time: ${meanAsk.toFixed(1)}s (across ${avgAskR.length} instruments)`);
    }
    console.log(`Partial replenishment events tracked (bid/ask combined).`);

    await markDone(56,
      `Liquidity replenishment tracked across ${results.length} instruments. ` +
      `Bid consumptions: ${totalBidCons}, ask consumptions: ${totalAskCons}. ` +
      `Full replenishment rates and avg times computed. ` +
      `Partial replenishment also tracked.`
    );
  } finally {
    await conn.end();
  }
})();
