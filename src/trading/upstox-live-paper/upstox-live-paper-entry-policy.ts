/**
 * UPSTOX_AUTO_PAPER_ENTRY_V1 — the unattended entry policy for the Upstox
 * Auto Trading PAPER account.
 *
 * AUTHORITY: the operator's GATE 0 / GATE 16 clarifications (2026-09-10) defined
 * this rule set verbatim. It is deliberately INDEPENDENT of the FNF entry rule
 * so the two books can be compared, and it is VERSIONED so every journal row
 * says which rule produced it.
 *
 * ENTRY (as specified)
 *  - maximum 1 lot
 *  - ATM CE/PE only
 *  - one open position at a time
 *  - no averaging down
 *  - fresh valid bid/ask and acceptable liquidity
 *  - underlying + option direction confirmation
 *  - evaluate structure/reversal/breakout, momentum, volume, OI, IV/Greeks,
 *    liquidity and risk/reward
 *  - minimum confidence 0.65
 *  - reversal setups require reversal_score >= 0.60
 *  - minimum reward:risk 1.5
 *  - structural stop defined BEFORE entry
 *  - maximum planned loss 1% of current paper equity
 *  - if the lot cannot satisfy the risk limit with a valid stop → NO TRADE
 *  - do not chase an already extended move
 *
 * POSITION MANAGEMENT (as specified)
 *  - protect initial risk (the stop only ever tightens)
 *  - adaptive trailing based on structure/volatility (2×ATR in this paper test)
 *  - partial profit-taking is available but EXPERIMENTAL and OFF by default
 *  - exit when the setup invalidates or reversal/exhaustion becomes significant
 *  - never widen a stop, never average down
 *
 * HYPOTHESES, NOT PROVEN THRESHOLDS
 * The 2×ATR trail, the 50% partial and the expiry-day time stop come from ONE
 * day (SENSEX 2026-09-10) and are treated as adjustable hypotheses. They are
 * configuration with documented defaults, and nothing here is promoted to real
 * trading on its own.
 *
 * NOTHING PRICE-LEVEL IS HARD-CODED. Every rule reads ratio/ATR-normalised
 * features, so the same policy works on SENSEX, NIFTY or any registered
 * underlying and at any configured capital (₹2,000 / ₹5,000 / ₹10,000). Capital
 * only reaches this file through the risk snapshot, never as a decision input.
 */

import {
  DEFAULT_PATTERN_THRESHOLDS,
  type PatternAssessment,
  type PatternThresholds,
  patternThresholdsFromEnv,
} from '../pattern-engine/pattern-features';
import {
  type PaperRiskSnapshot,
  type PositionSizing,
  entryGuards,
  sizeFromRisk,
} from './paper-risk';
import { SESSION_LAST_ENTRY_MINUTES, SESSION_OPEN_MINUTES } from './upstox-live-paper-instruction.rules';

/** The strategy version stamped on every journal row and trade. */
export const ENTRY_STRATEGY_VERSION = 'UPSTOX_AUTO_PAPER_ENTRY_V1';

/** IST minute-of-day at which an expiry-day position is closed (experimental). */
export const DEFAULT_EXPIRY_DAY_TIME_STOP_MINUTES = 15 * 60 + 15;

export interface EntryPolicyThresholds {
  version: string;
  /** Minimum blended confidence for ANY entry (operator: 0.65). */
  minConfidence: number;
  /** Minimum reversal score when the setup is a reversal (operator: 0.60). */
  minReversalScore: number;
  /** Minimum reward:risk for a fresh entry (operator: 1.5). */
  minRewardRisk: number;
  /** No-chase limit: how far past structure is "already extended" (premium ATRs). */
  maxExtensionAtr: number;
  /** Structural stop = structure ∓ this many option-ATRs. */
  stopAtrBuffer: number;
  /** Target = entry ± this many option-ATRs (market-derived, then R:R is tested). */
  targetAtrMultiple: number;
  /** Adaptive trail distance in option-ATRs — the initial PAPER-TEST policy. */
  trailAtrMultiple: number;
  /** Bars of structure the trail may also respect. */
  trailStructureBars: number;
  /** EXPERIMENTAL: 50% partial at 2×ATR. Off until the paper data supports it. */
  partialEnabled: boolean;
  partialAtAtrMultiple: number;
  partialFraction: number;
  /** EXPERIMENTAL: flat by 15:15 IST on expiry day. Configurable. */
  expiryDayTimeStopEnabled: boolean;
  expiryDayTimeStopMinutes: number;
  entryWindowStartMinutes: number;
  entryWindowEndMinutes: number;
  /** ATM window: 0 = the single nearest strike each side. */
  atmStrikeWindow: number;
  maxLots: number;
  maxOpenPositions: number;
  /** Chain confirmation: scored always, required only when switched on. */
  requireChainConfirmation: boolean;
  minChainScore: number;
  minUnderlyingScore: number;
  /** Liquidity floors, passed through to the shared liquidity check. */
  maxSpreadPct: number;
  minTopDepth: number;
  maxTickAgeMs: number;
}

