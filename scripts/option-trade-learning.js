#!/usr/bin/env node
/**
 * option-trade-learning.js — one day of REAL orders + the desk's REAL tick tape
 *  -> reconstructed trades, MFE/MAE, profit capture, cost-aware minimum edge,
 *     exit-policy comparison, regime/exhaustion states, cross-option confirmation.
 *
 * READ-ONLY: never writes to trading tables, never changes live strategy.
 * All thresholds are RATIOS (ATR multiples, %, relative volume/OI). No price level
 * from the analysed day is hard-coded.
 *
 * Usage:
 *   node scripts/option-trade-learning.js --orders <orders.csv> --tape <dir> \
 *        --date 2026-09-10 --lab SENSEX26091074900PE --out reports/x.md
 */
'use strict';
const fs = require('fs');
const path = require('path');

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const ORDERS = arg('orders', '/home/swarna-sekhar-dhar/Downloads/zerodha/orders.csv');
const TAPE = arg('tape', '/tmp/sx-tape');
const DATE = arg('date', '2026-09-10');
const LAB = arg('lab', 'SENSEX26091074900PE');
const OUT = arg('out', '');
const SESSION_START = arg('sessionStart', '09:15');
const SESSION_END = arg('sessionEnd', '15:30');
const LOT = Number(arg('lot', '20'));

/* ================================================================ symbols */
const MONTHS = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };
const MON = ['', 'JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

const norm = (s) => String(s).toUpperCase().replace(/[^A-Z0-9]/g, '');

/**
 * All compact symbol spellings an exchange/data vendor may use for one contract.
 * The truth (underlying/expiry/strike/type) always comes from the DB, never from
 * parsing a vendor's symbol string.
 */
function symbolForms(meta) {
  const [y, m, d] = meta.expiry.split('-');
  const yy = y.slice(2), mm = m, dd = d, one = String(Number(m)), oneD = String(Number(d));
  const U = norm(meta.underlying), T = meta.optionType, K = String(meta.strike);
  // strip trailing zeros of the strike only when the vendor's form omits them (e.g. 74900 -> 74900)
  return [...new Set([
    `${U}${yy}${one}${oneD}${K}${T}`,     // Zerodha weekly  SENSEX2691074600PE
    `${U}${yy}${mm}${dd}${K}${T}`,        // Upstox weekly   SENSEX26091074600PE
    `${U}${yy}${one}${dd}${K}${T}`,
    `${U}${yy}${mm}${oneD}${K}${T}`,
    `${U}${yy}${MON[Number(m)]}${K}${T}`, // BSE/Zerodha monthly  SENSEX26SEP74600PE
    `${U}${yy}${mm}${MON[Number(m)]}${K}${T}`,
    `${U}${y}${one}${oneD}${K}${T}`,      // 4-digit year variants
    `${U}${y}${mm}${dd}${K}${T}`,
    `${U}${y}${MON[Number(m)]}${K}${T}`,
  ])];
}

/* ================================================================ orders */
const toNum = (s) => (s === undefined || s === null || s === '' ? null : Number(s));

function parseOrders(file) {
  const lines = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/);
  const rows = [];
  for (const line of lines.slice(1)) {
    const f = line.split(',').map((x) => x.replace(/^"|"$/g, '').trim());
    if (f.length < 7) continue;
    const m = /^(\d+)\/(\d+)$/.exec(f[4]);
    rows.push({
      time: f[0].replace(' ', 'T'), type: f[1], instrument: f[2], product: f[3],
      orderedQty: m ? Number(m[2]) : Number(f[4]), filled: m ? Number(m[1]) : Number(f[4]),
      price: toNum(f[5]), status: f[6],
    });
  }
  return rows.sort((a, b) => a.time.localeCompare(b.time));
}

function roundTrips(rows) {
  const open = new Map(), trips = [], rejects = [];
  for (const r of rows) {
    if (r.status !== 'COMPLETE' || !r.filled) { rejects.push(r); continue; }
    const book = open.get(r.instrument) || [];
    if (r.type === 'BUY') { book.push({ qty: r.filled, price: r.price, time: r.time }); open.set(r.instrument, book); continue; }
    let left = r.filled; const legs = [];
    while (left > 0 && book.length) {
      const lot = book[0]; const take = Math.min(left, lot.qty);
      legs.push({ qty: take, price: lot.price, time: lot.time });
      lot.qty -= take; left -= take; if (lot.qty === 0) book.shift();
    }
    if (legs.length) {
      const q = legs.reduce((s, l) => s + l.qty, 0);
      trips.push({
        instrument: r.instrument, qty: q, legs, entryTs: legs[0].time, exitTs: r.time,
        entryVwap: legs.reduce((s, l) => s + l.qty * l.price, 0) / q,
        exitPrice: r.price, gross: (r.price - legs.reduce((s, l) => s + l.qty * l.price, 0) / q) * q,
      });
    }
    if (left > 0) console.warn(`  ! unmatched sell qty ${left} for ${r.instrument}`);
  }
  const stillOpen = [];
  for (const [inst, book] of open) for (const l of book) if (l.qty > 0) stillOpen.push({ instrument: inst, ...l });
  return { trips, rejects, stillOpen };
}

/* ================================================================= costs */
/* Zerodha F&O options statutory model (verify rates before depending on them). */
const RATES = { brokerage: 20, stt: 0.001, exchTurnover: 0.0003503, sebiPerCrore: 10, stampBuy: 0.00003, gst: 0.18 };

function costs(legs, exitPrice, exitQty) {
  const buyTurn = legs.reduce((s, l) => s + l.qty * l.price, 0), sellTurn = exitPrice * exitQty, turn = buyTurn + sellTurn;
  const brokerage = RATES.brokerage * (legs.length + 1);
  const stt = RATES.stt * sellTurn, exch = RATES.exchTurnover * turn;
  const sebi = turn / 1e7 * RATES.sebiPerCrore, stamp = buyTurn * RATES.stampBuy;
  const gst = RATES.gst * (brokerage + exch + sebi);
  return { total: brokerage + stt + exch + sebi + stamp + gst, brokerage, stt, exch, sebi, stamp, gst, buyTurn, sellTurn };
}

/* ================================================================== tape */
/** Loads <SYM>.csv files plus index.json (DB-authoritative metadata) and builds
 *  a vendor-symbol -> series map so orders can be matched regardless of format. */
