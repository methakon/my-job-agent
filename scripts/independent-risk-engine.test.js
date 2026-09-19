/**
 * Independent Risk Engine tests — items 255-271 (GATE 16)
 * Tests consecutive loss, volatility shutdown, kill switch, state machine,
 * duplicate order protection, and composite safety check.
 */

const assert = require('assert');
const {
  countConsecutiveLosses,
  checkVolatilityShutdown,
  evaluateKillSwitch,
  checkDuplicateOrder,
  canTransition,
  compositeSafetyCheck,
  MODE_ORDER,
} = require('../dist/trading/independent-risk-engine');

let pass = 0;
let fail = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    pass++;
  } catch (e) {
    console.log(`  ✗ ${name}: ${e.message}`);
    fail++;
  }
}

function eq(a, b, msg) {
  assert.strictEqual(a, b, msg || `expected ${b}, got ${a}`);
}

function approx(a, b, tol, msg) {
  assert.ok(Math.abs(a - b) < tol, msg || `expected ~${b}, got ${a}`);
}

// ── Consecutive Loss ─────────────────────────────────────────────────────────

console.log('\n── Consecutive Loss Tracking ──');

test('1. no losses → count=0, not exceeded', () => {
  const r = countConsecutiveLosses([
    { id: '1', symbol: 'NIFTY', pnl: 500, closedAtMs: 1000, mode: 'PAPER' },
    { id: '2', symbol: 'NIFTY', pnl: 300, closedAtMs: 900, mode: 'PAPER' },
  ]);
  eq(r.count, 0);
  eq(r.exceeded, false);
});

test('2. 2 consecutive losses → count=2', () => {
  const r = countConsecutiveLosses([
    { id: '1', symbol: 'NIFTY', pnl: -200, closedAtMs: 1000, mode: 'PAPER' },
    { id: '2', symbol: 'NIFTY', pnl: -300, closedAtMs: 900, mode: 'PAPER' },
    { id: '3', symbol: 'NIFTY', pnl: 100, closedAtMs: 800, mode: 'PAPER' },
  ]);
  eq(r.count, 2);
  eq(r.exceeded, false); // default max=3
});

test('3. 3 consecutive losses → count=3, exceeded=true', () => {
  const r = countConsecutiveLosses([
    { id: '1', symbol: 'NIFTY', pnl: -100, closedAtMs: 1000, mode: 'PAPER' },
    { id: '2', symbol: 'NIFTY', pnl: -100, closedAtMs: 900, mode: 'PAPER' },
    { id: '3', symbol: 'NIFTY', pnl: -100, closedAtMs: 800, mode: 'PAPER' },
  ]);
  eq(r.count, 3);
  eq(r.exceeded, true);
});

test('4. loss pct exceeded even with fewer losses', () => {
  const r = countConsecutiveLosses(
    [
      { id: '1', symbol: 'NIFTY', pnl: -3000, closedAtMs: 1000, mode: 'PAPER' },
      { id: '2', symbol: 'NIFTY', pnl: -2500, closedAtMs: 900, mode: 'PAPER' },
    ],
    3,  // max count
    5.0, // max pct
    100000, // equity
  );
  eq(r.count, 2);
  eq(r.exceeded, true); // 5.5% > 5%
});

test('5. empty positions → count=0, not exceeded', () => {
  const r = countConsecutiveLosses([]);
  eq(r.count, 0);
  eq(r.exceeded, false);
});

// ── Volatility Shutdown ──────────────────────────────────────────────────────

console.log('\n── Volatility Shutdown ──');

test('6. normal volatility → no shutdown', () => {
  const r = checkVolatilityShutdown(100, 100, 2.0);
  eq(r.shouldShutdown, false);
  approx(r.atrMultiple, 1.0, 0.01);
});

test('7. doubled volatility → shutdown at 2x threshold', () => {
  const r = checkVolatilityShutdown(200, 100, 2.0);
  eq(r.shouldShutdown, true);
  approx(r.atrMultiple, 2.0, 0.01);
});

