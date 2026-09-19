/**
 * Gap Database — historical gap tracking, MAE/MFE metrics, and gap closer evaluation.
 *
 * Pure functions for analyzing gap history quality and effectiveness.
 * No DB/IO. Deterministic: same inputs → same outputs.
 */

// ── Types ───────────────────────────────────────────────────────────────────

export interface GapRecord {
  symbol: string;
  tradeDate: string;
  preClose: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  gapPct: number;
  gapDirection: 'UP' | 'DOWN' | 'FLAT';
  maxFavorableExtensionPct: number;
  maxAdverseExtensionPct: number;
  timeToTargetMs: number;
  filled: boolean;
  fillTimeMs: number;
  classification: 'FADE' | 'FOLLOW' | 'CONTINUATION' | 'REVERSAL';
}

export interface GapDatabaseConfig {
  minGapPct: number;
  lookbackDays: number;
  fadeDetectionWindowMs: number;
}

export interface GapStats {
  totalGaps: number;
  fadeCount: number;
  followCount: number;
  continuationCount: number;
  reversalCount: number;
  avgMfePct: number;
  avgMaePct: number;
  avgTimeToTargetMs: number;
  fillRate: number;
  fadeSuccessRate: number;
}

export interface GapCloserEval {
  isCloser: boolean;
  gapPct: number;
  closerMagnitude: number;
  closerDirection: 'UP' | 'DOWN' | 'NONE';
  evidence: string;
}

// ── Gap Classification ──────────────────────────────────────────────────────

export function classifyGap(
  gapPct: number,
  maxFavorablePct: number,
  maxAdversePct: number,
  filled: boolean,
): GapRecord['classification'] {
  if (Math.abs(gapPct) < 0.1) return 'CONTINUATION';

  const isGapUp = gapPct > 0;

  // FADE: price moves against gap direction
  if (isGapUp && maxAdversePct > maxFavorablePct) return 'FADE';
  if (!isGapUp && maxFavorablePct > maxAdversePct) return 'FADE';

  // FOLLOW: price moves with gap direction
  if (isGapUp && maxFavorablePct > maxAdversePct) return 'FOLLOW';
  if (!isGapUp && maxAdversePct > maxFavorablePct) return 'FOLLOW';

  return 'CONTINUATION';
}

// ── Gap Statistics ───────────────────────────────────────────────────────────

export function computeGapStats(
  gaps: GapRecord[],
): GapStats {
  if (gaps.length === 0) {
    return {
      totalGaps: 0,
      fadeCount: 0,
      followCount: 0,
      continuationCount: 0,
      reversalCount: 0,
      avgMfePct: 0,
      avgMaePct: 0,
      avgTimeToTargetMs: 0,
      fillRate: 0,
      fadeSuccessRate: 0,
    };
  }

  const fadeCount = gaps.filter((g) => g.classification === 'FADE').length;
  const followCount = gaps.filter((g) => g.classification === 'FOLLOW').length;
  const continuationCount = gaps.filter((g) => g.classification === 'CONTINUATION').length;
  const reversalCount = gaps.filter((g) => g.classification === 'REVERSAL').length;

  const avgMfePct = gaps.reduce((s, g) => s + g.maxFavorableExtensionPct, 0) / gaps.length;
  const avgMaePct = gaps.reduce((s, g) => s + g.maxAdverseExtensionPct, 0) / gaps.length;
  const avgTimeToTargetMs = gaps.reduce((s, g) => s + g.timeToTargetMs, 0) / gaps.length;
  const fillRate = gaps.filter((g) => g.filled).length / gaps.length;

  // FADE success rate: FADEs that actually reversed
  const fadeGaps = gaps.filter((g) => g.classification === 'FADE');
  const fadeSuccessRate = fadeGaps.length > 0
    ? fadeGaps.filter((g) => g.classification === 'FADE' && g.filled).length / fadeGaps.length
    : 0;

  return {
    totalGaps: gaps.length,
    fadeCount,
    followCount,
    continuationCount,
    reversalCount,
    avgMfePct,
    avgMaePct,
    avgTimeToTargetMs,
    fillRate,
    fadeSuccessRate,
  };
}

// ── Gap Closer Detection ────────────────────────────────────────────────────