function loadTape(dir, date) {
  const out = new Map();       // normalised symbol spelling -> series
  const indexFile = path.join(dir, 'index.json');
  const meta = fs.existsSync(indexFile) ? JSON.parse(fs.readFileSync(indexFile, 'utf8')) : {};
  const load = (sym, file) => {
    const lines = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/);
    const head = lines[0].split(','), ix = (n) => head.indexOf(n);
    const q = [];
    for (const line of lines.slice(1)) {
      const c = line.split(','), ts = c[ix('ts')];
      if (!ts || !ts.startsWith(date)) continue;
      const hhmm = ts.slice(11, 16);
      if (hhmm < SESSION_START || hhmm > SESSION_END) continue;
      const ltp = toNum(c[ix('ltp')]);
      if (ltp === null || ltp <= 0) continue;
      q.push({
        ts, t: Date.parse(ts), ltp, bid: toNum(c[ix('bid')]), ask: toNum(c[ix('ask')]),
        bidQty: toNum(c[ix('bidQty')]), askQty: toNum(c[ix('askQty')]),
        volume: toNum(c[ix('volume')]), oi: toNum(c[ix('openInterest')]), oiChange: toNum(c[ix('oiChange')]),
        iv: toNum(c[ix('iv')]), delta: toNum(c[ix('delta')]), gamma: toNum(c[ix('gamma')]),
        theta: toNum(c[ix('theta')]), vega: toNum(c[ix('vega')]), underlying: toNum(c[ix('underlyingPrice')]),
      });
    }
    q.sort((a, b) => a.t - b.t);
    const rec = { symbol: sym, meta: meta[sym] || null, quotes: q };
    out.set(norm(sym), rec);
    if (rec.meta) for (const form of symbolForms(rec.meta)) if (!out.has(form)) out.set(form, rec);
    return rec;
  };
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.csv') || f === 'snapshots.csv') continue;
    load(f.replace(/\.csv$/, ''), path.join(dir, f));
  }
  /* underlying index snapshots (SENSEX) -> loaded as a plain price series for context */
  const snapFile = path.join(dir, 'snapshots.csv');
  if (fs.existsSync(snapFile)) {
    const lines = fs.readFileSync(snapFile, 'utf8').trim().split(/\r?\n/);
    const head = lines[0].split(','), ix = (n) => head.indexOf(n);
    const q = [];
    for (const line of lines.slice(1)) {
      const c = line.split(',');
      const ts = c[ix('ts')], ltp = toNum(c[ix('price')]);
      if (!ts || ltp === null || ltp <= 0) continue;
      q.push({ ts, t: Date.parse(ts.replace(' ', 'T')), ltp, bid: null, ask: null, volume: toNum(c[ix('volume')]), oi: null, oiChange: 0, iv: null, delta: null, gamma: null, theta: null, vega: null, underlying: null });
    }
    q.sort((a, b) => a.t - b.t);
    if (q.length) out.set('SENSEX-INDEX', { symbol: 'SENSEX-INDEX', meta: null, quotes: q });
  }
  return out;
}
/** Resolve an order symbol to its tape series (any vendor spelling). */
const resolve = (tape, symbol) => tape.get(norm(symbol)) || null;

function bars5m(quotes, date) {
  const b = new Map();
  for (const q of quotes) {
    const mm = Number(q.ts.slice(14, 16));
    const k = `${date}T${q.ts.slice(11, 13)}:${String(Math.floor(mm / 5) * 5).padStart(2, '0')}`;
    const x = b.get(k) || { k, o: q.ltp, h: q.ltp, l: q.ltp, c: q.ltp, n: 0, vol: 0, volFirst: null, volLast: null, oiFirst: null, oiLast: null, ivLast: null, undlLast: null, bidSum: 0, askSum: 0 };
    x.h = Math.max(x.h, q.ltp); x.l = Math.min(x.l, q.ltp); x.c = q.ltp;
    if (x.n === 0) { x.o = q.ltp; x.volFirst = q.volume; x.oiFirst = q.oi; }
    x.n++;
    if (q.volume !== null) x.volLast = q.volume;
    if (q.oi !== null) x.oiLast = q.oi;
    if (q.iv !== null) x.ivLast = q.iv;
    if (q.underlying !== null && q.underlying > 1000) x.undlLast = q.underlying;
    if (q.bid !== null && q.ask !== null && q.bid > 0) { x.bidSum += q.bid; x.askSum += q.ask; }
    b.set(k, x);
  }
  const bars = [...b.values()].sort((a, z) => a.k.localeCompare(z.k));
  for (let i = 0; i < bars.length; i++) {
    const prev = bars[i - 1], x = bars[i];
    x.ret = prev ? x.c / prev.c - 1 : 0;
    x.range = x.h - x.l; x.body = x.c - x.o;
    x.upperWick = x.h - Math.max(x.o, x.c); x.lowerWick = Math.min(x.o, x.c) - x.l;
    x.vol = x.volLast && x.volFirst ? x.volLast - x.volFirst : 0;         // cumulative volume is daily-cumulative
    x.oiDelta = x.oiLast && x.oiFirst ? x.oiLast - x.oiFirst : 0;
    x.spread = x.n ? (x.askSum - x.bidSum) / x.n : null;
  }
  const vols = bars.map((x) => x.vol).filter((v) => v > 0).sort((a, z) => a - z);
  const medVol = vols.length ? vols[Math.floor(vols.length / 2)] : 0;
  for (const x of bars) x.relVol = medVol ? x.vol / medVol : null;
  return bars;
}

function atrSeries(bars, n = 14) {
  const tr = bars.map((b, i) => (i === 0 ? b.range : Math.max(b.range, Math.abs(b.h - bars[i - 1].c), Math.abs(b.l - bars[i - 1].c))));
  const out = []; let a = null;
  for (let i = 0; i < tr.length; i++) {
    if (i < n - 1) { out.push(null); continue; }
    if (i === n - 1) { a = tr.slice(0, n).reduce((s, x) => s + x, 0) / n; out.push(a); continue; }
    a = (a * (n - 1) + tr[i]) / n; out.push(a);
  }
  return out;
}

/** Wilder ATR at the bar covering ts (or the last computed one). */
function atrAt(bars, atr, ts) {
  let idx = -1;
  for (let i = 0; i < bars.length; i++) if (bars[i].k <= ts.slice(0, 16)) idx = i;
  for (let i = idx; i >= 0; i--) if (atr[i] !== null) return { value: atr[i], idx: i };
  return { value: null, idx: -1 };
}

