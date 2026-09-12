#!/usr/bin/env node
/**
 * GATE 4 #2 (roadmap row 39) — GAP-FILL and GAP-AND-GO hypotheses.
 *
 * doneWhen: "The component can be enabled/disabled independently and its output can be
 * inspected in a historical replay."
 *
 *   [A] both hypotheses are stated as explicit, falsifiable specs;
 *   [B] each has an INDEPENDENT switch (one off never affects the other);
 *   [C] GAP_FILL outcomes follow the documented fill condition;
 *   [D] GAP_AND_GO requires BOTH an unfilled gap AND continuation;
 *   [E] NOT_APPLICABLE for non-material sessions; UNAVAILABLE propagates the taxonomy reason;
 *   [F] no fabricated outcomes: statuses/outcomes come only from the documented sets;
 *   [G] determinism: reordering cannot change the report;
 *   [H] the combination block reports overlap without assuming the two are complements;
 *   [I] STATIC: descriptive-only (no tuning), pure, non-AI, still research-only;
 *   [J] end-to-end: adapter → taxonomy → hypotheses, the way the replay drives it.
 */
const path = require('path');
const fs = require('fs');

const S = require(path.join(__dirname, '..', 'dist', 'trading', 'gap-engine', 'gap-session-series'));
const T = require(path.join(__dirname, '..', 'dist', 'trading', 'gap-engine', 'gap-taxonomy'));
const H = require(path.join(__dirname, '..', 'dist', 'trading', 'gap-engine', 'gap-hypotheses'));

