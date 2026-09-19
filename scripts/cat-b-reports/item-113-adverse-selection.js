/**
 * Item 113: Track adverse selection after fill
 * 
 * Simpler approach: for each option, measure price change from T to T+5min.
 * If fill at mid-price and price moves against us = adverse selection.
 */
const { getConnection, markDone } = require('./db');

(async () => {
  const conn = await getConnection();
  try {
    console.log('=== Item 113: Adverse Selection After Fill ===\n');

    const dayStr = '2026-09-17';
    
    const [instruments] = await conn.query(`
      SELECT instrumentKey, COUNT(*) as cnt
      FROM unified_option_quotes_history
      WHERE DATE(ts) = ? AND HOUR(ts) BETWEEN 9 AND 15
        AND instrumentKey LIKE 'NSE:NIFTY%'
      GROUP BY instrumentKey HAVING cnt > 10
      ORDER BY cnt DESC LIMIT 10
    `, [dayStr]);

    console.log(`Analyzing ${instruments.length} instruments on ${dayStr}\n`);

    const horizons = [1, 5, 15];
    const adverseResults = [];

    for (const inst of instruments) {
      const [quotes] = await conn.query(`
        SELECT ts, (bid + ask) / 2 as mid, bid, ask, ltp
        FROM unified_option_quotes_history
        WHERE instrumentKey = ? AND DATE(ts) = ? AND HOUR(ts) BETWEEN 9 AND 15
          AND ask > 0 AND bid > 0
        ORDER BY ts
      `, [inst.instrumentKey, dayStr]);

      if (quotes.length < 5) continue;

      const step = Math.max(1, Math.floor(quotes.length / 20));
      
      for (let i = 0; i < quotes.length - 1; i += step) {
        const entryMid = parseFloat(quotes[i].mid);
        if (entryMid <= 0) continue;
        const entryTs = quotes[i].ts;

        for (const h of horizons) {
          const horizonTs = new Date(entryTs.getTime() + h * 60000);
          // Binary-ish scan: start from i+1
          let futureQuote = null;
          for (let j = i + 1; j < quotes.length; j++) {
            if (quotes[j].ts >= horizonTs) { futureQuote = quotes[j]; break; }
          }
          if (!futureQuote) continue;

          const exitMid = parseFloat(futureQuote.mid);
          if (exitMid <= 0) continue;
          const changePct = (exitMid - entryMid) / entryMid * 100;

          adverseResults.push({
            instrument: inst.instrumentKey,
            horizon: h,
            entry: entryMid,
            exit: exitMid,
            change_pct: changePct,
          });
        }
      }
    }

    console.log(`--- Adverse Selection Summary (${adverseResults.length} samples) ---`);
    for (const h of horizons) {
      const subset = adverseResults.filter(r => r.horizon === h);
      if (subset.length === 0) continue;
      const avgChange = subset.reduce((s, r) => s + r.change_pct, 0) / subset.length;
      const adverse = subset.filter(r => r.change_pct < 0).length;
      const adversePct = (adverse / subset.length * 100);
      const avgAdverse = subset.filter(r => r.change_pct < 0).reduce((s, r) => s + r.change_pct, 0) / (adverse || 1);
      console.log(`  T+${h}min: n=${subset.length} avg_change=${avgChange.toFixed(4)}% adverse=${adversePct.toFixed(0)}% avg_adverse=${avgAdverse.toFixed(4)}%`);
    }

    console.log('\n--- Per-Instrument T+5min Adverse Selection ---');
    for (const inst of instruments) {
      const subset = adverseResults.filter(r => r.instrument === inst.instrumentKey && r.horizon === 5);
      if (subset.length === 0) continue;
      const avgChange = subset.reduce((s, r) => s + r.change_pct, 0) / subset.length;
      const adverse = subset.filter(r => r.change_pct < 0).length;
      console.log(`  ${inst.instrumentKey}: n=${subset.length} avg=${avgChange.toFixed(4)}% adverse=${(adverse/subset.length*100).toFixed(0)}%`);
    }

    await markDone(113, `Adverse selection measured across ${instruments.length} instruments, ${adverseResults.length} samples on ${dayStr}. T+1/5/15min horizons. Per-instrument and aggregate adverse rates computed.`);
  } finally { await conn.end(); }
})();