export const DEFAULT_ENTRY_POLICY_THRESHOLDS: EntryPolicyThresholds = {
  version: ENTRY_STRATEGY_VERSION,
  minConfidence: 0.65,
  minReversalScore: 0.6,
  minRewardRisk: 1.5,
  maxExtensionAtr: 2.0,
  stopAtrBuffer: 0.5,
  targetAtrMultiple: 2.5,
  trailAtrMultiple: 2.0,
  trailStructureBars: 3,
  partialEnabled: false,
  partialAtAtrMultiple: 2.0,
  partialFraction: 0.5,
  expiryDayTimeStopEnabled: true,
  expiryDayTimeStopMinutes: DEFAULT_EXPIRY_DAY_TIME_STOP_MINUTES,
  entryWindowStartMinutes: SESSION_OPEN_MINUTES,
  entryWindowEndMinutes: SESSION_LAST_ENTRY_MINUTES,
  atmStrikeWindow: 0,
  maxLots: 1,
  maxOpenPositions: 1,
  requireChainConfirmation: false,
  minChainScore: 0.4,
  minUnderlyingScore: 0.5,
  maxSpreadPct: DEFAULT_PATTERN_THRESHOLDS.maxSpreadPct,
  minTopDepth: DEFAULT_PATTERN_THRESHOLDS.minTopDepth,
  maxTickAgeMs: DEFAULT_PATTERN_THRESHOLDS.maxTickAgeMs,
};

/**
 * Every threshold is adjustable from the environment so a change to the policy
 * is configuration, never a code edit. The defaults above are the operator's
 * numbers; `UPSTOX_V1_*` overrides are for paper experiments only.
 */
export const entryPolicyThresholdsFromEnv = (
  env: Record<string, string | undefined> = process.env,
): EntryPolicyThresholds => {
  const n = (key: string, fallback: number): number => {
    const v = Number(env[key]);
    return Number.isFinite(v) ? v : fallback;
  };
  const b = (key: string, fallback: boolean): boolean =>
    env[key] === undefined || env[key] === '' ? fallback : !/^(0|false|no|off)$/i.test(String(env[key]));
  return {
    version: ENTRY_STRATEGY_VERSION,
    minConfidence: n('UPSTOX_V1_MIN_CONFIDENCE', DEFAULT_ENTRY_POLICY_THRESHOLDS.minConfidence),
    minReversalScore: n('UPSTOX_V1_MIN_REVERSAL_SCORE', DEFAULT_ENTRY_POLICY_THRESHOLDS.minReversalScore),
    minRewardRisk: n('UPSTOX_V1_MIN_REWARD_RISK', DEFAULT_ENTRY_POLICY_THRESHOLDS.minRewardRisk),
    maxExtensionAtr: n('UPSTOX_V1_MAX_EXTENSION_ATR', DEFAULT_ENTRY_POLICY_THRESHOLDS.maxExtensionAtr),
    stopAtrBuffer: n('UPSTOX_V1_STOP_ATR_BUFFER', DEFAULT_ENTRY_POLICY_THRESHOLDS.stopAtrBuffer),
    targetAtrMultiple: n('UPSTOX_V1_TARGET_ATR_MULTIPLE', DEFAULT_ENTRY_POLICY_THRESHOLDS.targetAtrMultiple),
    trailAtrMultiple: n('UPSTOX_V1_TRAIL_ATR_MULTIPLE', DEFAULT_ENTRY_POLICY_THRESHOLDS.trailAtrMultiple),
    trailStructureBars: Math.max(0, Math.trunc(n('UPSTOX_V1_TRAIL_STRUCTURE_BARS', DEFAULT_ENTRY_POLICY_THRESHOLDS.trailStructureBars))),
    partialEnabled: b('UPSTOX_V1_PARTIAL_ENABLED', DEFAULT_ENTRY_POLICY_THRESHOLDS.partialEnabled),
    partialAtAtrMultiple: n('UPSTOX_V1_PARTIAL_AT_ATR', DEFAULT_ENTRY_POLICY_THRESHOLDS.partialAtAtrMultiple),
    partialFraction: Math.min(0.9, Math.max(0.05, n('UPSTOX_V1_PARTIAL_FRACTION', DEFAULT_ENTRY_POLICY_THRESHOLDS.partialFraction))),
    expiryDayTimeStopEnabled: b('UPSTOX_V1_EXPIRY_DAY_TIME_STOP', DEFAULT_ENTRY_POLICY_THRESHOLDS.expiryDayTimeStopEnabled),
    expiryDayTimeStopMinutes: n('UPSTOX_V1_EXPIRY_DAY_TIME_STOP_MINUTES', DEFAULT_ENTRY_POLICY_THRESHOLDS.expiryDayTimeStopMinutes),
    entryWindowStartMinutes: n('UPSTOX_V1_ENTRY_START_MINUTES', DEFAULT_ENTRY_POLICY_THRESHOLDS.entryWindowStartMinutes),
    entryWindowEndMinutes: n('UPSTOX_V1_ENTRY_END_MINUTES', DEFAULT_ENTRY_POLICY_THRESHOLDS.entryWindowEndMinutes),
    atmStrikeWindow: Math.max(0, Math.trunc(n('UPSTOX_V1_ATM_WINDOW', DEFAULT_ENTRY_POLICY_THRESHOLDS.atmStrikeWindow))),
    maxLots: Math.max(1, Math.trunc(n('UPSTOX_V1_MAX_LOTS', DEFAULT_ENTRY_POLICY_THRESHOLDS.maxLots))),
    maxOpenPositions: Math.max(1, Math.trunc(n('UPSTOX_V1_MAX_POSITIONS', DEFAULT_ENTRY_POLICY_THRESHOLDS.maxOpenPositions))),
    requireChainConfirmation: b('UPSTOX_V1_REQUIRE_CHAIN_CONFIRMATION', DEFAULT_ENTRY_POLICY_THRESHOLDS.requireChainConfirmation),
    minChainScore: n('UPSTOX_V1_MIN_CHAIN_SCORE', DEFAULT_ENTRY_POLICY_THRESHOLDS.minChainScore),
    minUnderlyingScore: n('UPSTOX_V1_MIN_UNDERLYING_SCORE', DEFAULT_ENTRY_POLICY_THRESHOLDS.minUnderlyingScore),
    maxSpreadPct: n('UPSTOX_V1_MAX_SPREAD_PCT', DEFAULT_ENTRY_POLICY_THRESHOLDS.maxSpreadPct),
    minTopDepth: n('UPSTOX_V1_MIN_TOP_DEPTH', DEFAULT_ENTRY_POLICY_THRESHOLDS.minTopDepth),
    maxTickAgeMs: n('UPSTOX_V1_MAX_TICK_AGE_MS', DEFAULT_ENTRY_POLICY_THRESHOLDS.maxTickAgeMs),
  };
};

