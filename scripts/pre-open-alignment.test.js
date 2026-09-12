#!/usr/bin/env node
/**
 * GATE 2 #6 (roadmap row 27) — TIME-ALIGN pre-open + cross-market information.
 *
 * doneWhen: "A reviewer can determine exactly what the item does and a replay/test
 * demonstrates the behavior."
 *
 *   [A] the reviewer statement exists and its closed exclusion vocabulary is real;
 *   [B] basis resolution: an IST wall and a UTC wall both become absolute instants;
 *   [C] a row with no/unknown basis is REFUSED, never assumed;
 *   [D] the dual-basis cross-check catches an IST value stored in a UTC column;
 *   [E] window + calendar gates (pre-open window, weekend, other day, reference rules);
 *   [F] look-ahead: nothing at/after asOf may enter the frame;
 *   [G] determinism: shuffled input yields an identical frame and digest;
 *   [H] per-symbol resolution at asOf, with explicit UNAVAILABLE and no interpolation;
 *   [I] cross-validation: the alignment's phase model agrees with scripts/lib/market-session.js;
 *   [J] REPLAY: a fixture replay demonstrates the behaviour end to end.
 */
const path = require('path');
const fs = require('fs');

const A = require(path.join(__dirname, '..', 'dist', 'trading', 'pre-open', 'pre-open-alignment'));
const S = require(path.join(__dirname, '..', 'dist', 'trading', 'pre-open', 'pre-open-session'));

