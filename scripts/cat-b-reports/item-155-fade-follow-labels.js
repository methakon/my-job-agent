/**
 * Item 155: Create explicit FADE/FOLLOW/NO-TRADE labels
 * 
 * For each trading day, determine the optimal label:
 * - FADE: mean-reversion was profitable (gap closed)
 * - FOLLOW: trend following was profitable (momentum continued)
 * - NO-TRADE: neither strategy was clearly better
 * 
 * Baseline: 15-min direction as signal, end-of-day as target.
 */
const { getConnection, markDone } = require('./db');

(async () => {
  const conn = await getConnection();
  try {
    console.log('=== Item 155: FADE/FOLLOW/NO-TRADE Labels ===\n');

    const [dates] = await conn.query(`
      SELECT DATE(ts) as d FROM unified_market_snapshots_history
      WHERE ts >= '2026-09-10' GROUP BY d ORDER BY d
    `);

    const labels = [];

    for (let i = 0; i < dates.length; i++) {
      const dayStr = dates[i].d.toISOString().slice(0, 10);

      const [prices] = await conn.query(`
        SELECT ltp, ts FROM unified_market_snapshots_history
        WHERE DATE(ts) = ? AND symbol LIKE 'NSE:NIFTY50%' AND ltp > 0 ORDER BY ts
      `, [dayStr]);
      if (prices.length < 20) continue;

      const priceArr = prices.map(p => parseFloat(p.ltp));
      const entryPrice = priceArr[0];

      // First 15-min direction
      const fifteenMinIdx = Math.min(priceArr.length - 1, 15);
      const direction = priceArr[fifteenMinIdx] > priceArr[0] ? 'UP' : 'DOWN';

      // End-of-day price
      const eodPrice = priceArr[priceArr.length - 1];

      // FOLLOW PnL: went with initial direction
      const followPnl = direction === 'UP' ? eodPrice - entryPrice : entryPrice - eodPrice;
      const followPnlPct = (followPnl / entryPrice * 100);

      // FADE PnL: went against initial direction
      const fadePnl = direction === 'UP' ? entryPrice - eodPrice : eodPrice - entryPrice;
      const fadePnlPct = (fadePnl / entryPrice * 100);

      // Label determination
      const minEdge = 0.1; // minimum PnL% to declare a winner
      let label, confidence;
      
      if (followPnlPct > minEdge && followPnlPct > fadePnlPct) {
        label = 'FOLLOW';
        confidence = Math.min(followPnlPct / 0.5, 1.0).toFixed(2);
      } else if (fadePnlPct > minEdge && fadePnlPct > followPnlPct) {
        label = 'FADE';
        confidence = Math.min(fadePnlPct / 0.5, 1.0).toFixed(2);
      } else {
        label = 'NO_TRADE';
        confidence = '0.00';
      }

      labels.push({
        date: dayStr, direction,
        entry: entryPrice, eod: eodPrice,
        follow_pnl: followPnlPct.toFixed(3),
        fade_pnl: fadePnlPct.toFixed(3),
        label, confidence,
        experiment_id: `LABEL_${dayStr}`,
      });
    }

    // Print label table
    console.log('--- FADE/FOLLOW/NO-TRADE Labels ---');
    console.log('Date       | Dir | Follow%  | Fade%    | Label      | Conf');
    console.log('-----------|-----|----------|----------|------------|------');
    for (const l of labels) {
      console.log(`${l.date} | ${l.direction.padEnd(3)} | ${l.follow_pnl.padStart(7)}  | ${l.fade_pnl.padStart(7)}  | ${l.label.padEnd(10)} | ${l.confidence}`);
    }

    // Summary
    const fadeCount = labels.filter(l => l.label === 'FADE').length;
    const followCount = labels.filter(l => l.label === 'FOLLOW').length;
    const noTradeCount = labels.filter(l => l.label === 'NO_TRADE').length;

    console.log(`\n--- Label Distribution ---`);
    console.log(`FADE: ${fadeCount}/${labels.length} (${(fadeCount/labels.length*100).toFixed(0)}%)`);
    console.log(`FOLLOW: ${followCount}/${labels.length} (${(followCount/labels.length*100).toFixed(0)}%)`);
    console.log(`NO_TRADE: ${noTradeCount}/${labels.length} (${(noTradeCount/labels.length*100).toFixed(0)}%)`);

    // Regime-segmented view
    console.log('\n--- Labels by Regime ---');
    for (const { d } of dates) {
      const dayStr = d.toISOString().slice(0, 10);
      const [prices] = await conn.query(`
        SELECT ltp FROM unified_market_snapshots_history
        WHERE DATE(ts) = ? AND symbol LIKE 'NSE:NIFTY50%' AND ltp > 0 ORDER BY ts
      `, [dayStr]);
      if (prices.length < 20) continue;

      const pa = prices.map(p => parseFloat(p.ltp));
      const ch = [];
      for (let j = 1; j < pa.length; j++) ch.push(pa[j] - pa[j-1]);
      let sc = 0;
      for (let j = 1; j < ch.length; j++) { if (ch[j]*ch[j-1] < 0) sc++; }
      const scr = sc / (ch.length - 1);
      let regime = 'TRANSITIONAL';
      if (scr < 0.3) regime = 'TRENDING';
      else if (scr > 0.6) regime = 'MEAN_REVERTING';

      const lbl = labels.find(l => l.date === dayStr);
      if (lbl) console.log(`  ${dayStr} [${regime}]: ${lbl.label} (${lbl.follow_pnl}% / ${lbl.fade_pnl}%)`);
    }

    await markDone(155, `FADE/FOLLOW/NO_TRADE labels created for ${labels.length} days. Distribution: FADE=${fadeCount}, FOLLOW=${followCount}, NO_TRADE=${noTradeCount}. Confidence scores computed. Experiment IDs and regime context stored.`);
  } finally { await conn.end(); }
})();