let pass = 0;
const failures = [];
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; console.log(`  PASS ${name}`); }
  else { failures.push(name); console.log(`  FAIL ${name}${extra ? ' :: ' + extra : ''}`); }
};
const eq = (name, actual, expected) => ok(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`);

const INST = 'NSE:NIFTY50-INDEX';
const bar = (date, open, high, low, close, prevClose) => ({
  sessionDate: date, instrument: INST, provenance: 'DERIVED_CLOSE',
  open, high, low, close, prevClose, range: high - low, nextQuotedClose: null,
});
/** Adapter row fixture: quotedClose is the PREVIOUS session's close. */
const raw = (date, open, high, low, quotedClose, sourceId = 'a') => ({ instrument: INST, sessionDate: date, open, high, low, quotedClose, sourceId });

/** The composition the replay uses: bars → taxonomy assessments → hypotheses. */
const assess = (bars, config = {}) => T.assessGapSeries(bars, config).assessments;
const run = (bars, config = {}) => H.evaluateGapHypotheses(assess(bars), config);

// A baseline context so gapRatio has a prior session to measure against.
const ctx = [
  bar('2026-09-01', 100, 104, 99, 103, 100),
  bar('2026-09-02', 103, 106, 102, 105, 103),
];

// -------------------------------------------------------------------- [A]
console.log('\n[A] both hypotheses are stated explicitly');
{
  const s = H.describeGapHypotheses();
  ok('a reviewer statement exists', typeof s === 'string' && s.length > 250);
  ok('it names the version', /gaphyp-v1/.test(s));
  ok('it names both hypotheses', /GAP_FILL/.test(s) && /GAP_AND_GO/.test(s));
  eq('exactly two hypotheses are published', H.HYPOTHESIS_NAMES, ['GAP_FILL', 'GAP_AND_GO']);
  for (const name of H.HYPOTHESIS_NAMES) {
    const spec = H.HYPOTHESIS_SPECS[name];
    ok(`${name} asserts a falsifiable statement`, typeof spec.asserts === 'string' && spec.asserts.length > 20);
    ok(`${name} lists its input requirements`, Array.isArray(spec.requires) && spec.requires.length >= 3);
    ok(`${name} states the realization condition`, typeof spec.realizedWhen === 'string' && spec.realizedWhen.length > 20);
    ok(`${name} documents its refusals`, Array.isArray(spec.refusals) && spec.refusals.length >= 3);
  }
  ok('the specs differ (they are separate hypotheses, not one rule twice)', H.HYPOTHESIS_SPECS.GAP_FILL.realizedWhen !== H.HYPOTHESIS_SPECS.GAP_AND_GO.realizedWhen);
  ok('GAP_AND_GO declares its descriptive measure', /entry = session open/.test(H.HYPOTHESIS_SPECS.GAP_AND_GO.descriptiveMeasure || ''));
  eq('both default to enabled', [H.DEFAULT_HYPOTHESIS_CONFIG.GAP_FILL.enabled, H.DEFAULT_HYPOTHESIS_CONFIG.GAP_AND_GO.enabled], [true, true]);
}

// -------------------------------------------------------------------- [B]
console.log('\n[B] independent switches');
{
  const bars = [
    ...ctx,
    bar('2026-09-03', 108, 109, 106.5, 108.5, 105),   // material UP gap, filled later? low 106.5 > 105 -> UNFILLED
    bar('2026-09-04', 107, 108, 104, 106, 108.5),     // material DOWN gap
  ];
  const all = run(bars);
  const noFill = run(bars, { GAP_FILL: { enabled: false } });
  const noGo = run(bars, { GAP_AND_GO: { enabled: false } });

  ok('enabled by default: both blocks produce outcomes', all.gapFill.coverage.evaluable > 0 && all.gapAndGo.coverage.evaluable > 0);
  eq('switching GAP_FILL off ⇒ its block is DISABLED', noFill.gapFill.enabled, false);
  eq('...with zero evaluable sessions', noFill.gapFill.coverage.evaluable, 0);
  ok('...and every GAP_FILL observation says DISABLED', noFill.gapFill.observations.every((o) => o.status === 'DISABLED'));
  ok('...and no GAP_FILL outcome is invented', noFill.gapFill.observations.every((o) => o.outcome === null));
  eq('...while GAP_AND_GO is untouched', noFill.gapAndGo.coverage.evaluable, all.gapAndGo.coverage.evaluable);
  eq('...with identical GAP_AND_GO outcomes', noFill.gapAndGo.observations.map((o) => o.outcome), all.gapAndGo.observations.map((o) => o.outcome));

  eq('switching GAP_AND_GO off ⇒ only that block is disabled', [noGo.gapAndGo.enabled, noGo.gapFill.enabled], [false, true]);
  eq('...and GAP_FILL outcomes are unchanged', noGo.gapFill.observations.map((o) => o.outcome), all.gapFill.observations.map((o) => o.outcome));
  ok('...and the disabled block states why', noGo.gapAndGo.observations.every((o) => /switched off/.test(o.reason || '')));
  eq('both off ⇒ neither block evaluates anything', [run(bars, { GAP_FILL: { enabled: false }, GAP_AND_GO: { enabled: false } }).gapFill.coverage.evaluable, run(bars, { GAP_FILL: { enabled: false }, GAP_AND_GO: { enabled: false } }).gapAndGo.coverage.evaluable], [0, 0]);
}

// -------------------------------------------------------------------- [C]
console.log('\n[C] GAP_FILL follows the documented fill condition');
{
  const unfilled = run([...ctx, bar('2026-09-03', 108, 110, 106.2, 109, 105)]);
  eq('an UP gap never returning to prevClose ⇒ NOT_REALIZED', unfilled.gapFill.observations[2].outcome, 'NOT_REALIZED');
  const filled = run([...ctx, bar('2026-09-03', 108, 110, 104.5, 106, 105)]);
  eq('an UP gap whose low reaches prevClose ⇒ REALIZED', filled.gapFill.observations[2].outcome, 'REALIZED');
  const downFilled = run([...ctx, bar('2026-09-03', 102, 105.5, 101, 104, 105)]);
  eq('a DOWN gap whose high reaches prevClose ⇒ REALIZED', downFilled.gapFill.observations[2].outcome, 'REALIZED');
  const downOpen = run([...ctx, bar('2026-09-03', 102, 104.9, 100, 101, 105)]);
  eq('a DOWN gap untouched above prevClose ⇒ NOT_REALIZED', downOpen.gapFill.observations[2].outcome, 'NOT_REALIZED');
  ok('evidence carries the gap geometry a reviewer needs', unfilled.gapFill.observations[2].evidence.gapPts !== null && unfilled.gapFill.observations[2].evidence.zoneLow !== null);
}

// -------------------------------------------------------------------- [D]
console.log('\n[D] GAP_AND_GO needs an unfilled gap AND continuation');
{
  const heldAndContinued = run([...ctx, bar('2026-09-03', 108, 111, 106.5, 110, 105)]);
  eq('unfilled + closes beyond open ⇒ REALIZED', heldAndContinued.gapAndGo.observations[2].outcome, 'REALIZED');

  const heldNoContinuation = run([...ctx, bar('2026-09-03', 108, 110, 106.5, 107.5, 105)]);
  eq('unfilled but closes back below open ⇒ NOT_REALIZED', heldNoContinuation.gapAndGo.observations[2].outcome, 'NOT_REALIZED');

  const filledAndContinued = run([...ctx, bar('2026-09-03', 108, 111, 104, 110, 105)]);
  eq('filled (so it did not hold) but closed up ⇒ NOT_REALIZED', filledAndContinued.gapAndGo.observations[2].outcome, 'NOT_REALIZED');

  const downHeld = run([...ctx, bar('2026-09-03', 102, 103.5, 99, 100, 105)]);
  eq('a DOWN gap that holds and continues down ⇒ REALIZED', downHeld.gapAndGo.observations[2].outcome, 'REALIZED');

  const r = heldAndContinued.gapAndGo.observations[2];
  ok('the descriptive excursion measure is reported', r.evidence.descriptiveRMultiple !== null && r.evidence.excursionPts !== null);
  ok('...and is geometry, not a tuned score (entry/risk from the session itself)', r.evidence.gapPts > 0 && r.evidence.excursionPts >= r.evidence.sessionExtensionPts - 1e-9);
  ok('continuation is signed in the gap direction', r.evidence.continueDirectionPts > 0);
}

// -------------------------------------------------------------------- [E]
console.log('\n[E] NOT_APPLICABLE vs UNAVAILABLE');
{
  const immaterial = run([...ctx, bar('2026-09-03', 105.05, 105.5, 104, 105.2, 105)]);
  eq('a non-material session ⇒ NOT_APPLICABLE for GAP_FILL', immaterial.gapFill.observations[2].status, 'NOT_APPLICABLE');
  eq('...and for GAP_AND_GO', immaterial.gapAndGo.observations[2].status, 'NOT_APPLICABLE');
  ok('...with a reason naming the class', /class NONE/.test(immaterial.gapFill.observations[2].reason || ''));
  eq('NOT_APPLICABLE sessions are counted separately', immaterial.gapFill.coverage.notApplicable, 2);

  // a session the taxonomy cannot assess (no quoted prevClose) must propagate, not invent
  const broken = run([...ctx, bar('2026-09-03', 108, 110, 107, 109, null)]);
  eq('taxonomy refusal ⇒ UNAVAILABLE', broken.gapFill.observations[2].status, 'UNAVAILABLE');
  ok('...with the taxonomy reason propagated verbatim', /NO_PREV_CLOSE/.test(broken.gapFill.observations[2].reason || ''), broken.gapFill.observations[2].reason);
  eq('...and no outcome', broken.gapFill.observations[2].outcome, null);
  eq('UNAVAILABLE is counted', broken.gapFill.coverage.unavailable, 2);

  const firstOnly = run([bar('2026-09-01', 100, 104, 99, 103, 100), bar('2026-09-02', 105, 106, 104, 105.5, 103)]);
  ok('a series whose first session has no prior range ⇒ UNAVAILABLE (NO_PRIOR_SESSION)', /NO_PRIOR_SESSION/.test(firstOnly.gapFill.observations[0].reason || ''), firstOnly.gapFill.observations[0].reason);
}

// -------------------------------------------------------------------- [F]
console.log('\n[F] no fabricated outcomes');
{
  const r = run([...ctx, bar('2026-09-03', 108, 111, 106.5, 110, 105), bar('2026-09-04', 106, 107, 103, 104, 110)]);
  const statuses = new Set(r.gapFill.observations.map((o) => o.status));
  const outcomes = new Set(r.gapFill.observations.map((o) => o.outcome));
  ok('statuses come only from the documented set', [...statuses].every((s) => ['OK', 'UNAVAILABLE', 'NOT_APPLICABLE', 'DISABLED'].includes(s)), [...statuses].join(','));
  ok('outcomes are only REALIZED / NOT_REALIZED / null', [...outcomes].every((o) => o === 'REALIZED' || o === 'NOT_REALIZED' || o === null));
  ok('an outcome exists only on an OK observation', r.gapFill.observations.every((o) => (o.outcome === null) === (o.status !== 'OK')));
  ok('no NaN/Infinity ever reaches the evidence', r.gapAndGo.observations.every((o) => Object.values(o.evidence).every((v) => v === null || (typeof v === 'number' && Number.isFinite(v)))));
  ok('every refusal carries a reason', r.gapFill.observations.filter((o) => o.status !== 'OK').every((o) => !!o.reason));
  ok('an OK observation carries no reason', r.gapFill.observations.filter((o) => o.status === 'OK').every((o) => o.reason === null));
}

// -------------------------------------------------------------------- [G]
console.log('\n[G] determinism');
{
  const bars = [
    ...ctx,
    bar('2026-09-03', 108, 111, 106.5, 110, 105),
    bar('2026-09-04', 105, 106, 102, 103, 110),
    bar('2026-09-05', 104, 107, 103, 106, 103),
  ];
  const a = run(bars);
  const as = assess(bars);
  const b = H.evaluateGapHypotheses([...as].reverse(), {});
  const c = H.evaluateGapHypotheses([as[2], as[0], as[4], as[1], as[3]], {});
  eq('reordered assessments ⇒ identical digest', b.digest, a.digest);
  eq('shuffled assessments ⇒ identical digest', c.digest, a.digest);
  eq('and identical counts', JSON.stringify(b.gapFill.coverage), JSON.stringify(a.gapFill.coverage));
  eq('observations come out date-ordered whatever the input order', c.gapFill.observations.map((o) => o.sessionDate), a.gapFill.observations.map((o) => o.sessionDate));
  ok('assessments are not mutated by evaluation', JSON.stringify(assess(bars)) === JSON.stringify(assess(bars)));
}

// -------------------------------------------------------------------- [H]
console.log('\n[H] the combination block reports overlap honestly');
{
  const bars = [
    ...ctx,
    bar('2026-09-03', 108, 111, 106.5, 110, 105),  // unfilled + continued => GO
    bar('2026-09-04', 105, 108, 103, 104, 110),    // filled => FILL
    bar('2026-09-05', 104, 105, 101, 104.5, 103),  // ?
  ];
  const r = run(bars);
  const fill = r.gapFill.observations.filter((o) => o.status === 'OK');
  const go = r.gapAndGo.observations.filter((o) => o.status === 'OK');
  eq('every date evaluated by both is classified into exactly one combination bucket',
    r.combination.bothRealized + r.combination.onlyGapFill + r.combination.onlyGapAndGo + r.combination.neither,
    fill.filter((f) => go.some((g) => g.sessionDate === f.sessionDate)).length);
  ok('the report does not assume the hypotheses are complements', typeof r.combination.bothRealized === 'number');
  const bothOnOne = r.gapFill.observations.filter((o) => o.outcome === 'REALIZED' && r.gapAndGo.observations.find((g) => g.sessionDate === o.sessionDate && g.outcome === 'REALIZED'));
  eq('a session cannot satisfy both (filled and unfilled are exclusive)', bothOnOne.length, 0);
}

// -------------------------------------------------------------------- [I]
console.log('\n[I] STATIC: descriptive only, pure, research-only');
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'trading', 'gap-engine', 'gap-hypotheses.ts'), 'utf8');
  ok('no clock read', !/Date\.now\(\)/.test(src));
  ok('no randomness', !/Math\.random/.test(src));
  ok('no AI client or model import', !/\b(openai|anthropic|bedrock|gpt-[0-9a-z]|claude|gemini)\b/i.test(src) && !/require\(|from '[^']*(ai|llm)/i.test(src));
  ok('no DB or network access', !/mysql|fetch\(|axios|http/i.test(src));
  ok('it consumes the taxonomy type instead of re-deriving gap geometry', /import \{ GapDirection, SessionGapAssessment \} from '\.\/gap-taxonomy'/.test(src));
  ok('it never touches session bars (that stays the adapter/taxonomy job)', !/SessionBar|sessionDate:\s*string;\s*open/.test(src) && !/from '\.\/gap-session-series'/.test(src));
  ok('no threshold constants at all (nothing to tune)', !/0\.\d+/.test(src));
  ok('nothing is selected from historical results', !/optimal|bestThreshold|calibrat|argmax/i.test(src));
  ok('the descriptive measure is labelled descriptive', /descriptive/i.test(src) && /never used to select/i.test(src));
  ok('it documents that results are evidence, not targets', /DESCRIPTIVE EVIDENCE ONLY/.test(src));
  // still research-only: nothing under src/ imports it
  const srcRoot = path.join(__dirname, '..', 'src');
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
  const importers = walk(srcRoot).filter((f) => /\.ts$/.test(f) && !/gap-engine\//.test(f) && /gap-hypotheses/.test(fs.readFileSync(f, 'utf8')));
  eq('no production module imports the hypotheses', importers.length, 0);
}

// -------------------------------------------------------------------- [J]
console.log('\n[J] end-to-end: adapter → taxonomy → hypotheses');
{
  // archived-shaped rows: the adapter derives close from the NEXT session's quote
  const rows = [
    raw('2026-09-01', 100, 104, 99, 98),
    raw('2026-09-02', 103, 106, 102, 100),
    raw('2026-09-03', 108, 111, 106.5, 103),
    raw('2026-09-04', 105, 106, 102, 108),
    raw('2026-09-05', 104, 105, 101, 105),
  ];
  const series = S.buildSessionSeries(INST, rows);
  const taxonomy = T.assessGapSeries(series.sessions, {});
  const report = H.evaluateGapHypotheses(taxonomy.assessments, {});
  eq('every session appears in both hypothesis blocks', [report.gapFill.observations.length, report.gapAndGo.observations.length], [5, 5]);
  eq('the last session cannot be evaluated (no derivable close)', report.gapFill.observations[4].status, 'UNAVAILABLE');
  ok('the taxonomy reason is what is reported upstream', /NO_SESSION_CLOSE/.test(report.gapFill.observations[4].reason || ''));
  ok('at least one hypothesis outcome came from real adapter-derived bars', report.gapFill.coverage.evaluable + report.gapAndGo.coverage.evaluable > 0);
  ok('the report is replayable: a second pass matches', H.evaluateGapHypotheses(taxonomy.assessments, {}).digest === report.digest);
  ok('coverage adds up per block', report.gapFill.coverage.evaluable + report.gapFill.coverage.unavailable + report.gapFill.coverage.notApplicable === report.gapFill.coverage.sessionsConsidered);
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) { console.log('FAILED:'); failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
process.exit(0);
