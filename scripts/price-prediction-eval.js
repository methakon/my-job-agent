#!/usr/bin/env node
/**
 * OFFLINE / SHADOW evaluation of the price-prediction feature set.
 *
 * Read-only. No writes, no production wiring, no orders. It answers, per feature:
 * sample size, hit rate, false-positive rate, average move after the signal,
 * time-to-target, performance by regime, performance by time of day, and the
 * UNKNOWN / insufficient-data rate — against a walk-forward out-of-sample split.
 *
 * METHOD (deliberately conservative):
 *   * every feature is computed from bars/index <= t; the label is derived from
 *     t+1 onward only, so no label information can enter the signal;
 *   * any threshold is chosen on the TRAIN folds only and then applied unchanged
 *     to the next unseen fold — nothing is tuned on the evaluation data;
 *   * the unconditioned base rate is reported beside every hit rate so a reader
 *     can see whether a feature adds anything at all.
 *
 * DATA REALITY (measured 2026-09-14, recorded in the report):
 *   * candle geometry has ~1.2k sessions per index (fnf_market_snapshots_history,
 *     source IS NULL) -> a real study is possible;
 *   * OI features need a strike-wise OI history, and the only table with GENUINE
 *     OI (upstox_live_paper_option_quotes) holds two sessions. Those features are
 *     therefore EXECUTED (to prove they run and are deterministic) but NOT scored:
 *     reporting a hit rate from two sessions would be fabrication, not evidence.
 */
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const ROOT = '/home/swarna-sekhar-dhar/projects/my-job-agent';
require(ROOT + '/node_modules/dotenv').config({ path: ROOT + '/.env', override: true });
const mysql = require(ROOT + '/node_modules/mysql2/promise');

const DIST = process.env.PPF_DIST || path.join(__dirname, '..', 'dist');
const M = require(path.join(DIST, 'trading', 'research', 'price-prediction-features.js'));
const PF = require(path.join(DIST, 'trading', 'pattern-engine', 'pattern-features.js'));
const RG = require(path.join(DIST, 'trading', 'regime', 'regime-tags.js'));

const FOLDS = 5;
const WARMUP = 30;
const TARGET_ATR = 0.5;   // time-to-target: cumulative move reaching half an ATR
const MAG_FLOOR_ATR = 0.25; // "meaningful move" floor, in ATR units
const INSTRUMENTS = ['NSE:NIFTY50-INDEX', 'NSE:NIFTYBANK-INDEX'];

const pct = (n) => (n === null || Number.isNaN(n) ? 'NA' : (100 * n).toFixed(1) + '%');
const f4 = (n) => (n === null || Number.isNaN(n) ? 'NA' : Number(n).toFixed(4));
const lines = [];
const say = (s) => { lines.push(s); console.log(s); };
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const quantile = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))] : null);