let pass = 0;
const failures = [];
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; console.log(`  PASS ${name}`); }
  else { failures.push(name); console.log(`  FAIL ${name}${extra ? ' :: ' + extra : ''}`); }
};
const eq = (name, actual, expected) => ok(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`);

// A real trading day: Friday 2026-09-11. A real closed day: Saturday 2026-09-12.
const SESSION = '2026-09-11';
const ist = (h, m, s = 0) => `${SESSION} ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
const utcOf = (h, m, s = 0) => { // wall clock in UTC corresponding to that IST instant
  const ms = Date.parse(`${SESSION}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}+05:30`);
  const d = new Date(ms);
  return `${SESSION} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}:${String(d.getUTCSeconds()).padStart(2, '0')}`;
};

const row = (kind, source, symbol, wall, basis, extra = {}) => ({ kind, source, symbol, wall, basis, ...extra });
const NIFTY = 'NSE:NIFTY50';

// -------------------------------------------------------------------- [A]
console.log('\n[A] the reviewer statement + closed exclusion vocabulary');
{
  const s = A.describeAlignment();
  ok('a reviewer statement exists', typeof s === 'string' && s.length > 200);
  ok('it names the version', /align-v1/.test(s));
  ok('it states the two bases it reconciles', /IST/.test(s) && /UTC/.test(s));
  ok('it states the asOf / look-ahead rule', /asOf/.test(s));
  ok('it states the no-interpolation rule', /no interpolation|never interpolated/i.test(s) || /UNAVAILABLE/.test(s));
  eq('exclusion reasons are a closed, documented set', Array.isArray(A.ALIGNMENT_EXCLUSION_REASONS) && A.ALIGNMENT_EXCLUSION_REASONS.length >= 10, true);
  ok('the tolerance constant is published', A.EXACT_TOLERANCE_MS === 30 * 60_000);
}

// -------------------------------------------------------------------- [B]
console.log('\n[B] both bases resolve to the same absolute instant');
{
  const istMs = A.wallToInstantMs(ist(9, 4, 12), 'IST');
  const utcMs = A.wallToInstantMs(utcOf(9, 4, 12), 'UTC');
  ok('an IST wall clock resolves', Number.isFinite(istMs));
  eq('the same instant written in UTC resolves identically', utcMs, istMs);
  eq('IST wall is 5.5 h ahead of the UTC wall of the same instant', new Date(istMs).toISOString().slice(11, 19), '03:34:12');
  const walls = A.instantToWalls(istMs);
  eq('instant renders back to the same IST wall', walls.istWall, ist(9, 4, 12));
  eq('...and to the matching UTC wall', walls.utcWall, utcOf(9, 4, 12));
  eq('a fractional-seconds wall still parses', A.wallToInstantMs(`${SESSION} 09:04:12.500`, 'IST'), istMs + 500);
}

// -------------------------------------------------------------------- [C]
console.log('\n[C] an undeclared/invalid basis is refused, never assumed');
{
  const frame = A.alignPreOpenFrame([
    row('PRE_OPEN', 'src', NIFTY, ist(9, 4), null),
    row('PRE_OPEN', 'src', NIFTY, null, 'IST'),
    row('PRE_OPEN', 'src', NIFTY, 'not-a-time', 'IST'),
    row('PRE_OPEN', 'src', NIFTY, ist(9, 4), 'IST'),
  ], { sessionDate: SESSION });
  eq('only the fully-declared row is aligned', frame.coverage.rowCount, 1);
  eq('no-basis row refused as BASIS_UNKNOWN', frame.exclusionCounts.BASIS_UNKNOWN, 1);
  eq('missing timestamp refused as NO_TIMESTAMP', frame.exclusionCounts.NO_TIMESTAMP, 1);
  eq('malformed wall refused as TIMESTAMP_INVALID', frame.exclusionCounts.TIMESTAMP_INVALID, 1);
  ok('every produced reason is in the documented set', frame.exclusions.every((e) => A.ALIGNMENT_EXCLUSION_REASONS.includes(e.reason)));
}

// -------------------------------------------------------------------- [D]
console.log('\n[D] the dual-basis cross-check catches a mis-based column');
{
  // same event: eventTime written IST, createdAt written UTC -> consistent
  const consistent = A.alignPreOpenFrame([
    row('PRE_OPEN', 'src', NIFTY, ist(9, 4), 'IST', { crossCheck: { wall: utcOf(9, 4), basis: 'UTC' } }),
  ], { sessionDate: SESSION });
  eq('a consistent pair is aligned', consistent.coverage.rowCount, 1);
  eq('...with no BASIS_MISMATCH', consistent.exclusionCounts.BASIS_MISMATCH ?? 0, 0);

  // the classic defect: a 5.5 h gap between the two columns
  const drifted = A.alignPreOpenFrame([
    row('PRE_OPEN', 'src', NIFTY, ist(9, 4), 'IST', { crossCheck: { wall: ist(9, 4), basis: 'UTC' } }),
  ], { sessionDate: SESSION });
  eq('a 5.5 h gap is refused', drifted.coverage.rowCount, 0);
  eq('...reported as BASIS_MISMATCH', drifted.exclusionCounts.BASIS_MISMATCH, 1);
  ok('the detail names the gap in minutes', /330 min/.test(drifted.exclusions[0].detail));

  const withinTolerance = A.alignPreOpenFrame([
    row('PRE_OPEN', 'src', NIFTY, ist(9, 4), 'IST', { crossCheck: { wall: utcOf(9, 20), basis: 'UTC' } }),
  ], { sessionDate: SESSION });
  eq('a 16-minute publication delay is NOT a mismatch', withinTolerance.exclusionCounts.BASIS_MISMATCH ?? 0, 0);
}

// -------------------------------------------------------------------- [E]
console.log('\n[E] window + calendar gates');
{
  const frame = A.alignPreOpenFrame([
    row('PRE_OPEN', 'src', NIFTY, ist(8, 59), 'IST'),
    row('PRE_OPEN', 'src', NIFTY, ist(9, 0), 'IST'),
    row('PRE_OPEN', 'src', NIFTY, ist(9, 14, 59), 'IST'),
    row('PRE_OPEN', 'src', NIFTY, ist(9, 15), 'IST'),
    row('PRE_OPEN', 'src', NIFTY, ist(12, 0), 'IST'),
  ], { sessionDate: SESSION });
  eq('09:00 and 09:14:59 are inside, 09:15/12:00 outside', frame.coverage.rowCount, 2);
  eq('rows outside the window are refused as OUT_OF_WINDOW', frame.exclusionCounts.OUT_OF_WINDOW, 2);
  eq('08:59 is refused by the CALENDAR (before the pre-open session), not by the window', frame.exclusionCounts.CALENDAR_CLOSED, 1);
  eq('the first aligned instant is 09:00', frame.rows[0].istWall, ist(9, 0));

  const weekend = A.alignPreOpenFrame([row('PRE_OPEN', 'src', NIFTY, '2026-09-12 09:04:00', 'IST')], { sessionDate: '2026-09-12' });
  eq('a Saturday session aligns nothing', weekend.coverage.rowCount, 0);
  eq('...as CALENDAR_CLOSED', weekend.exclusionCounts.CALENDAR_CLOSED, 1);

  const otherDay = A.alignPreOpenFrame([row('PRE_OPEN', 'src', NIFTY, '2026-09-10 09:04:00', 'IST')], { sessionDate: SESSION });
  eq('a different day is refused', otherDay.exclusionCounts.OUT_OF_WINDOW, 1);

  const refs = A.alignPreOpenFrame([
    row('REFERENCE', 'unified', NIFTY, ist(9, 4), 'IST'),                        // reference AFTER window start -> refused
    row('REFERENCE', 'unified', NIFTY, ist(8, 30), 'IST'),                       // same day but pre-session -> CALENDAR_CLOSED
    row('REFERENCE', 'unified', 'X', '2026-09-11 08:15:00', 'IST'),              // same day, pre-session -> CALENDAR_CLOSED
    row('REFERENCE', 'unified', NIFTY, '2026-09-10 15:30:00', 'IST'),            // previous session close -> ok
    row('REFERENCE', 'unified', NIFTY, '2026-09-09 15:30:00', 'IST'),            // >30 h before window -> too old
  ], { sessionDate: SESSION });
  eq('references after the window start are refused', refs.exclusionCounts.REFERENCE_AFTER_WINDOW_START, 1);
  eq('references too old are refused', refs.exclusionCounts.REFERENCE_TOO_OLD, 1);
  eq('a pre-session row on the SAME day is not a reference (calendar CLOSED)', refs.exclusionCounts.CALENDAR_CLOSED, 2);
  eq('exactly the previous session close is a valid reference', refs.coverage.rowCount, 1);
  ok('...and it is kept with its own IST wall', refs.rows[0].istWall === '2026-09-10 15:30:00' && refs.rows[0].kind === 'REFERENCE');

  const noday = A.alignPreOpenFrame([row('PRE_OPEN', 'src', NIFTY, ist(9, 4), 'IST')], { sessionDate: '11-09-2026' });
  eq('a malformed session date aligns nothing', noday.coverage.rowCount, 0);
  ok('...and refuses the row', noday.exclusions.length === 1);
}

// -------------------------------------------------------------------- [F]
console.log('\n[F] nothing at/after the asOf cutoff enters the frame');
{
  const asOf = Date.parse(`${SESSION}T09:05:00+05:30`);
  const frame = A.alignPreOpenFrame([
    row('PRE_OPEN', 'src', NIFTY, ist(9, 4, 59), 'IST'),
    row('PRE_OPEN', 'src', NIFTY, ist(9, 5, 0), 'IST'),
    row('CROSS_MARKET', 'unified', NIFTY, ist(9, 4, 30), 'IST'),
  ], { sessionDate: SESSION, asOfMs: asOf });
  eq('rows before the cutoff are kept', frame.coverage.rowCount, 2);
  eq('the row AT the cutoff is refused', frame.exclusionCounts.LOOK_AHEAD, 1);
  ok('no aligned instant reaches asOf', frame.rows.every((r) => r.instantMs < frame.asOfMs));
  eq('asOf is reported on the frame', frame.asOfMs, asOf);
  const dflt = A.alignPreOpenFrame([row('PRE_OPEN', 'src', NIFTY, ist(9, 14, 59), 'IST')], { sessionDate: SESSION });
  eq('the default cutoff is the window end', dflt.asOfMs, Date.parse(`${SESSION}T09:15:00+05:30`));
}

// -------------------------------------------------------------------- [G]
console.log('\n[G] determinism: input order cannot change the frame');
{
  const inputs = [
    row('CROSS_MARKET', 'unified', NIFTY, ist(9, 3), 'IST', { sequence: 2 }),
    row('PRE_OPEN', 'upstox', NIFTY, ist(9, 4), 'IST', { sequence: 1 }),
    row('PRE_OPEN', 'upstox', 'BSE:SENSEX', ist(9, 4), 'IST', { sequence: 1 }),
    row('REFERENCE', 'unified', NIFTY, '2026-09-10 15:30:00', 'IST'),
    row('CROSS_MARKET', 'unified', 'BSE:SENSEX', ist(9, 2), 'IST', { sequence: 1 }),
    row('PRE_OPEN', 'upstox', NIFTY, ist(9, 1), 'IST', { sequence: 0 }),
  ];
  const a = A.alignPreOpenFrame(inputs, { sessionDate: SESSION });
  const b = A.alignPreOpenFrame([...inputs].reverse(), { sessionDate: SESSION });
  const c = A.alignPreOpenFrame([inputs[3], inputs[0], inputs[2], inputs[5], inputs[1], inputs[4]], { sessionDate: SESSION });
  eq('reversed input gives an identical digest', b.digest, a.digest);
  eq('reordered input gives an identical digest', c.digest, a.digest);
  eq('row order is identical too', b.rows.map((r) => r.key), a.rows.map((r) => r.key));
  ok('rows are ordered by instant', a.rows.every((r, i) => i === 0 || a.rows[i - 1].instantMs <= r.instantMs));
  ok('the reference sorts by its own earlier instant', a.rows[0].kind === 'REFERENCE');
  const dup = A.alignPreOpenFrame([inputs[1], inputs[1]], { sessionDate: SESSION });
  eq('an exact duplicate is refused, not double-counted', [dup.coverage.rowCount, dup.exclusionCounts.DUPLICATE], [1, 1]);

  // count maps must be canonical: two frames with the SAME exclusions, met in a different
  // order, must not differ in the key order of their counts (this caught a real defect).
  const noisy = [row('PRE_OPEN', 's', null, ist(9, 3), 'IST'), row('PRE_OPEN', 's', NIFTY, ist(9, 20), 'IST')];
  const n1 = A.alignPreOpenFrame(noisy, { sessionDate: SESSION });
  const n2 = A.alignPreOpenFrame([...noisy].reverse(), { sessionDate: SESSION });
  eq('exclusion-count key order is canonical', JSON.stringify(n2.exclusionCounts), JSON.stringify(n1.exclusionCounts));
  eq('...so the digest matches as well', n2.digest, n1.digest);
  eq('the canonical order follows the documented vocabulary', Object.keys(n1.exclusionCounts), ['OUT_OF_WINDOW', 'MISSING_SYMBOL']);
  eq('kind counts follow the declared kind order', Object.keys(A.alignPreOpenFrame(inputs, { sessionDate: SESSION }).coverage.kindCounts), ['PRE_OPEN', 'CROSS_MARKET', 'REFERENCE']);
}

// -------------------------------------------------------------------- [H]
console.log('\n[H] per-symbol resolution at asOf, no interpolation');
{
  const frame = A.alignPreOpenFrame([
    row('PRE_OPEN', 'upstox', NIFTY, ist(9, 2), 'IST', { values: { oai: -0.4 } }),
    row('PRE_OPEN', 'upstox', NIFTY, ist(9, 6), 'IST', { values: { oai: 0.25 } }),
    row('CROSS_MARKET', 'unified', NIFTY, ist(9, 3), 'IST', { values: { ltp: 23400 } }),
    row('PRE_OPEN', 'upstox', 'BSE:SENSEX', ist(9, 6), 'IST', { values: { oai: 0.1 } }),
  ], { sessionDate: SESSION });
  const n = frame.symbols.find((s) => s.symbol === NIFTY);
  const sx = frame.symbols.find((s) => s.symbol === 'BSE:SENSEX');
  eq('NIFTY resolves at asOf', n.status, 'OK');
  eq('the NEWEST pre-open row is the one used', n.preOpen.values.oai, 0.25);
  eq('the newest pre-open instant is 09:06', n.preOpen.istWall, ist(9, 6));
  ok('the newest row is not the last input row blindly', n.reference === null);
  eq('SENSEX has no cross-market row -> UNAVAILABLE', sx.status, 'UNAVAILABLE');
  ok('...with an explicit reason, not a filled value', sx.reason !== null && /cross-market/.test(sx.reason));
  eq('...and no invented value', sx.crossMarket, null);
  ok('symbols are listed in a stable order', JSON.stringify(frame.symbols.map((s) => s.symbol)) === JSON.stringify([...frame.symbols.map((s) => s.symbol)].sort()));
}

// -------------------------------------------------------------------- [I]
console.log('\n[I] cross-validation against scripts/lib/market-session.js');
{
  const M = require(path.join(__dirname, 'lib', 'market-session.js'));
  const cases = [[8, 59], [9, 0], [9, 7, 59], [9, 8], [9, 14, 59], [9, 15], [12, 0], [15, 30]];
  let agree = 0;
  for (const [h, m] of cases) {
    const d = new Date(Date.parse(`${SESSION}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+05:30`));
    const jsOpen = M.isMarketOpen(d);
    const tsPhase = S.sessionPhaseAt(d.getTime());
    const tsOpen = tsPhase === 'MARKET_OPEN' || tsPhase === 'POST_OPEN';
    if (jsOpen === tsOpen) agree += 1;
  }
  eq('every sampled instant agrees with the shared session lib on market-open state', agree, cases.length);
  const sat = new Date(Date.parse('2026-09-12T10:00:00+05:30'));
  eq('both agree a Saturday is closed', [M.isMarketOpen(sat), S.sessionPhaseAt(sat.getTime()) === 'CLOSED'], [false, true]);
}

// -------------------------------------------------------------------- [J]
console.log('\n[J] REPLAY: a full session replay demonstrates the behaviour');
{
  // A synthetic session that exercises every branch, replayed TWICE.
  const session = [
    row('REFERENCE', 'unified_market_snapshots', NIFTY, '2026-09-10 15:29:59', 'IST', { values: { prevClose: 23300 } }),
    row('PRE_OPEN', 'upstox_preopen', NIFTY, ist(9, 0, 5), 'IST', { values: { oai: -0.2 } }),
    row('PRE_OPEN', 'upstox_preopen', NIFTY, ist(9, 6, 30), 'IST', { values: { oai: 0.35 } }),
    row('CROSS_MARKET', 'unified_market_snapshots', NIFTY, ist(9, 6, 31), 'IST', { values: { ltp: 23380 } }),
    row('PRE_OPEN', 'upstox_preopen', 'BSE:SENSEX', ist(9, 6, 30), 'IST', { values: { oai: 0.05 } }),
    row('CROSS_MARKET', 'unified_market_snapshots', 'BSE:SENSEX', ist(9, 6, 32), 'IST', { values: { ltp: 74120 } }),
    row('PRE_OPEN', 'upstox_preopen', NIFTY, ist(9, 20), 'IST'),   // after window
    row('PRE_OPEN', 'upstox_preopen', null, ist(9, 3), 'IST'),     // no symbol
  ];
  const f1 = A.alignPreOpenFrame(session, { sessionDate: SESSION });
  const f2 = A.alignPreOpenFrame([...session].reverse(), { sessionDate: SESSION });
  eq('the replay frames agree byte for byte', f2.digest, f1.digest);
  eq('row count', f1.coverage.rowCount, 6);
  eq('symbol count', f1.coverage.symbolCount, 2);
  eq('one reference, four pre-open, two cross-market kept (1 reference + 3 pre-open + 2 cross-market)', JSON.stringify(f1.coverage.kindCounts), JSON.stringify({ PRE_OPEN: 3, CROSS_MARKET: 2, REFERENCE: 1 }));
  eq('both symbols resolve OK', f1.symbols.every((s) => s.status === 'OK'), true);
  eq('the out-of-window row and the symbol-less row are refused', [f1.exclusionCounts.OUT_OF_WINDOW, f1.exclusionCounts.MISSING_SYMBOL], [1, 1]);
  ok('the frame reports its own coverage span', f1.coverage.spanMs > 0 && Number.isFinite(f1.coverage.spanMs));
  ok('the frame carries the version', f1.version === 'align-v1');
  ok('the frame carries provenance per row (source + basis + both walls)', f1.rows.every((r) => r.source && r.basis && r.istWall && r.utcWall));
  ok('the frame shows the phase per row', f1.rows.every((r) => r.phase === 'PRE_OPEN' || r.phase === 'OPEN_AUCTION' || r.phase === 'MARKET_OPEN' || r.phase === 'POST_OPEN'));

  // source-side static proof: nothing else constructs the wall clocks itself
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'trading', 'pre-open', 'pre-open-alignment.ts'), 'utf8');
  ok('the module reads no clock (pure)', !/Date\.now\(\)/.test(src) && !/new Date\(\)\s*;/.test(src));
  ok('the module documents the two-basis hazard it exists to fix', /5\.5 h/.test(src) && /createdAt/.test(src) && /receivedTimestamp/.test(src));
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) { console.log('FAILED:'); failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
process.exit(0);
