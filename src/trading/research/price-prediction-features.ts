/**
 * OFFLINE / SHADOW RESEARCH — price-prediction feature formulas.
 *
 * Nothing in this file is wired into trading. It is a pure, deterministic
 * research surface: no DB, no network, no clock, no randomness. The only
 * import is the existing pure `pattern-features` helpers (ATR / median /
 * detectBreakout / detectReversal) so the "existing engine" baseline is the
 * real one rather than a reimplementation.
 *
 * Contract for EVERY function here:
 *   * the same inputs always produce the same output (replay-safe);
 *   * a value the caller did not supply is REFUSED with a closed-vocabulary
 *     reason — never coerced to 0, NaN or a guess (Stage-1 D4 rule);
 *   * "unknown" and "zero" are different answers.
 *
 * Feature numbering follows the operator's brief:
 *    1 strike-wise CE/PE OI concentration      2 highest CE-OI / PE-OI levels
 *    3 OI-change-based levels                  4 OI-level migration
 *    5 PCR as a regime feature                 6 price direction x CE OI change
 *    7 price direction x PE OI change          8 price x OI x volume
 *    9 upper shadow                           10 lower shadow
 *   11 wick/body ratio                        12 rejection/acceptance of OI levels
 *   13 breakout vs failed breakout at OI levels
 */

export const REFUSAL_REASONS = [
  'NO_OI',              // every leg's OI was absent (null) — not the same as 0
  'NO_OI_CHANGE',       // every leg's OI change was absent or exactly 0
  'NO_LEGS',            // the chain snapshot carried no legs at all
  'NO_SIDE',            // the requested side (CE/PE) had no legs
  'INSUFFICIENT_STRIKES', // fewer than 2 strikes on the side: no distribution exists
  'NO_TOTAL_OI',        // the side's total OI is 0: shares/PCR are undefined
  'ZERO_RANGE',         // high == low: no candle geometry exists
  'ZERO_BODY',          // open == close: wick/body is undefined
  'NO_PRICE_MOVE',      // spot unchanged: direction is undefined
  'NO_PRIOR_SNAPSHOT',  // migration needs a previous observation
  'NO_LEVEL',           // no OI-derived level was available to test against
  'NO_VOLUME',          // every leg's volume was absent
  'NO_VOLUME_BOTH_SIDES',
] as const;
export type RefusalReason = (typeof REFUSAL_REASONS)[number];

export type Ok<T> = { ok: true; value: T };
export type Refused = { ok: false; reason: RefusalReason };
export type Result<T> = Ok<T> | Refused;
const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
const no = (reason: RefusalReason): Refused => ({ ok: false, reason });

/** One option-chain leg. `null` means the source did not publish that field. */
export type OiLeg = {
  strike: number;
  optionType: 'CE' | 'PE';
  oi: number | null;
  changeOi: number | null;
  volume: number | null;
};

/** One completed candle. */
export type Bar = { open: number; high: number; low: number; close: number; volume: number | null };

const sum = (xs: readonly number[]): number => xs.reduce((s, x) => s + x, 0);
const sideLegs = (legs: readonly OiLeg[], side: 'CE' | 'PE'): OiLeg[] =>
  legs.filter((l) => l.optionType === side && Number.isFinite(l.strike));
/** OI values that were actually published. Absent legs are dropped, not zeroed. */
const publishedOi = (legs: readonly OiLeg[]): number[] =>
  legs.map((l) => l.oi).filter((v): v is number => v !== null && Number.isFinite(v));
const publishedChange = (legs: readonly OiLeg[]): number[] =>
  legs.map((l) => l.changeOi).filter((v): v is number => v !== null && Number.isFinite(v));

/** Deterministic tie-break: highest value, then LOWEST strike. */
const extremeStrike = (legs: readonly OiLeg[], pick: (l: OiLeg) => number, wantMax: boolean): number | null => {
  let best: OiLeg | null = null;
  let bestV = 0;
  for (const l of legs) {
    const v = pick(l);
    if (!Number.isFinite(v)) continue;
    if (best === null || (wantMax ? v > bestV : v < bestV) || (v === bestV && l.strike < best.strike)) {
      best = l; bestV = v;
    }
  }
  return best ? best.strike : null;
};