/** Pattern thresholds aligned to the V1 liquidity floors (single source). */
export const patternThresholdsForEntryPolicy = (
  entry: EntryPolicyThresholds,
  env: Record<string, string | undefined> = process.env,
): PatternThresholds => ({
  ...patternThresholdsFromEnv(env),
  maxSpreadPct: entry.maxSpreadPct,
  minTopDepth: entry.minTopDepth,
  maxTickAgeMs: entry.maxTickAgeMs,
});

export interface EntryScores {
  confidence: number;
  consolidation: number;
  reversal: number;
  breakout: number;
  momentum: number;
  volume: number;
  oi: number;
  iv: number;
  underlying: number;
  liquidity: number;
  chain: number;
  extensionPenalty: number;
  unconfirmedPenalty: number;
}

export interface EntryEvaluationInput {
  /** Shared feature-engine assessment — the same scores the engine records. */
  assessment: PatternAssessment;
  /** Option premium ATR (points) from the engine's own bar series. */
  optionAtr: number | null;
  /** Live premium and book. */
  premium: number;
  bid: number | null;
  ask: number | null;
  lotSize: number;
  /** The account's risk envelope (capital + limits). Sizing only. */
  risk: PaperRiskSnapshot;
  thresholds?: Partial<EntryPolicyThresholds>;
  /** IST minute-of-day, when the caller knows the clock. */
  nowIstMinutes?: number | null;
  /** Is the contract's expiry today? Enables the expiry-day time stop. */
  expiryIsToday?: boolean;
  /** Contract already open (averaging-down guard). */
  openSameContract?: string | null;
  requestedLots?: number | null;
}

