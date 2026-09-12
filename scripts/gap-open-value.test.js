#!/usr/bin/env node
/**
 * GATE 6 #5 (roadmap row 64) — gap opens above/below value and acceptance / rejection.
 *
 * doneWhen: "A report can reproduce the metric from archived data and shows the sample size/coverage used."
 *
 * [A] contract: version, pinned window/metric, closed refusal vocabulary, sample size in coverage
 * [B] every open location and every outcome, from the pinned precedence
 * [C] insufficient data is a safe explicit state that still reports the sample size
 * [D] the disabled path computes nothing
 * [E] determinism: reversed input ⇒ identical digest AND identical observation order
 * [F] coverage bounds and a refused/zero-width reference area are refused, never interpolated
 * [G] purity + research-only
 */
const fs = require('fs');
const path = require('path');
const REPO = path.join(__dirname, '..');

const M = require(path.join(REPO, 'dist', 'trading', 'value-profile', 'gap-open-value'));
const SRC = path.join(REPO, 'src', 'trading', 'value-profile', 'gap-open-value.ts');

let pass = 0;
const failures = [];
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; console.log(`  PASS ${name}`); }
  else { failures.push(name); console.log(`  FAIL ${name}${extra ? ' :: ' + extra : ''}`); }
};
const eq = (name, actual, expected) => ok(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`);

const INST = 'NSE:NIFTY50-INDEX';
// A session path: entries are [HH:MM IST, price]; instants are built with an explicit +05:30 offset.
const day = (sessionDate, entries, instrument = INST) => ({
  sessionDate, instrument,
  points: entries.map(([hhmm, price]) => ({ instantMs: Date.parse(`${sessionDate}T${hhmm}:00+05:30`), price })),
});
const bar = (sessionDate, instrument = INST) => ({ sessionDate, instrument });
const prof = (sessionDate, val, vah, instrument = INST) => ({ sessionDate, instrument, status: 'OK', val, vah });
const report = (profiles) => ({ version: 'valprof-v1', profiles });

// A full, judgeable tape: opens at 09:15, closes at 15:30, with optional mid-session [HH:MM, price] entries.
const tape = (sessionDate, open, mid = [], close) => day(sessionDate, [
  ['09:15', open],
  ...mid,
  ['15:30', close],
]);
const run = (sessions, profiles, paths, cfg) => M.buildGapOpenValue(sessions, profiles ? report(profiles) : undefined, paths, cfg ?? {});

const PRIOR = prof('2026-09-01', 100, 120);

// ── [A] ─────────────────────────────────────────────────────────────────────
console.log('\n[A] contract');
{
  const rep = run([bar('2026-09-02')], [PRIOR], [tape('2026-09-02', 110, [], 110)]);
  eq('version', rep.version, 'gapval-v1');
  eq('the single config object is the switch plus the two coverage bounds', Object.keys(M.DEFAULT_GAP_OPEN_VALUE_CONFIG), ['enabled', 'maxStartLagMinutes', 'closeCoverageMinutes']);
  eq('the closed refusal vocabulary is the documented set', [...M.GAP_OPEN_REFUSALS], ['NO_SESSION_DATE', 'NO_VALUE_AREA', 'ZERO_VALUE_AREA', 'NO_POINTS', 'LATE_START', 'NO_SESSION_CLOSE_COVERAGE', 'NO_GAP_OPEN']);
  eq('the spec documents every refusal token', M.GAP_OPEN_VALUE_SPEC.refuses, [...M.GAP_OPEN_REFUSALS]);
  eq('the location vocabulary is pinned in precedence order', [...M.GAP_OPEN_LOCATIONS], ['ABOVE_VALUE', 'BELOW_VALUE', 'INSIDE_VALUE']);
  eq('the outcome vocabulary is pinned', [...M.GAP_OPEN_OUTCOMES], ['ACCEPTED', 'REJECTED', 'REVISITED', 'NOT_APPLICABLE']);
  ok('the spec pins the observation window and the metric', /maxStartLagMinutes/.test(M.GAP_OPEN_VALUE_SPEC.window) && /sample size/.test(M.GAP_OPEN_VALUE_SPEC.metric));
  ok('the spec pins the acceptance rule with no tolerance', /no tolerance, band or duration/.test(M.GAP_OPEN_VALUE_SPEC.thresholds));
  eq('the upstream profile version is carried', rep.upstreamProfileVersion, 'valprof-v1');
  eq('the coverage block reports the SAMPLE SIZE', rep.coverage.sampleSize, 0);
  ok('the summary is a readable reviewer string', rep.reviewerSummary.includes('gapval-v1'));
}

// ── [B] ─────────────────────────────────────────────────────────────────────
console.log('\n[B] every open location and every outcome, from the pinned precedence');
{
  const one = (sessionDate, path) => run([bar(sessionDate)], [PRIOR], [path]).observations[0];

  const accepted = one('2026-09-02', tape('2026-09-02', 130, [['12:00', 135]], 128));
  eq('open above VAH ⇒ ABOVE_VALUE', accepted.location, 'ABOVE_VALUE');
  eq('a location that never returns inside ⇒ ACCEPTED', accepted.outcome, 'ACCEPTED');
  eq('the gap size is the distance of the open above the edge', accepted.gapPoints, 10);
  eq('...and there is no return time (nothing returned)', accepted.timeToReturnMs, null);

  const rejected = one('2026-09-02', tape('2026-09-02', 130, [['10:00', 110], ['12:00', 115]], 115));
  eq('open above, returns inside and stays ⇒ REJECTED', [rejected.location, rejected.outcome], ['ABOVE_VALUE', 'REJECTED']);
  ok('the return time is reported descriptively', typeof rejected.timeToReturnMs === 'number' && rejected.timeToReturnMs > 0);
  eq('...and the first return inside is recorded in evidence', rejected.evidence.firstReturnInsideAtMs !== null, true);

  const revisited = one('2026-09-02', tape('2026-09-02', 130, [['10:00', 110], ['12:00', 125], ['14:00', 115]], 115));
  eq('open above, returns inside then leaves again ⇒ REVISITED', [revisited.location, revisited.outcome], ['ABOVE_VALUE', 'REVISITED']);

  const belowAccepted = one('2026-09-02', tape('2026-09-02', 90, [['12:00', 92]], 92));
  eq('open below VAL ⇒ BELOW_VALUE', belowAccepted.location, 'BELOW_VALUE');
  eq('a location that never returns inside ⇒ ACCEPTED', belowAccepted.outcome, 'ACCEPTED');
  eq('the gap size is the distance below the edge', belowAccepted.gapPoints, 10);

  const belowRejected = one('2026-09-02', tape('2026-09-02', 90, [['10:00', 105], ['12:00', 110]], 110));
  eq('open below, returns inside and stays ⇒ REJECTED', [belowRejected.location, belowRejected.outcome], ['BELOW_VALUE', 'REJECTED']);

  const inside = one('2026-09-02', tape('2026-09-02', 110, [], 115));
  eq('an open inside the area ⇒ INSIDE_VALUE / NOT_APPLICABLE', [inside.location, inside.outcome, inside.status], ['INSIDE_VALUE', 'NOT_APPLICABLE', 'NOT_APPLICABLE']);
  eq('...and it is refused with NO_GAP_OPEN, never judged', inside.reason, 'NO_GAP_OPEN');

  const onEdge = one('2026-09-02', tape('2026-09-02', 120, [], 118));
  eq('an open exactly on VAH counts as INSIDE (pinned, no band)', [onEdge.location, onEdge.reason], ['INSIDE_VALUE', 'NO_GAP_OPEN']);

  // the metric: outcome counts per location, over a synthetic batch
  const batch = run(
    [bar('2026-09-02'), bar('2026-09-03'), bar('2026-09-04'), bar('2026-09-05')],
    [PRIOR],
    [
      tape('2026-09-02', 130, [['12:00', 135]], 128),          // ABOVE accepted
      tape('2026-09-03', 130, [['10:00', 110], ['12:00', 115]], 115), // ABOVE rejected
      tape('2026-09-04', 90, [['12:00', 92]], 92),             // BELOW accepted
      tape('2026-09-05', 90, [['10:00', 105], ['12:00', 110]], 110),  // BELOW rejected
    ],
  );
  eq('the location/outcome metric counts each judged gap open exactly once', batch.locationOutcomeCounts, {
    ABOVE_VALUE: { ACCEPTED: 1, REJECTED: 1, REVISITED: 0 },
    BELOW_VALUE: { ACCEPTED: 1, REJECTED: 1, REVISITED: 0 },
  });
  eq('the sample size is the number of judged gap opens', batch.coverage.sampleSize, 4);
  eq('the location counts add up to the sessions judged', [batch.coverage.aboveValue, batch.coverage.belowValue, batch.coverage.insideValue], [2, 2, 0]);
  eq('the outcome counts add up to the sample size', Object.values(batch.outcomeCounts).reduce((a, b) => a + b, 0), 4);
  ok('the location/outcome metric sums to the sample size', Object.values(batch.locationOutcomeCounts).reduce((a, o) => a + o.ACCEPTED + o.REJECTED + o.REVISITED, 0) === batch.coverage.sampleSize);
}

// ── [C] ─────────────────────────────────────────────────────────────────────
console.log('\n[C] insufficient data is explicit AND still reports the sample size');
{
  const none = run([], [], []);
  eq('no sessions ⇒ nothing judged and the sample size is 0', [none.coverage.sampleSize, none.counts.OK, none.counts.UNAVAILABLE], [0, 0, 0]);
  const noArea = run([bar('2026-09-02')], [], [tape('2026-09-02', 130, [], 128)]).observations[0];
  eq('no earlier profile ⇒ NO_VALUE_AREA', [noArea.reason, noArea.location], ['NO_VALUE_AREA', null]);
  const refusedPrior = run([bar('2026-09-02')], [{ sessionDate: '2026-09-01', instrument: INST, status: 'UNAVAILABLE', val: null, vah: null }], [tape('2026-09-02', 130, [], 128)]);
  eq('a refused prior profile is unusable ⇒ NO_VALUE_AREA', refusedPrior.observations[0].reason, 'NO_VALUE_AREA');
  eq('...and the sample size is still reported as 0 with the counts behind it', [refusedPrior.coverage.sampleSize, refusedPrior.coverage.unavailable], [0, 1]);
  const zeroWidth = run([bar('2026-09-02')], [prof('2026-09-01', 110, 110)], [tape('2026-09-02', 130, [], 128)]).observations[0];
  eq('a zero-width reference area ⇒ ZERO_VALUE_AREA', zeroWidth.reason, 'ZERO_VALUE_AREA');
  const noPoints = run([bar('2026-09-02')], [PRIOR], [day('2026-09-02', [])]).observations[0];
  eq('an empty path ⇒ NO_POINTS', noPoints.reason, 'NO_POINTS');
  ok('a refusal is counted in its own vocabulary bucket', run([], [], []).refusalCounts.NO_VALUE_AREA === 0);
  const bad = run([bar('2026-09-02')], [PRIOR], [day('2026-09-02', [])]);
  eq('the refusal counts are in vocabulary order', Object.keys(bad.refusalCounts), [...M.GAP_OPEN_REFUSALS]);
}

// ── [D] ─────────────────────────────────────────────────────────────────────
console.log('\n[D] the disabled path computes nothing');
{
  const off = run([bar('2026-09-02')], [PRIOR], [tape('2026-09-02', 130, [], 128)], { enabled: false });
  eq('disabled ⇒ DISABLED with no location or outcome', [off.observations[0].status, off.observations[0].location, off.observations[0].outcome], ['DISABLED', null, null]);
  eq('disabled ⇒ nothing judged, sample size 0', [off.coverage.sampleSize, off.counts.OK], [0, 0]);
  eq('disabled ⇒ no location or outcome counted and no refusal invented', [Object.values(off.locationCounts).reduce((a, b) => a + b, 0), Object.values(off.outcomeCounts).reduce((a, b) => a + b, 0), Object.values(off.refusalCounts).reduce((a, b) => a + b, 0)], [0, 0, 0]);
  ok('the summary says it is disabled', /enabled=false/.test(off.reviewerSummary));
}

// ── [E] ─────────────────────────────────────────────────────────────────────
console.log('\n[E] determinism');
{
  const sessions = [bar('2026-09-04'), bar('2026-09-02'), bar('2026-09-03')];
  const paths = [
    tape('2026-09-02', 130, [], 128),
    tape('2026-09-03', 90, [], 92),
    tape('2026-09-04', 110, [], 115),
  ];
  const profiles = [PRIOR, prof('2026-09-02', 105, 125), prof('2026-09-03', 95, 115)];
  const fwd = run(sessions, profiles, paths);
  const rev = run([...sessions].reverse(), [...profiles].reverse(), [...paths].reverse());
  eq('reversed input ⇒ identical digest', rev.digest, fwd.digest);
  eq('reversed input ⇒ identical observation order', rev.observations.map((o) => `${o.instrument}|${o.sessionDate}`), fwd.observations.map((o) => `${o.instrument}|${o.sessionDate}`));
  ok('repeated identical runs are byte-identical', run(sessions, profiles, paths).digest === fwd.digest);
  eq('the location count map is canonical', Object.keys(fwd.locationCounts), [...M.GAP_OPEN_LOCATIONS]);
  eq('the outcome count map is canonical', Object.keys(fwd.outcomeCounts), [...M.GAP_OPEN_OUTCOMES]);
  ok('a changed open moves the digest', run(sessions, profiles, [tape('2026-09-02', 131, [], 128), ...paths.slice(1)]).digest !== fwd.digest);
}

// ── [F] ─────────────────────────────────────────────────────────────────────
console.log('\n[F] coverage bounds, never interpolated');
{
  const late = run([bar('2026-09-02')], [PRIOR], [day('2026-09-02', [['10:00', 130], ['15:30', 128]])]).observations[0];
  eq('a tape that starts later than the bound ⇒ LATE_START', late.reason, 'LATE_START');
  const short = run([bar('2026-09-02')], [PRIOR], [day('2026-09-02', [['09:15', 130], ['14:00', 128]])]).observations[0];
  eq('a tape that ends earlier than the bound ⇒ NO_SESSION_CLOSE_COVERAGE', short.reason, 'NO_SESSION_CLOSE_COVERAGE');
  const gappy = run([bar('2026-09-03')], [PRIOR, prof('2026-09-02', 130, 140)], [tape('2026-09-03', 130, [], 128)]).observations[0];
  eq('the reference is the PRIOR profiled session, matched by date', [gappy.evidence.priorSessionDate, gappy.evidence.val, gappy.evidence.vah], ['2026-09-02', 130, 140]);
  eq('...so a prior area above the open makes it INSIDE', [gappy.location, gappy.reason], ['INSIDE_VALUE', 'NO_GAP_OPEN']);
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
  ok('no tolerance band invented', !/\b(tolerance|band|duration)\b\s*[:=]\s*[0-9]/.test(code));
  ok('research/shadow only: no production importer yet', prodImporters().length === 0, prodImporters().join(','));
  function prodImporters() {
    const hits = [];
    const RESEARCH = ['value-profile', 'gap-engine'];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (!RESEARCH.includes(e.name)) walk(p); }
        else if (e.name.endsWith('.ts') && !p.includes(path.join('trading', 'value-profile'))) {
          if (/gap-open-value|buildGapOpenValue/.test(fs.readFileSync(p, 'utf8'))) hits.push(path.relative(REPO, p));
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
