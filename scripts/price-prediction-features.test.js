#!/usr/bin/env node
/**
 * Price-prediction feature formulas — unit tests (offline/shadow research).
 *
 * Proves the two things that matter before any number from this module is
 * believed:
 *   1. each formula computes exactly what its doc comment says;
 *   2. an ABSENT value is refused with a closed-vocabulary reason and is never
 *      coerced to 0 — the Stage-1 D4 rule, asserted for every feature.
 */
'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const DIST = process.env.PPF_DIST || path.join(__dirname, '..', 'dist');
const M = require(path.join(DIST, 'trading', 'research', 'price-prediction-features.js'));

const leg = (strike, optionType, oi, changeOi, volume) => ({ strike, optionType, oi, changeOi, volume });
const reason = (r) => (r.ok ? null : r.reason);
const val = (r) => { assert.ok(r.ok, 'expected ok, got refusal ' + reason(r)); return r.value; };
let checks = 0;
const eq = (a, b, m) => { assert.equal(a, b, m); checks += 1; };
const near = (a, b, m, eps = 1e-9) => { assert.ok(Math.abs(a - b) < eps, `${m}: ${a} !== ${b}`); checks += 1; };

// A 5-strike chain with a deliberately concentrated CE side.
const CHAIN = [
  leg(25500, 'CE', 1000, 100, 500), leg(25600, 'CE', 5000, 900, 800),
  leg(25700, 'CE', 2000, 200, 300), leg(25800, 'CE', 1000, -50, 100), leg(25900, 'CE', 1000, 0, 50),
  leg(25500, 'PE', 3000, 150, 300), leg(25600, 'PE', 4000, 400, 600),
  leg(25700, 'PE', 2000, -100, 200), leg(25800, 'PE', 1000, 0, 100), leg(25900, 'PE', 500, 0, 50),
];

console.log('== 1. strike-wise OI concentration ==');
{
  const ce = val(M.oiConcentration(CHAIN, 'CE'));
  eq(ce.totalOi, 10000, 'CE total OI');
  eq(ce.strikes, 5, 'CE strikes with OI');
  eq(ce.topStrike, 25600, 'largest CE strike');
  near(ce.topShare, 0.5, 'top share 5000/10000');
  near(ce.hhi, 0.25 + 0.04 + 0.01 + 0.01 + 0.01, 'HHI');
  near(ce.hhiNorm, (ce.hhi - 0.2) / 0.8, 'normalised HHI');
  const pe = val(M.oiConcentration(CHAIN, 'PE'));
  eq(pe.topStrike, 25600, 'largest PE strike');
  // RAW HHI is NOT comparable across chains with different strike counts: a
  // uniform 3-strike chain scores 1/3 = 0.333 while a 5-strike chain with one
  // dominant strike scores 0.32. The NORMALISED form is the comparable one.
  const flat = [leg(1, 'CE', 100, 0, 1), leg(2, 'CE', 100, 0, 1), leg(3, 'CE', 100, 0, 1)];
  const flatHhi = val(M.oiConcentration(flat, 'CE'));
  assert.ok(Math.abs(flatHhi.hhi - 1 / 3) < 1e-12, 'uniform chain HHI = 1/N'); checks += 1;
  assert.ok(flatHhi.hhi > ce.hhi, 'raw HHI is inflated by a SMALLER strike count (why hhiNorm exists)'); checks += 1;
  assert.ok(flatHhi.hhiNorm < ce.hhiNorm, 'normalised HHI: uniform (0) < concentrated'); checks += 1;
  eq(reason(M.oiConcentration([], 'CE')), 'NO_LEGS', 'empty chain refused');
  eq(reason(M.oiConcentration([leg(1, 'CE', 1, 0, 1)], 'PE')), 'NO_SIDE', 'no PE legs refused');
}

console.log('== 2. highest-OI levels ==');
{
  const lv = val(M.highestOiLevels(CHAIN, 25600));
  eq(lv.maxCeOiStrike, 25600, 'max CE OI strike');
  eq(lv.maxPeOiStrike, 25600, 'max PE OI strike');
  eq(lv.totalCeOi, 10000, 'CE total');
  near(lv.spotDistanceCe, 0, 'distance at the money');
  const off = val(M.highestOiLevels(CHAIN, 25500));
  near(off.spotDistanceCe, (25600 - 25500) / 25500, 'distance when spot differs');
  const noSpot = val(M.highestOiLevels(CHAIN, null));
  eq(noSpot.spotDistanceCe, null, 'unknown spot -> distance stays null, never 0');
}

