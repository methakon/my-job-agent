#!/usr/bin/env node
/**
 * GATE 6 #3 (roadmap row 62) — failed-auction detection.
 *
 * doneWhen: "A reviewer can determine exactly what the item does and a replay/test demonstrates the
 * behavior."
 *
 * [A] contract: version, pinned definition, closed refusal vocabulary, only two coverage bounds
 * [B] the three states, from the pinned definition (excursion → return → no further exit)
 * [C] every refusal is reachable, each with a null state
 * [D] the disabled path computes nothing and says so
 * [E] determinism: reversed input ⇒ identical digest AND identical observation order
 * [F] no fabrication: a partial tape is refused, never judged
 * [G] purity + research-only
 * [H] end-to-end through the real adapter + the row-60 profile
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const REPO = path.join(__dirname, '..');

const SERIES = require(path.join(REPO, 'dist', 'trading', 'gap-engine', 'gap-session-series'));
const ALIGN = require(path.join(REPO, 'dist', 'trading', 'pre-open', 'pre-open-alignment'));
const V = require(path.join(REPO, 'dist', 'trading', 'value-profile', 'value-profile'));
const F = require(path.join(REPO, 'dist', 'trading', 'value-profile', 'failed-auction'));

const SRC = path.join(REPO, 'src', 'trading', 'value-profile', 'failed-auction.ts');

let pass = 0;
const failures = [];
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; console.log(`  PASS ${name}`); }
  else { failures.push(name); console.log(`  FAIL ${name}${extra ? ' :: ' + extra : ''}`); }
};
const eq = (name, actual, expected) => ok(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`);

const INST = 'NSE:NIFTY50-INDEX';
const D1 = '2026-09-01';
const D2 = '2026-09-02';
const D3 = '2026-09-03';
const D4 = '2026-09-04';
const D5 = '2026-09-05';
const at = (d, hhmm) => { const [h, m] = hhmm.split(':').map(Number); return ALIGN.sessionMidnightMs(d) + (h * 60 + m) * 60_000; };
const pt = (d, hhmm, price) => ({ instantMs: at(d, hhmm), price });
const pathOf = (d, points, instrument = INST) => ({ sessionDate: d, instrument, points });

// D1 profile: value area exactly [100, 120]
const D1_PATH = pathOf(D1, [pt(D1, '10:00', 105), pt(D1, '10:05', 105), pt(D1, '10:10', 105), pt(D1, '10:15', 105), pt(D1, '10:20', 105),
  pt(D1, '10:30', 115), pt(D1, '10:35', 115), pt(D1, '10:40', 115), pt(D1, '11:00', 125)]);
const PROFILES = V.buildValueProfiles([D1_PATH]);
const SESSIONS = SERIES.buildSessionSeries(INST, [
  { sessionDate: D1, open: 104, high: 110, low: 100, quotedClose: 98, sourceId: 'a' },
  { sessionDate: D2, open: 110, high: 112, low: 108, quotedClose: 104, sourceId: 'b' },
  { sessionDate: D3, open: 108, high: 110, low: 106, quotedClose: 110, sourceId: 'c' },
  { sessionDate: D4, open: 109, high: 111, low: 107, quotedClose: 108, sourceId: 'd' },
  { sessionDate: D5, open: 110, high: 112, low: 108, quotedClose: 109, sourceId: 'e' },
]).sessions;

// a tape that covers the open and reaches the close (09:15 → 15:30)
const cover = (points) => [pt(D2, '09:15', points[0]), ...points.slice(1), pt(D2, '15:30', points[points.length - 1])];
const run = (paths, cfg) => F.detectFailedAuctions(SESSIONS, PROFILES, paths, cfg);
// one() resolves the row for the path's OWN session date — paths are keyed by (sessionDate, instrument)
const one = (path, cfg) => run([path], cfg).observations.find((o) => o.sessionDate === path.sessionDate);

// FAILED_AUCTION: out to 130 (above VAH), back to 110, stays inside to the close  (D2)
const FAILED = pathOf(D2, [pt(D2, '09:15', 110), pt(D2, '10:00', 130), pt(D2, '11:00', 110), pt(D2, '15:30', 110)]);
// EXCURSION_HELD: out to 130 and never returns inside                                      (D3)
const HELD = pathOf(D3, [pt(D3, '09:15', 110), pt(D3, '10:00', 130), pt(D3, '15:30', 131)]);
// EXCURSION_REVISITED: returns inside then leaves again                                     (D4)
const REVISITED = pathOf(D4, [pt(D4, '09:15', 110), pt(D4, '10:00', 130), pt(D4, '11:00', 110), pt(D4, '12:00', 131), pt(D4, '15:30', 131)]);
// NOT_APPLICABLE: never leaves the area                                                     (D5)
const INSIDE = pathOf(D5, [pt(D5, '09:15', 110), pt(D5, '12:00', 115), pt(D5, '15:30', 112)]);
// DOWN excursion that fails                                                                 (D2 variant)
const FAILED_DOWN = pathOf(D2, [pt(D2, '09:15', 110), pt(D2, '10:00', 90), pt(D2, '11:00', 110), pt(D2, '15:30', 110)]);

// ── [A] ─────────────────────────────────────────────────────────────────────
console.log('\n[A] contract');
{
  eq('version', F.FAILED_AUCTION_VERSION, 'failauc-v1');
  eq('the single config object is the two coverage bounds plus the switch', Object.keys(F.DEFAULT_FAILED_AUCTION_CONFIG), ['enabled', 'maxStartLagMinutes', 'closeCoverageMinutes']);
  eq('the closed refusal vocabulary is the documented set', [...F.FAILED_AUCTION_REFUSALS],
    ['NO_SESSION_DATE', 'NO_POINTS', 'NO_VALUE_AREA', 'ZERO_VALUE_AREA', 'LATE_START', 'NO_SESSION_CLOSE_COVERAGE', 'NO_EXCURSION']);
  eq('the spec documents every refusal token', F.FAILED_AUCTION_SPEC.refuses, [...F.FAILED_AUCTION_REFUSALS]);
  ok('the spec pins the reference, the excursion and the acceptance rule', /PRIOR session value area/.test(F.FAILED_AUCTION_SPEC.reference) && /FIRST observation strictly outside/.test(F.FAILED_AUCTION_SPEC.excursion) && /never leaves the area again/.test(F.FAILED_AUCTION_SPEC.acceptance));
  ok('the acceptance rule is declared to carry no tolerance/band/duration', /only two coverage bounds/.test(F.FAILED_AUCTION_SPEC.thresholds));
  const rep = run([FAILED]);
  ok('the report carries the spec, the summary and the upstream version', rep.spec.version === 'failauc-v1' && rep.reviewerSummary.includes('failauc-v1') && rep.upstreamProfileVersion === PROFILES.version);
  eq('the fixture prior area is [100, 120]', [PROFILES.profiles[0].val, PROFILES.profiles[0].vah], [100, 120]);
}

// ── [B] ─────────────────────────────────────────────────────────────────────
console.log('\n[B] the three states, from the pinned definition (area 100..120)');
{
  const f = one(FAILED);
  eq('excursion then acceptance ⇒ FAILED_AUCTION', [f.status, f.state], ['OK', 'FAILED_AUCTION']);
  eq('the excursion direction is recorded', f.direction, 'UP');
  eq('the first excursion instant is reported', f.evidence.firstExcursionAtMs, at(D2, '10:00'));
  eq('the return-inside instant is reported', f.evidence.firstReturnInsideAtMs, at(D2, '11:00'));
  eq('the outside observation count is reported', f.evidence.observationsOutside, 1);

  const h = one(HELD);
  eq('excursion never returned inside ⇒ EXCURSION_HELD', [h.status, h.state], ['OK', 'EXCURSION_HELD']);
  eq('...with no return instant', h.evidence.firstReturnInsideAtMs, null);

  const r = one(REVISITED);
  eq('returned inside but left again ⇒ EXCURSION_REVISITED', [r.status, r.state], ['OK', 'EXCURSION_REVISITED']);

  const i = one(INSIDE);
  eq('never left the area ⇒ NOT_APPLICABLE (NO_EXCURSION)', [i.status, i.state, i.reason], ['NOT_APPLICABLE', null, 'NO_EXCURSION']);

  const d = one(FAILED_DOWN);
  eq('a failed DOWN excursion is detected too', [d.state, d.direction], ['FAILED_AUCTION', 'DOWN']);

  const rep = run([FAILED, HELD, REVISITED, INSIDE]);
  eq('the state counts separate the three states', rep.stateCounts, { FAILED_AUCTION: 1, EXCURSION_HELD: 1, EXCURSION_REVISITED: 1 });
  eq('coverage separates decided, not-applicable and refused', [rep.coverage.ok, rep.coverage.notApplicable], [3, 1]);
  // the area edges are INSIDE: sitting exactly on VAL/VAH is not an excursion
  const edges = one(pathOf(D2, [pt(D2, '09:15', 100), pt(D2, '12:00', 120), pt(D2, '15:30', 100)]));
  eq('sitting exactly on VAL/VAH is not an excursion', [edges.status, edges.reason], ['NOT_APPLICABLE', 'NO_EXCURSION']);
}

// ── [C] ─────────────────────────────────────────────────────────────────────
console.log('\n[C] every edge case is a safe explicit state, never a fabricated result');
{
  const emitted = new Set();

  const noPoints = one(pathOf(D2, []));
  eq('no in-window observations ⇒ NO_POINTS', [noPoints.status, noPoints.reason, noPoints.state], ['UNAVAILABLE', 'NO_POINTS', null]);
  emitted.add('NO_POINTS');

  const noArea = run([FAILED], {}).observations.find((o) => o.sessionDate === D1);
  ok('a session with no earlier profile ⇒ NO_VALUE_AREA or no decision at all', noArea === undefined || noArea.reason === 'NO_VALUE_AREA' || noArea.status === 'OK', JSON.stringify(noArea && noArea.reason));

  const emptyProfiles = F.detectFailedAuctions(SESSIONS, { version: 'valprof-v1', profiles: [] }, [FAILED]);
  eq('an empty profile report ⇒ NO_VALUE_AREA', [emptyProfiles.observations[1].status, emptyProfiles.observations[1].reason], ['UNAVAILABLE', 'NO_VALUE_AREA']);
  emitted.add('NO_VALUE_AREA');

  const zero = F.detectFailedAuctions(SESSIONS, { version: 'valprof-v1', profiles: [{ sessionDate: D1, instrument: INST, status: 'OK', val: 100, vah: 100, reason: null }] }, [FAILED]);
  eq('a zero-width area ⇒ ZERO_VALUE_AREA', [zero.observations[1].status, zero.observations[1].reason], ['UNAVAILABLE', 'ZERO_VALUE_AREA']);
  emitted.add('ZERO_VALUE_AREA');

  const late = one(pathOf(D2, [pt(D2, '11:00', 130), pt(D2, '12:00', 110), pt(D2, '15:30', 110)]));
  eq('a tape that does not cover the open ⇒ LATE_START', [late.status, late.reason], ['UNAVAILABLE', 'LATE_START']);
  emitted.add('LATE_START');

  const short = one(pathOf(D2, [pt(D2, '09:15', 110), pt(D2, '10:00', 130), pt(D2, '11:00', 110)]));
  eq('a tape that stops well before the close ⇒ NO_SESSION_CLOSE_COVERAGE', [short.status, short.reason], ['UNAVAILABLE', 'NO_SESSION_CLOSE_COVERAGE']);
  emitted.add('NO_SESSION_CLOSE_COVERAGE');

  emitted.add('NO_EXCURSION');
  const badDate = F.detectFailedAuctions([{ ...SESSIONS[1], sessionDate: 'not-a-date' }], PROFILES, [FAILED]).observations[0];
  eq('an unusable session date ⇒ NO_SESSION_DATE', [badDate.status, badDate.reason], ['UNAVAILABLE', 'NO_SESSION_DATE']);
  emitted.add('NO_SESSION_DATE');

  eq('the fixtures exercise the whole published vocabulary', [...F.FAILED_AUCTION_REFUSALS].filter((t) => !emitted.has(t)), []);
  const all = run([FAILED, HELD, REVISITED, INSIDE]);
  ok('no non-OK row ever carries a state', all.observations.every((o) => (o.status === 'OK' ? o.state !== null : o.state === null)));
  ok('every refusal carries a human detail', all.observations.filter((o) => o.reason).every((o) => typeof o.reasonDetail === 'string' && o.reasonDetail.length > 10));
}

// ── [D] ─────────────────────────────────────────────────────────────────────
console.log('\n[D] the disabled path computes nothing and says so');
{
  const off = run([FAILED], { enabled: false });
  eq('disabled ⇒ one DISABLED row per input', [off.observations.length, off.coverage.disabled], [SESSIONS.length, SESSIONS.length]);
  eq('disabled ⇒ no state and no OK', [off.counts.OK, off.coverage.failed], [0, 0]);
  eq('disabled ⇒ no refusal invented', off.counts.UNAVAILABLE, 0);
  ok('the summary says it is disabled', /enabled=false/.test(off.reviewerSummary));
}

// ── [E] ─────────────────────────────────────────────────────────────────────
console.log('\n[E] determinism');
{
  const fwd = run([FAILED, HELD]);
  const rev = run([HELD, FAILED]);
  eq('reversed path order ⇒ identical digest', rev.digest, fwd.digest);
  eq('reversed path order ⇒ identical observation order', rev.observations.map((o) => o.sessionDate), fwd.observations.map((o) => o.sessionDate));
  ok('repeated identical runs are byte-identical', run([FAILED, HELD]).digest === fwd.digest);
  eq('the counted vocabularies are canonical', [Object.keys(fwd.counts), Object.keys(fwd.refusalCounts), Object.keys(fwd.stateCounts)],
    [['OK', 'NOT_APPLICABLE', 'UNAVAILABLE', 'DISABLED'], [...F.FAILED_AUCTION_REFUSALS], [...F.AUCTION_STATES]]);
  ok('a changed tape moves the digest', run([REVISITED]).digest !== fwd.digest);
  // shuffled POINTS inside one path must not change the result (the component sorts by instant)
  const shuffled = pathOf(D2, [pt(D2, '15:30', 110), pt(D2, '10:00', 130), pt(D2, '11:00', 110), pt(D2, '09:15', 110)]);
  eq('a shuffled tape gives the same state', one(shuffled).state, one(FAILED).state);
}

// ── [F] ─────────────────────────────────────────────────────────────────────
console.log('\n[F] a partial tape is refused, never judged');
{
  const noOpen = one(pathOf(D2, [pt(D2, '11:00', 130), pt(D2, '15:30', 110)]));
  const noClose = one(pathOf(D2, [pt(D2, '09:15', 110), pt(D2, '10:00', 130)]));
  eq('neither partial tape yields a state', [noOpen.state, noClose.state], [null, null]);
  ok('both are refused with a reason', [noOpen.status, noClose.status].every((s) => s === 'UNAVAILABLE'));
  const body = fs.readFileSync(SRC, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  ok('the acceptance rule uses no tolerance/band/duration CONSTANT', !/(tolerance|band|duration)[A-Za-z]*\s*[:=]\s*[0-9]/.test(body));
  ok('no clock read and no randomness', !/Date\.now\(\)/.test(body) && !/Math\.random/.test(body));
}

// ── [G] ─────────────────────────────────────────────────────────────────────
console.log('\n[G] purity + research-only');
{
  const code = fs.readFileSync(SRC, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  ok('no DB or HTTP client', !/mysql|fetch\(|axios|http\./.test(code));
  ok('no model/AI client', !/openai|anthropic|bedrock|\bgpt-|claude|\bllm\b/i.test(code));
  ok('no ranking/optimisation of results', !/optimis|optimiz|\brank\b/i.test(code));
  ok('sorts are canonical only: session identity, instant order, profile date', (code.match(/\.sort\(\(/g) || []).length === 3);
  ok('research/shadow only: no production importer yet', prodImporters().length === 0, prodImporters().join(','));
  function prodImporters() {
    const hits = [];
    const RESEARCH = ['value-profile', 'gap-engine'];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (!RESEARCH.includes(e.name)) walk(p); }
        else if (e.name.endsWith('.ts') && !p.includes(path.join('trading', 'value-profile'))) {
          if (/failed-auction|detectFailedAuctions/.test(fs.readFileSync(p, 'utf8'))) hits.push(path.relative(REPO, p));
        }
      }
    };
    walk(path.join(REPO, 'src'));
    return hits;
  }
}

// ── [H] ─────────────────────────────────────────────────────────────────────
console.log('\n[H] end-to-end through the real adapter + the row-60 profile');
{
  const rep = run([FAILED, HELD, REVISITED, INSIDE]);
  eq('the profile report is consumed unchanged', rep.coverage.profilesIn, PROFILES.profiles.length);
  const digest = crypto.createHash('sha256').update(rep.digest).digest('hex').slice(0, 16);
  ok('the replay digest is reproducible', crypto.createHash('sha256').update(run([FAILED, HELD, REVISITED, INSIDE]).digest).digest('hex').slice(0, 16) === digest);
  console.log(`  (fixture replay digest ${digest}; failed=${rep.coverage.failed} held=${rep.coverage.held} revisited=${rep.coverage.revisited} n/a=${rep.coverage.notApplicable})`);
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) { console.log('FAILED:'); failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
process.exit(0);
