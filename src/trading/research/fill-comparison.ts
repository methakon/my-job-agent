/**
 * ITEM 353 — Compare intended fills against real quotes.
 *
 * Validates that intended order parameters (price, quantity, side)
 * are consistent with actual market quotes at the time of decision.
 * Detects slippage, stale quotes, and quote-estimate mismatches.
 *
 * Pure functions: no I/O, no DB, no network, no randomness.
 * RESEARCH / SHADOW ONLY: nothing in production imports this module.
 */

// ── Types ─────────────────────────────────────────────────────────────

export interface IntendedFill {
  readonly symbol: string;
  readonly side: 'BUY' | 'SELL';
  readonly intendedPrice: number;
  readonly quantity: number;
  readonly timestampMs: number;
  readonly signalSource: string;
}

export interface MarketQuote {
  readonly symbol: string;
  readonly bid: number;
  readonly ask: number;
  readonly bidSize: number;
  readonly askSize: number;
  readonly lastTradedPrice: number;
  readonly timestampMs: number;
}

export interface FillComparisonResult {
  readonly symbol: string;
  readonly side: 'BUY' | 'SELL';
  readonly intendedPrice: number;
  readonly marketPrice: number;  // best bid for BUY, best ask for SELL
  readonly slippage: number;     // intendedPrice - marketPrice (negative = adverse)
  readonly slippagePct: number;  // slippage / intendedPrice * 100
  readonly quoteAgeMs: number;   // how old the quote is
  readonly isStaleQuote: boolean;
  readonly isWithinSpread: boolean;
  readonly quantityAvailable: number;
  readonly sufficientLiquidity: boolean;
  readonly verdict: 'GOOD' | 'ADVERSE_SLIPPAGE' | 'STALE_QUOTE' | 'INSUFFICIENT_LIQUIDITY' | 'OUTSIDE_SPREAD';
}

// ── Constants ─────────────────────────────────────────────────────────

const MAX_SLIPPAGE_PCT = 0.1;  // 0.1% max acceptable slippage
const MAX_QUOTE_AGE_MS = 5000; // 5 seconds

// ── Functions ─────────────────────────────────────────────────────────

/**
 * Compare an intended fill against the current market quote.
 */
export function compareFillToQuote(
  intended: IntendedFill,
  quote: MarketQuote,
): FillComparisonResult {
  const marketPrice = intended.side === 'BUY' ? quote.ask : quote.bid;
  const slippage = intended.intendedPrice - marketPrice;
  const slippagePct = (slippage / intended.intendedPrice) * 100;
  const quoteAgeMs = intended.timestampMs - quote.timestampMs;
  const isStaleQuote = quoteAgeMs > MAX_QUOTE_AGE_MS;
  const quantityAvailable = intended.side === 'BUY' ? quote.askSize : quote.bidSize;
  const sufficientLiquidity = quantityAvailable >= intended.quantity;

  // Check if intended price is within the spread
  const isWithinSpread = intended.intendedPrice >= quote.bid && intended.intendedPrice <= quote.ask;

  // Determine verdict
  let verdict: FillComparisonResult['verdict'] = 'GOOD';
  if (!sufficientLiquidity) {
    verdict = 'INSUFFICIENT_LIQUIDITY';
  } else if (isStaleQuote) {
    verdict = 'STALE_QUOTE';
  } else if (!isWithinSpread) {
    verdict = 'OUTSIDE_SPREAD';
  } else if (Math.abs(slippagePct) > MAX_SLIPPAGE_PCT) {
    verdict = 'ADVERSE_SLIPPAGE';
  }

  return {
    symbol: intended.symbol,
    side: intended.side,
    intendedPrice: intended.intendedPrice,
    marketPrice,
    slippage,
    slippagePct,
    quoteAgeMs,
    isStaleQuote,
    isWithinSpread,
    quantityAvailable,
    sufficientLiquidity,
    verdict,
  };
}

/**
 * Batch comparison for multiple intended fills.
 */
export function batchCompareFills(
  intendedFills: readonly IntendedFill[],
  quotes: readonly MarketQuote[],
): readonly FillComparisonResult[] {
  const quoteMap = new Map<string, MarketQuote>();
  for (const q of quotes) {
    quoteMap.set(q.symbol, q);
  }

  const results: FillComparisonResult[] = [];
  for (const fill of intendedFills) {
    const quote = quoteMap.get(fill.symbol);
    if (quote) {
      results.push(compareFillToQuote(fill, quote));
    }
  }
  return results;
}

/**
 * Summarize comparison results.
 */
export function summarizeComparisons(
  results: readonly FillComparisonResult[],
): {
  readonly total: number;
  readonly good: number;
  readonly adverse: number;
  readonly stale: number;
  readonly insufficientLiquidity: number;
  readonly outsideSpread: number;
  readonly avgSlippagePct: number;
  readonly maxSlippagePct: number;
} {
  let totalSlippagePct = 0;
  let maxSlippagePct = 0;
  const counts: Record<string, number> = {
    GOOD: 0, ADVERSE_SLIPPAGE: 0, STALE_QUOTE: 0,
    INSUFFICIENT_LIQUIDITY: 0, OUTSIDE_SPREAD: 0,
  };

  for (const r of results) {
    counts[r.verdict] = (counts[r.verdict] || 0) + 1;
    totalSlippagePct += Math.abs(r.slippagePct);
    if (Math.abs(r.slippagePct) > maxSlippagePct) {
      maxSlippagePct = Math.abs(r.slippagePct);
    }
  }

  return {
    total: results.length,
    good: counts['GOOD'] || 0,
    adverse: counts['ADVERSE_SLIPPAGE'] || 0,
    stale: counts['STALE_QUOTE'] || 0,
    insufficientLiquidity: counts['INSUFFICIENT_LIQUIDITY'] || 0,
    outsideSpread: counts['OUTSIDE_SPREAD'] || 0,
    avgSlippagePct: results.length > 0 ? totalSlippagePct / results.length : 0,
    maxSlippagePct,
  };
}

