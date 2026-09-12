#!/usr/bin/env node
/**
 * GATE 7 #7 (roadmap row 77) — keep direction / movement / IV regime / holding period SEPARATE.
 *
 * doneWhen: "A reviewer can determine exactly what the item does and a replay/test demonstrates the behavior."
 *
 * [A] contract: version, the four dimensions, closed refusal vocabulary, and NO combined score
 * [B] an OK brief carries the four SEPARATE fields with their own sources
 * [C] ivRegime is derived by SIGN ONLY (no margin threshold)
 * [D] a partial brief is never emitted — `missing` lists every absent dimension
 * [E] the disabled path assembles nothing
 * [F] determinism + purity + research-only
 */
const fs = require('fs');
const path = require('path');
const REPO = path.join(__dirname, '..');

const M = require(path.join(REPO, 'dist', 'trading', 'options', 'selection-brief'));
const SRC = path.join(REPO, 'src', 'trading', 'options', 'selection-brief.ts');

let pass = 0;
const failures = [];
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; console.log(`  PASS ${name}`); }
  else { failures.push(name); console.log(`  FAIL ${name}${extra ? ' :: ' + extra : ''}`); }
};
const eq = (name, actual, expected) => ok(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`);

const D = '2026-09-11';
const base = () => ({
  underlying: 'SENSEX', sessionDate: D,
  direction: { value: 'SHORT', source: 'row48:gap-decision' },
  expectedMovement: { points: 120, source: 'row38:prior-session-range' },
  ivRegime: { iv: 12.5, rv: 19, source: 'row66:iv-rv' },
  holdingPeriod: { value: 'INTRADAY', source: 'operator' },
});
const run = (inputs, cfg) => M.evaluateSelectionBrief(inputs, cfg);
const one = (over = {}) => run([{ ...base(), ...over }]).rows[0];

// ── [A] ─────────────────────────────────────────────────────────────────────
console.log('\n[A] contract');
{
  const rep = run([base()]);
  eq('version', rep.version, 'selbrief-v1');
  eq('the config is just the switch', Object.keys(M.DEFAULT_SELECTION_BRIEF_CONFIG), ['enabled']);
  eq('the closed refusal vocabulary is the documented set', [...M.SELECTION_BRIEF_REFUSALS], ['NO_SESSION_DATE', 'NO_DIRECTION', 'NO_MOVEMENT', 'NO_IV_REGIME', 'NO_HOLDING']);
  eq('the spec documents every refusal token', M.SELECTION_BRIEF_SPEC.refuses, [...M.SELECTION_BRIEF_REFUSALS]);
  eq('the direction / holding / regime vocabularies are pinned', [M.TRADE_DIRECTIONS.length, M.HOLDING_PERIODS.length, M.IV_REGIMES.length], [2, 3, 3]);
  ok('the spec forbids a combined score/rank/pick', /NO combined score, rank or pick/.test(M.SELECTION_BRIEF_SPEC.transformation));
  ok('the spec says ivRegime has no margin band', /sign of \(iv − rv\)/.test(M.SELECTION_BRIEF_SPEC.thresholds));
  ok('the output contract has exactly the four dimensions (+missing)', /direction, expectedMovement, ivRegime, holdingPeriod, missing/.test(M.SELECTION_BRIEF_SPEC.output));
}

// ── [B] ─────────────────────────────────────────────────────────────────────
console.log('\n[B] an OK brief carries the four separate fields with sources');
{
  const r = one();
  eq('status OK', r.status, 'OK');
  eq('the brief has exactly the four dimensions (no extra score field)', Object.keys(r.brief).sort(), ['direction', 'expectedMovement', 'holdingPeriod', 'ivRegime', 'sessionDate', 'underlying']);
  eq('direction keeps its own source', r.brief.direction, { value: 'SHORT', source: 'row48:gap-decision' });
  eq('expectedMovement keeps its value and source', r.brief.expectedMovement, { points: 120, source: 'row38:prior-session-range' });
  eq('holdingPeriod keeps its source', r.brief.holdingPeriod, { value: 'INTRADAY', source: 'operator' });
  eq('nothing is missing', r.missing, []);
}

// ── [C] ─────────────────────────────────────────────────────────────────────
console.log('\n[C] ivRegime is derived by SIGN ONLY');
{
  eq('iv > rv ⇒ IV_RICH', one({ ivRegime: { iv: 20, rv: 15, source: 'x' } }).brief.ivRegime.value, 'IV_RICH');
  eq('iv < rv ⇒ IV_CHEAP', one({ ivRegime: { iv: 10, rv: 15, source: 'x' } }).brief.ivRegime.value, 'IV_CHEAP');
  eq('iv == rv ⇒ BALANCED', one({ ivRegime: { iv: 15, rv: 15, source: 'x' } }).brief.ivRegime.value, 'BALANCED');
  eq('a one-unit difference flips the regime (no margin band)', [one({ ivRegime: { iv: 15.000001, rv: 15, source: 'x' } }).brief.ivRegime.value, one({ ivRegime: { iv: 14.999999, rv: 15, source: 'x' } }).brief.ivRegime.value], ['IV_RICH', 'IV_CHEAP']);
  eq('the helper is the same sign rule', [M.ivRegimeOf(3, 2), M.ivRegimeOf(2, 3), M.ivRegimeOf(2, 2)], ['IV_RICH', 'IV_CHEAP', 'BALANCED']);
  eq('the regime keeps its inputs and source', one({ ivRegime: { iv: 20, rv: 15, source: 'row66' } }).brief.ivRegime, { value: 'IV_RICH', iv: 20, rv: 15, source: 'row66' });
}

// ── [D] ─────────────────────────────────────────────────────────────────────
console.log('\n[D] a partial brief is never emitted');
{
  eq('no direction ⇒ NO_DIRECTION with missing populated', [one({ direction: null }).status, one({ direction: null }).reason, one({ direction: null }).missing], ['UNAVAILABLE', 'NO_DIRECTION', ['NO_DIRECTION']]);
  eq('no movement ⇒ NO_MOVEMENT', [one({ expectedMovement: null }).reason, one({ expectedMovement: null }).missing], ['NO_MOVEMENT', ['NO_MOVEMENT']]);
  eq('a zero/negative movement is refused (never clamped)', [one({ expectedMovement: { points: 0, source: 'x' } }).reason, one({ expectedMovement: { points: -5, source: 'x' } }).reason], ['NO_MOVEMENT', 'NO_MOVEMENT']);
  eq('no iv/rv ⇒ NO_IV_REGIME', [one({ ivRegime: null }).reason, one({ ivRegime: { iv: 12, rv: null, source: 'x' } }).reason], ['NO_IV_REGIME', 'NO_IV_REGIME']);
  eq('no holding ⇒ NO_HOLDING', [one({ holdingPeriod: null }).reason, one({ holdingPeriod: { value: 'FOREVER', source: 'x' } }).reason], ['NO_HOLDING', 'NO_HOLDING']);
  eq('a bad session date ⇒ NO_SESSION_DATE', one({ sessionDate: 'yesterday' }).reason, 'NO_SESSION_DATE');
  const allMissing = one({ direction: null, expectedMovement: null, ivRegime: null, holdingPeriod: null });
  eq('every missing dimension is listed', allMissing.missing, ['NO_DIRECTION', 'NO_MOVEMENT', 'NO_IV_REGIME', 'NO_HOLDING']);
  ok('a refused row carries a null brief', allMissing.brief === null);
  const rep = run([{ ...base(), direction: null }, base()]);
  eq('coverage counts OK vs unavailable', [rep.coverage.ok, rep.coverage.unavailable], [1, 1]);
  eq('the missing-dimension tally is reported', rep.coverage.missingDimensionCounts.NO_DIRECTION, 1);
  eq('the refusal count map is in vocabulary order', Object.keys(rep.refusalCounts), [...M.SELECTION_BRIEF_REFUSALS]);
}

// ── [E] ─────────────────────────────────────────────────────────────────────
console.log('\n[E] the disabled path assembles nothing');
{
  const off = run([base()], { enabled: false });
  eq('disabled ⇒ DISABLED with no brief and nothing missing', [off.rows[0].status, off.rows[0].brief, off.rows[0].missing], ['DISABLED', null, []]);
  eq('disabled ⇒ no refusal invented and no sample', [Object.values(off.refusalCounts).reduce((a, b) => a + b, 0), off.coverage.ok], [0, 0]);
  ok('the summary says it is disabled', /enabled=false/.test(off.reviewerSummary));
}

// ── [F] ─────────────────────────────────────────────────────────────────────
console.log('\n[F] determinism + purity');
{
  const inputs = [base(), { ...base(), underlying: 'NIFTY50', direction: { value: 'LONG', source: 'row48' } }];
  const fwd = run(inputs);
  eq('reversed input ⇒ identical digest', run([...inputs].reverse()).digest, fwd.digest);
  ok('repeated identical runs are byte-identical', run(inputs).digest === fwd.digest);
  const code = fs.readFileSync(SRC, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  ok('no clock read', !/Date\.now\(\)/.test(code));
  ok('no randomness', !/Math\.random/.test(code));
  ok('no DB or HTTP client', !/mysql|fetch\(|axios|http\./.test(code));
  ok('no model/AI client', !/openai|anthropic|bedrock|\bgpt-|claude|\bllm\b/i.test(code));
  ok('the module defines no cross-dimension combination function', !/\b(compositeScore|combinedScore|blendDimensions|weightedScore|combineDimensions)\b/.test(code));
  ok('no arithmetic joins two dimensions in the emitted brief', !/expectedMovement[\s\S]{0,80}[*+]/.test(code) && !/ivRegime[\s\S]{0,80}[*+]/.test(code));
  ok('research/shadow only: no production importer', prodImporters().length === 0, prodImporters().join(','));
  function prodImporters() {
    const hits = [];
    const RESEARCH = ['gap-engine', 'value-profile', 'microstructure', 'options'];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (!RESEARCH.includes(e.name)) walk(p); }
        else if (e.name.endsWith('.ts') && !RESEARCH.some((d) => p.includes(path.join('trading', d)))) {
          if (/selection-brief|evaluateSelectionBrief/.test(fs.readFileSync(p, 'utf8'))) hits.push(path.relative(REPO, p));
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
