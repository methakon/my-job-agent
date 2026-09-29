#!/usr/bin/env node
/**
 * Expiry-day decision engine — shared core (pure, deterministic, no I/O).
 *
 * Session semantics for Indian index options (NSE/BSE):
 *   09:00–09:08  pre-open session (equity orientation; indicative EQ may print)
 *   09:15–15:30  normal market
 *   15:30        close / cash settlement value for index options
 *   15:16–15:30  post-close
 *
 * DB TIME BASIS (verified 2026-09-29): the MySQL server runs with time_zone=UTC
 * and NOW() is UTC, but `ts` on unified_* rows is written by the app driver as
 * IST wall-clock text. Therefore:
 *   - NEVER compare a `ts` value to NOW() or UTC_TIMESTAMP().
 *   - Treat every `ts` as an IST wall clock, and compare it to an IST clock
 *     derived from process time via IST_OFFSET_MS.
 * istNowIso() / istNowMs() are the only sanctioned "now" in this engine.
 *
 * No module in this engine places, sizes, prices or routes an order. It only
 * classifies and explains. The paper journal stores hypotheticals.
 */
'use strict';

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

// ───────────────────────────── clock helpers ───────────────────────────────

/** Current time as an IST wall clock (ms since epoch, IST-labelled). */
function istNowMs(nowMs = Date.now()) {
  return nowMs + IST_OFFSET_MS;
}

/** Current IST wall clock as a JS Date (fields read as IST values). */
function istNowDate(nowMs = Date.now()) {
  return new Date(nowMs + IST_OFFSET_MS);
}