test('8. tripled volatility → shutdown', () => {
  const r = checkVolatilityShutdown(300, 100, 2.0);
  eq(r.shouldShutdown, true);
  approx(r.atrMultiple, 3.0, 0.01);
});

test('9. zero baseline → no shutdown (division safe)', () => {
  const r = checkVolatilityShutdown(100, 0, 2.0);
  eq(r.shouldShutdown, false);
  eq(r.atrMultiple, 0);
});

test('10. just below threshold → no shutdown', () => {
  const r = checkVolatilityShutdown(199, 100, 2.0);
  eq(r.shouldShutdown, false);
});

// ── Kill Switch ──────────────────────────────────────────────────────────────

console.log('\n── Kill Switch ──');

test('11. no triggers → kill switch stays inactive', () => {
  const current = { active: false, activatedAtMs: 0, reason: '' };
  const r = evaluateKillSwitch(current, {}, 1000);
  eq(r.active, false);
});

test('12. session loss ≥ 5% → kill switch activates', () => {
  const current = { active: false, activatedAtMs: 0, reason: '' };
  const r = evaluateKillSwitch(current, { sessionLossPct: 5.0 }, 1000);
  eq(r.active, true);
  assert.ok(r.reason.includes('session_loss'));
});

test('13. drawdown ≥ 10% → kill switch activates', () => {
  const current = { active: false, activatedAtMs: 0, reason: '' };
  const r = evaluateKillSwitch(current, { drawdownPct: 10.0 }, 2000);
  eq(r.active, true);
  assert.ok(r.reason.includes('drawdown'));
});

test('14. already active → stays active with original reason', () => {
  const current = { active: true, activatedAtMs: 500, reason: 'previous' };
  const r = evaluateKillSwitch(current, { sessionLossPct: 5 }, 1000);
  eq(r.active, true);
  eq(r.activatedAtMs, 500); // unchanged
});

test('15. multiple triggers → all included in reason', () => {
  const current = { active: false, activatedAtMs: 0, reason: '' };
  const r = evaluateKillSwitch(
    current,
    { sessionLossPct: 6, drawdownPct: 12, consecutiveLosses: 4 },
    3000,
  );
  eq(r.active, true);
  assert.ok(r.reason.includes('session_loss'));
  assert.ok(r.reason.includes('drawdown'));
  assert.ok(r.reason.includes('consecutive_losses'));
});

// ── Duplicate Order Protection ───────────────────────────────────────────────

console.log('\n── Duplicate Order Protection ──');

test('16. no recent orders → allowed', () => {
  const r = checkDuplicateOrder(
    { orderId: 'O1', symbol: 'NIFTY', side: 'BUY', placedAtMs: 1000 },
    [],
  );
  eq(r.allowed, true);
});

test('17. same symbol+side within window → blocked', () => {
  const r = checkDuplicateOrder(
    { orderId: 'O2', symbol: 'NIFTY', side: 'BUY', placedAtMs: 1000 },
    [{ orderId: 'O1', symbol: 'NIFTY', side: 'BUY', placedAtMs: 990 }],
  );
  eq(r.allowed, false);
  assert.ok(r.reason.includes('similar order'));
});

test('18. different side → allowed', () => {
  const r = checkDuplicateOrder(
    { orderId: 'O2', symbol: 'NIFTY', side: 'SELL', placedAtMs: 1000 },
    [{ orderId: 'O1', symbol: 'NIFTY', side: 'BUY', placedAtMs: 990 }],
  );
  eq(r.allowed, true);
});

test('19. outside window → allowed', () => {
  const r = checkDuplicateOrder(
    { orderId: 'O2', symbol: 'NIFTY', side: 'BUY', placedAtMs: 1000 },
    [{ orderId: 'O1', symbol: 'NIFTY', side: 'BUY', placedAtMs: -100_000 }],
    30_000,
  );
  eq(r.allowed, true); // -100s < cutoff (-29s), outside 30s window
});

