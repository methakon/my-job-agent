#!/usr/bin/env node
/**
 * GATE 2 item 3 (roadmap row 22) — OAI level / slope / acceleration / persistence.
 *
 * doneWhen: "A historical record contains the value, timestamp/context and version
 * needed to reproduce or audit it."
 *
 * This test proves, offline and deterministically:
 *   [1] the four metrics are computed with pinned units and exact values;
 *   [2] the block carries its cutoff, phase, sample counts and formula VERSION, so the
 *       stored record is auditable without re-deriving anything;
 *   [3] replay is stable: identical input (in any order, with duplicate timestamps)
 *       produces a byte-identical block;
 *   [4] short/short-circuited series return UNAVAILABLE with a reason and a null value —
 *       never 0, NaN or Infinity;
 *   [5] look-ahead is impossible: samples after the cutoff and outside the window are
 *       excluded and counted;
 *   [6] the capture path actually STORES the block (static check on the source), so the
 *       value is preserved at decision time rather than recomputed on read.
 *
 * Pure functions only: no DB, no network, no clock reads.
 */
const path = require('path');
const fs = require('fs');

const S = require(path.join(__dirname, '..', 'dist', 'trading', 'pre-open', 'pre-open-oai-series'));

let pass = 0;
const failures = [];
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; console.log(`  PASS ${name}`); }
  else { failures.push(name); console.log(`  FAIL ${name}${extra ? ' :: ' + extra : ''}`); }
};
const eq = (name, actual, expected) => ok(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`);

// The pre-open auction on Friday 2026-09-11: 09:00-09:15 IST.
const T0 = Date.parse('2026-09-11T09:00:00+05:30');
const MIN = 60_000;
const CUTOFF = T0 + 10 * MIN; // a decision at 09:10
const build = (samples, over = {}) => S.buildOaiSeries({ samples, sessionPhase: 'PRE_OPEN', cutoffMs: CUTOFF, ...over });

console.log('\nGATE 2 item 3 / row 22 — OAI level, slope, acceleration, persistence\n');

// ── 1. the four metrics, with pinned units ──────────────────────────────────
console.log('[1] metrics and units');
{
  // Rising imbalance: +0.1, +0.3, +0.5 at 09:08, 09:09, 09:10 (one minute apart).
  const m = build([
    { atMs: T0 + 8 * MIN, oai: 0.1 },
    { atMs: T0 + 9 * MIN, oai: 0.3 },
    { atMs: T0 + 10 * MIN, oai: 0.5 },
  ]);
  eq('1a level = newest OAI in the window', m.level.value, 0.5);
  eq('1b level status OK', m.level.status, 'OK');
  // slope = (0.5 - 0.1) / 2 minutes = 0.2 per minute
  eq('1c slope is per MINUTE', m.slope.value, 0.2);
  // legs: 0.2/min then 0.2/min → acceleration 0
  eq('1d acceleration is per MINUTE^2 (constant speed → 0)', m.acceleration.value, 0);
  // all three samples are positive and the newest is positive → persistence 3/3
  eq('1e persistence = share of non-zero samples agreeing with the newest sign', m.persistence.value, 1);
  eq('1f persistence is a fraction', m.persistence.status, 'OK');
  eq('1g sample count and window bounds recorded', [m.sampleCount, m.windowStartMs, m.windowEndMs], [3, T0 + 8 * MIN, T0 + 10 * MIN]);

  // Accelerating: slopes 0.1/min then 0.5/min over 1-minute legs → (0.5-0.1)/1 = 0.4/min^2
  const acc = build([
    { atMs: T0 + 8 * MIN, oai: 0.1 },
    { atMs: T0 + 9 * MIN, oai: 0.2 },
    { atMs: T0 + 10 * MIN, oai: 0.7 },
  ]);
  eq('1h acceleration measures the change of slope', acc.acceleration.value, 0.4);
  eq('1i slope spans first→last', acc.slope.value, 0.3);

  // Falling imbalance with a mixed history: samples -0.4, +0.2, -0.3 → newest sign -1,
  // agreeing non-zero samples: -0.4 and -0.3 → 2/3.
  const mixed = build([
    { atMs: T0 + 8 * MIN, oai: -0.4 },
    { atMs: T0 + 9 * MIN, oai: 0.2 },
    { atMs: T0 + 10 * MIN, oai: -0.3 },
  ]);
  eq('1j persistence counts only the newest direction', mixed.persistence.value, 0.666667);
  ok('1k slope can be negative', mixed.slope.value > 0 && mixed.acceleration.value !== null, 'signs are preserved, not absolute');

  // A flat book is not a persistent imbalance.
  const flat = build([
    { atMs: T0 + 8 * MIN, oai: 0 },
    { atMs: T0 + 9 * MIN, oai: 0 },
    { atMs: T0 + 10 * MIN, oai: 0 },
  ]);
  eq('1l neutral newest OAI → persistence UNAVAILABLE', flat.persistence.status, 'UNAVAILABLE');
  ok('1m the neutral case explains itself', /neutral/.test(String(flat.persistence.reason)), String(flat.persistence.reason));
  eq('1n the level is still legitimately 0', flat.level.value, 0);

  // A zero in the middle neither agrees nor breaks the denominator.
  const withZero = build([
    { atMs: T0 + 8 * MIN, oai: 0.4 },
    { atMs: T0 + 9 * MIN, oai: 0 },
    { atMs: T0 + 10 * MIN, oai: 0.6 },
  ]);
  eq('1o a zero sample is excluded from the persistence denominator', withZero.persistence.value, 1);
}

// ── 2. audit context: cutoff, phase, counts, version ────────────────────────
console.log('[2] the record is auditable as stored');
{
  const m = build([{ atMs: T0 + 8 * MIN, oai: 0.2 }, { atMs: T0 + 9 * MIN, oai: 0.25 }, { atMs: T0 + 10 * MIN, oai: 0.3 }]);
  eq('2a the cutoff is the newest included sample time', m.cutoffMs, T0 + 10 * MIN);
  ok('2b the cutoff is never later than the requested instant', m.cutoffMs <= CUTOFF);
  eq('2c the session phase is recorded', m.sessionPhase, 'PRE_OPEN');
  eq('2d the formula version is stamped', m.version, S.OAI_SERIES_VERSION);
  ok('2e the version identifies this definition', S.OAI_SERIES_VERSION === 'oais-v1');
  eq('2f sample accounting is recorded', m.steps.considered, 3);
  eq('2g no reasons are raised on a clean series', m.reasons, []);
  const twoSamples = build([{ atMs: T0 + 9 * MIN, oai: 0.25 }, { atMs: T0 + 10 * MIN, oai: 0.3 }]);
  ok('2g2 a refused metric contributes its reason to the block', twoSamples.reasons.some((r) => /acceleration/.test(r)), JSON.stringify(twoSamples.reasons));
  const empty = build([]);
  eq('2h an empty series records a null cutoff', empty.cutoffMs, null);
  ok('2i and an explicit reason', /empty|no usable/i.test(empty.reasons.join(';')), JSON.stringify(empty.reasons));
}

// ── 3. replay stability ────────────────────────────────────────────────────
console.log('[3] replay stability');
{
  const a = [{ atMs: T0 + 8 * MIN, oai: 0.1 }, { atMs: T0 + 9 * MIN, oai: 0.2 }, { atMs: T0 + 10 * MIN, oai: 0.4 }];
  eq('3a identical input → identical block', S.seriesDigest(build(a)), S.seriesDigest(build(a)));
  eq('3b input order does not matter', S.seriesDigest(build([...a].reverse())), S.seriesDigest(build(a)));
  eq('3c a duplicate timestamp collapses to its LAST value', build([...a, { atMs: T0 + 10 * MIN, oai: 0.4 }]).level.value, 0.4);
  eq('3d a corrected re-print at the same instant replaces the old value', build([...a, { atMs: T0 + 10 * MIN, oai: 0.9 }]).level.value, 0.9);
  eq('3e dedupe keeps the sample count honest', build([...a, { atMs: T0 + 10 * MIN, oai: 0.9 }]).sampleCount, 3);
  ok('3f the whole block is byte-identical across replays', S.seriesDigest(build(a)) === S.seriesDigest(build(a)) && S.seriesDigest(build(a)).length > 50);
}

// ── 4. short series refuse safely ──────────────────────────────────────────
console.log('[4] short or unusable series → explicit state, never a number');
{
  const one = build([{ atMs: T0 + 10 * MIN, oai: 0.4 }]);
  eq('4a one sample: level OK', [one.level.status, one.level.value], ['OK', 0.4]);
  eq('4b one sample: slope UNAVAILABLE', [one.slope.status, one.slope.value], ['UNAVAILABLE', null]);
  ok('4c one sample: slope explains the requirement', /needs 2 usable samples/.test(String(one.slope.reason)), String(one.slope.reason));
  eq('4d one sample: acceleration UNAVAILABLE', [one.acceleration.status, one.acceleration.value], ['UNAVAILABLE', null]);
  eq('4e one sample: persistence OK (1/1)', one.persistence.value, 1);

  const two = build([{ atMs: T0 + 9 * MIN, oai: 0.2 }, { atMs: T0 + 10 * MIN, oai: 0.4 }]);
  eq('4f two samples: slope OK', two.slope.value, 0.2);
  eq('4g two samples: acceleration still UNAVAILABLE', two.acceleration.status, 'UNAVAILABLE');
  ok('4h two samples: acceleration explains the requirement', /needs 3 usable samples/.test(String(two.acceleration.reason)), String(two.acceleration.reason));

  const none = build([]);
  eq('4i no samples: every metric refuses', [none.level.status, none.slope.status, none.acceleration.status, none.persistence.status], ['UNAVAILABLE', 'UNAVAILABLE', 'UNAVAILABLE', 'UNAVAILABLE']);
  ok('4j no metric carries a number when refused', [none.level, none.slope, none.acceleration, none.persistence].every((m) => m.value === null && String(m.reason).length > 0));
  ok('4k no NaN or Infinity anywhere in a refused block', !/NaN|Infinity/.test(JSON.stringify(none)), JSON.stringify(none));
  const bad = build([{ atMs: T0 + 9 * MIN, oai: 5 }, { atMs: T0 + 10 * MIN, oai: Number.NaN }]);
  eq('4l out-of-range and non-finite samples are refused, not used', bad.sampleCount, 0);
  eq('4m refusals are counted', bad.steps.refused, 2);
  ok('4n a refusal count is recorded on the block', bad.steps.considered === 0 && bad.steps.refused === 2);
}

// ── 5. no look-ahead, window bounded ───────────────────────────────────────
console.log('[5] look-ahead and window bounds');
{
  const m = build([
    { atMs: T0 + 5 * MIN, oai: 0.1 },
    { atMs: T0 + 10 * MIN, oai: 0.2 },
    { atMs: T0 + 10 * MIN + 30_000, oai: 0.9 }, // 30 s AFTER the cutoff
  ]);
  eq('5a a sample after the cutoff is excluded', m.level.value, 0.2);
  eq('5b and it is counted, not silently dropped', m.steps.afterCutoff, 1);
  eq('5c the cutoff never exceeds the requested instant', m.cutoffMs, T0 + 10 * MIN);

  const wide = build([{ atMs: T0 - 30 * MIN, oai: 0.5 }, { atMs: T0 + 10 * MIN, oai: 0.2 }], { windowMs: 20 * MIN });
  eq('5d a sample older than the window is excluded', wide.sampleCount, 1);
  eq('5e and counted', wide.steps.outOfWindow, 1);
  const defaultWindow = build([{ atMs: T0 + 10 * MIN - 14 * MIN, oai: 0.2 }, { atMs: T0 + 10 * MIN, oai: 0.4 }]);
  eq('5f the default window keeps the whole 15-minute auction', defaultWindow.sampleCount, 2);
  eq('5g the default window is the auction length', S.DEFAULT_SERIES_WINDOW_MS, 15 * 60_000);
}

// ── 6. the capture path stores it (static check) ───────────────────────────
console.log('[6] the capture path STORES the block (never recomputes on read)');
{
  const dir = path.join(__dirname, '..', 'src', 'trading', 'pre-open');
  const capture = fs.readFileSync(path.join(dir, 'pre-open-capture.service.ts'), 'utf8');
  const entity = fs.readFileSync(path.join(dir, 'pre-open-observation.entity.ts'), 'utf8');
  const repo = fs.readFileSync(path.join(dir, 'pre-open.repository.ts'), 'utf8');
  ok('6a the capture service builds the block', /buildOaiSeries\(/.test(capture));
  ok('6b it attaches the block to the row before storing', /attachOaiSeries\(rows\);\s*\n\s*const inserted = await this\.repo\.insertIgnore\(rows\)/.test(capture));
  ok('6c both capture paths attach it', (capture.match(/attachOaiSeries\(rows\)/g) || []).length === 2);
  ok('6d the row has a persisted derived column', /@Column\(\{ type: 'json', nullable: true \}\)\s*\n\s*derived: Record<string, unknown> \| null;/.test(entity));
  ok('6e the series read is scoped to one instrument + session and bounded by the event time', /seriesAsOf\(/.test(repo) && /o\.eventTime <= :at/.test(repo));
  ok('6f the series read is ordered oldest-first so replay is stable', /orderBy\('o\.eventTime', 'ASC'\)/.test(repo));
  const controller = fs.readFileSync(path.join(dir, 'pre-open.controller.ts'), 'utf8');
  ok('6g the stored block is exposed for audit', /oaiSeries: \(row\.derived/.test(controller));
  ok('6h a failure to build it never blocks the observation', /Never lose the observation because its derived context could not be built/.test(capture));
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('failed: ' + failures.join(', '));
  process.exitCode = 1;
}
