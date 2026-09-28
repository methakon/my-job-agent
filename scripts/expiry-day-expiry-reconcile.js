#!/usr/bin/env node
/**
 * EXPIRY-DATE RECONCILIATION DRY RUN — READ ONLY. Executes no UPDATE.
 *
 * Question: `fnf_option_contracts` rows carry expiry='2026-09-26' (a Saturday that
 * is not an NIFTY/BANKNIFTY/SENSEX expiry). The 26SEP symbol namespace actually
 * refers to the September-2026 monthly, which expires 2026-09-29.
 *
 * INVARIANT (operator-directed):
 *     CONTRACT MASTER EXPIRY DATE  >  DATABASE EXPIRY DATE  >  SYMBOL PARSING
 *
 * So the proposed expiry is resolved ONLY from the authoritative contract master
 * by exact symbol lookup. If a symbol is absent, ambiguous, or the master has a
 * different lot size (i.e. it is a different contract), the row is marked
 * EXPIRY_RECONCILIATION_UNRESOLVED and is NOT proposed for change.
 *
 * Outputs a JSON + markdown dry-run report and the exact SQL that WOULD run.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const C = require('./expiry-day-core');

const MASTER_DIR = process.env.FNO_MASTER_DIR || '/home/swarna-sekhar-dhar/.hermes/cache/scratch';
const OUT_DIR = process.env.FNO_DRYRUN_DIR || path.join(process.cwd(), 'reports', 'expiry-day');

/** Parse the FYERS master into symbol → authoritative record. */
function loadMaster(dir = MASTER_DIR) {
  const bySymbol = new Map();
  const files = ['NSE_FO.csv', 'BSE_FO.csv'];
  for (const f of files) {
    const p = path.join(dir, f);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      if (!line) continue;
      const c = line.split(',');
      if (c.length < 16) continue;
      const symbol = c[9];
      if (!symbol || !(symbol.endsWith('CE') || symbol.endsWith('PE'))) continue;
      const strike = Number(c[15]);
      const epoch = Number(c[8]);
      if (!Number.isFinite(strike) || strike <= 0 || !Number.isFinite(epoch)) continue;
      // Duplicate symbols would make the lookup ambiguous → mark them.
      const rec = {
        symbol,
        description: (c[1] || '').trim(),
        instrumentToken: c[0],
        lotSize: Number(c[3]),
        tickSize: Number(c[4]),
        exchange: symbol.split(':')[0],
        underlyingName: c[13],
        strike,
        optionType: symbol.endsWith('CE') ? 'CE' : 'PE',
        // FYERS encodes MONTH+YEAR in the symbol; the real date is the epoch.
        expiry: new Date(epoch * 1000).toISOString().slice(0, 10),
        masterFile: f,
      };
      if (bySymbol.has(symbol)) bySymbol.get(symbol).ambiguous = true;
      else bySymbol.set(symbol, rec);
    }
  }
  return bySymbol;
}

/** Quote/reference count for a symbol, from a caller-supplied count map. */
function refCount(map, symbol) {
  return map?.[symbol] ?? null;
}

/**
 * Decide, per row, what (if anything) should change.
 * Never guesses. Returns one of:
 *   NO_CHANGE_ALREADY_CORRECT | CHANGE_PROPOSED | EXPIRY_RECONCILIATION_UNRESOLVED
 */