test('20. same orderId → not counted as duplicate', () => {
  const r = checkDuplicateOrder(
    { orderId: 'O1', symbol: 'NIFTY', side: 'BUY', placedAtMs: 1000 },
    [{ orderId: 'O1', symbol: 'NIFTY', side: 'BUY', placedAtMs: 990 }],
  );
  eq(r.allowed, true);
});

// ── State Machine ────────────────────────────────────────────────────────────

console.log('\n── Execution Mode State Machine ──');

test('21. PAPER → SHADOW always allowed', () => {
  const r = canTransition('PAPER', 'SHADOW', false);
  eq(r.allowed, true);
});

test('22. SHADOW → MICRO_LIVE without gates → blocked', () => {
  const r = canTransition('SHADOW', 'MICRO_LIVE', false);
  eq(r.allowed, false);
  assert.ok(r.reason.includes('GREEN'));
});

test('23. SHADOW → MICRO_LIVE with gates → allowed', () => {
  const r = canTransition('SHADOW', 'MICRO_LIVE', true);
  eq(r.allowed, true);
});

test('24. MICRO_LIVE → LIVE without gates → blocked', () => {
  const r = canTransition('MICRO_LIVE', 'LIVE', false);
  eq(r.allowed, false);
  assert.ok(r.reason.includes('GREEN'));
});

test('25. MICRO_LIVE → LIVE with gates → allowed', () => {
  const r = canTransition('MICRO_LIVE', 'LIVE', true);
  eq(r.allowed, true);
});

test('26. backward transition blocked', () => {
  const r = canTransition('SHADOW', 'PAPER', true);
  eq(r.allowed, false);
  assert.ok(r.reason.includes('backward'));
});

test('27. same mode → no-op allowed', () => {
  const r = canTransition('PAPER', 'PAPER', false);
  eq(r.allowed, true);
  assert.ok(r.reason.includes('no-op'));
});

test('28. PAPER → MICRO_LIVE requires gates', () => {
  const r = canTransition('PAPER', 'MICRO_LIVE', false);
  eq(r.allowed, false);
  assert.ok(r.reason.includes('GREEN'));
});

// ── Composite Safety Check ───────────────────────────────────────────────────

console.log('\n── Composite Safety Check ──');

test('29. clean state → allowed, NONE risk', () => {
  const r = compositeSafetyCheck({
    currentMode: 'PAPER',
    request: { orderId: 'O1', symbol: 'NIFTY', side: 'BUY', placedAtMs: 1000 },
    recentOrders: [],
    recentPositions: [],
    currentAtr: 100,
    baselineAtr: 100,
    killSwitch: { active: false, activatedAtMs: 0, reason: '' },
    nowMs: 1000,
    equity: 100000,
    sessionLossPct: 0,
    drawdownPct: 0,
    gatesGreen: false,
  });
  eq(r.allowed, true);
  eq(r.riskLevel, 'NONE');
});

test('30. kill switch active → blocked, CRITICAL', () => {
  const r = compositeSafetyCheck({
    currentMode: 'PAPER',
    request: { orderId: 'O1', symbol: 'NIFTY', side: 'BUY', placedAtMs: 1000 },
    recentOrders: [],
    recentPositions: [],
    currentAtr: 100,
    baselineAtr: 100,
    killSwitch: { active: true, activatedAtMs: 500, reason: 'test' },
    nowMs: 1000,
    equity: 100000,
    sessionLossPct: 0,
    drawdownPct: 0,
    gatesGreen: false,
  });
  eq(r.allowed, false);
  eq(r.riskLevel, 'CRITICAL');
  assert.ok(r.refusals.some((x) => x.includes('kill_switch')));
});