// ─────────────────────────── 1. OI concentration ───────────────────────────

export type Concentration = {
  side: 'CE' | 'PE';
  strikes: number;      // strikes that published OI
  totalOi: number;
  hhi: number;          // Σ share_s²  (1/N = uniform, 1 = all in one strike)
  hhiNorm: number | null; // (hhi − 1/N) / (1 − 1/N); null when N === 1
  topStrike: number;
  topShare: number;     // share of the single largest strike
};

/**
 * FORMULA: share_s = oi_s / Σ oi (published OI only); hhi = Σ share_s².
 * hhiNorm rescales hhi onto [0,1] so chains with different strike counts are
 * comparable: (hhi − 1/N) / (1 − 1/N).
 */
export function oiConcentration(legs: readonly OiLeg[], side: 'CE' | 'PE'): Result<Concentration> {
  if (!legs.length) return no('NO_LEGS');
  const onSide = sideLegs(legs, side);
  if (!onSide.length) return no('NO_SIDE');
  const withOi = onSide.filter((l) => l.oi !== null && Number.isFinite(l.oi));
  if (!withOi.length) return no('NO_OI');
  const published = publishedOi(onSide);
  const totalOi = sum(published);
  if (totalOi <= 0) return no('NO_TOTAL_OI');
  const n = published.length;
  if (n < 2) return no('INSUFFICIENT_STRIKES');
  // One entry per STRIKE: a strike that appears twice is summed, not double-counted.
  const byStrike = new Map<number, number>();
  for (const l of withOi) byStrike.set(l.strike, (byStrike.get(l.strike) ?? 0) + (l.oi as number));
  const shares = [...byStrike.values()].map((v) => v / totalOi);
  const hhi = sum(shares.map((s) => s * s));
  const topShare = Math.max(...shares);
  const topStrike = extremeStrike(
    [...byStrike.entries()].map(([strike, oi]) => ({ strike, optionType: side, oi, changeOi: null, volume: null })),
    (l) => l.oi as number, true,
  ) as number;
  const uniform = 1 / byStrike.size;
  return ok({
    side, strikes: byStrike.size, totalOi, hhi, topStrike, topShare,
    hhiNorm: byStrike.size > 1 ? (hhi - uniform) / (1 - uniform) : null,
  });
}

// ─────────────────── 2 & 3. Highest-OI and OI-change levels ────────────────

export type OiLevels = {
  maxCeOiStrike: number;
  maxPeOiStrike: number;
  totalCeOi: number;
  totalPeOi: number;
  spotDistanceCe: number | null; // (level − spot) / spot, null when spot is unusable
  spotDistancePe: number | null;
};

/** FORMULA: the strike holding the largest published OI on each side (ties → lowest strike). */
export function highestOiLevels(legs: readonly OiLeg[], spot: number | null): Result<OiLevels> {
  if (!legs.length) return no('NO_LEGS');
  const ce = sideLegs(legs, 'CE').filter((l) => l.oi !== null && Number.isFinite(l.oi));
  const pe = sideLegs(legs, 'PE').filter((l) => l.oi !== null && Number.isFinite(l.oi));
  if (!ce.length && !pe.length) return no('NO_OI');
  const ceStrike = extremeStrike(ce, (l) => l.oi as number, true);
  const peStrike = extremeStrike(pe, (l) => l.oi as number, true);
  if (ceStrike === null || peStrike === null) return no('NO_OI');
  const usable = spot !== null && Number.isFinite(spot) && spot > 0;
  return ok({
    maxCeOiStrike: ceStrike,
    maxPeOiStrike: peStrike,
    totalCeOi: sum(publishedOi(ce)),
    totalPeOi: sum(publishedOi(pe)),
    spotDistanceCe: usable ? (ceStrike - (spot as number)) / (spot as number) : null,
    spotDistancePe: usable ? (peStrike - (spot as number)) / (spot as number) : null,
  });
}

export type OiChangeLevels = {
  maxCeChangeStrike: number | null;
  maxPeChangeStrike: number | null;
  maxAbsTotalChangeStrike: number | null;
  totalCeChange: number;
  totalPeChange: number;
};

