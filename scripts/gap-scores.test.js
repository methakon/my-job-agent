#!/usr/bin/env node
/**
 * GATE 4 #7 (roadmap row 44) — independent FadeScore and FollowScore.
 *
 * doneWhen: "The component can be enabled/disabled independently and its output can be inspected in
 * a historical replay."
 *
 * [A] contract: version, two independent switches, equal weighting, pinned component lists + whitelist
 * [B] the counts, computed from the pinned definition (never eyeballed)
 * [C] INDEPENDENCE: disabling one side leaves the other byte-identical
 * [D] refusals: NO_GAP / TAXONOMY_UNAVAILABLE / RANGE_POS_UNAVAILABLE / DISABLED, each with a null score
 * [E] determinism: reversed input ⇒ identical digest AND identical observation order
 * [F] NO LOOK-AHEAD: mutating post-open fields cannot move a score
 * [G] purity + research-only + no fitted weight anywhere
 * [H] end-to-end through the real adapter + taxonomy + row 41
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const REPO = path.join(__dirname, '..');

const SERIES = require(path.join(REPO, 'dist', 'trading', 'gap-engine', 'gap-session-series'));
const TAX = require(path.join(REPO, 'dist', 'trading', 'gap-engine', 'gap-taxonomy'));
const RP = require(path.join(REPO, 'dist', 'trading', 'gap-engine', 'gap-range-pos'));
const S = require(path.join(REPO, 'dist', 'trading', 'gap-engine', 'gap-scores'));

const SRC = path.join(REPO, 'src', 'trading', 'gap-engine', 'gap-scores.ts');

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

// r1 prior for r2 (high 110 low 100 → range 10; close = next quote 105 → trend UP since 105 > 100)
// r2 the session of interest: prevClose 105, open 108 → UP gap 3, gapRatio 3/10 = 0.3, GapRangePos (108-100)/10 = 0.8
// r3: prevClose 104, open 106 → UP gap 2, prior r2 range 6 → gapRatio 1/3, GapRangePos (106-106)/6 = 0
// r4 exists so r3 has a derivable close: the taxonomy takes a session's close from the NEXT session's quote.
const RAW = [
  { sessionDate: D1, open: 100, high: 110, low: 100, quotedClose: 98, sourceId: 'r1' },
  { sessionDate: D2, open: 108, high: 112, low: 106, quotedClose: 105, sourceId: 'r2' },
  { sessionDate: D3, open: 106, high: 107, low: 105, quotedClose: 104, sourceId: 'r3' },
  { sessionDate: '2026-09-04', open: 105, high: 106, low: 104, quotedClose: 104, sourceId: 'r4' },
];
const SESSIONS = SERIES.buildSessionSeries(INST, RAW).sessions;
const ASSESS = TAX.assessGapSeries(SESSIONS, {}).assessments;
const RPOS = RP.assessGapRangePosSeries(SESSIONS, {});
const score = (assess = ASSESS, rpos = RPOS, cfg) => S.evaluateGapScores(assess, rpos, cfg);
const rowOf = (block, d) => block.observations.find((o) => o.sessionDate === d);

// ── [A] ─────────────────────────────────────────────────────────────────────
console.log('\n[A] contract');
{
  const rep = score();
  eq('version', rep.version, 'gapscore-v1');
  eq('the two sides are named', S.SCORE_SIDES, ['FADE', 'FOLLOW']);
  eq('each side has its own switch object', Object.keys(S.DEFAULT_GAP_SCORES_CONFIG), ['fade', 'follow']);
  eq('the component lists are pinned and equal-length', [S.SCORE_COMPONENTS.FADE, S.SCORE_COMPONENTS.FOLLOW],
    [['f_materialGap', 'f_insideRange', 'f_counterTrend', 'f_withinSize'], ['g_materialGap', 'g_outsideRange', 'g_withTrend', 'g_sizeBreak']]);
  eq('the weighting is declared EQUAL_UNWEIGHTED', S.GAP_SCORES_SPEC.weighting, 'EQUAL_UNWEIGHTED — every component weighs 1; no coefficient and no fitted threshold exists');
  eq('the published pre-open whitelist is exactly the documented set', [...S.SCORE_REQUIRES],
    ['status', 'class', 'direction', 'gapRatio', 'measures.priorRange', 'measures.priorTrendUp']);
  eq('the closed refusal vocabulary is the documented set', [...S.GAP_SCORE_REFUSALS], ['NO_GAP', 'TAXONOMY_UNAVAILABLE', 'RANGE_POS_UNAVAILABLE']);
  ok('the report carries the summary and both blocks', rep.reviewerSummary.includes('gapscore-v1') && rep.fade.side === 'FADE' && rep.follow.side === 'FOLLOW');
  eq('each block reports its maximum', [rep.fade.maxScore, rep.follow.maxScore], [4, 4]);
}

// ── [B] ─────────────────────────────────────────────────────────────────────
console.log('\n[B] the counts, from the pinned definition');
{
  // D2: gapRatio 0.3 (<=1 ✓), GapRangePos 0.8 (inside ✓), prior trend UP and gap UP (counter ✗)
  const fade2 = rowOf(score().fade, D2);
  eq('D2 FADE components', fade2.components, { f_materialGap: true, f_insideRange: true, f_counterTrend: false, f_withinSize: true });
  eq('D2 FADE score = 3', fade2.score, 3);
  const follow2 = rowOf(score().follow, D2);
  eq('D2 FOLLOW components', follow2.components, { g_materialGap: true, g_outsideRange: false, g_withTrend: true, g_sizeBreak: false });
  eq('D2 FOLLOW score = 2', follow2.score, 2);

  // D3: gapRatio 1/3 (<=1 ✓), GapRangePos 0 (inside ✓), prior r2 trend DOWN (104 < 108) and gap UP → counter ✓
  const fade3 = rowOf(score().fade, D3);
  eq('D3 FADE score = 4', fade3.score, 4);
  const follow3 = rowOf(score().follow, D3);
  eq('D3 FOLLOW score = 1', follow3.score, 1);

  const rep = score();
  eq('the distribution counts every OK row exactly once', [rep.fade.distribution.reduce((a, b) => a + b, 0), rep.fade.coverage.ok], [rep.fade.coverage.ok, 2]);
  eq('the distribution is indexed by score 0..max', rep.fade.distribution.length, rep.fade.maxScore + 1);
  ok('the two sides are not complements', JSON.stringify(rep.fade.distribution) !== JSON.stringify(rep.follow.distribution));
}

// ── [C] ─────────────────────────────────────────────────────────────────────
console.log('\n[C] INDEPENDENCE: one switch cannot move the other side');
{
  const both = score();
  const fadeOff = score(ASSESS, RPOS, { fade: { enabled: false } });
  eq('FADE off ⇒ no score, every input counted disabled', [fadeOff.fade.coverage.disabled, fadeOff.fade.coverage.ok], [ASSESS.length, 0]);
  eq('...and FOLLOW is byte-identical', JSON.stringify(fadeOff.follow.observations), JSON.stringify(both.follow.observations));
  const followOff = score(ASSESS, RPOS, { follow: { enabled: false } });
  eq('FOLLOW off ⇒ no score, every input counted disabled', [followOff.follow.coverage.disabled, followOff.follow.coverage.ok], [ASSESS.length, 0]);
  eq('...and FADE is byte-identical', JSON.stringify(followOff.fade.observations), JSON.stringify(both.fade.observations));
  const bothOff = score(ASSESS, RPOS, { fade: { enabled: false }, follow: { enabled: false } });
  eq('both off ⇒ both disabled, nothing computed', [bothOff.fade.coverage.ok, bothOff.follow.coverage.ok], [0, 0]);
  ok('the disabled row states why in words', /disabled/.test(rowOf(fadeOff.fade, D2).reasonDetail ?? ''));
}

// ── [D] ─────────────────────────────────────────────────────────────────────
console.log('\n[D] refusals: a null score, never a fabricated one');
{
  const rep = score();
  const first = rowOf(rep.fade, D1);
  eq('a session the taxonomy cannot assess ⇒ TAXONOMY_UNAVAILABLE', [first.status, first.reason, first.score], ['UNAVAILABLE', 'TAXONOMY_UNAVAILABLE', null]);
  ok('...and the taxonomy reason is propagated verbatim behind the token', /NO_PRIOR_SESSION|NO_SESSION_CLOSE/.test(first.reasonDetail), first.reasonDetail);

  const noRp = score(ASSESS, { ...RPOS, observations: [] });
  const orphan = rowOf(noRp.fade, D2);
  eq('a session with no GapRangePos row ⇒ RANGE_POS_UNAVAILABLE', [orphan.status, orphan.reason, orphan.score], ['UNAVAILABLE', 'RANGE_POS_UNAVAILABLE', null]);

  const noGapSessions = SERIES.buildSessionSeries(INST, [
    { sessionDate: D1, open: 100, high: 110, low: 100, quotedClose: 98, sourceId: 'n1' },
    { sessionDate: D2, open: 105, high: 110, low: 100, quotedClose: 105, sourceId: 'n2' },
    { sessionDate: D3, open: 106, high: 107, low: 105, quotedClose: 104, sourceId: 'n3' },
  ]).sessions;
  const noGap = S.evaluateGapScores(TAX.assessGapSeries(noGapSessions, {}).assessments, RP.assessGapRangePosSeries(noGapSessions, {}));
  const g2 = rowOf(noGap.fade, D2);
  eq('open == prevClose ⇒ NOT_APPLICABLE with NO_GAP', [g2.status, g2.reason, g2.score], ['NOT_APPLICABLE', 'NO_GAP', null]);

  ok('no non-OK row ever carries a score', rep.fade.observations.every((o) => (o.status === 'OK' ? typeof o.score === 'number' : o.score === null)));
  ok('a score is never NaN or Infinity', rep.fade.observations.filter((o) => o.score !== null).every((o) => Number.isFinite(o.score)));
}

// ── [E] ─────────────────────────────────────────────────────────────────────
console.log('\n[E] determinism');
{
  const fwd = score();
  const rev = score([...ASSESS].reverse(), RPOS);
  eq('reversed input ⇒ identical digest', rev.digest, fwd.digest);
  eq('reversed input ⇒ identical observation order', rev.fade.observations.map((o) => `${o.sessionDate}|${o.instrument}`), fwd.fade.observations.map((o) => `${o.sessionDate}|${o.instrument}`));
  ok('repeated identical runs are byte-identical', score().digest === fwd.digest);
}

// ── [F] ─────────────────────────────────────────────────────────────────────
console.log('\n[F] NO LOOK-AHEAD: post-open fields cannot move a score');
{
  const base = rowOf(score().fade, D2);
  const mutated = ASSESS.map((a) => a.sessionDate === D2
    ? { ...a, class: 'EXHAUSTION', fillState: 'UNFILLED', measures: { ...a.measures, close: 999999, high: 999999, low: 0.01 } }
    : a);
  const after = rowOf(score(mutated, RPOS).fade, D2);
  eq('mutating the session close/high/low, fill state and the class VALUE changes nothing', after.components, base.components);
  eq('...and the score is unchanged', after.score, base.score);
  const body = srcCode().split('function scoreOne')[1].split('function buildBlock')[0];
  ok('the computation reads no close/high/low and no outcome field', !/\bclose\b|nextQuotedClose|fillState|measures\.(high|low)/.test(body), body.match(/\bclose\b|nextQuotedClose|fillState|measures\.(high|low)/)?.[0]);
  ok('materiality is read only as NONE-ness', (body.match(/class ===/g) || []).length === 1 && /class === 'NONE'/.test(body));
}

// ── [G] ─────────────────────────────────────────────────────────────────────
console.log('\n[G] purity + research-only + no fitted weight');
{
  const code = srcCode();
  ok('no clock read', !/Date\.now\(\)/.test(code));
  ok('no randomness', !/Math\.random/.test(code));
  ok('no DB or HTTP client', !/mysql|fetch\(|axios|http\./.test(code));
  ok('no model/AI client', !/openai|anthropic|bedrock|\bgpt-|claude|\bllm\b/i.test(code));
  ok('no ranking of one session against another', !/optimis|optimiz|\.sort\([^;]*score/.test(code));
  ok('no weight/coefficient constant exists (equal weighting only)', !/weight\s*[:=]\s*[0-9]|coefficient\s*[:=]\s*[0-9]/i.test(code));
  ok('the only comparator sort is the canonical session order', (code.match(/\.sort\(\(/g) || []).length === 1);
  ok('the sort key uses only pre-open fields', /\$\{a\.gapRatio/.test(code) && !/\$\{a\.(high|low|close)\}/.test(code));
  ok('research/shadow only: no production importer yet', prodImporters().length === 0, prodImporters().join(','));
  function prodImporters() {
    const hits = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== 'gap-engine') walk(p); }
        else if (e.name.endsWith('.ts') && !/\.test\.ts$/.test(e.name) && !p.includes(path.join('trading', 'gap-engine'))) {
          if (/gap-scores|evaluateGapScores/.test(fs.readFileSync(p, 'utf8'))) hits.push(path.relative(REPO, p));
        }
      }
    };
    walk(path.join(REPO, 'src'));
    return hits;
  }
}

// ── [H] ─────────────────────────────────────────────────────────────────────
console.log('\n[H] end-to-end through the real adapter + taxonomy + row 41');
{
  const rep = score();
  eq('both blocks consume the real pipeline', [rep.fade.coverage.inputsIn, rep.follow.coverage.inputsIn], [ASSESS.length, ASSESS.length]);
  eq('the OK count matches the rows both parents could assess', rep.fade.coverage.ok, ASSESS.filter((a) => a.status === 'OK' && a.class !== 'NONE').length);
  const digest = crypto.createHash('sha256').update(rep.digest).digest('hex').slice(0, 16);
  ok('the replay digest is reproducible', crypto.createHash('sha256').update(score().digest).digest('hex').slice(0, 16) === digest);
  console.log(`  (fixture replay digest ${digest}, FADE dist ${JSON.stringify(rep.fade.distribution)}, FOLLOW dist ${JSON.stringify(rep.follow.distribution)})`);
}

function srcCode() {
  const src = fs.readFileSync(SRC, 'utf8');
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) { console.log('FAILED:'); failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
process.exit(0);
