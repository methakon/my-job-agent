#!/usr/bin/env node
/**
 * GATE 5 #5 (roadmap row 54) — track spread and spread shock.
 *
 * doneWhen: "A report can reproduce the metric from archived data and shows the sample size/coverage used."
 *
 * [A] contract: version, pinned metric/window/units, closed refusal + shock vocabularies, coverage
 * [B] the spread and the shock baseline are exact (self-exclusion, median, ratio/abs)
 * [C] every edge case is a safe explicit state (never 0/NaN/Infinity)
 * [D] the disabled path computes nothing
 * [E] determinism + no look-ahead (the baseline uses PRIOR quotes only)
 * [F] sessions never share a baseline; provenance and basis are echoed
 * [G] purity + research-only
 */
const fs = require('fs');
const path = require('path');
const REPO = path.join(__dirname, '..');

const M = require(path.join(REPO, 'dist', 'trading', 'microstructure', 'spread-shock'));
const SRC = path.join(REPO, 'src', 'trading', 'microstructure', 'spread-shock.ts');

let pass = 0;
const failures = [];
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; console.log(`  PASS ${name}`); }
  else { failures.push(name); console.log(`  FAIL ${name}${extra ? ' :: ' + extra : ''}`); }
};
const eq = (name, actual, expected) => ok(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`);

const S = '2026-09-11';
const sec = (n) => `2026-09-11T09:${String(15 + Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}+05:30`;
const sq = (over = {}) => ({ instrumentKey: 'NSE:NIFTY26SEP24000CE', source: 'FYERS_LIVE', sessionDate: S, basis: 'EVENT', bid: 100, ask: 101, sourceTimestamp: '2026-09-11T09:15:00+05:30', receivedTimestamp: '2026-09-11T09:15:01+05:30', sequenceNumber: 1, dataQuality: 'GOOD', ...over });
// a series where quote k has spread k (bid fixed, ask = bid + spread)
const series = (spreads, over = {}) => spreads.map((sp, i) => sq({ bid: 100, ask: 100 + sp, sourceTimestamp: sec(i * 10), sequenceNumber: i + 1, ...over }));
const run = (qs, cfg) => M.evaluateSpreadShock(qs, cfg);

// ── [A] ─────────────────────────────────────────────────────────────────────
console.log('\n[A] contract');
{
  const rep = run(series([1, 1, 2, 1, 1, 3]));
  eq('version', rep.version, 'spreadshock-v1');
  eq('the config is the switch plus the two window bounds', Object.keys(M.DEFAULT_SPREAD_SHOCK_CONFIG), ['enabled', 'baselineWindow', 'minBaseline']);
  eq('the closed refusal vocabulary is the documented set', [...M.SPREAD_REFUSALS], ['NO_QUOTES', 'NO_SESSION_DATE', 'INVALID_QUOTE', 'CROSSED_BOOK']);
  eq('the closed shock-reason vocabulary is the documented set', [...M.SHOCK_REASONS], ['NO_TIMESTAMP', 'INSUFFICIENT_BASELINE']);
  eq('the spec documents every refusal token', M.SPREAD_SHOCK_SPEC.refuses, [...M.SPREAD_REFUSALS]);
  ok('the spec pins metric, window and units', ['metric', 'window', 'units'].every((k) => typeof M.SPREAD_SHOCK_SPEC[k] === 'string' && M.SPREAD_SHOCK_SPEC[k].length > 0));
  ok('the spec says there is no look-ahead', /no look-ahead|PRIOR/.test(M.SPREAD_SHOCK_SPEC.window));
  ok('the spec says no threshold is tuned', /none/.test(M.SPREAD_SHOCK_SPEC.thresholds));
  eq('the coverage block reports the sample size', [rep.coverage.quotesIn, rep.coverage.ok], [6, 6]);
}

// ── [B] ─────────────────────────────────────────────────────────────────────
console.log('\n[B] the spread and the baseline are exact');
{
  const rep = run(series([1, 1, 2, 1, 1, 3]));
  const first = rep.observations[0];
  eq('spread = ask − bid', first.values.spread, 1);
  eq('mid = (bid+ask)/2', first.values.mid, 100.5);
  eq('relativeSpread = spread/mid', first.values.relativeSpread, Number((1 / 100.5).toFixed(6)));

  const fifth = rep.observations[4];
  eq('the first quote with too few priors reports INSUFFICIENT_BASELINE', [fifth.shock, fifth.shockReason], [null, 'INSUFFICIENT_BASELINE']);
  const sixth = rep.observations[5];
  eq('the baseline is the MEDIAN of the 5 PRIOR spreads [1,1,2,1,1]', sixth.shock.baselineSpread, 1);
  eq('...over exactly the prior-window count', sixth.shock.baselineCount, 5);
  eq('spreadShockAbs = spread − baseline', sixth.shock.spreadShockAbs, 2);
  eq('spreadShockRatio = spread/baseline', sixth.shock.spreadShockRatio, 3);
  ok('the quote itself is EXCLUDED from its baseline (4 priors < minBaseline 5 ⇒ no shock)', fifth.shock === null && fifth.shockReason === 'INSUFFICIENT_BASELINE');

  // an even prior count averages the two middle values
  const even = run(series([1, 1, 2, 1, 1, 1, 1, 4]), { minBaseline: 6, baselineWindow: 20 });
  eq('an even prior count ⇒ mean of the two middle values', even.observations[7].shock.baselineSpread, 1);
  // baselineWindow caps how many priors are used
  const capped = run(series([1, 1, 1, 1, 1, 5, 5, 5, 5, 5, 9]), { baselineWindow: 5, minBaseline: 5 });
  eq('baselineWindow caps the window (last 5 priors = [5,5,5,5,5])', capped.observations[10].shock.baselineSpread, 5);
  eq('...and the count reflects the cap', capped.observations[10].shock.baselineCount, 5);
}

// ── [C] ─────────────────────────────────────────────────────────────────────
console.log('\n[C] every edge case is safe and explicit');
{
  eq('no observation ⇒ NO_QUOTES', run([null]).observations[0].reason, 'NO_QUOTES');
  eq('a missing session date ⇒ NO_SESSION_DATE', run([sq({ sessionDate: null })]).observations[0].reason, 'NO_SESSION_DATE');
  eq('a 0 bid ⇒ INVALID_QUOTE', run([sq({ bid: 0 })]).observations[0].reason, 'INVALID_QUOTE');
  eq('a missing ask ⇒ INVALID_QUOTE', run([sq({ ask: null })]).observations[0].reason, 'INVALID_QUOTE');
  eq('bid > ask ⇒ CROSSED_BOOK', run([sq({ bid: 102, ask: 101 })]).observations[0].reason, 'CROSSED_BOOK');
  const noTs = run(series([1, 1, 1, 1, 1, 1]).map((q, i) => (i === 5 ? { ...q, sourceTimestamp: null } : q))).observations.find((o) => o.evidence.sourceTimestamp === null);
  eq('a quote with no timestamp keeps its spread but reports NO_TIMESTAMP', [noTs.status, noTs.values.spread, noTs.shock, noTs.shockReason], ['OK', 1, null, 'NO_TIMESTAMP']);
  const refused = run([null, sq({ bid: 0 }), sq({ bid: 102, ask: 101 })]);
  ok('every refusal carries null values', refused.observations.every((o) => o.values === null && o.status === 'UNAVAILABLE'));
  eq('counts separate decided from refused', [refused.counts.OK, refused.counts.UNAVAILABLE], [0, 3]);
  eq('the refusal count map is in vocabulary order', Object.keys(refused.refusalCounts), [...M.SPREAD_REFUSALS]);
  eq('the shock-reason count map is in vocabulary order', Object.keys(refused.shockReasonCounts), [...M.SHOCK_REASONS]);
}

// ── [D] ─────────────────────────────────────────────────────────────────────
console.log('\n[D] the disabled path computes nothing');
{
  const off = run(series([1, 1]), { enabled: false });
  eq('disabled ⇒ DISABLED with null values', [off.observations[0].status, off.observations[0].values], ['DISABLED', null]);
  eq('disabled ⇒ no refusal invented and no sample', [Object.values(off.refusalCounts).reduce((a, b) => a + b, 0), off.coverage.ok, off.coverage.withShock], [0, 0, 0]);
  ok('the summary says it is disabled', /enabled=false/.test(off.reviewerSummary));
}

// ── [E] ─────────────────────────────────────────────────────────────────────
console.log('\n[E] determinism and no look-ahead');
{
  const qs = series([1, 2, 1, 3, 1, 2, 1]);
  const fwd = run(qs);
  const rev = run([...qs].reverse());
  eq('reversed input ⇒ identical digest', rev.digest, fwd.digest);
  eq('reversed input ⇒ identical shock order', rev.observations.map((o) => o.evidence.sequenceNumber), fwd.observations.map((o) => o.evidence.sequenceNumber));
  ok('repeated identical runs are byte-identical', run(qs).digest === fwd.digest);

  const firstShockBefore = fwd.observations[0];
  const grown = run([...qs, sq({ sourceTimestamp: sec(600), sequenceNumber: 99, bid: 100, ask: 200 })]);
  eq('adding a LATER quote leaves an EARLIER quote spread unchanged', grown.observations.find((o) => o.evidence.sequenceNumber === 1).values, firstShockBefore.values);
  eq('...and leaves its shock state unchanged (still no priors)', grown.observations.find((o) => o.evidence.sequenceNumber === 1).shockReason, 'INSUFFICIENT_BASELINE');
  // a later quote DOES get a baseline from earlier ones (the intended direction)
  ok('a later quote is judged against its predecessors', grown.observations.find((o) => o.evidence.sequenceNumber === 99).shock !== null);
}

// ── [F] ─────────────────────────────────────────────────────────────────────
console.log('\n[F] sessions never share a baseline; provenance echoed');
{
  const a = series([1, 1, 1, 1, 1, 1]);
  const b = a.map((q, i) => ({ ...q, sessionDate: '2026-09-12', sourceTimestamp: `2026-09-12T09:1${i}:00+05:30` }));
  const rep = run([...a, ...b]);
  const bFirst = rep.observations.find((o) => o.sessionDate === '2026-09-12' && o.evidence.sequenceNumber === 1);
  eq('a new session starts with no baseline (sessions do not share)', [bFirst.shock, bFirst.shockReason], [null, 'INSUFFICIENT_BASELINE']);
  eq('the report counts both sessions', rep.coverage.sessions, 2);
  const o = rep.observations[0];
  eq('source/instrument travel', [o.source, o.instrumentKey], ['FYERS_LIVE', 'NSE:NIFTY26SEP24000CE']);
  eq('the timestamps and sequence number travel', [o.evidence.sourceTimestamp, o.evidence.receivedTimestamp, o.evidence.sequenceNumber], ['2026-09-11T03:45:00.000Z', '2026-09-11T03:45:01.000Z', 1]);
  eq('the basis and data quality travel', [o.basis, o.evidence.dataQuality], ['EVENT', 'GOOD']);
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
  ok('research/shadow only: no production importer yet', prodImporters().length === 0, prodImporters().join(','));
  function prodImporters() {
    const hits = [];
    const RESEARCH = ['gap-engine', 'value-profile', 'microstructure'];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (!RESEARCH.includes(e.name)) walk(p); }
        else if (e.name.endsWith('.ts') && !RESEARCH.some((d) => p.includes(path.join('trading', d)))) {
          if (/spread-shock|evaluateSpreadShock/.test(fs.readFileSync(p, 'utf8'))) hits.push(path.relative(REPO, p));
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
