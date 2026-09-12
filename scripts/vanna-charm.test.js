#!/usr/bin/env node
/**
 * GATE 7 #6 (roadmap row 75) — vanna / charm as secondary explanatory features.
 *
 * doneWhen: "The capability can run in research/shadow mode without changing production behavior."
 *
 * [A] contract: version, pinned method/steps, closed refusal vocabulary, coverage
 * [B] values and unit conversions
 * [C] the values agree with an INDEPENDENT central difference on the reused local model
 * [D] every refusal is a safe explicit state
 * [E] the disabled path computes nothing
 * [F] determinism
 * [G] purity + research-only (no production behaviour changed)
 */
const fs = require('fs');
const path = require('path');
const REPO = path.join(__dirname, '..');

const M = require(path.join(REPO, 'dist', 'trading', 'options', 'vanna-charm'));
const B = require(path.join(REPO, 'dist', 'trading', 'bsm-greeks'));
const SRC = path.join(REPO, 'src', 'trading', 'options', 'vanna-charm.ts');

let pass = 0;
const failures = [];
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; console.log(`  PASS ${name}`); }
  else { failures.push(name); console.log(`  FAIL ${name}${extra ? ' :: ' + extra : ''}`); }
};
const eq = (name, actual, expected) => ok(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`);
const near = (name, actual, expected, tol) => ok(name, typeof actual === 'number' && Math.abs(actual - expected) < tol, `got ${actual} want ~${expected} (tol ${tol})`);

const D = '2026-09-11';
const E = '2026-09-17'; // 6 days
const q = (over = {}) => ({ underlying: 'X', sessionDate: D, expiry: E, strike: 75000, optionType: 'CE', iv: 12.5, source: 'UPSTOX', ...over });
const SPOT = [{ underlying: 'X', spot: 75000 }];
const run = (quotes, spots = SPOT, cfg) => M.evaluateVannaCharm(quotes, spots, cfg);

// ── [A] ─────────────────────────────────────────────────────────────────────
console.log('\n[A] contract');
{
  const rep = run([q()]);
  eq('version', rep.version, 'vannacharm-v1');
  eq('the config is the switch, rate and the two derivative steps', Object.keys(M.DEFAULT_VANNA_CHARM_CONFIG), ['enabled', 'rate', 'volStep', 'timeStepDays']);
  eq('the closed refusal vocabulary is the documented set', [...M.VANNA_CHARM_REFUSALS], ['NO_QUOTES', 'NO_SPOT', 'NO_IV', 'NO_EXPIRY', 'SMALL_T', 'NO_GREEKS']);
  eq('the spec documents every refusal token', M.VANNA_CHARM_SPEC.refuses, [...M.VANNA_CHARM_REFUSALS]);
  ok('the spec pins the method, units, availability and boundary', ['method', 'units', 'inputAvailability', 'timestampBoundary'].every((k) => typeof M.VANNA_CHARM_SPEC[k] === 'string' && M.VANNA_CHARM_SPEC[k].length > 0));
  ok('the spec says the steps are method constants, not tuned thresholds', /not tuned thresholds/.test(M.VANNA_CHARM_SPEC.steps));
  eq('the coverage block reports the sample', [rep.coverage.quotesIn, rep.coverage.ok], [1, 1]);
}

// ── [B] ─────────────────────────────────────────────────────────────────────
console.log('\n[B] values and unit conversions');
{
  const v = run([q()]).observations[0].values;
  ok('vanna and charm are finite', [v.vanna, v.charm].every(Number.isFinite));
  eq('vannaPerVolPoint = vanna × 0.01', v.vannaPerVolPoint, Number((v.vanna * 0.01).toFixed(6)));
  eq('charmPerDay = charm / 365', v.charmPerDay, Number((v.charm / 365).toFixed(6)));
  const pe = run([q({ optionType: 'PE' })]).observations[0].values;
  ok('a put is priced too (values present)', pe !== null && Number.isFinite(pe.vanna));
}

// ── [C] ─────────────────────────────────────────────────────────────────────
console.log('\n[C] the values agree with an independent central difference');
{
  const spot = 75000, iv = 12.5 / 100, years = 6 / 365, rate = 0.065, strike = 75000;
  const step = 0.002; // a WIDER independent step than the module's default 0.0005
  const dPlus = B.bsmGreeks({ spot, strike, years, rate }, 'CE', iv + step).delta;
  const dMinus = B.bsmGreeks({ spot, strike, years, rate }, 'CE', iv - step).delta;
  const vannaIndependent = (dPlus - dMinus) / (2 * step);
  const tStep = 1 / 365;
  const tPlus = B.bsmGreeks({ spot, strike, years: years + tStep, rate }, 'CE', iv).delta;
  const tMinus = B.bsmGreeks({ spot, strike, years: years - tStep, rate }, 'CE', iv).delta;
  const charmIndependent = -(tPlus - tMinus) / (2 * tStep);
  const v = run([q()]).observations[0].values;
  near('vanna matches a wider independent central difference', v.vanna, vannaIndependent, 5e-3);
  near('charm matches a wider independent central difference', v.charm, charmIndependent, 50);
  eq('the evidence records the inputs used', [run([q()]).observations[0].evidence.spot, run([q()]).observations[0].evidence.iv], [75000, 12.5]);
}

// ── [D] ─────────────────────────────────────────────────────────────────────
console.log('\n[D] every refusal is safe and explicit');
{
  const one = (over, spots, cfg) => run([q(over)], spots ?? SPOT, cfg).observations[0];
  eq('no IV ⇒ NO_IV', one({ iv: 0 }).reason, 'NO_IV');
  eq('no spot ⇒ NO_SPOT', one({}, []).reason, 'NO_SPOT');
  eq('an expiry not after the session ⇒ NO_EXPIRY', one({ expiry: D }).reason, 'NO_EXPIRY');
  eq('one day to expiry with a 2-day step ⇒ SMALL_T', one({ expiry: '2026-09-12' }, SPOT, { timeStepDays: 2 }).reason, 'SMALL_T');
  eq('a missing strike ⇒ NO_QUOTES', one({ strike: null }).reason, 'NO_QUOTES');
  eq('a missing right ⇒ NO_QUOTES', one({ optionType: null }).reason, 'NO_QUOTES');
  const refusals = [one({ iv: 0 }), one({}, []), one({ strike: null })];
  ok('every refusal carries null values', refusals.every((r) => r.status === 'UNAVAILABLE' && r.values === null));
  ok('...with a human detail', refusals.every((r) => typeof r.reasonDetail === 'string' && r.reasonDetail.length > 0));
  eq('the refusal count map is in vocabulary order', Object.keys(run([q({ iv: 0 })]).refusalCounts), [...M.VANNA_CHARM_REFUSALS]);
}

// ── [E] ─────────────────────────────────────────────────────────────────────
console.log('\n[E] the disabled path computes nothing');
{
  const off = run([q()], SPOT, { enabled: false });
  eq('disabled ⇒ DISABLED with null values', [off.observations[0].status, off.observations[0].values], ['DISABLED', null]);
  eq('disabled ⇒ no refusal invented and no sample', [Object.values(off.refusalCounts).reduce((a, b) => a + b, 0), off.coverage.ok], [0, 0]);
  ok('the summary says it is disabled', /enabled=false/.test(off.reviewerSummary));
}

// ── [F] ─────────────────────────────────────────────────────────────────────
console.log('\n[F] determinism');
{
  const quotes = [q({ strike: 75000 }), q({ strike: 76000, optionType: 'PE', iv: 13 })];
  const fwd = run(quotes);
  ok('repeated identical runs are byte-identical', run(quotes).digest === fwd.digest);
  ok('reversed input keeps each row value identical', run([...quotes].reverse()).observations.map((o) => o.values).reverse().every((v, i) => JSON.stringify(v) === JSON.stringify(fwd.observations[i].values)));
}

// ── [G] ─────────────────────────────────────────────────────────────────────
console.log('\n[G] purity + research-only');
{
  const code = fs.readFileSync(SRC, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  ok('no clock read', !/Date\.now\(\)/.test(code));
  ok('no randomness', !/Math\.random/.test(code));
  ok('no DB or HTTP client', !/mysql|fetch\(|axios|http\./.test(code));
  ok('no model/AI client', !/openai|anthropic|bedrock|\bgpt-|claude|\bllm\b/i.test(code));
  ok('research/shadow only: no production importer', prodImporters().length === 0, prodImporters().join(','));
  function prodImporters() {
    const hits = [];
    const RESEARCH = ['gap-engine', 'value-profile', 'microstructure', 'options'];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (!RESEARCH.includes(e.name)) walk(p); }
        else if (e.name.endsWith('.ts') && !RESEARCH.some((d) => p.includes(path.join('trading', d)))) {
          if (/vanna-charm|evaluateVannaCharm/.test(fs.readFileSync(p, 'utf8'))) hits.push(path.relative(REPO, p));
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
