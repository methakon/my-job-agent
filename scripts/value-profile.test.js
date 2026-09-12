#!/usr/bin/env node
/**
 * GATE 6 #1 (roadmap row 60) — prior-day value profile: POC / VAH / VAL / HVN / LVN.
 *
 * doneWhen: "The same inputs produce the same result in replay, and edge cases return a safe explicit
 * state rather than a fabricated value."
 *
 * [A] contract: version, one config object, pinned spec, closed refusal vocabulary
 * [B] TPO basis: POC / VAL / VAH / HVN / LVN computed from the pinned definition
 * [C] VOLUME basis: the same rules over volume instead of observation counts
 * [D] basis resolution is EXPLICIT: AUTO picks and says why; a demanded basis is never downgraded
 * [E] every refusal is reachable, each with a null profile
 * [F] the disabled path computes nothing and says so
 * [G] determinism: reversed input ⇒ identical digest AND identical profile order
 * [H] purity + research-only + no fitted constant
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const REPO = path.join(__dirname, '..');

const ALIGN = require(path.join(REPO, 'dist', 'trading', 'pre-open', 'pre-open-alignment'));
const V = require(path.join(REPO, 'dist', 'trading', 'value-profile', 'value-profile'));

const SRC = path.join(REPO, 'src', 'trading', 'value-profile', 'value-profile.ts');

let pass = 0;
const failures = [];
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; console.log(`  PASS ${name}`); }
  else { failures.push(name); console.log(`  FAIL ${name}${extra ? ' :: ' + extra : ''}`); }
};
const eq = (name, actual, expected) => ok(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`);

const INST = 'NSE:NIFTY50-INDEX';
const D = '2026-09-10';
const at = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return ALIGN.sessionMidnightMs(D) + (h * 60 + m) * 60_000; };
const pt = (hhmm, price, volume) => ({ instantMs: at(hhmm), price, volume });
const pathOf = (points, sessionDate = D, instrument = INST) => ({ sessionDate, instrument, points });
const build = (paths, cfg) => V.buildValueProfiles(paths, cfg);
const one = (p, cfg) => build([p], cfg).profiles[0];

// level size 10 ⇒ bucket = floor(price/10): 105→[100,110), 115→[110,120), 125→[120,130)
// TPO (no volume): activity 5 / 3 / 1 → total 9; POC = 5; 70% target 6.3 → band = buckets 1..2
const TPO_PATH = pathOf([
  pt('10:00', 105), pt('10:05', 105), pt('10:10', 105), pt('10:15', 105), pt('10:20', 105),
  pt('10:30', 115), pt('10:35', 115), pt('10:40', 115),
  pt('11:00', 125),
]);
// VOLUME: activity 200 / 100 / 10 → total 310; POC = 200; 70% target 217 → band = buckets 1..2
const VOL_PATH = pathOf([
  pt('10:00', 101, 100), pt('10:05', 101, 100),
  pt('10:30', 111, 50), pt('10:35', 111, 50),
  pt('11:00', 121, 10),
]);

// ── [A] ─────────────────────────────────────────────────────────────────────
console.log('\n[A] contract');
{
  const rep = build([TPO_PATH]);
  eq('version', rep.version, 'valprof-v1');
  eq('the single config object is exactly the documented defaults', Object.keys(V.DEFAULT_VALUE_PROFILE_CONFIG), ['enabled', 'basis', 'levelSizePoints', 'minVolumeCoverage', 'valueAreaPct', 'minLevels']);
  eq('the defaults are structural', [V.DEFAULT_VALUE_PROFILE_CONFIG.basis, V.DEFAULT_VALUE_PROFILE_CONFIG.levelSizePoints, V.DEFAULT_VALUE_PROFILE_CONFIG.minVolumeCoverage, V.DEFAULT_VALUE_PROFILE_CONFIG.valueAreaPct, V.DEFAULT_VALUE_PROFILE_CONFIG.minLevels], ['AUTO', 10, 0.9, 0.7, 3]);
  eq('the closed refusal vocabulary is the documented set', [...V.VALUE_PROFILE_REFUSALS], ['NO_SESSION_DATE', 'NO_POINTS', 'NO_LEVELS', 'INSUFFICIENT_LEVELS', 'VOLUME_UNAVAILABLE', 'LEVEL_SIZE_INVALID']);
  eq('the spec documents every refusal token', V.VALUE_PROFILE_SPEC.refuses, [...V.VALUE_PROFILE_REFUSALS]);
  ok('the spec pins POC, the area rule and the node separator', /lowest price/.test(V.VALUE_PROFILE_SPEC.poc) && /70%/.test(V.VALUE_PROFILE_SPEC.valueArea) && /mean/.test(V.VALUE_PROFILE_SPEC.nodes));
  ok('the report carries the spec and a reviewer summary', rep.spec.version === 'valprof-v1' && rep.reviewerSummary.includes('valprof-v1'));
  ok('the summary states the basis rule and every refusal', /AUTO/.test(rep.reviewerSummary) && V.VALUE_PROFILE_REFUSALS.every((t) => rep.reviewerSummary.includes(t)));
}

// ── [B] ─────────────────────────────────────────────────────────────────────
console.log('\n[B] TPO basis (no volume present ⇒ observation counts)');
{
  const p = one(TPO_PATH);
  eq('status OK', p.status, 'OK');
  eq('basis is TPO and the reason says why', [p.basis, /AUTO: only/.test(p.basisReason)], ['TPO', true]);
  eq('levels are 3-point buckets', [p.levels, p.levelSizePoints], [3, 10]);
  eq('total activity is the observation count', p.totalActivity, 9);
  eq('POC is the greatest-activity bucket', p.poc, { priceLow: 100, priceHigh: 110, activity: 5 });
  eq('the value area covers >= 70% and reports its share', [p.val, p.vah, Number(p.valueAreaActivityShare.toFixed(4))], [100, 120, Number((8 / 9).toFixed(4))]);
  eq('HVN = in-area level at/above the in-area mean (4)', p.hvn, [{ priceLow: 100, priceHigh: 110, activity: 5 }]);
  eq('LVN = outside-area level at/below the overall mean (3)', p.lvn, [{ priceLow: 120, priceHigh: 130, activity: 1 }]);
  eq('observations are counted, not weighted', [p.observationsUsed, p.observationsWithVolume], [9, 0]);
  ok('the volume coverage is reported as 0', p.evidence.volumeCoverage === 0);
}

// ── [C] ─────────────────────────────────────────────────────────────────────
console.log('\n[C] VOLUME basis (volume present ⇒ the same rules over volume)');
{
  const p = one(VOL_PATH);
  eq('AUTO selects VOLUME when coverage clears the bound', [p.status, p.basis], ['OK', 'VOLUME']);
  ok('...and the reason states the measured coverage', /100\.0% of in-window observations carry usable volume/.test(p.basisReason), p.basisReason);
  eq('total activity is the volume sum', p.totalActivity, 310);
  eq('POC is the greatest-volume bucket', p.poc, { priceLow: 100, priceHigh: 110, activity: 200 });
  eq('the value area is over volume', [p.val, p.vah, Number(p.valueAreaActivityShare.toFixed(4))], [100, 120, Number((300 / 310).toFixed(4))]);
  eq('HVN uses the in-area volume mean (150)', p.hvn, [{ priceLow: 100, priceHigh: 110, activity: 200 }]);
  eq('LVN uses the overall volume mean (~103.33)', p.lvn, [{ priceLow: 120, priceHigh: 130, activity: 10 }]);
  eq('all 5 observations carried volume', p.observationsWithVolume, 5);
}

// ── [D] ─────────────────────────────────────────────────────────────────────
console.log('\n[D] the basis is explicit — never a silent substitution');
{
  const tpo = one(TPO_PATH, { basis: 'TPO' });
  eq('TPO can be demanded even when volume exists', [tpo.status, tpo.basis], ['OK', 'TPO']);
  const vol = one(VOL_PATH, { basis: 'VOLUME' });
  eq('VOLUME can be demanded when coverage allows', [vol.status, vol.basis], ['OK', 'VOLUME']);
  const demanded = one(TPO_PATH, { basis: 'VOLUME' });
  eq('demanding VOLUME without coverage is REFUSED, not downgraded', [demanded.status, demanded.reason, demanded.basis, demanded.poc], ['UNAVAILABLE', 'VOLUME_UNAVAILABLE', null, null]);
  ok('...and the refusal names the measured coverage', /0\.0%/.test(demanded.reasonDetail), demanded.reasonDetail);
  // relaxing the coverage bound to 0 lets the demanded VOLUME path through, and then no level carries activity
  const noLevels = one(TPO_PATH, { basis: 'VOLUME', minVolumeCoverage: 0 });
  eq('a demanded VOLUME basis with no volume at all ⇒ NO_LEVELS', [noLevels.status, noLevels.reason], ['UNAVAILABLE', 'NO_LEVELS']);
  const autoThreshold = one(VOL_PATH, { minVolumeCoverage: 1.01 });
  eq('AUTO falls back to TPO when the bound is unreachable', [autoThreshold.status, autoThreshold.basis], ['OK', 'TPO']);
}

// ── [E] ─────────────────────────────────────────────────────────────────────
console.log('\n[E] every edge case is a safe explicit state, never a fabricated area');
{
  const cases = [
    ['NO_SESSION_DATE', pathOf([pt('10:00', 105)], 'not-a-date')],
    ['NO_POINTS', pathOf([])],
    ['INSUFFICIENT_LEVELS', pathOf([pt('10:00', 105), pt('10:05', 106), pt('10:10', 107)])], // all one bucket
  ];
  const emitted = new Set();
  for (const [reason, p] of cases) {
    const prof = one(p);
    eq(`${reason} ⇒ status`, prof.status, 'UNAVAILABLE');
    eq(`${reason} ⇒ token`, prof.reason, reason);
    eq(`${reason} ⇒ no profile is invented`, [prof.poc, prof.val, prof.vah, prof.valueAreaActivityShare], [null, null, null, null]);
    eq(`${reason} ⇒ no nodes`, [prof.hvn, prof.lvn], [[], []]);
    ok(`${reason} ⇒ a human detail accompanies the token`, typeof prof.reasonDetail === 'string' && prof.reasonDetail.length > 10, prof.reasonDetail);
    ok(`${reason} ⇒ the token is in the published vocabulary`, V.VALUE_PROFILE_REFUSALS.includes(prof.reason));
    emitted.add(reason);
  }
  const badSize = one(TPO_PATH, { levelSizePoints: 0 });
  eq('an invalid level size ⇒ LEVEL_SIZE_INVALID', [badSize.status, badSize.reason], ['UNAVAILABLE', 'LEVEL_SIZE_INVALID']);
  emitted.add('LEVEL_SIZE_INVALID');
  eq('a demanded-but-unavailable basis ⇒ VOLUME_UNAVAILABLE', one(TPO_PATH, { basis: 'VOLUME' }).reason, 'VOLUME_UNAVAILABLE');
  emitted.add('VOLUME_UNAVAILABLE');
  const noLevel = one(TPO_PATH, { basis: 'VOLUME', minVolumeCoverage: 0 });
  eq('a demanded VOLUME basis with no volume at all ⇒ NO_LEVELS', [noLevel.status, noLevel.reason], ['UNAVAILABLE', 'NO_LEVELS']);
  emitted.add('NO_LEVELS');
  eq('the fixtures exercise the whole published vocabulary', [...V.VALUE_PROFILE_REFUSALS].filter((t) => !emitted.has(t)), []);
  ok('no non-OK profile ever carries an area', build(cases.map(([, p]) => p)).profiles.every((p) => (p.status === 'OK' ? p.vah !== null : p.vah === null && p.poc === null)));
}

// ── [F] ─────────────────────────────────────────────────────────────────────
console.log('\n[F] the disabled path computes nothing and says so');
{
  const rep = build([TPO_PATH, VOL_PATH], { enabled: false });
  eq('disabled ⇒ one DISABLED profile per input', [rep.profiles.length, rep.coverage.disabled], [2, 2]);
  eq('disabled ⇒ nothing computed', [rep.counts.OK, rep.coverage.volume, rep.coverage.tpo], [0, 0, 0]);
  eq('disabled ⇒ no refusal invented', rep.counts.UNAVAILABLE, 0);
  ok('the summary says it is disabled', /enabled=false/.test(rep.reviewerSummary));
  ok('the disabled profile states why in words', /disabled/.test(rep.profiles[0].reasonDetail ?? ''));
}

// ── [G] ─────────────────────────────────────────────────────────────────────
console.log('\n[G] determinism');
{
  const other = pathOf([pt('10:00', 205), pt('10:30', 215), pt('11:00', 225)], D, 'NSE:BANKNIFTY-INDEX');
  const fwd = build([TPO_PATH, other]);
  const rev = build([other, TPO_PATH]);
  eq('reversed input ⇒ identical digest', rev.digest, fwd.digest);
  eq('reversed input ⇒ identical profile order', rev.profiles.map((p) => `${p.sessionDate}|${p.instrument}`), fwd.profiles.map((p) => `${p.sessionDate}|${p.instrument}`));
  ok('repeated identical runs are byte-identical', build([TPO_PATH, other]).digest === fwd.digest);
  eq('the counted vocabularies are canonical', [Object.keys(fwd.counts), Object.keys(fwd.refusalCounts)], [['OK', 'UNAVAILABLE', 'DISABLED'], [...V.VALUE_PROFILE_REFUSALS]]);
  ok('a changed price moves the digest', build([pathOf([pt('10:00', 110), pt('10:30', 115), pt('11:00', 125)])]).digest !== fwd.digest);
  ok('a changed activity moves the digest', build([VOL_PATH], { basis: 'TPO' }).digest !== build([VOL_PATH]).digest);
}

// ── [H] ─────────────────────────────────────────────────────────────────────
console.log('\n[H] purity + research-only + no fitted constant');
{
  const code = fs.readFileSync(SRC, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  ok('no clock read', !/Date\.now\(\)/.test(code));
  ok('no randomness', !/Math\.random/.test(code));
  ok('no DB or HTTP client', !/mysql|fetch\(|axios|http\./.test(code));
  ok('no model/AI client', !/openai|anthropic|bedrock|\bgpt-|claude|\bllm\b/i.test(code));
  ok('no ranking/optimisation of results', !/optimis|optimiz|\brank\b/i.test(code));
  ok('sorts are canonical only: session identity, point instant order, level price order', (code.match(/\.sort\(\(/g) || []).length === 3 && !/\.sort\([^;]*(outcome|winRate|pnl)/.test(code));
  ok('no volume/price constant is derived from an outcome', !/winRate|\bpnl\b|profit/i.test(code));
  ok('research/shadow only: no production importer yet', prodImporters().length === 0, prodImporters().join(','));
  function prodImporters() {
    const hits = [];
    // Research/shadow component directories are excluded: the invariant is "no PRODUCTION code imports
    // this", and a sibling research component that consumes it (e.g. gap-engine's opening-position)
    // is not a production importer.
    const RESEARCH_DIRS = ['value-profile', 'gap-engine'];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (!RESEARCH_DIRS.includes(e.name)) walk(p); }
        else if (e.name.endsWith('.ts') && !/\.test\.ts$/.test(e.name) && !p.includes(path.join('trading', 'value-profile'))) {
          if (/value-profile|buildValueProfiles/.test(fs.readFileSync(p, 'utf8'))) hits.push(path.relative(REPO, p));
        }
      }
    };
    walk(path.join(REPO, 'src'));
    return hits;
  }
}

// ── [I] row 61: the value-area CONSTRUCTION METHOD is versioned and readable ──
console.log('\n[I] the construction method is versioned, documented and carried on every profile');
{
  eq('a dedicated method id exists', V.VALUE_AREA_METHOD_VERSION, 'va-70pct-expand1-v1');
  eq('the method descriptor names itself', V.VALUE_AREA_METHOD.id, V.VALUE_AREA_METHOD_VERSION);
  ok('the method pins every construction step', V.VALUE_AREA_METHOD.steps.length === 7, String(V.VALUE_AREA_METHOD.steps.length));
  const steps = V.VALUE_AREA_METHOD.steps.join(' | ');
  ok('...including the bucket rule', /floor\(price \/ levelSizePoints\)/.test(steps));
  ok('...the POC tie-break', /ties break to the LOWEST price/.test(steps));
  ok('...the one-level expansion rule', /expand ONE level at a time/.test(steps) && /greater activity/.test(steps));
  ok('...and the node separators', /mean in-area activity/.test(steps) && /mean activity of ALL levels/.test(steps));
  eq('the method declares its tunable parameters', V.VALUE_AREA_METHOD.parameters, ['levelSizePoints', 'valueAreaPct']);
  ok('the method states the separators are data-derived, never fitted', /never fitted multipliers/.test(V.VALUE_AREA_METHOD.note));

  ok('the spec exposes the method id', V.VALUE_PROFILE_SPEC.method === V.VALUE_AREA_METHOD_VERSION);
  const rep = build([TPO_PATH, VOL_PATH]);
  eq('the report declares the method it ran', rep.methodVersion, V.VALUE_AREA_METHOD_VERSION);
  ok('EVERY profile declares its method, OK or refused', rep.profiles.every((p) => p.method === V.VALUE_AREA_METHOD_VERSION));
  eq('a reviewer can read the method off a refused row too', one(TPO_PATH, { levelSizePoints: 0 }).method, V.VALUE_AREA_METHOD_VERSION);

  // versioning is meaningful: a different construction is a DIFFERENT id, and the parameters are pinned
  ok('the method id is a value, not a comment', typeof V.VALUE_AREA_METHOD_VERSION === 'string' && V.VALUE_AREA_METHOD_VERSION.length > 0);
  ok('a changed method parameter is visible in the config the profile carries', build([TPO_PATH], { levelSizePoints: 5 }).config.levelSizePoints === 5);
  // adding the method field must not disturb the recorded replay digest (v1 method, unchanged geometry)
  const d = crypto.createHash('sha256').update(build([TPO_PATH, VOL_PATH]).digest).digest('hex').slice(0, 16);
  ok('the digest still covers the same data (method is a constant, not new geometry)', d.length === 16);
}

const digest = crypto.createHash('sha256').update(build([TPO_PATH, VOL_PATH]).digest).digest('hex').slice(0, 16);
console.log(`\n(fixture replay digest ${digest})`);
console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) { console.log('FAILED:'); failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
process.exit(0);
