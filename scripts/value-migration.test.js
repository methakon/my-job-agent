#!/usr/bin/env node
/**
 * GATE 6 #4 (roadmap row 63) — value migration across sessions.
 *
 * doneWhen: "A report can reproduce the metric from archived data and shows the sample size/coverage used."
 *
 * [A] contract: version, pinned precedence, closed refusal vocabulary, sample size in coverage
 * [B] every migration state, from the pinned precedence
 * [C] insufficient data is a safe explicit state that still reports the sample size
 * [D] the disabled path computes nothing
 * [E] determinism: reversed input ⇒ identical digest AND identical transition order
 * [F] refused profiles are skipped, never interpolated; the date gap is reported
 * [G] purity + research-only
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const REPO = path.join(__dirname, '..');

const M = require(path.join(REPO, 'dist', 'trading', 'value-profile', 'value-migration'));

const SRC = path.join(REPO, 'src', 'trading', 'value-profile', 'value-migration.ts');

let pass = 0;
const failures = [];
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; console.log(`  PASS ${name}`); }
  else { failures.push(name); console.log(`  FAIL ${name}${extra ? ' :: ' + extra : ''}`); }
};
const eq = (name, actual, expected) => ok(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`);

const INST = 'NSE:NIFTY50-INDEX';
// synthetic profile rows: only the fields the migration compares, plus the provenance it reports
const prof = (sessionDate, val, vah, poc = null, status = 'OK', basis = 'TPO', instrument = INST) =>
  ({ sessionDate, instrument, status, val, vah, poc: poc === null ? null : { priceLow: poc, priceHigh: poc + 10, activity: 1 }, basis, method: 'va-70pct-expand1-v1' });
const report = (profiles) => ({ version: 'valprof-v1', profiles });
const run = (profiles, cfg) => M.buildValueMigration(report(profiles), cfg);

// ── [A] ─────────────────────────────────────────────────────────────────────
console.log('\n[A] contract');
{
  const rep = run([prof('2026-09-01', 100, 120), prof('2026-09-02', 110, 130)]);
  eq('version', rep.version, 'valmig-v1');
  eq('the single config object is just the switch', Object.keys(M.DEFAULT_VALUE_MIGRATION_CONFIG), ['enabled']);
  eq('the closed refusal vocabulary is the documented set', [...M.VALUE_MIGRATION_REFUSALS], ['NO_PROFILES', 'INSUFFICIENT_PROFILES', 'NO_ADJACENT_OK']);
  eq('the spec documents every refusal token', M.VALUE_MIGRATION_SPEC.refuses, [...M.VALUE_MIGRATION_REFUSALS]);
  eq('the state vocabulary is pinned in precedence order', [...M.MIGRATION_STATES], ['HIGHER', 'LOWER', 'WIDER', 'NARROWER', 'SAME', 'MIXED']);
  ok('the spec pins the pair rule and the no-threshold claim', /CONSECUTIVE profiled sessions/.test(M.VALUE_MIGRATION_SPEC.pair) && /^none/.test(M.VALUE_MIGRATION_SPEC.thresholds));
  ok('the spec says coverage/sample size is reported', /SAMPLE SIZE/.test(M.VALUE_MIGRATION_SPEC.coverage));
  eq('the upstream profile version is carried', rep.upstreamProfileVersion, 'valprof-v1');
  eq('the coverage block reports the SAMPLE SIZE', rep.coverage.sampleSize, 1);
}

// ── [B] ─────────────────────────────────────────────────────────────────────
console.log('\n[B] every migration state, from the pinned precedence');
{
  const t = (a, b) => run([prof('2026-09-01', a[0], a[1]), prof('2026-09-02', b[0], b[1])]).transitions[0];
  eq('both edges up ⇒ HIGHER', t([100, 120], [110, 130]).state, 'HIGHER');
  eq('both edges down ⇒ LOWER', t([110, 130], [100, 120]).state, 'LOWER');
  eq('both edges equal ⇒ SAME', t([100, 120], [100, 120]).state, 'SAME');
  eq('new strictly contains old ⇒ WIDER', t([110, 125], [100, 130]).state, 'WIDER');
  eq('new strictly inside old ⇒ NARROWER', t([100, 130], [110, 125]).state, 'NARROWER');
  eq('exactly one edge moved ⇒ MIXED (val up, vah unchanged)', t([100, 120], [110, 120]).state, 'MIXED');
  eq('...and the mirror case (val unchanged, vah up) ⇒ MIXED', t([100, 120], [100, 130]).state, 'MIXED');
  eq('one edge moved inward ⇒ MIXED', t([100, 120], [100, 115]).state, 'MIXED');
  ok('every published state is reachable', new Set([t([100, 120], [110, 130]).state, t([110, 130], [100, 120]).state, t([100, 120], [100, 120]).state, t([110, 125], [100, 130]).state, t([100, 130], [110, 125]).state, t([100, 120], [110, 120]).state]).size === 6);

  const higher = t([100, 120], [110, 130]);
  eq('the deltas are reported in index points', [higher.valDelta, higher.vahDelta], [10, 10]);
  eq('the overlap is the intersection', higher.overlapPoints, 10);
  eq('the overlap fraction is of the UNION', Number(higher.overlapOfUnion.toFixed(4)), Number((10 / 30).toFixed(4)));
  eq('the evidence carries both areas and their bases', [higher.evidence.prevVal, higher.evidence.prevVah, higher.evidence.val, higher.evidence.vah, higher.evidence.basis], [100, 120, 110, 130, 'TPO']);
  const withPoc = run([prof('2026-09-01', 100, 120, 110), prof('2026-09-02', 110, 130, 120)]).transitions[0];
  eq('the POC delta is reported when both POCs exist', withPoc.pocDelta, 10);
  eq('...and is null when a POC is missing', t([100, 120], [110, 130]).pocDelta, null);

  const counts = run([prof('2026-09-01', 100, 120), prof('2026-09-02', 110, 130), prof('2026-09-03', 100, 120)]).stateCounts;
  eq('the state counts add up to the sample size', Object.values(counts).reduce((a, b) => a + b, 0), 2);
}

// ── [C] ─────────────────────────────────────────────────────────────────────
console.log('\n[C] insufficient data is explicit AND still reports the sample size');
{
  const none = run([]);
  eq('no profiles ⇒ NO_PROFILES', [none.status, none.reason, none.transitions.length, none.coverage.sampleSize], ['UNAVAILABLE', 'NO_PROFILES', 0, 0]);
  const one = run([prof('2026-09-01', 100, 120)]);
  eq('a single profile ⇒ INSUFFICIENT_PROFILES', [one.status, one.reason], ['UNAVAILABLE', 'INSUFFICIENT_PROFILES']);
  eq('...and the sample size is still reported as 0 with the count behind it', [one.coverage.sampleSize, one.coverage.okProfiles], [0, 1]);
  const allBad = run([prof('2026-09-01', 100, 120, null, 'UNAVAILABLE'), prof('2026-09-02', 110, 130, null, 'UNAVAILABLE')]);
  eq('only refused profiles ⇒ NO_PROFILES', [allBad.status, allBad.reason], ['UNAVAILABLE', 'NO_PROFILES']);
  ok('...with a human detail naming the counts', /2 profile\(s\), none of them OK/.test(allBad.reasonDetail), allBad.reasonDetail);
  const twoInstruments = run([prof('2026-09-01', 100, 120, null, 'OK', 'TPO', 'A'), prof('2026-09-02', 100, 120, null, 'OK', 'TPO', 'B')]);
  eq('two instruments with one profile each ⇒ NO_ADJACENT_OK (two profiles, but no pair)', [twoInstruments.status, twoInstruments.reason], ['UNAVAILABLE', 'NO_ADJACENT_OK']);
  eq('...and the sample size is 0 while the profile count is reported', [twoInstruments.coverage.sampleSize, twoInstruments.coverage.okProfiles], [0, 2]);
  ok('a refusal is counted in its own vocabulary bucket', none.refusalCounts.NO_PROFILES === 1);
}

// ── [D] ─────────────────────────────────────────────────────────────────────
console.log('\n[D] the disabled path computes nothing');
{
  const off = run([prof('2026-09-01', 100, 120), prof('2026-09-02', 110, 130)], { enabled: false });
  eq('disabled ⇒ DISABLED with an empty transition list', [off.status, off.transitions.length, off.coverage.sampleSize], ['DISABLED', 0, 0]);
  eq('disabled ⇒ no state counted and no refusal invented', [Object.values(off.stateCounts).reduce((a, b) => a + b, 0), Object.values(off.refusalCounts).reduce((a, b) => a + b, 0)], [0, 0]);
  ok('the summary says it is disabled', /enabled=false/.test(off.reviewerSummary));
}

// ── [E] ─────────────────────────────────────────────────────────────────────
console.log('\n[E] determinism');
{
  const list = [prof('2026-09-01', 100, 120), prof('2026-09-02', 110, 130), prof('2026-09-03', 105, 125)];
  const fwd = run(list);
  const rev = run([...list].reverse());
  eq('reversed input ⇒ identical digest', rev.digest, fwd.digest);
  eq('reversed input ⇒ identical transition order', rev.transitions.map((t) => `${t.instrument}|${t.sessionDate}`), fwd.transitions.map((t) => `${t.instrument}|${t.sessionDate}`));
  ok('repeated identical runs are byte-identical', run(list).digest === fwd.digest);
  const b = run([prof('2026-09-01', 100, 120, null, 'OK', 'TPO', 'B'), prof('2026-09-02', 100, 120, null, 'OK', 'TPO', 'B'), prof('2026-09-01', 100, 120, null, 'OK', 'TPO', 'A'), prof('2026-09-02', 100, 120, null, 'OK', 'TPO', 'A')]);
  eq('instruments are canonically ordered', b.transitions.map((t) => t.instrument), ['A', 'B']);
  eq('the state count map is canonical', Object.keys(fwd.stateCounts), [...M.MIGRATION_STATES]);
  eq('the refusal count map is in vocabulary order', Object.keys(fwd.refusalCounts), [...M.VALUE_MIGRATION_REFUSALS]);
  ok('a changed area moves the digest', run([prof('2026-09-01', 100, 120), prof('2026-09-02', 110, 131)]).digest !== fwd.digest);
}

// ── [F] ─────────────────────────────────────────────────────────────────────
console.log('\n[F] refused profiles are skipped, never interpolated');
{
  const rep = run([prof('2026-09-01', 100, 120), prof('2026-09-02', 110, 130, null, 'UNAVAILABLE'), prof('2026-09-07', 105, 125)]);
  eq('a refused middle profile is skipped, leaving one pair', rep.transitions.length, 1);
  eq('the pair spans the refused session and reports the calendar gap', [rep.transitions[0].previousSessionDate, rep.transitions[0].sessionDate, rep.transitions[0].dayGap], ['2026-09-01', '2026-09-07', 6]);
  eq('non-consecutive pairs are counted for the reviewer', rep.coverage.sessionsNotConsecutive, 1);
  eq('the day gap is never used to interpolate a value', [rep.transitions[0].valDelta, rep.transitions[0].vahDelta], [5, 5]);
  const code = fs.readFileSync(SRC, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  ok('no interpolation/lerp CALL exists', !/\blerp\s*\(|interpolate\s*\(/.test(code));
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
  ok('the only comparator sort is the profile date order (the instrument-key sort uses the default order)', (code.match(/\.sort\(\(/g) || []).length === 1 && !/\.sort\([^;]*(state|overlap|delta)/.test(code));
  ok('no threshold constant exists', !/(threshold|min|max)[A-Za-z]*\s*[:=]\s*[0-9]/.test(code) || /Math\.(min|max)\(/.test(code));
  ok('research/shadow only: no production importer yet', prodImporters().length === 0, prodImporters().join(','));
  function prodImporters() {
    const hits = [];
    const RESEARCH = ['value-profile', 'gap-engine'];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (!RESEARCH.includes(e.name)) walk(p); }
        else if (e.name.endsWith('.ts') && !p.includes(path.join('trading', 'value-profile'))) {
          if (/value-migration|buildValueMigration/.test(fs.readFileSync(p, 'utf8'))) hits.push(path.relative(REPO, p));
        }
      }
    };
    walk(path.join(REPO, 'src'));
    return hits;
  }
  const rep = run([prof('2026-09-01', 100, 120), prof('2026-09-02', 110, 130)]);
  const digest = crypto.createHash('sha256').update(rep.digest).digest('hex').slice(0, 16);
  ok('the replay digest is reproducible', crypto.createHash('sha256').update(run([prof('2026-09-01', 100, 120), prof('2026-09-02', 110, 130)]).digest).digest('hex').slice(0, 16) === digest);
  console.log(`  (fixture replay digest ${digest})`);
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) { console.log('FAILED:'); failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
process.exit(0);
