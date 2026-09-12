#!/usr/bin/env node
/**
 * GATE 7 #2 (roadmap row 67) — IV surface across strike and expiry.
 *
 * doneWhen: "The component can be enabled/disabled independently and its output can be inspected in a
 *            historical replay."
 *
 * [A] contract: version, pinned input/output schema, closed refusal vocabulary, coverage
 * [B] the surface is built correctly (slices by expiry, strike-ordered points, summaries, term availability)
 * [C] exclusions and refusals are safe and explicit
 * [D] the component can be enabled/disabled independently
 * [E] determinism
 * [F] purity + research-only
 */
const fs = require('fs');
const path = require('path');
const REPO = path.join(__dirname, '..');

const M = require(path.join(REPO, 'dist', 'trading', 'options', 'iv-surface'));
const SRC = path.join(REPO, 'src', 'trading', 'options', 'iv-surface.ts');

let pass = 0;
const failures = [];
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; console.log(`  PASS ${name}`); }
  else { failures.push(name); console.log(`  FAIL ${name}${extra ? ' :: ' + extra : ''}`); }
};
const eq = (name, actual, expected) => ok(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`);

const S = '2026-09-11';
const pt = (expiry, strike, optionType, iv, over = {}) => ({ underlying: 'SENSEX', sessionDate: S, expiry, strike, optionType, iv, source: 'UPSTOX', ...over });
const near = () => [pt('2026-09-10', 74800, 'CE', 9.0), pt('2026-09-10', 74800, 'PE', 13.0), pt('2026-09-10', 74900, 'CE', 10.0), pt('2026-09-17', 74800, 'CE', 12.0), pt('2026-09-17', 74900, 'PE', 14.0)];
const run = (points, cfg) => M.evaluateIvSurface(points, cfg);

// ── [A] ─────────────────────────────────────────────────────────────────────
console.log('\n[A] contract');
{
  const rep = run(near());
  eq('version', rep.version, 'ivsurface-v1');
  eq('the config is the switch plus the coverage bound', Object.keys(M.DEFAULT_IV_SURFACE_CONFIG), ['enabled', 'minStrikesPerExpiry']);
  eq('the closed refusal vocabulary is the documented set', [...M.IV_SURFACE_REFUSALS], ['NO_IVS', 'NO_SESSION_DATE']);
  eq('the spec documents every refusal token', M.IV_SURFACE_SPEC.refuses, [...M.IV_SURFACE_REFUSALS]);
  eq('the status vocabulary is pinned', [...M.IV_SURFACE_STATUSES], ['OK', 'UNAVAILABLE', 'DISABLED']);
  ok('the spec pins input, output, units and timestamps', ['input', 'output', 'units', 'timestamps'].every((k) => typeof M.IV_SURFACE_SPEC[k] === 'string' && M.IV_SURFACE_SPEC[k].length > 0));
  eq('the coverage block reports slices and term availability', [rep.coverage.surfaces, rep.coverage.ok, rep.coverage.slices, rep.coverage.withTerm], [1, 1, 2, 1]);
}

// ── [B] ─────────────────────────────────────────────────────────────────────
console.log('\n[B] the surface is built correctly');
{
  const s = run(near()).surfaces[0];
  eq('slices are ordered by expiry', s.slices.map((x) => x.expiry), ['2026-09-10', '2026-09-17']);
  eq('a slice reports its strike range and count', [s.slices[0].strikeLow, s.slices[0].strikeHigh, s.slices[0].strikeCount], [74800, 74900, 2]);
  eq('points are strike-ordered with CE before PE', s.slices[0].points.map((p) => `${p.strike}${p.optionType}`), ['74800CE', '74800PE', '74900CE']);
  eq('a slice reports min/max/median IV', [s.slices[0].ivMin, s.slices[0].ivMax, s.slices[0].ivMedian], [9, 13, 10]);
  eq('call/put counts are reported', [s.slices[0].callCount, s.slices[0].putCount], [2, 1]);
  eq('the surface pools strikes and reports expiryCount/termAvailable', [s.expiryCount, s.termAvailable, s.strikeCoverage], [2, true, 2]);
  eq('the pooled IV summary spans all slices', [s.ivMin, s.ivMax, s.ivMedian], [9, 14, 12]);
  eq('pointsIn counts the supplied rows', s.pointsIn, 5);
  const single = run([pt('2026-09-15', 24000, 'CE', 11.0)]).surfaces[0];
  eq('one expiry ⇒ termAvailable false (a real single-expiry surface is still OK)', [single.status, single.expiryCount, single.termAvailable], ['OK', 1, false]);
  const thin = run([pt('2026-09-15', 24000, 'CE', 11.0)]).surfaces[0];
  eq('a slice below minStrikesPerExpiry is flagged, not dropped', thin.slices[0].sufficient, false);
  eq('...and a slice meeting the coverage bound is flagged sufficient', run(near(), { minStrikesPerExpiry: 2 }).surfaces[0].slices[1].sufficient, true);
  eq('...while the default bound of 3 strikes marks a 2-strike slice insufficient', run(near()).surfaces[0].slices[1].sufficient, false);
}

// ── [C] ─────────────────────────────────────────────────────────────────────
console.log('\n[C] exclusions and refusals are explicit');
{
  eq('no usable IV ⇒ NO_IVS', run([pt('2026-09-10', 74800, 'CE', 0), pt('2026-09-10', 74900, 'CE', null)]).surfaces[0].reason, 'NO_IVS');
  eq('an unusable session date ⇒ NO_SESSION_DATE', run([pt('2026-09-10', 74800, 'CE', 9, { sessionDate: 'x' })]).surfaces[0].reason, 'NO_SESSION_DATE');
  const ex = run([pt('2026-09-10', 74800, 'CE', 9), pt('2026-09-10', 74900, 'CE', -1), pt('2026-09-10', null, 'CE', 10), pt('2026-09-10', 75000, 'CE', 11, { expiry: '' })]).surfaces[0];
  eq('a 0/negative IV is excluded and counted', ex.excludedIv, 1);
  eq('a non-finite strike or missing expiry is excluded and counted', ex.excludedStrike, 2);
  eq('...and only the usable point forms the surface', [ex.slices.length, ex.slices[0].points.length], [1, 1]);
  const refusals = [run([pt('2026-09-10', 74800, 'CE', 0)]).surfaces[0], run([pt('2026-09-10', 74800, 'CE', 9, { sessionDate: '' })]).surfaces[0]];
  ok('every refusal carries an empty surface', refusals.every((r) => r.status === 'UNAVAILABLE' && r.slices.length === 0 && r.ivMedian === null));
  ok('...with a human detail', refusals.every((r) => typeof r.reasonDetail === 'string' && r.reasonDetail.length > 0));
  eq('the refusal count map is in vocabulary order', Object.keys(run([pt('2026-09-10', 74800, 'CE', 0)]).refusalCounts), [...M.IV_SURFACE_REFUSALS]);
}

// ── [D] ─────────────────────────────────────────────────────────────────────
console.log('\n[D] the component can be enabled/disabled independently');
{
  const off = run(near(), { enabled: false });
  eq('disabled ⇒ DISABLED with an empty surface', [off.surfaces[0].status, off.surfaces[0].slices.length], ['DISABLED', 0]);
  eq('disabled ⇒ no refusal invented', Object.values(off.refusalCounts).reduce((a, b) => a + b, 0), 0);
  eq('disabled ⇒ nothing counted as OK', off.coverage.ok, 0);
  ok('the summary says it is disabled', /enabled=false/.test(off.reviewerSummary));
}

// ── [E] ─────────────────────────────────────────────────────────────────────
console.log('\n[E] determinism');
{
  const pts = [...near(), pt('2026-09-17', 74800, 'PE', 15.0)];
  const fwd = run(pts);
  const rev = run([...pts].reverse());
  eq('reversed input ⇒ identical digest', rev.digest, fwd.digest);
  eq('reversed input ⇒ identical slice order', rev.surfaces[0].slices.map((s) => s.expiry), fwd.surfaces[0].slices.map((s) => s.expiry));
  ok('repeated identical runs are byte-identical', run(pts).digest === fwd.digest);
  const two = run([...pts, pt('2026-09-10', 74700, 'CE', 8.5, { underlying: 'NIFTY50' })]);
  eq('surfaces are canonically ordered by underlying+session', two.surfaces.map((s) => `${s.underlying}|${s.sessionDate}`), ['NIFTY50|2026-09-11', 'SENSEX|2026-09-11']);
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
          if (/iv-surface|evaluateIvSurface/.test(fs.readFileSync(p, 'utf8'))) hits.push(path.relative(REPO, p));
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