function reconcileRow(row, master) {
  const base = { ...row, status: null, proposedExpiry: null, masterExpiry: null, reason: null };
  if (!row.symbol) {
    return { ...base, status: 'EXPIRY_RECONCILIATION_UNRESOLVED', reason: 'NO_SYMBOL' };
  }
  const rec = master.get(row.symbol);
  if (!rec) {
    return { ...base, status: 'EXPIRY_RECONCILIATION_UNRESOLVED', reason: 'NOT_IN_CONTRACT_MASTER' };
  }
  if (rec.ambiguous) {
    return { ...base, status: 'EXPIRY_RECONCILIATION_UNRESOLVED', masterExpiry: rec.expiry, reason: 'AMBIGUOUS_IN_CONTRACT_MASTER' };
  }
  // Cross-check identity fields: a same-symbol record with a different strike,
  // option type or lot size is a different contract → do not touch.
  if (Number.isFinite(Number(row.strike)) && rec.strike !== Number(row.strike)) {
    return { ...base, status: 'EXPIRY_RECONCILIATION_UNRESOLVED', masterExpiry: rec.expiry, reason: `STRIKE_MISMATCH master=${rec.strike} db=${row.strike}` };
  }
  if (row.optionType && rec.optionType !== row.optionType) {
    return { ...base, status: 'EXPIRY_RECONCILIATION_UNRESOLVED', masterExpiry: rec.expiry, reason: `OPTION_TYPE_MISMATCH master=${rec.optionType} db=${row.optionType}` };
  }
  if (Number.isFinite(Number(row.lotSize)) && rec.lotSize !== Number(row.lotSize)) {
    return { ...base, status: 'EXPIRY_RECONCILIATION_UNRESOLVED', masterExpiry: rec.expiry, reason: `LOT_SIZE_MISMATCH master=${rec.lotSize} db=${row.lotSize}` };
  }
  if (rec.expiry === row.expiry) {
    return { ...base, status: 'NO_CHANGE_ALREADY_CORRECT', masterExpiry: rec.expiry };
  }
  return {
    ...base,
    status: 'CHANGE_PROPOSED',
    proposedExpiry: rec.expiry,
    masterExpiry: rec.expiry,
    masterLotSize: rec.lotSize,
    masterToken: rec.instrumentToken,
    masterDescription: rec.description,
    masterFile: rec.masterFile,
  };
}

function summarise(rows) {
  const s = {
    AFFECTED_ROWS_TOTAL: rows.length,
    ROWS_WITH_UNIQUE_AUTHORITATIVE_MAPPING: rows.filter((r) => r.status === 'CHANGE_PROPOSED').length,
    ROWS_WITHOUT_MAPPING: rows.filter((r) => r.status === 'EXPIRY_RECONCILIATION_UNRESOLVED').length,
    ROWS_WHERE_CURRENT_DATE_IS_ALREADY_CORRECT: rows.filter((r) => r.status === 'NO_CHANGE_ALREADY_CORRECT').length,
    ROWS_REQUIRING_CHANGE: rows.filter((r) => r.status === 'CHANGE_PROPOSED').length,
  };
  s.byUnderlying = {};
  for (const r of rows) {
    const u = r.underlying || 'unknown';
    s.byUnderlying[u] ??= { total: 0, change: 0, unresolved: 0, alreadyCorrect: 0 };
    s.byUnderlying[u].total += 1;
    if (r.status === 'CHANGE_PROPOSED') s.byUnderlying[u].change += 1;
    else if (r.status === 'EXPIRY_RECONCILIATION_UNRESOLVED') s.byUnderlying[u].unresolved += 1;
    else s.byUnderlying[u].alreadyCorrect += 1;
  }
  s.byProposedExpiry = {};
  for (const r of rows.filter((x) => x.status === 'CHANGE_PROPOSED')) {
    s.byProposedExpiry[r.proposedExpiry] = (s.byProposedExpiry[r.proposedExpiry] ?? 0) + 1;
  }
  s.unresolvedReasons = {};
  for (const r of rows.filter((x) => x.status === 'EXPIRY_RECONCILIATION_UNRESOLVED')) {
    const k = String(r.reason).split(' ')[0];
    s.unresolvedReasons[k] = (s.unresolvedReasons[k] ?? 0) + 1;
  }
  return s;
}