console.log('== 3. OI-change-based levels ==');
{
  const ch = val(M.oiChangeLevels(CHAIN));
  eq(ch.maxCeChangeStrike, 25600, 'largest CE OI increase');
  eq(ch.maxPeChangeStrike, 25600, 'largest PE OI increase');
  eq(ch.totalCeChange, 100 + 900 + 200 - 50 + 0, 'CE total change');
  eq(ch.totalPeChange, 150 + 400 - 100 + 0 + 0, 'PE total change');
  // largest |ΔOI| over BOTH sides summed per strike: 25600 = 900+400 = 1300
  eq(ch.maxAbsTotalChangeStrike, 25600, 'largest combined |ΔOI| strike');
}

console.log('== 4. OI-level migration ==');
{
  const prev = val(M.highestOiLevels(CHAIN, 25500));
  const now = val(M.highestOiLevels(CHAIN, 25700));
  const mig = val(M.oiLevelMigration(now, prev, 25700, 25500));
  eq(mig.ceShift, 0, 'CE level unchanged');
  eq(mig.ceMigration, 'STATIONARY', 'unmoved level is STATIONARY, not AGAINST_SPOT');
  near(mig.spotShift, (25700 - 25500) / 25500, 'spot shift');
  const moved = val(M.oiLevelMigration(
    val(M.highestOiLevels([leg(25700, 'CE', 9999, 1, 1), leg(25800, 'CE', 1, 1, 1), leg(25700, 'PE', 1, 1, 1), leg(25600, 'PE', 9999, 1, 1)], 25700)),
    prev, 25700, 25500));
  eq(moved.ceMigration, 'WITH_SPOT', 'level rose with spot');
  eq(reason(M.oiLevelMigration(now, null, 25700, 25500)), 'NO_PRIOR_SNAPSHOT', 'migration needs a prior snapshot');
}

console.log('== 5. PCR as a regime feature ==');
{
  const p = val(M.pcrState(CHAIN, []));
  near(p.pcr, 10500 / 10000, 'PCR = PE OI / CE OI');
  eq(p.regime, 'UNKNOWN', 'regime unknown until prior quantiles exist');
  eq(p.thresholds, null, 'no thresholds without history');
  const priors = Array.from({ length: 50 }, (_, i) => 0.5 + i * 0.02); // 0.50 .. 1.48
  const heavy = val(M.pcrState(CHAIN, priors));
  assert.ok(heavy.regime !== 'UNKNOWN', 'regime resolves with 50 priors'); checks += 1;
  const peHeavy = val(M.pcrState([leg(1, 'CE', 100, 0, 1), leg(1, 'PE', 100000, 0, 1)], priors));
  eq(peHeavy.regime, 'PE_HEAVY', 'very high PCR is PE_HEAVY');
  const ceHeavy = val(M.pcrState([leg(1, 'CE', 100000, 0, 1), leg(1, 'PE', 1, 0, 1)], priors));
  eq(ceHeavy.regime, 'CE_HEAVY', 'very low PCR is CE_HEAVY');
  const chg = val(M.pcrState(CHAIN, priors, 0.8));
  near(chg.pcrChange, chg.pcr - 0.8, 'pcrChange vs previous');
  eq(reason(M.pcrState([leg(1, 'PE', 5000, 0, 1)], [])), 'NO_TOTAL_OI', 'zero CE OI -> PCR undefined, NOT 0');
}

