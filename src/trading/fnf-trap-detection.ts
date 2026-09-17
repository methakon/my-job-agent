/**
 * FNF Trap Detection — classifies market traps from available data.
 *
 * Do NOT claim manipulation intent. Trap classification is a hypothesis
 * about market microstructure, not an assertion about intent.
 */

export enum TrapType {
  OI_CROWDING = 'oi_crowding',
  OI_UNWIND = 'oi_unwind',
  IV_CRUSH = 'iv_crush',
  THETA_DECAY = 'theta_decay',
  FALSE_BREAKOUT = 'false_breakout',
  GAMMA_REGIME_SHIFT = 'gamma_regime_shift',
  LIQUIDITY_TRAP = 'liquidity_trap',
  EVENT_VOL_TRAP = 'event_vol_trap',
  PIN_RISK = 'pin_risk',
  CROSS_ASSET_DIVERGENCE = 'cross_asset_divergence',
  DATA_QUALITY_FAILURE = 'data_quality',
  MODEL_DISAGREEMENT = 'model_disagreement',
}

export type TrapSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface Trap {
  trapType: TrapType;
  severity: TrapSeverity;
  detail: string;
  score: number; // 0-100
}

export interface TrapMarketData {
  premium: number;
  spreadPct: number | null;
  volume: number | null;
  openInterest: number | null;
  oiChange: number | null;
  iv: number | null;
  ivChange: number | null;
  dte: number;
  delta: number | null;
  underlyingSpot: number;
  underlyingSma20: number | null;
  underlyingSma5: number | null;
  futuresBasis: number | null;
  isExpiryWeek: boolean;
  hasMajorEvent: boolean;
  quoteAgeMin: number;
  maxStaleMin: number;
  greeksConsistent: boolean;
  crossAssetDivergence: number; // |spot - futures| / spot
}

export interface TrapAssessment {
  traps: Trap[];
  hasTraps: boolean;
  highSeverity: boolean;
  score: number; // aggregate 0-100
}

export function fnfDetectTraps(data: TrapMarketData): TrapAssessment {
  const traps: Trap[] = [];

  // 1. DATA_QUALITY_FAILURE
  if (data.quoteAgeMin > data.maxStaleMin) {
    traps.push({
      trapType: TrapType.DATA_QUALITY_FAILURE,
      severity: 'critical',
      detail: `quote stale ${data.quoteAgeMin}min > max ${data.maxStaleMin}min`,
      score: 95,
    });
  }
  if (data.volume !== null && data.volume === 0) {
    traps.push({
      trapType: TrapType.DATA_QUALITY_FAILURE,
      severity: 'high',
      detail: 'zero volume — possible data failure',
      score: 85,
    });
  }

  // 2. THETA_DECAY — near-expiry deep OTM
  if (data.dte <= 2 && data.delta !== null && Math.abs(data.delta) < 0.10) {
    traps.push({
      trapType: TrapType.THETA_DECAY,
      severity: data.dte === 0 ? 'critical' : 'high',
      detail: `DTE=${data.dte}, delta=${data.delta?.toFixed(2)} — theta decay accelerating`,
      score: data.dte === 0 ? 90 : 70,
    });
  }

  // 3. OI_CROWDING — OI very high + volume low
  if (data.openInterest !== null && data.openInterest > 50000 &&
      data.volume !== null && data.volume < data.openInterest * 0.01) {
    traps.push({
      trapType: TrapType.OI_CROWDING,
      severity: 'medium',
      detail: `OI ${data.openInterest} but volume ${data.volume} — crowded`,
      score: 55,
    });
  }

  // 4. OI_UNWIND — large negative OI change
  if (data.oiChange !== null && data.oiChange < -1000) {
    traps.push({
      trapType: TrapType.OI_UNWIND,
      severity: 'medium',
      detail: `OI change ${data.oiChange} — significant unwind`,
      score: 50,
    });
  }

  // 5. IV_CRUSH — IV dropping sharply
  if (data.ivChange !== null && data.ivChange < -0.05) {
    traps.push({
      trapType: TrapType.IV_CRUSH,
      severity: 'medium',
      detail: `IV change ${data.ivChange?.toFixed(3)} — potential crush`,
      score: 50,
    });
  }

  // 6. LIQUIDITY_TRAP — wide spread + low volume
  if (data.spreadPct !== null && data.spreadPct > 3.0 &&
      data.volume !== null && data.volume < 100) {
    traps.push({
      trapType: TrapType.LIQUIDITY_TRAP,
      severity: 'high',
      detail: `spread ${data.spreadPct?.toFixed(1)}% + volume ${data.volume} — thin book`,
      score: 75,
    });
  }

  // 7. EVENT_VOL_TRAP — event week + high IV
  if (data.hasMajorEvent && data.iv !== null && data.iv > 0.30) {
    traps.push({
      trapType: TrapType.EVENT_VOL_TRAP,
      severity: 'medium',
      detail: `event week + IV ${data.iv?.toFixed(3)} — inflated premium risk`,
      score: 60,
    });
  }

  // 8. PIN_RISK — near expiry + near round strike
  if (data.dte <= 1 && data.premium < 10) {
    traps.push({
      trapType: TrapType.PIN_RISK,
      severity: 'medium',
      detail: `DTE=${data.dte}, premium=${data.premium?.toFixed(1)} — pin risk zone`,
      score: 55,
    });
  }

  // 9. CROSS_ASSET_DIVERGENCE
  if (data.crossAssetDivergence > 0.005) {
    traps.push({
      trapType: TrapType.CROSS_ASSET_DIVERGENCE,
      severity: 'low',
      detail: `cross-asset divergence ${(data.crossAssetDivergence * 100).toFixed(2)}%`,
      score: 35,
    });
  }

  // 10. GAMMA_REGIME_SHIFT — expiry week + high gamma exposure
  if (data.isExpiryWeek && data.dte <= 3 && data.delta !== null && Math.abs(data.delta) > 0.4) {
    traps.push({
      trapType: TrapType.GAMMA_REGIME_SHIFT,
      severity: 'medium',
      detail: `expiry week DTE=${data.dte}, delta=${data.delta?.toFixed(2)} — gamma risk elevated`,
      score: 60,
    });
  }

  // 11. FALSE_BREAKOUT — underlying below SMA20 but premium high
  if (data.underlyingSma20 !== null && data.underlyingSpot < data.underlyingSma20 * 0.995 &&
      data.delta !== null && Math.abs(data.delta) > 0.4) {
    traps.push({
      trapType: TrapType.FALSE_BREAKOUT,
      severity: 'medium',
      detail: `underlying ${data.underlyingSpot?.toFixed(0)} below SMA20 ${data.underlyingSma20?.toFixed(0)} — possible false breakout`,
      score: 50,
    });
  }

  // 12. MODEL_DISAGREEMENT — greeks inconsistent
  if (!data.greeksConsistent) {
    traps.push({
      trapType: TrapType.MODEL_DISAGREEMENT,
      severity: 'medium',
      detail: 'greeks consistency check failed',
      score: 50,
    });
  }

  const highSeverity = traps.some(t => t.severity === 'high' || t.severity === 'critical');
  const score = traps.length > 0
    ? Math.min(100, traps.reduce((sum, t) => sum + t.score, 0) / traps.length)
    : 0;

  return {
    traps,
    hasTraps: traps.length > 0,
    highSeverity,
    score,
  };
}
