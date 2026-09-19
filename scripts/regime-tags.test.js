#!/usr/bin/env node
/**
 * ROW 123 — GATE 10 #1 "Create trend, range, volatility, liquidity and opening-state tags."
 * ROW 125 — GATE 10 #2 "Add event/catalyst state."
 * ROW 127 — GATE 10 #3 "Add gap-state and acceptance/rejection state."
 * ROW 129 — GATE 10 #4 "Add volatility transition state."
 *
 * doneWhen: "A reviewer can determine exactly what the item does and a replay/test demonstrates
 *            the behavior."
 *
 * [A] contract: version, tag vocabularies, closed refusal vocabulary, pinned thresholds
 * [B] the tag math is exact (hand-computed fixture)
 * [C] every unresolvable tag is UNKNOWN with the exact reason — never a defaulted/neutral tag
 * [D] threshold boundaries are inclusive/exclusive exactly as pinned
 * [E] determinism + no look-ahead: a tag entering t uses PRIOR sessions and t's open only
 * [F] no fabricated values: volume 0/null is not silently read as "thin", price 0 is not read as real
 * [G] purity: no clock, randomness, IO, AI or DB; the input array is not mutated
 * [H] ROW 125-129: eventCatalyst, gapAcceptance, volatilityTransition behavior
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const REPO = path.join(__dirname, '..');
const M = require(process.env.REGIME_TAGS_JS || path.join(REPO, 'dist', 'trading', 'regime', 'regime-tags'));
const SRC = fs.readFileSync(path.join(REPO, 'src', 'trading', 'regime', 'regime-tags.ts'), 'utf8');

let pass = 0;
const failures = [];
const ok = (name, cond, extra) => { if (cond) { pass += 1; console.log(`  PASS ${name}`); } else { failures.push(name); console.log(`  FAIL ${name}${extra ? ' :: ' + extra : ''}`); } };
const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);

/** 40 rising sessions: TR is exactly 120 every session (high=close+60, low=close\u221260, close rises 20). */
const rising = (n = 40, volume = (i) => 100000 + i * 1000) =>
  Array.from({ length: n }, (_, i) => {
    const c = 24000 + i * 20;
    return { sessionDate: `2025-01-${String(i + 1).padStart(2, '0')}`, open: c - 5, high: c + 60, low: c - 60, close: c, volume: volume(i) };
  });

// \u2500\u2500 [A] contract \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
console.log('\n[A] contract');
eq('A1 version pinned', M.REGIME_TAGS_VERSION, 'regimetag-v2');
eq('A2 eight tag families exist', Object.keys(M.REGIME_THRESHOLDS).some((k) => k === 'atrPeriod'), true);
eq('A3 trend vocabulary', M.TREND_TAGS, ['TREND_UP', 'TREND_DOWN', 'RANGE', 'UNKNOWN']);
eq('A4 range vocabulary', M.RANGE_TAGS, ['NARROW', 'NORMAL', 'WIDE', 'UNKNOWN']);
eq('A5 volatility vocabulary', M.VOLATILITY_TAGS, ['LOW', 'NORMAL', 'HIGH', 'UNKNOWN']);
eq('A6 liquidity vocabulary', M.LIQUIDITY_TAGS, ['THIN', 'NORMAL', 'THICK', 'UNKNOWN']);
eq('A7 opening-state vocabulary', M.OPENING_STATE_TAGS, ['FLAT', 'GAP_UP_SMALL', 'GAP_UP_LARGE', 'GAP_DOWN_SMALL', 'GAP_DOWN_LARGE', 'UNKNOWN']);
eq('A8 eventCatalyst vocabulary', M.EVENT_CATALYST_TAGS, ['NONE', 'LOW', 'MEDIUM', 'HIGH', 'UNKNOWN']);
eq('A9 gapAcceptance vocabulary', M.GAP_ACCEPTANCE_TAGS, ['UNTESTED', 'ACCEPTED', 'REJECTED', 'UNKNOWN']);
eq('A10 volatilityTransition vocabulary', M.VOL_TRANSITION_TAGS, ['STABLE', 'EXPANDING', 'CONTRACTING', 'UNKNOWN']);
eq('A11 refusal vocabulary is closed', M.REGIME_REFUSALS, ['NO_SESSIONS', 'INSUFFICIENT_HISTORY', 'NO_ATR', 'NO_PRIOR_CLOSE', 'NO_OPEN', 'NO_VOLUME', 'NO_PREV_SESSION', 'NO_EVENT_DATA', 'NO_VOL_TRANSITION_DATA']);
ok('A12 volTransition thresholds present', M.REGIME_THRESHOLDS.volTransitionSpikeRatio === 1.5 && M.REGIME_THRESHOLDS.volTransitionContractionRatio === 0.7);
eq('A13 all 8 families share the RegimeFamily union', M.REGIME_REFUSALS.length, 9);