const inWin = (q, a, b) => q.filter((x) => x.t >= a && x.t <= b);
function extremes(q, a, b) {
  const w = inWin(q, a, b); if (!w.length) return null;
  let hi = w[0], lo = w[0];
  for (const x of w) { if (x.ltp > hi.ltp) hi = x; if (x.ltp < lo.ltp) lo = x; }
  return { hi, lo, n: w.length };
}

/* ================================================== exit-policy simulation */
/**
 * Walk the tape bar by bar from entry, applying one exit policy.
 * Policies are expressed in ATR multiples / structure — never in ₹ levels.
 * Returns exit bar, exit price, MFE/MAE, capture, and the reason.
 */
function simulate(bars, atr, entryIdx, entryPrice, policy) {
  let peak = entryPrice, trough = entryPrice, entryAtr = null;
  for (let i = entryIdx; i >= 0; i--) if (atr[i] !== null) { entryAtr = atr[i]; break; }
  if (!entryAtr) return null;
  const stop = entryPrice - policy.stopAtr * entryAtr;
  let trailStop = stop, target = policy.targetAtr ? entryPrice + policy.targetAtr * entryAtr : null;
  let partialDone = false, partialQty = policy.partialFrac || 0, partialPnl = 0;
  const legs = [];
  for (let i = entryIdx; i < bars.length; i++) {
    const b = bars[i];
    peak = Math.max(peak, b.h); trough = Math.min(trough, b.l);
    if (policy.kind === 'fixed_target') {
      if (b.h >= target) { legs.push({ i, k: b.k, price: target, why: 'TARGET' }); break; }
      if (b.l <= stop) { legs.push({ i, k: b.k, price: stop, why: 'STOP' }); break; }
    } else if (policy.kind === 'atr_trail') {
      if (b.l <= trailStop && i > entryIdx) { legs.push({ i, k: b.k, price: trailStop, why: trailStop > entryPrice ? 'TRAIL_PROFIT' : 'TRAIL_STOP' }); break; }
      const newTrail = b.c - policy.trailAtr * entryAtr;
      if (newTrail > trailStop) trailStop = newTrail;
    } else if (policy.kind === 'structure_trail') {
      if (b.l < bars[i - 1].l && i > entryIdx) { legs.push({ i, k: b.k, price: b.l, why: 'STRUCTURE_BREAK' }); break; }
    } else if (policy.kind === 'partial_atr_trail') {
      if (!partialDone && b.h >= entryPrice + policy.partialAtr * entryAtr) {
        legs.push({ i, k: b.k, price: entryPrice + policy.partialAtr * entryAtr, why: 'PARTIAL_T1', qtyFrac: partialQty });
        partialDone = true; trailStop = Math.max(trailStop, entryPrice);   // break-even on the rest
        continue;
      }
      if (b.l <= trailStop && i > entryIdx) { legs.push({ i, k: b.k, price: trailStop, why: trailStop >= entryPrice ? 'TRAIL_PROFIT' : 'STOP', qtyFrac: partialDone ? 1 - partialQty : 1 }); break; }
      const newTrail = b.c - policy.trailAtr * entryAtr;
      if (newTrail > trailStop) trailStop = newTrail;
    } else if (policy.kind === 'exhaustion_exit') {
      // exit when the move shows deterioration: 2 consecutive lower closes after a new high,
      // or a candle closing below the previous candle's low while acceleration is negative.
      const prev = bars[i - 1];
      const lowerHigh = prev && b.h < prev.h;
      const accelNeg = prev && (b.c - prev.c) < 0;
      if (i > entryIdx && lowerHigh && accelNeg && (i - entryIdx) >= 2) { legs.push({ i, k: b.k, price: b.c, why: 'EXHAUSTION_DETERIORATION' }); break; }
      if (b.l <= stop) { legs.push({ i, k: b.k, price: stop, why: 'STOP' }); break; }
    } else if (policy.kind === 'hold_to_close') {
      if (i === bars.length - 1) { legs.push({ i, k: bars[bars.length - 1].k, price: bars[bars.length - 1].c, why: 'SESSION_CLOSE' }); break; }
    }
  }
  if (!legs.length) { const last = bars[bars.length - 1]; legs.push({ i: bars.length - 1, k: last.k, price: last.c, why: 'NO_EXIT_HIT' }); }
  const exit = legs[legs.length - 1];
  const totalQty = 1;
  let pnl = 0, fracs = 0;
  for (const l of legs) { const f = l.qtyFrac || (1 - fracs); fracs += f; pnl += (l.price - entryPrice) * f; }
  return {
    policy: policy.label, entryPrice, entryBar: bars[entryIdx].k, exitBar: exit.k, exitPrice: exit.price,
    why: legs.map((l) => `${l.why}@${l.price.toFixed(2)}`).join('+'),
    legs: legs.map((l) => ({ bar: l.k, price: l.price, why: l.why, frac: l.qtyFrac || 1 })),
    mfe: peak, mae: trough, retPct: (exit.price / entryPrice - 1) * 100,
    pnlPerUnit: pnl, capture: peak > entryPrice ? (exit.price - entryPrice) / (peak - entryPrice) : null,
    barsHeld: exit.i - entryIdx, entryAtr, atrPctOfPrice: entryAtr / entryPrice,
  };
}

