#!/usr/bin/env node
/**
 * GATE 4 #3 (roadmap row 40) — GAP-FADE and FAILED-ORB candidates.
 *
 * doneWhen: "The component can be enabled/disabled independently and its output can be inspected in
 * a historical replay."
 *
 * [A] two independent switches
 * [B] GAP-FADE: candidate / too-large / non-material / unavailable, with target + invalidation
 * [C] NO LOOK-AHEAD: mutating every post-open field cannot move a GAP-FADE verdict
 * [D] FAILED-ORB: candidate / held / no-breakout / late-start / incomplete / no-path-after
 * [E] no fabricated outcomes: statuses and refusal reasons come only from the published vocabulary
 * [F] purity + research-only + thresholds are structural defaults, not tuned numbers
 * [G] end-to-end through the real adapter + taxonomy
 */
const fs = require('fs');
const path = require('path');
const REPO = path.join(__dirname, '..');

const SERIES = require(path.join(REPO, 'dist', 'trading', 'gap-engine', 'gap-session-series'));
const TAX = require(path.join(REPO, 'dist', 'trading', 'gap-engine', 'gap-taxonomy'));
const C = require(path.join(REPO, 'dist', 'trading', 'gap-engine', 'gap-candidates'));
const ALIGN = require(path.join(REPO, 'dist', 'trading', 'pre-open', 'pre-open-alignment'));