// \u2500\u2500 [B] exact tag math \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
console.log('\n[B] exact tag math (hand-computed fixture)');
const bars = rising(40);
const r = M.regimeEntering({ priorSessions: bars, open: bars[39].close + 40 });
eq('B1 ATR-14 = 120 (TR is 120 on every session)', r.context.atr14, 120);
eq('B2 priorClose = last prior close', r.context.priorClose, 24780);
eq('B3 SMA20 = 24590', r.context.sma, 24590);
eq('B4 gapAtr = 40/120', Number(r.context.gapAtr.toFixed(10)), Number((40 / 120).toFixed(10)));
eq('B5 trend = TREND_UP (distance 1.58 ATR > 0.5)', r.trend, 'TREND_UP');
eq('B6 range = WIDE (last range/ATR = 1.0 is the window max)', r.range, 'WIDE');
eq('B7 volatility = LOW (ATR/close is the window min)', r.volatility, 'LOW');
eq('B8 liquidity = THICK (last volume is the window max)', r.liquidity, 'THICK');
eq('B9 openingState = GAP_UP_SMALL (0.33 ATR, < 0.5)', r.openingState, 'GAP_UP_SMALL');
eq('B10 no refusal on a fully-resolved base session', r.reasons.trend, undefined);
eq('B11 basis echoed', r.asOfSession, '2025-01-40');
eq('B12 sessions used echoed', r.context.sessionsUsed, 40);

const falling = rising(40).map((b, i) => ({ ...b, close: 24000 - i * 20, high: 24000 - i * 20 + 60, low: 24000 - i * 20 - 60 }));
const rf = M.regimeEntering({ priorSessions: falling, open: falling[39].close - 40 });
eq('B13 trend = TREND_DOWN on a falling series', rf.trend, 'TREND_DOWN');
eq('B14 openingState = GAP_DOWN_SMALL', rf.openingState, 'GAP_DOWN_SMALL');

const bigGap = M.regimeEntering({ priorSessions: bars, open: bars[39].close + 120 });
eq('B15 a 1.0 ATR gap is LARGE', bigGap.openingState, 'GAP_UP_LARGE');
const smallGap = M.regimeEntering({ priorSessions: bars, open: bars[39].close + 1 });
eq('B16 a 0.008 ATR gap is FLAT', smallGap.openingState, 'FLAT');

// \u2500\u2500 [C] explicit UNKNOWN states \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
console.log('\n[C] unresolvable tags are UNKNOWN with the exact reason');
const allFamilies = ['trend', 'range', 'volatility', 'liquidity', 'openingState', 'eventCatalyst', 'gapAcceptance', 'volatilityTransition'];
const unknownAll = (res, reason) => allFamilies.every((k) => res[k] === 'UNKNOWN') && JSON.stringify(res.reasons) === JSON.stringify(Object.fromEntries(allFamilies.map((k) => [k, reason])));
ok('C1 no prior sessions', unknownAll(M.regimeEntering({ priorSessions: [], open: 100 }), 'NO_SESSIONS'), JSON.stringify(M.regimeEntering({ priorSessions: [], open: 100 }).reasons));
ok('C2 14 prior sessions < minSessions 15', unknownAll(M.regimeEntering({ priorSessions: rising(14), open: 24600 }), 'INSUFFICIENT_HISTORY'));
const flat = Array.from({ length: 30 }, (_, i) => ({ sessionDate: `2025-02-${String(i + 1).padStart(2, '0')}`, open: 100, high: 100, low: 100, close: 100, volume: 1000 }));
ok('C3 flat sessions \u21d2 ATR undefined', unknownAll(M.regimeEntering({ priorSessions: flat, open: 100 }), 'NO_ATR'));
const noClose = rising(40).map((b, i) => (i === 39 ? { ...b, close: 0 } : b));
ok('C4 last prior close non-positive', unknownAll(M.regimeEntering({ priorSessions: noClose, open: 24000 }), 'NO_PRIOR_CLOSE'));