export interface EntryDecision {
  version: string;
  qualified: boolean;
  side: 'BUY_CE' | 'BUY_PE' | 'NO_TRADE';
  entryState: string;
  patternType: string;
  confidence: number;
  reversalScore: number;
  scores: EntryScores;
  /** Structural stop, defined BEFORE entry. */
  stop: number | null;
  stopPerUnit: number | null;
  stopSource: string;
  /** Market-derived target, then tested against the R:R floor. */
  target: number | null;
  rewardRisk: number | null;
  extensionAtr: number | null;
  /** Position sizing result (null when the policy refused before sizing). */
  sizing: PositionSizing | null;
  risk: {
    policyVersion: string;
    mode: string;
    configuredCapital: number;
    equity: number;
    riskBase: number;
    maxRiskPerTrade: number;
    maxRiskPerTradePct: number;
    plannedRisk: number | null;
    plannedRiskPct: number | null;
    maxOpenPositions: number;
    maxLotsPerPosition: number;
  };
  /** Hard blocks — any refusal means NO TRADE. */
  refusals: string[];
  /** Observational detail, recorded for every candidate. */
  notes: string[];
  thresholds: EntryPolicyThresholds;
  /** Exit plan the trade will be managed with (a hypothesis, not a promise). */
  management: {
    trailAtrMultiple: number;
    trailStructureBars: number;
    partialEnabled: boolean;
    partialAtAtrMultiple: number;
    partialFraction: number;
    expiryDayTimeStopEnabled: boolean;
    expiryDayTimeStopMinutes: number;
  };
}

const fmt = (v: number | null | undefined, digits = 2): string =>
  v === null || v === undefined || !Number.isFinite(Number(v)) ? 'n/a' : Number(v).toFixed(digits);

/**
 * Evaluate one candidate under V1. Pure: no DB, no clock, no network. Every
 * refusal is collected (not short-circuited) because the journal must record
 * WHY a NO-TRADE candidate failed, per the operator's learning rule.
 */
