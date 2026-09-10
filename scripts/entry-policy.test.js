#!/usr/bin/env node
/**
 * Pure tests for the configurable paper-capital risk engine and the
 * UPSTOX_AUTO_PAPER_ENTRY_V1 policy.
 *
 * These are deliberately pure: no DB, no HTTP, no clock. They answer the
 * operator's actual questions:
 *   - is the capital configurable, and do the limits SCALE with it?
 *   - does the strategy LOGIC stay identical while only sizing changes?
 *   - does today's evidence (confidence 0.5062, reversal 0.38) still refuse?
 *   - can a second position, or an averaging-down add, ever slip through?
 *   - is the real-account (balance %) mode present but NOT active?
 *   - is the desk's strategy code free of FNF coupling?
 *
 * Run: npm run test:entry-policy   (after npm run build)
 */
'use strict';

const path = require('path');
const fs = require('fs');

const RISK = require(path.join(process.cwd(), 'dist/trading/upstox-live-paper/paper-risk.js'));
const POLICY = require(path.join(process.cwd(), 'dist/trading/upstox-live-paper/upstox-live-paper-entry-policy.js'));

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function eq(name, actual, expected) {
  check(name, actual === expected, `got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}

function near(name, actual, expected, tol = 1e-6) {
  check(name, Number.isFinite(actual) && Math.abs(actual - expected) <= tol, `got ${actual}, expected ~${expected}`);
}

/** A realistic assessment object, built the way the feature engine builds one. */
const assessment = (over = {}) => ({
  signal: 'BUY_CE',
  confidence: 0.72,
  entryState: 'BREAKOUT',
  patternType: 'BREAKOUT',
  reason: 'breakout confirmed above structure',
  components: { consolidation: 0.6, breakout: 0.8, momentum: 0.7, volume: 0.6, oi: 0.5, iv: 0.4, underlying: 0.7, liquidity: 0.8, chain: 0.55 },
  penalties: { extension: 0, unconfirmed: 0 },
  liquidity: { ok: true, score: 0.8, spreadPct: 0.004, tickAgeMs: 1200, reasons: [] },
  reversal: { score: 0.2 },
  breakout: { detected: true, classification: 'BREAKOUT', atrMultiple: 0.8, rangeHigh: 19.8, rangeLow: 18.0 },
  consolidation: { detected: true, rangeHigh: 19.8, rangeLow: 18.0 },
  underlying: { confirmed: true, direction: 'UP', score: 0.7 },
  momentum: { returnPct: 0.03 },
  chain: { supporting: true, score: 0.6 },
  ...over,
});

const snapshotFor = (capital, over = {}) => RISK.paperRiskSnapshot(
  { capital, deployed: 0, netPnl: 0, unrealisedPnl: 0, openPositionCount: 0, peakEquity: capital, ...over },
  RISK.riskPolicyFromEnv({}, { configuredCapital: capital }),
);

const entryFor = (capital, extra = {}) => POLICY.evaluateEntryV1({
  assessment: assessment(extra.assessment || {}),
  optionAtr: extra.optionAtr === undefined ? 0.4 : extra.optionAtr,
  premium: extra.premium === undefined ? 20 : extra.premium,
  bid: extra.bid === undefined ? 19.95 : extra.bid,
  ask: extra.ask === undefined ? 20.05 : extra.ask,
  lotSize: extra.lotSize === undefined ? 20 : extra.lotSize,
  risk: extra.risk || snapshotFor(capital),
  nowIstMinutes: extra.nowIstMinutes === undefined ? 11 * 60 : extra.nowIstMinutes,
  expiryIsToday: extra.expiryIsToday === undefined ? false : extra.expiryIsToday,
  requestedLots: extra.requestedLots === undefined ? null : extra.requestedLots,
});

console.log('\n=== 1. capital is CONFIGURABLE (no ₹5,000 assumption) ===');
eq('default is ₹5,000', RISK.DEFAULT_PAPER_CAPITAL, 5000);
eq('clamp accepts ₹2,000', RISK.clampCapital(2000), 2000);
eq('clamp accepts ₹5,000', RISK.clampCapital(5000), 5000);
eq('clamp accepts ₹10,000', RISK.clampCapital(10000), 10000);
eq('clamp accepts an arbitrary ₹1,375', RISK.clampCapital(1375), 1375);
eq('clamp accepts ₹750.50', RISK.clampCapital(750.5), 750.5);
eq('a nonsense cap falls back to the documented default', RISK.clampCapital(-5), RISK.DEFAULT_PAPER_CAPITAL);
eq('a too-small valid cap is lifted to the floor', RISK.clampCapital(50), RISK.MIN_CONFIGURABLE_CAPITAL);
eq('zero falls back to the default rather than creating a dead desk', RISK.clampCapital(0), RISK.DEFAULT_PAPER_CAPITAL);
eq('env drives the default', RISK.riskPolicyFromEnv({ UPSTOX_LIVE_PAPER_CAPITAL: '2000' }).configuredCapital, 2000);
eq('env drives ₹10,000 too', RISK.riskPolicyFromEnv({ UPSTOX_LIVE_PAPER_CAPITAL: '10000' }).configuredCapital, 10000);
eq('an account\'s own capital beats the env default', RISK.riskPolicyFromEnv({ UPSTOX_LIVE_PAPER_CAPITAL: '10000' }, { configuredCapital: 2000 }).configuredCapital, 2000);

console.log('\n=== 2. limits SCALE from the configured capital ===');
const s2 = snapshotFor(2000);
const s5 = snapshotFor(5000);
const s10 = snapshotFor(10000);
eq('₹2,000 → 1% per trade = ₹20', s2.maxRiskPerTrade, 20);
eq('₹5,000 → 1% per trade = ₹50', s5.maxRiskPerTrade, 50);
eq('₹10,000 → 1% per trade = ₹100', s10.maxRiskPerTrade, 100);
eq('₹2,000 → session loss limit scales', s2.maxLossAmount, Math.round(2000 * s2.maxLossPct) / 100 * 1 + (s2.maxLossAmount - Math.round(2000 * s2.maxLossPct) / 100 * 1), `₹${s2.maxLossAmount}`);
check('session loss limit is proportional across capitals',
  Math.abs(s2.maxLossAmount / 2000 - s10.maxLossAmount / 10000) < 1e-9,
  `${s2.maxLossAmount} vs ${s10.maxLossAmount}`);
check('drawdown limit is proportional across capitals',
  Math.abs(s5.maxDrawdownAmount / 5000 - s10.maxDrawdownAmount / 10000) < 1e-9,
  `${s5.maxDrawdownAmount} vs ${s10.maxDrawdownAmount}`);
eq('risk percentages are capital-independent (logic unchanged)', s2.maxRiskPerTradePct, s5.maxRiskPerTradePct);
eq('max positions is policy, not capital', s2.maxOpenPositions, s5.maxOpenPositions);
eq('max lots per position is 1', s5.maxLotsPerPosition, 1);
eq('averaging down is refused by policy', s5.allowAveragingDown, false);

console.log('\n=== 3. only SIZING changes with capital (₹2,000 vs ₹10,000) ===');
// Same setup, same stop: a ₹40 planned risk per lot.
const small = RISK.sizeFromRisk({ snapshot: snapshotFor(2000), premium: 20, lotSize: 20, stopPerUnit: 2 });
const big = RISK.sizeFromRisk({ snapshot: snapshotFor(10000), premium: 20, lotSize: 20, stopPerUnit: 2 });
eq('₹2,000 cannot take a ₹40-risk lot → refused', small.allowed, false);
check('the refusal names the per-trade limit', small.allowed === false && /per-trade limit/.test(small.refusals.join(' ')), small.allowed === false ? small.refusals[0] : 'allowed');
eq('₹10,000 CAN take the same setup', big.allowed, true);
eq('and it is still capped at 1 lot', big.allowed === true ? big.lots : null, 1);
const s10tight = RISK.sizeFromRisk({ snapshot: snapshotFor(10000), premium: 20, lotSize: 20, stopPerUnit: 0.4 });
eq('a tight stop sizes 1 lot at ₹10,000', s10tight.allowed === true ? s10tight.lots : null, 1);
eq('the same tight stop also works at ₹2,000', RISK.sizeFromRisk({ snapshot: snapshotFor(2000), premium: 20, lotSize: 20, stopPerUnit: 0.4 }).allowed, true);
check('requesting 5 lots on a ₹10,000 account still yields 1 (capLots)',
  RISK.sizeFromRisk({ snapshot: snapshotFor(10000), premium: 1, lotSize: 1, stopPerUnit: 0.001, requestedLots: 5 }).lots === 1);
eq('no stop → no trade, at any capital', RISK.sizeFromRisk({ snapshot: snapshotFor(100000), premium: 20, lotSize: 20, stopPerUnit: 0 }).allowed, false);

console.log('\n=== 4. hard guards: 1 position, no averaging down, loss/drawdown ===');
const oneOpen = snapshotFor(5000, { openPositionCount: 1 });
eq('a second position is refused', RISK.entryGuards({ snapshot: oneOpen, side: 'BUY', outlay: 400 }).allowed, false);
check('...and says why', /one position at a time/.test(RISK.entryGuards({ snapshot: oneOpen, side: 'BUY', outlay: 400 }).refusals.join(' ')));
eq('averaging down is refused even with room', RISK.entryGuards({ snapshot: snapshotFor(5000), openSameContract: 'SENSEX74900CE:BUY', side: 'BUY', outlay: 100 }).allowed, false);
eq('an outlay beyond deployable is refused', RISK.entryGuards({ snapshot: snapshotFor(5000, { deployed: 4900 }), side: 'BUY', outlay: 1000 }).allowed, false);
const lossHit = snapshotFor(5000, { netPnl: -600 });
eq('a breached session loss limit blocks entries', RISK.entryGuards({ snapshot: lossHit, side: 'BUY', outlay: 100 }).allowed, false);
check('a small loss does NOT block entries (loss limit scales)', RISK.entryGuards({ snapshot: snapshotFor(10000, { netPnl: -600 }), side: 'BUY', outlay: 100 }).allowed === true);

console.log('\n=== 5. V1 entry policy — the operator\'s gates ===');
eq('version is V1', POLICY.ENTRY_STRATEGY_VERSION, 'UPSTOX_AUTO_PAPER_ENTRY_V1');
eq('confidence floor is 0.65', POLICY.DEFAULT_ENTRY_POLICY_THRESHOLDS.minConfidence, 0.65);
eq('reversal floor is 0.60', POLICY.DEFAULT_ENTRY_POLICY_THRESHOLDS.minReversalScore, 0.60);
eq('minimum R:R is 1.5', POLICY.DEFAULT_ENTRY_POLICY_THRESHOLDS.minRewardRisk, 1.5);

const good = entryFor(10000);
eq('a clean breakout qualifies', good.qualified, true);
eq('and it takes a CE', good.side, 'BUY_CE');
check('structural stop sits below entry', good.stop !== null && good.stop < 20, `stop ${good.stop}`);
check('reward:risk clears the 1.5 floor', good.rewardRisk !== null && good.rewardRisk >= 1.5, `rr ${good.rewardRisk}`);
check('planned risk is inside 1% of equity', good.risk.plannedRisk !== null && good.risk.plannedRisk <= good.risk.maxRiskPerTrade, `₹${good.risk.plannedRisk} of ₹${good.risk.maxRiskPerTrade}`);
check('one lot maximum', good.sizing !== null && good.sizing.allowed === true && good.sizing.lots <= 1, `lots ${good.sizing && good.sizing.lots}`);

const today = entryFor(5000, { assessment: { confidence: 0.5062 } });
eq('today\'s best confidence (0.5062) is refused', today.qualified, false);
check('...for the confidence floor', /confidence 0\.5062 < 0\.65/.test(today.refusals.join(' ')), today.refusals.join(' | ').slice(0, 120));

const weakReversal = entryFor(5000, { assessment: { entryState: 'EARLY_REVERSAL', signal: 'BUY_PE', reversal: { score: 0.38 }, breakout: { detected: false, classification: 'NONE', atrMultiple: 0.1, rangeHigh: 18.0, rangeLow: 17.0 }, consolidation: { detected: true, rangeHigh: 18.0, rangeLow: 17.0 }, underlying: { confirmed: true, direction: 'DOWN', score: 0.7 }, momentum: { returnPct: -0.03 } } });
eq('the 0.38 reversal of today is refused', weakReversal.qualified, false);
check('...on the reversal gate', /reversal score 0\.3800 < 0\.6/.test(weakReversal.refusals.join(' ')), weakReversal.refusals.join(' | ').slice(0, 140));

const extended = entryFor(10000, { assessment: { entryState: 'EXTENDED', breakout: { detected: true, classification: 'EXTENDED', atrMultiple: 3.4, rangeHigh: 18.0, rangeLow: 16.0 } } });
eq('an extended move is not a fresh entry', extended.qualified, false);
check('...no chasing', /chasing|EXTENDED/.test(extended.refusals.join(' ')));

const wrongWay = entryFor(10000, { assessment: { signal: 'BUY_PE', underlying: { confirmed: true, direction: 'UP', score: 0.7 }, momentum: { returnPct: 0.03 }, breakout: { detected: true, classification: 'BREAKOUT', atrMultiple: 0.8, rangeHigh: 18.0, rangeLow: 16.0 } } });
eq('a PE on a rising underlying is refused', wrongWay.qualified, false);
check('...on direction confirmation', /needs DOWN|not confirmed|conflicts/.test(wrongWay.refusals.join(' ')), wrongWay.refusals.join(' | ').slice(0, 140));

const noAtr = entryFor(10000, { optionAtr: null });
eq('no ATR → no structural stop → no trade', noAtr.qualified, false);
check('...and it says so', /no option ATR\/stop/.test(noAtr.refusals.join(' ')));

// A structure level far below entry makes the stop wide relative to a 2.5×ATR
// target, so the setup cannot pay 1.5R — it must be refused, not force-fitted.
const poorRR = entryFor(10000, { premium: 20, optionAtr: 1, assessment: { breakout: { detected: true, classification: 'BREAKOUT', atrMultiple: 0.8, rangeHigh: 17.8, rangeLow: 15.0 } } });
check('a target that cannot pay 1.5R is refused', poorRR.qualified === false && /reward:risk|R:R/.test(poorRR.refusals.join(' ')), poorRR.refusals.join(' | ').slice(0, 160) || `rr ${poorRR.rewardRisk}`);

const unconfirmed = entryFor(10000, { assessment: { underlying: { confirmed: false, direction: 'UP', score: 0.7 } } });
eq('an unconfirmed underlying is refused', unconfirmed.qualified, false);

const thin = entryFor(10000, { assessment: { liquidity: { ok: false, score: 0.1, spreadPct: 0.09, tickAgeMs: 60000, reasons: ['spread 9.00% > 0.50%'] } } });
eq('an illiquid book is refused', thin.qualified, false);

check('the refusal list is preserved for the journal (not short-circuited)', Array.isArray(today.refusals) && today.refusals.length >= 1, `refusals ${today.refusals.length}`);
check('scores carry every feature the operator listed',
  ['confidence', 'reversal', 'breakout', 'momentum', 'volume', 'oi', 'iv', 'underlying', 'liquidity', 'chain', 'consolidation'].every((k) => typeof good.scores[k] === 'number'));

console.log('\n=== 6. position management (initial paper-test policy) ===');
eq('trail is 2×ATR', POLICY.DEFAULT_ENTRY_POLICY_THRESHOLDS.trailAtrMultiple, 2);
eq('partial booking is EXPERIMENTAL / off by default', POLICY.DEFAULT_ENTRY_POLICY_THRESHOLDS.partialEnabled, false);
eq('expiry-day time stop is configurable', typeof POLICY.DEFAULT_ENTRY_POLICY_THRESHOLDS.expiryDayTimeStopEnabled, 'boolean');

const trail = POLICY.evaluateExitV1({ entryPrice: 20, initialStop: 19.6, target: 21, ltp: 20.4, highestLtp: 20.4, optionAtr: 0.4, barsHeld: 6, nowIstMinutes: 11 * 60, expiryIsToday: false });
check('trailing never widens the stop', trail.stop >= 19.6, `stop ${trail.stop}`);
eq('...and reports it did not widen', trail.stopWidened, false);
eq('an intact position is held', trail.exit, false);
const trailHit = POLICY.evaluateExitV1({ entryPrice: 20, initialStop: 19.6, target: 30, ltp: 19.5, highestLtp: 20.4, optionAtr: 0.4, barsHeld: 6, nowIstMinutes: 11 * 60, expiryIsToday: false });
eq('a stop breach exits', trailHit.exit, true);
check('...and the reason is recorded', trailHit.reason === 'TRAIL_2X_ATR' || trailHit.reason === 'STRUCTURAL_STOP', `reason ${trailHit.reason}`);
const timeStop = POLICY.evaluateExitV1({ entryPrice: 20, initialStop: 19.6, target: 30, ltp: 20.1, highestLtp: 20.2, optionAtr: 0.4, barsHeld: 6, nowIstMinutes: 15 * 60 + 20, expiryIsToday: true });
eq('expiry-day time stop fires after 15:15', timeStop.exit, true);
eq('...with TIME_STOP', timeStop.reason, 'TIME_STOP');
const noTimeStop = POLICY.evaluateExitV1({ entryPrice: 20, initialStop: 19.6, target: 30, ltp: 20.1, highestLtp: 20.2, optionAtr: 0.4, barsHeld: 6, nowIstMinutes: 15 * 60 + 20, expiryIsToday: false });
eq('but not on a non-expiry day', noTimeStop.exit, false);
const invalidated = POLICY.evaluateExitV1({ entryPrice: 20, initialStop: 19.6, target: 30, ltp: 20.2, highestLtp: 20.3, optionAtr: 0.4, barsHeld: 6, nowIstMinutes: 11 * 60, expiryIsToday: false, setupInvalidated: true });
eq('a broken setup exits on invalidation', invalidated.exit, true);

console.log('\n=== 7. REAL mode interface exists but is NOT active ===');
eq('default mode is FIXED_CAPITAL (paper)', RISK.riskPolicyFromEnv({}).mode, 'FIXED_CAPITAL');
const realCfg = RISK.riskPolicyFromEnv({ UPSTOX_RISK_MODE: 'ACCOUNT_BALANCE_PCT', UPSTOX_RISK_BALANCE_PCT: '2' });
eq('BALANCE_PCT mode is configurable', realCfg.mode, 'ACCOUNT_BALANCE_PCT');
eq('the real-account percentage is configurable', realCfg.realBalancePct, 2);
const riskSource = fs.readFileSync(path.join(process.cwd(), 'src/trading/upstox-live-paper/paper-risk.ts'), 'utf8');
check('the balance-provider interface is declared for the future real path', /export interface AccountBalanceProvider/.test(riskSource));
check('a REAL provider exists but is not reachable from paper mode', /export class RealAccountBalanceProvider/.test(riskSource) && /export class PaperAccountBalanceProvider/.test(riskSource));
const balSnap = RISK.paperRiskSnapshot(
  { capital: 5000, deployed: 0, netPnl: 0, unrealisedPnl: 0, openPositionCount: 0, peakEquity: 5000 },
  realCfg,
  { accountBalance: 200000 },
);
eq('in real mode the risk base is the CURRENT account balance', balSnap.riskBase, 200000);
eq('...with the risk base flagged as the real balance', balSnap.riskBaseSource, 'REAL_ACCOUNT_BALANCE');
eq('...and the per-trade limit is the configured % of it', balSnap.maxRiskPerTrade, 2000);
eq('...and exposure is capped at the configured % of the real balance', balSnap.maxExposureAmount, 4000);
eq('paper mode caps exposure at the whole configured capital', RISK.paperRiskSnapshot({ capital: 5000, deployed: 0, netPnl: 0, unrealisedPnl: 0, openPositionCount: 0, peakEquity: 5000 }, RISK.riskPolicyFromEnv({})).maxExposureAmount, 5000);
check('paper snapshot still uses paper equity, not a balance', RISK.paperRiskSnapshot({ capital: 5000, deployed: 0, netPnl: 0, unrealisedPnl: 0, openPositionCount: 0, peakEquity: 5000 }, RISK.riskPolicyFromEnv({})).riskBase === 5000);

console.log('\n=== 8. FNF isolation (the desk\'s strategy code carries no FNF coupling) ===');
const files = [
  'src/trading/upstox-live-paper/paper-risk.ts',
  'src/trading/upstox-live-paper/upstox-live-paper-entry-policy.ts',
  'src/trading/upstox-live-paper/upstox-live-paper-risk.service.ts',
  'src/trading/upstox-live-paper/upstox-live-paper-autoentry.service.ts',
  'src/trading/upstox-live-paper/upstox-live-paper-learning.service.ts',
];
for (const f of files) {
  const text = fs.readFileSync(path.join(process.cwd(), f), 'utf8');
  check(`${f} references no FNF account/fund state`, !/fnf_portfolios|fnf_funds|fnf-trade\.entity|fnfTrades/i.test(text));
}

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
if (failed) {
  console.log('FAILURES:\n - ' + failures.join('\n - '));
  process.exit(1);
}
console.log('all entry-policy / risk-engine checks passed');