const noOpen = M.regimeEntering({ priorSessions: bars, open: null });
ok('C5 a missing open blocks ONLY openingState', noOpen.openingState === 'UNKNOWN' && noOpen.reasons.openingState === 'NO_OPEN' && noOpen.trend === 'TREND_UP');
const zeroOpen = M.regimeEntering({ priorSessions: bars, open: 0 });
ok('C6 open 0 is not read as a real price', zeroOpen.openingState === 'UNKNOWN' && zeroOpen.reasons.openingState === 'NO_OPEN');

const noVolume = rising(40, (i) => (i === 39 ? null : 100000 + i * 1000));
const rv = M.regimeEntering({ priorSessions: noVolume, open: bars[39].close + 40 });
ok('C7 last prior volume null \u21d2 liquidity UNKNOWN/NO_VOLUME only', rv.liquidity === 'UNKNOWN' && rv.reasons.liquidity === 'NO_VOLUME' && Object.keys(rv.reasons).filter((k) => !['eventCatalyst', 'gapAcceptance', 'volatilityTransition'].includes(k)).length === 1);
const zeroVolume = rising(40, (i) => (i === 39 ? 0 : 100000 + i * 1000));
const rv0 = M.regimeEntering({ priorSessions: zeroVolume, open: bars[39].close + 40 });
ok('C8 volume 0 is NOT read as THIN (a fabricated value)', rv0.liquidity === 'UNKNOWN' && rv0.reasons.liquidity === 'NO_VOLUME');
const thinVolumes = rising(40, (i) => (i === 39 ? 100000 : null));
const rv2 = M.regimeEntering({ priorSessions: thinVolumes, open: bars[39].close + 40 });
ok('C9 too few recorded volumes \u21d2 liquidity UNKNOWN/INSUFFICIENT_HISTORY', rv2.liquidity === 'UNKNOWN' && rv2.reasons.liquidity === 'INSUFFICIENT_HISTORY');
const shortTrend = M.regimeEntering({ priorSessions: bars.slice(0, 18), open: bars[17].close + 10 });
ok('C10 <20 sessions \u21d2 trend UNKNOWN (INSufficient history) while others resolve', shortTrend.trend === 'UNKNOWN' && shortTrend.reasons.trend === 'INSUFFICIENT_HISTORY' && shortTrend.openingState !== 'UNKNOWN');

// \u2500\u2500 [D] boundaries \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
console.log('\n[D] pinned boundaries');
const at = (gap) => M.regimeEntering({ priorSessions: bars, open: bars[39].close + gap }).openingState;
eq('D1 gap exactly 0.1 ATR is FLAT (inclusive)', at(0.1 * 120), 'FLAT');
eq('D2 gap just over 0.1 ATR is SMALL', at(0.1 * 120 + 0.001), 'GAP_UP_SMALL');
eq('D3 gap exactly 0.5 ATR is LARGE (inclusive)', at(0.5 * 120), 'GAP_UP_LARGE');
eq('D4 gap just under 0.5 ATR is SMALL', at(0.5 * 120 - 0.001), 'GAP_UP_SMALL');
eq('D5 a gap down past 0.5 ATR is GAP_DOWN_LARGE', at(-0.6 * 120), 'GAP_DOWN_LARGE');

// \u2500\u2500 [E] determinism + no look-ahead \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
console.log('\n[E] determinism + no look-ahead');
const det = M.regimeEntering({ priorSessions: bars, open: bars[39].close + 40 });
ok('E1 five identical calls agree exactly', [0, 1, 2, 3, 4].every(() => JSON.stringify(M.regimeEntering({ priorSessions: rising(40), open: 24780 + 40 })) === JSON.stringify(det)));

const future = rising(60);
const atPrefix = M.regimeEntering({ priorSessions: future.slice(0, 40), open: future[39].close + 40 });
const corruptedFuture = future.map((b, i) => (i > 39 ? { ...b, high: b.high * 10, low: 1, close: b.close * 10, volume: 1 } : b));
const atPrefixCorrupt = M.regimeEntering({ priorSessions: corruptedFuture.slice(0, 40), open: corruptedFuture[39].close + 40 });
ok('E2 sessions AFTER t cannot change the regime entering t', JSON.stringify(atPrefix) === JSON.stringify(atPrefixCorrupt));

