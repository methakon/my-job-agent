/**
 * Gap Database tests — gap classification, stats, closer detection, range position.
 * Covers items: gap database module, MAE/MFE tracking, gap closer evaluation.
 */

const assert = require('assert');
const {
  classifyGap,
  computeGapStats,
  detectGapCloser,
  evaluateGapRangePosition,
  evaluateGapAcceptance,
} = require('../dist/trading/gap-database');

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

// ── Gap Classification ───────────────────────────────────────────────────────

console.log('\n── Gap Classification ──');

test('1. flat gap → CONTINUATION', () => {
  eq(classifyGap(0.05, 10, 5, true), 'CONTINUATION');
});

test('2. gap up + more adverse → FADE', () => {
  eq(classifyGap(1.5, 5, 15, true), 'FADE');
});

test('3. gap up + more favorable → FOLLOW', () => {
  eq(classifyGap(1.5, 15, 5, true), 'FOLLOW');
});

test('4. gap down + more favorable (price drops further) → FADE', () => {
  eq(classifyGap(-1.5, 15, 5, true), 'FADE');
});

test('5. gap down + more adverse → FOLLOW', () => {
  eq(classifyGap(-1.5, 5, 15, true), 'FOLLOW');
});

test('6. gap up, equal mfe/mae → CONTINUATION', () => {
  eq(classifyGap(1.0, 10, 10, true), 'CONTINUATION');
});

// ── Gap Stats ────────────────────────────────────────────────────────────────

console.log('\n── Gap Stats ──');

test('7. empty gaps → zero stats', () => {
  const s = computeGapStats([]);
  eq(s.totalGaps, 0);
  eq(s.fadeCount, 0);
  eq(s.fillRate, 0);
});

test('8. mixed gaps → correct counts', () => {
  const gaps = [
    { classification: 'FADE', maxFavorableExtensionPct: 5, maxAdverseExtensionPct: 15, timeToTargetMs: 1000, filled: true } ,
    { classification: 'FOLLOW', maxFavorableExtensionPct: 15, maxAdverseExtensionPct: 5, timeToTargetMs: 2000, filled: true },
    { classification: 'CONTINUATION', maxFavorableExtensionPct: 10, maxAdverseExtensionPct: 10, timeToTargetMs: 3000, filled: false },
  ];
  const s = computeGapStats(gaps);
  eq(s.totalGaps, 3);
  eq(s.fadeCount, 1);
  eq(s.followCount, 1);
  eq(s.continuationCount, 1);
  approx(s.avgMfePct, 10, 0.01);
  approx(s.avgMaePct, 10, 0.01);
  approx(s.avgTimeToTargetMs, 2000, 0.01);
  approx(s.fillRate, 2 / 3, 0.01);
});

test('9. all filled → fill rate = 1', () => {
  const gaps = [
    { classification: 'FADE', maxFavorableExtensionPct: 5, maxAdverseExtensionPct: 15, timeToTargetMs: 1000, filled: true },
    { classification: 'FOLLOW', maxFavorableExtensionPct: 15, maxAdverseExtensionPct: 5, timeToTargetMs: 2000, filled: true },
  ];
  const s = computeGapStats(gaps);
  eq(s.fillRate, 1);
});

// ── Gap Closer Detection ─────────────────────────────────────────────────────

console.log('\n── Gap Closer Detection ──');

test('10. no historical gaps → not a closer', () => {
  const current = { symbol: 'NIFTY', tradeDate: '2026-09-19', preClose: 100, open: 101, high: 102, low: 99, close: 101, volume: 1000, gapPct: 1.0, gapDirection: 'UP', maxFavorableExtensionPct: 2, maxAdverseExtensionPct: 0.5, timeToTargetMs: 60000, filled: true, classification: 'FOLLOW' };
  const r = detectGapCloser(current, [], 5);
  eq(r.isCloser, false);
});

