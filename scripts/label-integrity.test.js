#!/usr/bin/env node
/**
 * GATE 12 #5 (roadmap row 159) — the timestamp/leakage test.
 *
 * doneWhen: "A timestamp/leakage test proves no post-decision feature information
 * entered the label inputs."
 *
 * The learning dataset is `pattern_signals`: one row per decision, carrying the
 * features visible at the decision cutoff plus the forward outcome labels written
 * later. The proof has to show, deterministically:
 *
 *   [1] the row records the cutoff its features were derived from;
 *   [2] labelling leaves the feature vector byte-identical (frozen), and the label
 *       patch may only ever contain label fields;
 *   [3] the freeze cannot be bypassed — a patch touching a feature field, or an
 *       unknown field, is refused (fail closed);
 *   [4] the FEATURE side never receives a tick newer than the cutoff;
 *   [5] the OUTCOME side is strictly after the cutoff and inside the horizon, and a
 *       horizon the tape never reached is never promoted to a result;
 *   [6] identical inputs replay to identical output;
 *   [7] the real writer path goes through the guard (static check on the source).
 *
 * Pure functions only: no DB, no network, no clock reads (every timestamp is a
 * parameter), so this test is itself replayable.
 */
const path = require('path');
const fs = require('fs');

const L = require(path.join(__dirname, '..', 'dist', 'trading', 'pattern-engine', 'label-integrity'));
const F = require(path.join(__dirname, '..', 'dist', 'trading', 'pattern-engine', 'pattern-features'));