/** The SQL that WOULD run. Generated, never executed. */
function buildSql(rows) {
  const changes = rows.filter((r) => r.status === 'CHANGE_PROPOSED');
  if (!changes.length) return '-- no changes proposed\n';
  const body = changes.map((r) => `UPDATE fnf_option_contracts SET expiry='${r.proposedExpiry}' WHERE id='${r.id}' AND expiry='${r.expiry}';`).join('\n');
  return [
    '-- DRY RUN ONLY — generated by scripts/expiry-day-expiry-reconcile.js',
    '-- Precondition is part of the WHERE clause so a concurrent change cannot be',
    '-- silently overwritten: the row must still hold the audited expiry value.',
    `-- ${changes.length} row(s); proposed expiries: ${JSON.stringify(summarise(rows).byProposedExpiry)}`,
    'START TRANSACTION;',
    body,
    'COMMIT;',
  ].join('\n');
}

function toMarkdown(rows, s) {
  const L = [];
  L.push(`# Expiry-date reconciliation DRY RUN — ${new Date().toISOString()}`);
  L.push('');
  L.push('**DRY_RUN_ONLY — NO_MUTATION_PERFORMED.** This report was produced by a');
  L.push('read-only pass. No `UPDATE`, no `DELETE`, no DDL has been executed.');
  L.push('');
  L.push('Invariant applied: `CONTRACT MASTER EXPIRY > DATABASE EXPIRY > SYMBOL PARSING`.');
  L.push('Every proposed expiry comes from an exact-symbol lookup in the broker contract');
  L.push('master, cross-checked on strike, option type and lot size. Symbol strings were');
  L.push('never parsed to infer a date.');
  L.push('');
  L.push('## Counts');
  L.push('');
  for (const [k, v] of Object.entries(s)) {
    if (k === 'byUnderlying' || k === 'byProposedExpiry' || k === 'unresolvedReasons') continue;
    L.push(`- ${k}: **${v}**`);
  }
  L.push('');
  L.push('## By underlying');
  L.push('');
  L.push('| underlying | total | change | unresolved | already correct |');
  L.push('|---|---:|---:|---:|---:|');
  for (const [u, v] of Object.entries(s.byUnderlying)) {
    L.push(`| ${u} | ${v.total} | ${v.change} | ${v.unresolved} | ${v.alreadyCorrect} |`);
  }
  L.push('');
  if (Object.keys(s.byProposedExpiry).length) {
    L.push('## Proposed expiry distribution');
    L.push('');
    for (const [e, n] of Object.entries(s.byProposedExpiry)) L.push(`- ${e}: ${n} row(s)`);
    L.push('');
  }
  if (Object.keys(s.unresolvedReasons).length) {
    L.push('## Unresolved reasons');
    L.push('');
    for (const [r, n] of Object.entries(s.unresolvedReasons)) L.push(`- ${r}: ${n} row(s)`);
    L.push('');
  }
  const changes = rows.filter((r) => r.status === 'CHANGE_PROPOSED');
  if (changes.length) {
    L.push('## Rows proposed for change');
    L.push('');
    L.push('| id | symbol | underlying | strike | type | current | proposed | master lot | master token | refs |');
    L.push('|---|---|---|---:|---|---|---|---:|---|---:|');
    for (const r of changes.slice(0, 200)) {
      L.push(`| ${String(r.id).slice(0, 8)} | ${r.symbol} | ${r.underlying} | ${r.strike} | ${r.optionType} | ${r.expiry} | **${r.proposedExpiry}** | ${r.masterLotSize} | ${r.masterToken} | ${r.refs ?? '—'} |`);
    }
    if (changes.length > 200) L.push(`| … | *${changes.length - 200} more rows in the JSON artifact* | | | | | | | | |`);
    L.push('');
  }
  return L.join('\n');
}

/** Normalise a MySQL DATE/DATETIME value to YYYY-MM-DD. */
function toIsoDate(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) {
    // mysql2 returns DATE columns as a JS Date in LOCAL time. The `dateStrings`
    // option is not set on this connection, so normalise via UTC components.
    return new Date(v.getTime() - v.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
  }
  const s = String(v);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}

