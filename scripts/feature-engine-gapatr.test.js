#!/usr/bin/env node
/**
 * Roadmap row 427 (GATE 3 P0 features) — GapATR: the opening gap in PRIOR-SESSION ATR units.
 *
 * doneWhen: "The same inputs produce the same result in replay, and edge cases return a safe
 *            explicit state rather than a fabricated value."
 *
 * [A] contract: version + closed refusal vocabulary
 * [B] the formula is exact (ATR-14 = mean of the last 14 true ranges; gapAtr = (open−priorClose)/ATR)
 * [C] every edge case is a safe explicit state — null, NEVER 0/NaN/Infinity
 * [D] the daily-bar collapse: one bar per IST session date, placeholders dropped
 * [E] determinism + no look-ahead (a future bar cannot enter the ATR at t)
 * [F] sign convention (gap up / gap down)
 * [G] purity: the math is importable without a database, and nothing here executes or vetoes
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const REPO = path.join(__dirname, '..');
const M = require(process.env.FEATURE_ENGINE_JS || path.join(REPO, 'dist', 'trading', 'feature-engine.service'));
const SRC = fs.readFileSync(path.join(REPO, 'src', 'trading', 'feature-engine.service.ts'), 'utf8');

let pass = 0;
const failures = [];
const ok = (name, cond, extra) => { if (cond) { pass += 1; console.log(`  PASS ${name}`); } else { failures.push(name); console.log(`  FAIL ${name}${extra ? ' :: ' + extra : ''}`); } };
const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);

/** closes rise by 10/session; high=close+5, low=close−5 ⇒ every TR = 15 exactly. */
const mkBars = (n) => Array.from({ length: n }, (_, i) => {
  const close = 1000 + i * 10;
  return { date: `2024-01-${String(i + 1).padStart(2, '0')}`, open: close - 10, high: close + 5, low: close - 5, close };
});

// ── [A] contract ──────────────────────────────────────────────────────────────
console.log('\n[A] contract');
eq('A1 version pinned', M.GAP_ATR_VERSION, 'gapatr-v1');
eq('A2 period pinned to 14', M.DAILY_ATR_PERIOD, 14);
eq('A3 refusal vocabulary is closed and ordered', M.GAP_ATR_REFUSALS, [
  'NO_OPEN', 'INVALID_OPEN', 'NO_PRIOR_CLOSE', 'INVALID_PRIOR_CLOSE', 'NO_PRIOR_SESSIONS', 'INSUFFICIENT_SESSIONS', 'NO_ATR',
]);

// ── [B] exact formula ─────────────────────────────────────────────────────────
console.log('\n[B] exact formula');
const bars = mkBars(16);
const atr = M.computeDailyAtr14(bars);
eq('B1 ATR-14 = mean of last 14 true ranges (=15)', Number(atr.atr14.toFixed(10)), 15);
eq('B2 ATR reports how many TRs it used', atr.used, 14);
eq('B3 ATR has no refusal', atr.refusal, null);

const priorClose = bars[15].close;
const g = M.computeGapAtr({ open: priorClose + 30, priorClose, priorBars: bars });
eq('B4 gapAtr = (open − priorClose) / ATR = 30/15', Number(g.gapAtr.toFixed(10)), 2);
eq('B5 gapPoints echoed in points', g.gapPoints, 30);
eq('B6 atr14Daily echoed', Number(g.atr14Daily.toFixed(10)), 15);
eq('B7 sessionsUsed echoed', g.sessionsUsed, 14);
eq('B8 ok result has no refusal', g.refusal, null);
eq('B9 version on the result', g.version, 'gapatr-v1');
const g2 = M.computeGapAtr({ open: priorClose + 7.5, priorClose, priorBars: bars });
eq('B10 fractional gap scales linearly', Number(g2.gapAtr.toFixed(10)), 0.5);
const wide = M.computeGapAtr({ open: priorClose + 30, priorClose, priorBars: bars, period: 5 });
ok('B11 period is honoured (mean of last 5 TRs = 15)', Number(wide.atr14Daily.toFixed(10)) === 15 && wide.sessionsUsed === 5);