export const evaluateEntryV1 = (input: EntryEvaluationInput): EntryDecision => {
  const thresholds = { ...DEFAULT_ENTRY_POLICY_THRESHOLDS, ...(input.thresholds ?? {}) };
  const a = input.assessment;
  const refusals: string[] = [];
  const notes: string[] = [];

  const side: 'BUY_CE' | 'BUY_PE' = a.signal === 'BUY_PE' ? 'BUY_PE' : 'BUY_CE';
  const wantDirection = side === 'BUY_CE' ? 'UP' : 'DOWN';
  const premium = Number(input.premium);
  const optionAtr = Number.isFinite(Number(input.optionAtr)) && Number(input.optionAtr) > 0 ? Number(input.optionAtr) : null;

  const scores: EntryScores = {
    confidence: a.confidence,
    consolidation: a.components.consolidation,
    reversal: a.reversal.score,
    breakout: a.components.breakout,
    momentum: a.components.momentum,
    volume: a.components.volume,
    oi: a.components.oi,
    iv: a.components.iv,
    underlying: a.components.underlying,
    liquidity: a.components.liquidity,
    chain: a.components.chain,
    extensionPenalty: a.penalties.extension,
    unconfirmedPenalty: a.penalties.unconfirmed,
  };

  // ── 1. liquidity: fresh, two-sided, tight enough, deep enough ─────────────
  if (!a.liquidity.ok) {
    refusals.push(`liquidity: ${a.liquidity.reasons.join('; ') || 'quote not acceptable'}`);
  } else {
    notes.push(`liquidity ok (spread ${fmt((a.liquidity.spreadPct ?? 0) * 100)}%, tick age ${Math.round((a.liquidity.tickAgeMs ?? 0) / 1000)}s)`);
  }
  if (!(premium > 0)) refusals.push('no traded premium on the candidate');

  // ── 2. confidence floor (operator: 0.65; do not lower it to make trades) ──
  if (a.confidence < thresholds.minConfidence) {
    refusals.push(`confidence ${fmt(a.confidence, 4)} < ${thresholds.minConfidence}`);
  } else {
    notes.push(`confidence ${fmt(a.confidence, 4)} ≥ ${thresholds.minConfidence}`);
  }

  // ── 3. reversal setups need 0.60 on their own score ──────────────────────
  const isReversalSetup = a.entryState === 'EARLY_REVERSAL';
  if (isReversalSetup && a.reversal.score < thresholds.minReversalScore) {
    refusals.push(`reversal setup with reversal score ${fmt(a.reversal.score, 4)} < ${thresholds.minReversalScore}`);
  } else if (isReversalSetup) {
    notes.push(`reversal ${fmt(a.reversal.score, 4)} ≥ ${thresholds.minReversalScore}`);
  }

  // ── 4. no chase: refuse an already extended move ─────────────────────────
  const extensionAtr = Number.isFinite(Number(a.breakout.atrMultiple)) ? Number(a.breakout.atrMultiple) : null;
  if (a.entryState === 'EXTENDED' || a.entryState === 'OVEREXTENDED') {
    refusals.push(`entry state ${a.entryState} — not a fresh entry (${a.reason})`);
  }
  if (extensionAtr !== null && extensionAtr > thresholds.maxExtensionAtr) {
    refusals.push(`price already ${fmt(extensionAtr)} ATR past structure (> ${thresholds.maxExtensionAtr}) — chasing`);
  }

  // ── 5. underlying direction confirmation ─────────────────────────────────
  const u = a.underlying;
  if (!u.confirmed) refusals.push('underlying direction not confirmed');
  if (String(u.direction).toUpperCase() !== wantDirection) {
    refusals.push(`underlying is ${u.direction} but a ${side === 'BUY_CE' ? 'CE' : 'PE'} needs ${wantDirection}`);
  }
  if (u.score < thresholds.minUnderlyingScore) {
    refusals.push(`underlying score ${fmt(u.score, 4)} < ${thresholds.minUnderlyingScore}`);
  }

  // ── 6. option direction confirmation (the option itself must be moving) ──
  const optionReturnPct = a.momentum.returnPct;
  if (optionReturnPct === null) {
    refusals.push('no option momentum measured — direction unconfirmed');
  } else if (side === 'BUY_CE' ? optionReturnPct <= 0 : optionReturnPct >= 0) {
    refusals.push(`option direction conflicts (recent return ${fmt(optionReturnPct * 100)}% against a ${side === 'BUY_CE' ? 'long CE' : 'long PE'})`);
  }

  // ── 7. structure/breakout confirmation ───────────────────────────────────
  const structureConfirmed = a.breakout.detected || a.reversal.score >= thresholds.minReversalScore;
  if (!structureConfirmed) {
    refusals.push(`no structure confirmation (breakout ${a.breakout.classification}, reversal ${fmt(a.reversal.score, 4)})`);
  }

  // ── 8. chain confirmation (scored always; a veto only when switched on) ──
  if (thresholds.requireChainConfirmation && (!a.chain.supporting || a.chain.score < thresholds.minChainScore)) {
    refusals.push(`chain not supporting (score ${fmt(a.chain.score, 4)}, supporting=${a.chain.supporting})`);
  } else {
    notes.push(`chain ${fmt(a.chain.score, 4)}${a.chain.supporting ? ' (supporting)' : ' (neutral)'}${thresholds.requireChainConfirmation ? '' : ' — not a veto in V1'}`);
  }

  // ── 9. structural stop, defined BEFORE entry ─────────────────────────────
  let stop: number | null = null;
  let stopPerUnit: number | null = null;
  let stopSource = 'none';
  if (premium > 0 && optionAtr !== null) {
    const structureLevel = side === 'BUY_CE'
      ? (a.breakout.rangeHigh ?? a.consolidation.rangeHigh ?? null)
      : (a.breakout.rangeLow ?? a.consolidation.rangeLow ?? null);
    const buffer = thresholds.stopAtrBuffer * optionAtr;
    if (structureLevel !== null && Number.isFinite(Number(structureLevel))) {
      stop = side === 'BUY_CE' ? Number(structureLevel) - buffer : Number(structureLevel) + buffer;
      stopSource = `structure ${side === 'BUY_CE' ? 'range high' : 'range low'} ${fmt(Number(structureLevel))} ∓ ${fmt(buffer)} (${thresholds.stopAtrBuffer}×ATR ${fmt(optionAtr)})`;
    }
    // A structure level that leaves no room below/above entry is unusable: fall
    // back to a pure volatility stop rather than inventing a tighter level.
    if (stop === null || !(side === 'BUY_CE' ? stop < premium : stop > premium)) {
      stop = side === 'BUY_CE' ? premium - buffer : premium + buffer;
      stopSource = `volatility stop: entry ∓ ${fmt(buffer)} (${thresholds.stopAtrBuffer}×ATR ${fmt(optionAtr)})`;
    }
    stopPerUnit = Math.abs(premium - stop);
    if (!(stopPerUnit > 0)) {
      refusals.push('structural stop distance is zero');
      stopPerUnit = null;
    } else if (stopPerUnit > premium * 0.5) {
      refusals.push(`structural stop is ${fmt((stopPerUnit / premium) * 100)}% away — too wide to size inside the risk limit`);
    }
    // A stop tighter than a quarter ATR is inside the noise band.
    if (stopPerUnit !== null && stopPerUnit < 0.25 * optionAtr) {
      notes.push(`stop is only ${fmt(stopPerUnit)} (< 0.25×ATR ${fmt(optionAtr)}) — inside the noise band, expect to be touched`);
    }
  } else {
    refusals.push('no option ATR/stop available — V1 refuses to enter without a structural stop');
  }

  // ── 10. market-derived target, then the R:R floor ────────────────────────
  let target: number | null = null;
  let rr: number | null = null;
  if (premium > 0 && optionAtr !== null && stopPerUnit !== null) {
    const move = thresholds.targetAtrMultiple * optionAtr;
    target = side === 'BUY_CE' ? premium + move : premium - move;
    if (target !== null && (side === 'BUY_CE' ? target > premium : target < premium)) {
      rr = (Math.abs(target - premium)) / stopPerUnit;
      if (rr < thresholds.minRewardRisk) {
        refusals.push(`reward:risk ${fmt(rr)} < ${thresholds.minRewardRisk} (target ${fmt(target)} = ${thresholds.targetAtrMultiple}×ATR vs stop ${fmt(stopPerUnit)})`);
      } else {
        notes.push(`reward:risk ${fmt(rr)} ≥ ${thresholds.minRewardRisk}`);
      }
    } else {
      refusals.push('target did not resolve into a reward direction');
      target = null;
    }
  }

  // ── 11. size from RISK (max 1 lot, 1% of equity, never force a fit) ──────
  let sizing: PositionSizing | null = null;
  if (premium > 0 && stopPerUnit !== null && Number(input.lotSize) > 0) {
    sizing = sizeFromRisk({
      snapshot: input.risk,
      premium,
      lotSize: input.lotSize,
      stopPerUnit,
      requestedLots: input.requestedLots ?? thresholds.maxLots,
    });
    if (!sizing.allowed) {
      refusals.push(...sizing.refusals);
    } else {
      notes.push(`size ${sizing.lots} lot(s) × ${sizing.lotSize} — planned risk ₹${fmt(sizing.plannedRisk)} (${fmt(sizing.plannedRiskPct)}% of ₹${fmt(input.risk.riskBase)})`);
    }
  }

  // ── 12. account guards: 1 position, no averaging down ────────────────────
  if (sizing && sizing.allowed) {
    const guards = entryGuards({
      snapshot: input.risk,
      openSameContract: input.openSameContract ?? null,
      side: 'BUY',
      outlay: sizing.outlay,
    });
    if (!guards.allowed) refusals.push(...guards.refusals);
  } else {
    const guards = entryGuards({
      snapshot: { ...input.risk, deployable: Number.MAX_SAFE_INTEGER },
      openSameContract: input.openSameContract ?? null,
      side: 'BUY',
      outlay: 0,
    });
    if (!guards.allowed) refusals.push(...guards.refusals);
  }

  // ── 13. session timing: monitoring window + expiry-day time stop ─────────
  const minutes = Number(input.nowIstMinutes);
  if (Number.isFinite(minutes)) {
    if (minutes < thresholds.entryWindowStartMinutes || minutes > thresholds.entryWindowEndMinutes) {
      refusals.push(`outside the entry window (${Math.floor(thresholds.entryWindowStartMinutes / 60)}:${String(thresholds.entryWindowStartMinutes % 60).padStart(2, '0')}–${Math.floor(thresholds.entryWindowEndMinutes / 60)}:${String(thresholds.entryWindowEndMinutes % 60).padStart(2, '0')} IST)`);
    }
    if (input.expiryIsToday && thresholds.expiryDayTimeStopEnabled && minutes >= thresholds.expiryDayTimeStopMinutes) {
      refusals.push(`expiry-day time stop (${Math.floor(thresholds.expiryDayTimeStopMinutes / 60)}:${String(thresholds.expiryDayTimeStopMinutes % 60).padStart(2, '0')} IST) — no fresh entry`);
    }
  } else {
    notes.push('session clock unavailable — timing rules not evaluated');
  }

  const qualified = refusals.length === 0 && Boolean(sizing?.allowed);
  return {
    version: ENTRY_STRATEGY_VERSION,
    qualified,
    side: qualified ? side : 'NO_TRADE',
    entryState: a.entryState,
    patternType: a.patternType,
    confidence: a.confidence,
    reversalScore: a.reversal.score,
    scores,
    stop: qualified ? stop : null,
    stopPerUnit,
    stopSource,
    target,
    rewardRisk: rr,
    extensionAtr,
    sizing,
    risk: {
      policyVersion: input.risk.version,
      mode: input.risk.mode,
      configuredCapital: input.risk.configuredCapital,
      equity: input.risk.equity,
      riskBase: input.risk.riskBase,
      maxRiskPerTrade: input.risk.maxRiskPerTrade,
      maxRiskPerTradePct: input.risk.maxRiskPerTradePct,
      plannedRisk: sizing && sizing.allowed ? sizing.plannedRisk : null,
      plannedRiskPct: sizing && sizing.allowed ? sizing.plannedRiskPct : null,
      maxOpenPositions: input.risk.maxOpenPositions,
      maxLotsPerPosition: input.risk.maxLotsPerPosition,
    },
    refusals,
    notes,
    thresholds,
    management: {
      trailAtrMultiple: thresholds.trailAtrMultiple,
      trailStructureBars: thresholds.trailStructureBars,
      partialEnabled: thresholds.partialEnabled,
      partialAtAtrMultiple: thresholds.partialAtAtrMultiple,
      partialFraction: thresholds.partialFraction,
      expiryDayTimeStopEnabled: thresholds.expiryDayTimeStopEnabled,
      expiryDayTimeStopMinutes: thresholds.expiryDayTimeStopMinutes,
    },
  };
};