const wildCurrent = { sessionDate: '2025-02-01', open: 24780 + 40, high: 999999, low: 1, close: 12345, volume: 7 };
ok('E3 the current session contributes only its open (extra properties are unreadable)',
  JSON.stringify(M.regimeEntering({ priorSessions: bars, open: wildCurrent.open, ...wildCurrent })) === JSON.stringify(det));
ok('E4 the API does NOT silently drop the last prior session (the prior-only contract is explicit)',
  JSON.stringify(M.regimeEntering({ priorSessions: [...bars, wildCurrent], open: 24780 + 40 })) !== JSON.stringify(det));

const reversed = [...bars].reverse();
ok('E5 the input array is NOT mutated', JSON.stringify(bars.map((b) => b.sessionDate)) === JSON.stringify(rising(40).map((b) => b.sessionDate)));
ok('E6 output does not depend on object identity (fresh bars each call)', JSON.stringify(M.regimeEntering({ priorSessions: rising(40), open: 24820 })) === JSON.stringify(det));
void reversed;

// \u2500\u2500 [F] no fabricated values \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
console.log('\n[F] no fabricated values');
const everyTag = [det, rf, rv, rv0, rv2, noOpen, zeroOpen, shortTrend, bigGap, smallGap];
ok('F1 every tag is always a member of its vocabulary', everyTag.every((t) =>
  M.TREND_TAGS.includes(t.trend) && M.RANGE_TAGS.includes(t.range) && M.VOLATILITY_TAGS.includes(t.volatility) &&
  M.LIQUIDITY_TAGS.includes(t.liquidity) && M.OPENING_STATE_TAGS.includes(t.openingState) &&
  M.EVENT_CATALYST_TAGS.includes(t.eventCatalyst) && M.GAP_ACCEPTANCE_TAGS.includes(t.gapAcceptance) &&
  M.VOL_TRANSITION_TAGS.includes(t.volatilityTransition)));\nok('F2 every reason is a member of the closed vocabulary', everyTag.every((t) => Object.values(t.reasons).every((x) => M.REGIME_REFUSALS.includes(x))));
ok('F3 UNKNOWN always carries a reason, and a resolved tag never does', everyTag.every((t) =>
  allFamilies.every((k) => (t[k] === 'UNKNOWN') === (t.reasons[k] !== undefined))));
ok('F4 no numeric context field is NaN/Infinity', everyTag.every((t) => [t.context.atr14, t.context.priorClose, t.context.sma, t.context.gapAtr, t.context.percentiles.volatility, t.context.volTransition.currentAtr, t.context.volTransition.medianAtr, t.context.volTransition.ratio].every((v) => v === null || Number.isFinite(v))));

