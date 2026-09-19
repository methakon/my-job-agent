/**
 * Item 55: Track cancellation rate and quote-event intensity.
 *
 * Measures how frequently quotes change (event intensity) and how often
 * bid/ask updates represent cancellations (quote appears then disappears)
 * vs new quotes. Uses consecutive snapshots of the same instrument.
 */
const { getConnection, markDone } = require('./db');

(async () => {
  const conn = await getConnection();
  try {
    console.log('=== Item 55: Cancellation Rate & Quote-Event Intensity ===\n');

    // Get top instruments by event count across all days
    const [instruments] = await conn.query(`
      SELECT instrumentKey, COUNT(*) as total_events,
             COUNT(DISTINCT DATE(ts)) as days_active,
             MIN(ts) as first_seen, MAX(ts) as last_seen
      FROM unified_option_quotes_history
      WHERE ts >= '2026-09-09' AND HOUR(ts) BETWEEN 9 AND 16
      GROUP BY instrumentKey
      HAVING total_events > 100 AND days_active >= 2
      ORDER BY total_events DESC
      LIMIT 20
    `);

    console.log(`Top 20 most-active instruments: ${instruments.length}\n`);

    const results = [];

    for (const inst of instruments) {
      // Get all quotes for this instrument across all days
      const [quotes] = await conn.query(`
        SELECT ts, bid, ask, bidQty, askQty, volume, oi
        FROM unified_option_quotes_history
        WHERE instrumentKey = ? AND HOUR(ts) BETWEEN 9 AND 16
        ORDER BY ts
      `, [inst.instrumentKey]);

      if (quotes.length < 3) continue;

      let totalEvents = 0;
      let bidCancellations = 0;
      let askCancellations = 0;
      let bidRefreshes = 0;
      let askRefreshes = 0;
      let priceChanges = 0;
      let totalSpans = [];

      for (let i = 1; i < quotes.length; i++) {
        const prev = quotes[i - 1];
        const curr = quotes[i];
        const spanMs = new Date(curr.ts) - new Date(prev.ts);
        totalSpans.push(spanMs);
        totalEvents++;

        // Bid side analysis
        if (Number(prev.bid) > 0 && Number(curr.bid) > 0) {
          if (Number(curr.bid) < Number(prev.bid)) {
            bidCancellations++; // bid moved down (old bid cancelled)
          } else if (Number(curr.bid) === Number(prev.bid)) {
            if (Number(curr.bidQty) < Number(prev.bidQty)) {
              bidCancellations++; // same price but qty reduced
            } else if (Number(curr.bidQty) > Number(prev.bidQty)) {
              bidRefreshes++; // same price, qty added
            }
          } else {
            bidRefreshes++; // bid moved up (new higher bid)
          }
        }

        // Ask side analysis
        if (Number(prev.ask) > 0 && Number(curr.ask) > 0) {
          if (Number(curr.ask) > Number(prev.ask)) {
            askCancellations++; // ask moved up (old ask cancelled)
          } else if (Number(curr.ask) === Number(prev.ask)) {
            if (Number(curr.askQty) < Number(prev.askQty)) {
              askCancellations++;
            } else if (Number(curr.askQty) > Number(prev.askQty)) {
              askRefreshes++;
            }
          } else {
            askRefreshes++;
          }
        }

        // Price change detection
        if (Number(curr.bid) !== Number(prev.bid) || Number(curr.ask) !== Number(prev.ask)) {
          priceChanges++;
        }
      }

      const avgSpanSec = totalSpans.length > 0
        ? totalSpans.reduce((a, b) => a + b, 0) / totalSpans.length / 1000
        : 0;
      const eventsPerMinute = avgSpanSec > 0 ? 60 / avgSpanSec : 0;
      const totalCancels = bidCancellations + askCancellations;
      const cancelRate = totalEvents > 0 ? (totalCancels / (totalEvents * 2) * 100) : 0;

      results.push({
        instrument: inst.instrumentKey,
        days: inst.days_active,
        totalEvents: quotes.length,
        avgSpanSec: avgSpanSec.toFixed(1),
        eventsPerMin: eventsPerMinute.toFixed(2),
        priceChanges,
        bidCancels: bidCancellations,
        askCancels: askCancellations,
        bidRefreshes,
        askRefreshes,
        cancelRatePct: cancelRate.toFixed(1),
      });
    }

    // Print results
    console.log('Instrument                          | Days | Events | Avg Span | Evts/Min | Price Δ | Bid Canc | Ask Canc | Cancel%');
    console.log('------------------------------------|------|--------|----------|----------|---------|----------|----------|-------');
    for (const r of results.slice(0, 15)) {
      console.log(
        `${r.instrument.padEnd(35)}| ${String(r.days).padStart(4)} | ${String(r.totalEvents).padStart(6)} | ${String(r.avgSpanSec).padStart(8)}s | ${String(r.eventsPerMin).padStart(8)} | ${String(r.priceChanges).padStart(7)} | ${String(r.bidCancels).padStart(8)} | ${String(r.askCancels).padStart(8)} | ${r.cancelRatePct}%`
      );
    }

    // Aggregate summary
    const totalEvts = results.reduce((s, r) => s + r.totalEvents, 0);
    const totalCancels = results.reduce((s, r) => s + Number(r.bidCancels) + Number(r.askCancels), 0);
    const avgCancelRate = results.length > 0
      ? results.reduce((s, r) => s + Number(r.cancelRatePct), 0) / results.length
      : 0;
    const avgEventsPerMin = results.length > 0
      ? results.reduce((s, r) => s + Number(r.eventsPerMin), 0) / results.length
      : 0;

    console.log(`\n--- Aggregate Summary ---`);
    console.log(`Instruments analyzed: ${results.length}`);
    console.log(`Total quote events: ${totalEvts}`);
    console.log(`Total cancellations detected: ${totalCancels}`);
    console.log(`Average cancellation rate: ${avgCancelRate.toFixed(1)}%`);
    console.log(`Average event intensity: ${avgEventsPerMin.toFixed(2)} events/min`);

    await markDone(55,
      `Cancellation rate and quote-event intensity tracked across ${results.length} active instruments. ` +
      `Avg cancel rate: ${avgCancelRate.toFixed(1)}%, avg intensity: ${avgEventsPerMin.toFixed(2)} events/min. ` +
      `Bid/ask cancellation and refresh patterns quantified.`
    );
  } finally {
    await conn.end();
  }
})();
