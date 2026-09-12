#!/usr/bin/env node
/**
 * GATE 7 #3 (roadmap row 69) — skew and term-structure slope/curvature.
 *
 * doneWhen: "The same inputs produce the same result in replay, and edge cases return a safe explicit state
 *            rather than a fabricated value."
 *
 * [A] contract: version, pinned definition/units, closed refusal vocabulary, upstream version carried
 * [B] the skew is the exact OLS slope of IV on strike
 * [C] the term slope/curvature are exact; insufficient strikes/expiries and a zero gap are explicit
 * [D] a non-OK upstream surface ⇒ NO_SURFACE; the disabled path computes nothing
 * [E] determinism
 * [F] purity + research-only
 */
const fs = require('fs');
const path = require('path');
const REPO = path.join(__dirname, '..');

const S = require(path.join(REPO, 'dist', 'trading', 'options', 'iv-surface'));
const M = require(path.join(REPO, 'dist', 'trading', 'options', 'iv-skew-term'));
const SRC = path.join(REPO, 'src', 'trading', 'options', 'iv-skew-term.ts');

let pass = 0;
const failures = [];
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; console.log(`  PASS ${name}`); }
  else { failures.push(name); console.log(`  FAIL ${name}${extra ? ' :: ' + extra : ''}`); }
};
const eq = (name, actual, expected) => ok(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`);
const near = (name, actual, expected, tol = 1e-5) => ok(name, typeof actual === 'number' && Math.abs(actual - expected) < tol, `got ${actual} want ~${expected}`);

const D = '2026-09-11';
const pt = (underlying, expiry, strike, iv) => ({ underlying, sessionDate: D, expiry, strike, optionType: 'CE', iv, source: 'UPSTOX' });
const surfaceOf = (points) => S.evaluateIvSurface(points, {});

// ── [A] ─────────────────────────────────────────────────────────────────────
console.log('\n[A] contract');
{
  const rep = M.evaluateIvSkewTerm(surfaceOf([pt('X', '2026-09-15', 100, 10), pt('X', '2026-09-15', 200, 12), pt('X', '2026-09-15', 300, 14)]));
  eq('version', rep.version, 'ivskewterm-v1');
  eq('the config is just the switch', Object.keys(M.DEFAULT_IV_SKEW_TERM_CONFIG), ['enabled']);
  eq('the closed refusal vocabulary is the documented set', [...M.IV_SKEW_TERM_REFUSALS], ['NO_SURFACE', 'INSUFFICIENT_STRIKES', 'INSUFFICIENT_EXPIRIES', 'ZERO_EXPIRY_GAP']);
  eq('the spec documents every refusal token', M.IV_SKEW_TERM_SPEC.refuses, [...M.IV_SKEW_TERM_REFUSALS]);
  eq('the status vocabulary is pinned', [...M.IV_SKEW_TERM_STATUSES], ['OK', 'UNAVAILABLE', 'DISABLED']);
  ok('the spec pins skew, term, units and thresholds', ['skew', 'term', 'units', 'thresholds'].every((k) => typeof M.IV_SKEW_TERM_SPEC[k] === 'string' && M.IV_SKEW_TERM_SPEC[k].length > 0));
  ok('the spec says no ATM match / wing selection / percentile', /no ATM match, no wing selection, no percentile/.test(M.IV_SKEW_TERM_SPEC.thresholds));
  eq('the upstream surface version is carried', rep.upstreamSurfaceVersion, 'ivsurface-v1');
}

// ── [B] ─────────────────────────────────────────────────────────────────────
console.log('\n[B] the skew is the exact OLS slope of IV on strike');
{
  const s = M.evaluateIvSkewTerm(surfaceOf([pt('X', '2026-09-15', 100, 10), pt('X', '2026-09-15', 200, 12), pt('X', '2026-09-15', 300, 14)])).surfaces[0];
  // slope = (14 − 10) / (300 − 100) = 0.02 IV percent per strike point
  near('skewPerPoint = ΔIV/Δstrike for a linear slice', s.slices[0].skewPerPoint, 0.02);
  eq('skewPer100 = 100 × skewPerPoint', s.slices[0].skewPer100, 2);
  eq('the slice reports its strike count and median IV', [s.slices[0].strikeCount, s.slices[0].ivMedian], [3, 12]);
  const flat = M.evaluateIvSkewTerm(surfaceOf([pt('X', '2026-09-15', 100, 11), pt('X', '2026-09-15', 200, 11)])).surfaces[0];
  eq('a flat smile has zero skew', flat.slices[0].skewPerPoint, 0);
  const neg = M.evaluateIvSkewTerm(surfaceOf([pt('X', '2026-09-15', 100, 14), pt('X', '2026-09-15', 300, 10)])).surfaces[0];
  near('a negatively sloped smile has negative skew', neg.slices[0].skewPerPoint, -0.02);
}

// ── [C] ─────────────────────────────────────────────────────────────────────
console.log('\n[C] the term structure is exact and explicit');
{
  const two = M.evaluateIvSkewTerm(surfaceOf([pt('X', '2026-09-15', 100, 10), pt('X', '2026-09-17', 100, 12)])).surfaces[0];
  eq('two expiries ⇒ slope per calendar day', [two.term.expiryCount, two.term.daysTotal, two.term.slopePerDay], [2, 2, 1]);
  eq('...and curvature is null with its reason (a third expiry is required)', [two.term.curvature, two.term.reason], [null, 'INSUFFICIENT_EXPIRIES']);
  const three = M.evaluateIvSkewTerm(surfaceOf([pt('X', '2026-09-15', 100, 10), pt('X', '2026-09-17', 100, 12), pt('X', '2026-09-20', 100, 13)])).surfaces[0];
  eq('three expiries ⇒ slope over the total span', [three.term.daysTotal, three.term.slopePerDay], [5, 0.6]);
  // seg1 = (12−10)/2 = 1; seg2 = (13−12)/3 = 0.3333; curvature = (seg2−seg1)/((2+3)/2) = −0.266667
  near('...and a second-difference curvature', three.term.curvature, -0.266667);
  eq('...with no term reason', three.term.reason, null);

  const oneStrike = M.evaluateIvSkewTerm(surfaceOf([pt('X', '2026-09-15', 100, 10)])).surfaces[0];
  eq('a single-strike slice has no skew ⇒ INSUFFICIENT_STRIKES', [oneStrike.slices[0].skewPerPoint, oneStrike.slices[0].reason], [null, 'INSUFFICIENT_STRIKES']);
  const oneExpiry = M.evaluateIvSkewTerm(surfaceOf([pt('X', '2026-09-15', 100, 10), pt('X', '2026-09-15', 200, 12)])).surfaces[0];
  eq('one expiry ⇒ no term slope ⇒ INSUFFICIENT_EXPIRIES', [oneExpiry.term.slopePerDay, oneExpiry.term.reason], [null, 'INSUFFICIENT_EXPIRIES']);

  // ZERO_EXPIRY_GAP: two distinct expiry strings that are the same calendar day (hand-crafted upstream row)
  const zeroGap = M.evaluateIvSkewTerm({ version: 'ivsurface-v1', surfaces: [{ underlying: 'Z', sessionDate: D, status: 'OK', reason: null, reasonDetail: null, slices: [{ expiry: '2026-09-15', strikeCount: 2, ivMedian: 10, points: [{ strike: 100, optionType: 'CE', iv: 10 }, { strike: 200, optionType: 'CE', iv: 10 }] }, { expiry: '2026-09-15T00:00:00', strikeCount: 2, ivMedian: 12, points: [{ strike: 100, optionType: 'CE', iv: 12 }, { strike: 200, optionType: 'CE', iv: 12 }] }] }] }).surfaces[0];
  eq('two expiries on the same calendar day ⇒ ZERO_EXPIRY_GAP', [zeroGap.term.slopePerDay, zeroGap.term.reason], [null, 'ZERO_EXPIRY_GAP']);
}

// ── [D] ─────────────────────────────────────────────────────────────────────
console.log('\n[D] upstream failure and the disabled path');
{
  const bad = M.evaluateIvSkewTerm(surfaceOf([pt('X', '2026-09-15', 100, 0)])).surfaces[0];
  eq('a non-OK surface ⇒ NO_SURFACE with null slices', [bad.status, bad.reason, bad.slices.length], ['UNAVAILABLE', 'NO_SURFACE', 0]);
  const off = M.evaluateIvSkewTerm(surfaceOf([pt('X', '2026-09-15', 100, 10), pt('X', '2026-09-15', 200, 12)]), { enabled: false });
  eq('disabled ⇒ DISABLED with null term', [off.surfaces[0].status, off.surfaces[0].term.slopePerDay], ['DISABLED', null]);
  eq('disabled ⇒ no refusal invented', Object.values(off.refusalCounts).reduce((a, b) => a + b, 0), 0);
  eq('the refusal count map is in vocabulary order', Object.keys(off.refusalCounts), [...M.IV_SKEW_TERM_REFUSALS]);
}

// ── [E] ─────────────────────────────────────────────────────────────────────
console.log('\n[E] determinism');
{
  const pts = [pt('A', '2026-09-15', 100, 10), pt('A', '2026-09-15', 200, 12), pt('A', '2026-09-15', 300, 14), pt('B', '2026-09-15', 100, 9), pt('B', '2026-09-17', 100, 11)];
  const fwd = M.evaluateIvSkewTerm(surfaceOf(pts));
  const rev = M.evaluateIvSkewTerm(surfaceOf([...pts].reverse()));
  eq('reversed input ⇒ identical digest', rev.digest, fwd.digest);
  eq('surfaces stay canonically ordered', rev.surfaces.map((s) => s.underlying), fwd.surfaces.map((s) => s.underlying));
  ok('repeated identical runs are byte-identical', M.evaluateIvSkewTerm(surfaceOf(pts)).digest === fwd.digest);
}

// ── [F] ─────────────────────────────────────────────────────────────────────
console.log('\n[F] purity + research-only');
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
          if (/iv-skew-term|evaluateIvSkewTerm/.test(fs.readFileSync(p, 'utf8'))) hits.push(path.relative(REPO, p));
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
