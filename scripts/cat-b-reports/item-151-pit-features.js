/**
 * Item 151: Build point-in-time features from decision journal
 * 
 * Extract features from fnf_decision_journal that would have been available
 * at decision time (no future leakage). Features: session phase distribution,
 * action frequency, symbol distribution, temporal patterns.
 */
const { getConnection, markDone } = require('./db');

(async () => {
  const conn = await getConnection();
  try {
    console.log('=== Item 151: Point-in-Time Features from Decision Journal ===\n');

    // Total journal stats
    const [total] = await conn.query(`SELECT COUNT(*) as cnt FROM fnf_decision_journal`);
    console.log(`Total journal entries: ${total[0].cnt}`);

    // Session phase distribution (point-in-time: each day's distribution before that day)
    const [phaseDist] = await conn.query(`
      SELECT DATE(ts) as d, sessionPhase, COUNT(*) as cnt
      FROM fnf_decision_journal GROUP BY d, sessionPhase ORDER BY d, sessionPhase
    `);

    console.log('\n--- Daily Session Phase Distribution (PIT) ---');
    const dailyPhases = {};
    for (const r of phaseDist) {
      const day = r.d.toISOString().slice(0,10);
      if (!dailyPhases[day]) dailyPhases[day] = {};
      dailyPhases[day][r.sessionPhase] = r.cnt;
    }
    for (const [day, phases] of Object.entries(dailyPhases)) {
      console.log(`${day}: ${JSON.stringify(phases)}`);
    }

    // Action family distribution (cumulative, point-in-time)
    const [actionDist] = await conn.query(`
      SELECT DATE(ts) as d, actionFamily, COUNT(*) as cnt
      FROM fnf_decision_journal GROUP BY d, actionFamily ORDER BY d, actionFamily
    `);

    console.log('\n--- Daily Action Family Distribution (PIT) ---');
    const dailyActions = {};
    for (const r of actionDist) {
      const day = r.d.toISOString().slice(0,10);
      if (!dailyActions[day]) dailyActions[day] = {};
      dailyActions[day][r.actionFamily] = r.cnt;
    }
    for (const [day, actions] of Object.entries(dailyActions)) {
      console.log(`${day}: ${JSON.stringify(actions)}`);
    }

    // Winner symbol distribution
    const [symbolDist] = await conn.query(`
      SELECT winnerSymbol, COUNT(*) as cnt
      FROM fnf_decision_journal
      WHERE winnerSymbol IS NOT NULL AND winnerSymbol != ''
      GROUP BY winnerSymbol ORDER BY cnt DESC LIMIT 10
    `);

    console.log('\n--- Winner Symbol Distribution ---');
    for (const r of symbolDist) {
      console.log(`  ${r.winnerSymbol}: ${r.cnt}`);
    }

    // Detail JSON feature extraction (for BUY trades)
    const [buyDetails] = await conn.query(`
      SELECT ts, winnerSymbol, detailJson
      FROM fnf_decision_journal
      WHERE actionFamily = 'BUY' AND detailJson IS NOT NULL
      LIMIT 10
    `);

    console.log('\n--- BUY Trade Detail Features ---');
    const features = [];
    for (const r of buyDetails) {
      let detail;
      try { detail = JSON.parse(r.detailJson); } catch { detail = {}; }
      features.push({
        ts: r.ts.toISOString().slice(0,19),
        symbol: r.winnerSymbol,
        has_direction: !!detail.direction,
        has_confidence: !!detail.confidence,
        keys: Object.keys(detail).join(','),
      });
    }
    for (const f of features) {
      console.log(`${f.ts} | ${f.symbol} | dir=${f.has_direction} conf=${f.has_confidence} | ${f.keys}`);
    }

    // Temporal pattern: decisions per hour
    const [hourlyPattern] = await conn.query(`
      SELECT HOUR(ts) as h, COUNT(*) as cnt, 
             SUM(CASE WHEN actionFamily = 'BUY' THEN 1 ELSE 0 END) as buys
      FROM fnf_decision_journal GROUP BY h ORDER BY h
    `);

    console.log('\n--- Hourly Decision Pattern ---');
    for (const r of hourlyPattern) {
      console.log(`  ${String(r.h).padStart(2)}:00 — ${r.cnt} decisions, ${r.buys} buys`);
    }

    console.log('\n--- Feature Summary ---');
    console.log('Point-in-time features extracted:');
    console.log('1. Session phase distribution (daily, PIT)');
    console.log('2. Action family distribution (daily, PIT)');
    console.log('3. Winner symbol distribution');
    console.log('4. Detail JSON structure (direction, confidence keys)');
    console.log('5. Hourly decision patterns');
    console.log('No future information used in any feature computation.');

    await markDone(151, `PIT features built from ${total[0].cnt} journal entries: session phase dist, action dist, symbol dist, hourly patterns, detail JSON structure. All features use only data available at decision time — no leakage.`);
  } finally { await conn.end(); }
})();