// ─────────────────────────── position management ───────────────────────────

export type ExitReason =
  | 'STRUCTURAL_STOP'
  | 'TRAIL_2X_ATR'
  | 'SETUP_INVALIDATED'
  | 'REVERSAL_EXHAUSTION'
  | 'TIME_STOP'
  | 'TARGET_TRAILED';

export interface ExitEvaluationInput {
  entryPrice: number;
  /** The stop defined at entry — it may only ever tighten. */
  initialStop: number;
  target: number | null;
  ltp: number;
  /** Best price seen since entry (highest for a long). */
  highestLtp: number | null;
  optionAtr: number | null;
  /** Lowest premium the trade has seen (for the MAE side of the journal). */
  lowestLtp?: number | null;
  barsHeld: number;
  nowIstMinutes?: number | null;
  expiryIsToday?: boolean;
  /** The pattern that justified entry no longer holds. */
  setupInvalidated?: boolean;
  /** Reversal score measured AGAINST the position, if the caller measured one. */
  adverseReversalScore?: number | null;
  thresholds?: Partial<EntryPolicyThresholds>;
}

export interface ExitDecision {
  version: string;
  exit: boolean;
  reason: ExitReason | null;
  /** The stop to carry forward — never wider than the initial stop. */
  stop: number;
  stopWidened: boolean;
  /** EXPERIMENTAL partial-profit booking (only when enabled). */
  partial: { shouldBook: boolean; fraction: number; triggerPrice: number } | null;
  notes: string[];
}

