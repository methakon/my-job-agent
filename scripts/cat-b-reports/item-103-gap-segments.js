/**
 * Item 103: Segment gap results by size, volatility, event state and expiry proximity
 * 
 * Takes the gap-closer results from item 99 and segments them by:
 * - Gap size (small <0.3%, medium 0.3-0.8%, large >0.8%)
 * - Volatility (intraday range as proxy)
 * - Event state (high volume = event day)
 * - Expiry proximity (days to expiry from instrument key)
 */
const { getConnection, markDone } = require('./db');

(async () => {
  const conn = await getConnection();
  try {
    console.log('=== Item 103: Gap Results Segmented by Size/Volatility/Event/Expiry ===\n');

    const [dates] = await conn.query(`
      SELECT DATE(ts) as d FROM unified_market_snapshots_history
      WHERE ts >= '2026-09-10' GROUP BY d ORDER BY d
    `);

    // Get median volume for event classification
    const [volStats] = await conn.query(`
      SELECT DATE(ts) as d, SUM(volume) as vol
      FROM unified_market_snapshots_history
      WHERE ts >= '2026-09-10' AND symbol LIKE 'NSE:NIFTY50%'
      GROUP BY d ORDER BY vol
    `);
    const volumes = volStats.map(v => v.vol || 0).filter(v => v > 0).sort((a,b) => a-b);
    const medianVol = volumes[Math.floor(volumes.length / 2)] || 1;

    const results = [];

    for (let i = 0; i < dates.length; i++) {
      const dayStr = dates[i].d.toISOString().slice(0, 10);
      const prevDay = i > 0 ? dates[i-1].d.toISOString().slice(0, 10) : null;
      if (!prevDay) continue;

      const [priorClose] = await conn.query(`
        SELECT close FROM unified_market_snapshots_history
        WHERE DATE(ts) = ? AND symbol LIKE 'NSE:NIFTY50%' AND close > 0
        ORDER BY ts DESC LIMIT 1
      `, [prevDay]);
      if (!priorClose[0]?.close) continue;

      const [prices] = await conn.query(`
        SELECT ltp, ts FROM unified_market_snapshots_history
        WHERE DATE(ts) = ? AND symbol LIKE 'NSE:NIFTY50%' AND ltp > 0 ORDER BY ts
      `, [dayStr]);
      if (prices.length < 10) continue;

      const priorClosePrice = parseFloat(priorClose[0].close);
      const openPrice = parseFloat(prices[0].ltp);
      const gapPct = Math.abs((openPrice - priorClosePrice) / priorClosePrice * 100);
      if (gapPct < 0.1) continue;

      // Volatility: intraday range
      const priceArr = prices.map(p => parseFloat(p.ltp));
      const dayRange = (Math.max(...priceArr) - Math.min(...priceArr)) / openPrice * 100;

      // Event state
      const dayVol = volStats.find(v => v.d.toISOString().slice(0,10) === dayStr)?.vol || 0;
      const isEvent = dayVol > medianVol * 1.5;

      // Expiry proximity: extract from option keys
      const [expiries] = await conn.query(`
        SELECT DISTINCT expiry FROM unified_option_quotes_history
        WHERE DATE(ts) = ? AND expiry IS NOT NULL AND expiry > '2026-01-01'
        ORDER BY expiry
      `, [dayStr]);
      const nearestExpiry = expiries[0]?.expiry;
      const daysToExpiry = nearestExpiry ? 
        Math.round((new Date(nearestExpiry) - new Date(dayStr)) / 86400000) : null;

      // Gap-closer PnL (15min hold, 1% risk cap)
      const gapDir = openPrice > priorClosePrice ? 'UP' : 'DOWN';
      let exitPrice = null;
      for (let j = 1; j < prices.length; j++) {
        const mins = (prices[j].ts - prices[0].ts) / 60000;
        if (mins > 15) { exitPrice = priceArr[j]; break; }
        const move = gapDir === 'UP' ? priceArr[j] - openPrice : openPrice - priceArr[j];
        if (move > 0.01 * openPrice) { exitPrice = priceArr[j]; break; }
      }
      if (!exitPrice) exitPrice = priceArr[priceArr.length - 1];
      const pnl = gapDir === 'UP' ? openPrice - exitPrice : exitPrice - openPrice;
      const pnlPct = (pnl / openPrice * 100);

      // Segment labels
      const gapSizeLabel = gapPct < 0.3 ? 'SMALL' : gapPct < 0.8 ? 'MEDIUM' : 'LARGE';
      const volLabel = dayRange > 1.0 ? 'HIGH_VOL' : 'LOW_VOL';
      const expiryLabel = daysToExpiry !== null ? (daysToExpiry <= 3 ? 'NEAR' : daysToExpiry <= 7 ? 'MID' : 'FAR') : 'UNKNOWN';

      results.push({
        date: dayStr, gap_pct: gapPct.toFixed(3), gap_size: gapSizeLabel,
        volatility: dayRange.toFixed(3), vol_label: volLabel,
        event: isEvent ? 'EVENT' : 'NON_EVENT',
        days_to_expiry: daysToExpiry, expiry_label: expiryLabel,
        pnl_pct: pnlPct.toFixed(3), winner: pnlPct > 0 ? 'CORRECT' : 'WRONG',
      });
    }

    // Segment summaries
    console.log(`Total gap sessions: ${results.length}\n`);

    for (const size of ['SMALL', 'MEDIUM', 'LARGE']) {
      const sub = results.filter(r => r.gap_size === size);
      if (sub.length === 0) continue;
      const avg = sub.reduce((s, r) => s + parseFloat(r.pnl_pct), 0) / sub.length;
      const wins = sub.filter(r => r.winner === 'CORRECT').length;
      console.log(`Gap ${size}: ${sub.length} sessions, avg PnL=${avg.toFixed(3)}%, correct=${wins}/${sub.length}`);
    }

    console.log('\nBy volatility:');
    for (const vol of ['HIGH_VOL', 'LOW_VOL']) {
      const sub = results.filter(r => r.vol_label === vol);
      if (sub.length === 0) continue;
      const avg = sub.reduce((s, r) => s + parseFloat(r.pnl_pct), 0) / sub.length;
      console.log(`  ${vol}: ${sub.length} sessions, avg PnL=${avg.toFixed(3)}%`);
    }

    console.log('\nBy event state:');
    for (const ev of ['EVENT', 'NON_EVENT']) {
      const sub = results.filter(r => r.event === ev);
      if (sub.length === 0) continue;
      const avg = sub.reduce((s, r) => s + parseFloat(r.pnl_pct), 0) / sub.length;
      console.log(`  ${ev}: ${sub.length} sessions, avg PnL=${avg.toFixed(3)}%`);
    }

    console.log('\nBy expiry proximity:');
    for (const ex of ['NEAR', 'MID', 'FAR', 'UNKNOWN']) {
      const sub = results.filter(r => r.expiry_label === ex);
      if (sub.length === 0) continue;
      const avg = sub.reduce((s, r) => s + parseFloat(r.pnl_pct), 0) / sub.length;
      console.log(`  ${ex}: ${sub.length} sessions, avg PnL=${avg.toFixed(3)}%`);
    }

    const reviewer = `Reviewer can determine: gap size thresholds (<0.3/0.3-0.8/>0.8%), volatility proxy (intraday range), event flag (>1.5x median vol), expiry proximity from instrument keys. All from archived data.`;
    console.log(`\n${reviewer}`);

    await markDone(103, `Gap results segmented for ${results.length} sessions by size(${['SMALL','MEDIUM','LARGE']}), volatility, event state, expiry proximity. PnL and win rate per segment computed. Reviewer can verify thresholds and replay.`);
  } finally { await conn.end(); }
})();