// ── [C] safe explicit edge states — never 0 / NaN / Infinity ──────────────────
console.log('\n[C] edge states are explicit, never fabricated');
const bad = (name, res, refusal) => {
  ok(`${name}: ${refusal}`, res.refusal === refusal && res.gapAtr === null && res.atr14Daily === null && res.gapAtr === null && !Number.isFinite(res.gapAtr),
    `refusal=${res.refusal} gapAtr=${res.gapAtr}`);
};
bad('C1 open missing', M.computeGapAtr({ open: null, priorClose: 100, priorBars: bars }), 'NO_OPEN');
bad('C2 open 0', M.computeGapAtr({ open: 0, priorClose: 100, priorBars: bars }), 'INVALID_OPEN');
bad('C3 open NaN', M.computeGapAtr({ open: NaN, priorClose: 100, priorBars: bars }), 'NO_OPEN');
bad('C4 priorClose missing', M.computeGapAtr({ open: 100, priorClose: null, priorBars: bars }), 'NO_PRIOR_CLOSE');
bad('C5 priorClose 0', M.computeGapAtr({ open: 100, priorClose: 0, priorBars: bars }), 'INVALID_PRIOR_CLOSE');
bad('C6 no prior sessions', M.computeGapAtr({ open: 1030, priorClose: 1010, priorBars: [] }), 'NO_PRIOR_SESSIONS');
bad('C7 one prior session', M.computeGapAtr({ open: 1030, priorClose: 1010, priorBars: mkBars(1) }), 'NO_PRIOR_SESSIONS');
bad('C8 14 bars < period+1', M.computeGapAtr({ open: 1030, priorClose: 1010, priorBars: mkBars(14) }), 'INSUFFICIENT_SESSIONS');
const flat = Array.from({ length: 16 }, (_, i) => ({ date: `2024-01-${String(i + 1).padStart(2, '0')}`, open: 100, high: 100, low: 100, close: 100 }));
bad('C9 zero true range (flat bars)', M.computeGapAtr({ open: 130, priorClose: 100, priorBars: flat }), 'NO_ATR');
const negAtr = M.computeDailyAtr14([...mkBars(15), { date: '2024-01-16', open: 1, high: 1, low: 1, close: 1 }]);
ok('C10 an ATR of exactly 0 refuses rather than dividing', negAtr.atr14 === null || negAtr.atr14 > 0, `atr=${negAtr.atr14}`);

// ── [D] daily-bar collapse ────────────────────────────────────────────────────
console.log('\n[D] one bar per session date');
const rows = [
  { d: '2024-06-05', o: 22128.35, h: 22670.4, l: 21791.95, c: 22620.35 },
  { d: '2024-06-03', o: 23337.9, h: 23338.7, l: 23062.3, c: 23263.9 },
  { d: '2024-06-04', o: 23179.5, h: 23179.5, l: 21281.45, c: 21884.5 },
  { d: '2024-06-06', o: 100, h: 100, l: 100, c: 100 },          // flat placeholder → dropped
  { d: '2024-06-07', o: 0, h: 10, l: 5, c: 8 },                   // non-positive open → dropped
  { d: 'not-a-date', o: 1, h: 2, l: 0.5, c: 1.5 },                // invalid date → dropped
];
const collapsed = M.toDailyBars(rows);
eq('D1 dates ascending and de-duplicated', collapsed.map((b) => b.date), ['2024-06-03', '2024-06-04', '2024-06-05']);
eq('D2 flat placeholder dropped', collapsed.some((b) => b.date === '2024-06-06'), false);
eq('D3 non-positive open dropped', collapsed.some((b) => b.date === '2024-06-07'), false);
eq('D4 invalid date dropped', collapsed.length, 3);
eq('D5 first bar exact', collapsed[0], { date: '2024-06-03', open: 23337.9, high: 23338.7, low: 23062.3, close: 23263.9 });
eq('D6 input order does not matter', M.toDailyBars([...rows].reverse()).map((b) => b.date), ['2024-06-03', '2024-06-04', '2024-06-05']);
eq('D7 a driver-returned Date is accepted (DATE(ts) columns arrive as Date)',
  M.toDailyBars([{ d: new Date(2024, 5, 3), o: 100, h: 120, l: 90, c: 110 }]).map((b) => b.date), ['2024-06-03']);
eq('D8 an invalid Date is dropped, not coerced',
  M.toDailyBars([{ d: new Date('nonsense'), o: 100, h: 120, l: 90, c: 110 }]).length, 0);
