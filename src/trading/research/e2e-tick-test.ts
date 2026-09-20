/**
 * ITEM 892 — End-to-end token → WebSocket → canonical tick test.
 *
 * Validates the full pipeline: token acquisition, WebSocket connection,
 * raw message parsing, and canonical tick construction. Tests the mapping
 * chain from broker-specific format to UnifiedTickInput → UnifiedMarketSnapshot.
 *
 * Pure test harness: uses stub data, no actual WS connections.
 * RESEARCH / SHADOW ONLY: requires Monday live verification.
 */

// ── Types ─────────────────────────────────────────────────────────────

/** Canonical tick shape from broker adapters. */
export interface CanonicalTick {
  readonly instrumentKey: string;
  readonly symbol: string;
  readonly exchange: string;
  readonly ltp: number;
  readonly bid: number;
  readonly ask: number;
  readonly bidQty: number;
  readonly askQty: number;
  readonly volume: number;
  readonly oi: number | null;
  readonly source: string;
  readonly sourceTimestamp: string;
  readonly receivedTimestamp: string;
}

/** Simulated raw WS message (broker-specific format). */
export interface RawWsMessage {
  readonly type: string;
  readonly symbol?: string;
  readonly ltp?: number;
  readonly bid?: number;
  readonly ask?: number;
  readonly bidQty?: number;
  readonly askQty?: number;
  readonly vol?: number;
  readonly oi?: number;
  readonly timestamp?: string;
}

/** Pipeline stage metrics. */
export interface PipelineMetrics {
  readonly tokenAcquisitionMs: number;
  readonly wsConnectMs: number;
  readonly messageParseMs: number;
  readonly tickConstructionMs: number;
  readonly totalMs: number;
  readonly ticksReceived: number;
  readonly ticksFailed: number;
  readonly ticksPerSecond: number;
}

// ── Functions ─────────────────────────────────────────────────────────

/**
 * Simulate token acquisition.
 * Returns token and acquisition time.
 */
export function acquireToken(apiKey: string, secret: string): {
  token: string;
  expiresMs: number;
  acquireMs: number;
} {
  // Deterministic stub: token is hash of inputs
  const hash = apiKey.length * 31 + secret.length * 17;
  return {
    token: `stub_token_${hash}`,
    expiresMs: Date.now() + 3600000,
    acquireMs: 2, // Simulated 2ms acquisition
  };
}

/**
 * Simulate WebSocket connection.
 * Returns connection handle and connect time.
 */
export function connectWebSocket(token: string, feedUrl: string): {
  connected: boolean;
  connectMs: number;
  sessionId: string;
} {
  if (!token || !feedUrl) {
    throw new Error('Token and feedUrl are required');
  }
  return {
    connected: true,
    connectMs: 15, // Simulated 15ms connection
    sessionId: `ws_${token}`,
  };
}

/**
 * Parse a raw WebSocket message into intermediate format.
 */
export function parseRawMessage(raw: string): {
  parsed: RawWsMessage | null;
  parseMs: number;
  error: string | null;
} {
  try {
    const msg = JSON.parse(raw) as RawWsMessage;
    return { parsed: msg, parseMs: 0.5, error: null };
  } catch {
    return { parsed: null, parseMs: 0, error: 'Invalid JSON' };
  }
}

/**
 * Map raw WS message to canonical tick.
 */
export function mapToCanonicalTick(
  raw: RawWsMessage,
  source: string,
): CanonicalTick | null {
  if (!raw.symbol || raw.ltp === undefined) {
    return null;
  }

  const now = new Date().toISOString();
  return {
    instrumentKey: `NSE:${raw.symbol}`,
    symbol: raw.symbol,
    exchange: 'NSE',
    ltp: raw.ltp,
    bid: raw.bid ?? raw.ltp,
    ask: raw.ask ?? raw.ltp,
    bidQty: raw.bidQty ?? 0,
    askQty: raw.askQty ?? 0,
    volume: raw.vol ?? 0,
    oi: raw.oi ?? null,
    source,
    sourceTimestamp: raw.timestamp ?? now,
    receivedTimestamp: now,
  };
}

/**
 * Compute pipeline metrics from simulation.
 */
export function computePipelineMetrics(
  ticksReceived: number,
  ticksFailed: number,
  totalMs: number,
): PipelineMetrics {
  const ticksPerSecond = totalMs > 0 ? (ticksReceived / totalMs) * 1000 : 0;
  return {
    tokenAcquisitionMs: 2,
    wsConnectMs: 15,
    messageParseMs: 0.5 * ticksReceived,
    tickConstructionMs: 0.3 * ticksReceived,
    totalMs,
    ticksReceived,
    ticksFailed,
    ticksPerSecond,
  };
}

// ── Test Harness ──────────────────────────────────────────────────────

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(`FAIL: ${msg}`);
}

