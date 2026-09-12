#!/usr/bin/env node
/**
 * GATE 7 #5 (roadmap row 73) — GEX / gamma-flip with EXPLICIT participant-position assumptions.
 *
 * doneWhen: "A reviewer can determine exactly what the item does and a replay/test demonstrates the behavior."
 *
 * [A] contract: version, MANDATORY assumption, conventions, closed refusal vocabulary, coverage
 * [B] the assumption is required and echoed (never silent positioning)
 * [C] the sign convention changes the aggregate exactly as documented
 * [D] gamma is computed locally (ATM gamma > OTM gamma) and the gex formula holds
 * [E] the gamma flip is the ADJACENT strikes bracketing a zero-crossing (never interpolated); NO_FLIP otherwise
 * [F] refusals: NO_SPOT / NO_EXPIRY / NO_QUOTES / NO_GAMMA; disabled
 * [G] determinism + purity
 */
const fs = require('fs');
const path = require('path');
const REPO = path.join(__dirname, '..');

const M = require(path.join(REPO, 'dist', 'trading', 'options', 'gamma-exposure'));
const B = require(path.join(REPO, 'dist', 'trading', 'bsm-greeks'));
const SRC = path.join(REPO, 'src', 'trading', 'options', 'gamma-exposure.ts');

let pass = 0;
const failures = [];
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; console.log(`  PASS ${name}`); }
  else { failures.push(name); console.log(`  FAIL ${name}${extra ? ' :: ' + extra : ''}`); }
};
const eq = (name, actual, expected) => ok(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`);
const near = (name, actual, expected, tol = 1e-6) => ok(name, typeof actual === 'number' && Math.abs(actual - expected) < tol, `got ${actual} want ~${expected}`);

const D = '2026-09-11';
const E = '2026-09-17'; // 6 days out
const q = (strike, optionType, oi, iv, over = {}) => ({ underlying: 'SENSEX', sessionDate: D, expiry: E, strike, optionType, oi, iv, source: 'UPSTOX', ...over });
const SPOT = [{ underlying: 'SENSEX', spot: 75000 }];
const A = { convention: 'CALLS_LONG_PUTS_SHORT', label: 'modelled:test' };
const run = (quotes, spots = SPOT, assumption = A, cfg) => M.evaluateGex(quotes, spots, assumption, cfg);

// ── [A] ─────────────────────────────────────────────────────────────────────
console.log('\n[A] contract');
{
  const rep = run([q(75000, 'CE', 1000, 12.5), q(75000, 'PE', 1000, 12.5)]);
  eq('version', rep.version, 'gex-v1');
  eq('the config is the switch plus the documented rate', Object.keys(M.DEFAULT_GEX_CONFIG), ['enabled', 'rate']);
  eq('the closed refusal vocabulary is the documented set', [...M.GEX_REFUSALS], ['NO_ASSUMPTIONS', 'NO_QUOTES', 'NO_SPOT', 'NO_EXPIRY', 'NO_GAMMA']);
  eq('the spec documents every refusal token', M.GEX_SPEC.refuses, [...M.GEX_REFUSALS]);
  eq('the dealer conventions are pinned', [...M.DEALER_CONVENTIONS], ['ALL_LONG', 'ALL_SHORT', 'CALLS_LONG_PUTS_SHORT']);
  ok('the spec makes the assumption mandatory and explicit', /MANDATORY/.test(M.GEX_SPEC.assumption) && /never a claim about real positioning/.test(M.GEX_SPEC.assumption));
  ok('the spec pins the formula and the 1% convention', /spot² × 0\.01/.test(M.GEX_SPEC.formula) && /index-point²/.test(M.GEX_SPEC.units));
  eq('the assumption is echoed on the report', rep.assumption, A);
}

// ── [B] ─────────────────────────────────────────────────────────────────────
console.log('\n[B] the assumption is REQUIRED and echoed');
{
  const rep = run([q(75000, 'CE', 1000, 12.5)], SPOT, null);
  eq('no assumption ⇒ NO_ASSUMPTIONS with no GEX', [rep.surfaces[0].status, rep.surfaces[0].reason, rep.surfaces[0].totalGex], ['UNAVAILABLE', 'NO_ASSUMPTIONS', null]);
  const bogus = run([q(75000, 'CE', 1000, 12.5)], SPOT, { convention: 'WHATEVER', label: 'x' });
  eq('an unknown convention is refused too', bogus.surfaces[0].reason, 'NO_ASSUMPTIONS');
  const okRows = run([q(75000, 'CE', 1000, 12.5)]).surfaces[0];
  eq('the assumption travels on the surface', okRows.assumption, A);
}

// ── [C] ─────────────────────────────────────────────────────────────────────
console.log('\n[C] the sign convention changes the aggregate exactly as documented');
{
  const call = q(75000, 'CE', 1000, 12.5);
  const put = q(75000, 'PE', 1000, 12.5);
  const clps = run([call]).surfaces[0].totalGex;
  const clpsPut = run([put]).surfaces[0].totalGex;
  ok('CALLS_LONG_PUTS_SHORT: the call is positive and the put negative', clps > 0 && clpsPut < 0);
  near('...and they are exact negatives for identical OI/IV', clps + clpsPut, 0, 1e-6);
  const allLong = run([call, put], SPOT, { convention: 'ALL_LONG', label: 'x' }).surfaces[0].totalGex;
  const allShort = run([call, put], SPOT, { convention: 'ALL_SHORT', label: 'x' }).surfaces[0].totalGex;
  ok('ALL_LONG sums both sides positive', allLong > 0);
  near('ALL_SHORT is the exact reflection of ALL_LONG', allLong + allShort, 0, 1e-6);
}

// ── [D] ─────────────────────────────────────────────────────────────────────
console.log('\n[D] gamma is computed locally and the formula holds');
{
  const s = run([q(75000, 'CE', 1000, 12.5)]).surfaces[0];
  const spot = 75000, years = 6 / 365, rate = 0.065;
  const g = B.bsmGreeks({ spot, strike: 75000, years, rate }, 'CE', 12.5 / 100);
  const expected = 1 * g.gamma * 1000 * spot * spot * 0.01;
  near('per-strike gex = sign × localGamma × oi × spot² × 0.01', s.byStrike[0].gex, expected, 1e-4);
  eq('the row records its contract count', s.byStrike[0].contracts, 1);
  const atm = run([q(75000, 'CE', 1000, 12.5)]).surfaces[0].byStrike[0].gex;
  const otm = run([q(80000, 'CE', 1000, 12.5)]).surfaces[0].byStrike[0].gex;
  ok('an ATM contract has more gamma than an OTM one', Math.abs(atm) > Math.abs(otm));
  const twoStrikes = run([q(75000, 'CE', 1000, 12.5), q(76000, 'CE', 500, 13)]).surfaces[0];
  eq('strikes are ordered ascending', twoStrikes.byStrike.map((c) => c.strike), [75000, 76000]);
  eq('call/put split is reported per strike', [twoStrikes.byStrike[0].callGex, twoStrikes.byStrike[0].putGex], [twoStrikes.byStrike[0].gex, 0]);
}

// ── [E] ─────────────────────────────────────────────────────────────────────
console.log('\n[E] the gamma flip is the bracketing pair, never interpolated');
{
  // puts with large OI at the low strike (negative), calls with large OI at the high strike (positive)
  const crossed = run([q(74000, 'PE', 5000, 14), q(76000, 'CE', 5000, 13)]).surfaces[0];
  eq('a zero-crossing is reported as the ADJACENT strikes', crossed.gammaFlip, { lowerStrike: 74000, upperStrike: 76000 });
  eq('...with no flip reason', crossed.flipReason, null);
  const monotone = run([q(74000, 'CE', 5000, 13), q(76000, 'CE', 5000, 13)]).surfaces[0];
  eq('a profile that never crosses reports NO_FLIP (no fabricated level)', [monotone.gammaFlip, monotone.flipReason], [null, 'NO_FLIP']);
  const flip = M.evaluateGex([q(74000, 'PE', 5000, 14), q(76000, 'CE', 5000, 13)], SPOT, A).surfaces[0].gammaFlip;
  ok('the flip reports strikes only — it is never a single interpolated price', flip && flip.lowerStrike !== flip.upperStrike);
}

// ── [F] ─────────────────────────────────────────────────────────────────────
console.log('\n[F] refusals are safe and explicit');
{
  eq('no spot ⇒ NO_SPOT', run([q(75000, 'CE', 1000, 12.5)], []).surfaces[0].reason, 'NO_SPOT');
  eq('an expiry not after the session ⇒ NO_EXPIRY', run([q(75000, 'CE', 1000, 12.5, { expiry: '2026-09-01' })]).surfaces[0].reason, 'NO_EXPIRY');
  eq('no quotes ⇒ no surface at all (nothing grouped)', run([]).surfaces.length, 0);
  eq('no usable gamma ⇒ NO_GAMMA', run([q(75000, 'CE', 1000, 0)]).surfaces[0].reason, 'NO_GAMMA');
  eq('OI of 0 is excluded, not treated as gamma', run([q(75000, 'CE', 0, 12.5)]).surfaces[0].excluded.noOi, 1);
  const off = run([q(75000, 'CE', 1000, 12.5)], SPOT, A, { enabled: false });
  eq('disabled ⇒ DISABLED with no GEX', [off.surfaces[0].status, off.surfaces[0].totalGex], ['DISABLED', null]);
  eq('the refusal count map is in vocabulary order', Object.keys(run([q(75000, 'CE', 1000, 12.5)]).refusalCounts), [...M.GEX_REFUSALS]);
}

// ── [G] ─────────────────────────────────────────────────────────────────────
console.log('\n[G] determinism + purity');
{
  const quotes = [q(75000, 'CE', 1000, 12.5), q(76000, 'CE', 500, 13), q(74000, 'PE', 800, 14)];
  const fwd = run(quotes);
  const rev = run([...quotes].reverse());
  eq('reversed input ⇒ identical digest', rev.digest, fwd.digest);
  ok('repeated identical runs are byte-identical', run(quotes).digest === fwd.digest);
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
          if (/gamma-exposure|evaluateGex/.test(fs.readFileSync(p, 'utf8'))) hits.push(path.relative(REPO, p));
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
