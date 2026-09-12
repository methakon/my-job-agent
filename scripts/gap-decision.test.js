#!/usr/bin/env node
/**
 * GATE 4 #11 (roadmap row 48) — return FADE, FOLLOW or NO TRADE.
 *
 * doneWhen: "A reviewer can determine exactly what the item does and a replay/test demonstrates the behavior."
 *
 * [A] contract: version, pinned precedence, closed refusal vocabulary, upstream versions carried
 * [B] every decision and every refusal, from the documented precedence
 * [C] partial evidence never yields a decision (no fabrication)
 * [D] the disabled path decides nothing
 * [E] determinism: input order irrelevant; canonical order; digest is a function of the data
 * [F] the trade direction implied by each side, and the exact state confirmation
 * [G] purity + research-only
 */
const fs = require('fs');
const path = require('path');
const REPO = path.join(__dirname, '..');

const M = require(path.join(REPO, 'dist', 'trading', 'gap-engine', 'gap-decision'));
const SRC = path.join(REPO, 'src', 'trading', 'gap-engine', 'gap-decision.ts');

let pass = 0;
const failures = [];
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; console.log(`  PASS ${name}`); }
  else { failures.push(name); console.log(`  FAIL ${name}${extra ? ' :: ' + extra : ''}`); }
};
const eq = (name, actual, expected) => ok(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`);

const INST = 'NSE:NIFTY50-INDEX';
const sc = (sessionDate, score, over = {}) => ({ sessionDate, instrument: INST, status: 'OK', reason: null, reasonDetail: null, direction: 'UP', score, maxScore: 4, components: { c: true }, evidence: {}, ...over });
const acc = (sessionDate, state, over = {}) => ({ sessionDate, instrument: INST, status: 'OK', state, reason: null, reasonDetail: null, direction: 'UP', originLevel: null, evidence: {}, ...over });
const ev = (sessionDate, netEvPoints, over = {}) => ({ sessionDate, instrument: INST, status: 'OK', reason: null, direction: 'LONG', ev: { grossEvPoints: netEvPoints, netEvPoints, expectancyPerUnitRisk: 0, breakEvenProbability: 0.5 }, ...over });
const scores = (fade, follow) => ({ version: 'gapscore-v1', fade: { observations: fade }, follow: { observations: follow } });
const accRep = (observations) => ({ version: 'gapacc-v1', observations });
const evRep = (plans) => ({ version: 'gapev-v1', plans });

const build = (fade, follow = [], acceptance = [], evRows = [], cfg) => M.decideGapSessions({ scores: scores(fade, follow), acceptance: accRep(acceptance), ev: evRows.length ? evRep(evRows) : null }, cfg);
// one session, both score rows, an acceptance state; the common case
const one = (fadeScore, followScore, state, over = {}) => build(
  [sc('2026-09-02', fadeScore, { direction: over.dir ?? 'UP' })],
  [sc('2026-09-02', followScore, { direction: over.dir ?? 'UP' })],
  [acc('2026-09-02', state, { direction: over.dir ?? 'UP' })],
  over.evRows ?? [],
  over.cfg,
).decisions[0];

// ── [A] ─────────────────────────────────────────────────────────────────────
console.log('\n[A] contract');
{
  const rep = one(3, 1, 'REJECTED');
  eq('version is gapdec-v1', M.GAP_DECISION_VERSION, 'gapdec-v1');
  eq('the config is the switch plus the EV-required policy', Object.keys(M.DEFAULT_GAP_DECISION_CONFIG), ['enabled', 'requireEv']);
  eq('the closed refusal vocabulary is the documented set', [...M.GAP_DECISION_REFUSALS], ['SCORES_UNAVAILABLE', 'NO_GAP', 'SCORE_TIE', 'NO_CONFIRMATION', 'CONFIRMATION_CONFLICT', 'EV_REQUIRED', 'EV_UNAVAILABLE', 'NON_POSITIVE_EV']);
  eq('the spec documents every refusal token', M.GAP_DECISION_SPEC.refuses, [...M.GAP_DECISION_REFUSALS]);
  eq('the outcome vocabulary is pinned', [...M.GAP_DECISION_OUTCOMES], ['FADE', 'FOLLOW', 'NO_TRADE']);
  eq('the side vocabulary is pinned', [...M.GAP_DECISION_SIDES], ['FADE', 'FOLLOW']);
  ok('the spec defines input/transformation/output/timestampBoundary/failureBehaviour', ['inputs', 'transformation', 'output', 'timestampBoundary', 'failureBehavior'].every((k) => typeof M.GAP_DECISION_SPEC[k] === 'string' && M.GAP_DECISION_SPEC[k].length > 0));
  ok('the failure behaviour is fail-closed', /NO_TRADE/.test(M.GAP_DECISION_SPEC.failureBehavior) && /never a guessed side|no decision is fabricated/.test(M.GAP_DECISION_SPEC.missingData));
  const rep2 = build([sc('2026-09-02', 3)], [sc('2026-09-02', 1)], [acc('2026-09-02', 'REJECTED')]);
  eq('upstream versions are carried', rep2.upstream, { scoresVersion: 'gapscore-v1', acceptanceVersion: 'gapacc-v1', evVersion: null });
}

// ── [B] ─────────────────────────────────────────────────────────────────────
console.log('\n[B] every decision and every refusal');
{
  const fade = one(3, 1, 'REJECTED');
  eq('the higher score with the matching state ⇒ that side', [fade.decision, fade.side, fade.status], ['FADE', 'FADE', 'OK']);
  eq('...and the winner carries its score/max', [fade.winner.score, fade.winner.maxScore], [3, 4]);
  const follow = one(1, 3, 'ACCEPTED');
  eq('the mirror case ⇒ FOLLOW', [follow.decision, follow.side], ['FOLLOW', 'FOLLOW']);

  eq('a tie ⇒ NO_TRADE / SCORE_TIE', [one(2, 2, 'ACCEPTED').decision, one(2, 2, 'ACCEPTED').reason], ['NO_TRADE', 'SCORE_TIE']);
  const conflict = one(3, 1, 'ACCEPTED');
  eq('the stronger side contradicted by the state ⇒ CONFIRMATION_CONFLICT', [conflict.decision, conflict.reason], ['NO_TRADE', 'CONFIRMATION_CONFLICT']);
  const noState = build([sc('2026-09-02', 3)], [sc('2026-09-02', 1)], []).decisions[0];
  eq('no acceptance row ⇒ NO_CONFIRMATION', [noState.decision, noState.reason], ['NO_TRADE', 'NO_CONFIRMATION']);
  const noGap = build([sc('2026-09-02', 3, { status: 'NOT_APPLICABLE', reason: 'NO_GAP', score: null })], [sc('2026-09-02', 3, { status: 'NOT_APPLICABLE', reason: 'NO_GAP', score: null })], [acc('2026-09-02', 'REJECTED')]).decisions[0];
  eq('no material gap ⇒ NO_GAP', [noGap.decision, noGap.reason], ['NO_TRADE', 'NO_GAP']);
  const missing = build([sc('2026-09-02', 3)], [], [acc('2026-09-02', 'REJECTED')]).decisions[0];
  eq('a missing score row ⇒ SCORES_UNAVAILABLE', [missing.decision, missing.reason], ['NO_TRADE', 'SCORES_UNAVAILABLE']);
  const badScore = build([sc('2026-09-02', 3, { status: 'UNAVAILABLE', reason: 'TAXONOMY_UNAVAILABLE', score: null })], [sc('2026-09-02', 1)], [acc('2026-09-02', 'REJECTED')]).decisions[0];
  eq('a non-OK score row ⇒ SCORES_UNAVAILABLE', badScore.reason, 'SCORES_UNAVAILABLE');

  // EV gate
  const evPass = build([sc('2026-09-02', 3)], [sc('2026-09-02', 1)], [acc('2026-09-02', 'REJECTED')], [ev('2026-09-02', 5)]).decisions[0];
  eq('a supplied positive-EV row passes and is recorded', [evPass.decision, evPass.evidence.evGate, evPass.evidence.evNetPoints], ['FADE', 'PASSED', 5]);
  const evNeg = build([sc('2026-09-02', 3)], [sc('2026-09-02', 1)], [acc('2026-09-02', 'REJECTED')], [ev('2026-09-02', -1)]).decisions[0];
  eq('a supplied non-positive-EV row ⇒ NON_POSITIVE_EV', [evNeg.decision, evNeg.reason], ['NO_TRADE', 'NON_POSITIVE_EV']);
  const evBad = build([sc('2026-09-02', 3)], [sc('2026-09-02', 1)], [acc('2026-09-02', 'REJECTED')], [ev('2026-09-02', 5, { status: 'UNAVAILABLE', reason: 'NO_FRICTION', ev: null })]).decisions[0];
  eq('a supplied unusable EV row ⇒ EV_UNAVAILABLE', [evBad.decision, evBad.reason], ['NO_TRADE', 'EV_UNAVAILABLE']);
  const evMissingRequired = build([sc('2026-09-02', 3)], [sc('2026-09-02', 1)], [acc('2026-09-02', 'REJECTED')], [], { requireEv: true }).decisions[0];
  eq('requireEv with no EV row ⇒ EV_REQUIRED', [evMissingRequired.decision, evMissingRequired.reason], ['NO_TRADE', 'EV_REQUIRED']);
  const evMissingOptional = build([sc('2026-09-02', 3)], [sc('2026-09-02', 1)], [acc('2026-09-02', 'REJECTED')], [], { requireEv: false }).decisions[0];
  eq('without requireEv an absent EV row is recorded, not silently ignored', [evMissingOptional.decision, evMissingOptional.evidence.evGate], ['FADE', 'NOT_SUPPLIED']);

  const counts = build([sc('2026-09-02', 3), sc('2026-09-03', 2)], [sc('2026-09-02', 1), sc('2026-09-03', 2)], [acc('2026-09-02', 'REJECTED'), acc('2026-09-03', 'ACCEPTED')]);
  eq('the outcome counts add up to the sessions', Object.values(counts.counts).reduce((a, b) => a + b, 0), 2);
  eq('the status counts separate decided from NO_TRADE', [counts.statusCounts.OK, counts.statusCounts.NO_TRADE], [1, 1]);
  eq('the reason count map is in vocabulary order', Object.keys(counts.reasonCounts), [...M.GAP_DECISION_REFUSALS]);
}

// ── [C] ─────────────────────────────────────────────────────────────────────
console.log('\n[C] partial evidence never yields a decision');
{
  const empty = build([], [], []);
  eq('no sessions ⇒ nothing decided', [empty.coverage.sessionsIn, empty.coverage.decided, empty.counts.NO_TRADE], [0, 0, 0]);
  // exhaustive-ish: any of the three required inputs missing must be NO_TRADE
  const variants = [
    build([sc('2026-09-02', 3)], [], [acc('2026-09-02', 'REJECTED')]).decisions[0],
    build([sc('2026-09-02', 3)], [sc('2026-09-02', 1)], []).decisions[0],
  ];
  ok('every partial-evidence variant is NO_TRADE, never a side', variants.every((v) => v.decision === 'NO_TRADE' && v.side === null && v.tradeDirection === null), JSON.stringify(variants.map((v) => v.reason)));
  ok('a NO_TRADE row never carries a winner', variants.every((v) => v.winner === null));
}

// ── [D] ─────────────────────────────────────────────────────────────────────
console.log('\n[D] the disabled path decides nothing');
{
  const off = build([sc('2026-09-02', 3)], [sc('2026-09-02', 1)], [acc('2026-09-02', 'REJECTED')], [], { enabled: false });
  eq('disabled ⇒ NO_TRADE/DISABLED with nothing decided', [off.decisions[0].decision, off.decisions[0].status, off.coverage.decided], ['NO_TRADE', 'DISABLED', 0]);
  eq('disabled ⇒ no refusal invented', Object.values(off.reasonCounts).reduce((a, b) => a + b, 0), 0);
  ok('the summary says it is disabled', /enabled=false/.test(off.reviewerSummary));
}

// ── [E] ─────────────────────────────────────────────────────────────────────
console.log('\n[E] determinism');
{
  const fade = [sc('2026-09-03', 2), sc('2026-09-02', 3)];
  const follow = [sc('2026-09-03', 2), sc('2026-09-02', 1)];
  const acceptance = [acc('2026-09-03', 'ACCEPTED'), acc('2026-09-02', 'REJECTED')];
  const fwd = build(fade, follow, acceptance);
  const rev = build([...fade].reverse(), [...follow].reverse(), [...acceptance].reverse());
  eq('reversed input ⇒ identical digest', rev.digest, fwd.digest);
  eq('reversed input ⇒ identical decision order', rev.decisions.map((d) => `${d.sessionDate}|${d.instrument}`), fwd.decisions.map((d) => `${d.sessionDate}|${d.instrument}`));
  ok('repeated identical runs are byte-identical', build(fade, follow, acceptance).digest === fwd.digest);
  // The digest is over the DECISIONS, not the raw scores: a score change that does not move a decision
  // leaves it unchanged (a property, not a bug), while one that flips a decision must move it.
  ok('a score change that does not alter a decision leaves the digest unchanged', build([sc('2026-09-03', 2), sc('2026-09-02', 4)], follow, acceptance).digest === fwd.digest);
  const flipped = build(fade, [sc('2026-09-03', 2), sc('2026-09-02', 4)], acceptance);
  ok('a score change that flips a decision moves the digest', flipped.digest !== fwd.digest, JSON.stringify(flipped.decisions.map((d) => [d.sessionDate, d.decision, d.reason])));
}

// ── [F] ─────────────────────────────────────────────────────────────────────
console.log('\n[F] the trade direction implied by each side');
{
  eq('gap UP + FOLLOW ⇒ LONG', one(1, 3, 'ACCEPTED', { dir: 'UP' }).tradeDirection, 'LONG');
  eq('gap UP + FADE ⇒ SHORT', one(3, 1, 'REJECTED', { dir: 'UP' }).tradeDirection, 'SHORT');
  eq('gap DOWN + FOLLOW ⇒ SHORT', one(1, 3, 'ACCEPTED', { dir: 'DOWN' }).tradeDirection, 'SHORT');
  eq('gap DOWN + FADE ⇒ LONG', one(3, 1, 'REJECTED', { dir: 'DOWN' }).tradeDirection, 'LONG');
  eq('the confirmation is an EXACT state match (FOLLOW needs ACCEPTED)', one(1, 3, 'REJECTED', { dir: 'UP' }).reason, 'CONFIRMATION_CONFLICT');
  eq('the confirmation is an EXACT state match (FADE needs REJECTED)', one(3, 1, 'ACCEPTED', { dir: 'UP' }).reason, 'CONFIRMATION_CONFLICT');
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
    const RESEARCH = ['gap-engine', 'value-profile'];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (!RESEARCH.includes(e.name)) walk(p); }
        else if (e.name.endsWith('.ts') && !p.includes(path.join('trading', 'gap-engine')) && !p.includes(path.join('trading', 'value-profile'))) {
          if (/gap-decision|decideGapSessions/.test(fs.readFileSync(p, 'utf8'))) hits.push(path.relative(REPO, p));
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
