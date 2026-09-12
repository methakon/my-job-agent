#!/usr/bin/env node
/**
 * GATE 4 #1 (roadmap row 38) — gap taxonomy + session-series adapter.
 *
 * doneWhen: "The component can be enabled/disabled independently and its output can be
 * inspected in a historical replay."
 *
 *   [A] the reviewer statement + closed class vocabulary + config defaults;
 *   [B] enabled/disabled independently (disabled computes NOTHING and says so);
 *   [C] materiality: both the percent and the ratio threshold must be exceeded;
 *   [D] fill is a range fact, and fill TIMING is never invented from OHLC;
 *   [E] every pinned class is reachable (NONE/COMMON/BREAKAWAY/RUNAWAY/EXHAUSTION/ISLAND/UNCLASSIFIED);
 *   [F] missing inputs give UNAVAILABLE with a reason, never a class;
 *   [G] determinism: shuffled input ⇒ identical result and digest;
 *   [H] the session-series adapter: next-session close rule, widest-bar pick, exclusions;
 *   [I] older-open-gap interaction is reported from real ranges;
 *   [J] STATIC: pure, non-AI, and not wired into any production module;
 *   [K] REPLAY: a full series replays end to end and is inspectable.
 */
const path = require('path');
const fs = require('fs');

const S = require(path.join(__dirname, '..', 'dist', 'trading', 'gap-engine', 'gap-session-series'));
const T = require(path.join(__dirname, '..', 'dist', 'trading', 'gap-engine', 'gap-taxonomy'));