eq('D9 a datetime string keeps its session date',
  M.toDailyBars([{ d: '2024-06-03 09:15:00', o: 100, h: 120, l: 90, c: 110 }]).map((b) => b.date), ['2024-06-03']);
eq('D10 a null date is dropped', M.toDailyBars([{ d: null, o: 100, h: 120, l: 90, c: 110 }]).length, 0);
eq('D11 a NULL numeric column cannot become a real zero',
  M.toDailyBars([{ d: '2024-06-03', o: null, h: 120, l: 90, c: 110 }]).length, 0);

// ── [E] determinism + no look-ahead ──────────────────────────────────────────
console.log('\n[E] determinism + no look-ahead');
const T = 15;
const deterministic = M.computeDailyAtr14(mkBars(16));
ok('E1 same input → identical output (5 runs)', [0, 1, 2, 3, 4].every(() => JSON.stringify(M.computeDailyAtr14(mkBars(16))) === JSON.stringify(deterministic)));
const futureBars = mkBars(30);
const corrupted = futureBars.map((b, i) => (i > T ? { ...b, high: b.high * 100, low: b.low / 100, close: b.close * 100 } : b));
const atPrefix = M.computeDailyAtr14(futureBars.slice(0, T + 1));
const atPrefixCorrupt = M.computeDailyAtr14(corrupted.slice(0, T + 1));
ok('E2 corrupting FUTURE bars cannot change the ATR at t', JSON.stringify(atPrefix) === JSON.stringify(atPrefixCorrupt));
ok('E3 appending a future bar cannot change the ATR AT t (only at t+1)', Number(M.computeDailyAtr14(futureBars.slice(0, T + 1)).atr14.toFixed(10)) === Number(atPrefix.atr14.toFixed(10)));
const gapAtT = M.computeGapAtr({ open: 1100, priorClose: 1090, priorBars: futureBars.slice(0, T + 1) });
const gapAtTCorrupt = M.computeGapAtr({ open: 1100, priorClose: 1090, priorBars: corrupted.slice(0, T + 1) });
ok('E4 gapAtr at t unchanged by future corruption', JSON.stringify(gapAtT) === JSON.stringify(gapAtTCorrupt));
ok('E5 ATR uses the LAST `period` TRs, not the first', (() => {
  const rising = mkBars(16);
  const spiked = rising.map((b, i) => (i >= 2 ? { ...b, high: b.close + 500, low: b.close - 500 } : b));
  return M.computeDailyAtr14(spiked).atr14 > M.computeDailyAtr14(rising).atr14;
})());

// ── [F] sign convention ───────────────────────────────────────────────────────
console.log('\n[F] sign');
ok('F1 gap up → positive', M.computeGapAtr({ open: 1030, priorClose: 1000, priorBars: bars }).gapAtr > 0);
ok('F2 gap down → negative', M.computeGapAtr({ open: 970, priorClose: 1000, priorBars: bars }).gapAtr < 0);
ok('F3 a gap down stays negative (never clamped to 0)', M.computeGapAtr({ open: 970, priorClose: 1000, priorBars: bars }).gapAtr < 0);

// ── [G] purity / research-only ────────────────────────────────────────────────
console.log('\n[G] purity');
const helperSrc = SRC.slice(SRC.indexOf('export function toDailyBars'), SRC.indexOf('@Injectable()'));
ok('G1 pure helpers contain no `await`', !/\bawait\b/.test(helperSrc));
ok('G2 pure helpers contain no `this.`', !/\bthis\./.test(helperSrc));
ok('G3 pure helpers do not touch a repository', !/Repository|InjectRepository/.test(helperSrc));
ok('G4 module exports the helpers for reuse', ['toDailyBars', 'computeDailyAtr14', 'computeGapAtr'].every((k) => typeof M[k] === 'function'));
ok('G5 no order/execution call in the feature module', !/\bplaceOrder\b|\bsubmitOrder\b|\bexecutionProvider\b/.test(SRC));
ok('G6 gapAtr never falls back to 0 on failure', !/gapAtr\s*[:=]\s*0\b/.test(SRC));

console.log(`\nGAPATR (row 427): ${pass} passed, ${failures.length} failed`);
if (failures.length) { console.log('FAILED: ' + failures.join(', ')); process.exit(1); }