/* ==================================================== regime classification */
/** Classic expansion sequence, all thresholds normalized. */
function classifySeries(bars, atr) {
  const out = [];
  const lookback = 6;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const a = atr[i];
    if (a == null || a <= 0) { out.push({ k: b.k, ret: b.ret, extension: null, relVol: b.relVol ?? null, oiDelta: b.oiDelta, iv: b.ivLast, state: 'NO_ATR' }); continue; }
    const win = bars.slice(Math.max(0, i - lookback), i + 1);
    const hi = Math.max(...win.map((x) => x.h)), lo = Math.min(...win.map((x) => x.l));
    const rangePos = hi > lo ? (b.c - lo) / (hi - lo) : 0.5;
    const rangeWidth = hi - lo;
    const compression = rangeWidth / (a * lookback);          // <0.6 = compressed
    const prev = bars[i - 1];
    const accel = prev ? b.ret - prev.ret : 0;
    const extension = (b.c - (win.reduce((s, x) => s + x.c, 0) / win.length)) / a;
    const relVol = b.relVol;
    const lowerHigh = prev ? b.h < prev.h : false;
    const volClimax = relVol !== null && relVol > 2.2;
    let state = 'RANGE';
    if (compression < 0.6) state = 'CONSOLIDATION';
    if (rangePos > 0.75 && b.ret > 0.02) state = 'BREAKOUT';
    if (b.ret > 0.05 && accel > 0.02) state = 'ACCELERATING';
    if (extension > 2.5 && (volClimax || b.upperWick > b.body)) state = 'EXHAUSTION';
    if (lowerHigh && accel < 0 && extension > 2) state = 'REVERSAL_EXIT_SIGNAL';
    if (b.ret > 0.15) state = 'EXTENDED';
    out.push({ k: b.k, state, rangePos: +rangePos.toFixed(3), compression: +compression.toFixed(2), extension: +extension.toFixed(2), accel: +accel.toFixed(4), relVol, ret: +b.ret.toFixed(4), oiDelta: b.oiDelta, iv: b.ivLast, spread: b.spread });
  }
  return out;
}