/**
 * FORMULA: the strike with the largest POSITIVE published ΔOI on each side
 * (tie → lowest strike); plus the strike with the largest |ΔOI| over BOTH sides
 * combined, where per-strike ΔOI is summed across CE and PE.
 */
export function oiChangeLevels(legs: readonly OiLeg[]): Result<OiChangeLevels> {
  if (!legs.length) return no('NO_LEGS');
  const changes = publishedChange(legs);
  if (!changes.length) return no('NO_OI_CHANGE');
  const byStrike = new Map<number, number>();
  for (const l of legs) {
    if (l.changeOi === null || !Number.isFinite(l.changeOi)) continue;
    byStrike.set(l.strike, (byStrike.get(l.strike) ?? 0) + l.changeOi);
  }
  const ceRising = sideLegs(legs, 'CE').filter((l) => l.changeOi !== null && (l.changeOi as number) > 0);
  const peRising = sideLegs(legs, 'PE').filter((l) => l.changeOi !== null && (l.changeOi as number) > 0);
  const totalCeChange = sum(sideLegs(legs, 'CE').map((l) => (Number.isFinite(l.changeOi as number) ? (l.changeOi as number) : 0)));
  const totalPeChange = sum(sideLegs(legs, 'PE').map((l) => (Number.isFinite(l.changeOi as number) ? (l.changeOi as number) : 0)));
  if (totalCeChange === 0 && totalPeChange === 0 && !ceRising.length && !peRising.length) return no('NO_OI_CHANGE');
  const maxAbs = extremeStrike(
    [...byStrike.entries()].map(([strike, v]) => ({ strike, optionType: 'CE' as const, oi: null, changeOi: v, volume: null })),
    (l) => Math.abs(l.changeOi as number), true,
  );
  return ok({
    maxCeChangeStrike: ceRising.length ? extremeStrike(ceRising, (l) => l.changeOi as number, true) : null,
    maxPeChangeStrike: peRising.length ? extremeStrike(peRising, (l) => l.changeOi as number, true) : null,
    maxAbsTotalChangeStrike: maxAbs,
    totalCeChange, totalPeChange,
  });
}

// ──────────────────────── 4. OI-level migration ────────────────────────────

export type Migration = {
  ceShift: number;             // strikes moved (current − previous)
  peShift: number;
  spotShift: number;           // (spot − prevSpot) / prevSpot
  ceMigration: 'WITH_SPOT' | 'AGAINST_SPOT' | 'STATIONARY';
  peMigration: 'WITH_SPOT' | 'AGAINST_SPOT' | 'STATIONARY';
};

/**
 * FORMULA: compare the highest-OI strikes now with the previous observation,
 * against the spot move. WITH_SPOT when the level moved the same way as spot,
 * AGAINST_SPOT when it moved the opposite way, STATIONARY when it did not move.
 * A level that did not move while spot did is STATIONARY (not "against").
 */
export function oiLevelMigration(
  current: OiLevels, previous: OiLevels, spot: number | null, prevSpot: number | null,
): Result<Migration> {
  if (!current || !previous) return no('NO_PRIOR_SNAPSHOT');
  if (spot === null || prevSpot === null || !Number.isFinite(spot) || !Number.isFinite(prevSpot) || prevSpot <= 0) {
    return no('NO_PRICE_MOVE');
  }
  const spotShift = (spot - prevSpot) / prevSpot;
  const classify = (levelShift: number): Migration['ceMigration'] => {
    if (levelShift === 0) return 'STATIONARY';
    if (spotShift === 0) return 'STATIONARY';
    return Math.sign(levelShift) === Math.sign(spotShift) ? 'WITH_SPOT' : 'AGAINST_SPOT';
  };
  const ceShift = current.maxCeOiStrike - previous.maxCeOiStrike;
  const peShift = current.maxPeOiStrike - previous.maxPeOiStrike;
  return ok({ ceShift, peShift, spotShift, ceMigration: classify(ceShift), peMigration: classify(peShift) });
}

// ──────────────────────── 5. PCR as a regime feature ───────────────────────

