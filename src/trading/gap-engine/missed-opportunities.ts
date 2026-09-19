/**
 * ITEM 115 — Track missed opportunities.
 *
 * Records gap sessions where a valid setup was identified but no trade
 * was placed (missed due to latency, risk gate, or manual skip).
 * Enables post-hoc analysis of missed P&L and pattern identification.
 *
 * Pure functions: no I/O, no DB, no network, no randomness.
 * RESEARCH / SHADOW ONLY: nothing in production imports this module.
 */

// ── Types ─────────────────────────────────────────────────────────────

export type MissReason =
  | 'LATENCY_EXCEEDED'
  | 'RISK_GATE_BLOCKED'
  | 'MANUAL_SKIP'
  | 'INSUFFICIENT_LIQUIDITY'
  | 'EVENT_GATE_BLOCKED'
  | 'REGIME_VETO'
  | 'POSITION_LIMIT'
  | 'UNKNOWN';

export interface MissedOpportunity {
  readonly sessionId: string;
  readonly date: string;
  readonly symbol: string;
  readonly setupType: 'GAP_FADE' | 'FAILED_ORB' | 'BREAKOUT' | 'MEAN_REVERSION';
  readonly direction: 'LONG' | 'SHORT';
  readonly entryPrice: number;
  readonly targetPrice: number;
  readonly stopPrice: number;
  readonly expectedValue: number;
  readonly missReason: MissReason;
  readonly timestampMs: number;
  readonly notes: string;
}

export interface MissedOpportunitySummary {
  readonly totalMissed: number;
  readonly byReason: Readonly<Record<MissReason, number>>;
  readonly bySetupType: Readonly<Record<string, number>>;
  readonly totalMissedEV: number;
  readonly avgMissedEV: number;
  readonly topMissReason: MissReason | null;
}

// ── Functions ─────────────────────────────────────────────────────────

/** Record a missed opportunity. */
export function recordMissedOpportunity(
  params: Omit<MissedOpportunity, 'timestampMs'>,
): MissedOpportunity {
  return {
    ...params,
    timestampMs: Date.now(),
  };
}

/** Summarize a list of missed opportunities. */
export function summarizeMissedOpportunities(
  opportunities: readonly MissedOpportunity[],
): MissedOpportunitySummary {
  const byReason = {} as Record<MissReason, number>;
  const bySetupType = {} as Record<string, number>;
  let totalEV = 0;

  for (const opp of opportunities) {
    byReason[opp.missReason] = (byReason[opp.missReason] || 0) + 1;
    bySetupType[opp.setupType] = (bySetupType[opp.setupType] || 0) + 1;
    totalEV += opp.expectedValue;
  }

  // Find top reason
  let topReason: MissReason | null = null;
  let maxCount = 0;
  for (const [reason, count] of Object.entries(byReason) as [MissReason, number][]) {
    if (count > maxCount) {
      maxCount = count;
      topReason = reason;
    }
  }

  return {
    totalMissed: opportunities.length,
    byReason,
    bySetupType,
    totalMissedEV: totalEV,
    avgMissedEV: opportunities.length > 0 ? totalEV / opportunities.length : 0,
    topMissReason: topReason,
  };
}

/** Filter missed opportunities by reason. */
export function filterByReason(
  opportunities: readonly MissedOpportunity[],
  reason: MissReason,
): readonly MissedOpportunity[] {
  return opportunities.filter(o => o.missReason === reason);
}

/** Filter missed opportunities by setup type. */
export function filterBySetupType(
  opportunities: readonly MissedOpportunity[],
  setupType: MissedOpportunity['setupType'],
): readonly MissedOpportunity[] {
  return opportunities.filter(o => o.setupType === setupType);
}

// ── Test Harness ──────────────────────────────────────────────────────

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(`FAIL: ${msg}`);
}

function assertPositive(val: number, label: string): void {
  assert(val > 0, `${label}: expected positive, got ${val}`);
}

// ── Tests ─────────────────────────────────────────────────────────────