let pass = 0;
const failures = [];
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; console.log(`  PASS ${name}`); }
  else { failures.push(name); console.log(`  FAIL ${name}${extra ? ' :: ' + extra : ''}`); }
};
const eq = (name, actual, expected) => ok(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`);

// A fixed decision instant: Friday 2026-09-11 10:30:00 IST.
const CUTOFF = Date.parse('2026-09-11T10:30:00+05:30');
const MIN = 60_000;

const decisionTicks = [
  { ts: new Date(CUTOFF - 60 * MIN), price: 100, volume: 10 },
  { ts: new Date(CUTOFF - 5 * MIN), price: 100.4, volume: 12 },
  { ts: new Date(CUTOFF), price: 100.5, volume: 30 }, // the entry tick — decision-time information
];
const leakyTick = { ts: new Date(CUTOFF + 30_000), price: 106, volume: 99 };
const featurePayload = { components: { breakout: 0.7 }, entryState: 'ARMED', penalties: [], chain: { pcr: 1.1 } };
const frozenFeatures = L.withFeatureCutoff(featurePayload, { featureCutoffMs: CUTOFF, bucketMs: 5 * MIN, strategyVersion: 'pattern-engine-v1' });
const row = {
  id: 'sig-1', contractSymbol: 'NIFTY26SEP23000PE', underlying: 'NIFTY', strategyVersion: 'pattern-engine-v1',
  ltp: 100.5, bid: 100.4, ask: 100.6, spreadPct: 0.002, pcr: 1.1, targetPct: 0.2, stopPct: 0.1,
  signalTs: new Date(CUTOFF), bucketTs: new Date(CUTOFF), confidence: 0.66,
  features: frozenFeatures, outcomeLabel: 'PENDING', labelledAt: null,
};
const applyPatch = (base, patch) => ({ ...base, ...patch });

console.log('\nGATE 12 #5 / row 159 — strict future-only labels with frozen feature cutoffs\n');

// ── 1. the cutoff is recorded on the row and read back, never guessed ─────────
console.log('[1] recorded feature cutoff');
{
  eq('1a the cutoff is stored inside the frozen feature payload', frozenFeatures.cutoff.featureCutoffMs, CUTOFF);
  eq('1b the cutoff travels with its strategy version', frozenFeatures.cutoff.strategyVersion, 'pattern-engine-v1');
  eq('1c featureCutoffOf reads it back', L.featureCutoffOf(row), CUTOFF);
  eq('1d a legacy row with no recorded cutoff reports null (never inferred)', L.featureCutoffOf({ features: { components: {} } }), null);
  eq('1e a row with no features at all reports null', L.featureCutoffOf({}), null);
  const reordered = { chain: { pcr: 1.1 }, penalties: [], entryState: 'ARMED', components: { breakout: 0.7 }, cutoff: { strategyVersion: 'pattern-engine-v1', bucketMs: 5 * MIN, featureCutoffMs: CUTOFF } };
  ok('1f the digest ignores key insertion order', L.frozenFeatureDigest(reordered) === L.frozenFeatureDigest(frozenFeatures));
  ok('1g a CHANGED feature value changes the digest', L.frozenFeatureDigest({ ...frozenFeatures, entryState: 'READY' }) !== L.frozenFeatureDigest(frozenFeatures));
}

// ── 2. labelling leaves the feature vector byte-identical ────────────────────
console.log('[2] frozen features (the leakage proof)');
{
  const outcomes = [
    { horizonMinutes: 5, covered: true, coverage: 'FULL', label: 'CONTINUATION', maxFavourablePct: 0.9, maxAdversePct: -0.2 },
    { horizonMinutes: 10, covered: false, coverage: 'INSUFFICIENT', label: 'PENDING', maxFavourablePct: 1.1, maxAdversePct: -0.3 },
  ];
  const patch = L.buildLabelPatch({
    outcomeLabel: L.headlineLabel(outcomes), labelledAtMs: CUTOFF + 11 * MIN,
    maxFavourablePct: 1.1, maxAdversePct: -0.3,
    outcomes: L.labelEnvelope({ outcomes, coverageMinutes: 5, cutoffMs: L.featureCutoffOf(row), strategyVersion: row.strategyVersion }),
  });
  const after = applyPatch(row, patch);
  ok('2a feature vector identical before/after labelling', L.frozenFeatureDigest(after.features) === L.frozenFeatureDigest(row.features));
  ok('2b the recorded cutoff is unchanged by labelling', after.features.cutoff.featureCutoffMs === CUTOFF);
  ok('2c the label patch contains ONLY label fields', Object.keys(patch).every((k) => L.LABEL_FIELDS.includes(k)), Object.keys(patch).join(','));
  eq('2d LABEL_FIELDS is exactly the documented set', [...L.LABEL_FIELDS], ['outcomeLabel', 'labelledAt', 'maxFavourablePct', 'maxAdversePct', 'outcomes']);
  eq('2e the label write is accepted', L.validateLabelWrite(row, patch).violations, []);
  for (const field of ['features', 'ltp', 'spreadPct', 'signalTs', 'strategyVersion', 'confidence', 'pcr', 'targetPct', 'stopPct', 'bucketTs']) {
    ok(`2f ${field} is in the frozen feature set`, L.FROZEN_FEATURE_FIELDS.includes(field));
  }
}

// ── 3. the freeze cannot be bypassed ────────────────────────────────────────
console.log('[3] the freeze cannot be bypassed (fail closed)');
{
  const features = L.validateLabelWrite(row, { outcomeLabel: 'CONTINUATION', labelledAt: new Date(CUTOFF), features: {} });
  ok('3a a patch rewriting features is refused', features.ok === false);
  ok('3b the violation names the frozen field', features.violations.some((v) => v.startsWith('features:')), features.violations.join(','));
  const ltp = L.validateLabelWrite(row, { outcomeLabel: 'CONTINUATION', labelledAt: new Date(CUTOFF), ltp: 999 });
  ok('3c a patch touching the decision price is refused', ltp.ok === false && ltp.violations.some((v) => v === 'ltp:frozen-feature-field'), ltp.violations.join(','));
  const unknown = L.validateLabelWrite(row, { outcomeLabel: 'CONTINUATION', labelledAt: new Date(CUTOFF), someNewScore: 3 });
  ok('3d an unknown/new field is refused rather than allowed', unknown.ok === false && unknown.violations.some((v) => v === 'someNewScore:not-a-label-field'), unknown.violations.join(','));
  const noProvenance = L.validateLabelWrite(row, { outcomeLabel: 'CONTINUATION', labelledAt: new Date(CUTOFF), outcomes: { horizons: [{ horizonMinutes: 5, label: 'CONTINUATION' }] } });
  ok('3e a horizon without coverage provenance is refused', noProvenance.ok === false && noProvenance.violations.some((v) => v.includes('missing-coverage-provenance')), noProvenance.violations.join(','));
  const withProvenance = L.validateLabelWrite(row, { outcomeLabel: 'CONTINUATION', labelledAt: new Date(CUTOFF), outcomes: { horizons: [{ horizonMinutes: 5, label: 'CONTINUATION', covered: true, coverage: 'FULL' }] } });
  ok('3f the same horizon WITH provenance is accepted', withProvenance.ok === true, withProvenance.violations.join(','));
}

// ── 4. the feature side never sees a post-cutoff tick ───────────────────────
console.log('[4] feature inputs stop at the cutoff');
{
  const split = L.splitFeatureInputs([...decisionTicks, leakyTick], CUTOFF);
  eq('4a only ticks at/before the cutoff are usable for features', split.usable.length, 3);
  eq('4b the post-cutoff tick is separated, not silently dropped', split.afterCutoff.length, 1);
  eq('4c the leaked tick is named', L.leakedFeatureInputs([...decisionTicks, leakyTick], CUTOFF), [`tick@${CUTOFF + 30_000}`]);
  eq('4d a clean feature input list reports no leak', L.leakedFeatureInputs(split.usable, CUTOFF), []);
  ok('4e every usable tick is at or before the cutoff', split.usable.every((t) => t.ts.getTime() <= CUTOFF));
}

// ── 5. the outcome side is strictly after the cutoff, inside the horizon ────
console.log('[5] outcome inputs start after the cutoff');
{
  const horizon = 10 * MIN;
  const window = L.labelInputsWithinHorizon([...decisionTicks, leakyTick, { ts: new Date(CUTOFF + 11 * MIN), price: 108 }], { cutoffMs: CUTOFF, horizonMs: horizon });
  eq('5a the entry tick is decision-time information, not an outcome', window.outcomes.length, 1);
  eq('5b the cutoff tick is classified before/at the cutoff', window.beforeOrAtCutoff.length, 3);
  eq('5c a tick past the horizon is excluded', window.beyondHorizon.length, 1);
  ok('5d every outcome tick is inside (cutoff, cutoff+horizon]', window.outcomes.every((t) => t.ts.getTime() > CUTOFF && t.ts.getTime() <= CUTOFF + horizon));
}

// ── 6. coverage is honoured: an unreached horizon is never a result ─────────
console.log('[6] coverage provenance (never extrapolate)');
{
  const entryPrice = 100.5;
  const tape = [
    { ts: CUTOFF, price: entryPrice, volume: 5 },
    { ts: CUTOFF + 2 * MIN, price: 102, volume: 5 },
    { ts: CUTOFF + 6 * MIN, price: 101, volume: 5 },
  ];
  const outcomes = F.labelOutcomes({ entryPrice, entryTs: CUTOFF, futureTicks: tape, targetPct: 0.2, stopPct: 0.1, horizons: [5, 15] });
  const five = outcomes.find((o) => o.horizonMinutes === 5);
  const fifteen = outcomes.find((o) => o.horizonMinutes === 15);
  eq('6a the covered horizon is labelled', five.covered, true);
  eq('6b the horizon the tape has not reached is marked uncovered', fifteen.covered, false);
  eq('6c the headline label comes from the longest COVERED horizon', L.headlineLabel(outcomes), five.label);
  ok('6d the uncovered horizon is never promoted to the headline', L.headlineLabel(outcomes) === five.label && fifteen.covered === false);
  const distinct = [
    { horizonMinutes: 5, covered: true, coverage: 'FULL', label: 'TARGET_REACHED' },
    { horizonMinutes: 60, covered: false, coverage: 'INSUFFICIENT', label: 'PENDING' },
  ];
  eq('6d2 with distinct labels the covered one wins', L.headlineLabel(distinct), 'TARGET_REACHED');
  eq('6d3 when nothing is covered the result is PENDING, never a measured label', L.headlineLabel(distinct.map((d) => ({ ...d, covered: false }))), 'PENDING');
  const envelope = L.labelEnvelope({ outcomes, coverageMinutes: 5, cutoffMs: L.featureCutoffOf(row), strategyVersion: row.strategyVersion });
  eq('6e the stored envelope echoes the frozen cutoff', envelope.featureCutoffMs, CUTOFF);
  eq('6f the stored envelope keeps the coverage width actually measured', envelope.coverageMinutes, 5);
  eq('6g horizons are stored as measured, with their coverage', envelope.horizons.length, outcomes.length);
  const emptyTape = F.labelOutcomes({ entryPrice, entryTs: CUTOFF, futureTicks: [], targetPct: 0.2, stopPct: 0.1, horizons: [5] });
  eq('6h an empty tape labels nothing', emptyTape.length, 0);
  eq('6i no outcome in that case can be claimed', L.headlineLabel(emptyTape), null);
}

// ── 7. replay determinism ───────────────────────────────────────────────────
console.log('[7] replay determinism');
{
  const build = () => L.buildLabelPatch({ outcomeLabel: 'CONTINUATION', labelledAtMs: CUTOFF + 11 * MIN, maxFavourablePct: 1.1, maxAdversePct: -0.3, outcomes: { horizons: [], coverageMinutes: 5, featureCutoffMs: CUTOFF, strategyVersion: 'pattern-engine-v1' } });
  eq('7a identical inputs produce identical patches', JSON.stringify(build()), JSON.stringify(build()));
  ok('7b the patch never carries a decision field even when a row is in scope', Object.keys(build()).every((k) => L.LABEL_FIELDS.includes(k)));
  eq('7c the frozen digest is stable across repeated reads', L.frozenFeatureDigest(row.features), L.frozenFeatureDigest(row.features));
}

// ── 8. the real writer path goes through the guard ──────────────────────────
console.log('[8] the production writer uses the guard (static check)');
{
  const dir = path.join(__dirname, '..', 'src', 'trading', 'pattern-engine');
  const service = fs.readFileSync(path.join(dir, 'pattern-engine.service.ts'), 'utf8');
  ok('8a the service imports the integrity module', /from '\.\/label-integrity'/.test(service));
  ok('8b the service validates every label write', /validateLabelWrite\(/.test(service));
  ok('8c the service builds the patch through buildLabelPatch', /buildLabelPatch\(/.test(service));
  ok('8d the service records the cutoff at creation', /withFeatureCutoff\(/.test(service));
  ok('8e the headline label is chosen by the shared rule', /headlineLabel\(/.test(service));
  const updateCalls = service.split('signals.update(').slice(1);
  ok('8f there is exactly one writer on this.signals.update', updateCalls.length === 1, `${updateCalls.length} call sites`);
  // Static scan of every signals.update() patch in the pattern engine: no INLINE patch
  // object literal may name a frozen field. The second argument is extracted properly
  // (a variable such as the validated `patch` carries no fields of its own), so the
  // check stays precise instead of flagging unrelated code that follows the call.
  const callArguments = (text) => {
    const calls = [];
    let idx = 0;
    while ((idx = text.indexOf('signals.update(', idx)) !== -1) {
      let depth = 1;
      let cursor = text.indexOf('(', idx) + 1;
      const start = cursor;
      while (cursor < text.length && depth > 0) {
        if (text[cursor] === '(') depth += 1;
        else if (text[cursor] === ')') depth -= 1;
        cursor += 1;
      }
      calls.push(text.slice(start, cursor - 1));
      idx = cursor;
    }
    return calls;
  };
  const secondArgument = (args) => {
    let depth = 0;
    for (let i = 0; i < args.length; i += 1) {
      const c = args[i];
      if (c === '{' || c === '[' || c === '(') depth += 1;
      else if (c === '}' || c === ']' || c === ')') depth -= 1;
      else if (c === ',' && depth === 0) return args.slice(i + 1).trim();
    }
    return '';
  };
  const inlineLiteralFields = (literal) => {
    const fields = [];
    let depth = 0;
    for (let i = 0; i < literal.length; i += 1) {
      const c = literal[i];
      if (c === '{' || c === '[' || c === '(') depth += 1;
      else if (c === '}' || c === ']' || c === ')') depth -= 1;
      else if (depth === 1) {
        const rest = literal.slice(i);
        const match = /^([A-Za-z_$][\w$]*)\s*:/.exec(rest);
        if (match && (i === 1 || /[{,\s]/.test(literal[i - 1]))) fields.push(match[1]);
      }
    }
    return fields;
  };
  let violations = [];
  let inlinePatches = 0;
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.ts')) continue;
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    for (const args of callArguments(text)) {
      const argument = secondArgument(args);
      if (!argument.startsWith('{')) continue;
      inlinePatches += 1;
      for (const field of inlineLiteralFields(argument)) {
        if (L.FROZEN_FEATURE_FIELDS.includes(field)) violations.push(`${file}:${field}`);
      }
    }
  }
  eq('8g no inline signals.update patch names a frozen feature field', violations, []);
  ok('8h the scan actually inspected the inline patch(es) it claims to cover', inlinePatches >= 1, `${inlinePatches} inline patch object literal(s) inspected`);
  const featureFields = new Set(L.FROZEN_FEATURE_FIELDS);
  const labelFields = new Set(L.LABEL_FIELDS);
  const overlap = [...featureFields].filter((f) => labelFields.has(f));
  eq('8h the frozen set and the label set are disjoint', overlap, []);
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('failed: ' + failures.join(', '));
  process.exitCode = 1;
}
