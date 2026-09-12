#!/usr/bin/env node
/**
 * GATE 4 #5 (roadmap row 42) — opening position relative to the prior value area.
 *
 * doneWhen: "The same inputs produce the same result in replay, and edge cases return a safe explicit
 * state rather than a fabricated value."
 *
 * [A] contract: version, formula/units/window/look-ahead pinned, closed refusal vocabulary
 * [B] the pinned positions: ABOVE_VALUE / INSIDE_VALUE / BELOW_VALUE and the ratio
 * [C] every refusal is reachable, each with a null position
 * [D] the disabled path computes nothing and says so
 * [E] determinism: reversed input ⇒ identical digest AND identical observation order
 * [F] NO LOOK-AHEAD: post-open fields cannot move a position
 * [G] purity + research-only + no threshold
 * [H] end-to-end through the real adapter + the row-60 value profile
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const REPO = path.join(__dirname, '..');

const SERIES = require(path.join(REPO, 'dist', 'trading', 'gap-engine', 'gap-session-series'));
const ALIGN = require(path.join(REPO, 'dist', 'trading', 'pre-open', 'pre-open-alignment'));
const V = require(path.join(REPO, 'dist', 'trading', 'value-profile', 'value-profile'));
const O = require(path.join(REPO, 'dist', 'trading', 'gap-engine', 'opening-position'));

const SRC = path.join(REPO, 'src', 'trading', 'gap-engine', 'opening-position.ts');

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

// one bar per session; the adapter owns labelling. Opens: D1 104, D2 110, D3 106, D4 130, D5 90
const RAW = [
  { sessionDate: D1, open: 104, high: 110, low: 100, quotedClose: 98, sourceId: 'a' },
  { sessionDate: D2, open: 110, high: 112, low: 108, quotedClose: 104, sourceId: 'b' },
  { sessionDate: D3, open: 106, high: 108, low: 104, quotedClose: 110, sourceId: 'c' },
  { sessionDate: D4, open: 130, high: 132, low: 128, quotedClose: 106, sourceId: 'd' },
  { sessionDate: D5, open: 90, high: 92, low: 88, quotedClose: 130, sourceId: 'e' },
];
const SESSIONS = SERIES.buildSessionSeries(INST, RAW).sessions;

// a D1 profile whose value area is exactly [100, 120] (width 20) — 5 obs at 105, 3 at 115, 1 at 125
const at = (d, hhmm) => { const [h, m] = hhmm.split(':').map(Number); return ALIGN.sessionMidnightMs(d) + (h * 60 + m) * 60_000; };
const pt = (d, hhmm, price) => ({ instantMs: at(d, hhmm), price });
const D1_PATH = {
  sessionDate: D1, instrument: INST,
  points: [pt(D1, '10:00', 105), pt(D1, '10:05', 105), pt(D1, '10:10', 105), pt(D1, '10:15', 105), pt(D1, '10:20', 105),
    pt(D1, '10:30', 115), pt(D1, '10:35', 115), pt(D1, '10:40', 115), pt(D1, '11:00', 125)],
};
const PROFILES = V.buildValueProfiles([D1_PATH]);
const run = (profiles = PROFILES, cfg) => O.buildOpeningPositions(SESSIONS, profiles, cfg);
const rowOf = (rep, d) => rep.observations.find((o) => o.sessionDate === d);

// ── [A] ─────────────────────────────────────────────────────────────────────
console.log('\n[A] contract');
{
  const rep = run();
  eq('version', rep.version, 'oppos-v1');
  eq('the spec pins the formula and the states', [O.OPENING_POSITION_SPEC.formula.startsWith('pos = (open − prior.VAL) / (prior.VAH − prior.VAL)'), O.OPENING_STATES], [true, ['ABOVE_VALUE', 'INSIDE_VALUE', 'BELOW_VALUE']]);
  ok('the spec pins units, window and look-ahead', /value-area widths/.test(O.OPENING_POSITION_SPEC.units) && /immediately preceding/.test(O.OPENING_POSITION_SPEC.window) && /^none/.test(O.OPENING_POSITION_SPEC.lookAhead));
  eq('the closed refusal vocabulary is the documented set', [...O.OPENING_POSITION_REFUSALS], ['NO_SESSION_OPEN', 'NO_PRIOR_SESSION', 'PROFILE_UNAVAILABLE', 'ZERO_VALUE_AREA']);
  eq('the spec documents every refusal token', O.OPENING_POSITION_SPEC.refuses, [...O.OPENING_POSITION_REFUSALS]);
  eq('the single config object is just the switch', Object.keys(O.DEFAULT_OPENING_POSITION_CONFIG), ['enabled']);
  ok('the summary states the formula, the states and every refusal', /prior\.VAL/.test(rep.reviewerSummary) && /ABOVE_VALUE/.test(rep.reviewerSummary) && O.OPENING_POSITION_REFUSALS.every((t) => rep.reviewerSummary.includes(t)));
  eq('the fixture prior profile really is VAL=100 / VAH=120', [PROFILES.profiles[0].val, PROFILES.profiles[0].vah], [100, 120]);
}

// ── [B] ─────────────────────────────────────────────────────────────────────
console.log('\n[B] the pinned positions (prior value area 100..120, width 20)');
{
  const rep = run();
  const d2 = rowOf(rep, D2);
  eq('open inside the area ⇒ INSIDE_VALUE at pos 0.5', [d2.status, d2.state, d2.pos], ['OK', 'INSIDE_VALUE', 0.5]);
  eq('the prior session is named', d2.priorSessionDate, D1);
  eq('the evidence carries the area it used', [d2.evidence.open, d2.evidence.val, d2.evidence.vah], [110, 100, 120]);
  const d4 = rowOf(rep, D4);
  eq('open above the area ⇒ ABOVE_VALUE at pos 1.5', [d4.state, d4.pos], ['ABOVE_VALUE', 1.5]);
  const d5 = rowOf(rep, D5);
  eq('open below the area ⇒ BELOW_VALUE at pos −0.5', [d5.state, d5.pos], ['BELOW_VALUE', -0.5]);
  ok('the state and the ratio agree (open > VAH ⇔ pos > 1)', [d4, d5].every((r) => (r.state === 'ABOVE_VALUE') === (r.pos > 1) && (r.state === 'BELOW_VALUE') === (r.pos < 0)));
  eq('the state counts add up over the OK rows', rep.stateCounts, { ABOVE_VALUE: 1, INSIDE_VALUE: 2, BELOW_VALUE: 1 });
  eq('coverage separates decided from refused', [rep.coverage.ok, rep.coverage.unavailable, rep.coverage.sessionsIn], [4, 1, 5]);
  // exact boundary behaviour: the area edges are INSIDE
  const edge = (open) => {
    const s = SESSIONS.map((x) => (x.sessionDate === D2 ? { ...x, open } : x));
    return rowOf(O.buildOpeningPositions(s, PROFILES), D2);
  };
  eq('open exactly at VAL ⇒ INSIDE_VALUE at pos 0', [edge(100).state, edge(100).pos], ['INSIDE_VALUE', 0]);
  eq('open exactly at VAH ⇒ INSIDE_VALUE at pos 1', [edge(120).state, edge(120).pos], ['INSIDE_VALUE', 1]);
}

// ── [C] ─────────────────────────────────────────────────────────────────────
console.log('\n[C] every edge case is a safe explicit state, never a fabricated position');
{
  const rep = run();
  const d1 = rowOf(rep, D1);
  eq('the first session has no prior profile ⇒ NO_PRIOR_SESSION', [d1.status, d1.reason, d1.pos, d1.state], ['UNAVAILABLE', 'NO_PRIOR_SESSION', null, null]);
  ok('...with a human detail', typeof d1.reasonDetail === 'string' && d1.reasonDetail.length > 10);

  const badOpen = SESSIONS.map((x) => (x.sessionDate === D2 ? { ...x, open: 0 } : x));
  const b = rowOf(O.buildOpeningPositions(badOpen, PROFILES), D2);
  eq('a non-positive open ⇒ NO_SESSION_OPEN', [b.status, b.reason, b.pos], ['UNAVAILABLE', 'NO_SESSION_OPEN', null]);

  // a prior profile that itself refused ⇒ PROFILE_UNAVAILABLE carrying the parent reason verbatim
  const badProfile = V.buildValueProfiles([{ sessionDate: D1, instrument: INST, points: [pt(D1, '10:00', 105)] }]);
  const p = rowOf(O.buildOpeningPositions(SESSIONS, badProfile), D2);
  eq('a refused prior profile ⇒ PROFILE_UNAVAILABLE', [p.status, p.reason, p.pos], ['UNAVAILABLE', 'PROFILE_UNAVAILABLE', null]);
  ok('...and the profile reason is propagated verbatim', /INSUFFICIENT_LEVELS/.test(p.reasonDetail), p.reasonDetail);

  // a zero-width area is unreachable from buildValueProfiles, so it is pinned with a synthetic profile
  const zero = { ...PROFILES.profiles[0], val: 100, vah: 100 };
  const z = rowOf(O.buildOpeningPositions(SESSIONS, { ...PROFILES, profiles: [zero] }), D2);
  eq('a zero-width value area ⇒ ZERO_VALUE_AREA', [z.status, z.reason, z.pos], ['UNAVAILABLE', 'ZERO_VALUE_AREA', null]);

  const all = O.buildOpeningPositions(SESSIONS, PROFILES);
  const produced = all.observations.filter((o) => o.reason).map((o) => o.reason);
  ok('every produced reason is in the published vocabulary', produced.every((r) => O.OPENING_POSITION_REFUSALS.includes(r)), produced.join(','));
  ok('no non-OK row ever carries a position or a state', all.observations.every((o) => (o.status === 'OK' ? typeof o.pos === 'number' && o.state !== null : o.pos === null && o.state === null)));
  ok('a position is never NaN or Infinity', all.observations.filter((o) => o.pos !== null).every((o) => Number.isFinite(o.pos)));
  // the emitted set covers the vocabulary that these fixtures can reach
  eq('the fixtures reach every reachable refusal', [...O.OPENING_POSITION_REFUSALS].filter((t) => ![d1.reason, b.reason, p.reason, z.reason].includes(t)), []);
}

// ── [D] ─────────────────────────────────────────────────────────────────────
console.log('\n[D] the disabled path computes nothing and says so');
{
  const off = run(PROFILES, { enabled: false });
  eq('disabled ⇒ one DISABLED row per input', [off.observations.length, off.coverage.disabled], [SESSIONS.length, SESSIONS.length]);
  eq('disabled ⇒ no position and no state', [off.counts.OK, off.coverage.above + off.coverage.inside + off.coverage.below], [0, 0]);
  eq('disabled ⇒ no refusal invented', off.counts.UNAVAILABLE, 0);
  ok('the summary says it is disabled', /enabled=false/.test(off.reviewerSummary));
  ok('the disabled row states why in words', /disabled/.test(off.observations[0].reasonDetail ?? ''));
}

// ── [E] ─────────────────────────────────────────────────────────────────────
console.log('\n[E] determinism');
{
  const other = SERIES.buildSessionSeries('NSE:BANKNIFTY-INDEX', [
    { sessionDate: D1, open: 204, high: 210, low: 200, quotedClose: 198, sourceId: 'x' },
    { sessionDate: D2, open: 210, high: 212, low: 208, quotedClose: 204, sourceId: 'y' },
  ]).sessions;
  const fwd = O.buildOpeningPositions([...SESSIONS, ...other], PROFILES);
  const rev = O.buildOpeningPositions([...[...SESSIONS, ...other]].reverse(), PROFILES);
  eq('reversed input ⇒ identical digest', rev.digest, fwd.digest);
  eq('reversed input ⇒ identical observation order', rev.observations.map((o) => `${o.sessionDate}|${o.instrument}`), fwd.observations.map((o) => `${o.sessionDate}|${o.instrument}`));
  ok('repeated identical runs are byte-identical', O.buildOpeningPositions([...SESSIONS, ...other], PROFILES).digest === fwd.digest);
  eq('the counted vocabularies are canonical', [Object.keys(fwd.counts), Object.keys(fwd.refusalCounts), Object.keys(fwd.stateCounts)], [['OK', 'UNAVAILABLE', 'DISABLED'], [...O.OPENING_POSITION_REFUSALS], [...O.OPENING_STATES]]);
  ok('a changed open moves the digest', O.buildOpeningPositions(SESSIONS.map((s) => (s.sessionDate === D2 ? { ...s, open: 111 } : s)), PROFILES).digest !== fwd.digest);
}

// ── [F] ─────────────────────────────────────────────────────────────────────
console.log('\n[F] NO LOOK-AHEAD: post-open fields cannot move a position');
{
  const base = rowOf(run(), D2);
  const mutated = SESSIONS.map((s) => (s.sessionDate === D2 ? { ...s, high: 9999, low: 0.01, close: 9999, nextQuotedClose: 9999, range: 9998 } : s));
  const after = rowOf(O.buildOpeningPositions(mutated, PROFILES), D2);
  eq('mutating the session high/low/close changes nothing', [after.state, after.pos], [base.state, base.pos]);
  const body = fs.readFileSync(SRC, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').split('export function buildOpeningPositions')[1];
  ok('the computation reads no session high/low/close', !/s\.(high|low|close|range|nextQuotedClose)/.test(body), body.match(/s\.(high|low|close|range|nextQuotedClose)/)?.[0]);
}

// ── [G] ─────────────────────────────────────────────────────────────────────
console.log('\n[G] purity + research-only + no threshold');
{
  const code = fs.readFileSync(SRC, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  ok('no clock read', !/Date\.now\(\)/.test(code));
  ok('no randomness', !/Math\.random/.test(code));
  ok('no DB or HTTP client', !/mysql|fetch\(|axios|http\./.test(code));
  ok('no model/AI client', !/openai|anthropic|bedrock|\bgpt-|claude|\bllm\b/i.test(code));
  ok('no ranking/optimisation of results', !/optimis|optimiz|\brank\b/i.test(code));
  ok('sorts are canonical only: session identity, then profile date', (code.match(/\.sort\(\(/g) || []).length === 2);
  ok('no threshold constant exists', !/threshold\s*[=:]|winRate|\bpnl\b|profit/i.test(code));
  ok('research/shadow only: no production importer yet', prodImporters().length === 0, prodImporters().join(','));
  function prodImporters() {
    const hits = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== 'gap-engine') walk(p); }
        else if (e.name.endsWith('.ts') && !/\.test\.ts$/.test(e.name) && !p.includes(path.join('trading', 'gap-engine'))) {
          if (/opening-position|buildOpeningPositions/.test(fs.readFileSync(p, 'utf8'))) hits.push(path.relative(REPO, p));
        }
      }
    };
    walk(path.join(REPO, 'src'));
    return hits;
  }
}

// ── [H] ─────────────────────────────────────────────────────────────────────
console.log('\n[H] end-to-end through the real adapter + the row-60 value profile');
{
  const rep = run();
  eq('the profile block is consumed unchanged', rep.coverage.profilesIn, PROFILES.profiles.length);
  eq('the upstream value-profile version is carried, not assumed', rep.upstreamProfileVersion, PROFILES.version);
  ok('...and the basis used for each prior profile is recorded', rep.observations.filter((o) => o.status === 'OK').every((o) => typeof o.evidence.priorBasis === 'string'));
  const digest = crypto.createHash('sha256').update(rep.digest).digest('hex').slice(0, 16);
  ok('the replay digest is reproducible', crypto.createHash('sha256').update(run().digest).digest('hex').slice(0, 16) === digest);
  console.log(`  (fixture replay digest ${digest}; above=${rep.coverage.above} inside=${rep.coverage.inside} below=${rep.coverage.below})`);
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) { console.log('FAILED:'); failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
process.exit(0);
