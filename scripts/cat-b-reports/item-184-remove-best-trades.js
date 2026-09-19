/**
 * Item 184: Remove best trades and stress regime shifts
 * 
 * Robustness test:
 * 1. Remove the best-performing day and recompute strategy metrics
 * 2. Remove top 2 best days and recompute
 * 3. Identify regime shift points and measure strategy performance before/after
 */
const { getConnection, markDone } = require('./db');

(async () => {
  const conn = await getConnection();
  try {
    console.log('=== Item 184: Remove Best Trades & Regime Shift Stress ===\n');

    const [dates] = await conn.query(`
      SELECT DATE(ts) as d FROM unified_market_snapshots_history
      WHERE ts >= '2026-09-10' GROUP BY d ORDER BY d
    `);

    // Compute per-day PnL for FOLLOW strategy
    const dailyPnls = [];
    for (const { d } of dates) {
      const dayStr = d.toISOString().slice(0, 10);
      const [prices] = await conn.query(`
        SELECT ltp, ts FROM unified_market_snapshots_history
        WHERE DATE(ts) = ? AND symbol LIKE 'NSE:NIFTY50%' AND ltp > 0 ORDER BY ts
      `, [dayStr]);
      if (prices.length < 20) continue;

      const pa = prices.map(p => parseFloat(p.ltp));
      const dir = pa[15] > pa[0] ? 'UP' : 'DOWN';
      const eod = pa[pa.length - 1];
      const followPnl = dir === 'UP' ? eod - pa[0] : pa[0] - eod;
      const fadePnl = dir === 'UP' ? pa[0] - eod : eod - pa[0];

      dailyPnls.push({
        date: dayStr,
        follow_pnl_pct: (followPnl / pa[0] * 100),
        fade_pnl_pct: (fadePnl / pa[0] * 100),
      });
    }

    // Baseline metrics
    const baseAvgFollow = dailyPnls.reduce((s, r) => s + r.follow_pnl_pct, 0) / dailyPnls.length;
    const baseAvgFade = dailyPnls.reduce((s, r) => s + r.fade_pnl_pct, 0) / dailyPnls.length;
    const baseFollowWins = dailyPnls.filter(r => r.follow_pnl_pct > 0).length;

    console.log(`--- Baseline (${dailyPnls.length} days) ---`);
    console.log(`FOLLOW avg: ${baseAvgFollow.toFixed(3)}%, win rate: ${baseFollowWins}/${dailyPnls.length}`);
    console.log(`FADE avg: ${baseAvgFade.toFixed(3)}%\n`);

    // Remove best trade
    const sortedFollow = [...dailyPnls].sort((a, b) => b.follow_pnl_pct - a.follow_pnl_pct);
    
    for (const removeCount of [1, 2]) {
      const remaining = dailyPnls.filter(p => !sortedFollow.slice(0, removeCount).some(r => r.date === p.date));
      const avgFollow = remaining.reduce((s, r) => s + r.follow_pnl_pct, 0) / remaining.length;
      const avgFade = remaining.reduce((s, r) => s + r.fade_pnl_pct, 0) / remaining.length;
      const followWins = remaining.filter(r => r.follow_pnl_pct > 0).length;

      console.log(`--- Remove Top ${removeCount} Best FOLLOW Day(s) ---`);
      console.log(`Removed: ${sortedFollow.slice(0, removeCount).map(r => `${r.date}(${r.follow_pnl_pct.toFixed(3)}%)`).join(', ')}`);
      console.log(`Remaining: ${remaining.length} days`);
      console.log(`FOLLOW avg: ${avgFollow.toFixed(3)}% (was ${baseAvgFollow.toFixed(3)}%), win: ${followWins}/${remaining.length}`);
      console.log(`FADE avg: ${avgFade.toFixed(3)}% (was ${baseAvgFade.toFixed(3)}%)\n`);
    }

    // Regime shift detection
    console.log('--- Regime Shift Detection ---');
    const regimes = [];
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

      const pnl = dailyPnls.find(p => p.date === dayStr);
      regimes.push({ date: dayStr, regime, follow: pnl?.follow_pnl_pct, fade: pnl?.fade_pnl_pct });
    }

    // Find shifts
    for (let i = 1; i < regimes.length; i++) {
      if (regimes[i].regime !== regimes[i-1].regime) {
        console.log(`SHIFT: ${regimes[i-1].date}(${regimes[i-1].regime}) → ${regimes[i].date}(${regimes[i].regime})`);
        // Measure performance before and after
        const before = regimes.slice(Math.max(0, i-3), i);
        const after = regimes.slice(i, i+3);
        const beforeAvg = before.reduce((s, r) => s + (r.follow || 0), 0) / before.length;
        const afterAvg = after.reduce((s, r) => s + (r.follow || 0), 0) / after.length;
        console.log(`  Before FOLLOW avg: ${beforeAvg.toFixed(3)}%, After: ${afterAvg.toFixed(3)}%`);
      }
    }

    console.log('\nRegime timeline:');
    for (const r of regimes) {
      console.log(`  ${r.date}: ${r.regime} (FOLLOW=${r.follow?.toFixed(3)}% FADE=${r.fade?.toFixed(3)}%)`);
    }

    await markDone(184, `Robustness: removed top-1 and top-2 best days. Regime shifts identified between ${regimes.length} days. FOLLOW avg without best day(s) recomputed. Shift impact on strategy performance measured.`);
  } finally { await conn.end(); }
})();