/**
 * Manage one open V1 position. The stop only ever tightens: the adaptive trail
 * is max(initial stop, best price − trail×ATR), so an adverse move can never
 * widen risk, and "protect initial risk" is structural rather than a promise.
 */
export const evaluateExitV1 = (input: ExitEvaluationInput): ExitDecision => {
  const thresholds = { ...DEFAULT_ENTRY_POLICY_THRESHOLDS, ...(input.thresholds ?? {}) };
  const notes: string[] = [];
  const entry = Number(input.entryPrice);
  const initialStop = Number(input.initialStop);
  const ltp = Number(input.ltp);
  const atr = Number.isFinite(Number(input.optionAtr)) && Number(input.optionAtr) > 0 ? Number(input.optionAtr) : null;
  const highest = Number.isFinite(Number(input.highestLtp)) ? Number(input.highestLtp) : ltp;

  let stop = Number.isFinite(initialStop) && initialStop > 0 ? initialStop : entry;
  if (atr !== null) {
    const trailed = highest - thresholds.trailAtrMultiple * atr;
    if (trailed > stop) {
      notes.push(`trail raised stop to ${fmt(trailed)} (${thresholds.trailAtrMultiple}×ATR ${fmt(atr)} below best ${fmt(highest)})`);
      stop = trailed;
    }
  }
  const stopWidened = stop < initialStop;
  if (stopWidened) stop = initialStop; // defensive: never widen

  // Target: in V1 a reached target is trailed, not force-exited, so the winner
  // can keep running under the adaptive stop ("good profit capture").
  if (input.target !== null && Number.isFinite(Number(input.target)) && ltp >= Number(input.target)) {
    notes.push(`target ${fmt(input.target)} reached — trailing the remainder rather than exiting at the level`);
  }

  const partialTrigger = entry + thresholds.partialAtAtrMultiple * (atr ?? 0);
  const partial = {
    shouldBook: thresholds.partialEnabled && atr !== null && ltp >= partialTrigger,
    fraction: thresholds.partialFraction,
    triggerPrice: partialTrigger,
  };

  const decide = (reason: ExitReason): ExitDecision => ({ version: ENTRY_STRATEGY_VERSION, exit: true, reason, stop, stopWidened, partial: thresholds.partialEnabled ? partial : null, notes });

  if (ltp <= stop) return decide(stop > initialStop ? 'TRAIL_2X_ATR' : 'STRUCTURAL_STOP');
  if (input.setupInvalidated) return decide('SETUP_INVALIDATED');

  const adverse = Number(input.adverseReversalScore);
  if (Number.isFinite(adverse) && adverse >= thresholds.minReversalScore) {
    notes.push(`adverse reversal score ${fmt(adverse, 4)} ≥ ${thresholds.minReversalScore}`);
    return decide('REVERSAL_EXHAUSTION');
  }

  if (input.expiryIsToday && thresholds.expiryDayTimeStopEnabled && Number.isFinite(Number(input.nowIstMinutes)) && Number(input.nowIstMinutes) >= thresholds.expiryDayTimeStopMinutes) {
    notes.push(`expiry-day time stop reached (${Math.floor(thresholds.expiryDayTimeStopMinutes / 60)}:${String(thresholds.expiryDayTimeStopMinutes % 60).padStart(2, '0')} IST)`);
    return decide('TIME_STOP');
  }

  return { version: ENTRY_STRATEGY_VERSION, exit: false, reason: null, stop, stopWidened, partial: thresholds.partialEnabled ? partial : null, notes };
};