async function loadRows(conn) {
  // All rows are loaded and reconciled against the master, so the report also
  // proves which rows are ALREADY correct rather than only listing problems.
  // Read-only SELECTs.
  const [rows] = await conn.query(
    `SELECT c.id, c.underlying, c.symbol, c.strike, c.optionType, c.expiry, c.lotSize,
            c.createdAt, c.updatedAt,
            (SELECT COUNT(*) FROM fnf_option_quotes_history q
              WHERE q.contractSymbol COLLATE utf8mb4_unicode_ci = c.symbol COLLATE utf8mb4_unicode_ci) refs
       FROM fnf_option_contracts c
      ORDER BY c.underlying, c.symbol`,
  );
  return rows.map((r) => ({
    id: r.id, underlying: r.underlying, symbol: r.symbol, strike: Number(r.strike),
    optionType: r.optionType, expiry: toIsoDate(r.expiry), lotSize: Number(r.lotSize),
    createdAt: toIsoDate(r.createdAt), updatedAt: toIsoDate(r.updatedAt),
    refs: Number(r.refs) || 0,
  }));
}

async function main() {
  const master = loadMaster();
  const A = require('./expiry-day-analysis');
  const rows = await A.withDb(loadRows);
  const reconciled = rows.map((r) => reconcileRow(r, master));
  const s = summarise(reconciled);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const jsonPath = path.join(OUT_DIR, 'expiry-date-reconciliation-DRYRUN.json');
  fs.writeFileSync(jsonPath, `${JSON.stringify({
    generatedAt: new Date().toISOString(),
    DRY_RUN_ONLY: true,
    NO_MUTATION_PERFORMED: true,
    contractMaster: { dir: MASTER_DIR, symbols: master.size, field3IsLotSize: 'INFERRED (no header row in the CSV)' },
    summary: s,
    rows: reconciled,
  }, null, 2)}\n`);
  const mdPath = path.join(OUT_DIR, 'expiry-date-reconciliation-DRYRUN.md');
  fs.writeFileSync(mdPath, `${toMarkdown(reconciled, s)}\n`);
  const sqlPath = path.join(OUT_DIR, 'expiry-date-reconciliation-PROPOSED.sql');
  fs.writeFileSync(sqlPath, `${buildSql(reconciled)}\n`);

  console.log('EXPIRY-DATE RECONCILIATION — DRY RUN (no mutation performed)\n');
  for (const [k, v] of Object.entries(s)) {
    if (k === 'byUnderlying' || k === 'byProposedExpiry' || k === 'unresolvedReasons') continue;
    console.log(`  ${k}: ${v}`);
  }
  console.log('\nby underlying:');
  for (const [u, v] of Object.entries(s.byUnderlying)) console.log(`  ${u}: total=${v.total} change=${v.change} unresolved=${v.unresolved} alreadyCorrect=${v.alreadyCorrect}`);
  if (Object.keys(s.byProposedExpiry).length) {
    console.log('\nproposed expiry distribution:');
    for (const [e, n] of Object.entries(s.byProposedExpiry)) console.log(`  ${e}: ${n}`);
  }
  if (Object.keys(s.unresolvedReasons).length) {
    console.log('\nunresolved reasons:');
    for (const [r, n] of Object.entries(s.unresolvedReasons)) console.log(`  ${r}: ${n}`);
  }
  console.log(`\nartifacts:\n  ${jsonPath}\n  ${mdPath}\n  ${sqlPath}`);
  console.log('\nDRY_RUN_ONLY — NO_MUTATION_PERFORMED');
}

module.exports = { loadMaster, reconcileRow, summarise, buildSql, refCount };

if (require.main === module) {
  main().catch((e) => { console.error('dry-run failed:', e.message); process.exit(1); });
}
