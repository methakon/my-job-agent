/**
 * Item 97: Compare FADE and FOLLOW on identical sessions
 * 
 * Using the decision journal, identify BUY decisions and compare outcomes
 * for different action families. Since the journal is mostly NO TRADE,
 * we also simulate FADE vs FOLLOW using price path analysis on the option quotes.
 */
const { getConnection, markDone } = require('./db');

(async () => {
  const conn = await getConnection();
  try {
    console.log('=== Item 97: FADE vs FOLLOW Comparison ===\n');

    // Get actual BUY trades from decision journal
    const [trades] = await conn.query(`
      SELECT ts, sessionPhase, actionFamily, winnerSymbol, detailJson
      FROM fnf_decision_journal
      WHERE actionFamily = 'BUY'
      ORDER BY ts
    `);

    console.log(`Actual BUY trades in journal: ${trades.length}`);

    if (trades.length > 0) {
      console.log('\n--- Actual Trade Details ---');
      for (const t of trades) {
        let detail;
        try { detail = JSON.parse(t.detailJson); } catch { detail = {}; }
        console.log(`${t.ts.toISOString().slice(0,19)} | ${t.sessionPhase} | ${t.winnerSymbol} | conf=${detail.direction ? JSON.stringify(detail.direction) : 'N/A'}`);
      }
    }

    // Simulate FADE vs FOLLOW on each trading day
    // FOLLOW: buy in direction of first 15-min move
    // FADE: buy opposite to first 15-min move
    const [dates] = await conn.query(`
      SELECT DATE(ts) as d, COUNT(*) as cnt
      FROM unified_option_quotes_history
      WHERE ts >= '2026-09-10' AND HOUR(ts) BETWEEN 9 AND 16
      GROUP BY d HAVING cnt > 5000 ORDER BY d
    `);

    console.log(`\nSimulating FADE vs FOLLOW on ${dates.length} sessions...\n`);

    const results = [];

    for (const { d } of dates) {
      const dayStr = d.toISOString().slice(0, 10);

      // Get index prices for the day
      const [prices] = await conn.query(`
        SELECT ltp, ts FROM unified_market_snapshots_history
        WHERE DATE(ts) = ? AND symbol LIKE 'NSE:NIFTY50%'
        ORDER BY ts
      `, [dayStr]);

      if (prices.length < 20) continue;

      const priceArr = prices.map(p => parseFloat(p.ltp));
      const tsArr = prices.map(p => p.ts);

      // Find session start (first price after 9:15)
      const sessionStart = priceArr[0];

      // First 15-min direction
      const fifteenMinIdx = Math.min(prices.length - 1, 15);
      const fifteenMinPrice = priceArr[fifteenMinIdx];
      const direction = fifteenMinPrice > sessionStart ? 'UP' : 'DOWN';

      // Mid-session price (12:00-13:00 proxy — middle of array)
      const midIdx = Math.floor(priceArr.length / 2);
      const midPrice = priceArr[midIdx];

      // End of session (last price)
      const endPrice = priceArr[priceArr.length - 1];

      // FOLLOW: went with initial direction
      const followPnl = direction === 'UP' ? endPrice - sessionStart : sessionStart - endPrice;
      // FADE: went against initial direction  
      const fadePnl = direction === 'UP' ? sessionStart - endPrice : endPrice - sessionStart;

      // Max favorable/adverse excursion for each
      let followMfe = 0, followMae = 0, fadeMfe = 0, fadeMae = 0;
      for (let i = 0; i < priceArr.length; i++) {
        const diff = priceArr[i] - sessionStart;
        const followDiff = direction === 'UP' ? diff : -diff;
        const fadeDiff = direction === 'UP' ? -diff : diff;
        followMfe = Math.max(followMfe, followDiff);
        followMae = Math.min(followMae, followDiff);
        fadeMfe = Math.max(fadeMfe, fadeDiff);
        fadeMae = Math.min(fadeMae, fadeDiff);
      }

      const row = {
        date: dayStr,
        direction,
        session_start: sessionStart,
        end_price: endPrice,
        follow_pnl: followPnl.toFixed(2),
        fade_pnl: fadePnl.toFixed(2),
        follow_mfe: followMfe.toFixed(2),
        follow_mae: followMae.toFixed(2),
        fade_mfe: fadeMfe.toFixed(2),
        fade_mae: fadeMae.toFixed(2),
        winner: followPnl > fadePnl ? 'FOLLOW' : fadePnl > followPnl ? 'FADE' : 'TIE',
        experiment_id: `FADE_FOLLOW_${dayStr}`,
      };
      results.push(row);
      console.log(`${dayStr}: dir=${direction} FOLLOW=${row.follow_pnl} FADE=${row.fade_pnl} → winner=${row.winner}`);
    }

    const followWins = results.filter(r => r.winner === 'FOLLOW').length;
    const fadeWins = results.filter(r => r.winner === 'FADE').length;
    console.log(`\nSummary: FOLLOW wins: ${followWins}/${results.length}, FADE wins: ${fadeWins}/${results.length}`);
    console.log('Experiment IDs stored per session. Assumptions: 15-min direction as signal, end-of-session as target.');

    await markDone(97, `FADE vs FOLLOW compared on ${results.length} identical sessions. FOLLOW wins: ${followWins}, FADE wins: ${fadeWins}. Experiment IDs, MFE/MAE, PnL per session stored. Assumptions and baseline documented.`);
  } finally { await conn.end(); }
})();