console.log('== 6/7. price direction x CE / PE OI change ==');
{
  eq(val(M.priceDirectionVsSideOi(CHAIN, 'CE', 25700, 25600)).state, 'PRICE_UP_OI_UP', 'up + CE OI up');
  eq(val(M.priceDirectionVsSideOi(CHAIN, 'PE', 25700, 25600)).state, 'PRICE_UP_OI_UP', 'up + PE OI up');
  const down = [leg(1, 'CE', 10, -100, 1), leg(1, 'PE', 10, -100, 1)];
  eq(val(M.priceDirectionVsSideOi(down, 'CE', 25500, 25600)).state, 'PRICE_DOWN_OI_DOWN', 'down + OI down');
  eq(val(M.priceDirectionVsSideOi(down, 'PE', 25500, 25600)).state, 'PRICE_DOWN_OI_DOWN', 'down + PE OI down');
  eq(reason(M.priceDirectionVsSideOi(CHAIN, 'CE', 25600, 25600)), 'NO_PRICE_MOVE', 'flat spot refused');
  eq(reason(M.priceDirectionVsSideOi([leg(1, 'CE', 10, 0, 1)], 'CE', 25700, 25600)), 'NO_OI_CHANGE', 'zero ΔOI refused');
  const absent = [leg(1, 'CE', 10, null, 1)];
  eq(reason(M.priceDirectionVsSideOi(absent, 'CE', 25700, 25600)), 'NO_OI_CHANGE', 'ABSENT ΔOI refused like zero');
}

console.log('== 8. price x OI x volume ==');
{
  const v = val(M.priceOiVolume(CHAIN, 25700, 25600, 1.4));
  eq(v.oiGainingVolume, 500 + 800 + 300 + 300 + 600, 'volume on ΔOI>0 legs');
  eq(v.oiLosingVolume, 100 + 200, 'volume on ΔOI<0 legs');
  near(v.oiVolumeRatio, v.oiGainingVolume / v.oiLosingVolume, 'ratio');
  eq(v.quadrant, 'PRICE_UP_OI_UP', 'quadrant');
  eq(v.sessionVolumeRatio, 1.4, 'caller-supplied session volume ratio passed through');
  const noLosing = [leg(1, 'CE', 10, 50, 100)];
  eq(reason(M.priceOiVolume(noLosing, 25700, 25600)), 'NO_VOLUME_BOTH_SIDES', 'no losing volume -> undefined ratio');
  const noVol = [leg(1, 'CE', 10, 50, null)];
  eq(reason(M.priceOiVolume(noVol, 25700, 25600)), 'NO_VOLUME', 'absent volume refused');
}

console.log('== 9/10/11. candle shadow geometry ==');
{
  const up = val(M.shadowGeometry({ open: 100, high: 110, low: 95, close: 105, volume: 10 }));
  near(up.upperShadow, (110 - 105) / 15, 'upper shadow');
  near(up.lowerShadow, (100 - 95) / 15, 'lower shadow');
  near(up.wickBodyRatio, (5 + 5) / 5, 'wick/body ratio');
  eq(up.direction, 'UP', 'direction');
  const dn = val(M.shadowGeometry({ open: 105, high: 110, low: 95, close: 100, volume: 10 }));
  near(dn.upperShadow, (110 - 105) / 15, 'upper shadow, down candle uses max(o,c)');
  near(dn.lowerShadow, (100 - 95) / 15, 'lower shadow, down candle uses min(o,c)');
  eq(reason(M.shadowGeometry({ open: 100, high: 100, low: 100, close: 100, volume: 1 })), 'ZERO_RANGE', 'no range');
  eq(reason(M.shadowGeometry({ open: 100, high: 110, low: 95, close: 100, volume: 1 })), 'ZERO_BODY', 'no body -> ratio undefined');
  const shadowsSum = val(M.shadowGeometry({ open: 100, high: 110, low: 95, close: 105, volume: 1 }));
  assert.ok(shadowsSum.upperShadow + shadowsSum.lowerShadow <= 1 + 1e-12, 'shadows are fractions of the range'); checks += 1;
}

