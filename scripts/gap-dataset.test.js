#!/usr/bin/env node
/**
 * GATE 8 #1 (roadmap row 85) — the current NIFTY/BANKNIFTY gap DATABASE (feature side).
 *
 * doneWhen: "The component can be enabled/disabled independently and its output can be inspected in a
 *            historical replay."
 *
 * [A] contract: version, the FEATURE CUTOFF declaration, the exact column list, closed refusal vocabulary
 * [B] assembly: the frozen feature vector + per-column provenance
 * [C] LEAKAGE SAFETY (structural): no outcome/label column and no post-open read
 * [D] a missing dependency leaves a null column, never a guess
 * [E] enable/disable independently
 * [F] determinism
 * [G] purity + research-only
 */
const fs = require('fs');
const path = require('path');
const REPO = path.join(__dirname, '..');

const M = require(path.join(REPO, 'dist', 'trading', 'gap-engine', 'gap-dataset'));
const SRC = path.join(REPO, 'src', 'trading', 'gap-engine', 'gap-dataset.ts');

let pass = 0;
const failures = [];
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; console.log(`  PASS ${name}`); }
  else { failures.push(name); console.log(`  FAIL ${name}${extra ? ' :: ' + extra : ''}`); }
};
const eq = (name, actual, expected) => ok(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`);

const D = '2026-09-02';
const INST = 'NSE:NIFTY50-INDEX';
const assessment = (over = {}) => ({ sessionDate: D, instrument: INST, status: 'OK', class: 'COMMON', direction: 'UP', gapPct: 0.5, gapRatio: 0.8, gapAbs: 120, measures: { open: 24000, prevClose: 23880, priorRange: 150, priorTrendUp: 1 }, reason: null, ...over });
const inputs = (over = {}) => ({
  assessments: [assessment()],
  rangePos: { version: 'gaprangepos-v1', observations: [{ sessionDate: D, instrument: INST, status: 'OK', gapRangePos: 0.5, reason: null }] },
  scores: {
    version: 'gapscore-v1',
    fade: { observations: [{ sessionDate: D, instrument: INST, status: 'OK', score: 3, maxScore: 4, reason: null }] },
    follow: { observations: [{ sessionDate: D, instrument: INST, status: 'OK', score: 1, maxScore: 4, reason: null }] },
  },
  decisions: { version: 'gapdec-v1', decisions: [{ sessionDate: D, instrument: INST, status: 'OK', decision: 'FADE', side: 'FADE', tradeDirection: 'SHORT', direction: 'UP', reason: null }] },
  ...over,
});
const run = (over, cfg) => M.buildGapDataset(inputs(over), cfg);

// ── [A] ─────────────────────────────────────────────────────────────────────
console.log('\n[A] contract');
{
  const rep = run();
  eq('version', rep.version, 'gapdb-v1');
  eq('the config is just the switch', Object.keys(M.DEFAULT_GAP_DATASET_CONFIG), ['enabled']);
  eq('the FEATURE CUTOFF is declared on the report and every row', [rep.cutoff, rep.rows[0].cutoff], ['OPEN (09:15 IST)', 'OPEN (09:15 IST)']);
  eq('the column list is pinned and excludes any label', [...M.GAP_DATASET_FEATURES], ['gapClass', 'gapDirection', 'gapPct', 'gapRatio', 'gapAbs', 'open', 'prevClose', 'priorRange', 'gapRangePos', 'fadeScore', 'followScore', 'decisionSide', 'tradeDirection', 'decisionReason']);
  eq('the closed refusal vocabulary is the documented set', [...M.GAP_DATASET_REFUSALS], ['NO_SESSIONS', 'NO_SESSION_DATE']);
  eq('the spec documents the columns and the cutoff', [M.GAP_DATASET_SPEC.columns.length, M.GAP_DATASET_SPEC.cutoff], [M.GAP_DATASET_FEATURES.length, 'OPEN (09:15 IST)']);
  ok('the spec states labels are a SEPARATE concern (no outcome leak)', /NONE — labels are a separate row/.test(M.GAP_DATASET_SPEC.labels));
  eq('the upstream versions travel', rep.upstream, { taxonomyVersion: null, rangePosVersion: 'gaprangepos-v1', scoresVersion: 'gapscore-v1', decisionVersion: 'gapdec-v1' });
}

// ── [B] ─────────────────────────────────────────────────────────────────────
console.log('\n[B] assembly: the frozen feature vector + provenance');
{
  const r = run().rows[0];
  eq('status OK', r.status, 'OK');
  eq('the row has exactly the pinned columns', Object.keys(r.features), [...M.GAP_DATASET_FEATURES]);
  eq('the pre-open tape values are carried', [r.features.open, r.features.prevClose, r.features.priorRange], [24000, 23880, 150]);
  eq('the gap geometry is carried', [r.features.gapClass, r.features.gapDirection, r.features.gapPct, r.features.gapRatio, r.features.gapAbs], ['COMMON', 'UP', 0.5, 0.8, 120]);
  eq('the dependent columns are carried', [r.features.gapRangePos, r.features.fadeScore, r.features.followScore, r.features.decisionSide, r.features.tradeDirection], [0.5, 3, 1, 'FADE', 'SHORT']);
  ok('each column records WHICH upstream row supplied it', /row38:taxonomy/.test(r.provenance.gapClass) && /row41:range-pos/.test(r.provenance.gapRangePos) && /row44:fade/.test(r.provenance.fadeScore) && /row48:decision/.test(r.provenance.decisionSide));
}

// ── [C] ─────────────────────────────────────────────────────────────────────
console.log('\n[C] LEAKAGE SAFETY (structural)');
{
  const outcomeish = /^(close|high|low|exit|outcome|label|target|mfe|mae|fill|realized|pnl)/i;
  ok('no column is an outcome/label field', [...M.GAP_DATASET_FEATURES].every((c) => !outcomeish.test(c)), [...M.GAP_DATASET_FEATURES].filter((c) => outcomeish.test(c)).join(','));
  ok('the row carries a `cutoff` field so the boundary is explicit', 'cutoff' in run().rows[0]);
  const code = fs.readFileSync(SRC, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  ok('the module never reads a session close/high/low', !/\.(close|high|low)\b/.test(code) && !/quotedClose/.test(code));
  ok('the dataset ROW carries no label field', !Object.keys(run().rows[0]).some((k) => /label/i.test(k)) && !Object.keys(run().rows[0].features).some((k) => /label/i.test(k)));
}

// ── [D] ─────────────────────────────────────────────────────────────────────
console.log('\n[D] a missing dependency leaves a null column, never a guess');
{
  const r = run({ rangePos: { version: 'gaprangepos-v1', observations: [] }, decisions: { version: 'gapdec-v1', decisions: [] } }).rows[0];
  eq('a missing range-pos row ⇒ its column is null', r.features.gapRangePos, null);
  eq('a missing decision ⇒ its columns are null', [r.features.decisionSide, r.features.tradeDirection], [null, null]);
  ok('...and the provenance explains the absence', /absent: row41/.test(r.provenance.gapRangePos) && /absent: row48/.test(r.provenance.decisionSide));
  const bad = run({ assessments: [assessment({ sessionDate: 'nope' })] }).rows[0];
  eq('an unusable date ⇒ NO_SESSION_DATE with null features', [bad.status, bad.reason, bad.features], ['UNAVAILABLE', 'NO_SESSION_DATE', null]);
  eq('no sessions ⇒ the NO_SESSIONS refusal is recorded', run({ assessments: [] }).refusalCounts.NO_SESSIONS, 1);
}

// ── [E] ─────────────────────────────────────────────────────────────────────
console.log('\n[E] enable / disable independently');
{
  const off = run({}, { enabled: false });
  eq('disabled ⇒ DISABLED with null features', [off.rows[0].status, off.rows[0].features], ['DISABLED', null]);
  eq('disabled ⇒ nothing counted OK', [off.coverage.ok, off.coverage.rowsOut], [0, 1]);
  ok('the summary says it is disabled', /enabled=false/.test(off.reviewerSummary));
  eq('enabled ⇒ the same input yields an OK row', run().rows[0].status, 'OK');
}

// ── [F] ─────────────────────────────────────────────────────────────────────
console.log('\n[F] determinism');
{
  const rep = run();
  ok('repeated identical runs are byte-identical', run().digest === rep.digest);
  eq('coverage reports which dependencies were present', [rep.coverage.withDecision, rep.coverage.withScores, rep.coverage.withRangePos], [1, 1, 1]);
}

// ── [G] ─────────────────────────────────────────────────────────────────────
console.log('\n[G] purity + research-only');
{
  const code = fs.readFileSync(SRC, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  ok('no clock read', !/Date\.now\(\)/.test(code));
  ok('no randomness', !/Math\.random/.test(code));
  ok('no DB or HTTP client', !/mysql|fetch\(|axios|http\./.test(code));
  ok('no model/AI client', !/openai|anthropic|bedrock|\bgpt-|claude|\bllm\b/i.test(code));
  ok('research/shadow only: no production importer', prodImporters().length === 0, prodImporters().join(','));
  function prodImporters() {
    const hits = [];
    const RESEARCH = ['gap-engine', 'value-profile', 'microstructure', 'options'];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (!RESEARCH.includes(e.name)) walk(p); }
        else if (e.name.endsWith('.ts') && !RESEARCH.some((d) => p.includes(path.join('trading', d)))) {
          if (/gap-dataset|buildGapDataset/.test(fs.readFileSync(p, 'utf8'))) hits.push(path.relative(REPO, p));
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
