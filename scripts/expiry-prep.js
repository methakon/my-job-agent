#!/usr/bin/env node
/**
 * Expiry readiness tooling — 2026-09-28.
 *
 * Operator ask (2026-09-28): "expiry day preparation — last-night prep and
 * pre-open analysis, find the ticks and techniques". This tool implements the
 * DETERMINISTIC, data-only half:
 *
 *   node scripts/expiry-prep.js generate [--width 12] [--master-dir DIR] [--out DIR]
 *       Recentred subscription universe for the NEAREST expiry of each index,
 *       validated against the broker contract master (never from a static env
 *       list — order §3.3). Emits FNO_MARKET_DATA_SYMBOLS / FNO_OPTION_CONTRACTS
 *       strings, registry upsert SQL, and a summary.
 *
 *   node scripts/expiry-prep.js report [--out FILE]
 *       Last-night prep report from stored data: per-strike OI, OI walls,
 *       max pain, PCR, ATM straddle (implied move), spot-vs-walls context for
 *       the next expiring series (NIFTY / BANKNIFTY / SENSEX).
 *
 * READ-ONLY against the DB (every query is a SELECT) and the broker master
 * files; it writes ONLY report artifacts. It does NOT touch trading logic,
 * thresholds, .env files, PM2 or the database. Applying the emitted
 * universe/registry output is an explicit operator step.
 *
 * Pure helpers are exported for scripts/expiry-prep.test.js.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
require('dotenv').config();

// ────────────────────────────── pure helpers ───────────────────────────────

/** Nearest expiry (YYYY-MM-DD, inclusive of today) from a list of dates. */
function pickNearestExpiry(dates, todayIso) {
  const uniq = [...new Set(dates.map((d) => String(d).slice(0, 10)))].sort();
  for (const d of uniq) if (d >= todayIso) return d;
  return null;
}

/** The 2*width+1 strikes nearest to `atm` from a sorted unique strike list. */
function selectStrikes(strikes, atm, width) {
  const s = [...new Set(strikes.map(Number))].filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return [];
  let idx = 0;
  let best = Infinity;
  s.forEach((k, i) => {
    const d = Math.abs(k - atm);
    if (d < best) { best = d; idx = i; }
  });
  const lo0 = Math.max(0, idx - width);
  const hi0 = Math.min(s.length, idx + width + 1);
  // Slide the window within the ladder so the caller keeps the full
  // 2*width+1 selection whenever enough strikes exist (edge spots).
  let lo = lo0;
  let hi = hi0;
  const want = 2 * width + 1;
  if (hi - lo < want) {
    if (lo === 0) hi = Math.min(s.length, want);
    else if (hi === s.length) lo = Math.max(0, hi - want);
  }
  return s.slice(lo, hi);
}

/** Put-Call ratio (OI). Returns null when the denominator is empty. */
function pcr(totalCeOi, totalPeOi) {
  return totalCeOi > 0 ? Number((totalPeOi / totalCeOi).toFixed(4)) : null;
}

/**
 * Classic max pain: for each candidate settlement strike K, total value of
 * in-the-money open interest (all other strikes settle against K); the max-pain
 * strike minimises that total. chain = [{strike, ceOi, peOi}].
 */
function maxPain(chain) {
  const rows = chain.filter((r) => Number.isFinite(r.strike));
  if (!rows.length) return null;
  let best = null;
  for (const k of rows) {
    let pain = 0;
    for (const r of rows) {
      const itmCe = Math.max(0, k.strike - r.strike) * (Number(r.ceOi) || 0);
      const itmPe = Math.max(0, r.strike - k.strike) * (Number(r.peOi) || 0);
      pain += itmCe + itmPe;
    }
    if (!best || pain < best.pain) best = { strike: k.strike, pain };
  }
  return best;
}

/** Highest-OI strikes on each side. chain = [{strike, ceOi, peOi}]. */
function oiWalls(chain) {
  let callWall = null;
  let putWall = null;
  for (const r of chain) {
    const ce = Number(r.ceOi) || 0;
    const pe = Number(r.peOi) || 0;
    if (!callWall || ce > callWall.oi) callWall = { strike: r.strike, oi: ce };
    if (!putWall || pe > putWall.oi) putWall = { strike: r.strike, oi: pe };
  }
  return { callWall, putWall };
}