/* ================================================================ main */
function main() {
  const orderRows = parseOrders(ORDERS);
  const { trips, rejects, stillOpen } = roundTrips(orderRows);
  const tape = loadTape(TAPE, DATE);

  /* unique series once (the lookup map holds vendor aliases for the same series) */
  const unique = [...new Set(tape.values())];
  const seriesOf = new Map();       // series record -> { bars, atr }
  for (const rec of unique) {
    if (!rec.quotes.length) continue;
    const bars = bars5m(rec.quotes, DATE);
    seriesOf.set(rec, { bars, atr: atrSeries(bars) });
  }
  const seriesFor = (symbol) => {
    const rec = resolve(tape, symbol);
    return rec ? { rec, ...seriesOf.get(rec) } : null;
  };

  /* ---- enrich trades with tape metrics ---- */
  const trades = trips.map((t) => {
    const s = seriesFor(t.instrument);
    const q = s ? s.rec.quotes : [];
    const hold = q.length ? extremes(q, Date.parse(t.entryTs), Date.parse(t.exitTs)) : null;
    const post = q.length ? extremes(q, Date.parse(t.exitTs), Date.parse(`${DATE}T${SESSION_END}:59`)) : null;
    const c = costs(t.legs, t.exitPrice, t.qty);
    const tapeStart = q.length ? q[0].ts : null;
    const entryAtr = s ? atrAt(s.bars, s.atr, t.entryTs).value : null;
    const perUnit = t.exitPrice - t.entryVwap;
    return {
      ...t, costs: c, net: t.gross - c.total, holdMin: (Date.parse(t.exitTs) - Date.parse(t.entryTs)) / 60000,
      vwap: t.entryVwap, tapeSymbol: s ? s.rec.symbol : null,
      tapeStart, preTape: !!(tapeStart && t.entryTs < tapeStart.replace(' ', 'T')),
      mfe: hold ? hold.hi.ltp : null, mfeTs: hold ? hold.hi.ts : null,
      mae: hold ? hold.lo.ltp : null, maeTs: hold ? hold.lo.ts : null,
      postMax: post ? post.hi.ltp : null, postMaxTs: post ? post.hi.ts : null,
      postMin: post ? post.lo.ltp : null,
      costsPerUnit: c.total / t.qty, entryAtr, atrPct: entryAtr ? entryAtr / t.entryVwap : null,
      capture: (hold && Math.max(hold.hi.ltp, t.exitPrice) > t.entryVwap) ? Math.min(1, perUnit / (Math.max(hold.hi.ltp, t.exitPrice) - t.entryVwap)) : null,
      postLoss: post ? (post.lo.ltp - t.exitPrice) * t.qty : null,
      postGain: post ? (post.hi.ltp - t.exitPrice) * t.qty : null,
    };
  });

  /* ---- exit-policy comparison on each REAL entry ---- */
  const policies = [
    { kind: 'fixed_target', label: 'fixed 1.0xATR target / 1.0xATR stop', stopAtr: 1.0, targetAtr: 1.0 },
    { kind: 'fixed_target', label: 'fixed 2.0xATR target / 1.0xATR stop', stopAtr: 1.0, targetAtr: 2.0 },
    { kind: 'atr_trail', label: 'ATR trail 1.0x', stopAtr: 1.5, trailAtr: 1.0 },
    { kind: 'atr_trail', label: 'ATR trail 2.0x', stopAtr: 2.0, trailAtr: 2.0 },
    { kind: 'structure_trail', label: 'structure trail (prior bar low)', stopAtr: 2.0 },
    { kind: 'partial_atr_trail', label: '50% at 2xATR + 2xATR trail', stopAtr: 2.0, partialAtr: 2.0, trailAtr: 2.0, partialFrac: 0.5 },
    { kind: 'exhaustion_exit', label: 'exhaustion deterioration exit', stopAtr: 2.0 },
    { kind: 'hold_to_close', label: 'hold to 15:30 (expiry-day control)', stopAtr: 99 },
  ];
  const policyResults = [];
  for (const t of trades) {
    const s = seriesFor(t.instrument);
    if (!s) continue;
    const entryIdx = s.bars.findIndex((b) => b.k >= t.entryTs.slice(0, 16));
    if (entryIdx < 0) continue;
    for (const p of policies) {
      const r = simulate(s.bars, s.atr, entryIdx, t.entryVwap, p);
      if (r) policyResults.push({ instrument: t.instrument, entryTs: t.entryTs, qty: t.qty, net: r.pnlPerUnit * t.qty - t.costs.total, preTape: t.preTape, ...r });
    }
  }

  /* ---- lab contract: full regime timeline + exhaustion study ---- */
  const labS = seriesFor(LAB);
  const lab = labS ? { symbol: labS.rec.symbol, quotes: labS.rec.quotes, bars: labS.bars, atr: labS.atr } : null;
  const labRegime = lab ? classifySeries(lab.bars, lab.atr) : [];
  const labPeak = lab ? lab.bars.reduce((m, b) => (b.h > m.h ? b : m), lab.bars[0]) : null;

  /* ---- how long was the peak actually reachable? (exit-opportunity window) ---- */
  const opportunity = [];
  for (const rec of unique) {
    const s = seriesOf.get(rec); if (!s || !s.bars.length) continue;
    if (rec.symbol === 'SENSEX') continue;
    const bars = s.bars;
    const maxB = bars.reduce((m, b) => (b.h > m.h ? b : m), bars[0]);
    const minB = bars.reduce((m, b) => (b.l < m.l ? b : m), bars[0]);
    const hi80 = bars.filter((b) => b.h >= 0.8 * maxB.h);
    const cl70 = bars.filter((b) => b.c >= 0.7 * maxB.h);
    opportunity.push({
      symbol: rec.symbol, max: +maxB.h.toFixed(2), maxAt: maxB.k,
      lastBar: bars[bars.length - 1].k, close: +bars[bars.length - 1].c.toFixed(2),
      min: +minB.l.toFixed(2), minAt: minB.k,
      barsAbove80: hi80.length, window80: hi80.length ? `${hi80[0].k.slice(11)}-${hi80[hi80.length - 1].k.slice(11)}` : null,
      barsAbove70close: cl70.length,
      pctOfPeakRealisedAtClose: +((bars[bars.length - 1].c / maxB.h) * 100).toFixed(1),
    });
  }

  /* ---- cross-option confirmation at each real entry ---- */
  const cross = [];
  const CROSS_SET = ['SENSEX26091074600PE', 'SENSEX26091074700PE', 'SENSEX26091074800PE', 'SENSEX26091074900PE', 'SENSEX26091075000PE', 'SENSEX26091074800CE', 'SENSEX26091074900CE', 'SENSEX26091075000CE'];
  for (const t of trades) {
    for (const leg of t.legs) {
      const snap = {};
      for (const sym of CROSS_SET) {
        const rec = [...unique].find((r) => r.symbol === sym); if (!rec) continue;
        const s = seriesOf.get(rec); if (!s) continue;
        const b = s.bars.filter((x) => x.k <= leg.time.slice(0, 16)).pop(); if (!b) continue;
        const prev = s.bars.filter((x) => x.k <= leg.time.slice(0, 16)).slice(-2)[0];
        snap[sym.replace('SENSEX260910', '')] = {
          px: +b.c.toFixed(2), d5m: +((b.c - (prev ? prev.c : b.o)) / (prev ? prev.c : b.o) * 100).toFixed(1),
          oiDelta: b.oiDelta, iv: b.ivLast, undl: b.undlLast,
        };
      }
      cross.push({ instrument: t.instrument, side: t.instrument.endsWith('PE') ? 'PE_BUY' : 'CE_BUY', time: leg.time, price: leg.price, chain: snap });
    }
  }

  /* ---- SENSEX (underlying) 5-min bars for regime context ---- */
  const idxRec = [...unique].find((r) => /SENSEX$|SENSEX-INDEX|BSE:SENSEX/i.test(r.symbol)) || null;
  const idxBars = idxRec && seriesOf.get(idxRec) ? seriesOf.get(idxRec).bars : [];

  /* ---- minimum edge vs cost ---- */
  const costFacts = trades.map((t) => ({
    instrument: t.instrument, qty: t.qty, cost: t.costs.total,
    ptsNeeded: t.costs.total / t.qty, pctNeeded: (t.costs.total / t.qty) / t.entryVwap * 100,
    grossGainPct: (t.exitPrice / t.entryVwap - 1) * 100,
  }));

  /* ---- capture study: how much of a big move does a mechanical trail keep? ---- */
  const captureStudy = [];
  for (const sym of [LAB, 'SENSEX26091074600PE']) {
    const rec = [...unique].find((r) => r.symbol === sym); if (!rec) continue;
    const s = seriesOf.get(rec); if (!s) continue;
    const bars = s.bars;
    const peak = bars.reduce((m, b) => (b.h > m.h ? b : m), bars[0]);
    const entryBars = [bars[0].k, ...bars.filter((b, i) => i > 0 && b.h > bars[i - 1].h && b.c > b.o * 1.05).map((b) => b.k)].slice(0, 8);
    for (const k of entryBars) {
      const i = bars.findIndex((b) => b.k === k);
      const px = bars[i].c;
      const runway = peak.h - px;
      if (runway <= 0) continue;
      for (const p of [{ kind: 'atr_trail', label: 'trail 1.0xATR', stopAtr: 2, trailAtr: 1.0 },
                       { kind: 'atr_trail', label: 'trail 1.5xATR', stopAtr: 2, trailAtr: 1.5 },
                       { kind: 'atr_trail', label: 'trail 2.0xATR', stopAtr: 2, trailAtr: 2.0 },
                       { kind: 'structure_trail', label: 'structure trail', stopAtr: 2 },
                       { kind: 'exhaustion_exit', label: 'exhaustion exit', stopAtr: 2 },
                       { kind: 'fixed_target', label: 'fixed 2xATR target', stopAtr: 1, targetAtr: 2 }]) {
        const r = simulate(bars, s.atr, i, px, p); if (!r) continue;
        captureStudy.push({
          symbol: sym.replace('SENSEX260910', ''), entryBar: k.slice(11), entryPx: +px.toFixed(2), policy: p.label,
          exitBar: r.exitBar.slice(11), exitPx: +r.exitPrice.toFixed(2), why: r.why,
          pnlPerUnit: +r.pnlPerUnit.toFixed(2), runwayToPeak: +runway.toFixed(2),
          captureOfRunway: runway > 0 ? +(r.pnlPerUnit / runway).toFixed(3) : null,
        });
      }
    }
  }

/**
 * Underlying-driven exit study: for a PE position, exit when the UNDERLYING turns up
 * (close above the previous bar's high by >= k x underlying-ATR), with an option-side
 * disaster stop and an optional profit-protection backstop. All thresholds are ratios.
 */
function simulateUnderlying(optBars, optAtr, undlByKey, undlAtrByKey, entryIdx, entryPrice, cfg, isPe) {
  const a0 = (() => { for (let i = entryIdx; i >= 0; i--) if (optAtr[i] != null) return optAtr[i]; return null; })();
  if (!a0) return null;
  const stop = entryPrice - cfg.stopAtr * a0;
  let peak = entryPrice, exit = null, why = null;
  for (let i = entryIdx; i < optBars.length; i++) {
    const b = optBars[i];
    peak = Math.max(peak, b.h);
    const ub = undlByKey.get(b.k), uprev = undlByKey.get(optBars[i - 1] ? optBars[i - 1].k : null);
    const ua = undlAtrByKey.get(b.k);
    if (i > entryIdx) {
      if (b.l <= stop) { exit = { i, k: b.k, price: stop }; why = 'OPTION_STOP'; break; }
      if (cfg.underlyingTurnK && ub && uprev && ua) {
        const turnedUp = isPe ? (ub.c - uprev.h) > cfg.underlyingTurnK * ua : (uprev.l - ub.c) > cfg.underlyingTurnK * ua;
        if (turnedUp) { exit = { i, k: b.k, price: b.c }; why = 'UNDERLYING_TURN'; break; }
      }
      if (cfg.protectFrac != null && peak > entryPrice * (1 + cfg.protectArmFrac || 0) && b.c < peak * (1 - cfg.protectFrac)) {
        exit = { i, k: b.k, price: b.c }; why = 'PROFIT_PROTECT'; break;
      }
    }
  }
  if (!exit) { const last = optBars[optBars.length - 1]; exit = { i: optBars.length - 1, k: last.k, price: last.c }; why = 'NO_EXIT_HIT'; }
  return { exitBar: exit.k, exitPrice: exit.price, why, pnlPerUnit: exit.price - entryPrice, peak: Math.max(peak, exit.price), mae: entryPrice };
}

  /* ---- underlying-driven exit study (PE positions) ---- */
  const undlByKey = new Map(idxBars.map((b) => [b.k, b]));
  const undlAtr = atrSeries(idxBars);
  const undlAtrByKey = new Map(idxBars.map((b, i) => [b.k, undlAtr[i]]));
  const underlyingStudy = [];
  for (const sym of [LAB, 'SENSEX26091074600PE', 'SENSEX26091074700PE']) {
    const rec = [...unique].find((r) => r.symbol === sym); if (!rec) continue;
    const s = seriesOf.get(rec); if (!s) continue;
    const isPe = /PE$/.test(sym);
    const highBars = s.bars.filter((b, i) => i > 0 && b.h > s.bars[i - 1].h && s.atr[i] != null);
    const pick = []; const step = Math.max(1, Math.floor(highBars.length / 5));
    for (let j = 0; j < highBars.length; j += step) pick.push(highBars[j]);
    for (const k of [...pick.map((b) => b.k)].slice(0, 6)) {
      const i = s.bars.findIndex((b) => b.k === k); if (i < 0) continue;
      const px = s.bars[i].c;
      for (const cfg of [
        { label: 'undl turn 0.25xATR', underlyingTurnK: 0.25, stopAtr: 2 },
        { label: 'undl turn 0.5xATR', underlyingTurnK: 0.5, stopAtr: 2 },
        { label: 'undl turn 0.5xATR + protect 33% off peak', underlyingTurnK: 0.5, stopAtr: 2, protectFrac: 0.33, protectArmFrac: 0.3 },
        { label: 'undl turn 0.25xATR + protect 50% off peak', underlyingTurnK: 0.25, stopAtr: 2, protectFrac: 0.5, protectArmFrac: 0.3 },
      ]) {
        const r = simulateUnderlying(s.bars, s.atr, undlByKey, undlAtrByKey, i, px, cfg, isPe); if (!r) continue;
        const peak = s.bars.reduce((m, b) => (b.h > m.h ? b : m), s.bars[0]);
        underlyingStudy.push({
          symbol: sym.replace('SENSEX260910', ''), entryBar: k.slice(11), entryPx: +px.toFixed(2), label: cfg.label,
          exitBar: r.exitBar.slice(11), exitPx: +r.exitPrice.toFixed(2), why: r.why, pnlPerUnit: +r.pnlPerUnit.toFixed(2),
          runwayToPeak: +(peak.h - px).toFixed(2), captureOfRunway: peak.h > px ? +(r.pnlPerUnit / (peak.h - px)).toFixed(3) : null,
        });
      }
    }
  }

  const payload = {
    date: DATE, ordersFile: ORDERS, tapeDir: TAPE, labSymbol: LAB,
    rejects: rejects.map((r) => `${r.time} ${r.type} ${r.instrument} qty ${r.orderedQty} @ ${r.price} ${r.status}`),
    stillOpen, trades, policyResults, lab: lab ? { symbol: lab.symbol, regime: labRegime, peak: labPeak && { bar: labPeak.k, high: labPeak.h, close: labPeak.c }, bars: lab.bars.map((b) => ({ k: b.k, o: +b.o.toFixed(2), h: +b.h.toFixed(2), l: +b.l.toFixed(2), c: +b.c.toFixed(2), ret: +b.ret.toFixed(4), relVol: b.relVol, oiDelta: b.oiDelta, iv: b.ivLast })) } : null,
    crossOption: cross, costFacts, opportunity, captureStudy, underlyingStudy,
    sensex: idxBars.map((b) => ({ k: b.k, o: +b.o.toFixed(2), h: +b.h.toFixed(2), l: +b.l.toFixed(2), c: +b.c.toFixed(2) })),
    chainSummary: [...tape.entries()].map(([k, v]) => ({ symbol: v.symbol, quotes: v.quotes.length, lo: Math.min(...v.quotes.map((q) => q.ltp)), hi: Math.max(...v.quotes.map((q) => q.ltp)) })),
  };
  fs.mkdirSync('/tmp/sx-analysis', { recursive: true });
  fs.writeFileSync('/tmp/sx-analysis/learning.json', JSON.stringify(payload, null, 2));

  /* ============================ console report ============================ */
  const p6 = (n) => (n === null || n === undefined ? '   n/a' : n.toFixed(2).padStart(6));
  console.log(`\n################ ORDERS / ROUND TRIPS ################`);
  for (const r of payload.rejects) console.log(`  CANCELLED-NOT-FILLED: ${r}`);
  trades.forEach((t, i) => {
    console.log(`\n[${i + 1}] ${t.instrument}  qty ${t.qty}  ${t.tapeSymbol || 'NO TAPE SERIES'}${t.preTape ? `  (tape starts ${t.tapeStart.slice(11, 16)})` : ''}`);
    console.log(`    legs      : ${t.legs.map((l) => `${l.qty}@${l.price} ${l.time.slice(11, 16)}`).join(' | ')}`);
    console.log(`    entryVWAP : ${t.entryVwap.toFixed(2)}   exit ${t.exitPrice} @ ${t.exitTs.slice(11, 16)}   hold ${t.holdMin.toFixed(1)}m`);
    console.log(`    gross ${t.gross.toFixed(2)}  costs ${t.costs.total.toFixed(2)}  NET ${t.net.toFixed(2)}   cost/unit ${t.costsPerUnit.toFixed(2)} pts = ${(t.costsPerUnit / t.entryVwap * 100).toFixed(1)}% of entry`);
    console.log(`    MFE ${p6(t.mfe)} (${t.mfeTs ? t.mfeTs.slice(11, 16) : '-'})  MAE ${p6(t.mae)} (${t.maeTs ? t.maeTs.slice(11, 16) : '-'})  capture ${t.capture === null ? 'n/a' : (t.capture * 100).toFixed(0) + '%'} of run-up`);
    console.log(`    post-exit: max ${p6(t.postMax)} (${t.postMaxTs ? t.postMaxTs.slice(11, 16) : '-'}) min ${p6(t.postMin)}  -> gain left ${t.postGain === null ? 'n/a' : t.postGain.toFixed(0)} / damage avoided ${t.postLoss === null ? 'n/a' : (-t.postLoss).toFixed(0)}`);
    console.log(`    ATR(5m) at entry ${p6(t.entryAtr)} = ${t.atrPct == null ? 'n/a' : (t.atrPct * 100).toFixed(1) + '% of premium'}`);
  });
  console.log(`\nTOTAL gross ${trades.reduce((s, t) => s + t.gross, 0).toFixed(2)}  costs ${trades.reduce((s, t) => s + t.costs.total, 0).toFixed(2)}  NET ${trades.reduce((s, t) => s + t.net, 0).toFixed(2)}`);

  console.log(`\n################ LAB CONTRACT ${LAB} ################`);
  if (lab) {
    const peakIdx = lab.bars.findIndex((b) => b === labPeak);
    console.log(`  bars ${lab.bars.length}, peak ${labPeak.h.toFixed(2)} at ${labPeak.k}, close ${lab.bars[lab.bars.length - 1].c}`);
    console.log('  bar      o      h      l      c     ret%   ext(ATR)  relVol  oiΔ        iv     state');
    labRegime.forEach((r, i) => {
      const b = lab.bars[i];
      console.log(`  ${r.k.slice(11)} ${p6(b.o)} ${p6(b.h)} ${p6(b.l)} ${p6(b.c)} ${(r.ret * 100).toFixed(1).padStart(6)} ${String(r.extension).padStart(8)} ${r.relVol == null ? '  n/a' : r.relVol.toFixed(2).padStart(6)} ${String(r.oiDelta).padStart(9)} ${r.iv == null ? 'n/a' : String(r.iv).padStart(7)}  ${r.state}`);
    });
  } else console.log('  no tape series for lab contract');

  console.log(`\n################ EXIT POLICY COMPARISON (per real entry, net of real costs) ################`);
  const byPolicy = new Map();
  for (const r of policyResults) {
    const a = byPolicy.get(r.policy) || { n: 0, net: 0, cap: [], mae: [] };
    a.n++; a.net += r.net; if (r.capture !== null) a.cap.push(r.capture); a.mae.push(r.mae / r.entryPrice - 1);
    byPolicy.set(r.policy, a);
  }
  console.log('  policy                                  trades     net ₹   avg capture   avg MAE%');
  for (const [k, v] of byPolicy) {
    console.log(`  ${k.padEnd(38)} ${String(v.n).padStart(6)} ${v.net.toFixed(0).padStart(9)} ${(v.cap.length ? (v.cap.reduce((s, x) => s + x, 0) / v.cap.length * 100).toFixed(0) + '%' : 'n/a').padStart(11)} ${(v.mae.reduce((s, x) => s + x, 0) / v.mae.length * 100).toFixed(1).padStart(9)}`);
  }
  console.log('\n  per-trade detail:');
  for (const t of [...new Set(policyResults.map((r) => r.instrument + ' ' + r.entryTs))]) {
    console.log(`  --- ${t}`);
    for (const r of policyResults.filter((x) => x.instrument + ' ' + x.entryTs === t)) {
      console.log(`      ${r.policy.padEnd(38)} exit ${r.exitBar.slice(11)} @ ${String(r.exitPrice.toFixed(2)).padStart(7)}  net ₹${r.net.toFixed(0).padStart(6)}  capture ${r.capture === null ? 'n/a' : (r.capture * 100).toFixed(0) + '%'}  (${r.why})`);
    }
  }

  console.log(`\n################ EXIT-OPPORTUNITY WINDOW (how long the peak was reachable) ################`);
  console.log('  contract        max    at     close  %peak@close  bars>=80%max  window(80%)      bars close>=70%max');
  for (const o of opportunity.sort((a, b) => a.symbol.localeCompare(b.symbol))) {
    console.log(`  ${o.symbol.replace('SENSEX260910', '').padEnd(14)} ${String(o.max).padStart(7)} ${o.maxAt.slice(11)} ${String(o.close).padStart(7)} ${String(o.pctOfPeakRealisedAtClose).padStart(9)}% ${String(o.barsAbove80).padStart(12)}  ${String(o.window80 || '-').padEnd(16)} ${String(o.barsAbove70close).padStart(8)}`);
  }

  console.log(`\n################ SENSEX UNDERLYING (5-min) ################`);
  for (const b of idxBars) console.log(`  ${b.k.slice(11)} ${b.o.toFixed(1).padStart(8)} ${b.h.toFixed(1).padStart(8)} ${b.l.toFixed(1).padStart(8)} ${b.c.toFixed(1).padStart(8)}`);

  console.log(`\n################ CHAIN SNAPSHOT AT EACH REAL ENTRY ################`);
  for (const c of cross) {
    console.log(`  ${c.time.slice(11, 16)} ${c.side} ${c.instrument.replace('SENSEX26910', '')} @ ${c.price}   undl ${Object.values(c.chain)[0] ? Object.values(c.chain)[0].undl : 'n/a'}`);
    console.log(`      ${Object.entries(c.chain).map(([k, v]) => `${k}:${v.px}(${v.d5m > 0 ? '+' : ''}${v.d5m}%)`).join('  ')}`);
  }

  /* ---- self-check: the analysis engine must prove its own arithmetic ---- */
  if (process.argv.includes('--selfcheck')) {
    const fails = [];
    const ok = (name, cond, got) => { if (!cond) fails.push(`${name} (got ${got})`); else console.log(`  PASS ${name}`); };

    /* 1. ATR must follow the Wilder recursion exactly */
    let atrBad = 0;
    for (const rec of unique) {
      const s = seriesOf.get(rec); if (!s) continue;
      const trs = s.bars.map((b, i) => (i === 0 ? b.range : Math.max(b.range, Math.abs(b.h - s.bars[i - 1].c), Math.abs(b.l - s.bars[i - 1].c))));
      for (let i = 15; i < s.bars.length; i++) if (Math.abs(s.atr[i] - (s.atr[i - 1] * 13 + trs[i]) / 14) > 1e-6) atrBad++;
    }
    ok('ATR Wilder recursion holds for every bar of every contract', atrBad === 0, `${atrBad} bad bars`);

    /* 2. reconstructed gross must equal the CSV's own filled-order arithmetic */
    let csvGross = 0;
    for (const r of orderRows) if (r.status === 'COMPLETE') csvGross += (r.type === 'SELL' ? 1 : -1) * r.filled * r.price;
    const tripGross = trades.reduce((a, t) => a + t.gross, 0);
    ok('gross P&L reconciles to orders.csv arithmetic', Math.abs(csvGross - tripGross) < 1e-6, `${csvGross.toFixed(2)} vs ${tripGross.toFixed(2)}`);

    /* 3. every reconstructed trade must be fully closed */
    ok('no reconstructed trade left open', trades.every((t) => Math.abs(t.legs.reduce((a, l) => a + l.qty, 0) - t.qty) < 1e-9), 'mismatch');

    /* 4. capture can never exceed 100% of the run-up it is measured against */
    ok('profit capture <= 100%', trades.every((t) => t.capture == null || t.capture <= 1 + 1e-9), 'over 100%');

    /* 5. bar keys strictly increasing (no silent re-ordering) */
    let unordered = 0;
    for (const rec of unique) { const s = seriesOf.get(rec); if (!s) continue; for (let i = 1; i < s.bars.length; i++) if (s.bars[i].k <= s.bars[i - 1].k) unordered++; }
    ok('5-min bars strictly time-ordered', unordered === 0, `${unordered} out of order`);

    /* 6. cost model: brokerage is flat per order, so it must equal 20 x filled orders */
    const filled = orderRows.filter((r) => r.status === 'COMPLETE').length;
    ok('cost model charges flat brokerage per filled order', Math.abs(trades.reduce((a, t) => a + t.costs.brokerage, 0) - 20 * filled) < 1e-6, 'mismatch');

    console.log(fails.length ? `\nSELF-CHECK FAILED (${fails.length}):\n  - ${fails.join('\n  - ')}` : '\nSELF-CHECK: ALL PASS');
    if (fails.length) process.exitCode = 1;
  }

  if (OUT) {
    fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
    fs.writeFileSync(OUT, renderMarkdown(payload, trades, lab, labRegime, policyResults, byPolicy, costFacts));
    console.log(`\nwrote ${path.resolve(OUT)}`);
  }
}

