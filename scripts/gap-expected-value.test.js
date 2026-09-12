#!/usr/bin/env node
/**
 * GATE 4 #10 (roadmap row 47) — expected value after spread, slippage and fees.
 *
 * doneWhen: "A reviewer can determine exactly what the item does and a replay/test demonstrates the behavior."
 *
 * [A] contract: version, pinned fee schedule, closed refusal vocabulary, sample size in coverage
 * [B] the fee model is exact (hand-computed FYERS figures; TRUE lower-of brokerage)
 * [C] the EV transformation is exact (geometry, gross/net, expectancy per unit risk, break-even)
 * [D] every refusal, from the documented precedence
 * [E] the disabled path computes nothing; determinism; input order irrelevant
 * [F] plan derivation from a real FAILED_ORB candidate (row 40)
 * [G] purity + research-only
 */
const fs = require('fs');
const path = require('path');
const REPO = path.join(__dirname, '..');

const M = require(path.join(REPO, 'dist', 'trading', 'gap-engine', 'gap-expected-value'));
const SRC = path.join(REPO, 'src', 'trading', 'gap-engine', 'gap-expected-value.ts');

let pass = 0;
const failures = [];
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; console.log(`  PASS ${name}`); }
  else { failures.push(name); console.log(`  FAIL ${name}${extra ? ' :: ' + extra : ''}`); }
};
const eq = (name, actual, expected) => ok(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`);
const near = (name, actual, expected, dp = 6) => ok(name, typeof actual === 'number' && Math.abs(actual - expected) < 1e-9 + Math.pow(10, -dp) / 2, `got ${actual} want ~${expected}`);

const SCHEDULE = M.DEFAULT_EV_FEE_SCHEDULE;
// A documented LONG plan; numbers below are hand-computed from the pinned schedule.
const longPlan = (extra = {}) => ({ sessionDate: '2026-09-02', instrument: 'NSE:NIFTY50-INDEX', direction: 'LONG', entryPrice: 100, targetPrice: 130, stopPrice: 90, units: 50, segment: 'future', pWin: 0.5, probabilitySource: 'assumption:test', spreadPoints: 0, slippagePoints: 0, ...extra });
const run = (plans, cfg) => M.evaluateGapExpectedValue(plans, cfg);

// ── [A] ─────────────────────────────────────────────────────────────────────
console.log('\n[A] contract');
{
  const rep = run([longPlan()]);
  eq('version', rep.version, 'gapev-v1');
  eq('the config object is the switch plus the fee schedule', Object.keys(M.DEFAULT_GAP_EXPECTED_VALUE_CONFIG), ['enabled', 'feeSchedule']);
  eq('the closed refusal vocabulary is the documented set', [...M.EV_REFUSALS], ['INVALID_GEOMETRY', 'ZERO_RISK', 'NO_PROBABILITY', 'INVALID_PROBABILITY', 'NO_FRICTION', 'INVALID_FRICTION']);
  eq('the spec documents every refusal token', M.GAP_EXPECTED_VALUE_SPEC.refuses, [...M.EV_REFUSALS]);
  eq('the direction vocabulary is LONG/SHORT', [...M.EV_DIRECTIONS], ['LONG', 'SHORT']);
  eq('the segment vocabulary is future/option', [...M.EV_SEGMENTS], ['future', 'option']);
  eq('the fee schedule is versioned', rep.feeScheduleVersion, 'fyers-2026-09-04');
  eq('EV_FEE_SCHEDULE_VERSION matches the report', M.EV_FEE_SCHEDULE_VERSION, rep.feeScheduleVersion);
  ok('the spec pins inputs, transformation, units and boundaries', ['inputs', 'transformation', 'units', 'boundaries'].every((k) => typeof M.GAP_EXPECTED_VALUE_SPEC[k] === 'string' && M.GAP_EXPECTED_VALUE_SPEC[k].length > 0));
  ok('the spec says probability is a caller input, never estimated', /pWin/.test(M.GAP_EXPECTED_VALUE_SPEC.inputs) && /supplied by the caller/.test(M.GAP_EXPECTED_VALUE_SPEC.inputs) && /never estimates/.test(rep.reviewerSummary));
  eq('the coverage block reports the SAMPLE SIZE', rep.coverage.sampleSize, 1);
  eq('the pinned fee rates', [SCHEDULE.future.brokeragePct, SCHEDULE.future.brokerageFlat, SCHEDULE.future.sttSellPct, SCHEDULE.future.exchangeTxnPct, SCHEDULE.future.stampBuyPct], [0.0003, 20, 0.0001, 0.0000183, 0.00002]);
  eq('the pinned option rates + statutory rates', [SCHEDULE.option.brokeragePct, SCHEDULE.option.brokerageFlat, SCHEDULE.option.sttSellPct, SCHEDULE.option.exchangeTxnPct, SCHEDULE.option.stampBuyPct, SCHEDULE.gstPct, SCHEDULE.sebiPct], [0, 20, 0.0005, 0.0003553, 0.00003, 0.18, 0.000001]);
}

// ── [B] ─────────────────────────────────────────────────────────────────────
console.log('\n[B] the fee model is exact (hand-computed)');
{
  const fLeg = (n, side) => M.legCostRupees(n, side, SCHEDULE.future, SCHEDULE.gstPct, SCHEDULE.sebiPct);
  const oLeg = (n, side) => M.legCostRupees(n, side, SCHEDULE.option, SCHEDULE.gstPct, SCHEDULE.sebiPct);
  near('future BUY leg on a 5,000 notional', fLeg(5000, 'BUY'), 1.98387, 5);
  near('future SELL leg (STT only on sell)', fLeg(5000, 'SELL'), 2.38387, 5);
  near('future round trip = BUY + SELL', M.roundTripFeesRupees(100, 50, 'future', SCHEDULE), 4.36774, 5);
  near('option BUY leg (flat ₹20 brokerage)', oLeg(5000, 'BUY'), 25.85217, 5);
  near('option SELL leg (flat ₹20 + 0.05% STT)', oLeg(5000, 'SELL'), 28.20217, 5);
  near('option round trip', M.roundTripFeesRupees(100, 50, 'option', SCHEDULE), 54.05434, 5);
  // TRUE lower-of: at a 100,000 notional the 0.03% leg (₹30) exceeds ₹20, so the flat ₹20 must win.
  near('futures brokerage is the TRUE lower-of (flat wins when smaller)', fLeg(100000, 'BUY'), 27.8774, 4);
  ok('...and the flat is NOT applied when the percentage is smaller', fLeg(5000, 'BUY') < 20);
  ok('STT is charged on the SELL leg only', fLeg(5000, 'SELL') > fLeg(5000, 'BUY'));
}

// ── [C] ─────────────────────────────────────────────────────────────────────
console.log('\n[C] the EV transformation is exact');
{
  const rep = run([longPlan()]);
  const r = rep.plans[0];
  eq('the plan is OK', r.status, 'OK');
  eq('geometry: reward = |target-entry|', r.geometry.rewardPoints, 30);
  eq('geometry: risk = |entry-stop|', r.geometry.riskPoints, 10);
  eq('geometry: reward:risk ratio', r.geometry.rewardRiskRatio, 3);
  eq('geometry: break-even probability with no friction', r.geometry.breakEvenProbabilityFrictionless, 0.25);
  near('cost: round-trip fees in points = rupees/units', r.costs.feesPoints, 0.087355, 6);
  near('gross EV = pWin*reward - (1-pWin)*risk', r.ev.grossEvPoints, 10, 6);
  near('net EV = gross - costs', r.ev.netEvPoints, 9.912645, 6);
  near('expectancy per unit risk = net / risk', r.ev.expectancyPerUnitRisk, 0.991265, 6);
  near('break-even probability = (risk + cost) / (reward + risk)', r.ev.breakEvenProbability, 0.252184, 6);

  const short = run([longPlan({ direction: 'SHORT', targetPrice: 70, stopPrice: 110 })]).plans[0];
  eq('a SHORT plan is the mirror image of the LONG', [short.geometry.rewardPoints, short.geometry.riskPoints, Number(short.ev.netEvPoints.toFixed(6))], [30, 10, 9.912645]);

  const friction = run([longPlan({ spreadPoints: 0.5, slippagePoints: 0.25 })]).plans[0];
  near('friction increases the total cost by exactly its sum', friction.costs.totalPoints, 0.837355, 6);
  near('...and reduces net EV by the same amount', friction.ev.netEvPoints, 9.162645, 6);
  near('...and raises the break-even probability', friction.ev.breakEvenProbability, 0.270934, 6);

  const highWin = run([longPlan({ pWin: 0.75 })]).plans[0];
  near('a higher pWin raises gross EV exactly', highWin.ev.grossEvPoints, 20, 6);

  const losing = run([longPlan({ pWin: 0.1 })]).plans[0];
  ok('a low-probability plan can carry negative net EV', losing.ev.netEvPoints < 0, String(losing.ev.netEvPoints));
  eq('...and it is counted in the negative bucket', run([longPlan({ pWin: 0.1 }), longPlan({ pWin: 0.9 })]).distribution, { positive: 1, zero: 0, negative: 1 });
}

// ── [D] ─────────────────────────────────────────────────────────────────────
console.log('\n[D] every refusal, from the documented precedence');
{
  const one = (plan) => run([plan]).plans[0];
  const noProb = one(longPlan({ pWin: undefined }));
  eq('an absent pWin ⇒ NO_PROBABILITY', noProb.reason, 'NO_PROBABILITY');
  ok('...and the geometry it could validate is still reported', noProb.geometry !== null && noProb.ev === null);
  eq('pWin > 1 ⇒ INVALID_PROBABILITY', one(longPlan({ pWin: 1.5 })).reason, 'INVALID_PROBABILITY');
  eq('pWin < 0 ⇒ INVALID_PROBABILITY', one(longPlan({ pWin: -0.1 })).reason, 'INVALID_PROBABILITY');
  eq('a target on the wrong side ⇒ INVALID_GEOMETRY', one(longPlan({ targetPrice: 95 })).reason, 'INVALID_GEOMETRY');
  eq('a stop on the wrong side ⇒ INVALID_GEOMETRY', one(longPlan({ stopPrice: 105 })).reason, 'INVALID_GEOMETRY');
  eq('zero units ⇒ INVALID_GEOMETRY', one(longPlan({ units: 0 })).reason, 'INVALID_GEOMETRY');
  eq('stop == entry ⇒ ZERO_RISK', one(longPlan({ stopPrice: 100 })).reason, 'ZERO_RISK');
  eq('an absent spread ⇒ NO_FRICTION', one(longPlan({ spreadPoints: undefined })).reason, 'NO_FRICTION');
  eq('an absent slippage ⇒ NO_FRICTION', one(longPlan({ slippagePoints: undefined })).reason, 'NO_FRICTION');
  eq('a negative spread ⇒ INVALID_FRICTION', one(longPlan({ spreadPoints: -1 })).reason, 'INVALID_FRICTION');
  ok('an absent friction input is never treated as zero friction', /never treated as zero/.test(one(longPlan({ spreadPoints: undefined })).reasonDetail));
  const counts = run([longPlan({ pWin: undefined }), longPlan({ spreadPoints: undefined }), longPlan()]);
  eq('refusals are counted in their own buckets', [counts.refusalCounts.NO_PROBABILITY, counts.refusalCounts.NO_FRICTION], [1, 1]);
  eq('...and the sample size counts only the OK rows', [counts.coverage.sampleSize, counts.counts.OK, counts.counts.UNAVAILABLE], [1, 1, 2]);
  eq('the refusal count map is in vocabulary order', Object.keys(counts.refusalCounts), [...M.EV_REFUSALS]);
}

// ── [E] ─────────────────────────────────────────────────────────────────────
console.log('\n[E] disabled computes nothing; determinism');
{
  const off = run([longPlan()], { enabled: false });
  eq('disabled ⇒ DISABLED with a null geometry/costs/EV', [off.plans[0].status, off.plans[0].geometry, off.plans[0].costs, off.plans[0].ev], ['DISABLED', null, null, null]);
  eq('disabled ⇒ no refusal invented and sample size 0', [Object.values(off.refusalCounts).reduce((a, b) => a + b, 0), off.coverage.sampleSize], [0, 0]);
  eq('disabled ⇒ an empty distribution', off.distribution, { positive: 0, zero: 0, negative: 0 });
  ok('the summary says it is disabled', /enabled=false/.test(off.reviewerSummary));

  const plans = [longPlan({ sessionDate: '2026-09-03' }), longPlan(), longPlan({ sessionDate: '2026-09-02', targetPrice: 135 })];
  const fwd = run(plans);
  const rev = run([...plans].reverse());
  eq('reversed input ⇒ identical digest', rev.digest, fwd.digest);
  eq('reversed input ⇒ identical row order', rev.plans.map((p) => `${p.sessionDate}|${p.instrument}|${p.direction}`), fwd.plans.map((p) => `${p.sessionDate}|${p.instrument}|${p.direction}`));
  ok('repeated identical runs are byte-identical', run(plans).digest === fwd.digest);
  ok('a changed entry moves the digest', run([longPlan({ entryPrice: 101 })]).digest !== run([longPlan()]).digest);
}

// ── [F] ─────────────────────────────────────────────────────────────────────
console.log('\n[F] plan derivation from a real FAILED_ORB candidate');
{
  const cand = (over = {}) => ({ kind: 'FAILED_ORB', sessionDate: '2026-09-03', instrument: 'NSE:NIFTY50-INDEX', status: 'OK', isCandidate: true, reason: null, direction: 'UP', openingRange: { low: 90, high: 110, fromMs: 1, toMs: 2, observations: 5 }, breakout: { atMs: 3, price: 112 }, reEntry: { atMs: 4, price: 105 }, excursion: 5, evidence: {}, ...over });
  const up = M.planFromFailedOrb(cand());
  eq('an UP breakout that failed is faded SHORT with the opposite edge as target', [up.direction, up.entryPrice, up.targetPrice], ['SHORT', 105, 90]);
  eq('...and the stop sits the excursion beyond the breakout extreme', up.stopPrice, 115);
  const down = M.planFromFailedOrb(cand({ direction: 'DOWN' }));
  eq('a DOWN breakout that failed is faded LONG', [down.direction, down.entryPrice, down.targetPrice, down.stopPrice], ['LONG', 105, 110, 85]);
  eq('a non-candidate yields no plan', M.planFromFailedOrb(cand({ isCandidate: false })), null);
  eq('a candidate without a re-entry yields no plan', M.planFromFailedOrb(cand({ reEntry: null })), null);
  ok('the derivation rule is published', /opposite edge|OPPOSITE edge/.test(M.PLAN_DERIVATION_SPEC.rule) && /excursion/.test(M.PLAN_DERIVATION_SPEC.rule));

  const priced = run([{ ...up, units: 50, spreadPoints: 0, slippagePoints: 0, pWin: 0.5, probabilitySource: 'assumption:test' }]);
  eq('a derived plan prices end-to-end', [priced.plans[0].status, priced.plans[0].ev !== null], ['OK', true]);
  eq('...with the derived risk as the reward:risk denominator', [priced.plans[0].geometry.rewardPoints, priced.plans[0].geometry.riskPoints], [15, 10]);
}

// ── [G] ─────────────────────────────────────────────────────────────────────
console.log('\n[G] purity + research-only');
{
  const code = fs.readFileSync(SRC, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  ok('no clock read', !/Date\.now\(\)/.test(code));
  ok('no randomness', !/Math\.random/.test(code));
  ok('no DB or HTTP client', !/mysql|fetch\(|axios|http\./.test(code));
  ok('no model/AI client', !/openai|anthropic|bedrock|\bgpt-|claude|\bllm\b/i.test(code));
  ok('no ranking/optimisation of results', !/optimis|optimiz|\brank\b/i.test(code));
  ok('no probability/friction is tuned against outcomes', !/(threshold|tuned)[A-Za-z]*\s*[:=]\s*[0-9]/.test(code));
  ok('research/shadow only: no production importer yet', prodImporters().length === 0, prodImporters().join(','));
  function prodImporters() {
    const hits = [];
    const RESEARCH = ['gap-engine', 'value-profile'];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (!RESEARCH.includes(e.name)) walk(p); }
        else if (e.name.endsWith('.ts') && !p.includes(path.join('trading', 'gap-engine')) && !p.includes(path.join('trading', 'value-profile'))) {
          if (/gap-expected-value|evaluateGapExpectedValue|planFromFailedOrb/.test(fs.readFileSync(p, 'utf8'))) hits.push(path.relative(REPO, p));
        }
      }
    };
    walk(path.join(REPO, 'src'));
    return hits;
  }
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) { console.log('FAILED:'); failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
process.exit(0);