// ───────────────────────── ATM universe selection ──────────────────────────

export interface AtmCandidateLeg {
  contractSymbol: string;
  optionType: 'CE' | 'PE';
  strike: number;
  expiry: string;
  ltp: number;
  bid: number | null;
  ask: number | null;
  oi?: number | null;
  volume?: number | null;
}

export interface AtmUniverse {
  atmStrike: number | null;
  spot: number | null;
  ce: AtmCandidateLeg[];
  pe: AtmCandidateLeg[];
  considered: number;
  window: number;
}

/**
 * The eligible ATM universe: the strikes nearest spot, per side, from the
 * broker's own contract master (lot sizes and expiries come from the desk, not
 * from here). Window 0 = the single nearest strike each side.
 */
export const buildAtmUniverse = (input: {
  legs: readonly AtmCandidateLeg[];
  spot: number | null;
  window?: number;
}): AtmUniverse => {
  const window = Math.max(0, Math.trunc(input.window ?? 0));
  const spot = Number(input.spot);
  if (!Number.isFinite(spot) || spot <= 0 || !input.legs.length) {
    return { atmStrike: null, spot: Number.isFinite(spot) ? spot : null, ce: [], pe: [], considered: input.legs.length, window };
  }
  const strikes = [...new Set(input.legs.map((l) => Number(l.strike)).filter((s) => Number.isFinite(s)))].sort((a, b) => a - b);
  if (!strikes.length) return { atmStrike: null, spot, ce: [], pe: [], considered: input.legs.length, window };

  const atmStrike = strikes.reduce((best, s) => (Math.abs(s - spot) < Math.abs(best - spot) ? s : best), strikes[0]);
  const atmIndex = strikes.indexOf(atmStrike);
  const lo = Math.max(0, atmIndex - window);
  const hi = Math.min(strikes.length - 1, atmIndex + window);
  const allowed = new Set(strikes.slice(lo, hi + 1));

  const within = input.legs.filter((l) => allowed.has(Number(l.strike)) && Number(l.ltp) > 0);
  return {
    atmStrike,
    spot,
    ce: within.filter((l) => l.optionType === 'CE').sort((a, b) => Number(b.ltp) - Number(a.ltp)),
    pe: within.filter((l) => l.optionType === 'PE').sort((a, b) => Number(b.ltp) - Number(a.ltp)),
    considered: input.legs.length,
    window,
  };
};

/** Operator-facing description of the live V1 policy (version + thresholds). */
export const describeEntryPolicy = (thresholds: EntryPolicyThresholds = DEFAULT_ENTRY_POLICY_THRESHOLDS): Record<string, unknown> => ({
  version: thresholds.version,
  entry: {
    minConfidence: thresholds.minConfidence,
    minReversalScore: thresholds.minReversalScore,
    minRewardRisk: thresholds.minRewardRisk,
    maxExtensionAtr: thresholds.maxExtensionAtr,
    stopAtrBuffer: thresholds.stopAtrBuffer,
    targetAtrMultiple: thresholds.targetAtrMultiple,
    atmStrikeWindow: thresholds.atmStrikeWindow,
    maxLots: thresholds.maxLots,
    maxOpenPositions: thresholds.maxOpenPositions,
    entryWindowIst: `${Math.floor(thresholds.entryWindowStartMinutes / 60)}:${String(thresholds.entryWindowStartMinutes % 60).padStart(2, '0')}–${Math.floor(thresholds.entryWindowEndMinutes / 60)}:${String(thresholds.entryWindowEndMinutes % 60).padStart(2, '0')}`,
    noAveragingDown: true,
  },
  management: {
    trailAtrMultiple: thresholds.trailAtrMultiple,
    trailStructureBars: thresholds.trailStructureBars,
    'partial (experimental)': { enabled: thresholds.partialEnabled, atAtrMultiple: thresholds.partialAtAtrMultiple, fraction: thresholds.partialFraction },
    'expiry-day time stop (experimental, configurable)': { enabled: thresholds.expiryDayTimeStopEnabled, atIst: `${Math.floor(thresholds.expiryDayTimeStopMinutes / 60)}:${String(thresholds.expiryDayTimeStopMinutes % 60).padStart(2, '0')}` },
  },
  provenance: 'hypotheses from SENSEX 2026-09-10 — adjustable, NOT proven optima',
});