test('11. opposing unfilled gap → is a closer', () => {
  const unfilled = { symbol: 'NIFTY', tradeDate: '2026-09-17', preClose: 102, open: 100, high: 101, low: 99, close: 100.5, volume: 800, gapPct: -2.0, gapDirection: 'DOWN', maxFavorableExtensionPct: 3, maxAdverseExtensionPct: 1, timeToTargetMs: 120000, filled: false, classification: 'FOLLOW' };
  const current = { symbol: 'NIFTY', tradeDate: '2026-09-19', preClose: 100, open: 101, high: 102, low: 99, close: 101, volume: 1000, gapPct: 1.0, gapDirection: 'UP', maxFavorableExtensionPct: 2, maxAdverseExtensionPct: 0.5, timeToTargetMs: 60000, filled: true, classification: 'FOLLOW' };
  const r = detectGapCloser(current, [unfilled], 5);
  eq(r.isCloser, true);
  eq(r.closerDirection, 'UP');
  approx(r.closerMagnitude, 2.0, 0.01);
});

test('12. same-direction unfilled gap → not a closer', () => {
  const sameDir = { symbol: 'NIFTY', tradeDate: '2026-09-17', preClose: 99, open: 100, high: 101, low: 99, close: 100.5, volume: 800, gapPct: 1.0, gapDirection: 'UP', maxFavorableExtensionPct: 3, maxAdverseExtensionPct: 1, timeToTargetMs: 120000, filled: false, classification: 'FOLLOW' };
  const current = { symbol: 'NIFTY', tradeDate: '2026-09-19', preClose: 100, open: 101, high: 102, low: 99, close: 101, volume: 1000, gapPct: 1.0, gapDirection: 'UP', maxFavorableExtensionPct: 2, maxAdverseExtensionPct: 0.5, timeToTargetMs: 60000, filled: true, classification: 'FOLLOW' };
  const r = detectGapCloser(current, [sameDir], 5);
  eq(r.isCloser, false);
});

// ── Gap Range Position ───────────────────────────────────────────────────────

console.log('\n── Gap Range Position ──');

test('13. price at midpoint → MIDPOINT', () => {
  const r = evaluateGapRangePosition({ preClose: 100, open: 102, high: 103, low: 99, currentPrice: 101 });
  eq(r.position, 'MIDPOINT');
  eq(r.insideGap, true);
});

test('14. price at pre-close side → PRE_CLOSE', () => {
  const r = evaluateGapRangePosition({ preClose: 100, open: 102, high: 103, low: 99, currentPrice: 100.3 });
  eq(r.position, 'PRE_CLOSE');
  eq(r.insideGap, true);
});

test('15. price at open side → OPEN_SIDE', () => {
  const r = evaluateGapRangePosition({ preClose: 100, open: 102, high: 103, low: 99, currentPrice: 101.8 });
  eq(r.position, 'OPEN_SIDE');
  eq(r.insideGap, true);
});

test('16. price outside gap → BREACH', () => {
  const r = evaluateGapRangePosition({ preClose: 100, open: 102, high: 103, low: 99, currentPrice: 104 });
  eq(r.position, 'BREACH');
  eq(r.insideGap, false);
});

test('17. gap down, price at midpoint → MIDPOINT', () => {
  const r = evaluateGapRangePosition({ preClose: 102, open: 100, high: 103, low: 99, currentPrice: 101 });
  eq(r.position, 'MIDPOINT');
});

// ── Gap Acceptance ───────────────────────────────────────────────────────────

console.log('\n── Gap Acceptance ──');

test('18. no gaps → not accepted', () => {
  const r = evaluateGapAcceptance({ gaps: [], windowDays: 5 });
  eq(r.accepted, false);
  eq(r.acceptanceRate, 0);
});

test('19. all filled → accepted', () => {
  const gaps = [
    { filled: true },
    { filled: true },
  ];
  const r = evaluateGapAcceptance({ gaps, windowDays: 5 });
  eq(r.accepted, true);
  eq(r.acceptanceRate, 1);
});

test('20. 50% filled → accepted (≥ 0.5)', () => {
  const gaps = [
    { filled: true },
    { filled: false },
  ];
  const r = evaluateGapAcceptance({ gaps, windowDays: 5 });
  eq(r.accepted, true);
  approx(r.acceptanceRate, 0.5, 0.01);
});

test('21. less than 50% filled → not accepted', () => {
  const gaps = [
    { filled: true },
    { filled: false },
    { filled: false },
  ];
  const r = evaluateGapAcceptance({ gaps, windowDays: 5 });
  eq(r.accepted, false);
  approx(r.acceptanceRate, 1 / 3, 0.01);
});

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n── Gap Database: ${pass} pass, ${fail} fail ──`);
process.exit(fail > 0 ? 1 : 0);