function renderMarkdown(payload, trades, lab, labRegime, policyResults, byPolicy, costFacts) {
  const L = [];
  L.push(`# Learning case — real orders vs real tick tape (${payload.date})\n`);
  L.push(`- Orders: \`${payload.ordersFile}\``);
  L.push(`- Tape: \`upstox_live_paper_option_quotes\` (desk tick store, ${payload.tapeDir})`);
  L.push(`- Lab contract: \`${payload.labSymbol}\`\n`);
  L.push('> Auto-generated by `scripts/option-trade-learning.js`. Ratios only — no price level is hard-coded.\n');
  L.push('## Reconstructed round trips\n');
  L.push('| # | Instrument | Qty | Entry VWAP | Entry legs | Exit | Hold | Gross | Costs | Net | MFE | MAE | Post-exit max | Post-exit min | Capture |');
  L.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  trades.forEach((t, i) => L.push(`| ${i + 1} | ${t.instrument} | ${t.qty} | ${t.entryVwap.toFixed(2)} | ${t.legs.map((l) => `${l.qty}@${l.price} ${l.time.slice(11, 16)}`).join('<br>')} | ${t.exitPrice} @${t.exitTs.slice(11, 16)} | ${t.holdMin.toFixed(0)}m | ${t.gross.toFixed(0)} | ${t.costs.total.toFixed(0)} | ${t.net.toFixed(0)} | ${t.mfe ?? '—'} | ${t.mae ?? '—'} | ${t.postMax ?? '—'} | ${t.postMin ?? '—'} | ${t.capture === null ? '—' : (t.capture * 100).toFixed(0) + '%'} |`));
  L.push('\n## Cost-relative minimum edge\n');
  L.push('| Instrument | Qty | Round-trip cost | Points needed to break even | % of premium | Move actually captured |');
  L.push('|---|---|---|---|---|---|');
  costFacts.forEach((c) => L.push(`| ${c.instrument} | ${c.qty} | ${c.cost.toFixed(0)} | ${c.ptsNeeded.toFixed(2)} | ${c.pctNeeded.toFixed(1)}% | ${c.grossGainPct.toFixed(1)}% |`));
  L.push('\n## Exit-policy comparison\n');
  L.push('| Policy | Trades | Net ₹ | Avg capture | Avg MAE% |');
  L.push('|---|---|---|---|---|');
  for (const [k, v] of byPolicy) L.push(`| ${k} | ${v.n} | ${v.net.toFixed(0)} | ${v.cap.length ? (v.cap.reduce((s, x) => s + x, 0) / v.cap.length * 100).toFixed(0) + '%' : '—'} | ${(v.mae.reduce((s, x) => s + x, 0) / v.mae.length * 100).toFixed(1)} |`);
  if (lab) {
    L.push(`\n## Lab contract regime timeline — ${lab.symbol}\n`);
    L.push('| Bar | O | H | L | C | Ret% | Extension (ATR) | RelVol | OI Δ | IV | State |');
    L.push('|---|---|---|---|---|---|---|---|---|---|---|');
    labRegime.forEach((r, i) => { const b = lab.bars[i]; L.push(`| ${r.k.slice(11)} | ${b.o.toFixed(0)} | ${b.h.toFixed(0)} | ${b.l.toFixed(0)} | ${b.c.toFixed(0)} | ${(r.ret * 100).toFixed(1)} | ${r.extension} | ${r.relVol == null ? '—' : r.relVol.toFixed(2)} | ${r.oiDelta} | ${r.iv ?? '—'} | ${r.state} |`); });
  }
  return L.join('\n') + '\n';
}

main();
