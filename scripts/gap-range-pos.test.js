#!/usr/bin/env node
/**
 * GATE 4 #4 (roadmap row 41) — GapRangePos.
 *
 * doneWhen: "The same inputs produce the same result in replay, and edge cases return a safe
 * explicit state rather than a fabricated value."
 *
 * [A] contract: version, one switch object, no thresholds, spec states formula/units/window/refusals
 * [B] the pinned definition, including the sign/edge values 0, 0.5, 1, >1, <0
 * [C] every refusal reason is reachable, each with a null value and a closed-vocabulary token
 * [D] the disabled path computes nothing and says so
 * [E] determinism: reversed/shuffled input ⇒ identical digest AND identical observation order
 * [F] NO LOOK-AHEAD: nothing after the open can move the value
 * [G] purity + research-only + no threshold constant
 * [H] end-to-end through the real session-series adapter
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const REPO = path.join(__dirname, '..');

const SERIES = require(path.join(REPO, 'dist', 'trading', 'gap-engine', 'gap-session-series'));
const G = require(path.join(REPO, 'dist', 'trading', 'gap-engine', 'gap-range-pos'));

const SRC = path.join(REPO, 'src', 'trading', 'gap-engine', 'gap-range-pos.ts');

let pass = 0;
const failures = [];
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; console.log(`  PASS ${name}`); }
  else { failures.push(name); console.log(`  FAIL ${name}${extra ? ' :: ' + extra : ''}`); }
};
const eq = (name, actual, expected) => ok(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`);
const close = (name, actual, expected) => ok(name, actual !== null && Math.abs(actual - expected) < 1e-9, `got ${actual} want ${expected}`);

const INST = 'NSE:NIFTY50-INDEX';
const bar = (d, open, high, low, close = null, prevClose = null, instrument = INST) => ({
  sessionDate: d, instrument, provenance: 'DERIVED_CLOSE', open, high, low, close, prevClose, range: high - low, nextQuotedClose: close,
});
const run = (bars, cfg) => G.assessGapRangePosSeries(bars, cfg);
const byDate = (r, d) => r.observations.find((o) => o.sessionDate === d);

// prior range = 110 - 100 = 10 exactly (the reference for every [B] value)
const PRIOR = bar('2026-09-01', 104, 110, 100, 107, 103);

// ── [A] ─────────────────────────────────────────────────────────────────────
console.log('\n[A] contract');
{
  const r = run([PRIOR, bar('2026-09-02', 105, 108, 103, 106, 107)]);
  eq('version', r.version, 'gaprangepos-v1');
  eq('the spec carries the pinned formula', G.GAP_RANGE_POS_SPEC.formula, 'GapRangePos = (open − prior.low) / (prior.high − prior.low)');
  ok('the spec states units, window and look-ahead', /dimensionless/.test(G.GAP_RANGE_POS_SPEC.units) && /immediately preceding/.test(G.GAP_RANGE_POS_SPEC.window) && /^none/.test(G.GAP_RANGE_POS_SPEC.lookAhead));
  ok('the result carries the spec and a reviewer summary', r.spec.formula === G.GAP_RANGE_POS_SPEC.formula && r.reviewerSummary.includes('gaprangepos-v1'));
  ok('the summary states the formula and the refusals', /prior\.low/.test(r.reviewerSummary) && G.GAP_RANGE_POS_REFUSALS.every((t) => r.reviewerSummary.includes(t)));
  eq('the closed refusal vocabulary is exactly the documented five', [...G.GAP_RANGE_POS_REFUSALS],
    ['NO_PRIOR_SESSION', 'NO_PRIOR_RANGE', 'ZERO_PRIOR_RANGE', 'IMPOSSIBLE_PRIOR_RANGE', 'NO_SESSION_OPEN']);
  eq('the spec documents every refusal token', G.GAP_RANGE_POS_SPEC.refuses, [...G.GAP_RANGE_POS_REFUSALS]);
  ok('every refusal token appears in the spec prose', G.GAP_RANGE_POS_REFUSALS.every((t) => G.GAP_RANGE_POS_SPEC.missingData.includes(t)));
  // no thresholds: the ONE config object carries a single boolean switch and no numeric knob
  eq('the single config object is just the switch', Object.keys(G.DEFAULT_GAP_RANGE_POS_CONFIG), ['enabled']);
  ok('and it holds no numeric threshold', Object.values(G.DEFAULT_GAP_RANGE_POS_CONFIG).every((v) => typeof v !== 'number'));
}

// ── [B] ─────────────────────────────────────────────────────────────────────
console.log('\n[B] the pinned definition (prior range 100..110)');
{
  const g = (open) => byDate(run([PRIOR, bar('2026-09-02', open, open + 1, open - 1, open, 107)]), '2026-09-02').gapRangePos;
  close('open at the prior low ⇒ 0', g(100), 0);
  close('open at the prior midpoint ⇒ 0.5', g(105), 0.5);
  close('open at the prior high ⇒ 1', g(110), 1);
  close('open above the prior range ⇒ > 1', g(115), 1.5);
  close('open below the prior range ⇒ < 0', g(95), -0.5);
  close('the value is linear in the open', g(102) - g(101), 0.1);

  const r = run([PRIOR, bar('2026-09-02', 105, 108, 103, 106, 107)]);
  const o = byDate(r, '2026-09-02');
  eq('every OK row reports its inputs as measures', [o.measures.open, o.measures.priorHigh, o.measures.priorLow, o.measures.priorRange], [105, 110, 100, 10]);
  eq('the first session is refused for want of a prior session', [byDate(r, '2026-09-01').status, byDate(r, '2026-09-01').reason], ['UNAVAILABLE', 'NO_PRIOR_SESSION']);
  eq('coverage counts one OK and one UNAVAILABLE', [r.coverage.ok, r.coverage.unavailable, r.coverage.sessionsIn], [1, 1, 2]);
  eq('first/last OK sessions are reported', [r.coverage.firstOkSession, r.coverage.lastOkSession], ['2026-09-02', '2026-09-02']);
}

// ── [C] ─────────────────────────────────────────────────────────────────────
console.log('\n[C] every edge case is a safe explicit state, never a fabricated value');
{
  const cases = [
    ['NO_SESSION_OPEN', [PRIOR, bar('2026-09-02', null, 108, 103, 106, 107)]],
    ['NO_SESSION_OPEN', [PRIOR, bar('2026-09-02', 0, 108, 103, 106, 107)]],
    ['NO_SESSION_OPEN', [PRIOR, bar('2026-09-02', -5, 108, 103, 106, 107)]],
    ['NO_PRIOR_SESSION', [bar('2026-09-01', 104, 110, 100, 107, 103)]],
    ['ZERO_PRIOR_RANGE', [bar('2026-09-01', 105, 105, 105, 105, 104), bar('2026-09-02', 106, 108, 103, 106, 105)]],
    ['IMPOSSIBLE_PRIOR_RANGE', [bar('2026-09-01', 104, 100, 110, 107, 103), bar('2026-09-02', 106, 108, 103, 106, 107)]],
    ['NO_PRIOR_RANGE', [bar('2026-09-01', 104, undefined, 100, 107, 103), bar('2026-09-02', 106, 108, 103, 106, 107)]],
    ['NO_PRIOR_RANGE', [bar('2026-09-01', 104, 110, NaN, 107, 103), bar('2026-09-02', 106, 108, 103, 106, 107)]],
  ];
  for (const [reason, bars] of cases) {
    const r = run(bars);
    const row = r.observations[r.observations.length - 1];
    eq(`${reason}: status is UNAVAILABLE`, row.status, 'UNAVAILABLE');
    eq(`${reason}: reason token`, row.reason, reason);
    eq(`${reason}: the value is null, not 0/NaN`, row.gapRangePos, null);
    ok(`${reason}: a human detail accompanies the token`, typeof row.reasonDetail === 'string' && row.reasonDetail.length > 10, row.reasonDetail);
    eq(`${reason}: the refusal is counted under its token`, r.refusalCounts[reason] >= 1, true);
  }
  // every published token is emitted by some case above, so none is dead prose-only vocabulary
  const emitted = new Set(cases.map((c) => c[0]));
  eq('the fixtures exercise the whole vocabulary', [...G.GAP_RANGE_POS_REFUSALS].every((t) => emitted.has(t)), true);
  // and no row anywhere carries a value outside OK
  const all = run(cases.flatMap((c) => c[1]));
  ok('no non-OK row ever carries a number', all.observations.every((o) => (o.status === 'OK' ? typeof o.gapRangePos === 'number' : o.gapRangePos === null)));
  ok('a value is never NaN or Infinity', all.observations.filter((o) => o.gapRangePos !== null).every((o) => Number.isFinite(o.gapRangePos)));
}

// ── [D] ─────────────────────────────────────────────────────────────────────
console.log('\n[D] the disabled path computes nothing and says so');
{
  const bars = [PRIOR, bar('2026-09-02', 105, 108, 103, 106, 107)];
  const off = run(bars, { enabled: false });
  eq('disabled ⇒ one DISABLED row per input', [off.observations.length, off.coverage.disabled, off.coverage.sessionsIn], [2, 2, 2]);
  eq('disabled ⇒ no OK rows and no computed value', [off.counts.OK, off.observations.every((o) => o.gapRangePos === null)], [0, true]);
  eq('disabled ⇒ no refusal is invented', off.counts.UNAVAILABLE, 0);
  eq('the dataset size is still reported', off.coverage.sessionsIn, 2);
  ok('the disabled summary says the component is disabled', /enabled=false/.test(off.reviewerSummary), off.reviewerSummary.slice(-40));

  const on = run(bars);
  ok('enabling changes which rows carry values', off.digest !== on.digest && on.coverage.ok === 1);
}

// ── [E] ─────────────────────────────────────────────────────────────────────
console.log('\n[E] determinism is engineered, not hoped for');
{
  // two instruments sharing one session date — a date-only sort would keep the caller's order
  const A = [bar('2026-09-01', 104, 110, 100, 107, 103, 'NSE:NIFTY50-INDEX'), bar('2026-09-02', 105, 108, 103, 106, 107, 'NSE:NIFTY50-INDEX')];
  const B = [bar('2026-09-01', 204, 210, 200, 207, 203, 'NSE:BANKNIFTY-INDEX'), bar('2026-09-02', 205, 208, 203, 206, 207, 'NSE:BANKNIFTY-INDEX')];
  const forward = run([...A, ...B]);
  const reversed = run([...[...A, ...B]].reverse());
  eq('reversed input ⇒ identical digest', reversed.digest, forward.digest);
  eq('reversed input ⇒ identical observation order', reversed.observations.map((o) => `${o.sessionDate}|${o.instrument}`), forward.observations.map((o) => `${o.sessionDate}|${o.instrument}`));
  const shuffled = run([...B, ...A]); // B's rows arrive before A's: caller order changed, content identical
  eq('shuffled input ⇒ identical counts', shuffled.counts, forward.counts);
  eq('shuffled input ⇒ identical refusal counts', shuffled.refusalCounts, forward.refusalCounts);
  // count maps are canonicalised, not insertion-ordered
  eq('the status count map is in the canonical order', Object.keys(forward.counts), ['OK', 'UNAVAILABLE', 'DISABLED']);
  eq('the refusal count map is in the vocabulary order', Object.keys(forward.refusalCounts), [...G.GAP_RANGE_POS_REFUSALS]);
  ok('repeated identical runs are byte-identical', run([...A, ...B]).digest === forward.digest);
  // the digest is a function of the data: a real change must move it
  const changed = run([...A, bar('2026-09-02', 105.5, 108, 103, 106, 107, 'NSE:NIFTY50-INDEX'), ...B]);
  ok('a changed open moves the digest', changed.digest !== forward.digest);
}

// ── [F] ─────────────────────────────────────────────────────────────────────
console.log('\n[F] NO LOOK-AHEAD: nothing after the open can move the value');
{
  const bars = [PRIOR, bar('2026-09-02', 105, 108, 103, 106, 107)];
  const base = byDate(run(bars), '2026-09-02');
  const val = (b2, prior2) => byDate(run([prior2, b2]), '2026-09-02').gapRangePos;
  eq('mutating the session own close/high/low changes nothing', val(bar('2026-09-02', 105, 999, 0.01, 999, 107), PRIOR), base.gapRangePos);
  eq('mutating the prior session close changes nothing', val(bar('2026-09-02', 105, 108, 103, 106, 107), bar('2026-09-01', 104, 110, 100, 999, 103)), base.gapRangePos);
  eq('mutating the next quoted close changes nothing', val(bar('2026-09-02', 105, 108, 103, 999, 107), PRIOR), base.gapRangePos);
  // the module body must not read an outcome field at all
  const body = srcCode().split('function assessOne')[1].split('/** The disabled path')[0];
  ok('the computation reads no close/high/low of the session itself', !/\bclose\b|nextQuotedClose|\bfillState\b|\bclass\b/.test(body), body.match(/\bclose\b|nextQuotedClose|\bfillState\b|\bclass\b/)?.[0]);
}

// ── [G] ─────────────────────────────────────────────────────────────────────
console.log('\n[G] purity + research-only + no threshold constant');
{
  const code = srcCode();
  ok('no clock read', !/Date\.now\(\)/.test(code));
  ok('no randomness', !/Math\.random/.test(code));
  ok('no DB or HTTP client', !/mysql|fetch\(|axios|http\./.test(code));
  ok('no model/AI client', !/openai|anthropic|bedrock|\bgpt-|claude|\bllm\b/i.test(code));
  ok('no ranking/optimisation/tuning of a result', !/rank|optimis|optimiz|tune|threshold\s*=/i.test(code));
  ok('exactly one comparator sort (canonical order)', (code.match(/\.sort\(\(/g) || []).length === 1);
  ok('the sort key uses only pre-open fields', /\$\{a\.open\}/.test(code) && /\$\{a\.prevClose\}/.test(code) && !/\$\{a\.(high|low|close)\}/.test(code));
  ok('research/shadow only: no production importer yet', prodImporters().length === 0, prodImporters().join(','));
  function prodImporters() {
    const hits = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== 'gap-engine') walk(p); }
        else if (e.name.endsWith('.ts') && !/\.test\.ts$/.test(e.name) && !p.includes(path.join('trading', 'gap-engine'))) {
          if (/gap-range-pos|gapRangePos/.test(fs.readFileSync(p, 'utf8'))) hits.push(path.relative(REPO, p));
        }
      }
    };
    walk(path.join(REPO, 'src'));
    return hits;
  }
}

// ── [H] ─────────────────────────────────────────────────────────────────────
console.log('\n[H] end-to-end through the real session-series adapter');
{
  const raw = [
    { sessionDate: '2026-09-01', open: 104, high: 110, low: 100, quotedClose: 103, sourceId: 'r1' },
    { sessionDate: '2026-09-02', open: 105, high: 108, low: 103, quotedClose: 107, sourceId: 'r2' },
    { sessionDate: '2026-09-03', open: 111, high: 113, low: 109, quotedClose: 106, sourceId: 'r3' },
  ];
  const series = SERIES.buildSessionSeries(INST, raw);
  const r = run(series.sessions);
  eq('the adapter-built series is consumed unchanged', r.coverage.sessionsIn, series.sessions.length);
  close('the 2026-09-02 value matches the pinned formula on adapter output', byDate(r, '2026-09-02').gapRangePos, 0.5); // prior 100..110 => range 10, open 105 => 5/10
  ok('a value above the prior range is computed, not clamped', byDate(r, '2026-09-03').gapRangePos > 1); // prior 103..108 => range 5, open 111 => 1.6
  eq('the newest session still gets a value (no close needed)', byDate(r, '2026-09-03').status, 'OK');
  const a = crypto.createHash('sha256').update(r.digest).digest('hex').slice(0, 16);
  ok('the replay digest is reproducible', crypto.createHash('sha256').update(run(series.sessions).digest).digest('hex').slice(0, 16) === a);
  console.log(`  (fixture replay digest ${a})`);
}

function srcCode() {
  const src = fs.readFileSync(SRC, 'utf8');
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) { console.log('FAILED:'); failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
process.exit(0);
