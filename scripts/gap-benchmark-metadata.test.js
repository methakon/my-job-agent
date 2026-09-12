#!/usr/bin/env node
/**
 * GATE 4 #12 (roadmap row 49) — old U.S. statistics stay BENCHMARK METADATA only.
 *
 * doneWhen: "The old behavior still passes regression tests and a negative test proves the new code cannot
 *            bypass it."
 *
 * [A] contract: the invariant, the policy and the closed metadata flag
 * [B] the transcribed statistics are faithful to the source and frozen
 * [C] REGRESSION: no gate-4 / production source consumes the benchmarks (the real tree scans clean)
 * [D] NEGATIVE TEST: the control catches a synthetic bypass and does not false-positive on clean code
 * [E] purity + research-only
 */
const fs = require('fs');
const path = require('path');
const REPO = path.join(__dirname, '..');

const M = require(path.join(REPO, 'dist', 'trading', 'gap-engine', 'benchmark-metadata'));
const SRC = path.join(REPO, 'src', 'trading', 'gap-engine', 'benchmark-metadata.ts');

let pass = 0;
const failures = [];
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; console.log(`  PASS ${name}`); }
  else { failures.push(name); console.log(`  FAIL ${name}${extra ? ' :: ' + extra : ''}`); }
};
const eq = (name, actual, expected) => ok(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`);

const readTs = (dir, skipDirs) => {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!skipDirs.includes(e.name)) out.push(...readTs(p, skipDirs)); }
    else if (e.name.endsWith('.ts')) out.push({ path: path.relative(REPO, p), content: fs.readFileSync(p, 'utf8') });
  }
  return out;
};

// ── [A] ─────────────────────────────────────────────────────────────────────
console.log('\n[A] contract');
{
  eq('version', M.GAP_BENCHMARK_VERSION, 'gapbench-v1');
  eq('every statistic is METADATA_ONLY and not a decision input', [...new Set(M.US_GAP_BENCHMARKS.map((e) => `${e.usage}|${e.decisionInput}`))], ['METADATA_ONLY|false']);
  eq('the policy pins the flag and claims no consumers', [M.BENCHMARK_USAGE_POLICY.usage, M.BENCHMARK_USAGE_POLICY.decisionInput, M.BENCHMARK_USAGE_POLICY.consumers.length], ['METADATA_ONLY', false, 0]);
  ok('the policy states the invariant (never a signal/score/EV/decision input)', /input to a signal, candidate, score, expected value or decision/.test(M.BENCHMARK_USAGE_POLICY.rule) && /never to act on/.test(M.BENCHMARK_USAGE_POLICY.rule));
  ok('the spec carries the invariant, the control and the source', ['invariant', 'control', 'source'].every((k) => typeof M.GAP_BENCHMARK_SPEC[k] === 'string' && M.GAP_BENCHMARK_SPEC[k].length > 0));
  eq('the authoritative module is named', M.BENCHMARK_USAGE_POLICY.authoritativeModule, 'src/trading/gap-engine/benchmark-metadata.ts');
  ok('the guard is a metadata test, not a decision path', M.isBenchmarkMetadata(M.US_GAP_BENCHMARKS[0]) === true);
  ok('the summary says METADATA_ONLY', /METADATA_ONLY/.test(M.describeGapBenchmarks()));
}

// ── [B] ─────────────────────────────────────────────────────────────────────
console.log('\n[B] the statistics are faithful and frozen');
{
  const ids = M.US_GAP_BENCHMARKS.map((e) => e.id);
  eq('the four documented U.S. statistics are recorded', ids, ['us-gap-fill-rate-low-volume', 'us-gap-fill-rate-mid-volume', 'us-reward-risk-rule', 'us-down-gap-backtest']);
  ok('every entry cites the reference document', M.US_GAP_BENCHMARKS.every((e) => e.source === 'docs/FNO_MARKET_REFERENCE.md'));
  ok('the values are kept as TEXT (never parsed into a rule)', M.US_GAP_BENCHMARKS.every((e) => typeof e.value === 'string' && e.value.length > 0));
  ok('the low-volume ~80% and mid-volume ~60% bands are recorded', M.US_GAP_BENCHMARKS.some((e) => e.id === 'us-gap-fill-rate-low-volume' && e.value === '~80%') && M.US_GAP_BENCHMARKS.some((e) => e.id === 'us-gap-fill-rate-mid-volume' && e.value === '~60%'));
  ok('the 1:1.5 reward/risk rule is recorded as text', /1:1\.5/.test(M.US_GAP_BENCHMARKS.find((e) => e.id === 'us-reward-risk-rule').value));
  ok('the array and every entry are frozen (a benchmark cannot be mutated into a rule)', Object.isFrozen(M.US_GAP_BENCHMARKS) && M.US_GAP_BENCHMARKS.every((e) => Object.isFrozen(e)));
  ok('the reference document exists on disk', fs.existsSync(path.join(REPO, 'docs', 'FNO_MARKET_REFERENCE.md')));
}

// ── [C] ─────────────────────────────────────────────────────────────────────
console.log('\n[C] REGRESSION — the protected behaviour holds on the real tree');
{
  const files = readTs(path.join(REPO, 'src', 'trading'), []);
  const hits = M.detectBenchmarkMisuse(files, { ignore: ['src/trading/gap-engine/benchmark-metadata.ts'] });
  ok('no gate-4 or production source consumes the U.S. statistics', hits.length === 0, JSON.stringify(hits.slice(0, 5)));
  ok('...and the scan actually covered the tree', files.length > 20, `scanned ${files.length} files`);
  // the decision modules are independent of the benchmarks (spot-check the ones the row protects)
  const decisionFiles = files.filter((f) => /gap-(taxonomy|hypotheses|candidates|range-pos|acceptance|scores|expected-value|decision)\.ts$/.test(f.path));
  ok('the gate-4 decision chain is among the scanned sources', decisionFiles.length === 8, String(decisionFiles.length));
}

// ── [D] ─────────────────────────────────────────────────────────────────────
console.log('\n[D] NEGATIVE TEST — a bypass cannot pass silently');
{
  const bypassImport = { path: 'src/trading/gap-engine/new-research.ts', content: "import { US_GAP_BENCHMARKS } from './benchmark-metadata';\nconst p = US_GAP_BENCHMARKS[0];\n" };
  const bypassValue = { path: 'src/trading/gap-engine/new-research.ts', content: "// calibrate against the E-mini S&P history\nconst fillRate = 0.8; // the US benchmark\n" };
  const clean = { path: 'src/trading/gap-engine/new-research.ts', content: 'const x = computeFeature();\nexport default x;\n' };
  ok('a module that IMPORTS the benchmarks is flagged', M.detectBenchmarkMisuse([bypassImport]).length > 0);
  ok('a module that hard-codes a benchmark fingerprint is flagged', M.detectBenchmarkMisuse([bypassValue]).length > 0);
  eq('...and the hit names the file, fingerprint and line', M.detectBenchmarkMisuse([bypassImport])[0].file, 'src/trading/gap-engine/new-research.ts');
  ok('...with a usable line number', M.detectBenchmarkMisuse([bypassImport])[0].line >= 1);
  eq('clean code is NOT flagged (no false positives)', M.detectBenchmarkMisuse([clean]), []);
  eq('the ignore list suppresses the authoritative module only', M.detectBenchmarkMisuse([bypassImport], { ignore: ['src/trading/gap-engine/new-research.ts'] }), []);
  // a synthetic tree containing one bypass must fail the same scan the regression runs
  ok('the control turns a bypass into a failing scan', M.detectBenchmarkMisuse([clean, bypassValue]).some((h) => h.file === bypassValue.path));
}

// ── [E] ─────────────────────────────────────────────────────────────────────
console.log('\n[E] purity + research-only');
{
  const code = fs.readFileSync(SRC, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  ok('no clock read', !/Date\.now\(\)/.test(code));
  ok('no randomness', !/Math\.random/.test(code));
  ok('no DB or HTTP client', !/mysql|fetch\(|axios|http\./.test(code));
  ok('no model/AI client', !/openai|anthropic|bedrock|\bgpt-|claude|\bllm\b/i.test(code));
  ok('no ranking/optimisation of results', !/optimis|optimiz|\brank\b/i.test(code));
  ok('research/shadow only: no production importer', prodImporters().length === 0, prodImporters().join(','));
  function prodImporters() {
    const hits = [];
    const RESEARCH = ['gap-engine', 'value-profile'];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (!RESEARCH.includes(e.name)) walk(p); }
        else if (e.name.endsWith('.ts') && !p.includes(path.join('trading', 'gap-engine')) && !p.includes(path.join('trading', 'value-profile'))) {
          if (/benchmark-metadata|US_GAP_BENCHMARKS|detectBenchmarkMisuse/.test(fs.readFileSync(p, 'utf8'))) hits.push(path.relative(REPO, p));
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
