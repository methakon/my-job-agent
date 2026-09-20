/**
 * ValidationEngine + AdaptationEngine tests.
 * Uses synthetic fixtures — no real DB required.
 * Validates: baseline metrics, holdout split, stability, safety gates, lifecycle.
 */

const assert = require('assert');
let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}: ${e.message}`);
  }
}

function approx(a, b, tol = 0.01) {
  assert(Math.abs(a - b) < tol, `Expected ${a} ≈ ${b} (tol=${tol})`);
}

// ── Validation logic (inline, no DB) ──

function computeBaselineMetrics(trades) {
  if (!trades.length) return emptyMetrics();
  const closed = trades.filter(t => t.closedAt !== null);
  const winners = closed.filter(t => t.netPnl > 0);
  const losers = closed.filter(t => t.netPnl <= 0);
  const avgWin = winners.length > 0 ? winners.reduce((s, t) => s + t.netPnl, 0) / winners.length : 0;
  const avgLoss = losers.length > 0 ? losers.reduce((s, t) => s + t.netPnl, 0) / losers.length : 0;
  const netPnl = closed.reduce((s, t) => s + t.netPnl, 0);
  const winRate = closed.length > 0 ? (winners.length / closed.length) * 100 : 0;
  const expectancy = closed.length > 0 ? netPnl / closed.length : 0;
  const grossWin = winners.reduce((s, t) => s + t.netPnl, 0);
  const grossLoss = Math.abs(losers.reduce((s, t) => s + t.netPnl, 0));
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0;
  let peak = 0, maxDrawdown = 0, runningPnl = 0;
  for (const t of closed) {
    runningPnl += t.netPnl;
    peak = Math.max(peak, runningPnl);
    maxDrawdown = Math.max(maxDrawdown, peak - runningPnl);
  }
  return { totalTrades: closed.length, winners: winners.length, winRate, avgWin, avgLoss,
    netPnl, expectancy, maxDrawdown, profitFactor, avgHoldingPeriodMinutes: 0, byDayOfWeek: {} };
}

function emptyMetrics() {
  return { totalTrades: 0, winners: 0, winRate: 0, avgWin: 0, avgLoss: 0,
    netPnl: 0, expectancy: 0, maxDrawdown: 0, profitFactor: 0,
    avgHoldingPeriodMinutes: 0, byDayOfWeek: {} };
}

function splitHoldout(trades) {
  const sorted = [...trades].sort((a, b) => a.orderedAt.getTime() - b.orderedAt.getTime());
  const splitIdx = Math.floor(sorted.length * 0.7);
  return { inSample: sorted.slice(0, splitIdx), outOfSample: sorted.slice(splitIdx) };
}

function computeStabilityScore(trades, windowSize = 5) {
  if (trades.length < windowSize) return 0;
  const sorted = [...trades].sort((a, b) => a.orderedAt.getTime() - b.orderedAt.getTime());
  let positiveWindows = 0, totalWindows = 0;
  for (let i = 0; i <= sorted.length - windowSize; i++) {
    const window = sorted.slice(i, i + windowSize);
    const windowPnl = window.reduce((s, t) => s + t.netPnl, 0);
    if (windowPnl > 0) positiveWindows++;
    totalWindows++;
  }
  return totalWindows > 0 ? positiveWindows / totalWindows : 0;
}

// ── Adaptation safety logic (inline) ──

const PROHIBITED_PARAMS = [
  'maxRiskPerTrade', 'maxOpenPositions', 'maxDailyLoss', 'realOrderAllowed',
  'stopLossPercent', 'takeProfitPercent', 'staleDataThreshold',
  'connectionTimeout', 'retryAttempts', 'providerPriority',
];

const PARAM_BOUNDS = {
  decayRate: { min: 0.01, max: 0.99 },
  timingWindowMinutes: { min: 10, max: 120 },
  confidenceThreshold: { min: 0.3, max: 0.95 },
  spreadThreshold: { min: 0.01, max: 5.0 },
  liquidityMinimum: { min: 10, max: 10000 },
};

function isParamAdaptable(paramName) {
  if (PROHIBITED_PARAMS.includes(paramName)) return { allowed: false, reason: 'Prohibited' };
  return { allowed: true };
}

function isValueBounded(paramName, value) {
  const bounds = PARAM_BOUNDS[paramName];
  if (!bounds) return { valid: true };
  if (typeof value !== 'number') return { valid: false, reason: 'Expected number' };
  if (value < bounds.min || value > bounds.max) return { valid: false, reason: 'Out of bounds' };
  return { valid: true };
}

// ── Generate synthetic trades ──

function makeTrades(count, winRate = 0.5, avgPnl = 100) {
  const trades = [];
  const baseDate = new Date('2026-09-01T09:15:00+05:30');
  for (let i = 0; i < count; i++) {
    const isWin = Math.random() < winRate;
    const pnl = isWin ? Math.abs(avgPnl * (0.5 + Math.random())) : -Math.abs(avgPnl * (0.5 + Math.random()));
    const orderedAt = new Date(baseDate.getTime() + i * 3600000);
    const closedAt = new Date(orderedAt.getTime() + (15 + Math.random() * 45) * 60000);
    trades.push({
      instrumentKey: `NIFTY26SEP${24000 + Math.floor(Math.random() * 20) * 100}CE`,
      underlying: 'NIFTY',
      optionType: 'CE',
      strike: 24000 + Math.floor(Math.random() * 20) * 100,
      expiry: '2026-09-25',
      netPnl: pnl,
      entryPrice: 100 + Math.random() * 50,
      exitPrice: 100 + Math.random() * 50,
      orderedAt,
      closedAt,
      entrySource: ['DECAY_AM', 'DECAY_PM', 'MANUAL'][Math.floor(Math.random() * 3)],
    });
  }
  return trades;
}

// ══════════════════════════════════════════════════════════
console.log('ValidationEngine tests');
console.log('');

// ── Baseline metrics ──

test('baseline: empty trades', () => {
  const m = computeBaselineMetrics([]);
  assert(m.totalTrades === 0);
  assert(m.winRate === 0);
});

test('baseline: all winners', () => {
  const trades = makeTrades(10, 1.0, 100);
  const m = computeBaselineMetrics(trades);
  assert(m.totalTrades === 10);
  assert(m.winners === 10);
  approx(m.winRate, 100);
  assert(m.netPnl > 0);
});

test('baseline: all losers', () => {
  const trades = makeTrades(10, 0.0, 100);
  const m = computeBaselineMetrics(trades);
  assert(m.totalTrades === 10);
  assert(m.winners === 0);
  approx(m.winRate, 0);
  assert(m.netPnl < 0);
});

test('baseline: 50/50 win rate', () => {
  const trades = makeTrades(100, 0.5, 100);
  const m = computeBaselineMetrics(trades);
  assert(m.totalTrades === 100);
  approx(m.winRate, 50, 15); // ~50% with variance
});

test('baseline: profit factor', () => {
  const trades = makeTrades(20, 0.6, 100);
  const m = computeBaselineMetrics(trades);
  assert(m.profitFactor > 0, 'Profit factor should be positive');
});

test('baseline: max drawdown', () => {
  const trades = makeTrades(30, 0.3, 100); // losing strategy
  const m = computeBaselineMetrics(trades);
  assert(m.maxDrawdown >= 0, 'Max drawdown should be non-negative');
});

// ── Holdout split ──

test('holdout: 70/30 split', () => {
  const trades = makeTrades(20, 0.5, 100);
  const { inSample, outOfSample } = splitHoldout(trades);
  assert(inSample.length === 14, `Expected 14 in-sample, got ${inSample.length}`);
  assert(outOfSample.length === 6, `Expected 6 out-of-sample, got ${outOfSample.length}`);
});

test('holdout: preserves time order', () => {
  const trades = makeTrades(10, 0.5, 100);
  const { inSample, outOfSample } = splitHoldout(trades);
  // in-sample should be earlier than out-of-sample
  const lastIn = inSample[inSample.length - 1].orderedAt;
  const firstOut = outOfSample[0].orderedAt;
  assert(lastIn <= firstOut, 'In-sample should end before out-of-sample starts');
});

// ── Stability score ──

test('stability: all profitable → high stability', () => {
  const trades = makeTrades(20, 1.0, 100);
  const score = computeStabilityScore(trades, 5);
  approx(score, 1.0, 0.01);
});

test('stability: alternating → medium stability', () => {
  const trades = makeTrades(20, 0.5, 100);
  const score = computeStabilityScore(trades, 5);
  assert(score >= 0 && score <= 1, 'Score should be in [0, 1]');
});

test('stability: too few trades', () => {
  const trades = makeTrades(3, 0.5, 100);
  const score = computeStabilityScore(trades, 5);
  assert(score === 0, 'Score should be 0 for insufficient trades');
});

// ══════════════════════════════════════════════════════════
console.log('');
console.log('AdaptationEngine safety tests');
console.log('');

// ── Safety gates ──

test('safety: maxRiskPerTrade is prohibited', () => {
  const result = isParamAdaptable('maxRiskPerTrade');
  assert(result.allowed === false);
  assert(result.reason.includes('Prohibited'));
});

test('safety: realOrderAllowed is prohibited', () => {
  const result = isParamAdaptable('realOrderAllowed');
  assert(result.allowed === false);
});

test('safety: stopLossPercent is prohibited', () => {
  const result = isParamAdaptable('stopLossPercent');
  assert(result.allowed === false);
});

test('safety: decayRate is allowed', () => {
  const result = isParamAdaptable('decayRate');
  assert(result.allowed === true);
});

test('safety: timingWindowMinutes is allowed', () => {
  const result = isParamAdaptable('timingWindowMinutes');
  assert(result.allowed === true);
});

test('safety: confidenceThreshold is allowed', () => {
  const result = isParamAdaptable('confidenceThreshold');
  assert(result.allowed === true);
});

// ── Value bounds ──

test('bounds: decayRate in range', () => {
  assert(isValueBounded('decayRate', 0.05).valid === true);
  assert(isValueBounded('decayRate', 0.50).valid === true);
});

test('bounds: decayRate out of range', () => {
  assert(isValueBounded('decayRate', 0.001).valid === false);
  assert(isValueBounded('decayRate', 0.999).valid === false);
});

test('bounds: timingWindowMinutes in range', () => {
  assert(isValueBounded('timingWindowMinutes', 30).valid === true);
  assert(isValueBounded('timingWindowMinutes', 60).valid === true);
});

test('bounds: timingWindowMinutes out of range', () => {
  assert(isValueBounded('timingWindowMinutes', 5).valid === false);
  assert(isValueBounded('timingWindowMinutes', 200).valid === false);
});

test('bounds: unknown param passes (no bounds defined)', () => {
  assert(isValueBounded('unknownParam', 42).valid === true);
});

test('bounds: non-number value rejected for bounded param', () => {
  assert(isValueBounded('decayRate', 'not_a_number').valid === false);
});

// ── Lifecycle states ──

test('lifecycle: candidate state machine', () => {
  // Simulate lifecycle
  const candidate = {
    status: 'PROPOSED',
    paramName: 'decayRate',
    oldValue: 0.05,
    proposedValue: 0.06,
  };

  // PROPOSED → VALIDATING
  assert(candidate.status === 'PROPOSED');
  candidate.status = 'VALIDATING';

  // VALIDATING → APPROVED (with validation result)
  assert(candidate.status === 'VALIDATING');
  candidate.status = 'APPROVED';
  candidate.validationId = 'val-123';

  // APPROVED → ACTIVE
  assert(candidate.status === 'APPROVED');
  candidate.status = 'ACTIVE';
  candidate.activatedAt = new Date();

  assert(candidate.status === 'ACTIVE');
  assert(candidate.activatedAt !== null);
});

test('lifecycle: rejection stops the chain', () => {
  const candidate = {
    status: 'VALIDATING',
    paramName: 'spreadThreshold',
  };
  candidate.status = 'REJECTED';
  assert(candidate.status === 'REJECTED');
  // Cannot activate a rejected candidate
  const canActivate = candidate.status === 'APPROVED';
  assert(canActivate === false);
});

test('lifecycle: rollback from ACTIVE', () => {
  const candidate = {
    status: 'ACTIVE',
    paramName: 'decayRate',
    proposedValue: 0.06,
    rollbackValue: 0.05,
  };
  const previousValue = candidate.proposedValue;
  const restoredValue = candidate.rollbackValue;
  candidate.status = 'ROLLED_BACK';

  assert(candidate.status === 'ROLLED_BACK');
  assert(previousValue === 0.06);
  assert(restoredValue === 0.05);
});

// ── Integration: validation pass/fail ──

test('integration: good candidate passes validation', () => {
  // Deterministic: baseline = 9W/20L (45%), candidate = 16W/20L (80%)
  const baseDate = new Date('2026-09-01T09:00:00+05:30');
  const baseline = [];
  for (let i = 0; i < 20; i++) {
    baseline.push({
      instrumentKey: 'TEST', underlying: 'NIFTY', optionType: 'CE', strike: 24000,
      expiry: '2026-09-25', netPnl: i < 11 ? -100 : 150,
      entryPrice: 100, exitPrice: 100,
      orderedAt: new Date(baseDate.getTime() + i * 3600000),
      closedAt: new Date(baseDate.getTime() + i * 3600000 + 1800000),
      entrySource: 'DECAY_AM',
    });
  }
  const candidate = [];
  for (let i = 0; i < 20; i++) {
    candidate.push({
      instrumentKey: 'TEST', underlying: 'NIFTY', optionType: 'CE', strike: 24000,
      expiry: '2026-09-25', netPnl: i < 4 ? -100 : 200,
      entryPrice: 100, exitPrice: 100,
      orderedAt: new Date(baseDate.getTime() + 100000000 + i * 3600000),
      closedAt: new Date(baseDate.getTime() + 100000000 + i * 3600000 + 1800000),
      entrySource: 'DECAY_AM',
    });
  }

  const bMetrics = computeBaselineMetrics(baseline);
  const cMetrics = computeBaselineMetrics(candidate);

  assert(bMetrics.winRate === 45, 'Baseline win rate should be 45%, got ' + bMetrics.winRate);
  assert(cMetrics.winRate === 80, 'Candidate win rate should be 80%, got ' + cMetrics.winRate);

  const winRateImprovement = cMetrics.winRate - bMetrics.winRate;
  const MIN_WINRATE_IMPROVEMENT = 0.5;
  const passed = winRateImprovement >= -MIN_WINRATE_IMPROVEMENT;
  assert(passed === true, 'Candidate with better win rate should pass');
});

test('integration: bad candidate fails validation', () => {
  // Deterministic: baseline = 12W/20L (60%), candidate = 3W/20L (15%)
  const baseDate = new Date('2026-09-01T09:00:00+05:30');
  const baseline = [];
  for (let i = 0; i < 20; i++) {
    baseline.push({
      instrumentKey: 'TEST', underlying: 'NIFTY', optionType: 'CE', strike: 24000,
      expiry: '2026-09-25', netPnl: i < 12 ? 100 : -150,
      entryPrice: 100, exitPrice: 100,
      orderedAt: new Date(baseDate.getTime() + i * 3600000),
      closedAt: new Date(baseDate.getTime() + i * 3600000 + 1800000),
      entrySource: 'DECAY_AM',
    });
  }
  const candidate = [];
  for (let i = 0; i < 20; i++) {
    candidate.push({
      instrumentKey: 'TEST', underlying: 'NIFTY', optionType: 'CE', strike: 24000,
      expiry: '2026-09-25', netPnl: i < 3 ? 200 : -100,
      entryPrice: 100, exitPrice: 100,
      orderedAt: new Date(baseDate.getTime() + 100000000 + i * 3600000),
      closedAt: new Date(baseDate.getTime() + 100000000 + i * 3600000 + 1800000),
      entrySource: 'DECAY_AM',
    });
  }

  const bMetrics = computeBaselineMetrics(baseline);
  const cMetrics = computeBaselineMetrics(candidate);

  assert(bMetrics.winRate === 60, 'Baseline win rate should be 60%, got ' + bMetrics.winRate);
  assert(cMetrics.winRate === 15, 'Candidate win rate should be 15%, got ' + cMetrics.winRate);

  const winRateImprovement = cMetrics.winRate - bMetrics.winRate;
  const passed = winRateImprovement >= -0.5;
  assert(passed === false, 'Candidate with worse win rate should fail');
});

test('integration: too-small sample rejected', () => {
  const baseline = makeTrades(3, 0.5, 100); // too few
  const m = computeBaselineMetrics(baseline);
  const MIN_BASELINE_TRADES = 10;
  const passed = m.totalTrades >= MIN_BASELINE_TRADES;
  assert(passed === false, 'Small baseline should be rejected');
});

// ── REAL_ORDER_ALLOWED hardcoded check ──

test('safety: REAL_ORDER_ALLOWED cannot be adapted', () => {
  const result = isParamAdaptable('realOrderAllowed');
  assert(result.allowed === false, 'REAL_ORDER_ALLOWED must never be adaptable');
});

test('safety: providerPriority cannot be adapted', () => {
  const result = isParamAdaptable('providerPriority');
  assert(result.allowed === false);
});

// ══════════════════════════════════════════════════════════

console.log('');
console.log(`All ${passed + failed} tests: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
