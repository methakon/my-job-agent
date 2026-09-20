#!/usr/bin/env node
/**
 * ITEM 892: End-to-end token → WebSocket → canonical tick verification.
 *
 * Runs the e2e-tick-test module with simulated provider data:
 * - Token acquisition pipeline
 * - WebSocket connection simulation
 * - Raw message parsing (valid + invalid)
 * - Canonical tick mapping from broker-specific format
 * - Pipeline metrics computation
 * - Full end-to-end simulation
 *
 * doneWhen: "End-to-end test passes with real or simulated provider data"
 */

const path = require('path');

// ── Helpers ──────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const errors = [];

function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  PASS ${name}`);
  } else {
    failed++;
    const msg = `  FAIL ${name} :: ${detail}`;
    console.log(msg);
    errors.push(msg);
  }
}

// ── Load compiled module ─────────────────────────────────────────────
const mod = require(path.resolve(__dirname, '../dist/trading/research/e2e-tick-test'));

const {
  acquireToken,
  connectWebSocket,
  parseRawMessage,
  mapToCanonicalTick,
  computePipelineMetrics,
} = mod;

// ── Tests ────────────────────────────────────────────────────────────
async function main() {
  console.log('=== ITEM 892: E2E Tick Pipeline Verification ===\n');

  // T1: Token acquisition
  {
    console.log('Test 1: Token acquisition');
    const result = acquireToken('fyers_api_key_123', 'fyers_secret_456');
    check('token non-empty', result.token.length > 0, result.token);
    check('token has expected prefix', result.token.startsWith('stub_token_'),
      result.token);
    check('expiresMs in future', result.expiresMs > Date.now(), `got ${result.expiresMs}`);
    check('acquireMs > 0', result.acquireMs > 0, `got ${result.acquireMs}`);
    check('acquireMs reasonable (<100ms)', result.acquireMs < 100, `got ${result.acquireMs}`);
  }

  // T2: Token determinism
  {
    console.log('\nTest 2: Token determinism');
    const t1 = acquireToken('key1', 'secret1');
    const t2 = acquireToken('key1', 'secret1');
    check('same token for same inputs', t1.token === t2.token,
      `${t1.token} vs ${t2.token}`);
    const t3 = acquireToken('key222', 'secret2');
    check('different token for different inputs', t1.token !== t3.token,
      `both ${t1.token}`);
  }

  // T3: WebSocket connection
  {
    console.log('\nTest 3: WebSocket connection');
    const token = acquireToken('k', 's');
    const conn = connectWebSocket(token.token, 'wss://ws.fyers.in');
    check('connected = true', conn.connected === true, `got ${conn.connected}`);
    check('connectMs > 0', conn.connectMs > 0, `got ${conn.connectMs}`);
    check('sessionId format', conn.sessionId.startsWith('ws_'), conn.sessionId);
    check('sessionId includes token', conn.sessionId.includes(token.token), conn.sessionId);
  }

  // T4: WebSocket connection — missing token throws
  {
    console.log('\nTest 4: WS connection rejects missing token');
    try {
      connectWebSocket('', 'wss://ws.fyers.in');
      check('should throw', false, 'no error thrown');
    } catch (e) {
      check('throws error', e.message.includes('required'), e.message);
    }
  }

  // T5: Parse valid JSON
  {
    console.log('\nTest 5: Parse valid JSON message');
    const raw = JSON.stringify({
      type: 'tick', symbol: 'NIFTY', ltp: 24500, 
      bid: 24499, ask: 24501, bidQty: 100, askQty: 50, vol: 5000, oi: 100000,
    });
    const result = parseRawMessage(raw);
    check('parsed non-null', result.parsed !== null, '');
    check('error null', result.error === null, result.error);
    check('symbol = NIFTY', result.parsed.symbol === 'NIFTY', result.parsed.symbol);
    check('ltp = 24500', result.parsed.ltp === 24500, result.parsed.ltp);
    check('bid = 24499', result.parsed.bid === 24499, result.parsed.bid);
    check('parseMs > 0', result.parseMs > 0, result.parseMs);
  }

  // T6: Parse invalid JSON
  {
    console.log('\nTest 6: Parse invalid JSON');
    const result = parseRawMessage('{ broken json');
    check('parsed null', result.parsed === null, '');
    check('error = Invalid JSON', result.error === 'Invalid JSON', result.error);
  }

  // T7: Parse empty string
  {
    console.log('\nTest 7: Parse empty string');
    const result = parseRawMessage('');
    check('parsed null', result.parsed === null, '');
    check('has error', result.error !== null, result.error);
  }

  // T8: Map to canonical tick — FYERS format
  {
    console.log('\nTest 8: Map to canonical tick (FYERS)');
    const raw = {
      type: 'tick', symbol: 'BANKNIFTY', ltp: 51200, 
      bid: 51198, ask: 51202, bidQty: 50, askQty: 75,
      vol: 1000, oi: 50000, timestamp: '2026-09-19T10:00:00Z',
    };
    const tick = mapToCanonicalTick(raw, 'FYERS_LIVE');
    check('tick not null', tick !== null, '');
    check('instrumentKey = NSE:BANKNIFTY', tick.instrumentKey === 'NSE:BANKNIFTY', tick.instrumentKey);
    check('symbol = BANKNIFTY', tick.symbol === 'BANKNIFTY', tick.symbol);
    check('exchange = NSE', tick.exchange === 'NSE', tick.exchange);
    check('ltp = 51200', tick.ltp === 51200, tick.ltp);
    check('bid = 51198', tick.bid === 51198, tick.bid);
    check('ask = 51202', tick.ask === 51202, tick.ask);
    check('bidQty = 50', tick.bidQty === 50, tick.bidQty);
    check('askQty = 75', tick.askQty === 75, tick.askQty);
    check('volume = 1000', tick.volume === 1000, tick.volume);
    check('oi = 50000', tick.oi === 50000, tick.oi);
    check('source = FYERS_LIVE', tick.source === 'FYERS_LIVE', tick.source);
    check('sourceTimestamp set', tick.sourceTimestamp === '2026-09-19T10:00:00Z', tick.sourceTimestamp);
    check('receivedTimestamp set', tick.receivedTimestamp.length > 0, tick.receivedTimestamp);
  }

  // T9: Map to canonical tick — UPSTOX format
  {
    console.log('\nTest 9: Map to canonical tick (UPSTOX)');
    const raw = { type: 'tick', symbol: 'NIFTY', ltp: 24500 }; 
    const tick = mapToCanonicalTick(raw, 'UPSTOX_LIVE');
    check('tick not null', tick !== null, '');
    check('source = UPSTOX_LIVE', tick.source === 'UPSTOX_LIVE', tick.source);
    check('bid defaults to ltp', tick.bid === 24500, tick.bid);
    check('ask defaults to ltp', tick.ask === 24500, tick.ask);
    check('bidQty defaults to 0', tick.bidQty === 0, tick.bidQty);
    check('volume defaults to 0', tick.volume === 0, tick.volume);
    check('oi defaults to null', tick.oi === null, tick.oi);
  }

  // T10: Map to canonical tick — missing symbol/ltp returns null
  {
    console.log('\nTest 10: Missing fields → null');
    const raw1 = { type: 'tick' };
    check('no symbol → null', mapToCanonicalTick(raw1, 'SRC') === null, '');
    const raw2 = { type: 'tick', symbol: 'NIFTY' }; 
    check('no ltp → null', mapToCanonicalTick(raw2, 'SRC') === null, '');
  }

  // T11: Pipeline metrics
  {
    console.log('\nTest 11: Pipeline metrics');
    const m = computePipelineMetrics(1000, 2, 500);
    check('ticksReceived = 1000', m.ticksReceived === 1000, m.ticksReceived);
    check('ticksFailed = 2', m.ticksFailed === 2, m.ticksFailed);
    check('totalMs = 500', m.totalMs === 500, m.totalMs);
    check('ticksPerSecond > 1000', m.ticksPerSecond > 1000, m.ticksPerSecond);
    check('tokenAcquisitionMs = 2', m.tokenAcquisitionMs === 2, m.tokenAcquisitionMs);
    check('wsConnectMs = 15', m.wsConnectMs === 15, m.wsConnectMs);
    check('messageParseMs > 0', m.messageParseMs > 0, m.messageParseMs);
  }

  // T12: Full E2E pipeline simulation
  {
    console.log('\nTest 12: Full E2E pipeline simulation');
    const token = acquireToken('test_key', 'test_secret');
    check('step 1: token acquired', token.token.length > 0, token.token);

    const conn = connectWebSocket(token.token, 'wss://ws.fyers.in');
    check('step 2: connected', conn.connected === true, '');

    const rawStr = JSON.stringify({ type: 'tick', symbol: 'NIFTY', ltp: 24500, bid: 24499, ask: 24501 }); 
    const parsed = parseRawMessage(rawStr);
    check('step 3: parsed', parsed.parsed !== null, parsed.error);

    const tick = mapToCanonicalTick(parsed.parsed, 'FYERS_LIVE');
    check('step 4: canonical tick', tick !== null, '');
    check('step 5: symbol correct', tick.symbol === 'NIFTY', tick.symbol);
    check('step 6: ltp correct', tick.ltp === 24500, tick.ltp);

    const metrics = computePipelineMetrics(1, 0, 20);
    check('step 7: metrics computed', metrics.ticksPerSecond > 0, metrics.ticksPerSecond);
  }

  // T13: Multiple tick processing
  {
    console.log('\nTest 13: Multiple tick processing');
    const symbols = ['NIFTY', 'BANKNIFTY', 'RELIANCE', 'TCS', 'INFY'];
    const ticks = [];
    for (const sym of symbols) {
      const raw = JSON.stringify({ type: 'tick', symbol: sym, ltp: 1000 + Math.random() * 50000 }); 
      const parsed = parseRawMessage(raw);
      const tick = mapToCanonicalTick(parsed.parsed, 'UPSTOX_LIVE');
      ticks.push(tick);
    }
    check('5 ticks processed', ticks.length === 5, `got ${ticks.length}`);
    check('all non-null', ticks.every(t => t !== null), '');
    check('all have NSE key', ticks.every(t => t.instrumentKey.startsWith('NSE:')), '');
    check('all source UPSTOX_LIVE', ticks.every(t => t.source === 'UPSTOX_LIVE'), '');
  }

  // T14: DB real data verification
  {
    console.log('\nTest 14: DB canonical tick data verification');
    const mysql = require('mysql2/promise');
    require('dotenv').config();
    const DB_CONFIG = {
      host: process.env.MYSQL_HOST,
      port: parseInt(process.env.MYSQL_PORT || '3306'),
      user: process.env.MYSQL_USER,
      password: process.env.MYSQL_PASSWORD,
      database: process.env.MYSQL_DATABASE || 'myjob_agent',
    };
    const conn = await mysql.createConnection(DB_CONFIG);
    try {
      // Check canonical tick data matches our CanonicalTick shape
      const [fields] = await conn.query(`
        SELECT COLUMN_NAME
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = 'myjob_agent'
        AND TABLE_NAME = 'unified_option_quotes_history'
        ORDER BY ORDINAL_POSITION
      `);
      const colNames = fields.map(f => f.COLUMN_NAME);
      check('has underlying', colNames.includes('underlying'), colNames.join(','));
      check('has source', colNames.includes('source'), colNames.join(','));
      check('has ltp', colNames.includes('ltp'), colNames.join(','));
      check('has bid', colNames.includes('bid'), colNames.join(','));
      check('has ask', colNames.includes('ask'), colNames.join(','));
      check('has createdAt', colNames.includes('createdAt'), colNames.join(','));

      // Verify data quality
      const [quality] = await conn.query(`
        SELECT
          COUNT(*) as total,
          SUM(CASE WHEN ltp > 0 THEN 1 ELSE 0 END) as valid_ltp,
          SUM(CASE WHEN underlying IS NOT NULL AND underlying != '' THEN 1 ELSE 0 END) as valid_underlying,
          SUM(CASE WHEN source IN ('FYERS_LIVE', 'UPSTOX', 'UPSTOX_LIVE') THEN 1 ELSE 0 END) as valid_source
        FROM unified_option_quotes_history
        LIMIT 1
      `);
      if (quality[0]) {
        const q = quality[0];
        check('total > 0', Number(q.total) > 0, `got ${q.total}`);
        check('valid_ltp rate > 99%',
          Number(q.valid_ltp) / Number(q.total) > 0.99,
          `${Number(q.valid_ltp)}/${Number(q.total)}`);
        console.log(`    DB: ${q.total} ticks, ${q.valid_ltp} valid LTP, ${q.valid_underlying} valid underlying`);
      }
    } finally {
      await conn.end();
    }
  }

  // ── Summary ────────────────────────────────────────────────────────
  console.log(`\n=== ITEM 892 Results: ${passed} passed, ${failed} failed ===`);
  if (errors.length > 0) {
    console.log('\nErrors:');
    errors.forEach(e => console.log(`  ${e}`));
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
