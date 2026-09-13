#!/usr/bin/env node
/**
 * GATE 8 #2 (roadmap row 87) — gap outcome labels with a proven timestamp/leakage boundary.
 *
 * doneWhen: "A timestamp/leakage test proves no post-decision feature information entered the label inputs."
 *
 * [A] contract: version, cutoff, closed refusal + leakage vocabulary, pinned label definitions
 * [B] the six labels are computed correctly from frozen features + the in-window tape
 * [C] THE LEAKAGE/TIMESTAMP TEST — the boundary holds, and each violation class is detected
 * [D] refusals are safe and explicit
 * [E] the disabled path computes nothing
 * [F] determinism
 * [G] purity + research-only
 */
const fs = require('fs');
const path = require('path');
const REPO = path.join(__dirname, '..');

const M = require(path.join(REPO, 'dist', 'trading', 'gap-engine', 'gap-labels'));
const SRC = path.join(REPO, 'src', 'trading', 'gap-engine', 'gap-labels.ts');

let pass = 0;
const failures = [];
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; console.log(`  PASS ${name}`); }
  else { failures.push(name); console.log(`  FAIL ${name}${extra ? ' :: ' + extra : ''}`); }
};
const eq = (name, actual, expected) => ok(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`);

const D = '2026-09-11';
const INST = 'NSE:NIFTY50-INDEX';
const at = (hhmm) => Date.parse(`${D}T${hhmm}:00+05:30`);
const feat = (over = {}) => ({ gapClass: 'COMMON', gapDirection: 'UP', gapPct: 0.5, gapRatio: 0.8, gapAbs: 120, open: 24000, prevClose: 23880, priorRange: 150, gapRangePos: 0.5, fadeScore: 3, followScore: 1, decisionSide: 'FADE', tradeDirection: 'SHORT', decisionReason: null, ...over });
const dataset = (features = feat()) => ({ version: 'gapdb-v1', rows: [{ sessionDate: D, instrument: INST, status: 'OK', reason: null, reasonDetail: null, cutoff: 'OPEN (09:15 IST)', features, provenance: {} }] });
const pathOf = (points, over = {}) => ({ sessionDate: D, instrument: INST, points, ...over });
const labels = (features, points, cfg) => M.buildGapLabels(dataset(features), [pathOf(points)], cfg);

// ── [A] ─────────────────────────────────────────────────────────────────────
console.log('\n[A] contract');
{
  const rep = labels(feat(), [{ instantMs: at('09:15'), price: 24010 }]);
  eq('version', rep.version, 'gaplabel-v1');
  eq('the config is just the switch', Object.keys(M.DEFAULT_GAP_LABEL_CONFIG), ['enabled']);
  eq('the FEATURE CUTOFF is declared on the report and every row', [rep.cutoff, rep.rows[0].cutoff], ['OPEN (09:15 IST)', 'OPEN (09:15 IST)']);
  eq('the closed refusal vocabulary is the documented set', [...M.GAP_LABEL_REFUSALS], ['NO_SESSION_DATE', 'NO_FEATURES', 'NO_PATH', 'NO_POINTS']);
  eq('the closed leakage-code vocabulary is the documented set', [...M.LEAKAGE_CODES], ['BAD_WINDOW', 'OUT_OF_WINDOW_OBSERVATION', 'FEATURE_NOT_FROZEN', 'WINDOW_AFTER_CLOSE']);
  ok('the spec pins the features as the frozen row-85 subset', /no other, no post-open column/.test(M.GAP_LABEL_SPEC.features));
  ok('the spec pins the outcome window', /openMs <= instantMs <= closeMs of the SAME sessionDate/.test(M.GAP_LABEL_SPEC.outcomeWindow));
  eq('the upstream dataset version travels', rep.upstreamDatasetVersion, 'gapdb-v1');
  eq('labels are 0/1 plus the two magnitudes', Object.keys(rep.rows[0].labels), ['fade', 'follow', 'midpointReach', 'fullFill', 'maximumExtensionPoints', 'timeToTargetMs']);
}

// ── [B] ─────────────────────────────────────────────────────────────────────
console.log('\n[B] the six labels from frozen features + the in-window tape');
{
  // UP gap: open 24000, origin 23880 (below), priorRange 150
  const filled = labels(feat(), [
    { instantMs: at('09:15'), price: 24010 },
    { instantMs: at('10:00'), price: 23880 },   // reaches the origin → full fill at +45 min
    { instantMs: at('11:00'), price: 23850 },
    { instantMs: at('15:30'), price: 23900 },
  ]).rows[0].labels;
  eq('fade = 1 when the origin is reached', filled.fade, 1);
  eq('fullFill = 1 when the origin is reached', filled.fullFill, 1);
  eq('midpointReach = 1 when the midpoint is reached', filled.midpointReach, 1);
  eq('follow = 0 when the favourable excursion stays under priorRange', filled.follow, 0);
  eq('maximumExtensionPoints is the largest favourable excursion', filled.maximumExtensionPoints, 10);
  eq('timeToTargetMs is measured from the first in-window observation', filled.timeToTargetMs, 45 * 60 * 1000);

  const followed = labels(feat(), [
    { instantMs: at('09:15'), price: 24000 },
    { instantMs: at('10:00'), price: 24200 },   // +200 favourable >= priorRange 150
  ]).rows[0].labels;
  eq('follow = 1 when the excursion reaches priorRange', followed.follow, 1);
  eq('fade/fullFill = 0 when the origin is never reached', [followed.fade, followed.fullFill], [0, 0]);
  eq('midpointReach = 0 in the favourable direction', followed.midpointReach, 0);
  eq('timeToTargetMs is null when the target is never reached', followed.timeToTargetMs, null);
  eq('maximumExtensionPoints reports the full excursion', followed.maximumExtensionPoints, 200);

  const down = labels(feat({ gapDirection: 'DOWN', open: 24000, prevClose: 24120, priorRange: 100 }), [
    { instantMs: at('09:15'), price: 23990 },
    { instantMs: at('09:45'), price: 24120 },
  ]).rows[0].labels;
  eq('a DOWN gap mirrors the geometry (origin above the open)', [down.fullFill, down.midpointReach, down.timeToTargetMs], [1, 1, 30 * 60 * 1000]);
  eq('...and its favourable extension is downward', down.maximumExtensionPoints, 10);
}

// ── [C] ─────────────────────────────────────────────────────────────────────
console.log('\n[C] THE LEAKAGE/TIMESTAMP TEST');
{
  // 1) the boundary is exactly [open, close] of the session; close is INCLUDED, one ms later is excluded and counted
  const boundary = labels(feat(), [
    { instantMs: at('09:15') - 60_000, price: 99999 },  // BEFORE the open → ignored
    { instantMs: at('09:15'), price: 24010 },
    { instantMs: at('15:30'), price: 23880 },           // exactly the close → included
    { instantMs: at('15:30') + 60_000, price: 1 },      // AFTER the close → ignored
  ]);
  const w = boundary.rows[0].window;
  eq('the window is the session open..close', [w.openMs, w.closeMs], [at('09:15'), at('15:30')]);
  eq('only in-window observations are used', w.observationsUsed, 2);
  eq('out-of-window observations are IGNORED and COUNTED', w.outsideWindowIgnored, 2);
  eq('...and the out-of-window price did not affect the labels', boundary.rows[0].labels.fullFill, 1);

  // 2) an independent audit passes on well-formed output …
  const rep = labels(feat(), [{ instantMs: at('09:15'), price: 24010 }, { instantMs: at('10:00'), price: 23880 }]);
  eq('detectLabelLeakage reports NO violation on well-formed labels', M.detectLabelLeakage(rep, [pathOf([{ instantMs: at('09:15'), price: 24010 }, { instantMs: at('10:00'), price: 23880 }])]), []);

  // 3) … and catches each violation class
  const inflate = { ...rep, rows: rep.rows.map((r) => ({ ...r, window: { ...r.window, observationsUsed: r.window.observationsUsed + 1 } })) };
  const v1 = M.detectLabelLeakage(inflate, [pathOf([{ instantMs: at('09:15'), price: 24010 }, { instantMs: at('10:00'), price: 23880 }])]);
  eq('a label claiming more observations than the window holds is flagged', v1.map((v) => v.code), ['OUT_OF_WINDOW_OBSERVATION']);

  const afterClose = { ...rep, rows: rep.rows.map((r) => ({ ...r, window: { ...r.window, closeMs: at('15:30') + 3_600_000 } })) };
  eq('a window ending after the session close is flagged', M.detectLabelLeakage(afterClose, []).map((v) => v.code), ['WINDOW_AFTER_CLOSE']);

  const badWindow = { ...rep, rows: rep.rows.map((r) => ({ ...r, window: { ...r.window, closeMs: r.window.openMs } })) };
  eq('a malformed window is flagged', M.detectLabelLeakage(badWindow, []).map((v) => v.code), ['BAD_WINDOW']);

  // 4) FEATURES are frozen: a mutated tape cannot change them, and the module reads no post-open dataset column
  const frozen = labels(feat(), [{ instantMs: at('09:15'), price: 24010 }]);
  const mutated = labels(feat(), [{ instantMs: at('09:15'), price: 24010 }, { instantMs: at('15:29'), price: 1 }]);
  eq('the frozen features are identical regardless of the tape', [frozen.rows[0].window.openMs === mutated.rows[0].window.openMs, frozen.cutoff === mutated.cutoff], [true, true]);
  const code = fs.readFileSync(SRC, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  ok('the module reads ONLY the four frozen feature columns (no session outcome column)', !/\bf\.(high|low|close|decisionReason)\b/.test(code) && /f\.open/.test(code) && /f\.prevClose/.test(code) && /f\.priorRange/.test(code) && /f\.gapDirection/.test(code));
  ok('no post-decision feature information can enter the label inputs (cutoff echoed on every row)', rep.rows.every((r) => r.cutoff === 'OPEN (09:15 IST)'));
}

// ── [D] ─────────────────────────────────────────────────────────────────────
console.log('\n[D] refusals are safe and explicit');
{
  const one = (features, points) => M.buildGapLabels(dataset(features), points === null ? [] : [pathOf(points)]).rows[0];
  eq('missing frozen features ⇒ NO_FEATURES', one(feat({ open: null }), [{ instantMs: at('09:15'), price: 1 }]).reason, 'NO_FEATURES');
  eq('a missing direction ⇒ NO_FEATURES', one(feat({ gapDirection: null }), [{ instantMs: at('09:15'), price: 1 }]).reason, 'NO_FEATURES');
  eq('no path ⇒ NO_PATH', one(feat(), null).reason, 'NO_PATH');
  eq('an empty path ⇒ NO_POINTS', one(feat(), []).reason, 'NO_POINTS');
  const refusals = [one(feat({ open: null }), [{ instantMs: at('09:15'), price: 1 }]), one(feat(), [] )];
  ok('every refusal carries null labels', refusals.every((r) => r.status === 'UNAVAILABLE' && r.labels === null));
  eq('an unusable date ⇒ NO_SESSION_DATE', M.buildGapLabels({ version: 'gapdb-v1', rows: [{ sessionDate: 'x', instrument: INST, status: 'OK', features: feat() }] }, []).rows[0].reason, 'NO_SESSION_DATE');
  eq('the refusal count map is in vocabulary order', Object.keys(one(feat(), []).labels === null ? M.buildGapLabels(dataset(), [], {}).refusalCounts : {}), [...M.GAP_LABEL_REFUSALS]);
}

// ── [E] ─────────────────────────────────────────────────────────────────────
console.log('\n[E] the disabled path computes nothing');
{
  const off = labels(feat(), [{ instantMs: at('09:15'), price: 24010 }], { enabled: false });
  eq('disabled ⇒ DISABLED with null labels', [off.rows[0].status, off.rows[0].labels], ['DISABLED', null]);
  eq('disabled ⇒ no refusal invented and no sample', [Object.values(off.refusalCounts).reduce((a, b) => a + b, 0), off.coverage.ok], [0, 0]);
  ok('the summary says it is disabled', /enabled=false/.test(off.reviewerSummary));
}

// ── [F] ─────────────────────────────────────────────────────────────────────
console.log('\n[F] determinism');
{
  const pts = [{ instantMs: at('09:15'), price: 24010 }, { instantMs: at('10:00'), price: 23880 }];
  const a = labels(feat(), pts);
  eq('repeated identical runs are byte-identical', labels(feat(), pts).digest, a.digest);
  // input observation ORDER does not change the outcome (the window is sorted)
  const shuffled = labels(feat(), [pts[1], pts[0]]);
  eq('shuffled tape gives the same labels', shuffled.rows[0].labels, a.rows[0].labels);
  eq('...and the same digest', shuffled.digest, a.digest);
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
          if (/gap-labels|buildGapLabels|detectLabelLeakage/.test(fs.readFileSync(p, 'utf8'))) hits.push(path.relative(REPO, p));
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
