// Pattern-engine + feed verification against the live MySQL (3307).
require('dotenv').config();
const mysql = require('mysql2/promise');

(async () => {
  const conn = await mysql.createConnection({
    host: process.env.MYSQL_HOST || '127.0.0.1',
    port: Number(process.env.MYSQL_PORT || 3307),
    user: process.env.MYSQL_USER, password: process.env.MYSQL_PASSWORD,
    database: process.env.LOCAL_DB_NAME || 'myjob_agent',
  });
  const q = async (label, sql, args = []) => {
    try {
      const [rows] = await conn.query(sql, args);
      console.log(`\n== ${label} ==`);
      console.log(JSON.stringify(rows, null, 1).slice(0, 2200));
    } catch (e) { console.log(`\n== ${label} == ERROR: ${e.message}`); }
  };

  await q('tables', "SHOW TABLES LIKE 'pattern%'");
  await q('feed lease tables', "SHOW TABLES LIKE 'market_data_feed%'");
  await q('pattern_signals total', 'SELECT COUNT(*) AS n FROM pattern_signals');
  await q('pattern_signals latest', `SELECT signal, entryState, confidence, contractSymbol, optionType, underlying,
      ROUND(confidence,3) c, consolidationDetected, reason, signalTs, outcomeLabel
      FROM pattern_signals ORDER BY signalTs DESC LIMIT 5`);
  await q('signals only', `SELECT signal, COUNT(*) n, ROUND(AVG(confidence),3) avgConf FROM pattern_signals GROUP BY signal`);
  await q('lease rows', 'SELECT * FROM market_data_feed_lease');
  await q('unified store by source (last 30 min)', `SELECT source, COUNT(*) n, MIN(ts) oldest, MAX(ts) newest
      FROM unified_option_quotes WHERE ts >= NOW() - INTERVAL 30 MINUTE GROUP BY source`);
  await q('upstox mirrored legs', `SELECT underlying, COUNT(DISTINCT instrumentKey) contracts, COUNT(*) n, MAX(ts) newest
      FROM unified_option_quotes WHERE source='UPSTOX_LIVE' GROUP BY underlying`);
  await q('upstox mirrored index snapshots', `SELECT symbol, COUNT(*) n, MAX(ts) newest FROM unified_market_snapshots
      WHERE source='UPSTOX_LIVE' GROUP BY symbol`);
  await q('desk trades', 'SELECT COUNT(*) n FROM upstox_live_paper_trades');
  await conn.end();
})().catch((e) => { console.error('FAILED', e.message); process.exit(1); });