console.log('== 12/13. acceptance at OI levels + breakout class ==');
{
  const tol = 5;
  const conf = val(M.testOiLevel({ open: 100, high: 120, low: 99, close: 118, volume: 10 }, 110, 'RESISTANCE', tol));
  eq(conf.breakout, 'CONFIRMED_BREAKOUT', 'closed well beyond -> confirmed');
  eq(conf.outcome, 'ACCEPTED_BEYOND', 'closed in the upper half -> accepted');
  const failed = val(M.testOiLevel({ open: 100, high: 120, low: 99, close: 105, volume: 10 }, 110, 'RESISTANCE', tol));
  eq(failed.breakout, 'FAILED_BREAKOUT', 'traded beyond, closed back below -> failed');
  eq(failed.outcome, 'REJECTED_AT_LEVEL', 'closed below the level -> rejected');
  const early = val(M.testOiLevel({ open: 100, high: 120, low: 99, close: 112, volume: 10 }, 110, 'RESISTANCE', tol));
  eq(early.breakout, 'EARLY_BREAKOUT', 'closed beyond but inside the tolerance band');
  const none = val(M.testOiLevel({ open: 100, high: 105, low: 99, close: 104, volume: 10 }, 110, 'RESISTANCE', tol));
  eq(none.breakout, 'NONE', 'never reached the level');
  eq(none.outcome, 'NOT_TESTED', 'not tested');
  const sup = val(M.testOiLevel({ open: 100, high: 101, low: 85, close: 87, volume: 10 }, 95, 'SUPPORT', tol));
  eq(sup.breakout, 'CONFIRMED_BREAKOUT', 'support mirrored: closing well BELOW support is a confirmed breakdown');
  const supFail = val(M.testOiLevel({ open: 100, high: 101, low: 85, close: 96, volume: 10 }, 95, 'SUPPORT', tol));
  eq(supFail.breakout, 'FAILED_BREAKOUT', 'support mirrored: dipped below, closed back above -> failed');
  const closedOnly = val(M.testOiLevel({ open: 100, high: 140, low: 99, close: 112, volume: 10 }, 110, 'RESISTANCE', tol));
  eq(closedOnly.outcome, 'CLOSED_BEYOND', 'closed beyond the level but in the LOWER half of the bar');
  eq(reason(M.testOiLevel({ open: 100, high: 120, low: 99, close: 118, volume: 10 }, null, 'RESISTANCE', tol)), 'NO_LEVEL', 'no level');
}

console.log('== ABSENT != ZERO (the Stage-1 rule, asserted per feature) ==');
{
  // Same chain shape, one built from ABSENT OI and one from ZERO OI.
  const absentOi = [leg(1, 'CE', null, null, 10), leg(2, 'CE', null, null, 10)];
  const zeroOi = [leg(1, 'CE', 0, 0, 10), leg(2, 'CE', 0, 0, 10)];
  eq(reason(M.oiConcentration(absentOi, 'CE')), 'NO_OI', 'absent OI -> NO_OI');
  eq(reason(M.oiConcentration(zeroOi, 'CE')), 'NO_TOTAL_OI', 'zero OI -> NO_TOTAL_OI');
  assert.notEqual(reason(M.oiConcentration(absentOi, 'CE')), reason(M.oiConcentration(zeroOi, 'CE')), 'absent and zero are DIFFERENT answers'); checks += 1;
  eq(reason(M.highestOiLevels(absentOi, 100)), 'NO_OI', 'absent OI has no level');
  eq(reason(M.oiChangeLevels([leg(1, 'CE', null, null, 1)])), 'NO_OI_CHANGE', 'absent ΔOI refused');
  eq(reason(M.pcrState(absentOi, [])), 'NO_TOTAL_OI', 'absent OI cannot become a PCR');
}

console.log('== determinism (replay-safe) ==');
{
  const a = JSON.stringify(M.oiConcentration(CHAIN, 'CE'));
  const b = JSON.stringify(M.oiConcentration(CHAIN, 'CE'));
  eq(a, b, 'same input -> same output');
  const g1 = JSON.stringify(M.shadowGeometry({ open: 100, high: 110, low: 95, close: 105, volume: 1 }));
  const g2 = JSON.stringify(M.shadowGeometry({ open: 100, high: 110, low: 95, close: 105, volume: 1 }));
  eq(g1, g2, 'geometry deterministic');
  const t1 = JSON.stringify(M.testOiLevel({ open: 100, high: 120, low: 99, close: 118, volume: 10 }, 110, 'RESISTANCE', 5));
  const t2 = JSON.stringify(M.testOiLevel({ open: 100, high: 120, low: 99, close: 118, volume: 10 }, 110, 'RESISTANCE', 5));
  eq(t1, t2, 'level test deterministic');
}

console.log(`\nALL PRICE-PREDICTION FEATURE TESTS PASSED (${checks} assertions)`);