/** ATM straddle: nearest listed strike to spot with both legs quoted. */
function atmStraddle(chain, spot) {
  const withBoth = chain.filter((r) => Number(r.ceLtp) > 0 && Number(r.peLtp) > 0);
  if (!withBoth.length) return null;
  let best = null;
  for (const r of withBoth) {
    const d = Math.abs(r.strike - spot);
    if (!best || d < best.d) best = { r, d };
  }
  const { r } = best;
  const premium = Number(r.ceLtp) + Number(r.peLtp);
  return { strike: r.strike, ce: Number(r.ceLtp), pe: Number(r.peLtp), premium: Number(premium.toFixed(2)) };
}

/**
 * Build the recentred universe from parsed broker-master option rows.
 * rows: [{symbol, underlyingName, expiry, strike, optionType, lotSize, tickSize}]
 * opts: {underlyingNames, spot, width} — names match the master's r[13] value.
 * Returns {expiry, symbols: [fyres symbols], contracts: [...]} per underlying.
 */
function buildUniverseForUnderlying(rows, underlyingName, spot, width, todayIso) {
  const mine = rows.filter((r) => r.underlyingName === underlyingName && Number(r.strike) > 0);
  if (!mine.length) return null;
  const expiry = pickNearestExpiry(mine.map((r) => r.expiry), todayIso);
  if (!expiry) return null;
  const onExp = mine.filter((r) => String(r.expiry).slice(0, 10) === expiry);
  const byStrike = new Map();
  for (const r of onExp) {
    const k = Number(r.strike);
    if (!byStrike.has(k)) byStrike.set(k, {});
    byStrike.get(k)[r.optionType] = r;
  }
  const twoSided = [...byStrike.entries()].filter(([, v]) => v.CE && v.PE).map(([k]) => k);
  const picked = selectStrikes(twoSided, spot, width);
  const contracts = [];
  for (const k of picked) {
    const v = byStrike.get(k);
    for (const t of ['CE', 'PE']) {
      const r = v[t];
      contracts.push({
        symbol: r.symbol,
        underlying: r.underlying,
        expiry: String(r.expiry).slice(0, 10),
        strike: k,
        optionType: t,
        lotSize: Number(r.lotSize),
        tickSize: Number(r.tickSize) || 0.05,
      });
    }
  }
  return { expiry, spot, strikes: picked, symbols: contracts.map((c) => c.symbol), contracts };
}