test('31. consecutive loss → blocked', () => {
  const r = compositeSafetyCheck({
    currentMode: 'PAPER',
    request: { orderId: 'O1', symbol: 'NIFTY', side: 'BUY', placedAtMs: 1000 },
    recentOrders: [],
    recentPositions: [
      { id: '1', symbol: 'NIFTY', pnl: -200, closedAtMs: 900, mode: 'PAPER' },
      { id: '2', symbol: 'NIFTY', pnl: -200, closedAtMs: 800, mode: 'PAPER' },
      { id: '3', symbol: 'NIFTY', pnl: -200, closedAtMs: 700, mode: 'PAPER' },
    ],
    currentAtr: 100,
    baselineAtr: 100,
    killSwitch: { active: false, activatedAtMs: 0, reason: '' },
    nowMs: 1000,
    equity: 100000,
    sessionLossPct: 0,
    drawdownPct: 0,
    gatesGreen: false,
  });
  eq(r.allowed, false);
  assert.ok(r.refusals.some((x) => x.includes('consecutive_loss')));
});

test('32. volatility spike → blocked', () => {
  const r = compositeSafetyCheck({
    currentMode: 'PAPER',
    request: { orderId: 'O1', symbol: 'NIFTY', side: 'BUY', placedAtMs: 1000 },
    recentOrders: [],
    recentPositions: [],
    currentAtr: 300,
    baselineAtr: 100,
    killSwitch: { active: false, activatedAtMs: 0, reason: '' },
    nowMs: 1000,
    equity: 100000,
    sessionLossPct: 0,
    drawdownPct: 0,
    gatesGreen: false,
  });
  eq(r.allowed, false);
  assert.ok(r.refusals.some((x) => x.includes('volatility_shutdown')));
});

test('33. duplicate order → blocked', () => {
  const r = compositeSafetyCheck({
    currentMode: 'PAPER',
    request: { orderId: 'O2', symbol: 'NIFTY', side: 'BUY', placedAtMs: 1000 },
    recentOrders: [
      { orderId: 'O1', symbol: 'NIFTY', side: 'BUY', placedAtMs: 995 },
    ],
    recentPositions: [],
    currentAtr: 100,
    baselineAtr: 100,
    killSwitch: { active: false, activatedAtMs: 0, reason: '' },
    nowMs: 1000,
    equity: 100000,
    sessionLossPct: 0,
    drawdownPct: 0,
    gatesGreen: false,
  });
  eq(r.allowed, false);
  assert.ok(r.refusals.some((x) => x.includes('duplicate_order')));
});

test('34. LIVE mode without GREEN gates → blocked', () => {
  const r = compositeSafetyCheck({
    currentMode: 'LIVE',
    request: { orderId: 'O1', symbol: 'NIFTY', side: 'BUY', placedAtMs: 1000 },
    recentOrders: [],
    recentPositions: [],
    currentAtr: 100,
    baselineAtr: 100,
    killSwitch: { active: false, activatedAtMs: 0, reason: '' },
    nowMs: 1000,
    equity: 100000,
    sessionLossPct: 0,
    drawdownPct: 0,
    gatesGreen: false,
  });
  eq(r.allowed, false);
  assert.ok(r.refusals.some((x) => x.includes('LIVE_mode_without_GREEN')));
});

test('35. LIVE mode with GREEN gates → allowed', () => {
  const r = compositeSafetyCheck({
    currentMode: 'LIVE',
    request: { orderId: 'O1', symbol: 'NIFTY', side: 'BUY', placedAtMs: 1000 },
    recentOrders: [],
    recentPositions: [],
    currentAtr: 100,
    baselineAtr: 100,
    killSwitch: { active: false, activatedAtMs: 0, reason: '' },
    nowMs: 1000,
    equity: 100000,
    sessionLossPct: 0,
    drawdownPct: 0,
    gatesGreen: true,
  });
  eq(r.allowed, true);
});

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n── Independent Risk Engine: ${pass} pass, ${fail} fail ──`);
process.exit(fail > 0 ? 1 : 0);
