#!/usr/bin/env node
/**
 * GATE 7 #1 (roadmap row 66) — IV-RV and IV-versus-forecast-volatility.
 *
 * doneWhen: "The same inputs produce the same result in replay, and edge cases return a safe explicit state
 *            rather than a fabricated value."
 *
 * [A] contract: version, pinned definition/units/window, closed refusal vocabulary, coverage
 * [B] the IV reference is the median of usable IVs; 0/negative IVs are excluded and counted
 * [C] the realised volatility is exact and annualises from ACTUAL elapsed time
 * [D] every refusal is a safe explicit state
 * [E] the disabled path computes nothing
 * [F] determinism; units (IV percent → fraction); degenerate ratio guard
 * [G] purity + research-only
 */
const fs = require('fs');
const path = require('path');
const REPO = path.join(__dirname, '..');

const M = require(path.join(REPO, 'dist', 'trading', 'options', 'iv-rv'));
const SRC = path.join(REPO, 'src', 'trading', 'options', 'iv-rv.ts');

let pass = 0;
const failures = [];
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; console.log(`  PASS ${name}`); }
  else { failures.push(name); console.log(`  FAIL ${name}${extra ? ' :: ' + extra : ''}`); }
};
const eq = (name, actual, expected) => ok(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`);
const near = (name, actual, expected, tol = 1e-4) => ok(name, typeof actual === 'number' && Math.abs(actual - expected) < tol, `got ${actual} want ~${expected}`);

const iv = (underlying, value, over = {}) => ({ underlying, iv: value, source: 'UPSTOX', instrumentKey: 'X', ...over });
const px = (underlying, instantMs, price) => ({ underlying, instantMs, price, source: 'FYERS_LIVE' });
const T0 = Date.parse('2026-09-11T03:45:00Z');
const run = (ivs, prices, cfg) => M.evaluateIvRv(ivs, prices, cfg);
const two = (underlying, p0, p1, elapsedDays) => [px(underlying, T0, p0), px(underlying, T0 + elapsedDays * 86_400_000, p1)];

// ── [A] ─────────────────────────────────────────────────────────────────────
console.log('\n[A] contract');
{
  const rep = run([iv('NIFTY50', 12.68)], two('NIFTY50', 100, 110, 1), { minPrices: 2 });
  eq('version', rep.version, 'ivrv-v1');
  eq('the config is the switch plus the calendar/structural bounds', Object.keys(M.DEFAULT_IV_RV_CONFIG), ['enabled', 'minPrices', 'secondsPerYear']);
  eq('the seconds-per-year default is the 365-day calendar constant', M.DEFAULT_IV_RV_CONFIG.secondsPerYear, 31_536_000);
  eq('the closed refusal vocabulary is the documented set', [...M.IV_RV_REFUSALS], ['NO_IV', 'NO_PRICES', 'INSUFFICIENT_PRICES', 'ZERO_ELAPSED']);
  eq('the spec documents every refusal token', M.IV_RV_SPEC.refuses, [...M.IV_RV_REFUSALS]);
  eq('the status vocabulary is pinned', [...M.IV_RV_STATUSES], ['OK', 'UNAVAILABLE', 'DISABLED']);
  ok('the spec pins ivReference, rv, units and window', ['ivReference', 'rv', 'units', 'window'].every((k) => typeof M.IV_RV_SPEC[k] === 'string' && M.IV_RV_SPEC[k].length > 0));
  ok('the spec says only the calendar constant and minPrices are involved', /no fitted|none/.test(M.IV_RV_SPEC.thresholds) && /calendar constant|365/.test(M.IV_RV_SPEC.thresholds));
  eq('the coverage block reports counts and exclusions', [rep.coverage.underlyingsIn, rep.coverage.ok, rep.coverage.excludedIv], [1, 1, 0]);
}

// ── [B] ─────────────────────────────────────────────────────────────────────
console.log('\n[B] the IV reference is the median of USABLE IVs');
{
  const rep = run([iv('NIFTY50', 12.68), iv('NIFTY50', 11.62), iv('NIFTY50', 15.02)], two('NIFTY50', 100, 110, 1), { minPrices: 2 });
  eq('the median of [12.68, 11.62, 15.02]', rep.observations[0].iv.ivReference, 12.68);
  eq('min/max/count are reported', [rep.observations[0].iv.ivMin, rep.observations[0].iv.ivMax, rep.observations[0].iv.ivCount], [11.62, 15.02, 3]);
  const excluded = run([iv('NIFTY50', 12.5), iv('NIFTY50', 0), iv('NIFTY50', -3), iv('NIFTY50', null)], two('NIFTY50', 100, 110, 1), { minPrices: 2 });
  eq('a 0 or negative IV is EXCLUDED and counted, never treated as a vol', [excluded.observations[0].iv.ivReference, excluded.observations[0].iv.excludedIv], [12.5, 3]);
  eq('...and the report totals the exclusions', excluded.coverage.excludedIv, 3);
}

// ── [C] ─────────────────────────────────────────────────────────────────────
console.log('\n[C] realised volatility is exact and annualises from elapsed time');
{
  const a = run([iv('X', 12.68)], two('X', 100, 110, 1), { minPrices: 2 }).observations[0];
  // sumSq = ln(1.1)^2 = 0.0090840; annualised over 1 day = sqrt(sumSq * 365) = 1.820898
  near('two prices over one day annualise to sqrt(ln(1.1)^2 × 365)', a.values.rvAnnualised, 1.820898, 1e-5);
  const b = run([iv('X', 12.68)], two('X', 100, 110, 2), { minPrices: 2 }).observations[0];
  near('...and doubling the elapsed time scales it by 1/sqrt(2)', b.values.rvAnnualised, 1.820898 / Math.SQRT2, 1e-5);
  const flat = run([iv('X', 12.68)], [px('X', T0, 100), px('X', T0 + 3_600_000, 100)], { minPrices: 2 }).observations[0];
  eq('a flat tape has zero realised volatility', flat.values.rvAnnualised, 0);
  eq('...and the ratio is guarded (0, not Infinity/NaN)', flat.values.ivToRvRatio, 0);
  eq('the elapsed seconds come from the timestamps', a.prices.elapsedSeconds, 86_400);
}

// ── [D] ─────────────────────────────────────────────────────────────────────
console.log('\n[D] every refusal is safe and explicit');
{
  const one = (ivs, prices, cfg) => run(ivs, prices, cfg).observations[0];
  eq('no IV ⇒ NO_IV', one([], two('X', 100, 110, 1), { minPrices: 2 }).reason, 'NO_IV');
  eq('every IV invalid ⇒ NO_IV', one([iv('X', 0)], two('X', 100, 110, 1), { minPrices: 2 }).reason, 'NO_IV');
  eq('no prices ⇒ NO_PRICES', one([iv('X', 12)], [], { minPrices: 2 }).reason, 'NO_PRICES');
  eq('too few prices ⇒ INSUFFICIENT_PRICES', one([iv('X', 12)], two('X', 100, 110, 1), { minPrices: 10 }).reason, 'INSUFFICIENT_PRICES');
  eq('a zero-elapsed tape ⇒ ZERO_ELAPSED', one([iv('X', 12)], [px('X', T0, 100), px('X', T0, 101)], { minPrices: 2 }).reason, 'ZERO_ELAPSED');
  const refusals = [one([], two('X', 100, 110, 1), { minPrices: 2 }), one([iv('X', 12)], [], { minPrices: 2 })];
  ok('every refusal carries null values', refusals.every((r) => r.values === null && r.status === 'UNAVAILABLE'));
  ok('...but still reports the IV summary it could compute', refusals[1].iv.ivCount === 1);
  ok('...with a human detail', refusals.every((r) => typeof r.reasonDetail === 'string' && r.reasonDetail.length > 0));
  const counts = run([iv('X', 12)], [], { minPrices: 2 });
  eq('the refusal count map is in vocabulary order', Object.keys(counts.refusalCounts), [...M.IV_RV_REFUSALS]);
}

// ── [E] ─────────────────────────────────────────────────────────────────────
console.log('\n[E] the disabled path computes nothing');
{
  const off = run([iv('X', 12)], two('X', 100, 110, 1), { enabled: false, minPrices: 2 });
  eq('disabled ⇒ DISABLED with null values', [off.observations[0].status, off.observations[0].values], ['DISABLED', null]);
  eq('disabled ⇒ no refusal invented and no sample', [Object.values(off.refusalCounts).reduce((a, b) => a + b, 0), off.coverage.ok], [0, 0]);
  ok('the summary says it is disabled', /enabled=false/.test(off.reviewerSummary));
}

// ── [F] ─────────────────────────────────────────────────────────────────────
console.log('\n[F] determinism, units, independence');
{
  const ivs = [iv('B', 11), iv('A', 12.68), iv('A', 12.0)];
  const prices = [...two('A', 100, 110, 1), ...two('B', 200, 210, 1)];
  const fwd = run(ivs, prices, { minPrices: 2 });
  const rev = run([...ivs].reverse(), [...prices].reverse(), { minPrices: 2 });
  eq('reversed input ⇒ identical digest', rev.digest, fwd.digest);
  eq('underlyings are canonically ordered', fwd.observations.map((o) => o.underlying), ['A', 'B']);
  ok('repeated identical runs are byte-identical', run(ivs, prices, { minPrices: 2 }).digest === fwd.digest);

  const a = fwd.observations.find((o) => o.underlying === 'A');
  eq('IV is converted from an annualised PERCENT to a fraction (median of [12.68, 12.0])', a.values.ivFraction, 0.1234);
  near('ivMinusRv = ivFraction − rv', a.values.ivMinusRv, 0.1234 - 1.820898, 1e-4);
  ok('a per-underlying value is unchanged when another underlying is added', run([...ivs], [...two('A', 100, 110, 1)], { minPrices: 2 }).observations.find((o) => o.underlying === 'A').values.rvAnnualised === a.values.rvAnnualised);
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
  ok('research/shadow only: no production importer', prodImporters().length === 0, prodImporters().join(','));
  function prodImporters() {
    const hits = [];
    const RESEARCH = ['gap-engine', 'value-profile', 'microstructure', 'options'];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (!RESEARCH.includes(e.name)) walk(p); }
        else if (e.name.endsWith('.ts') && !RESEARCH.some((d) => p.includes(path.join('trading', d)))) {
          if (/iv-rv|evaluateIvRv/.test(fs.readFileSync(p, 'utf8'))) hits.push(path.relative(REPO, p));
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
