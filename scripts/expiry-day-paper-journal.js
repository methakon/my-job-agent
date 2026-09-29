#!/usr/bin/env node
/**
 * expiry-day PAPER/SHADOW journal — append-only local file store.
 *
 * Stores every hypothetical signal with the full provenance the spec requires
 * (timestamp, index, spot, setup, direction, candidate contract, entry price,
 * spread, expected move, stop/invalidation, target, exit, reason, slippage,
 * P&L, MAE, MFE, data freshness, contributing signals, and WHY NOT TRADE).
 *
 * SAFETY: this is a LOCAL JSONL file under the scratch directory. It is NOT a
 * trading table, it is never read by the trading engine, and appending a
 * hypothetical signal cannot place an order. REAL_ORDER_ALLOWED is not touched
 * by anything in this file.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const C = require('./expiry-day-core');

const DEFAULT_DIR = '/home/swarna-sekhar-dhar/.hermes/cache/scratch/expiry-day-journal';

function journalPath(dateIso, dir = DEFAULT_DIR) {
  return path.join(dir, `expiry-day-signals-${dateIso}.jsonl`);
}

/** Build the record for one cycle. Pure — the caller does the writing. */
function buildRecord({ cycle, nowMs = Date.now() }) {
  const d = cycle.direction || {};
  const t = cycle.tradeable || {};
  const setups = cycle.setups?.candidates ?? [];
  return {
    schema: 'expiry-day-signal/v1',
    recordedAtUtc: new Date(nowMs).toISOString(),
    recordedAtIst: `${C.istDateIso(nowMs)} ${C.istHm(nowMs)}`,
    index: cycle.index,
    sessionDate: cycle.dateIso,
    spot: cycle.spot ?? null,

    bias: d.view ?? 'NO_TRADE',
    confidence: d.confidence ?? 0,
    confidenceIsCalibrated: d.confidenceIsCalibrated === true,
    confidenceNote: d.confidenceNote ?? null,

    regime: cycle.regime?.regime ?? 'UNKNOWN',
    regimeReason: cycle.regime?.reason ?? null,
    regimeValidated: cycle.regime?.validated === true,

    evidenceFor: d.bullishEvidence ?? [],
    evidenceAgainst: d.bearishEvidence ?? [],
    evidenceNeutral: d.neutralEvidence ?? [],
    evidenceUnusable: d.unusableBuckets ?? [],
    signalConflict: d.signalConflict === true,
    netEvidence: d.netEvidence ?? null,
    agreementShare: d.agreementShare ?? null,

    dataFreshness: cycle.freshness ?? null,
    oiStale: cycle.freshness?.OI_STALE ?? null,

    setup: setups.map((c) => c.setup),
    setupReasons: setups.map((c) => ({ setup: c.setup, why: c.why })),

    invalidation: cycle.openingRange ? {
      orHigh: cycle.openingRange.orHigh ?? null,
      orLow: cycle.openingRange.orLow ?? null,
      breakBuffer: cycle.openingRange.breakBuffer ?? null,
    } : null,

    whyNotTrade: d.whyNoTrade ?? [],
    blockingGates: t.blocking ?? [],
    // Refined primary reason. Purely additive: the full audit trail above is
    // preserved, and this does not alter any signal behaviour.
    noTradeType: cycle.noTrade?.type ?? null,
    noTradeBecause: cycle.noTrade?.because ?? null,

    // Paper-only hypotheticals. Null unless a candidate contract was evaluated.
    hypothetical: {
      contract: null,
      entryPrice: null,
      spread: cycle.optionMetrics?.atm?.spread ?? null,
      expectedMove: cycle.impliedMove ?? null,
      stop: null,
      target: null,
      exitPrice: null,
      exitReason: null,
      slippagePts: null,
      pnl: null,
      maePts: null,
      mfePts: null,
    },

    authority: cycle.authority ?? { canPlaceOrder: false },
  };
}

/** Append a record (JSONL). Returns the path written. */
function append(record, { dir = DEFAULT_DIR } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const p = journalPath(record.sessionDate, dir);
  fs.appendFileSync(p, `${JSON.stringify(record)}\n`);
  return p;
}

/** Read a day's records back (read-only). */
function read(dateIso, { dir = DEFAULT_DIR } = {}) {
  const p = journalPath(dateIso, dir);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return { parseError: true, raw: l.slice(0, 200) }; } });
}

/**
 * Paper report: how many cycles, what the biases were, and crucially how many
 * were NO_TRADE (a high NO_TRADE rate is a healthy, honest result).
 */
function paperReport(dateIso, { dir = DEFAULT_DIR } = {}) {
  const recs = read(dateIso, { dir });
  const byBias = {};
  const byRegime = {};
  const blocking = {};
  let conflictCount = 0; let oiStaleCount = 0; let calibratedCount = 0;
  for (const r of recs) {
    byBias[r.bias] = (byBias[r.bias] ?? 0) + 1;
    byRegime[r.regime] = (byRegime[r.regime] ?? 0) + 1;
    for (const b of r.blockingGates ?? []) blocking[b] = (blocking[b] ?? 0) + 1;
    if (r.signalConflict) conflictCount += 1;
    if (r.oiStale) oiStaleCount += 1;
    if (r.confidenceIsCalibrated) calibratedCount += 1;
  }
  return {
    schema: 'expiry-day-paper-report/v1',
    sessionDate: dateIso,
    cycles: recs.length,
    byBias, byRegime,
    topBlockingGates: Object.entries(blocking).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ gate: k, cycles: v })),
    signalConflictCycles: conflictCount,
    oiStaleCycles: oiStaleCount,
    calibratedConfidenceCycles: calibratedCount,
    noTradeRate: recs.length ? C.r2((byBias.NO_TRADE ?? 0) / recs.length, 4) : null,
    note: 'NO_TRADE cycles are a successful outcome. Confidence is uncalibrated until historical expiry sessions exist.',
  };
}

module.exports = { DEFAULT_DIR, journalPath, buildRecord, append, read, paperReport };