export const PCR_REGIMES = ['PE_HEAVY', 'BALANCED', 'CE_HEAVY'] as const;
export type PcrRegime = (typeof PCR_REGIMES)[number];

export type PcrState = {
  pcr: number;                 // Σ PE OI / Σ CE OI
  pcrChange: number | null;    // vs the previous observation, null when unknown
  regime: PcrRegime | 'UNKNOWN'; // UNKNOWN until priorSessionPcrs supplies quantiles
  thresholds: { lo: number; hi: number } | null;
};

/**
 * FORMULA: pcr = Σ published PE OI / Σ published CE OI. Refused when the CE
 * total is 0 — PCR of "no CE open interest at all" is UNDEFINED, not zero.
 * The regime uses ONLY quantiles of PCR computed over sessions strictly before
 * the observation (`priorSessionPcrs`), so it cannot see its own outcome.
 * PCR = PE OI / CE OI, so a HIGH pcr means put open interest dominates:
 *   pcr >= q67 → PE_HEAVY,  pcr <= q33 → CE_HEAVY,  otherwise BALANCED.
 */
export function pcrState(
  legs: readonly OiLeg[], priorSessionPcrs: readonly number[], previousPcr: number | null = null,
): Result<PcrState> {
  if (!legs.length) return no('NO_LEGS');
  const ceOi = sum(publishedOi(sideLegs(legs, 'CE')));
  const peOi = sum(publishedOi(sideLegs(legs, 'PE')));
  if (!(ceOi > 0)) return no('NO_TOTAL_OI');
  const pcr = peOi / ceOi;
  const prior = priorSessionPcrs.filter((v) => Number.isFinite(v)).slice().sort((a, b) => a - b);
  let regime: PcrRegime | 'UNKNOWN' = 'UNKNOWN';
  let thresholds: { lo: number; hi: number } | null = null;
  if (prior.length >= 20) {
    const q = (p: number): number => prior[Math.min(prior.length - 1, Math.max(0, Math.round(p * (prior.length - 1))))];
    thresholds = { lo: q(1 / 3), hi: q(2 / 3) };
    regime = pcr >= thresholds.hi ? 'PE_HEAVY' : pcr <= thresholds.lo ? 'CE_HEAVY' : 'BALANCED';
  }
  return ok({ pcr, pcrChange: previousPcr !== null ? pcr - previousPcr : null, regime, thresholds });
}

// ─────────── 6 & 7. Price direction x CE / PE open-interest change ─────────

export const PRICE_OI_STATES = [
  'PRICE_UP_OI_UP', 'PRICE_UP_OI_DOWN', 'PRICE_DOWN_OI_UP', 'PRICE_DOWN_OI_DOWN',
] as const;
export type PriceOiState = (typeof PRICE_OI_STATES)[number];

const priceOiQuadrant = (spot: number | null, prevSpot: number | null, oiChange: number | null): Result<PriceOiState> => {
  if (spot === null || prevSpot === null || !Number.isFinite(spot) || !Number.isFinite(prevSpot)) return no('NO_PRICE_MOVE');
  if (spot === prevSpot) return no('NO_PRICE_MOVE');
  if (oiChange === null || !Number.isFinite(oiChange)) return no('NO_OI_CHANGE');
  if (oiChange === 0) return no('NO_OI_CHANGE');
  const up = spot > prevSpot;
  return ok(up ? (oiChange > 0 ? 'PRICE_UP_OI_UP' : 'PRICE_UP_OI_DOWN') : (oiChange > 0 ? 'PRICE_DOWN_OI_UP' : 'PRICE_DOWN_OI_DOWN'));
};

/**
 * FORMULA: quadrant of (sign of spot change, sign of that side's TOTAL ΔOI).
 * Covered calls/puts are deliberately NOT interpreted here as a verdict — the
 * quadrant is the feature; whether it predicts anything is the evaluation's job.
 */