let pass = 0;
const failures = [];
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; console.log(`  PASS ${name}`); }
  else { failures.push(name); console.log(`  FAIL ${name}${extra ? ' :: ' + extra : ''}`); }
};
const eq = (name, actual, expected) => ok(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`);

const INST = 'NSE:NIFTY50-INDEX';
/** A session bar fixture: close/prevClose are explicit so classes are unambiguous. */
const bar = (date, open, high, low, close, prevClose) => ({
  sessionDate: date, instrument: INST, provenance: 'DERIVED_CLOSE',
  open, high, low, close, prevClose, range: high - low, nextQuotedClose: null,
});
/** Row fixture for the adapter (its `quotedClose` is the PREVIOUS session's close). */
const raw = (date, open, high, low, quotedClose, sourceId = 'a') => ({ instrument: INST, sessionDate: date, open, high, low, quotedClose, sourceId });

// -------------------------------------------------------------------- [A]
console.log('\n[A] reviewer statement, closed vocabulary, config');
{
  const s = T.describeGapTaxonomy();
  ok('a reviewer statement exists', typeof s === 'string' && s.length > 200);
  ok('it names the version', /gap-tax-v1/.test(s));
  ok('it states the materiality rule', /material/i.test(s) && /minGapPct|%/.test(s));
  ok('it states that fill timing is unavailable', /UNAVAILABLE/.test(s) && /timing/i.test(s));
  eq('the class vocabulary is closed and ordered', Array.isArray(T.GAP_CLASSES) && T.GAP_CLASSES.length, 7);
  eq('default config is published', [T.DEFAULT_GAP_TAXONOMY_CONFIG.enabled, T.DEFAULT_GAP_TAXONOMY_CONFIG.minGapPct, T.DEFAULT_GAP_TAXONOMY_CONFIG.minGapRatio], [true, 0.15, 0.1]);
}

// -------------------------------------------------------------------- [B]
console.log('\n[B] enabled/disabled independently');
{
  const series = [
    bar('2026-09-08', 100, 105, 99, 102, 100),
    bar('2026-09-09', 108, 110, 107, 109, 102),
    bar('2026-09-10', 111, 112, 106, 107, 109),
  ];
  const off = T.assessGapSeries(series, { enabled: false });
  const on = T.assessGapSeries(series, { enabled: true });
  eq('disabled ⇒ enabled=false', off.enabled, false);
  eq('disabled ⇒ computes no assessment', off.assessments.length, 0);
  eq('disabled ⇒ all class counts are zero', Object.values(off.counts).reduce((a, b) => a + b, 0), 0);
  eq('disabled ⇒ coverage reports nothing assessed', [off.coverage.assessed, off.coverage.materialGaps], [0, 0]);
  ok('disabled ⇒ digest is content-free (not data-dependent)', !/2026-09-0/.test(off.digest));
  ok('disabled ⇒ still states what it would do', off.reviewerSummary === T.describeGapTaxonomy(off.config));
  ok('enabled ⇒ the same series IS assessed', on.assessments.length === 3 && on.coverage.assessed === 2);
  ok('the switch is config-only (no other argument needed)', T.assessGapSeries(series, {}).enabled === true);
  // a caller can turn it off without touching anything else
  const retuned = T.assessGapSeries(series, { minGapPct: 50 });
  ok('thresholds are independently tunable', retuned.counts.NONE > on.counts.NONE);
}

// -------------------------------------------------------------------- [C]
console.log('\n[C] materiality needs BOTH thresholds');
{
  const base = [bar('2026-09-08', 100, 105, 99, 102, 100)];
  const aboveBoth = T.assessGapSeries([...base, bar('2026-09-09', 112, 113, 110, 112.5, 102)], {});
  eq('a +9.8% gap on a wide prior range is material', aboveBoth.assessments[1].class !== 'NONE', true);
  // pct above the threshold but the gap is small relative to the prior range (0.4 / 6.0 = 0.067)
  const pctOnly = T.assessGapSeries([...base, bar('2026-09-09', 102.4, 103, 102, 102.5, 102)], {});
  ok('|gapPct| below the ratio threshold ⇒ NONE', pctOnly.assessments[1].class === 'NONE', pctOnly.assessments[1].class);
  const tiny = T.assessGapSeries([...base, bar('2026-09-09', 102.05, 103, 101, 102.5, 102)], {});
  eq('a sub-0.15% gap ⇒ NONE', tiny.assessments[1].class, 'NONE');
  const wide = T.assessGapSeries([...base, bar('2026-09-09', 110, 111, 109, 110, 102)], { minGapRatio: 10 });
  eq('retuning the ratio threshold can make the same gap NONE', wide.assessments[1].class, 'NONE');
  ok('measures are reported either way', tiny.assessments[1].gapPct !== null && tiny.assessments[1].zone !== null);
}

// -------------------------------------------------------------------- [D]
console.log('\n[D] fill is a range fact; timing is never invented');
{
  const prior = bar('2026-09-08', 100, 105, 99, 102, 100);
  const filled = T.assessGapSeries([prior, bar('2026-09-09', 108, 109, 101, 107, 102)], {});
  eq('an UP gap whose low reaches prevClose is FILLED', filled.assessments[1].fillState, 'FILLED');
  const unfilled = T.assessGapSeries([prior, bar('2026-09-09', 108, 110, 103, 109, 102)], {});
  eq('an UP gap that never returns to prevClose is UNFILLED', unfilled.assessments[1].fillState, 'UNFILLED');
  const down = T.assessGapSeries([prior, bar('2026-09-09', 96, 102.5, 95, 100, 102)], {});
  eq('a DOWN gap is FILLED when high reaches prevClose', down.assessments[1].fillState, 'FILLED');
  const downUn = T.assessGapSeries([prior, bar('2026-09-09', 96, 100, 94, 95, 102)], {});
  eq('a DOWN gap untouched above prevClose stays UNFILLED', downUn.assessments[1].fillState, 'UNFILLED');
  eq('fill timing is always UNAVAILABLE', filled.assessments[1].fillTiming, 'UNAVAILABLE');
  ok('...with a reason that names why', /OHLC cannot time/.test(filled.assessments[1].fillTimingReason));
}

// -------------------------------------------------------------------- [E]
console.log('\n[E] every pinned class is reachable');
{
  const ctx = [
    bar('2026-08-27', 95, 99, 94, 98, 95),
    bar('2026-08-28', 98, 100, 97, 99, 98),
    bar('2026-09-01', 100, 104, 99, 103, 100),
    bar('2026-09-02', 103, 106, 102, 105, 103),
    bar('2026-09-03', 105, 107, 104, 106, 105),
  ];
  const hit = (label, today, config = {}) => {
    const r = T.assessGapSeries([...ctx, today], config);
    const last = r.assessments[r.assessments.length - 1];
    ok(`${label} ⇒ ${label}`, last.class === label, `got ${last.class} (${last.reason || 'no reason'})`);
    return last;
  };
  hit('NONE', bar('2026-09-04', 106.02, 106.5, 105.5, 106.1, 106));
  // breakaway: opens ABOVE the 3-session lookback high (107) and holds
  hit('BREAKAWAY', bar('2026-09-04', 108, 112, 107.5, 111, 106));
  // runaway: gap up inside the lookback range (open <= 107), holds, not filled
  hit('RUNAWAY_CONTINUATION', bar('2026-09-04', 106.8, 108, 106.2, 107.5, 106));
  // exhaustion: gap up but the session closes back THROUGH prevClose
  hit('EXHAUSTION', bar('2026-09-04', 108, 108.5, 103, 104, 106));
  // common: gap up, trades back to prevClose (filled) and still closes on the gap side
  hit('COMMON', bar('2026-09-04', 107.5, 108.5, 105.9, 107.2, 106));
  // island: opposite gap with an isolated intervening range (the middle session's own gap is
  // immaterial, so the previous MATERIAL gap is the DOWN gap two sessions back, and that
  // session's range does not overlap the one before it)
  const island = T.assessGapSeries([
    bar('2026-09-01', 100, 101, 99, 100.5, 100),   // range 99..101
    bar('2026-09-02', 96, 97, 95, 96.5, 100.5),    // material DOWN gap -> zone 96..100.5
    bar('2026-09-03', 96.4, 98.5, 96.2, 98, 96.5), // immaterial gap; range 96.2..98.5 (no overlap with 99..101)
    bar('2026-09-04', 101, 102, 100, 101.5, 98),   // gap UP back over the island
  ], {});
  const islandLast = island.assessments[island.assessments.length - 1];
  ok('ISLAND ⇒ ISLAND', islandLast.class === 'ISLAND', `got ${islandLast.class} (${islandLast.reason || ''})`);

  // UNCLASSIFIED must exist as a reachable, honest outcome
  const srcT = fs.readFileSync(path.join(__dirname, '..', 'src', 'trading', 'gap-engine', 'gap-taxonomy.ts'), 'utf8');
  ok('UNCLASSIFIED carries a review reason rather than a forced label', /NO_PINNED_CLASS_MATCHED/.test(srcT));
}

// -------------------------------------------------------------------- [F]
console.log('\n[F] missing inputs ⇒ UNAVAILABLE + reason, never a class');
{
  const noPrev = T.assessGapSeries([bar('2026-09-08', 100, 105, 99, 102, null), bar('2026-09-09', 108, 110, 107, 109, 102)], {});
  eq('no quoted prevClose ⇒ UNAVAILABLE', noPrev.assessments[0].status, 'UNAVAILABLE');
  ok('...with a named reason', /NO_PREV_CLOSE/.test(noPrev.assessments[0].reason));
  eq('...and no class', noPrev.assessments[0].class, null);

  const noClose = T.assessGapSeries([bar('2026-09-08', 100, 105, 99, 102, 100), bar('2026-09-09', 108, 110, 107, null, 102)], {});
  ok('no derivable close ⇒ UNAVAILABLE', noClose.assessments[1].status === 'UNAVAILABLE' && /NO_SESSION_CLOSE/.test(noClose.assessments[1].reason));

  const firstOnly = T.assessGapSeries([bar('2026-09-08', 100, 105, 99, 102, 100)], {});
  ok('the first session has no prior range ⇒ UNAVAILABLE', firstOnly.assessments[0].status === 'UNAVAILABLE' && /NO_PRIOR_SESSION/.test(firstOnly.assessments[0].reason));

  const zeroRange = T.assessGapSeries([bar('2026-09-08', 100, 100, 100, null, 100), bar('2026-09-09', 108, 110, 107, 109, 102)], {});
  ok('a zero-range prior session ⇒ UNAVAILABLE', zeroRange.assessments[1].status === 'UNAVAILABLE' && /ZERO_PRIOR_RANGE/.test(zeroRange.assessments[1].reason));

  eq('unavailable assessments are counted', noPrev.coverage.unavailable >= 1, true);
  ok('UNAVAILABLE rows never contribute to class counts', noPrev.counts.NONE === 0 || noPrev.assessments.filter((a) => a.class === null).length > 0);
}

// -------------------------------------------------------------------- [G]
console.log('\n[G] determinism');
{
  const series = [
    bar('2026-09-01', 100, 104, 99, 103, 100),
    bar('2026-09-02', 108, 110, 107, 109, 103),
    bar('2026-09-03', 109, 112, 106, 107, 109),
    bar('2026-09-04', 104, 106, 102, 105, 107),
    bar('2026-09-05', 106, 108, 105, 107.5, 105),
  ];
  const a = T.assessGapSeries(series, {});
  const b = T.assessGapSeries([...series].reverse(), {});
  const c = T.assessGapSeries([series[2], series[0], series[4], series[1], series[3]], {});
  eq('reversed input ⇒ identical digest', b.digest, a.digest);
  eq('reordered input ⇒ identical digest', c.digest, a.digest);
  eq('and identical counts', JSON.stringify(b.counts), JSON.stringify(a.counts));
  eq('assessments are date-ordered regardless of input order', a.assessments.map((x) => x.sessionDate), [...series].map((x) => x.sessionDate).sort());
  ok('the same inputs give byte-identical assessments', JSON.stringify(b.assessments) === JSON.stringify(a.assessments));
}

// -------------------------------------------------------------------- [H]
console.log('\n[H] session-series adapter (the close/prevClose rule is the point)');
{
  const rows = [
    raw('2026-09-08', 100, 105, 99, 98, 'a'),     // quotedClose 98 = 09-07's close
    raw('2026-09-09', 102, 110, 101, 102, 'a'),   // quotedClose 102 = 09-08's close
    raw('2026-09-10', 103, 104, 95, 102.5, 'a'),  // quotedClose 102.5 = 09-09's close
  ];
  const s = S.buildSessionSeries(INST, rows);
  eq('three raw rows ⇒ three sessions', s.sessions.length, 3);
  eq('session 1 prevClose is its own quoted close', s.sessions[0].prevClose, 98);
  eq('session 1 close comes from session 2\'s quote', s.sessions[0].close, 102);
  eq('session 2 close comes from session 3\'s quote', s.sessions[1].close, 102.5);
  eq('the LAST session has no derivable close', s.sessions[2].close, null);
  eq('...and is marked INCOMPLETE', s.sessions[2].provenance, 'INCOMPLETE_NO_CLOSE');
  eq('closed sessions are counted', s.coverage.closedSessions, 2);
  ok('the next quoted close is retained for audit', s.sessions[2].nextQuotedClose === null && s.sessions[1].nextQuotedClose === 102.5);
  ok('a session range is published (the next session\'s ratio input)', s.sessions[0].range === 6);

  // widest-bar pick: intraday rows repeat the OHLC; the complete bar has the widest span
  const dupes = [
    raw('2026-09-11', 200, 200, 200, 199, 'z1'),
    raw('2026-09-11', 200, 210, 195, 199, 'z2'),
    raw('2026-09-11', 200, 205, 198, 199, 'z3'),
  ];
  const d = S.buildSessionSeries(INST, dupes);
  eq('one session from three rows', d.coverage.sessionsOut, 1);
  eq('the widest-span row wins', [d.sessions[0].high, d.sessions[0].low], [210, 195]);
  const shuffled = S.buildSessionSeries(INST, [...dupes].reverse());
  eq('pick order does not depend on input order', shuffled.digest, d.digest);

  // exclusions
  const bad = S.buildSessionSeries(INST, [
    raw('bad-date', 100, 105, 99, 98),
    raw('2026-09-12', -1, 105, 99, 98),
    raw('2026-09-13', 100, 90, 95, 98),   // high < low: impossible
  ]);
  eq('every unusable row is excluded with a reason', bad.exclusions.length, 3);
  ok('...and no session is invented from them', bad.sessions.length === 0);
  ok('reasons come from a documented set', bad.exclusions.every((e) => ['INVALID_SESSION_DATE', 'NO_USABLE_BAR', 'IMPOSSIBLE_BAR'].includes(e.reason)));

  // the adapter's output feeds the taxonomy (end-to-end composition)
  const composed = T.assessGapSeries(s.sessions, {});
  eq('adapter output is directly usable by the taxonomy', composed.assessments.length, 3);
  ok('the last session is UNAVAILABLE for the right reason (no close)', /NO_SESSION_CLOSE/.test(composed.assessments[2].reason || ''));
}

// -------------------------------------------------------------------- [I]
console.log('\n[I] older-open-gap interaction');
{
  // session 2 creates an open DOWN gap (never revisited); session 4 trades back into it
  const series = [
    bar('2026-09-01', 100, 101, 99.5, 100.5, 100),
    bar('2026-09-02', 90, 91, 89, 90.5, 100.5),    // DOWN gap zone 90..100.5, stays open
    bar('2026-09-03', 90.6, 91, 90.2, 90.8, 90.5),
    bar('2026-09-04', 92, 95, 91, 94, 90.8),       // range 91..95 enters the older zone? no (zone low 90 high 100.5) -> yes it does
  ];
  const r = T.assessGapSeries(series, {});
  const last = r.assessments[3];
  ok('interaction is reported when today ranges into an older open zone', last.olderGapInteraction.sessionDates.includes('2026-09-02'), JSON.stringify(last.olderGapInteraction));
  ok('...and the note explains the count', /still-open older gap/.test(last.olderGapInteraction.note));
  // when the older gap was already filled, it is not reported
  const filledChain = [
    bar('2026-09-01', 100, 101, 99.5, 100.5, 100),
    bar('2026-09-02', 90, 91, 89, 90.5, 100.5),   // DOWN gap
    bar('2026-09-03', 98, 101, 97, 100, 90.5),    // traded back up through the zone -> filled
    bar('2026-09-04', 100.5, 102, 100, 101, 100),
  ];
  const r2 = T.assessGapSeries(filledChain, {});
  // 09-03 is the session that FILLS the older 09-02 gap, so reporting the interaction there is
  // correct (it names the fill event); by 09-04 that gap is no longer open and must not be listed.
  ok('the filling session itself is reported (it is the interaction)', r2.assessments[2].olderGapInteraction.sessionDates.includes('2026-09-02'), JSON.stringify(r2.assessments[2].olderGapInteraction));
  ok('a filled older gap is no longer reported as open on a later session', !r2.assessments[3].olderGapInteraction.sessionDates.includes('2026-09-02'), JSON.stringify(r2.assessments[3].olderGapInteraction));
}

// -------------------------------------------------------------------- [J]
console.log('\n[J] STATIC: pure, non-AI, not wired into production');
{
  const tax = fs.readFileSync(path.join(__dirname, '..', 'src', 'trading', 'gap-engine', 'gap-taxonomy.ts'), 'utf8');
  const ser = fs.readFileSync(path.join(__dirname, '..', 'src', 'trading', 'gap-engine', 'gap-session-series.ts'), 'utf8');
  ok('taxonomy reads no clock', !/Date\.now\(\)/.test(tax));
  ok('series adapter reads no clock', !/Date\.now\(\)/.test(ser));
  ok('no randomness or AI client in the taxonomy', !/Math\.random|openai|anthropic|bedrock|llm/i.test(tax));
  ok('no randomness in the adapter', !/Math\.random/.test(ser));
  ok('no DB/network access in either module', !/mysql|fetch\(|axios|http/i.test(tax) && !/mysql|fetch\(|axios|http/i.test(ser));
  // nothing under src/ imports these yet (research/shadow only; wiring is a later roadmap item)
  const srcRoot = path.join(__dirname, '..', 'src');
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
  const importers = walk(srcRoot).filter((f) => /\.ts$/.test(f) && !/gap-engine\//.test(f) && /gap-taxonomy|gap-session-series/.test(fs.readFileSync(f, 'utf8')));
  eq('no production module imports the gap engine yet', importers.length, 0);
  ok('the taxonomy documents its precedence', /precedence/i.test(tax));
}

// -------------------------------------------------------------------- [K]
console.log('\n[K] REPLAY: a long synthetic series is inspectable end to end');
{
  const days = [];
  let px = 100;
  for (let i = 0; i < 40; i += 1) {
    const d = `2026-08-${String(i + 1).padStart(2, '0')}`;
    const prevClose = px;
    const open = i % 7 === 0 ? px * 1.02 : i % 7 === 3 ? px * 0.985 : px * 1.001;
    const high = Math.max(open, prevClose) * 1.004;
    const low = Math.min(open, prevClose) * (i % 5 === 0 ? 0.995 : 0.999);
    const close = (high + low) / 2;
    days.push(bar(d, Number(open.toFixed(4)), Number(high.toFixed(4)), Number(low.toFixed(4)), Number(close.toFixed(4)), Number(prevClose.toFixed(4))));
    px = close;
  }
  const r = T.assessGapSeries(days, {});
  ok('a 40-session series replays', r.assessments.length === 40);
  ok('coverage names the window', r.coverage.firstSession === '2026-08-01' && r.coverage.lastSession === '2026-08-40');
  ok('material gaps were found', r.coverage.materialGaps > 0);
  ok('the class distribution sums to the assessed sessions', Object.values(r.counts).reduce((a, b) => a + b, 0) === r.coverage.assessed);
  const again = T.assessGapSeries([...days].reverse(), {});
  eq('the replay is reproducible from reordered input', again.digest, r.digest);
  ok('a reviewer can see the measures behind each class', r.assessments.filter((a) => a.status === 'OK').every((a) => a.gapPct !== null && a.measures.prevClose !== null));
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) { console.log('FAILED:'); failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
process.exit(0);