/** YYYY-MM-DD in IST. */
function istDateIso(nowMs = Date.now()) {
  return new Date(nowMs + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** "HH:MM" in IST. */
function istHm(nowMs = Date.now()) {
  return new Date(nowMs + IST_OFFSET_MS).toISOString().slice(11, 16);
}

/** Minutes since IST midnight for a Date on the IST wall clock. */
function istMinutesOfDay(date) {
  return date.getUTCHours() * 60 + date.getUTCMinutes();
}

/** Build an IST wall-clock Date from YYYY-MM-DD + "HH:MM". */
function istDateAt(dateIso, hm) {
  const [h, m] = String(hm).split(':').map(Number);
  return new Date(`${dateIso}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.000Z`);
}

/** Parse a MySQL datetime string (assumed IST wall clock) to ms-since-epoch-as-IST. */
function parseIstTs(ts) {
  if (ts === null || ts === undefined) return null;
  if (ts instanceof Date) return ts.getTime();
  const s = String(ts).replace(' ', 'T');
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

/** Age in ms of an IST-stamped `ts` relative to now (never negative-clamped silently). */
function ageMs(ts, nowMs = Date.now()) {
  const t = parseIstTs(ts);
  if (t === null) return null;
  return istNowMs(nowMs) - t;
}

// ───────────────────────── data-freshness contract ────────────────────────

/**
 * Freshness buckets. A signal may only use a datum whose bucket is at most
 * `maxUsable` — anything STALE contributes ZERO weight, and UNKNOWN is treated
 * as unusable by default (absence of data is not neutral evidence).
 */
const FRESHNESS = { FRESH: 'FRESH', AGING: 'AGING', STALE: 'STALE', UNKNOWN: 'UNKNOWN' };

function freshnessBucket(age, { freshMs = 30_000, agingMs = 120_000 } = {}) {
  if (age === null || age === undefined || !Number.isFinite(age)) return FRESHNESS.UNKNOWN;
  if (age < 0) return FRESHNESS.FRESH;                 // clock skew ahead: treat as fresh
  if (age <= freshMs) return FRESHNESS.FRESH;
  if (age <= agingMs) return FRESHNESS.AGING;
  return FRESHNESS.STALE;
}

/** Multiplicative weight applied to a bucket's evidence contribution. */
function freshnessWeight(bucket, weights = {}) {
  const w = { FRESH: 1, AGING: 0.5, STALE: 0, UNKNOWN: 0, ...weights };
  return w[bucket] ?? 0;
}

/**
 * Per-datum age with explicit provenance. The spec requires every signal to
 * know how fresh its underlying data is, and to mark OI_STALE explicitly.
 * FYERS tick updates and OI snapshots are NOT the same clock: a tick can be
 * milliseconds old while OI is a periodic snapshot many minutes old.
 */
function datumFreshness({ marketDataTimestamp, optionChainTimestamp, tickTimestamp, nowMs = Date.now() }) {
  const mk = ageMs(marketDataTimestamp, nowMs);
  const ok = ageMs(optionChainTimestamp, nowMs);
  const tk = ageMs(tickTimestamp, nowMs);
  const worst = [mk, ok, tk].filter((v) => v !== null);
  return {
    marketDataAgeMs: mk,
    optionChainAgeMs: ok,
    tickAgeMs: tk,
    marketDataBucket: freshnessBucket(mk),
    optionChainBucket: freshnessBucket(ok),
    tickBucket: freshnessBucket(tk),
    dataAgeMs: worst.length ? Math.max(...worst) : null,
    overallBucket: freshnessBucket(worst.length ? Math.max(...worst) : null),
    OI_STALE: freshnessBucket(ok) === FRESHNESS.STALE || freshnessBucket(ok) === FRESHNESS.UNKNOWN,
  };
}

// ───────────────────────────── VWAP / ranges ─────────────────────────────

/**
 * Session VWAP from running cumulative volume. Returns null without both a
 * price and a positive cumulative volume — a VWAP over zero volume is not a
 * VWAP and must never be reported as one.
 */
function sessionVwap(price, cumVolume) {
  if (!Number.isFinite(price) || !Number.isFinite(cumVolume) || cumVolume <= 0) return null;
  return price; // call-site passes either {cumPv, cumVol} or the precomputed pair
}

function vwapFromSums(sumPxVol, cumVol) {
  if (!Number.isFinite(sumPxVol) || !Number.isFinite(cumVol) || cumVol <= 0) return null;
  return sumPxVol / cumVol;
}

/** Typical price from a bar (H+L+C)/3, guarding non-finite legs. */
function typicalPrice({ high, low, close }) {
  const leg = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));
  const legs = [leg(high), leg(low), leg(close)];
  if (legs.some((v) => !Number.isFinite(v))) return null;
  return (legs[0] + legs[1] + legs[2]) / 3;
}

/**
 * IST session window for Indian index options.
 *
 * The stored index tape is a 24x7 quote stream (first ticks on 2026-09-28 were
 * at 00:56 IST, last at 23:59 IST), so a naive "first N bars of the day" built
 * the opening range out of overnight flat quotes — a real correctness bug that
 * silently produces a degenerate OR (high == low) and a fake "held break".
 * Every bar-building path is therefore clipped to the cash session.
 */
const SESSION_OPEN_MIN = 9 * 60 + 15;      // 09:15 IST
const SESSION_CLOSE_MIN = 15 * 60 + 30;    // 15:30 IST

/** Build fixed-length OHLCV bars from timestamped LTP observations. */
function buildBars(ticks, barMinutes = 5, sessionDateIso, { clipToSession = true } = {}) {
  const usable = (ticks || [])
    .map((t) => ({ ts: parseIstTs(t.ts), ltp: Number(t.ltp), volume: Number(t.volume) || 0 }))
    .filter((t) => t.ts !== null && Number.isFinite(t.ltp))
    .filter((t) => {
      if (!clipToSession) return true;
      const m = istMinutesOfDay(new Date(t.ts));
      return m >= SESSION_OPEN_MIN && m <= SESSION_CLOSE_MIN;
    })
    .sort((a, b) => a.ts - b.ts);
  const bars = new Map();
  for (const t of usable) {
    const d = new Date(t.ts);
    const mins = istMinutesOfDay(d);
    const bucket = Math.floor(mins / barMinutes) * barMinutes;
    const key = `${sessionDateIso}#${bucket}`;
    if (!bars.has(key)) {
      bars.set(key, { key, barMinutes, bucketMinutes: bucket, startIstMs: t.ts - ((mins % barMinutes) + d.getUTCSeconds() / 60) * 60_000, high: t.ltp, low: t.ltp, close: t.ltp, open: t.ltp, volume: 0, tickCount: 0, firstTs: t.ts, lastTs: t.ts, sumPxVol: 0 });
    }
    const b = bars.get(key);
    b.high = Math.max(b.high, t.ltp);
    b.low = Math.min(b.low, t.ltp);
    b.close = t.ltp;
    b.open = b.tickCount === 0 ? t.ltp : b.open;
    b.volume += t.volume;
    b.tickCount += 1;
    b.lastTs = t.ts;
    // Tick-level volume is unreliable (exchange sends per-update volume, not
    // per-interval volume), so bar VWAP uses the typical price of the bar and
    // is labelled as an approximation, not a true trade-weighted VWAP.
    const tp = (b.high + b.low + b.close) / 3;
    b.sumPxVol += tp * b.volume;
  }
  const out = [...bars.values()].sort((a, b) => a.bucketMinutes - b.bucketMinutes);
  let cumVol = 0;
  let cumPxVol = 0;
  for (const b of out) {
    cumVol += b.volume;
    cumPxVol += b.sumPxVol;
    b.cumVolume = cumVol;
    b.vwap = vwapFromSums(cumPxVol, cumVol);
    b.range = b.high - b.low;
    b.body = b.close - b.open;
    b.bodyRatio = b.range > 0 ? b.body / b.range : 0;
  }
  return out;
}

// ──────────────────────── opening range / VWAP state ─────────────────────

/**
 * Opening-range state from completed bars. `orMinutes` is the OR window
 * (default 15 = first three 5-minute bars). A break requires the CLOSE to sit
 * beyond the boundary by `breakBufferPct` of the OR height — an intrabar poke
 * is a sweep candidate, not a breakout.
 */
function openingRangeState(bars, { orMinutes = 15, breakBufferPct = 0.10 } = {}) {
  const need = orMinutes / (bars[0]?.barMinutes || 5);
  if (bars.length < need) return { ready: false, reason: 'INSUFFICIENT_BARS', barsSeen: bars.length, barsNeeded: need };
  const orBars = bars.slice(0, need);
  const orHigh = Math.max(...orBars.map((b) => b.high));
  const orLow = Math.min(...orBars.map((b) => b.low));
  // Defensive: the index tape can be EMPTY (e.g. a feed outage, or before the
  // open). Math.max(...[]) is -Infinity and Math.min(...[]) is +Infinity, so
  // every downstream number silently became garbage. Report "no bars" instead.
  if (!bars.length) {
    return {
      ready: false, reason: 'NO_BARS', barsSeen: 0, barsNeeded: need,
      orHigh: null, orLow: null, orHeight: null, breakBuffer: null,
      close: null, vwap: null, closePos: 'UNKNOWN', beyondBuffer: false,
      pokedUp: false, pokedDown: false, hadBreak: false, breakFailed: false,
      held: null, barsOutside: 0, vwapRelation: 'UNKNOWN', distanceFromVwap: null, vwapDistancePct: null,
    };
  }
  const last = bars[bars.length - 1];
  const height = orHigh - orLow;
  const buffer = height * breakBufferPct;
  const vwap = last.vwap;
  const close = last.close;
  const beyond = (p) => p > orHigh + buffer ? 'UP' : (p < orLow - buffer ? 'DOWN' : 'INSIDE');
  const closePos = beyond(close);
  const maxHigh = Math.max(...bars.map((b) => b.high));
  const minLow = Math.min(...bars.map((b) => b.low));
  const pokedUp = maxHigh > orHigh;
  const pokedDown = minLow < orLow;
  const barsOutside = bars.filter((b, i) => i >= need && beyond(b.close) === closePos && closePos !== 'INSIDE').length;
  // A retest is price trading back into the range AFTER the breakout close.
  // The breakout bar's own low is part of the break, not a retest — counting it
  // made every genuine breakout look like a failed one.
  const firstOutsideIdx = bars.findIndex((b, i) => i >= need && beyond(b.close) === closePos && closePos !== 'INSIDE');
  const retested = closePos !== 'INSIDE' && firstOutsideIdx >= 0
    ? bars.slice(firstOutsideIdx + 1).some((b) => (closePos === 'UP' ? b.low <= orHigh : b.high >= orLow))
    : false;
  const held = closePos !== 'INSIDE' ? barsOutside >= 2 && !retested : null;
  // A break that has already happened but is no longer holding is the failed /
  // false-break state the reversal setups key on. Exposed explicitly so no
  // caller has to infer it from poke flags.
  const hadBreak = bars.slice(need).some((b) => beyond(b.close) !== 'INSIDE');
  const breakFailed = hadBreak && closePos === 'INSIDE';
  return {
    ready: true,
    hadBreak, breakFailed,
    orHigh, orLow, orHeight: height, breakBuffer: buffer,
    orMinutes, barsUsed: need,
    close, vwap, closePos, beyondBuffer: closePos !== 'INSIDE',
    pokedUp, pokedDown,
    falseBreak: closePos !== 'INSIDE' && barsOutside < 2,
    held, barsOutside,
    vwapRelation: vwap === null ? 'UNKNOWN' : (close > vwap ? 'ABOVE_VWAP' : close < vwap ? 'BELOW_VWAP' : 'AT_VWAP'),
    distanceFromVwap: vwap === null ? null : close - vwap,
    vwapDistancePct: vwap === null || vwap === 0 ? null : (close - vwap) / vwap * 100,
  };
}

/** VWAP reclaim / reject: needs a prior excursion then a close back through. */
function vwapReclaimState(bars, vwap, { barsBack = 6 } = {}) {
  if (vwap === null || !bars.length) return { state: 'UNKNOWN', reason: 'NO_VWAP' };
  const window = bars.slice(-barsBack);
  const last = window[window.length - 1];
  const sides = window.map((b) => (b.close > b.vwap ? 1 : b.close < b.vwap ? -1 : 0));
  const current = sides[sides.length - 1];
  if (current === 0) return { state: 'AT_VWAP', prior: sides.slice(0, -1).filter((s) => s !== 0).slice(-1)[0] ?? 0, barsBack };
  const prior = [...sides].reverse().slice(1).find((s) => s !== 0) ?? 0;
  let crosses = 0;
  for (let i = 1; i < sides.length; i += 1) if (sides[i] !== 0 && prior !== 0 && sides[i] !== sides[i - 1]) crosses += 1;
  if (current === 1 && prior === -1) return { state: crosses >= 2 ? 'FLIP_RECLAIM' : 'RECLAIM', prior, crosses, barsBack };
  if (current === -1 && prior === 1) return { state: crosses >= 2 ? 'FLIP_REJECT' : 'REJECT', prior, crosses, barsBack };
  return { state: current === 1 ? 'HOLDING_ABOVE' : 'HOLDING_BELOW', prior, crosses, barsBack };
}

/** Directional persistence: share of recent bars closing on the dominant side. */
function directionalPersistence(bars, n = 6) {
  const w = bars.slice(-n);
  if (w.length < 2) return { score: 0, bars: w.length, netBody: 0, note: 'INSUFFICIENT_BARS' };
  let up = 0; let down = 0; let net = 0;
  for (const b of w) {
    if (b.body > 0) { up += 1; net += b.body; }
    else if (b.body < 0) { down += 1; net += b.body; }
  }
  const total = up + down;
  return {
    up, down, total, netBody: net,
    score: total ? (up - down) / total : 0,
    dominant: up === down ? 'MIXED' : up > down ? 'UP' : 'DOWN',
    bars: w.length,
  };
}

// ────────────────────────────── gaps ──────────────────────────────────────

/** Opening-condition classification. Thresholds are explicit inputs. */
function classifyGap(gapPct, { smallPct = 0.20, largePct = 0.50 } = {}) {
  const g = Number(gapPct);
  if (!Number.isFinite(g)) return 'UNKNOWN';
  const a = Math.abs(g);
  if (a <= smallPct) return 'FLAT_OPEN';
  return g > 0 ? (a >= largePct ? 'GAP_UP_LARGE' : 'GAP_UP_SMALL') : (a >= largePct ? 'GAP_DOWN_LARGE' : 'GAP_DOWN_SMALL');
}

/** Where the open sits inside the implied range (0 = lower boundary, 1 = upper). */
function openingPositionInImpliedRange(open, impliedLow, impliedHigh) {
  if (![open, impliedLow, impliedHigh].every((v) => Number.isFinite(v)) || impliedHigh <= impliedLow) {
    return { position: 'UNKNOWN', z: null, outside: false };
  }
  const span = impliedHigh - impliedLow;
  const mid = (impliedHigh + impliedLow) / 2;
  const z = span === 0 ? 0 : (open - mid) / (span / 2);
  const position = z > 0.6 ? 'NEAR_UPPER_BOUNDARY' : z < -0.6 ? 'NEAR_LOWER_BOUNDARY' : 'INSIDE_EXPECTED_RANGE';
  return { position, z: Number(z.toFixed(4)), outside: open > impliedHigh || open < impliedLow, mid };
}

// ─────────────────────────── option maths ─────────────────────────────────

/** Black–Scholes call/put with continuous dividend yield (for greeks). */
function bsGreeks({ S, K, T, r = 0.06, q = 0, vol, type = 'CE' }) {
  if (![S, K, T, vol].every((v) => Number.isFinite(v)) || T <= 0 || vol <= 0 || K <= 0 || S <= 0) return null;
  const pdf = (x) => Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
  const d1 = (Math.log(S / K) + (r - q + 0.5 * vol * vol) * T) / (vol * Math.sqrt(T));
  const d2 = d1 - vol * Math.sqrt(T);
  const Nd = (x) => 0.5 * (1 + erf(x / Math.SQRT2));
  const isCall = type === 'CE';
  const delta = isCall ? Math.exp(-q * T) * Nd(d1) : Math.exp(-q * T) * (Nd(d1) - 1);
  const gamma = (Math.exp(-q * T) * pdf(d1)) / (S * vol * Math.sqrt(T));
  const vega = S * Math.exp(-q * T) * pdf(d1) * Math.sqrt(T);
  const thetaAnnual = isCall
    ? -(S * pdf(d1) * vol * Math.exp(-q * T)) / (2 * Math.sqrt(T)) + r * K * Math.exp(-r * T) * Nd(d2) - q * S * Math.exp(-q * T) * Nd(d1)
    : -(S * pdf(d1) * vol * Math.exp(-q * T)) / (2 * Math.sqrt(T)) - r * K * Math.exp(-r * T) * (1 - Nd(d2)) + q * S * Math.exp(-q * T) * (1 - Nd(d1));
  const price = isCall
    ? S * Math.exp(-q * T) * Nd(d1) - K * Math.exp(-r * T) * Nd(d2)
    : K * Math.exp(-r * T) * (1 - Nd(d2)) - S * Math.exp(-q * T) * (1 - Nd(d1));
  return { price, delta, gamma, vega, thetaPerDay: thetaAnnual / 365, d1, d2 };
}

function erf(x) {
  const s = Math.sign(x);
  x = Math.abs(x);
  const a1 = 0.254829592; const a2 = -0.284496736; const a3 = 1.421413741;
  const a4 = -1.453152027; const a5 = 1.061405429; const p = 0.3275911;
  const t = 1 / (1 + p * x);
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return s * y;
}

/** ATM straddle premium and the implied move it prices. */
function impliedMoveFromStraddle(straddlePremium, spot) {
  if (!Number.isFinite(straddlePremium) || !Number.isFinite(spot) || spot <= 0) return null;
  return {
    straddlePremium: Number(straddlePremium.toFixed(4)),
    impliedMovePts: Number(straddlePremium.toFixed(2)),
    impliedMovePct: Number(((straddlePremium / spot) * 100).toFixed(3)),
    impliedLow: Number((spot - straddlePremium).toFixed(2)),
    impliedHigh: Number((spot + straddlePremium).toFixed(2)),
  };
}

/** Realised range of a session from bars, for realised-vs-implied comparison. */
function realisedRange(bars) {
  if (!bars || !bars.length) return null;
  const high = Math.max(...bars.map((b) => b.high));
  const low = Math.min(...bars.map((b) => b.low));
  return { high, low, range: Number((high - low).toFixed(2)), bars: bars.length };
}

/** Max pain over a two-sided OI chain (pre-existing helper, kept shared). */
function maxPainStrikes(chain) {
  const rows = (chain || []).filter((r) => Number.isFinite(Number(r.strike)));
  if (!rows.length) return null;
  let best = null;
  for (const k of rows) {
    let pain = 0;
    for (const r of rows) {
      pain += Math.max(0, k.strike - r.strike) * (Number(r.ceOi) || 0);
      pain += Math.max(0, r.strike - k.strike) * (Number(r.peOi) || 0);
    }
    if (!best || pain < best.pain) best = { strike: Number(k.strike), pain };
  }
  return best;
}

/** OI concentration: share of total OI held by the top-N strikes per side. */
function oiConcentration(chain, topN = 3) {
  const rows = (chain || []).filter((r) => Number.isFinite(Number(r.strike)));
  const sum = (v) => rows.reduce((a, r) => a + (Number(v(r)) || 0), 0);
  const ceTotal = sum((r) => r.ceOi);
  const peTotal = sum((r) => r.peOi);
  const top = (key) => [...rows].sort((a, b) => (Number(b[key]) || 0) - (Number(a[key]) || 0)).slice(0, topN);
  const share = (list, key, total) => (
    total > 0 ? Number((list.reduce((a, r) => a + (Number(r[key]) || 0), 0) / total * 100).toFixed(2)) : null
  );
  const topCe = top('ceOi');
  const topPe = top('peOi');
  return {
    topN,
    callOiTotal: ceTotal,
    putOiTotal: peTotal,
    topCallStrikes: topCe.map((r) => ({ strike: Number(r.strike), oi: Number(r.ceOi) || 0 })),
    topPutStrikes: topPe.map((r) => ({ strike: Number(r.strike), oi: Number(r.peOi) || 0 })),
    callConcentrationPct: share(topCe, 'ceOi', ceTotal),
    putConcentrationPct: share(topPe, 'peOi', peTotal),
  };
}

/** Largest absolute positive/negative OI changes (migration signal). */
function oiMigrations(chain, n = 5) {
  const rows = (chain || []).filter((r) => Number.isFinite(Number(r.strike)));
  const mk = (side, type) => rows
    .map((r) => ({ strike: Number(r.strike), change: Number(r[type]) || 0, oi: Number(r[side]) || 0 }))
    .filter((r) => Number.isFinite(r.change) && r.change !== 0)
    .sort((a, b) => Math.abs(b.change) - Math.abs(a.change))
    .slice(0, n);
  return { largestAdds: mk('ceOi', 'ceChg'), largestDrops: mk('peOi', 'peChg') };
}

/** Relative spread in points and as a fraction of mid — the cost gate. */
function spreadMetrics(bid, ask, ltp) {
  // A null/undefined/zero bid or ask is MISSING data, not a zero-width spread.
  // Number(null) is 0, so guard before coercion or a missing bid silently
  // becomes a 200% spread and poisons the cost gate.
  const b = bid === null || bid === undefined || bid === '' ? NaN : Number(bid);
  const a = ask === null || ask === undefined || ask === '' ? NaN : Number(ask);
  if (!Number.isFinite(b) || !Number.isFinite(a) || a <= 0 || b <= 0 || a < b) return null;
  const mid = (a + b) / 2;
  if (mid <= 0) return null;
  return {
    bid: b, ask: a, mid: Number(mid.toFixed(4)),
    spread: Number((a - b).toFixed(4)),
    spreadPctOfMid: Number((((a - b) / mid) * 100).toFixed(3)),
    ltp: ltp === null || ltp === undefined || ltp === '' ? null : Number(ltp),
    ltpVsMid: (ltp === null || ltp === undefined || ltp === '') || !Number.isFinite(Number(ltp)) ? null : Number((Number(ltp) - mid).toFixed(4)),
  };
}

/** Round to n decimals, or null when the input is not finite. */
function r2(v, n = 4) {
  const x = Number(v);
  return Number.isFinite(x) ? Number(x.toFixed(n)) : null;
}

module.exports = {
  IST_OFFSET_MS, istNowMs, istNowDate, istDateIso, istHm, istMinutesOfDay, istDateAt, parseIstTs, ageMs,
  SESSION_OPEN_MIN, SESSION_CLOSE_MIN,
  FRESHNESS, freshnessBucket, freshnessWeight, datumFreshness,
  sessionVwap, vwapFromSums, typicalPrice, buildBars,
  openingRangeState, vwapReclaimState, directionalPersistence,
  classifyGap, openingPositionInImpliedRange,
  bsGreeks, erf, impliedMoveFromStraddle, realisedRange, maxPainStrikes,
  oiConcentration, oiMigrations, spreadMetrics, r2,
};
