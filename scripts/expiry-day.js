#!/usr/bin/env node
/**
 * expiry-day CLI — one entry point for the whole expiry-day decision engine.
 *
 *   node scripts/expiry-day.js analyze       --index NIFTY [--date YYYY-MM-DD]
 *   node scripts/expiry-day.js preopen       --index NIFTY [--date ...]
 *   node scripts/expiry-day.js regime        --index NIFTY [--date ...]
 *   node scripts/expiry-day.js signals       --index NIFTY [--date ...]
 *   node scripts/expiry-day.js backtest      [--index NIFTY]
 *   node scripts/expiry-day.js paper-report  [--date ...]
 *   node scripts/expiry-day.js all           [--date ...]        (all three indexes)
 *
 * Every command writes a machine-readable JSON artifact to
 *   reports/expiry-day/<command>-<index>-<date>.json
 * and prints a compact human summary. `expiry-prep.js` keeps its own
 * `generate` / `report` subcommands (documented in EXPIRY_DAY_PLAYBOOK.md).
 *
 * SAFETY: read-only against the database. It classifies and explains; it never
 * places, sizes or routes an order, and it never modifies risk parameters.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const C = require('./expiry-day-core');
const A = require('./expiry-day-analysis');
const B = require('./expiry-day-backtest');
const J = require('./expiry-day-paper-journal');
const S = require('./expiry-day-signals');

const OUT_ROOT = path.join(process.cwd(), 'reports', 'expiry-day');

function argOf(rest, name, dflt) {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 && rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[i + 1] : dflt;
}

function writeArtifact(name, payload) {
  fs.mkdirSync(OUT_ROOT, { recursive: true });
  const p = path.join(OUT_ROOT, name);
  fs.writeFileSync(p, `${JSON.stringify(payload, null, 2)}\n`);
  return p;
}

const f2 = (v, d = 2) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? '—' : Number(v).toFixed(d));

/** Human summary of one cycle. */
function summarise(cycle) {
  const L = [];
  L.push(`\n=== ${cycle.index} ${cycle.dateIso} (generated ${cycle.istNow} IST) ===`);
  L.push(`spot ${f2(cycle.spot)}  |  ticks ${cycle.data.ticks}  bars ${cycle.data.bars}  chainRows ${cycle.data.chainRows} (${cycle.data.chainSource})`);
  const fr = cycle.freshness || {};
  L.push(`freshness ${fr.overallBucket}  dataAge=${fr.dataAgeMs}ms  OI_STALE=${fr.OI_STALE}`);
  if (cycle.impliedMove) L.push(`implied move ±${f2(cycle.impliedMove.impliedMovePts)} (${cycle.impliedMove.impliedMovePct}%)  [${cycle.impliedMove.impliedLow} – ${cycle.impliedMove.impliedHigh}]`);
  if (cycle.realised) L.push(`realised range ${f2(cycle.realised.range)} (${cycle.realised.low}–${cycle.realised.high})`);
  if (cycle.microstructure) {
    const m = cycle.microstructure;
    L.push(`PCR(OI) ${f2(m.pcrOi, 3)}  PCR(vol) ${f2(m.pcrVol, 3)}  maxPain ${m.maxPain?.strike ?? '—'}  walls CE ${m.walls.callWall?.strike ?? '—'} / PE ${m.walls.putWall?.strike ?? '—'}`);
  }
  if (cycle.gap) L.push(`gap ${cycle.gap.pct}% → ${cycle.gap.class}${cycle.gap.position ? ` · open ${cycle.gap.position}` : ''}`);
  if (cycle.openingRange?.ready) {
    const o = cycle.openingRange;
    L.push(`OR ${f2(o.orLow)}–${f2(o.orHigh)} (buf ${f2(o.breakBuffer)})  closePos ${o.closePos}  held=${o.held}  failed=${o.breakFailed}  vwap ${o.vwapRelation}`);
  }
  L.push(`REGIME  ${cycle.regime.regime}  (${cycle.regime.reason})  confidence ${cycle.regime.confidence} [UNVALIDATED]`);
  const d = cycle.direction;
  L.push(`BIAS    ${d.view}  agreement ${(d.agreementShare * 100).toFixed(0)}%  net ${d.netEvidence}  conflict=${d.signalConflict}`);
  L.push(`  for:     ${d.bullishEvidence.join(', ') || '—'}`);
  L.push(`  against: ${d.bearishEvidence.join(', ') || '—'}`);
  L.push(`  neutral: ${d.neutralEvidence.join(', ') || '—'}`);
  L.push(`  abstained: ${d.unusableBuckets.join(', ') || '—'}`);
  if (d.whyNoTrade.length) L.push(`  why NO TRADE: ${d.whyNoTrade.join(' | ')}`);
  L.push(`TRADEABLE ${cycle.tradeable.verdict}  noTradeType=${cycle.noTrade?.type ?? '—'}  blocking: ${cycle.tradeable.blocking.join(', ') || '—'}`);
  L.push(`SETUPS  ${cycle.setups.candidates.map((c) => c.setup).join(', ') || '—'}`);
  L.push(`AUTHORITY canPlaceOrder=${cycle.authority.canPlaceOrder} · strategy armed=NO (operator approval pending)`);
  return L.join('\n');
}