export function detectGapCloser(
  currentGap: GapRecord,
  historicalGaps: GapRecord[],
  windowDays: number = 5,
): GapCloserEval {
  // A gap closer is a gap that reverses a previous unfilled gap
  const recentGaps = historicalGaps
    .filter((g) => g.symbol === currentGap.symbol)
    .sort((a, b) => a.tradeDate.localeCompare(b.tradeDate))
    .slice(-windowDays);

  const unfilledGaps = recentGaps.filter((g) => !g.filled);

  if (unfilledGaps.length === 0) {
    return {
      isCloser: false,
      gapPct: currentGap.gapPct,
      closerMagnitude: 0,
      closerDirection: 'NONE',
      evidence: 'no unfilled gaps in lookback window',
    };
  }

  // Check if current gap is in the opposite direction of unfilled gaps
  const isGapUp = currentGap.gapPct > 0;
  const opposingGaps = unfilledGaps.filter((g) =>
    isGapUp ? g.gapPct < 0 : g.gapPct > 0,
  );

  if (opposingGaps.length === 0) {
    return {
      isCloser: false,
      gapPct: currentGap.gapPct,
      closerMagnitude: 0,
      closerDirection: 'NONE',
      evidence: 'no opposing unfilled gaps',
    };
  }

  // Compute closer magnitude as max opposing gap magnitude
  const maxOpposingPct = Math.max(...opposingGaps.map((g) => Math.abs(g.gapPct)));

  return {
    isCloser: true,
    gapPct: currentGap.gapPct,
    closerMagnitude: maxOpposingPct,
    closerDirection: isGapUp ? 'UP' : 'DOWN',
    evidence: `${opposingGaps.length} opposing unfilled gap(s) in last ${windowDays} days`,
  };
}

// ── Gap Range Position Evaluation ────────────────────────────────────────────

export interface GapRangeInput {
  preClose: number;
  open: number;
  high: number;
  low: number;
  currentPrice: number;
}

export interface GapRangeResult {
  position: 'PRE_CLOSE' | 'OPEN_SIDE' | 'MIDPOINT' | 'BREACH';
  distanceToMidPct: number;
  insideGap: boolean;
  gapFilled: boolean;
}

export function evaluateGapRangePosition(input: GapRangeInput): GapRangeResult {
  const { preClose, open, high, low, currentPrice } = input;

  const midPoint = (preClose + open) / 2;
  const gapHigh = Math.max(preClose, open);
  const gapLow = Math.min(preClose, open);

  const distanceToMidPct = Math.abs(currentPrice - midPoint) / midPoint * 100;
  const insideGap = currentPrice >= gapLow && currentPrice <= gapHigh;
  const gapFilled = currentPrice >= gapLow && currentPrice <= gapHigh;

  let position: GapRangeResult['position'];

  if (insideGap) {
    if (Math.abs(currentPrice - midPoint) / midPoint * 100 < 0.05) {
      position = 'MIDPOINT';
    } else if (currentPrice > midPoint) {
      position = 'OPEN_SIDE';
    } else {
      position = 'PRE_CLOSE';
    }
  } else {
    position = 'BREACH';
  }

  return {
    position,
    distanceToMidPct,
    insideGap,
    gapFilled,
  };
}

// ── Gap Acceptance Evaluation ────────────────────────────────────────────────

export interface GapAcceptanceInput {
  gaps: GapRecord[];
  windowDays: number;
}

export interface GapAcceptanceResult {
  accepted: boolean;
  acceptanceCount: number;
  totalGaps: number;
  acceptanceRate: number;
  reason: string;
}

export function evaluateGapAcceptance(input: GapAcceptanceInput): GapAcceptanceResult {
  const { gaps, windowDays } = input;

  if (gaps.length === 0) {
    return {
      accepted: false,
      acceptanceCount: 0,
      totalGaps: 0,
      acceptanceRate: 0,
      reason: 'no gaps in evaluation window',
    };
  }

  const acceptanceCount = gaps.filter((g) => g.filled).length;
  const acceptanceRate = acceptanceCount / gaps.length;

  return {
    accepted: acceptanceRate >= 0.5,
    acceptanceCount,
    totalGaps: gaps.length,
    acceptanceRate,
    reason: `${acceptanceCount}/${gaps.length} gaps filled (${(acceptanceRate * 100).toFixed(1)}%)`,
  };
}