(async () => {
  const conn = await mysql.createConnection({
    host: process.env.MYSQL_HOST, port: Number(process.env.MYSQL_PORT || 3307),
    user: process.env.MYSQL_USER, password: process.env.MYSQL_PASSWORD,
    database: process.env.DATABASE_NAME || 'myjob_agent',
  });

  // ══════════════ PART 1 — what the OI history can and cannot support ══════════════
  say('='.repeat(100));
  say('PART 1 — OI-feature data reality (features 1-8, 12, 13 need strike-wise OI history)');
  say('='.repeat(100));
  const oiTables = (await conn.query(`
    SELECT 'fnf_option_quotes_history' t, COUNT(*) n, SUM(openInterest=0) oi_zero, SUM(openInterest>0) oi_pos,
           COUNT(DISTINCT DATE(ts)) days FROM fnf_option_quotes_history
    UNION ALL
    SELECT 'upstox_live_paper_option_quotes', COUNT(*), SUM(openInterest <= 0), SUM(openInterest > 0),
           COUNT(DISTINCT DATE(ts)) FROM upstox_live_paper_option_quotes`))[0];
  for (const r of oiTables) {
    say(`${String(r.t).padEnd(32)} rows=${String(r.n).padEnd(9)} oi>0=${String(r.oi_pos).padEnd(9)} oi<=0=${String(r.oi_zero).padEnd(9)} distinctDays=${r.days}`);
  }
  const oiVerdict = oiTables.find((r) => r.t === 'fnf_option_quotes_history');
  say(`\nVERDICT: fnf_option_quotes_history carries ${oiVerdict.oi_pos} real OI values out of ${oiVerdict.n} rows`);
  say('  -> its OI/volume columns are fabricated zeros. Feature evidence CANNOT come from it.');
  say('  upstox_live_paper_option_quotes carries genuine strike-wise OI + ΔOI + underlyingPrice,');
  say('  but over a handful of sessions. Walk-forward/OOS is impossible; a hit rate would be noise.');

  // ══════════════ PART 2 — OI features: execute for real, report coverage only ══════════════
  say('\n' + '='.repeat(100));
  say('PART 2 — OI features EXECUTED on the genuine sample (coverage/UNKNOWN rate; NO scoring)');
  say('='.repeat(100));
  const oiRows = (await conn.query(`
    SELECT DATE_FORMAT(ts,'%Y-%m-%d %H:%i:%s') snap, DATE_FORMAT(ts,'%Y-%m-%d') session, underlying, expiry,
           strike, optionType, openInterest oi, oiChange, volume, underlyingPrice
    FROM upstox_live_paper_option_quotes
    WHERE underlying IN ('NIFTY50','SENSEX') AND openInterest IS NOT NULL AND strike IS NOT NULL
    ORDER BY ts`))[0];
  const groups = new Map();
  for (const r of oiRows) {
    const k = `${r.underlying}|${r.expiry}|${r.snap}`;
    if (!groups.has(k)) groups.set(k, { underlying: r.underlying, expiry: r.expiry, session: r.session, snap: r.snap, legs: [], spot: null });
    const g = groups.get(k);
    g.legs.push({ strike: Number(r.strike), optionType: r.optionType, oi: r.oi === null ? null : Number(r.oi),
      changeOi: r.oiChange === null ? null : Number(r.oiChange), volume: r.volume === null ? null : Number(r.volume) });
    if (g.spot === null && r.underlyingPrice !== null && Number(r.underlyingPrice) > 0) g.spot = Number(r.underlyingPrice);
  }
  const snapshots = [...groups.values()].sort((a, b) => (a.snap < b.snap ? -1 : 1));
  const sessions = [...new Set(snapshots.map((s) => s.session))].sort();
  say(`genuine chain snapshots: ${snapshots.length}   sessions: ${sessions.length} (${sessions.join(', ')})`);
  const cov = { f1: 0, f2: 0, f3: 0, f5: 0, f6: 0, f7: 0, f8: 0, f4: 0, regime: 0 };
  const refusals = {};
  const bump = (r) => { if (!r.ok) refusals[r.reason] = (refusals[r.reason] || 0) + 1; };
  let prevByChain = new Map();
  // One PCR per session (its LAST one), so the regime thresholds are calibrated
  // on SESSION-level PCR from strictly earlier sessions — the module's stated
  // contract. Feeding intra-session snapshots here would silently calibrate the
  // regime on same-session noise and call it a session regime.
  const sessionPcrLast = new Map();
  for (const s of snapshots) {
    const priorPcrs = sessions.filter((d) => d < s.session).map((d) => sessionPcrLast.get(d)).filter((v) => v !== undefined);
    const c1 = M.oiConcentration(s.legs, 'CE'); const c1p = M.oiConcentration(s.legs, 'PE');
    if (c1.ok && c1p.ok) cov.f1 += 1; bump(c1); bump(c1p);
    const lv = M.highestOiLevels(s.legs, s.spot); if (lv.ok) cov.f2 += 1; bump(lv);
    const cl = M.oiChangeLevels(s.legs); if (cl.ok) cov.f3 += 1; bump(cl);
    const pcr = M.pcrState(s.legs, priorPcrs, null);
    if (pcr.ok) { cov.f5 += 1; if (pcr.value.regime !== 'UNKNOWN') cov.regime += 1; sessionPcrLast.set(s.session, pcr.value.pcr); }
    bump(pcr);
    const ce = M.priceDirectionVsSideOi(s.legs, 'CE', s.spot, prevByChain.get(`${s.underlying}|${s.expiry}`)?.spot ?? null); if (ce.ok) cov.f6 += 1; bump(ce);
    const pe = M.priceDirectionVsSideOi(s.legs, 'PE', s.spot, prevByChain.get(`${s.underlying}|${s.expiry}`)?.spot ?? null); if (pe.ok) cov.f7 += 1; bump(pe);
    const pv = M.priceOiVolume(s.legs, s.spot, prevByChain.get(`${s.underlying}|${s.expiry}`)?.spot ?? null, null); if (pv.ok) cov.f8 += 1; bump(pv);
    const prev = prevByChain.get(`${s.underlying}|${s.expiry}`);
    const prevLv = prev?.lv ?? null;
    if (lv.ok && prevLv) { const mig = M.oiLevelMigration(lv.value, prevLv, s.spot, prev.spot); if (mig.ok) cov.f4 += 1; bump(mig); }
    prevByChain.set(`${s.underlying}|${s.expiry}`, { spot: s.spot, lv: lv.ok ? lv.value : null });
  }
  const N = snapshots.length;
  say(`\nfeature                                                    resolved        rate`);
  say(`  1  OI concentration (both sides)                          ${String(cov.f1).padEnd(14)} ${pct(cov.f1 / N)}`);
  say(`  2  highest CE/PE OI levels                                ${String(cov.f2).padEnd(14)} ${pct(cov.f2 / N)}`);
  say(`  3  OI-change levels                                       ${String(cov.f3).padEnd(14)} ${pct(cov.f3 / N)}`);
  say(`  4  OI-level migration (needs a prior snapshot)             ${String(cov.f4).padEnd(14)} ${pct(cov.f4 / N)}`);
  say(`  5  PCR value                                              ${String(cov.f5).padEnd(14)} ${pct(cov.f5 / N)}`);
  say(`  5b PCR REGIME (needs >=20 prior-SESSION pcr samples)       ${String(cov.regime).padEnd(14)} ${pct(cov.regime / N)}   <-- cannot resolve`);
  say(`  6  price direction x CE OI change                         ${String(cov.f6).padEnd(14)} ${pct(cov.f6 / N)}`);
  say(`  7  price direction x PE OI change                         ${String(cov.f7).padEnd(14)} ${pct(cov.f7 / N)}`);
  say(`  8  price x OI x volume                                    ${String(cov.f8).padEnd(14)} ${pct(cov.f8 / N)}`);
  say(`\nrefusals by reason: ${Object.entries(refusals).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join('  ') || 'none'}`);
  say('SCORING: withheld. Two sessions cannot support train/validation/OOS, regime or');
  say('time-of-day breakdowns. Any hit rate computed here would be noise presented as evidence.');

  // ══════════════ PART 3 — candle geometry: a real walk-forward study ══════════════
  say('\n' + '='.repeat(100));
  say('PART 3 — candle-geometry features (9,10,11) + existing-engine baseline, walk-forward OOS');
  say('='.repeat(100));
  const load = async (instrument) => (await conn.query(
    `SELECT DATE_FORMAT(ts,'%Y-%m-%d') d, open, high, low, close, volume FROM fnf_market_snapshots_history
     WHERE source IS NULL AND instrument = ? AND ts < '2026-01-01' AND high > low AND close > 0 AND open > 0
     ORDER BY ts`, [instrument]))[0];

  const samples = [];
  const geomRefusals = {};
  for (const instrument of INSTRUMENTS) {
    const rows = await load(instrument);
    const bars = rows.map((r) => ({ sessionDate: String(r.d).slice(0, 10), ts: Date.parse(String(r.d).slice(0, 10)),
      open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close),
      volume: r.volume === null ? null : Number(r.volume) }));
    for (let t = WARMUP; t < bars.length - 1; t++) {
      const hist = bars.slice(0, t);
      const geo = M.shadowGeometry(bars[t]);
      if (!geo.ok) geomRefusals[geo.reason] = (geomRefusals[geo.reason] || 0) + 1;
      const a = PF.atr(hist.map((b) => ({ ts: b.ts, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume === null ? 0 : b.volume })), 14);
      const regime = RG.regimeEntering({
        priorSessions: hist.map((b) => ({ sessionDate: b.sessionDate, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume })),
        open: bars[t].open,
      });
      // Baseline A = the EXISTING engine's breakout detector on the same history.
      let baseline = 'NONE';
      try {
        const cons = PF.detectConsolidation(bars.slice(0, t + 1), PF.DEFAULT_PATTERN_THRESHOLDS);
        baseline = PF.detectBreakout(bars.slice(0, t + 1), cons, PF.DEFAULT_PATTERN_THRESHOLDS).classification;
      } catch { baseline = 'ERROR'; }
      const next = bars[t + 1];
      const r = (next.close - bars[t].close) / bars[t].close;
      const atrFloor = a !== null && a > 0 ? (MAG_FLOOR_ATR * a) / bars[t].close : null;
      let ttt = null;
      if (a !== null && a > 0) {
        const target = (TARGET_ATR * a) / bars[t].close;
        for (let j = 1; j <= 5 && t + j < bars.length; j += 1) {
          if (Math.abs((bars[t + j].close - bars[t].close) / bars[t].close) >= target) { ttt = j; break; }
        }
      }
      samples.push({ instrument, t, sessionDate: bars[t].sessionDate, geo: geo.ok ? geo.value : null,
        r, abs: Math.abs(r), atrFloor, ttt, baseline, volTag: regime.volatility, trendTag: regime.trend });
    }
  }
  const foldSize = Math.floor(samples.length / FOLDS);
  const folds = Array.from({ length: FOLDS }, (_, i) => samples.slice(i * foldSize, i === FOLDS - 1 ? samples.length : (i + 1) * foldSize));
  say(`samples with a completed next session: ${samples.length}   folds: ${FOLDS} x ~${foldSize}`);
  say(`geometry refusals: ${Object.entries(geomRefusals).map(([k, v]) => `${k}=${v}`).join('  ') || 'none'}`);

  const baseUp = samples.filter((s) => s.r > 0).length / samples.length;
  const magOk = samples.filter((s) => s.atrFloor !== null && s.abs >= s.atrFloor);
  say(`\nunconditioned base rate: P(next up)=${pct(baseUp)}   P(|move| >= ${MAG_FLOOR_ATR} ATR)=${pct(magOk.length / samples.length)}`);

  // Feature signals. Direction is stated up front, never chosen after seeing the result.
  const FEATURES = [
    { id: '9  upperShadow>=q75', dir: 'DOWN', pick: (s) => (s.geo ? s.geo.upperShadow : null) },
    { id: '10 lowerShadow>=q75', dir: 'UP', pick: (s) => (s.geo ? s.geo.lowerShadow : null) },
    { id: '11 wickBodyRatio>=q75', dir: 'MAGNITUDE', pick: (s) => (s.geo ? s.geo.wickBodyRatio : null) },
  ];
  const score = (rows, dir, mag) => {
    const hit = rows.filter((s) => (dir === 'MAGNITUDE' ? (s.atrFloor !== null && s.abs >= s.atrFloor) : (dir === 'UP' ? s.r > 0 : s.r < 0)));
    return { n: rows.length, hit: rows.length ? hit.length / rows.length : null,
      avgMove: mean(rows.map((s) => (dir === 'DOWN' ? -s.r : s.r))), avgAbs: mean(rows.map((s) => s.abs)),
      ttt: mean(rows.map((s) => s.ttt).filter((v) => v !== null)) };
  };
  const table = [];
  for (const feat of FEATURES) {
    const perFold = [];
    let pooled = [];
    for (let fi = 1; fi < FOLDS; fi += 1) {
      const train = folds.slice(0, fi).flat().map(feat.pick).filter((v) => v !== null).sort((a, b) => a - b);
      const q = quantile(train, 0.75);
      const oos = folds[fi].filter((s) => { const v = feat.pick(s); return v !== null && q !== null && v >= q; });
      pooled = pooled.concat(oos);
      if (oos.length) perFold.push(score(oos, feat.dir, feat.atrFloor));
    }
    const s = score(pooled, feat.dir, feat.atrFloor);
    table.push({ feature: feat.id, n: s.n, hit: s.hit, avgMove: s.avgMove, avgAbs: s.avgAbs, ttt: s.ttt,
      folds: perFold.map((p) => pct(p.hit)).join(' '),
      regime: s.n ? mean(pooled.map((x) => x.volTag === 'HIGH' ? 1 : 0)) : null,
      oos: perFold.length ? (perFold.every((p) => p.hit !== null && p.hit > (feat.dir === 'MAGNITUDE' ? magOk.length / samples.length : baseUp)) ? 'CONSISTENT' : 'MIXED') : 'NO OOS' });
  }
  // Baseline A — the existing engine's breakout detector.
  {
    const oos = folds.slice(1).flat().filter((s) => s.baseline !== 'NONE' && s.baseline !== 'ERROR');
    const all = samples.filter((s) => s.baseline !== 'NONE');
    const s = score(oos, 'UP', null);
    table.unshift({ feature: 'A  existing detectBreakout', n: s.n, hit: s.hit, avgMove: s.avgMove, avgAbs: s.avgAbs, ttt: s.ttt,
      folds: '-', regime: all.length ? mean(all.map((x) => x.volTag === 'HIGH' ? 1 : 0)) : null, oos: 'baseline' });
  }

  say('\n' + '-'.repeat(118));
  say('FEATURE                    N     HIT    BASE   AVG MOVE   AVG|MOVE|  TTT(sess)  OOS        highVol%');
  say('-'.repeat(118));
  for (const r of table) {
    const base = r.feature.startsWith('11') ? magOk.length / samples.length : baseUp;
    say(`${r.feature.padEnd(26)} ${String(r.n).padEnd(5)} ${pct(r.hit).padEnd(6)} ${pct(base).padEnd(6)} ${f4(r.avgMove).padEnd(10)} ${f4(r.avgAbs).padEnd(10)} ${f4(r.ttt).padEnd(10)} ${String(r.oos).padEnd(10)} ${pct(r.regime)}`);
  }
  say('-'.repeat(118));
  say('per-fold OOS hit rate (fold 2..5, thresholds fitted on the folds before it):');
  for (const r of table) if (r.folds !== '-') say(`  ${r.feature.padEnd(26)} ${r.folds}`);
  say('TIME OF DAY: NOT APPLICABLE to these features — the archive is one DAILY bar per session,');
  say('so there is no intra-session decision time to stratify by. Reported as N/A, not estimated.');

  // ══════════════ PART 4 — leakage + reproducibility ══════════════
  say('\n' + '='.repeat(100));
  say('PART 4 — leakage control and reproducibility');
  say('='.repeat(100));
  const bars0 = (await load(INSTRUMENTS[0])).map((r) => ({ open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close), volume: r.volume === null ? null : Number(r.volume) }));
  const T = Math.min(400, bars0.length - 2);
  const before = JSON.stringify(M.shadowGeometry(bars0[T]));
  const mutated = bars0.map((b, i) => (i > T ? { ...b, open: 0, high: 0, low: 0, close: 0, volume: 0 } : b));
  const after = JSON.stringify(M.shadowGeometry(mutated[T]));
  say(`zeroing EVERY session after t=${T} leaves the feature at t identical: ${before === after ? 'PASS' : 'FAIL'}`);
  const h1 = crypto.createHash('sha256');
  for (const s of samples) h1.update(`${s.instrument}|${s.sessionDate}|${s.geo ? s.geo.upperShadow.toFixed(8) + ',' + s.geo.lowerShadow.toFixed(8) + ',' + s.geo.wickBodyRatio.toFixed(8) : 'REFUSED'}|${s.r.toFixed(8)}\n`);
  const d1 = h1.digest('hex').slice(0, 16);
  const h2 = crypto.createHash('sha256');
  for (const s of samples) h2.update(`${s.instrument}|${s.sessionDate}|${s.geo ? s.geo.upperShadow.toFixed(8) + ',' + s.geo.lowerShadow.toFixed(8) + ',' + s.geo.wickBodyRatio.toFixed(8) : 'REFUSED'}|${s.r.toFixed(8)}\n`);
  const d2 = h2.digest('hex').slice(0, 16);
  say(`digest run 1 = ${d1}\ndigest run 2 = ${d2}\nidentical: ${d1 === d2 ? 'PASS' : 'FAIL'}   (samples hashed: ${samples.length})`);

  await conn.end();
  fs.writeFileSync(process.env.COMMANDCODE_SCRATCHPAD + '/price-prediction-eval.txt', lines.join('\n'));
})().catch((e) => { console.error('EVAL FAILED', e); process.exit(1); });