export function priceDirectionVsSideOi(
  legs: readonly OiLeg[], side: 'CE' | 'PE', spot: number | null, prevSpot: number | null,
): Result<{ state: PriceOiState; sideOiChange: number }> {
  if (!legs.length) return no('NO_LEGS');
  const onSide = sideLegs(legs, side);
  if (!onSide.length) return no('NO_SIDE');
  const changes = publishedChange(onSide);
  if (!changes.length) return no('NO_OI_CHANGE');
  const sideOiChange = sum(onSide.map((l) => (Number.isFinite(l.changeOi as number) ? (l.changeOi as number) : 0)));
  const quadrant = priceOiQuadrant(spot, prevSpot, sideOiChange);
  return quadrant.ok ? ok({ state: quadrant.value, sideOiChange }) : quadrant;
}

// ───────────────────── 8. Price x OI x volume relationship ────────────────

export type PriceOiVolume = {
  oiGainingVolume: number;
  oiLosingVolume: number;
  oiVolumeRatio: number;   // volume on ΔOI>0 legs / volume on ΔOI<0 legs
  sessionVolumeRatio: number | null; // session volume / prior-session median volume
  quadrant: PriceOiState;
};

/**
 * FORMULA: volume is split by the SIGN of each leg's ΔOI —
 *   oiVolumeRatio = Σ volume(ΔOI>0) / Σ volume(ΔOI<0)
 * refused when the losing side has 0 volume (undefined, not infinite).
 * sessionVolumeRatio = volume / median(volume of prior sessions) is supplied by
 * the caller (it needs history) and stays null when it cannot be computed.
 */
export function priceOiVolume(
  legs: readonly OiLeg[], spot: number | null, prevSpot: number | null,
  sessionVolumeRatio: number | null = null,
): Result<PriceOiVolume> {
  if (!legs.length) return no('NO_LEGS');
  if (!publishedChange(legs).length) return no('NO_OI_CHANGE');
  const volumes = legs.map((l) => l.volume).filter((v): v is number => v !== null && Number.isFinite(v));
  if (!volumes.length) return no('NO_VOLUME');
  const totalChange = sum(legs.map((l) => (Number.isFinite(l.changeOi as number) ? (l.changeOi as number) : 0)));
  const quadrant = priceOiQuadrant(spot, prevSpot, totalChange);
  if (!quadrant.ok) return quadrant;
  let gain = 0, lose = 0;
  for (const l of legs) {
    if (l.changeOi === null || l.volume === null || !Number.isFinite(l.changeOi) || !Number.isFinite(l.volume)) continue;
    if (l.changeOi > 0) gain += l.volume; else if (l.changeOi < 0) lose += l.volume;
  }
  if (lose === 0) return no('NO_VOLUME_BOTH_SIDES');
  return ok({
    oiGainingVolume: gain, oiLosingVolume: lose, oiVolumeRatio: gain / lose,
    sessionVolumeRatio, quadrant: quadrant.value,
  });
}

// ─────────────── 9, 10, 11. Candle shadow / wick geometry ─────────────────

export type ShadowGeometry = {
  upperShadow: number;      // (high − max(open, close)) / (high − low)
  lowerShadow: number;      // (min(open, close) − low) / (high − low)
  wickBodyRatio: number;    // (upper + lower wick) / |close − open|
  body: number;
  range: number;
  direction: 'UP' | 'DOWN' | 'FLAT';
};

/**
 * FORMULAS (all on one completed candle; range and body must exist):
 *   upperShadow  = (high − max(open, close)) / (high − low)
 *   lowerShadow  = (min(open, close) − low) / (high − low)
 *   wickBodyRatio = (upperShadowBody + lowerShadowBody) / |close − open|,
 *                   where each wick is in PRICE units, not a fraction.
 * A zero-range candle has no geometry (ZERO_RANGE); a zero-body candle has no
 * wick/body ratio (ZERO_BODY) — both are refusals, never Infinity or 0.
 */
export function shadowGeometry(bar: Bar): Result<ShadowGeometry> {
  if (![bar.open, bar.high, bar.low, bar.close].every((v) => Number.isFinite(v))) return no('ZERO_RANGE');
  const range = bar.high - bar.low;
  if (!(range > 0)) return no('ZERO_RANGE');
  const body = Math.abs(bar.close - bar.open);
  const upperWick = bar.high - Math.max(bar.open, bar.close);
  const lowerWick = Math.min(bar.open, bar.close) - bar.low;
  if (body === 0) return no('ZERO_BODY');
  return ok({
    upperShadow: upperWick / range,
    lowerShadow: lowerWick / range,
    wickBodyRatio: (upperWick + lowerWick) / body,
    body, range,
    direction: bar.close > bar.open ? 'UP' : bar.close < bar.open ? 'DOWN' : 'FLAT',
  });
}