// ── Test Harness ──────────────────────────────────────────────────────

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(`FAIL: ${msg}`);
}

// ── Tests ─────────────────────────────────────────────────────────────

export function runFillComparisonTests(): { passed: number; failed: number; errors: string[] } {
  const errors: string[] = [];
  let passed = 0;
  let failed = 0;

  const tests = [
    () => {
      console.log('Test 1: Good fill — within spread, no slippage');
      const intended: IntendedFill = {
        symbol: 'NIFTY', side: 'BUY', intendedPrice: 24500,
        quantity: 50, timestampMs: 1000, signalSource: 'gap-fade',
      };
      const quote: MarketQuote = {
        symbol: 'NIFTY', bid: 24499, ask: 24500, bidSize: 100, askSize: 100,
        lastTradedPrice: 24499.5, timestampMs: 999,
      };
      const result = compareFillToQuote(intended, quote);
      assert(result.verdict === 'GOOD', `Expected GOOD, got ${result.verdict}`);
      assert(result.isWithinSpread, 'Should be within spread');
      assert(result.sufficientLiquidity, 'Should have sufficient liquidity');
      console.log('  PASS');
    },
    () => {
      console.log('Test 2: Stale quote');
      const intended: IntendedFill = {
        symbol: 'NIFTY', side: 'BUY', intendedPrice: 24500,
        quantity: 50, timestampMs: 10000, signalSource: 'gap-fade',
      };
      const quote: MarketQuote = {
        symbol: 'NIFTY', bid: 24499, ask: 24500, bidSize: 100, askSize: 100,
        lastTradedPrice: 24499.5, timestampMs: 1000, // 9 seconds old
      };
      const result = compareFillToQuote(intended, quote);
      assert(result.verdict === 'STALE_QUOTE', `Expected STALE_QUOTE, got ${result.verdict}`);
      assert(result.isStaleQuote, 'Should be stale');
      console.log('  PASS');
    },
    () => {
      console.log('Test 3: Insufficient liquidity');
      const intended: IntendedFill = {
        symbol: 'NIFTY', side: 'BUY', intendedPrice: 24500,
        quantity: 200, timestampMs: 1000, signalSource: 'gap-fade',
      };
      const quote: MarketQuote = {
        symbol: 'NIFTY', bid: 24499, ask: 24500, bidSize: 100, askSize: 50,
        lastTradedPrice: 24499.5, timestampMs: 999,
      };
      const result = compareFillToQuote(intended, quote);
      assert(result.verdict === 'INSUFFICIENT_LIQUIDITY', `Expected INSUFFICIENT_LIQUIDITY, got ${result.verdict}`);
      assert(!result.sufficientLiquidity, 'Should lack liquidity');
      console.log('  PASS');
    },
    () => {
      console.log('Test 4: Batch comparison');
      const fills: IntendedFill[] = [
        { symbol: 'NIFTY', side: 'BUY', intendedPrice: 24500, quantity: 50, timestampMs: 1000, signalSource: 'gap-fade' },
        { symbol: 'BANKNIFTY', side: 'SELL', intendedPrice: 51200, quantity: 25, timestampMs: 1000, signalSource: 'orb' },
      ];
      const quotes: MarketQuote[] = [
        { symbol: 'NIFTY', bid: 24499, ask: 24500, bidSize: 100, askSize: 100, lastTradedPrice: 24499.5, timestampMs: 999 },
        { symbol: 'BANKNIFTY', bid: 51200, ask: 51205, bidSize: 50, askSize: 50, lastTradedPrice: 51202, timestampMs: 999 },
      ];
      const results = batchCompareFills(fills, quotes);
      assert(results.length === 2, `Expected 2 results, got ${results.length}`);
      console.log('  PASS');
    },
    () => {
      console.log('Test 5: Summary');
      const results: FillComparisonResult[] = [
        { symbol: 'A', side: 'BUY', intendedPrice: 100, marketPrice: 100, slippage: 0, slippagePct: 0, quoteAgeMs: 0, isStaleQuote: false, isWithinSpread: true, quantityAvailable: 100, sufficientLiquidity: true, verdict: 'GOOD' },
        { symbol: 'B', side: 'BUY', intendedPrice: 100, marketPrice: 102, slippage: -2, slippagePct: -2, quoteAgeMs: 0, isStaleQuote: false, isWithinSpread: false, quantityAvailable: 100, sufficientLiquidity: true, verdict: 'ADVERSE_SLIPPAGE' },
      ];
      const summary = summarizeComparisons(results);
      assert(summary.total === 2, 'Total 2');
      assert(summary.good === 1, '1 good');
      assert(summary.adverse === 1, '1 adverse');
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

  console.log(`\nFill Comparison Test Results: ${passed} passed, ${failed} failed`);
  return { passed, failed, errors };
}

if (require.main === module) {
  const result = runFillComparisonTests();
  process.exit(result.failed > 0 ? 1 : 0);
}