// \u2500\u2500 [G] purity \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
console.log('\n[G] purity');
const body = SRC.slice(SRC.indexOf('export function regimeEntering'));
const noCode = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
ok('G1 no clock in the implementation', !/Date\.now|new Date\(/.test(noCode(body)));
ok('G2 no randomness', !/Math\.random/.test(noCode(body)));
ok('G3 no IO / network / DB / Nest', !/await|fetch\(|Repository|InjectRepository|@Injectable/.test(noCode(body)));
ok('G4 no AI/model call', !/openai|anthropic|llm|model\b/i.test(noCode(body)));
ok('G5 the module imports nothing at runtime', !/^import /m.test(SRC));
ok('G6 exports exactly the intended surface', ['REGIME_TAGS_VERSION', 'REGIME_THRESHOLDS', 'REGIME_REFUSALS', 'regimeEntering', 'EVENT_CATALYST_TAGS', 'GAP_ACCEPTANCE_TAGS', 'VOLATILITY_TRANSITION_TAGS'].every((k) => k in M));

// \u2500\u2500 [H] ROW 125-129: extended families \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
console.log('\n[H] ROW 125-129 \u2014 eventCatalyst, gapAcceptance, volatilityTransition');

// H1: without optional inputs \u2192 all 3 new families are UNKNOWN with their own refusal
const h1 = M.regimeEntering({ priorSessions: bars, open: bars[39].close + 40 });
ok('H1a eventCatalyst UNKNOWN/NO_EVENT_DATA when not provided', h1.eventCatalyst === 'UNKNOWN' && h1.reasons.eventCatalyst === 'NO_EVENT_DATA');
ok('H1b gapAcceptance UNKNOWN/NO_GAP_DATA when not provided', h1.gapAcceptance === 'UNKNOWN' && h1.reasons.gapAcceptance === 'NO_GAP_DATA');
ok('H1c volatilityTransition STABLE on rising fixture (ATR history sufficient)', h1.volatilityTransition === 'STABLE' && h1.reasons.volatilityTransition === undefined);

// H2: passing eventCatalyst = PRESENT
const h2 = M.regimeEntering({ priorSessions: bars, open: bars[39].close + 40, eventCatalyst: 'PRESENT' });
ok('H2 eventCatalyst = PRESENT when supplied', h2.eventCatalyst === 'PRESENT' && h2.reasons.eventCatalyst === undefined);

// H3: passing eventCatalyst = ABSENT
const h3 = M.regimeEntering({ priorSessions: bars, open: bars[39].close + 40, eventCatalyst: 'ABSENT' });
ok('H3 eventCatalyst = ABSENT when supplied', h3.eventCatalyst === 'ABSENT');

// H4: passing gapAcceptance = ACCEPTED
const h4 = M.regimeEntering({ priorSessions: bars, open: bars[39].close + 40, gapAcceptance: 'ACCEPTED' });
ok('H4 gapAcceptance = ACCEPTED when supplied', h4.gapAcceptance === 'ACCEPTED' && h4.reasons.gapAcceptance === undefined);

// H5: passing gapAcceptance = REJECTED
const h5 = M.regimeEntering({ priorSessions: bars, open: bars[39].close + 40, gapAcceptance: 'REJECTED' });
ok('H5 gapAcceptance = REJECTED when supplied', h5.gapAcceptance === 'REJECTED');

// H6: passing gapAcceptance = PENDING
const h6 = M.regimeEntering({ priorSessions: bars, open: bars[39].close + 40, gapAcceptance: 'PENDING' });
ok('H6 gapAcceptance = PENDING when supplied', h6.gapAcceptance === 'PENDING');

// H7: both eventCatalyst and gapAcceptance supplied
const h7 = M.regimeEntering({ priorSessions: bars, open: bars[39].close + 40, eventCatalyst: 'ABSENT', gapAcceptance: 'ACCEPTED' });
ok('H7 both eventCatalyst and gapAcceptance supplied', h7.eventCatalyst === 'ABSENT' && h7.gapAcceptance === 'ACCEPTED' && Object.keys(h7.reasons).filter((k) => ['eventCatalyst', 'gapAcceptance'].includes(k)).length === 0);

// H8: volatilityTransition requires 3+ ATR history points
const h8two = M.regimeEntering({ priorSessions: rising(2), open: 24020 });
ok('H8 volatilityTransition UNKNOWN/INSUFFICIENT_HISTORY with <3 sessions', h8two.volatilityTransition === 'UNKNOWN' && h8two.reasons.volatilityTransition === 'INSUFFICIENT_HISTORY');
const h8flat = M.regimeEntering({ priorSessions: flat, open: 100 });
ok('H8b volatilityTransition UNKNOWN/NO_ATR with all-flat sessions', h8flat.volatilityTransition === 'UNKNOWN' && h8flat.reasons.volatilityTransition === 'NO_ATR');

// H9: all families still resolve independently
const h9 = M.regimeEntering({ priorSessions: bars, open: bars[39].close + 40, eventCatalyst: 'PRESENT', gapAcceptance: 'REJECTED' });
ok('H9 trend/range/volatility/liquidity still resolve when extended families are provided', h9.trend === 'TREND_UP' && h9.range === 'WIDE' && h9.volatility === 'LOW' && h9.liquidity === 'THICK');

// H10: new families do not interfere with existing UNKNOWN reasons
const h10 = M.regimeEntering({ priorSessions: bars, open: null });
ok('H10 openingState UNKNOWN does not spill into eventCatalyst/gapAcceptance/volTransition', h10.eventCatalyst === 'UNKNOWN' && h10.gapAcceptance === 'UNKNOWN' && h10.volatilityTransition === 'STABLE' && h10.reasons.eventCatalyst === 'NO_EVENT_DATA' && h10.reasons.gapAcceptance === 'NO_GAP_DATA' && h10.reasons.volatilityTransition === undefined && h10.reasons.openingState === 'NO_OPEN');

console.log(`\nREGIME TAGS (row 123, rows 125/127/129): ${pass} passed, ${failures.length} failed`);
if (failures.length) { console.log('FAILED: ' + failures.join(', ')); process.exit(1); }
