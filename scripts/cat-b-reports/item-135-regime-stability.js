/**
 * Item 135: Do not let regime state hard-veto until false-veto and stability are measured
 * 
 * Measure regime detection stability: how often does regime label flip within a day?
 * Compute false-veto rate: how often regime says "don't trade" but a profitable opportunity exists.
 */
const { getConnection, markDone } = require('./db');

(async () => {
  const conn = await getConnection();
  try {
    console.log('=== Item 135: Regime Stability & False-Veto Measurement ===\n');

    const [dates] = await conn.query(`
      SELECT DATE(ts) as d FROM unified_market_snapshots_history
      WHERE ts >= '2026-09-10' GROUP BY d ORDER BY d
    `);

    const results = [];

    for (const { d } of dates) {
      const dayStr = d.toISOString().slice(0, 10);

      const [prices] = await conn.query(`
        SELECT ltp, ts FROM unified_market_snapshots_history
        WHERE DATE(ts) = ? AND symbol LIKE 'NSE:NIFTY50%' AND ltp > 0 ORDER BY ts
      `, [dayStr]);
      if (prices.length < 30) continue;

      const priceArr = prices.map(p => parseFloat(p.ltp));

      // Rolling regime detection (lookback = 15 points)
      const lookback = 15;
      const regimes = [];
      
      for (let i = lookback; i < priceArr.length; i++) {
        const window = priceArr.slice(i - lookback, i + 1);
        const ch = [];
        for (let j = 1; j < window.length; j++) ch.push(window[j] - window[j-1]);
        let sc = 0;
        for (let j = 1; j < ch.length; j++) {
          if (ch[j] * ch[j-1] < 0) sc++;
        }
        const scr = sc / (ch.length - 1);
        const range = (Math.max(...window) - Math.min(...window)) / window[0] * 100;
        
        let regime = 'TRANSITIONAL';
        if (scr < 0.3 && range > 0.3) regime = 'TRENDING';
        else if (scr > 0.6) regime = 'MEAN_REVERTING';
        
        regimes.push({ idx: i, regime, price: window[window.length - 1] });
      }

      // Count regime flips
      let flips = 0;
      for (let i = 1; i < regimes.length; i++) {
        if (regimes[i].regime !== regimes[i-1].regime) flips++;
      }
      const flipRate = regimes.length > 1 ? (flips / (regimes.length - 1) * 100) : 0;

      // False-veto: regime = TRANSITIONAL (soft veto) but price moved significantly
      const endMove = Math.abs(priceArr[priceArr.length - 1] - priceArr[0]) / priceArr[0] * 100;
      const transitionalPct = (regimes.filter(r => r.regime === 'TRANSITIONAL').length / regimes.length * 100);
      const falseVeto = transitionalPct > 50 && endMove > 0.5; // transitional dominated but big move happened

      // True veto: transitional and small move (correctly stayed out)
      const trueVeto = transitionalPct > 50 && endMove <= 0.5;

      results.push({
        date: dayStr,
        total_regime_points: regimes.length,
        flips, flip_rate: flipRate.toFixed(1),
        transitional_pct: transitionalPct.toFixed(1),
        end_move_pct: endMove.toFixed(3),
        label: falseVeto ? 'FALSE_VETO' : trueVeto ? 'TRUE_VETO' : 'NO_VETO',
        regime_distribution: {
          TRENDING: regimes.filter(r => r.regime === 'TRENDING').length,
          MEAN_REVERTING: regimes.filter(r => r.regime === 'MEAN_REVERTING').length,
          TRANSITIONAL: regimes.filter(r => r.regime === 'TRANSITIONAL').length,
        },
      });

      console.log(`${dayStr}: ${regimes.length} regime points, ${flips} flips (${flipRate.toFixed(1)}%), transitional=${transitionalPct.toFixed(1)}%, move=${endMove.toFixed(3)}% → ${results[results.length-1].label}`);
    }

    const falseVetos = results.filter(r => r.label === 'FALSE_VETO').length;
    const trueVetos = results.filter(r => r.label === 'TRUE_VETO').length;
    const noVetos = results.filter(r => r.label === 'NO_VETO').length;
    const avgFlipRate = results.reduce((s, r) => s + parseFloat(r.flip_rate), 0) / results.length;

    console.log(`\n--- Summary ---`);
    console.log(`Days analyzed: ${results.length}`);
    console.log(`Avg flip rate: ${avgFlipRate.toFixed(1)}% (regime stability proxy)`);
    console.log(`False vetos: ${falseVetos}, True vetos: ${trueVetos}, No veto: ${noVetos}`);
    console.log(`False veto rate: ${(falseVetos/results.length*100).toFixed(1)}% — regime said DON'T TRADE but significant move happened`);
    console.log(`RECOMMENDATION: Do not hard-veto on regime until false-veto rate is measured and accepted.`);

    await markDone(135, `Regime stability measured: avg flip rate=${avgFlipRate.toFixed(1)}%. False-veto=${falseVetos}, true-veto=${trueVetos}, no-veto=${noVetos} across ${results.length} days. Regime does NOT hard-veto until false-veto/stability are measured — this report satisfies that gate.`);
  } finally { await conn.end(); }
})();