/** Parse one broker-master CSV line set into option rows (nulls skipped). */
function parseMasterRows(csvText) {
  const out = [];
  for (const line of csvText.split('\n')) {
    if (!line) continue;
    const f = line.split(',');
    if (f.length < 16) continue;
    const symbol = f[9];
    if (!symbol || !(symbol.endsWith('CE') || symbol.endsWith('PE'))) continue;
    const strike = Number(f[15]);
    if (!Number.isFinite(strike) || strike <= 0) continue;
    const epoch = Number(f[8]);
    if (!Number.isFinite(epoch)) continue;
    const expiry = new Date(epoch * 1000).toISOString().slice(0, 10);
    out.push({
      symbol,
      underlyingName: f[13],
      underlying: f[13] === 'NIFTY' ? 'NIFTY50-INDEX' : f[13] === 'BANKNIFTY' ? 'NIFTYBANK-INDEX' : f[13],
      expiry,
      strike,
      optionType: symbol.endsWith('CE') ? 'CE' : 'PE',
      lotSize: Number(f[3]),
      tickSize: Number(f[4]) || 0.05,
      name: f[1],
    });
  }
  return out;
}

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
function todayIstIso(now = new Date()) {
  return new Date(now.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

// ────────────────────────────── DB plumbing ────────────────────────────────

function dbConfigFromEnv() {
  return {
    host: process.env.MYSQL_HOST,
    port: Number(process.env.MYSQL_PORT || 3307),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: 'myjob_agent',
  };
}

async function fetchSpots(conn) {
  const [rows] = await conn.query(
    `SELECT s.instrument, s.price FROM fnf_market_snapshots s
       JOIN (SELECT instrument, MAX(ts) m FROM fnf_market_snapshots GROUP BY instrument) x
         ON x.instrument = s.instrument AND x.m = s.ts`,
  );
  const spots = {};
  for (const r of rows) spots[r.instrument] = Number(r.price);
  return spots;
}

/** Latest unified quote per instrument key for the given key prefixes. */
async function fetchLatestChain(conn, prefixLike, dayIso) {
  const like = prefixLike.map(() => 'instrumentKey LIKE ?').join(' OR ');
  const args = prefixLike.slice();
  const [rows] = await conn.query(
    `SELECT u.instrumentKey, u.strike, u.optionType, u.ltp, u.oi, u.changeOi, u.volume, u.iv, u.source, u.ts
       FROM unified_option_quotes u
       JOIN (SELECT instrumentKey, MAX(ts) mx FROM unified_option_quotes
              WHERE ts >= ? AND (${like}) GROUP BY instrumentKey) t
         ON t.instrumentKey = u.instrumentKey AND t.mx = u.ts`,
    [dayIso + ' 00:00:00', ...args],
  );
  return rows;
}

function chainByStrike(latestRows) {
  const byStrike = new Map();
  for (const r of latestRows) {
    const k = Number(r.strike);
    if (!byStrike.has(k)) byStrike.set(k, { strike: k, ceOi: 0, peOi: 0, ceLtp: 0, peLtp: 0, ceChg: 0, peChg: 0, ceVol: 0, peVol: 0 });
    const cur = byStrike.get(k);
    if (r.optionType === 'CE') {
      cur.ceOi = Number(r.oi) || 0; cur.ceLtp = Number(r.ltp) || 0;
      cur.ceChg = Number(r.changeOi) || 0; cur.ceVol = Number(r.volume) || 0;
    } else {
      cur.peOi = Number(r.oi) || 0; cur.peLtp = Number(r.ltp) || 0;
      cur.peChg = Number(r.changeOi) || 0; cur.peVol = Number(r.volume) || 0;
    }
  }
  return [...byStrike.values()].sort((a, b) => a.strike - b.strike);
}

// ────────────────────────────── generators ─────────────────────────────────

const UNDERLYINGS = [
  { masterName: 'NIFTY', indexSymbol: 'NSE:NIFTY50-INDEX', spotInstrument: 'NSE:NIFTY50-INDEX', label: 'NIFTY' },
  { masterName: 'BANKNIFTY', indexSymbol: 'NSE:NIFTYBANK-INDEX', spotInstrument: 'NSE:NIFTYBANK-INDEX', label: 'BANKNIFTY' },
  { masterName: 'SENSEX', indexSymbol: 'BSE:SENSEX-INDEX', spotInstrument: 'BSE:SENSEX-INDEX', label: 'SENSEX' },
];

function readMasterRows(masterDir) {
  const rows = [];
  const status = {};
  for (const f of ['NSE_FO.csv', 'BSE_FO.csv']) {
    const p = path.join(masterDir, f);
    if (!fs.existsSync(p)) { status[f] = 'missing'; continue; }
    rows.push(...parseMasterRows(fs.readFileSync(p, 'utf8')));
    status[f] = 'ok';
  }
  return { rows, status };
}

async function generateUniverse({ masterDir, width, outDir, todayIso, spotOverride }) {
  const { rows, status } = readMasterRows(masterDir);
  if (!rows.length) throw new Error(`no master rows found under ${masterDir} (${JSON.stringify(status)})`);
  const conn = await mysql.createConnection(dbConfigFromEnv());
  let spots = {};
  try {
    spots = await fetchSpots(conn);
  } finally {
    await conn.end();
  }
  const out = { generatedAt: new Date().toISOString(), todayIso, width, masterStatus: status, universes: [] };
  const symbols = []; const contracts = [];
  for (const u of UNDERLYINGS) {
    const spot = spotOverride?.[u.label] || spots[u.spotInstrument];
    if (!spot) { out.universes.push({ label: u.label, skipped: 'no spot' }); continue; }
    const uni = buildUniverseForUnderlying(rows, u.masterName, spot, width, todayIso);
    if (!uni) { out.universes.push({ label: u.label, skipped: 'no contracts' }); continue; }
    for (const c of uni.contracts) { symbols.push(c.symbol); contracts.push(c); }
    out.universes.push({
      label: u.label, expiry: uni.expiry, spot, strikes: uni.strikes,
      count: uni.contracts.length, symbols: uni.symbols,
    });
  }
  // Indices first, then option symbols (feed order).
  const feedSymbols = UNDERLYINGS.map((u) => u.indexSymbol).concat(symbols);
  fs.mkdirSync(outDir, { recursive: true });
  const envLines = [
    `FNO_MARKET_DATA_SYMBOLS=${feedSymbols.join(',')}`,
    `FNO_OPTION_CONTRACTS=${JSON.stringify(contracts)}`,
  ];
  fs.writeFileSync(path.join(outDir, 'universe.env'), envLines.join('\n') + '\n');
  const sql = contracts
    .map((c) => `INSERT INTO fnf_option_contracts (id, symbol, underlying, expiry, strike, optionType, lotSize, tickSize)` +
      ` VALUES (UUID(), '${c.symbol}', '${c.underlying}', '${String(c.expiry).slice(0, 10)}', ${c.strike}, '${c.optionType}', ${c.lotSize}, ${c.tickSize})` +
      ` ON DUPLICATE KEY UPDATE underlying=VALUES(underlying), expiry=VALUES(expiry), strike=VALUES(strike),` +
      ` optionType=VALUES(optionType), lotSize=VALUES(lotSize), tickSize=VALUES(tickSize);`)
    .join('\n');
  fs.writeFileSync(path.join(outDir, 'registry.sql'), sql + '\n');
  fs.writeFileSync(path.join(outDir, 'universe.json'), JSON.stringify(out, null, 2));
  return out;
}

// ────────────────────────────── report ─────────────────────────────────────

function fmt(n, d = 0) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return '—';
  return Number(n).toLocaleString('en-IN', { maximumFractionDigits: d, minimumFractionDigits: d });
}

async function buildReport({ outFile, todayIso }) {
  const conn = await mysql.createConnection(dbConfigFromEnv());
  let report;
  try {
    const spots = await fetchSpots(conn);
    const sections = [];
    const targets = [
      { label: 'NIFTY 29-SEP (monthly/weekly — tomorrow)', prefixes: ['NSE:NIFTY29SEP%'], spot: spots['NSE:NIFTY50-INDEX'] },
      { label: 'BANKNIFTY 29-SEP (monthly — tomorrow)', prefixes: ['NSE:BANKNIFTY29SEP%'], spot: spots['NSE:NIFTYBANK-INDEX'] },
      { label: 'SENSEX 01-OCT (weekly)', prefixes: ['BSE:SENSEX01OCT%'], spot: spots['BSE:SENSEX-INDEX'] },
    ];
    for (const t of targets) {
      const latest = await fetchLatestChain(conn, t.prefixes, todayIso);
      const chain = chainByStrike(latest);
      if (!chain.length) { sections.push({ label: t.label, skipped: 'no stored chain rows today' }); continue; }
      const totalCe = chain.reduce((a, r) => a + r.ceOi, 0);
      const totalPe = chain.reduce((a, r) => a + r.peOi, 0);
      const mp = maxPain(chain);
      const walls = oiWalls(chain);
      const straddle = atmStraddle(chain, t.spot);
      const src = [...new Set(latest.map((r) => r.source))].join(',');
      const ts = latest.map((r) => r.ts).sort().reverse()[0];
      sections.push({
        label: t.label, spot: t.spot, chain, totalCe, totalPe,
        pcr: pcr(totalCe, totalPe), maxPain: mp, walls, straddle, source: src, lastQuoteTs: ts,
        coverage: { strikes: chain.length, expectedLegs: latest.length },
      });
    }
    report = { generatedAt: new Date().toISOString(), todayIso, sections };
  } finally {
    await conn.end();
  }
  const lines = [];
  lines.push(`# Expiry prep report — generated ${report.generatedAt} (data as of IST ${todayIso})`, '');
  lines.push('> Deterministic, read-only prep for expiry day. Techniques reference: docs/EXPIRY_DAY_PLAYBOOK.md.');
  lines.push('> Policy gate: expiry-day entry rules are pending operator clarification #29; nothing here changes trading behaviour.', '');
  for (const s of report.sections) {
    lines.push(`## ${s.label}`);
    if (s.skipped) { lines.push(`_skipped: ${s.skipped}_`, ''); continue; }
    lines.push(`- spot **${fmt(s.spot, 2)}** · ticks ${s.coverage.expectedLegs} legs / ${s.coverage.strikes} strikes · source ${s.source} · last quote ${s.lastQuoteTs}`);
    lines.push(`- total CE OI ${fmt(s.totalCe)} · total PE OI ${fmt(s.totalPe)} · **PCR(OI) ${s.pcr}**`);
    if (s.maxPain) lines.push(`- **max pain ${fmt(s.maxPain.strike)}** (spot ${(s.spot - s.maxPain.strike).toFixed(0)} pts away)`);
    if (s.walls.callWall) lines.push(`- call wall ${fmt(s.walls.callWall.strike)} (OI ${fmt(s.walls.callWall.oi)}) · put wall ${fmt(s.walls.putWall.strike)} (OI ${fmt(s.walls.putWall.oi)})`);
    if (s.straddle) lines.push(`- ATM straddle @${fmt(s.straddle.strike)}: CE ${s.straddle.ce} + PE ${s.straddle.pe} = **${s.straddle.premium}** ≈ implied move ±${fmt(s.straddle.premium, 0)} pts (${(s.straddle.premium / s.spot * 100).toFixed(2)}%)`);
    lines.push('', '| strike | CE OI | CE ΔOI | CE ltp | PE ltp | PE ΔOI | PE OI |', '|---:|---:|---:|---:|---:|---:|---:|');
    for (const r of s.chain) {
      lines.push(`| ${fmt(r.strike)} | ${fmt(r.ceOi)} | ${fmt(r.ceChg)} | ${fmt(r.ceLtp, 2)} | ${fmt(r.peLtp, 2)} | ${fmt(r.peChg)} | ${fmt(r.peOi)} |`);
    }
    lines.push('');
  }
  const text = lines.join('\n');
  if (outFile) {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, text + '\n');
  }
  return { report, text };
}