/** PRE-OPEN view: derived from the same cycle, focused on the open. */
function preOpenView(cycle) {
  return {
    index: cycle.index,
    dateIso: cycle.dateIso,
    phase: 'PRE_OPEN_OR_EARLY_SESSION',
    previousClose: cycle.data.previousSession?.close ?? null,
    previousHigh: cycle.data.previousSession?.high ?? null,
    previousLow: cycle.data.previousSession?.low ?? null,
    previousSessionDate: cycle.data.previousSession?.date ?? null,
    spot: cycle.spot,
    gapPct: cycle.gap?.pct ?? null,
    gapClass: cycle.gap?.class ?? null,
    openingPosition: cycle.gap?.position ?? null,
    impliedMove: cycle.impliedMove,
    expectedRange: cycle.impliedMove ? { low: cycle.impliedMove.impliedLow, high: cycle.impliedMove.impliedHigh } : null,
    distanceFromWalls: cycle.microstructure ? {
      callWall: cycle.microstructure.walls.callWall?.strike ?? null,
      putWall: cycle.microstructure.walls.putWall?.strike ?? null,
      ptsToCallWall: cycle.microstructure.walls.callWall && cycle.spot ? f2(cycle.microstructure.walls.callWall.strike - cycle.spot) : null,
      ptsToPutWall: cycle.microstructure.walls.putWall && cycle.spot ? f2(cycle.spot - cycle.microstructure.walls.putWall.strike) : null,
    } : null,
    atm: cycle.optionMetrics?.atm ?? null,
    iv: cycle.optionMetrics?.iv ?? null,
    volatilityRegime: cycle.impliedMove && cycle.spot
      ? (cycle.impliedMove.impliedMovePct >= 1.0 ? 'HIGH_EXPECTED_RANGE' : cycle.impliedMove.impliedMovePct >= 0.5 ? 'NORMAL' : 'COMPRESSED')
      : 'UNKNOWN',
    note: 'The opening condition is a LOCATION fact, never a direction vote. No trade is implied by a gap.',
  };
}

async function runCycleFor(indexKey, dateIso, nowMs) {
  return A.withDb((conn) => A.runCycle(conn, { indexKey, dateIso, nowMs, config: { daysToExpiry: 0 } }));
}

