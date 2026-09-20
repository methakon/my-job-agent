/**
 * Item 133: Measure each skill separately by regime
 * 
 * Skills: FADE (gap close), FOLLOW (trend follow), and NO-TRADE.
 * Regime: TRENDING, MEAN_REVERTING, TRANSITIONAL.
 * For each skill+regime combination, measure PnL, win rate, and frequency.
 */
const { getConnection, markDone } = require('./db');

(async () => {
  const conn = await getConnection();
  try {
    console.log('=== Item 133: Skill Performance by Regime ===\n');

    const [dates] = await conn.query(`
      SELECT DATE(ts) as d FROM unified_market_snapshots_history
      WHERE ts >= '2026-09-10' GROUP BY d ORDER BY d
    `);

    const skillResults = { FADE: [], FOLLOW: [], NO_TRADE: [] };

    for (let i = 0; i < dates.length; i++) {
      const dayStr = dates[i].d.toISOString().slice(0, 10);
      const prevDay = i > 0 ? dates[i-1].d.toISOString().slice(0, 10) : null;

      // Get prices for the day
      const [prices] = await conn.query(`
        SELECT ltp, ts FROM unified_market_snapshots_history
        WHERE DATE(ts) = ? AND symbol LIKE 'NSE:NIFTY50%' AND ltp > 0 ORDER BY ts
      `, [dayStr]);
      if (prices.length < 20) continue;

      const priceArr = prices.map(p => parseFloat(p.ltp));

      // Detect regime (sign-change ratio)
      const changes = [];
      for (let j = 1; j < priceArr.length; j++) changes.push(priceArr[j] - priceArr[j-1]);
      let signChanges = 0;
      for (let j = 1; j < changes.length; j++) {
        if (changes[j] * changes[j-1] < 0) signChanges++;
      }
      const signChangeRatio = signChanges / (changes.length - 1);
      const dayRange = (Math.max(...priceArr) - Math.min(...priceArr)) / priceArr[0] * 100;
      let regime = 'TRANSITIONAL';
      if (signChangeRatio < 0.3 && dayRange > 0.3) regime = 'TRENDING';
      else if (signChangeRatio > 0.6) regime = 'MEAN_REVERTING';

      // First 15-min direction
      const fifteenMinIdx = Math.min(priceArr.length - 1, 15);
      const direction = priceArr[fifteenMinIdx] > priceArr[0] ? 'UP' : 'DOWN';

      // FADE PnL: bet against initial direction
      const fadePnl = direction === 'UP' 
        ? priceArr[0] - priceArr[priceArr.length - 1]
        : priceArr[priceArr.length - 1] - priceArr[0];

      // FOLLOW PnL: bet with initial direction
      const followPnl = direction === 'UP'
        ? priceArr[priceArr.length - 1] - priceArr[0]
        : priceArr[0] - priceArr[priceArr.length - 1];

      const fadePnlPct = (fadePnl / priceArr[0] * 100);
      const followPnlPct = (followPnl / priceArr[0] * 100);

      skillResults.FADE.push({ date: dayStr, regime, pnl_pct: fadePnlPct });
      skillResults.FOLLOW.push({ date: dayStr, regime, pnl_pct: followPnlPct });
      skillResults.NO_TRADE.push({ date: dayStr, regime, pnl_pct: 0 });
    }

    // Print skill-by-regime summary
    const regimes = ['TRENDING', 'MEAN_REVERTING', 'TRANSITIONAL'];
    
    console.log('--- FADE by Regime ---');
    for (const r of regimes) {
      const sub = skillResults.FADE.filter(x => x.regime === r);
      if (sub.length === 0) continue;
      const avg = sub.reduce((s, x) => s + x.pnl_pct, 0) / sub.length;
      const wins = sub.filter(x => x.pnl_pct > 0).length;
      console.log(`  ${r}: ${sub.length} days, avg PnL=${avg.toFixed(3)}%, wins=${wins}/${sub.length}`);
    }

    console.log('\n--- FOLLOW by Regime ---');
    for (const r of regimes) {
      const sub = skillResults.FOLLOW.filter(x => x.regime === r);
      if (sub.length === 0) continue;
      const avg = sub.reduce((s, x) => s + x.pnl_pct, 0) / sub.length;
      const wins = sub.filter(x => x.pnl_pct > 0).length;
      console.log(`  ${r}: ${sub.length} days, avg PnL=${avg.toFixed(3)}%, wins=${wins}/${sub.length}`);
    }

    console.log('\n--- NO_TRADE by Regime ---');
    for (const r of regimes) {
      const sub = skillResults.NO_TRADE.filter(x => x.regime === r);
      if (sub.length === 0) continue;
      console.log(`  ${r}: ${sub.length} days, PnL=0 (no trade)`);
    }

    console.log(`\nTotal days analyzed: ${skillResults.FADE.length}`);
    console.log('Baseline: first 15-min direction as signal, end-of-day as outcome.');

    await markDone(133, `FADE/FOLLOW/NO-TRADE measured by regime (TRENDING/MEAN_REVERTING/TRANSITIONAL) across ${skillResults.FADE.length} days. Regime detected via sign-change ratio and range. PnL and win rate per skill+regime cell computed.`);
  } finally { await conn.end(); }
})();