export function runMissedOpportunitiesTests(): { passed: number; failed: number; errors: string[] } {
  const errors: string[] = [];
  let passed = 0;
  let failed = 0;

  const sampleOpps: MissedOpportunity[] = [
    {
      sessionId: 'S1', date: '2026-09-19', symbol: 'NIFTY',
      setupType: 'GAP_FADE', direction: 'LONG', entryPrice: 24500,
      targetPrice: 24600, stopPrice: 24450, expectedValue: 50,
      missReason: 'LATENCY_EXCEEDED', timestampMs: 1000, notes: 'Late signal',
    },
    {
      sessionId: 'S2', date: '2026-09-19', symbol: 'BANKNIFTY',
      setupType: 'FAILED_ORB', direction: 'SHORT', entryPrice: 51200,
      targetPrice: 51000, stopPrice: 51350, expectedValue: 80,
      missReason: 'RISK_GATE_BLOCKED', timestampMs: 2000, notes: 'Max positions',
    },
    {
      sessionId: 'S3', date: '2026-09-19', symbol: 'NIFTY',
      setupType: 'GAP_FADE', direction: 'LONG', entryPrice: 24500,
      targetPrice: 24600, stopPrice: 24450, expectedValue: 40,
      missReason: 'LATENCY_EXCEEDED', timestampMs: 3000, notes: 'Slow fill',
    },
    {
      sessionId: 'S4', date: '2026-09-20', symbol: 'NIFTY',
      setupType: 'BREAKOUT', direction: 'LONG', entryPrice: 24700,
      targetPrice: 24800, stopPrice: 24650, expectedValue: 60,
      missReason: 'EVENT_GATE_BLOCKED', timestampMs: 4000, notes: 'RBI policy',
    },
  ];

  const tests = [
    () => {
      console.log('Test 1: Record missed opportunity');
      const opp = recordMissedOpportunity({
        sessionId: 'S5', date: '2026-09-21', symbol: 'NIFTY',
        setupType: 'GAP_FADE', direction: 'LONG', entryPrice: 25000,
        targetPrice: 25100, stopPrice: 24950, expectedValue: 30,
        missReason: 'MANUAL_SKIP', notes: 'Low confidence',
      });
      assert(opp.timestampMs > 0, 'Should have timestamp');
      assert(opp.sessionId === 'S5', 'Session ID preserved');
      console.log('  PASS');
    },
    () => {
      console.log('Test 2: Summary computation');
      const summary = summarizeMissedOpportunities(sampleOpps);
      assert(summary.totalMissed === 4, `Expected 4, got ${summary.totalMissed}`);
      assertPositive(summary.totalMissedEV, 'totalMissedEV');
      assertPositive(summary.avgMissedEV, 'avgMissedEV');
      assert(summary.byReason['LATENCY_EXCEEDED'] === 2, '2 latency misses');
      assert(summary.byReason['RISK_GATE_BLOCKED'] === 1, '1 risk miss');
      assert(summary.topMissReason === 'LATENCY_EXCEEDED', 'Top reason');
      console.log('  PASS');
    },
    () => {
      console.log('Test 3: Filter by reason');
      const latencyMisses = filterByReason(sampleOpps, 'LATENCY_EXCEEDED');
      assert(latencyMisses.length === 2, '2 latency misses');
      for (const m of latencyMisses) {
        assert(m.missReason === 'LATENCY_EXCEEDED', 'Reason matches');
      }
      console.log('  PASS');
    },
    () => {
      console.log('Test 4: Filter by setup type');
      const gapFades = filterBySetupType(sampleOpps, 'GAP_FADE');
      assert(gapFades.length === 2, '2 gap fade setups');
      console.log('  PASS');
    },
    () => {
      console.log('Test 5: Empty list');
      const summary = summarizeMissedOpportunities([]);
      assert(summary.totalMissed === 0, 'No missed');
      assert(summary.avgMissedEV === 0, 'Zero avg EV');
      assert(summary.topMissReason === null, 'No top reason');
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

  console.log(`\nMissed Opportunities Test Results: ${passed} passed, ${failed} failed`);
  return { passed, failed, errors };
}

if (require.main === module) {
  const result = runMissedOpportunitiesTests();
  process.exit(result.failed > 0 ? 1 : 0);
}