let pass = 0;
const failures = [];
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; console.log(`  PASS ${name}`); }
  else { failures.push(name); console.log(`  FAIL ${name}${extra ? ' :: ' + extra : ''}`); }
};
const eq = (name, actual, expected) => ok(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`);

const bar = (d, open, high, low, close, prevClose) => ({ sessionDate: d, instrument: 'NSE:NIFTY50-INDEX', provenance: 'DERIVED_CLOSE', open, high, low, close, prevClose, range: high - low, nextQuotedClose: close });
const assess = (bars) => TAX.assessGapSeries(bars, {}).assessments;

// a material, bounded up-gap session (gap 1.0 against a prior range of 4.0 -> ratio 0.25)
const CTX = [bar('2026-09-01', 100, 104, 100, 103, 100), bar('2026-09-02', 103, 106, 102, 105, 103)];
const FADE = [...CTX, bar('2026-09-03', 106, 108, 105, 107, 105)];

// ── ORB path fixture helpers ────────────────────────────────────────────────
const OPEN = (d) => ALIGN.sessionMidnightMs(d) + 555 * 60_000; // 09:15 IST
const at = (d, hhmm) => { const [h, m] = hhmm.split(':').map(Number); return ALIGN.sessionMidnightMs(d) + (h * 60 + m) * 60_000; };
const pt = (d, hhmm, price) => ({ instantMs: at(d, hhmm), price });
const pathOf = (d, points, instrument = 'NSE:NIFTY50-INDEX') => ({ sessionDate: d, instrument, points });

const D = '2026-09-08';
const ORB_CANDIDATE = pathOf(D, [pt(D, '09:15', 100), pt(D, '09:20', 102), pt(D, '09:25', 98), pt(D, '09:35', 104), pt(D, '09:40', 101)]);
const ORB_HELD = pathOf(D, [pt(D, '09:15', 100), pt(D, '09:20', 102), pt(D, '09:25', 98), pt(D, '09:35', 104), pt(D, '09:40', 103.5)]);
const ORB_NONE = pathOf(D, [pt(D, '09:15', 100), pt(D, '09:20', 102), pt(D, '09:25', 98), pt(D, '09:35', 101), pt(D, '09:40', 100)]);
const ORB_LATE = pathOf(D, [pt(D, '09:25', 98), pt(D, '09:35', 104), pt(D, '09:40', 101)]);
const ORB_THIN = pathOf(D, [pt(D, '09:15', 100), pt(D, '09:35', 104)]);
const ORB_NO_AFTER = pathOf(D, [pt(D, '09:15', 100), pt(D, '09:20', 102)]);

// ── [A] ─────────────────────────────────────────────────────────────────────
console.log('\n[A] two independent switches');
{
  const on = C.buildGapCandidates({ assessments: assess(FADE), paths: [ORB_CANDIDATE] });
  eq('version', on.version, 'gap-cand-v1');
  eq('both candidates are named', C.CANDIDATE_NAMES, ['GAP_FADE', 'FAILED_ORB']);
  ok('both run when both are enabled', on.gapFade.coverage.evaluated === 1 && on.failedOrb.coverage.evaluated === 1);
  ok('specs describe the contract', /fade/i.test(on.gapFade.spec.asserts) && /breakout/i.test(on.failedOrb.spec.asserts) && on.failedOrb.spec.refuses.length >= 4);
  ok('the reviewer summary states what each candidate is', /GAP_FADE/.test(on.reviewerSummary) && /FAILED_ORB/.test(on.reviewerSummary) && /never tuned/.test(on.reviewerSummary));

  const fadeOff = C.buildGapCandidates({ assessments: assess(FADE), paths: [ORB_CANDIDATE], config: { gapFade: { enabled: false } } });
  eq('GAP_FADE off ⇒ no results, every input counted disabled', [fadeOff.gapFade.results.length, fadeOff.gapFade.coverage.disabled, fadeOff.gapFade.coverage.candidates], [0, 3, 0]);
  ok('...and FAILED_ORB is untouched by that switch', JSON.stringify(fadeOff.failedOrb.results) === JSON.stringify(on.failedOrb.results));

  const orbOff = C.buildGapCandidates({ assessments: assess(FADE), paths: [ORB_CANDIDATE], config: { failedOrb: { enabled: false } } });
  eq('FAILED_ORB off ⇒ no results, all counted disabled', [orbOff.failedOrb.results.length, orbOff.failedOrb.coverage.disabled], [0, 1]);
  ok('...and GAP_FADE is untouched by that switch', JSON.stringify(orbOff.gapFade.results) === JSON.stringify(on.gapFade.results));
}

// ── [B] ─────────────────────────────────────────────────────────────────────
console.log('\n[B] GAP-FADE verdicts');
{
  const blk = C.buildGapFadeCandidates(assess(FADE));
  const c = blk.results[2]; // 2026-09-03
  eq('a material bounded gap is a candidate', [c.status, c.isCandidate], ['OK', true]);
  eq('the fade direction is AGAINST the gap', c.direction, 'DOWN');
  eq('the fade target is the gap origin (previous close)', c.targetLevel, 105);
  eq('the invalidation is the session open (the gap edge)', c.invalidationLevel, 106);
  eq('coverage counts the candidate', blk.coverage.candidates, 1);
  ok('the first session (no prior) is UNAVAILABLE with the taxonomy reason', blk.results[0].status === 'UNAVAILABLE' && /PRIOR_SESSION|prior/i.test(blk.results[0].reason || ''), blk.results[0].reason);
  eq('a non-material session is NOT_APPLICABLE', [blk.results[1].status, blk.results[1].isCandidate], ['NOT_APPLICABLE', false]);
  ok('...with the documented reason', /NOT_A_MATERIAL_GAP/.test(blk.results[1].reason || ''), blk.results[1].reason);

  // a gap larger than the whole prior range is a structural break, not a fade
  const huge = [...CTX, bar('2026-09-03', 120, 122, 119, 121, 105)];
  const hb = C.buildGapFadeCandidates(assess(huge));
  const h = hb.results[2];
  eq('a gap >= the prior range is not a fade candidate', [h.status, h.isCandidate], ['NOT_APPLICABLE', false]);
  ok('...with the documented reason and the measured ratio', /GAP_TOO_LARGE_FOR_FADE/.test(h.reason || '') && h.evidence.gapRatio > 1, h.reason);
  ok('the ratio bound is reported in the evidence', h.evidence.maxGapRatio === 1.0);

  const down = [...CTX, bar('2026-09-03', 101, 102, 99, 99.5, 105)];
  const dc = C.buildGapFadeCandidates(assess(down)).results[2];
  eq('a down-gap fades UP', dc.direction, 'UP');
}

// ── [C] ─────────────────────────────────────────────────────────────────────
console.log('\n[C] NO LOOK-AHEAD: the verdict cannot move with post-open information');
{
  const base = assess(FADE)[2];
  const verdictOf = (a) => C.buildGapFadeCandidates([a]).results[0];
  const asIs = verdictOf(base);

  // mutate every field that is only knowable AFTER the session ran
  const mutated = { ...base, fillState: 'UNFILLED', gapAbs: base.gapAbs, measures: { ...base.measures, close: 999999, high: 999999, low: 0.01 } };
  eq('mutating the session close/high/low and fill state changes nothing', JSON.stringify(verdictOf(mutated)), JSON.stringify(asIs));

  // the outcome-dependent classification must not matter either — only materiality (NONE vs not)
  const asCommon = verdictOf({ ...base, class: 'COMMON' });
  const asExhaustion = verdictOf({ ...base, class: 'EXHAUSTION' });
  const asIsland = verdictOf({ ...base, class: 'ISLAND' });
  ok('the outcome-derived class does not change the verdict (only NONE-ness matters)', JSON.stringify(asCommon) === JSON.stringify(asExhaustion) && JSON.stringify(asExhaustion) === JSON.stringify(asIsland));
  ok('...and all three equal the unmutated verdict', JSON.stringify(asCommon) === JSON.stringify(asIs));
  // the contract is pinned to an explicit whitelist: adding a field must be a conscious act, and
  // `measures.prevClose` is deliberately IN it (the previous session's close is pre-open knowledge)
  eq('the published input contract is exactly the documented pre-open whitelist', [...C.GAP_FADE_REQUIRES],
    ['status', 'class', 'direction', 'gapPct', 'gapRatio', 'measures.open', 'measures.prevClose', 'measures.priorRange']);
  const fadeBody = srcOf('gap-candidates.ts').split('const gapFadeVerdict')[1].split('\n};')[0];
  ok('the verdict body reads no outcome field at all', !/fillState|measures\.(close|high|low)|\.close\b/.test(fadeBody), fadeBody.match(/fillState|measures\.(close|high|low)|\.close\b/)?.[0]);
  ok('materiality uses the class NONE-ness only', /class === 'NONE'/.test(fadeBody) && (fadeBody.match(/class ===/g) || []).length === 1);
  function srcOf(f) { return fs.readFileSync(path.join(REPO, 'src', 'trading', 'gap-engine', f), 'utf8'); }
}

// ── [D] ─────────────────────────────────────────────────────────────────────
console.log('\n[D] FAILED-ORB verdicts');
{
  const one = (p) => C.buildFailedOrbCandidates([p]).results[0];

  const cand = one(ORB_CANDIDATE);
  eq('a breakout that returned inside the range is a candidate', [cand.status, cand.isCandidate], ['OK', true]);
  eq('the breakout direction is recorded', cand.direction, 'UP');
  eq('the opening range is the first window', [cand.openingRange.low, cand.openingRange.high, cand.openingRange.observations], [98, 102, 3]);
  eq('the breakout and the re-entry are both reported', [cand.breakout.price, cand.reEntry.price], [104, 101]);
  ok('the excursion beyond the range edge is measured', cand.excursion > 0, String(cand.excursion));
  ok('the re-entry is after the breakout', cand.reEntry.atMs > cand.breakout.atMs);

  const held = one(ORB_HELD);
  eq('a breakout that never came back is not a candidate', [held.status, held.isCandidate], ['OK', false]);
  ok('...with the BREAKOUT_HELD reason', /BREAKOUT_HELD/.test(held.reason || ''), held.reason);

  const none = one(ORB_NONE);
  eq('no breakout is NOT_APPLICABLE', [none.status, none.isCandidate], ['NOT_APPLICABLE', false]);
  ok('...with the NO_BREAKOUT reason', /NO_BREAKOUT/.test(none.reason || ''), none.reason);

  const late = one(ORB_LATE);
  eq('a late-starting path is refused, never proxied', [late.status, late.isCandidate], ['UNAVAILABLE', null]);
  ok('...naming the lag it measured', /LATE_START/.test(late.reason || '') && lat_e(late), late.reason);
  function lat_e(r) { return r.evidence.startLagMs === 10 * 60_000; }

  const thin = one(ORB_THIN);
  ok('too few observations inside the range is refused', thin.status === 'UNAVAILABLE' && /RANGE_INCOMPLETE/.test(thin.reason || ''), thin.reason);

  const noAfter = one(ORB_NO_AFTER);
  ok('no observations after the range is refused', noAfter.status === 'UNAVAILABLE' && /NO_PATH_AFTER_RANGE/.test(noAfter.reason || ''), noAfter.reason);

  const badDate = one(pathOf('not-a-date', [pt(D, '09:15', 100)]));
  ok('an unusable session date is refused', badDate.status === 'UNAVAILABLE' && /NO_SESSION_OPEN/.test(badDate.reason || ''), badDate.reason);

  // determinism: shuffled + duplicated points produce the same verdict
  const shuffled = pathOf(D, [...ORB_CANDIDATE.points].reverse());
  const dup = pathOf(D, [...ORB_CANDIDATE.points, ...ORB_CANDIDATE.points]);
  eq('input order does not matter', JSON.stringify(C.buildFailedOrbCandidates([shuffled]).results[0].breakout), JSON.stringify(cand.breakout));
  const digestA = C.buildGapCandidates({ paths: [ORB_CANDIDATE, ORB_HELD] }).digest;
  const digestB = C.buildGapCandidates({ paths: [ORB_HELD, ORB_CANDIDATE] }).digest;
  eq('the report digest is order-independent', digestA, digestB);

  const downOrb = pathOf(D, [pt(D, '09:15', 100), pt(D, '09:20', 102), pt(D, '09:25', 98), pt(D, '09:35', 96), pt(D, '09:40', 99)]);
  eq('a failed DOWN breakout is detected too', one(downOrb).direction, 'DOWN');
}

// ── [E] ─────────────────────────────────────────────────────────────────────
console.log('\n[E] no fabricated outcomes');
{
  const both = C.buildGapCandidates({ assessments: assess(FADE), paths: [ORB_CANDIDATE, ORB_HELD, ORB_NONE, ORB_LATE, ORB_THIN, ORB_NO_AFTER] });
  const all = [...both.gapFade.results, ...both.failedOrb.results];
  const statuses = [...new Set(all.map((r) => r.status))].sort();
  ok('only published statuses appear', statuses.every((s) => ['OK', 'NOT_APPLICABLE', 'UNAVAILABLE', 'DISABLED'].includes(s)), statuses.join(','));
  ok('a verdict is never invented for a refused row: isCandidate is null when UNAVAILABLE', all.filter((r) => r.status === 'UNAVAILABLE').every((r) => r.isCandidate === null));
  ok('every refusal carries a reason', all.filter((r) => r.status !== 'OK').every((r) => typeof r.reason === 'string' && r.reason.length > 20));
  const vocab = new Set([...C.CANDIDATE_REFUSAL_TOKENS.GAP_FADE, ...C.CANDIDATE_REFUSAL_TOKENS.FAILED_ORB]);
  const produced = all.filter((r) => r.reason).map((r) => r.reason.split(' ')[0]);
  ok('every produced refusal reason is in the published vocabulary', produced.every((r) => vocab.has(r)), produced.filter((r) => !vocab.has(r)).join(','));
  const specText = [...C.CANDIDATE_SPECS.GAP_FADE.refuses, ...C.CANDIDATE_SPECS.FAILED_ORB.refuses].join(' ');
  ok('...and every published token is documented in its spec', [...vocab].every((t) => specText.includes(t)), [...vocab].filter((t) => !specText.includes(t)).join(','));
  ok('coverage reasons are counted, never dropped', Object.keys(both.failedOrb.coverage.reasons).length >= 3, JSON.stringify(both.failedOrb.coverage.reasons));
  eq('the combination block accounts for both inputs', both.combination.sessionsInBothInputs >= both.gapFade.results.length, true);
}

// ── [F] ─────────────────────────────────────────────────────────────────────
console.log('\n[F] purity, research-only, and structural (not tuned) defaults');
{
  const src = fs.readFileSync(path.join(REPO, 'src', 'trading', 'gap-engine', 'gap-candidates.ts'), 'utf8');
  // scan CODE, not prose: comments legitimately say things like "it never ranks or optimises"
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  ok('no clock read', !/Date\.now\(\)/.test(code));
  ok('no randomness', !/Math\.random/.test(code));
  ok('no DB or HTTP client', !/mysql|fetch\(|axios|http\./.test(code));
  ok('no model/AI client or heuristic scoring', !/openai|anthropic|bedrock|\bgpt-|claude|score\s*=/i.test(code));
  ok('no ranking/optimisation of results', !/rank|optimis|optimiz|bestCandidate/i.test(code));
  ok('sorts are canonical only: session date + identity content, or instant order',
    (code.match(/\.sort\(\(/g) || []).length === 2 && !/\.sort\([^;]*isCandidate|\.sort\([^;]*gapPct/.test(code));
  ok('thresholds come from the one documented config', C.DEFAULT_CANDIDATE_CONFIG.gapFade.maxGapRatio === 1.0 && C.DEFAULT_CANDIDATE_CONFIG.failedOrb.rangeMinutes === 15 && C.DEFAULT_CANDIDATE_CONFIG.failedOrb.maxStartLagMinutes === 5);
  eq('nothing in production imports the candidate module yet (research/shadow only)', prodImporters(), []);
  function prodImporters() {
    const hits = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.ts') && !/\.test\.ts$/.test(e.name) && !p.includes('gap-engine')) {
          const t = fs.readFileSync(p, 'utf8');
          if (/gap-candidates|gap-engine/.test(t)) hits.push(path.relative(REPO, p));
        }
      }
    };
    walk(path.join(REPO, 'src'));
    return hits;
  }
}

// ── [G] ─────────────────────────────────────────────────────────────────────
console.log('\n[G] end-to-end through the real adapter + taxonomy (historical replay shape)');
{
  const series = SERIES.buildSessionSeries('NSE:NIFTY50-INDEX', FADE.map((b) => ({ sessionDate: b.sessionDate, open: b.open, high: b.high, low: b.low, quotedClose: b.prevClose, sourceId: b.sessionDate })));
  const tax = TAX.assessGapSeries(series.sessions.length ? series.sessions : [], {});
  const rep = C.buildGapCandidates({ assessments: tax.assessments, paths: [ORB_CANDIDATE] });
  ok('the report is produced from the real pipeline', rep.gapFade.coverage.inputsIn > 0 && rep.failedOrb.coverage.candidates === 1);
  ok('the digest is stable across two identical runs',
    C.buildGapCandidates({ assessments: tax.assessments, paths: [ORB_CANDIDATE] }).digest === rep.digest);
  ok('the summary is reproducible prose a reviewer can check', C.describeCandidateConfig(rep.config).includes('gap-cand-v1'));
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) { console.log('FAILED:'); failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
process.exit(0);