async function main() {
  const [cmd = 'analyze', ...rest] = process.argv.slice(2);
  const nowMs = Date.now();
  const dateIso = argOf(rest, 'date', C.istDateIso(nowMs));
  const indexArg = argOf(rest, 'index', 'NIFTY');
  const indexes = argOf(rest, 'all', null) ? Object.keys(A.INDEXES) : [indexArg.toUpperCase()];

  if (cmd === 'backtest') {
    // Session inventory straight from the tape, then an honest verdict.
    const inventory = await A.withDb(async (conn) => {
      const out = {};
      for (const [k, v] of Object.entries(A.INDEXES)) {
        const [rows] = await conn.query(
          'SELECT DISTINCT DATE(ts) d FROM unified_market_snapshots_history WHERE symbol = ? ORDER BY d',
          [v.symbol],
        );
        out[k] = rows.map((r) => String(r.d).slice(0, 10));
      }
      return out;
    });
    const sessions = Object.entries(inventory).map(([k, dates]) => ({
      index: k,
      sessions: B.classifySessionDates(dates, { expiryDates: [] }),   // no expiry map is available yet
    }));
    const report = {
      generatedAt: new Date(nowMs).toISOString(),
      inventoryByIndex: Object.fromEntries(Object.entries(inventory).map(([k, d]) => [k, { sessions: d.length, first: d[0] ?? null, last: d[d.length - 1] ?? null }])),
      runs: sessions.map((s) => B.buildRun({ indexKey: s.index, sessions: s.sessions, setupResults: {} })),
      expiryDateMapStatus: 'UNAVAILABLE — the engine has no authoritative expiry-date table wired in; expiry sessions cannot be identified automatically yet',
      conclusion: 'NO EXPIRY SESSION HAS EVER BEEN CAPTURED. Every setup is an unvalidated hypothesis. Arming is blocked by evidence, not by code.',
    };
    const p = writeArtifact(`backtest-${dateIso}.json`, report);
    console.log(`backtest report → ${p}`);
    for (const [k, v] of Object.entries(report.inventoryByIndex)) console.log(`  ${k}: ${v.sessions} index sessions (${v.first} … ${v.last})`);
    console.log(`\n${report.conclusion}`);
    return;
  }

  if (cmd === 'paper-report') {
    const rep = J.paperReport(dateIso);
    const p = writeArtifact(`paper-report-${dateIso}.json`, rep);
    console.log(`paper report → ${p}\n`);
    console.log(JSON.stringify(rep, null, 2));
    return;
  }

  const cycles = [];
  for (const k of indexes) {
    try {
      const cycle = await runCycleFor(k, dateIso, nowMs);
      cycles.push(cycle);
      if (['analyze', 'all', k === indexArg ? 'analyze' : 'all'].includes(cmd)) console.log(summarise(cycle));
      if (cmd === 'preopen') {
        const v = preOpenView(cycle);
        const p = writeArtifact(`preopen-${k}-${dateIso}.json`, v);
        console.log(`\nPRE-OPEN ${k} → ${p}`);
        console.log(`  prevClose ${f2(v.previousClose)}  spot ${f2(v.spot)}  gap ${v.gapPct}% (${v.gapClass})  open ${v.openingPosition}`);
        console.log(`  expected range ${f2(v.expectedRange?.low)}–${f2(v.expectedRange?.high)}  vol regime ${v.volatilityRegime}`);
        console.log(`  walls: call ${v.distanceFromWalls?.callWall} (+${v.distanceFromWalls?.ptsToCallWall})  put ${v.distanceFromWalls?.putWall} (-${v.distanceFromWalls?.ptsToPutWall})`);
      }
      if (cmd === 'regime') {
        console.log(`\nREGIME ${k}: ${cycle.regime.regime} (${cycle.regime.reason}) conf ${cycle.regime.confidence}`);
        for (const e of cycle.regime.evidence) console.log(`   ${e.pass === true ? '✓' : e.pass === false ? '✗' : '–'} ${e.name} (w${e.weight}) ${e.detail}`);
      }
      if (cmd === 'signals') {
        console.log(`\nSIGNALS ${k}: bias ${cycle.direction.view}  conflict ${cycle.direction.signalConflict}`);
        for (const b of cycle.direction.buckets) console.log(`   ${b.usable ? '•' : '○'} ${b.name.padEnd(30)} score ${String(b.score).padStart(7)} w ${b.contribution}  [${b.freshness}] ${b.reason}`);
        console.log(`   TRADEABLE: ${cycle.tradeable.verdict}  blocking: ${cycle.tradeable.blocking.join(', ') || '—'}`);
      }
      writeArtifact(`${cmd}-${k}-${dateIso}.json`, cycle);
    } catch (e) {
      console.error(`${k} failed: ${e.message}`);
    }
  }

  if (cmd === 'all' || cmd === 'analyze') {
    // Only journal a cycle that actually resolved. A failed/aborted cycle must
    // never be recorded as a market observation.
    if (cycles.length) {
      const jp = J.append(J.buildRecord({ cycle: cycles[0], nowMs }), { dir: J.DEFAULT_DIR });
      console.log(`\npaper journal ← ${jp}  (hypothetical only, no order placed)`);
    } else {
      console.log('\nno cycle resolved — nothing written to the paper journal');
    }
  }
}

module.exports = { summarise, preOpenView };

if (require.main === module) {
  main().catch((e) => { console.error('expiry-day failed:', e.stack || e.message); process.exit(1); });
}
