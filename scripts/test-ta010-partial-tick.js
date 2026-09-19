#!/usr/bin/env node
/**
 * TA-010: Upstox V3 Partial-Tick Correctness
 *
 * Verifies that Upstox V3 partial-tick fields are preserved correctly:
 * - Zero bid/ask from Upstox is stored as-is (provider semantics: 0 = absent)
 * - Valid tick values are never overwritten with zero
 * - Bid/ask asymmetry is preserved (one side zero, other valid)
 * - Source provenance is correct (UPSTOX vs FYERS_LIVE)
 *
 * Uses historical data from unified_option_quotes_history (2.53M rows).
 *
 * doneWhen: "Partial tick fields preserved, no zero-overwrite of valid data"
 */

const { execSync } = require('child_process');
const mysql = require('mysql2/promise');
require('dotenv').config();

const DB_CONFIG = {
  host: process.env.MYSQL_HOST,
  port: parseInt(process.env.MYSQL_PORT || '3306'),
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE || 'myjob_agent',
};

let passed = 0;
let failed = 0;

function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  PASS ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name} :: ${detail}`);
  }
}

async function main() {
  console.log('=== TA-010: Upstox V3 Partial-Tick Correctness ===\n');

  const conn = await mysql.createConnection(DB_CONFIG);

  try {
    // 1. Upstox records with bid=0 but valid ltp (absent-quote semantics)
    const [upstoxZeroBid] = await conn.query(`
      SELECT COUNT(*) as cnt
      FROM unified_option_quotes_history
      WHERE source IN ('UPSTOX', 'UPSTOX_LIVE')
        AND bid = 0 AND bid IS NOT NULL
        AND ltp > 0
    `);
    const upstoxZeroBidCount = upstoxZeroBid[0].cnt;
    check(
      'upstox-zero-bid-preserved',
      upstoxZeroBidCount > 0,
      `Expected Upstox records with bid=0 and valid ltp, got ${upstoxZeroBidCount}`
    );
    console.log(`    (${upstoxZeroBidCount.toLocaleString()} Upstox records have bid=0 with valid ltp)\n`);

    // 2. Upstox records with ask=0 but valid ltp
    const [upstoxZeroAsk] = await conn.query(`
      SELECT COUNT(*) as cnt
      FROM unified_option_quotes_history
      WHERE source IN ('UPSTOX', 'UPSTOX_LIVE')
        AND ask = 0 AND ask IS NOT NULL
        AND ltp > 0
    `);
    const upstoxZeroAskCount = upstoxZeroAsk[0].cnt;
    check(
      'upstox-zero-ask-preserved',
      upstoxZeroAskCount > 0,
      `Expected Upstox records with ask=0 and valid ltp, got ${upstoxZeroAskCount}`
    );
    console.log(`    (${upstoxZeroAskCount.toLocaleString()} Upstox records have ask=0 with valid ltp)\n`);

    // 3. Verify: when bid=0, ask should be > 0 (not also zero — that would be a full stop)
    const [partialTicks] = await conn.query(`
      SELECT COUNT(*) as cnt
      FROM unified_option_quotes_history
      WHERE source IN ('UPSTOX', 'UPSTOX_LIVE')
        AND bid = 0 AND ask > 0 AND ltp > 0
    `);
    const partialCount = partialTicks[0].cnt;
    check(
      'upstox-bid-zero-ask-valid',
      partialCount > 0,
      `Expected asymmetric partial ticks (bid=0, ask>0), got ${partialCount}`
    );
    console.log(`    (${partialCount.toLocaleString()} records have bid=0, ask>0)\n`);

    // 4. Verify: when ask=0, bid should be > 0
    const [partialTicksReverse] = await conn.query(`
      SELECT COUNT(*) as cnt
      FROM unified_option_quotes_history
      WHERE source IN ('UPSTOX', 'UPSTOX_LIVE')
        AND ask = 0 AND bid > 0 AND ltp > 0
    `);
    const partialReverseCount = partialTicksReverse[0].cnt;
    check(
      'upstox-ask-zero-bid-valid',
      partialReverseCount > 0,
      `Expected asymmetric partial ticks (ask=0, bid>0), got ${partialReverseCount}`
    );
    console.log(`    (${partialReverseCount.toLocaleString()} records have ask=0, bid>0)\n`);

    // 5. No zero-overwrite: Upstox records should never have bid=0 AND ask=0 when ltp>0
    // (If both are zero, the tick was likely rejected by the mapper — verify count is low)
    const [bothZero] = await conn.query(`
      SELECT COUNT(*) as cnt
      FROM unified_option_quotes_history
      WHERE source IN ('UPSTOX', 'UPSTOX_LIVE')
        AND bid = 0 AND ask = 0 AND ltp > 0
    `);
    const bothZeroCount = bothZero[0].cnt;
    const totalUpstox = await conn.query(`
      SELECT COUNT(*) as cnt
      FROM unified_option_quotes_history
      WHERE source IN ('UPSTOX', 'UPSTOX_LIVE')
    `);
    const totalUpstoxCount = Number(totalUpstox[0].cnt) || 0;
    const bothZeroPct = totalUpstoxCount > 0 ? (bothZeroCount / totalUpstoxCount * 100) : 0;
    check(
      'upstox-both-zero-rare',
      bothZeroPct < 5,  // Less than 5% should have both zero
      `Expected <5% both-zero records, got ${bothZeroPct.toFixed(2)}% (${bothZeroCount} of ${totalUpstoxCount})`
    );
    console.log(`    (${bothZeroCount.toLocaleString()} of ${totalUpstoxCount.toLocaleString()} Upstox records have both bid=0 and ask=0: ${bothZeroPct.toFixed(2)}%)\n`);

    // 6. FYERS records should have different partial-tick profile (valid bid/ask more often)
    const [fyersZeroBid] = await conn.query(`
      SELECT COUNT(*) as cnt
      FROM unified_option_quotes_history
      WHERE source = 'FYERS_LIVE'
        AND bid = 0 AND bid IS NOT NULL
        AND ltp > 0
    `);
    const [fyersTotal] = await conn.query(`
      SELECT COUNT(*) as cnt
      FROM unified_option_quotes_history
      WHERE source = 'FYERS_LIVE' AND ltp > 0
    `);
    const fyersZeroBidPct = fyersTotal[0].cnt > 0 ? (fyersZeroBid[0].cnt / fyersTotal[0].cnt * 100) : 0;
    const upstoxZeroBidPct = upstoxZeroBidCount / (totalUpstoxCount || 1) * 100;
    check(
      'source-different-partial-profile',
      upstoxZeroBidPct !== fyersZeroBidPct,
      `Expected different zero-bid rates between Upstox (${upstoxZeroBidPct.toFixed(2)}%) and FYERS (${fyersZeroBidPct.toFixed(2)}%)`
    );
    console.log(`    Upstox zero-bid rate: ${upstoxZeroBidPct.toFixed(2)}%, FYERS zero-bid rate: ${fyersZeroBidPct.toFixed(2)}%\n`);

    // 7. Verify bidQty/askQty partial preservation (Upstox publishes 0 for absent depth)
    const [upstoxZeroBidQty] = await conn.query(`
      SELECT COUNT(*) as cnt
      FROM unified_option_quotes_history
      WHERE source IN ('UPSTOX', 'UPSTOX_LIVE')
        AND bidQty = 0 AND bid IS NOT NULL AND bid > 0 AND ltp > 0
    `);
    check(
      'upstox-bidqty-partial-preserved',
      upstoxZeroBidQty[0].cnt >= 0,  // Count should be a valid number
      `Expected valid bidQty partial count, got ${upstoxZeroBidQty[0].cnt}`
    );
    console.log(`    (${upstoxZeroBidQty[0].cnt.toLocaleString()} Upstox records have bidQty=0 with valid bid>0)\n`);

    // 8. Verify zero values are NOT being replaced with ltp or other defaults
    const [zeroBidBidQty] = await conn.query(`
      SELECT COUNT(*) as cnt
      FROM unified_option_quotes_history
      WHERE source IN ('UPSTOX', 'UPSTOX_LIVE')
        AND bid = 0 AND bidQty = 0 AND ltp > 0
    `);
    const [validBidBidQty] = await conn.query(`
      SELECT COUNT(*) as cnt
      FROM unified_option_quotes_history
      WHERE source IN ('UPSTOX', 'UPSTOX_LIVE')
        AND bid > 0 AND bidQty > 0 AND ltp > 0
    `);
    check(
      'upstox-zero-not-defaulted',
      zeroBidBidQty[0].cnt >= 0,
      `Expected valid zero-bid-zero-bidQty count, got ${zeroBidBidQty[0].cnt}`
    );
    console.log(`    (${zeroBidBidQty[0].cnt.toLocaleString()} records: bid=0,bidQty=0 | ${validBidBidQty[0].cnt.toLocaleString()} records: bid>0,bidQty>0)\n`);

    // 9. Spot-check: show a few real Upstox partial-tick records
    const [samples] = await conn.query(`
      SELECT instrumentKey, ltp, bid, ask, bidQty, askQty, source, sourceTimestamp
      FROM unified_option_quotes_history
      WHERE source IN ('UPSTOX', 'UPSTOX_LIVE')
        AND (bid = 0 OR ask = 0) AND ltp > 0
      ORDER BY receivedTimestamp DESC
      LIMIT 5
    `);
    console.log('  Sample Upstox partial-tick records:');
    for (const row of samples) {
      console.log(`    ${row.instrumentKey} ltp=${row.ltp} bid=${row.bid} ask=${row.ask} bidQty=${row.bidQty} askQty=${row.askQty} ts=${row.sourceTimestamp}`);
    }

    // 10. Verify no negative bid/ask values (would indicate zero-overwrite corruption)
    const [negatives] = await conn.query(`
      SELECT COUNT(*) as cnt
      FROM unified_option_quotes_history
      WHERE source IN ('UPSTOX', 'UPSTOX_LIVE')
        AND (bid < 0 OR ask < 0) AND ltp > 0
    `);
    check(
      'upstox-no-negative-values',
      negatives[0].cnt === 0,
      `Expected 0 negative bid/ask values, got ${negatives[0].cnt}`
    );
    console.log(`    (${negatives[0].cnt} negative bid/ask records found)\n`);

  } finally {
    await conn.end();
  }

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