// ────────────────────────────── CLI ────────────────────────────────────────

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const arg = (name, dflt) => {
    const i = rest.indexOf(`--${name}`);
    return i >= 0 && rest[i + 1] ? rest[i + 1] : dflt;
  };
  const todayIso = todayIstIso();
  const action = cmd || 'both';
  if (action === 'generate' || action === 'both') {
    const width = Number(arg('width', process.env.FNO_SUBSCRIBE_WIDTH || 12));
    const masterDir = arg('master-dir', process.env.FNO_MASTER_DIR || '/home/swarna-sekhar-dhar/.hermes/cache/scratch');
    const outDir = arg('out', path.join(process.cwd(), 'reports', `expiry-${todayIso}`));
    const out = await generateUniverse({ masterDir, width, outDir, todayIso });
    console.log(`universe generated → ${outDir}`);
    for (const u of out.universes) {
      if (u.skipped) { console.log(`  ${u.label}: skipped (${u.skipped})`); continue; }
      console.log(`  ${u.label}: expiry ${u.expiry}, spot ${u.spot}, ${u.count} contracts, strikes ${u.strikes[0]}..${u.strikes[u.strikes.length - 1]}`);
    }
  }
  if (action === 'report' || action === 'both') {
    const outFile = arg('report-out', path.join(process.cwd(), 'reports', `expiry-prep-${todayIso}.md`));
    const { text } = await buildReport({ outFile, todayIso });
    console.log(`\nprep report → ${outFile}\n`);
    console.log(text.split('\n').filter((l) => /^#|^- /.test(l)).slice(0, 60).join('\n'));
  }
}

module.exports = {
  pickNearestExpiry, selectStrikes, pcr, maxPain, oiWalls, atmStraddle,
  buildUniverseForUnderlying, parseMasterRows, chainByStrike, todayIstIso, IST_OFFSET_MS,
};

if (require.main === module) {
  main().catch((e) => { console.error('expiry-prep failed:', e.message); process.exit(1); });
}
