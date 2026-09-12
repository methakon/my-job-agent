#!/usr/bin/env node
/**
 * GATE 4 #6 (roadmap row 43) — early gap ACCEPTANCE / REJECTION state.
 *
 * doneWhen: "The capability can run in research/shadow mode without changing production behavior."
 *
 * [A] contract: version, spec, closed refusal vocabulary, one config object
 * [B] the pinned decision: ACCEPTED / REJECTED, precedence, and the window boundary
 * [C] every refusal is reachable, each with a null state and a closed-vocabulary token
 * [D] research/shadow mode: the switch computes nothing, and nothing in production imports it
 * [E] determinism: reversed/shuffled input ⇒ identical digest AND identical observation order
 * [F] NO LOOK-AHEAD: post-window prices cannot move a verdict
 * [G] purity + no tuning + no production behaviour change
 * [H] end-to-end through the real session-series adapter
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const REPO = path.join(__dirname, '..');

const SERIES = require(path.join(REPO, 'dist', 'trading', 'gap-engine', 'gap-session-series'));
const ALIGN = require(path.join(REPO, 'dist', 'trading', 'pre-open', 'pre-open-alignment'));
const A = require(path.join(REPO, 'dist', 'trading', 'gap-engine', 'gap-acceptance'));

const SRC = path.join(REPO, 'src', 'trading', 'gap-engine', 'gap-acceptance.ts');

let pass = 0;
const failures = [];
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; console.log(`  PASS ${name}`); }
  else { failures.push(name); console.log(`  FAIL ${name}${extra ? ' :: ' + extra : ''}`); }
};
const eq = (name, actual, expected) => ok(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`);

const INST = 'NSE:NIFTY50-INDEX';
const D = '2026-09-02';   // open 108, previous close 107 → UP gap of 1
const D1 = '2026-09-01';
const D3 = '2026-09-03';  // open 111, previous close 108 → UP gap of 3 (path dates never collide)

const at = (d, hhmm) => { const [h, m] = hhmm.split(':').map(Number); return ALIGN.sessionMidnightMs(d) + (h * 60 + m) * 60_000; };
const pt = (d, hhmm, price) => ({ instantMs: at(d, hhmm), price });
const pathOf = (d, points, instrument = INST) => ({ sessionDate: d, instrument, points });

// one bar per session; the adapter owns labelling and bar selection
const RAW = [
  { sessionDate: D1, open: 104, high: 110, low: 100, quotedClose: 103, sourceId: 'r1' },
  { sessionDate: D, open: 108, high: 112, low: 106, quotedClose: 107, sourceId: 'r2' },
  { sessionDate: D3, open: 111, high: 113, low: 109, quotedClose: 108, sourceId: 'r3' },
];
const SESSIONS = SERIES.buildSessionSeries(INST, RAW).sessions;
const run = (paths, cfg) => A.assessGapAcceptance(SESSIONS, paths, cfg);
const rowOf = (rep, d) => rep.observations.find((o) => o.sessionDate === d);

// 09:15 open; the 30-minute early window is [09:15, 09:45)
const ACCEPTED_D = pathOf(D, [pt(D, '09:15', 108), pt(D, '09:20', 108.5), pt(D, '09:30', 109), pt(D, '09:45', 110)]);
const REJECTED_D = pathOf(D, [pt(D, '09:15', 108), pt(D, '09:20', 107)]);
const REJECTED_D3 = pathOf(D3, [pt(D3, '09:15', 111), pt(D3, '09:20', 108)]);
const LATE_D = pathOf(D, [pt(D, '09:25', 108), pt(D, '09:30', 109), pt(D, '09:45', 110)]);
const NO_PATH_D = pathOf(D, []);
const TOO_FEW_D = pathOf(D, [pt(D, '09:16', 108)]);
const NOT_COVERED_D = pathOf(D, [pt(D, '09:15', 108), pt(D, '09:20', 108.5)]);

// ── [A] ─────────────────────────────────────────────────────────────────────
console.log('\n[A] contract');
{
  const rep = run([ACCEPTED_D]);
  eq('version', rep.version, 'gapacc-v1');
  eq('the spec names the feature and pins the origin', [A.GAP_ACCEPTANCE_SPEC.feature, A.GAP_ACCEPTANCE_SPEC.origin], ['EarlyGapAcceptance', 'prevClose — the same origin the taxonomy uses for "filled"']);
  ok('the spec states the precedence and the look-ahead rule', /NOT_APPLICABLE/.test(A.GAP_ACCEPTANCE_SPEC.precedence) && /never change a verdict/.test(A.GAP_ACCEPTANCE_SPEC.lookAhead));
  eq('the closed refusal vocabulary is exactly the documented set', [...A.GAP_ACCEPTANCE_REFUSALS],
    ['NO_SESSION_OPEN', 'NO_PREV_CLOSE', 'NO_GAP', 'NO_PATH', 'LATE_START', 'WINDOW_INCOMPLETE']);
  eq('the spec documents every refusal token', A.GAP_ACCEPTANCE_SPEC.refuses, [...A.GAP_ACCEPTANCE_REFUSALS]);
  eq('the single config object is exactly the documented structural defaults', Object.keys(A.DEFAULT_GAP_ACCEPTANCE_CONFIG), ['enabled', 'earlyWindowMinutes', 'maxStartLagMinutes', 'minObservationsInWindow']);
  eq('the defaults are structural, not fitted', [A.DEFAULT_GAP_ACCEPTANCE_CONFIG.earlyWindowMinutes, A.DEFAULT_GAP_ACCEPTANCE_CONFIG.maxStartLagMinutes, A.DEFAULT_GAP_ACCEPTANCE_CONFIG.minObservationsInWindow], [30, 5, 2]);
  ok('the report carries the spec and a reviewer summary', rep.spec.version === 'gapacc-v1' && rep.reviewerSummary.includes('gapacc-v1'));
  ok('the summary names the states and every refusal', /ACCEPTED/.test(rep.reviewerSummary) && /REJECTED/.test(rep.reviewerSummary) && A.GAP_ACCEPTANCE_REFUSALS.every((t) => rep.reviewerSummary.includes(t)));
}

// ── [B] ─────────────────────────────────────────────────────────────────────
console.log('\n[B] the pinned decision (09:15 open, 30-minute early window)');
{
  const acc = rowOf(run([ACCEPTED_D]), D);
  eq('a gap held through the window is ACCEPTED', [acc.status, acc.state], ['OK', 'ACCEPTED']);
  eq('the direction is the gap direction', acc.direction, 'UP');
  eq('the origin is the previous close', acc.originLevel, 107);
  eq('the window boundary is reported', [acc.evidence.windowFromMs, acc.evidence.windowToMs], [at(D, '09:15'), at(D, '09:45')]);
  eq('coverage to the window end is recorded', acc.evidence.windowCoveredToEnd, true);
  eq('no rejection instant is recorded', acc.evidence.firstRejectionAtMs, null);
  eq('the gap size is reported', acc.evidence.gapAbs, 1);

  const rej = rowOf(run([REJECTED_D]), D);
  eq('a return to the origin is REJECTED', [rej.status, rej.state], ['OK', 'REJECTED']);
  eq('the rejection instant is the first origin touch', rej.evidence.firstRejectionAtMs, at(D, '09:20'));

  const both = run([ACCEPTED_D, REJECTED_D3]);
  eq('two sessions can carry the two different states', both.stateCounts, { ACCEPTED: 1, REJECTED: 1 });
  eq('...and coverage separates them', [both.coverage.accepted, both.coverage.rejected], [1, 1]);

  const downSessions = SERIES.buildSessionSeries(INST, [
    { sessionDate: D1, open: 104, high: 110, low: 100, quotedClose: 108, sourceId: 'd1' },
    { sessionDate: D, open: 106, high: 107, low: 104, quotedClose: 108, sourceId: 'd2' },
  ]).sessions;
  const down = A.assessGapAcceptance(downSessions, [pathOf(D, [pt(D, '09:15', 106), pt(D, '09:20', 108)])]).observations.find((o) => o.sessionDate === D);
  eq('a DOWN gap that returns UP to the origin is REJECTED', [down.direction, down.state], ['DOWN', 'REJECTED']);

  // the deciding window is half-open [09:15, 09:45): an observation exactly at 09:45 covers the end,
  // it cannot decide by reaching the origin there.
  const covered = rowOf(run([pathOf(D, [pt(D, '09:15', 108), pt(D, '09:20', 109), pt(D, '09:45', 110)])]), D);
  eq('an observation at the window end only asserts coverage', covered.state, 'ACCEPTED');
  const originAtEnd = rowOf(run([pathOf(D, [pt(D, '09:15', 108), pt(D, '09:44', 109), pt(D, '09:45', 107)])]), D);
  eq('an origin touch exactly at the window end does not decide', [originAtEnd.status, originAtEnd.state], ['OK', 'ACCEPTED']);
}

// ── [C] ─────────────────────────────────────────────────────────────────────
console.log('\n[C] every edge case is a safe explicit state, never an assumed one');
{
  const emitted = new Set();

  const noGapSessions = SERIES.buildSessionSeries(INST, [
    { sessionDate: D1, open: 104, high: 110, low: 100, quotedClose: 107, sourceId: 'n1' },
    { sessionDate: D, open: 107, high: 108, low: 106, quotedClose: 107, sourceId: 'n2' },
  ]).sessions;
  const noGap = A.assessGapAcceptance(noGapSessions, [ACCEPTED_D]).observations.find((o) => o.sessionDate === D);
  eq('no gap ⇒ NOT_APPLICABLE', [noGap.status, noGap.state, noGap.reason], ['NOT_APPLICABLE', null, 'NO_GAP']);
  emitted.add('NO_GAP');

  const badDate = A.assessGapAcceptance([{ ...rowOf(run([]), D), sessionDate: 'not-a-date' }], [ACCEPTED_D]).observations[0];
  eq('an unusable session date ⇒ NO_SESSION_OPEN', [badDate.status, badDate.reason, badDate.state], ['UNAVAILABLE', 'NO_SESSION_OPEN', null]);
  emitted.add('NO_SESSION_OPEN');

  const noPrev = A.assessGapAcceptance([{ ...rowOf(run([]), D), prevClose: null }], [ACCEPTED_D]).observations[0];
  eq('a missing previous close ⇒ NO_PREV_CLOSE', [noPrev.status, noPrev.reason, noPrev.state], ['UNAVAILABLE', 'NO_PREV_CLOSE', null]);
  emitted.add('NO_PREV_CLOSE');

  const cases = [['NO_PATH', NO_PATH_D], ['LATE_START', LATE_D], ['WINDOW_INCOMPLETE', TOO_FEW_D], ['WINDOW_INCOMPLETE', NOT_COVERED_D]];
  for (const [reason, p] of cases) {
    const rep = run([p]);
    const o = rowOf(rep, D);
    eq(`${reason} (${p.points.length} obs) ⇒ UNAVAILABLE`, o.status, 'UNAVAILABLE');
    eq(`${reason} (${p.points.length} obs) ⇒ token`, o.reason, reason);
    eq(`${reason} (${p.points.length} obs) ⇒ state null, never assumed`, o.state, null);
    ok(`${reason} (${p.points.length} obs) ⇒ a human detail accompanies the token`, typeof o.reasonDetail === 'string' && o.reasonDetail.length > 10, o.reasonDetail);
    eq(`${reason} (${p.points.length} obs) ⇒ counted under its token`, rep.refusalCounts[reason] >= 1, true);
    ok(`${reason} (${p.points.length} obs) ⇒ no OK state invented`, rep.stateCounts.ACCEPTED === 0 && rep.stateCounts.REJECTED === 0);
    emitted.add(reason);
  }

  ok('a partial window that reaches the origin is still decisive', rowOf(run([pathOf(D, [pt(D, '09:15', 108), pt(D, '09:20', 106)])]), D).state === 'REJECTED');
  ok('acceptance is never assumed from a partial window', rowOf(run([NOT_COVERED_D]), D).state === null);
  ok('no non-OK row ever carries a state', run([NO_PATH_D, LATE_D, TOO_FEW_D, NOT_COVERED_D, ACCEPTED_D]).observations.every((o) => (o.status === 'OK' ? o.state !== null : o.state === null)));
  eq('the fixtures exercise the whole published vocabulary', [...A.GAP_ACCEPTANCE_REFUSALS].filter((t) => !emitted.has(t)), []);
}

// ── [D] ─────────────────────────────────────────────────────────────────────
console.log('\n[D] research/shadow: the switch, and no production behaviour change');
{
  const off = run([ACCEPTED_D], { enabled: false });
  eq('disabled ⇒ one DISABLED row per input', [off.observations.length, off.coverage.disabled], [SESSIONS.length, SESSIONS.length]);
  eq('disabled ⇒ no state, no verdict', [off.counts.OK, off.coverage.accepted, off.coverage.rejected], [0, 0, 0]);
  eq('disabled ⇒ no refusal invented', off.counts.UNAVAILABLE, 0);
  ok('the disabled summary says so', /enabled=false/.test(off.reviewerSummary));
  ok('the switch actually changes the result', off.digest !== run([ACCEPTED_D]).digest);

  const code = srcCode();
  ok('the module writes nothing (no repository/DB call)', !/\.save\(|\.insert\(|\.update\(|getRepository|@InjectRepository|createQueryBuilder/.test(code));
  ok('no production importer yet (research/shadow only)', prodImporters().length === 0, prodImporters().join(','));
  function prodImporters() {
    const hits = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== 'gap-engine') walk(p); }
        else if (e.name.endsWith('.ts') && !/\.test\.ts$/.test(e.name) && !p.includes(path.join('trading', 'gap-engine'))) {
          if (/gap-acceptance|assessGapAcceptance/.test(fs.readFileSync(p, 'utf8'))) hits.push(path.relative(REPO, p));
        }
      }
    };
    walk(path.join(REPO, 'src'));
    return hits;
  }
}

// ── [E] ─────────────────────────────────────────────────────────────────────
console.log('\n[E] determinism');
{
  const otherInst = 'NSE:BANKNIFTY-INDEX';
  const other = SERIES.buildSessionSeries(otherInst, [
    { sessionDate: D1, open: 204, high: 210, low: 200, quotedClose: 203, sourceId: 'b1' },
    { sessionDate: D, open: 208, high: 212, low: 206, quotedClose: 207, sourceId: 'b2' },
  ]).sessions;
  const otherPath = pathOf(D, [pt(D, '09:15', 208), pt(D, '09:30', 209), pt(D, '09:45', 210)], otherInst);
  const all = [...SESSIONS, ...other];
  const forward = A.assessGapAcceptance(all, [ACCEPTED_D, otherPath]);
  const reversed = A.assessGapAcceptance([...all].reverse(), [otherPath, ACCEPTED_D]);
  eq('reversed input ⇒ identical digest', reversed.digest, forward.digest);
  eq('reversed input ⇒ identical observation order', reversed.observations.map((o) => `${o.sessionDate}|${o.instrument}`), forward.observations.map((o) => `${o.sessionDate}|${o.instrument}`));
  eq('the status count map is canonical', Object.keys(forward.counts), [...A.GAP_ACCEPTANCE_STATUSES]);
  eq('the refusal count map is in vocabulary order', Object.keys(forward.refusalCounts), [...A.GAP_ACCEPTANCE_REFUSALS]);
  ok('repeated identical runs are byte-identical', A.assessGapAcceptance(all, [ACCEPTED_D, otherPath]).digest === forward.digest);
  ok('a changed path moves the digest', A.assessGapAcceptance(all, [REJECTED_D, otherPath]).digest !== forward.digest);
}

// ── [F] ─────────────────────────────────────────────────────────────────────
console.log('\n[F] NO LOOK-AHEAD: post-window prices cannot move a verdict');
{
  const acc = rowOf(run([ACCEPTED_D]), D);
  const lateCrash = rowOf(run([pathOf(D, [...ACCEPTED_D.points, pt(D, '10:00', 90), pt(D, '14:00', 80)])]), D);
  eq('a post-window collapse cannot change ACCEPTED', [lateCrash.state, lateCrash.evidence.firstRejectionAtMs], [acc.state, null]);
  const lateRally = rowOf(run([pathOf(D, [...ACCEPTED_D.points, pt(D, '11:00', 200)])]), D);
  eq('a post-window rally cannot change ACCEPTED', lateRally.state, 'ACCEPTED');

  const rej = rowOf(run([REJECTED_D]), D);
  const rejLate = rowOf(run([pathOf(D, [...REJECTED_D.points, pt(D, '12:00', 500)])]), D);
  eq('a post-window move cannot un-reject a REJECTED session', [rejLate.state, rejLate.evidence.firstRejectionAtMs], [rej.state, rej.evidence.firstRejectionAtMs]);

  const body = srcCode().split('function assessOne')[1].split('/** The disabled path')[0];
  ok('the decision restricts itself to the early window', /p\.instantMs < windowToMs/.test(body) && /inWindow\.find\(reachedOrigin\)/.test(body));
  ok('a later observation is used only to assert coverage', /windowCoveredToEnd/.test(body) && /some\(\(p\) => p\.instantMs >= windowToMs\)/.test(body));
}

// ── [G] ─────────────────────────────────────────────────────────────────────
console.log('\n[G] purity + no tuning + no production behaviour change');
{
  const code = srcCode();
  ok('no clock read', !/Date\.now\(\)/.test(code));
  ok('no randomness', !/Math\.random/.test(code));
  ok('no DB or HTTP client', !/mysql|fetch\(|axios|http\./.test(code));
  ok('no model/AI client', !/openai|anthropic|bedrock|\bgpt-|claude|\bllm\b/i.test(code));
  ok('no ranking/optimisation of a result', !/rank|optimis|optimiz/i.test(code));
  ok('sorts are canonical only: session identity, or instant order', (code.match(/\.sort\(\(/g) || []).length === 2 && !/\.sort\([^;]*(outcome|winRate|pnl)/.test(code));
  ok('the sort key uses only pre-open fields', /\$\{a\.open\}/.test(code) && /\$\{a\.prevClose\}/.test(code) && !/\$\{a\.(high|low|close)\}/.test(code));
  ok('no threshold is derived from an outcome field', !/winRate|\bpnl\b|profit/i.test(code));
}

// ── [H] ─────────────────────────────────────────────────────────────────────
console.log('\n[H] end-to-end through the real session-series adapter');
{
  const LATE_D1 = pathOf(D1, [pt(D1, '09:25', 104), pt(D1, '09:30', 105), pt(D1, '09:45', 106)]);
  const rep = run([ACCEPTED_D, REJECTED_D3, LATE_D1]);
  eq('the adapter-built series is consumed unchanged', rep.coverage.sessionsIn, SESSIONS.length);
  eq('coverage separates decided from refused', [rep.coverage.accepted, rep.coverage.rejected, rep.coverage.unavailable], [1, 1, 1]);
  eq('a late-starting session is refused, not proxied', rowOf(rep, D1).reason, 'LATE_START');
  eq('the plain-language summary is carried', /\d+ sessions/.test(rep.reviewerSummary) || rep.reviewerSummary.includes('gapacc-v1'), true);
  const digest = crypto.createHash('sha256').update(rep.digest).digest('hex').slice(0, 16);
  ok('the replay digest is reproducible', crypto.createHash('sha256').update(run([ACCEPTED_D, REJECTED_D3, LATE_D1]).digest).digest('hex').slice(0, 16) === digest);
  console.log(`  (fixture replay digest ${digest})`);
}

function srcCode() {
  const src = fs.readFileSync(SRC, 'utf8');
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) { console.log('FAILED:'); failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
process.exit(0);