// ──────── 12 & 13. Acceptance/rejection and breakout at OI-derived levels ──

export const LEVEL_OUTCOMES = [
  'NOT_TESTED', 'ACCEPTED_BEYOND', 'REJECTED_AT_LEVEL', 'CLOSED_BEYOND', 'UNRESOLVED',
] as const;
export type LevelOutcome = (typeof LEVEL_OUTCOMES)[number];

export const OI_BREAKOUT_CLASSES = [
  'NONE', 'EARLY_BREAKOUT', 'CONFIRMED_BREAKOUT', 'FAILED_BREAKOUT',
] as const;
export type OiBreakoutClass = (typeof OI_BREAKOUT_CLASSES)[number];

export type LevelTest = {
  outcome: LevelOutcome;
  breakout: OiBreakoutClass;
  level: number;
  role: 'RESISTANCE' | 'SUPPORT';
  tolerance: number;   // ATR-derived, supplied by the caller
  distanceOverLevel: number;
};

/**
 * FORMULA (level = the previous session's highest-OI strike; tolerance = a
 * fraction of ATR computed from sessions strictly before this one):
 *   resistance:  tested = high >  level
 *                CLOSED_BEYOND   = close >  level + tolerance
 *                ACCEPTED_BEYOND = CLOSED_BEYOND and close >= (high + low)/2
 *                REJECTED_AT_LEVEL = tested and close < level
 *                UNRESOLVED      = tested, not closed beyond, and still above
 *   support is the mirror image (low < level, close < level − tolerance).
 * BREAKOUT CLASSIFICATION (resistance shown; support mirrored):
 *   NONE                = never traded beyond the level
 *   FAILED_BREAKOUT     = traded beyond by more than tolerance but closed back at/below it
 *   CONFIRMED_BREAKOUT  = closed beyond the level by more than tolerance
 *   EARLY_BREAKOUT      = closed beyond the level but within the tolerance band
 * The tolerance is the caller's ATR share on purpose: it is NOT tuned here.
 */
export function testOiLevel(
  bar: Bar, level: number | null, role: 'RESISTANCE' | 'SUPPORT', tolerance: number | null,
): Result<LevelTest> {
  if (level === null || !Number.isFinite(level)) return no('NO_LEVEL');
  if (tolerance === null || !Number.isFinite(tolerance) || tolerance < 0) return no('NO_LEVEL');
  const { open, high, low, close } = bar;
  if (![open, high, low, close].every((v) => Number.isFinite(v))) return no('ZERO_RANGE');
  const beyond = role === 'RESISTANCE' ? high - level : level - low;
  const closeBeyond = role === 'RESISTANCE' ? close - level : level - close;
  const toleranceAbs = tolerance;
  let breakout: OiBreakoutClass;
  if (beyond <= 0) breakout = 'NONE';
  else if (closeBeyond <= 0) breakout = 'FAILED_BREAKOUT';
  else if (closeBeyond > toleranceAbs) breakout = 'CONFIRMED_BREAKOUT';
  else breakout = 'EARLY_BREAKOUT';

  let outcome: LevelOutcome;
  if (beyond <= 0) outcome = 'NOT_TESTED';
  else if (closeBeyond > 0) {
    const mid = (high + low) / 2;
    const heldBeyond = role === 'RESISTANCE' ? close >= mid : close <= mid;
    outcome = heldBeyond ? 'ACCEPTED_BEYOND' : 'CLOSED_BEYOND';
  } else outcome = 'REJECTED_AT_LEVEL';
  return ok({ outcome, breakout, level, role, tolerance: toleranceAbs, distanceOverLevel: beyond });
}

/** Wall-clock minute-of-session key (IST) for the time-of-day breakdown. */
export const sessionMinuteOfDay = (istHour: number, istMinute: number): number => istHour * 60 + istMinute;