// ── Tests ─────────────────────────────────────────────────────────────

export function runE2ETickTests(): { passed: number; failed: number; errors: string[] } {
  const errors: string[] = [];
  let passed = 0;
  let failed = 0;

  const tests = [
    () => {
      console.log('Test 1: Token acquisition');
      const result = acquireToken('test_key', 'test_secret');
      assert(result.token.length > 0, 'Token should be non-empty');
      assert(result.expiresMs > Date.now(), 'Token should not be expired');
      assert(result.acquireMs > 0, 'Acquisition should take time');
      console.log('  PASS');
    },
    () => {
      console.log('Test 2: WebSocket connection');
      const token = acquireToken('key', 'secret').token;
      const conn = connectWebSocket(token, 'wss://ws.example.com');
      assert(conn.connected, 'Should be connected');
      assert(conn.connectMs > 0, 'Connect should take time');
      assert(conn.sessionId.startsWith('ws_'), 'Session ID should start with ws_');
      console.log('  PASS');
    },
    () => {
      console.log('Test 3: Raw message parsing');
      const raw = JSON.stringify({ type: 'tick', symbol: 'NIFTY', ltp: 24500, bid: 24499, ask: 24501 });
      const result = parseRawMessage(raw);
      assert(result.parsed !== null, 'Should parse successfully');
      assert(result.error === null, 'No error');
      assert(result.parsed!.symbol === 'NIFTY', 'Symbol should be NIFTY');
      assert(result.parsed!.ltp === 24500, 'LTP should be 24500');
      console.log('  PASS');
    },
    () => {
      console.log('Test 4: Parse error handling');
      const result = parseRawMessage('not json');
      assert(result.parsed === null, 'Should fail to parse');
      assert(result.error === 'Invalid JSON', 'Should have error');
      console.log('  PASS');
    },
    () => {
      console.log('Test 5: Raw → Canonical tick mapping');
      const raw: RawWsMessage = {
        type: 'tick', symbol: 'BANKNIFTY', ltp: 51200,
        bid: 51198, ask: 51202, bidQty: 50, askQty: 75, vol: 1000, oi: 50000,
        timestamp: '2026-09-19T10:00:00Z',
      };
      const tick = mapToCanonicalTick(raw, 'FYERS_LIVE');
      assert(tick !== null, 'Should produce canonical tick');
      assert(tick!.symbol === 'BANKNIFTY', 'Symbol preserved');
      assert(tick!.instrumentKey === 'NSE:BANKNIFTY', 'Key format');
      assert(tick!.exchange === 'NSE', 'Exchange');
      assert(tick!.ltp === 51200, 'LTP');
      assert(tick!.source === 'FYERS_LIVE', 'Source');
      console.log('  PASS');
    },
    () => {
      console.log('Test 6: Missing fields → null');
      const raw: RawWsMessage = { type: 'tick' };
      const tick = mapToCanonicalTick(raw, 'SOURCE');
      assert(tick === null, 'Should return null for missing symbol/ltp');
      console.log('  PASS');
    },
    () => {
      console.log('Test 7: Pipeline metrics');
      const metrics = computePipelineMetrics(1000, 2, 500);
      assert(metrics.ticksReceived === 1000, 'Ticks received');
      assert(metrics.ticksFailed === 2, 'Ticks failed');
      assert(metrics.totalMs === 500, 'Total ms');
      assert(metrics.ticksPerSecond > 1000, `TPS > 1000, got ${metrics.ticksPerSecond}`);
      assert(metrics.tokenAcquisitionMs === 2, 'Token ms');
      assert(metrics.wsConnectMs === 15, 'WS ms');
      console.log('  PASS');
    },
    () => {
      console.log('Test 8: End-to-end pipeline simulation');
      const token = acquireToken('key', 'secret');
      const conn = connectWebSocket(token.token, 'wss://ws.example.com');
      assert(conn.connected, 'Connected');

      const rawStr = JSON.stringify({ type: 'tick', symbol: 'NIFTY', ltp: 24500 });
      const parsed = parseRawMessage(rawStr);
      assert(parsed.parsed !== null, 'Parsed');

      const tick = mapToCanonicalTick(parsed.parsed!, 'UPSTOX_LIVE');
      assert(tick !== null, 'Canonical tick');
      assert(tick!.symbol === 'NIFTY', 'Symbol');
      console.log('  PASS');
    },
  ];

  for (const test of tests) {
    try {
      test();
      passed++;
    } catch (e) {
      failed++;
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }

  console.log(`\nE2E Tick Test Results: ${passed} passed, ${failed} failed`);
  return { passed, failed, errors };
}

if (require.main === module) {
  const result = runE2ETickTests();
  process.exit(result.failed > 0 ? 1 : 0);
}
