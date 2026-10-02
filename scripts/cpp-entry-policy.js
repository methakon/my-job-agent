#!/usr/bin/env node
/**
 * PORTED ENTRY POLICY — which contract, when, and why.
 *
 * Logic ported from /home/swarna-sekhar-dhar/projects/cpp-trading-agent
 *   src/trading/upstox-live-paper/upstox-live-paper-entry-policy.ts
 * READ ONLY: nothing in that project was modified.
 *
 * The source's GATE ORDER is carried across faithfully — that ordering is the
 * valuable part, because each gate has a distinct, auditable reason and a
 * refusal records WHY rather than just refusing.
 *
 * ── What is DELIBERATELY different, and why ─────────────────────────────
 * The operator's standing rules for this engine forbid fixed thresholds as
 * vetoes. Four of the source's gates are exactly that, so they are converted
 * from vetoes into SIZING INPUTS. The gate order is preserved; the REFUSAL is
 * not, because a fixed confidence floor or a fixed profit target is precisely
 * what must not gate the loop.
 *
 *   source gate                     ported as
 *   ─────────────────────────────   ──────────────────────────────────────
 *   minConfidence 0.65 veto          → sizeMultiplier; NOT a veto
 *   minRewardRisk 1.5 veto           → expectancyScore label; NOT a veto
 *   targetAtrMultiple 2.5            → a LABEL only, never an exit trigger
 *   expiryDayTimeStop 15:15 veto     → timePressure raises exit urgency only
 *
 *   source gate                     ported unchanged (structural, data-derived)
 *   ─────────────────────────────   ──────────────────────────────────────
 *   liquidity                        → HARD veto (data integrity)
 *   no traded premium                → HARD veto (data integrity)
 *   reversal floor                   → kept as a SETUP-QUALITY signal
 *   no-chase / extension             → HARD veto (structural, not a fixed %)
 *   underlying direction + score     → HARD veto (direction must agree)
 *   option's own momentum            → HARD veto (direction must agree)
 *   structure confirmation           → HARD veto (there must BE a setup)
 *   structural stop before entry     → HARD veto (boundary must exist)
 *
 * The one hard financial invariant remains TOTAL_COMMITTED <= AVAILABLE_CAPITAL.
 */
'use strict';

const F = require('./cpp-features');

const POLICY = {
  version: 'PORTED_ENTRY_POLICY_V1',
  // structural gates kept from the source
  minReversalScoreForSetup: 0.60,
  maxExtensionAtr: 2.0,
  stopAtrBuffer: 0.5,
  minUnderlyingScore: 0.50,
  // converted to sizing inputs, not vetoes
  sourceMinConfidence: 0.65,     // becomes sizeMultiplier
  sourceMinRewardRisk: 1.5,      // becomes an expectancy label
  sourceTargetAtrMultiple: 2.5,  // becomes a label only
  // session window (IST minutes). This is a MARKET window, not a fixed holding
  // time: it says when the exchange is open, nothing more.
  entryWindowStartMinutes: 9 * 60 + 15,
  entryWindowEndMinutes: 15 * 60 + 20,
};

/**
 * Build the structural loss boundary BEFORE entry.
 *
 * Ported exactly: structure level (range high for a long call, range low for a
 * long put) minus an ATR buffer, with a volatility-only fallback when the
 * structure level is unusable. The source treats "stop too wide to size" as a
 * REFUSAL rather than clamping — we keep that, because clamping would be
 * inventing a tighter boundary the market never offered.
 */
function deriveStructuralStop({ side, premium, optionAtr, breakout, consolidation, buffer = POLICY.stopAtrBuffer }) {
  if (!(premium > 0) || optionAtr === null || !Number.isFinite(optionAtr)) {
    return { stop: null, stopPerUnit: null, basis: 'none', refusal: 'no option ATR/stop available — refusing to enter without a structural stop' };
  }
  const b = buffer * optionAtr;
  // NOTE: detectBreakout returns index/classification/atrMultiple, NOT the
  // range level -- that lives on `consolidation`. The source reads
  // `breakout.rangeHigh`, which it never sets, so its structural stop silently
  // ALWAYS fell through to the volatility fallback. Read the level where it
  // actually is, and accept either shape so a caller may pass either.
  const structureLevel = side === 'CE'
    ? (breakout?.rangeHigh ?? consolidation?.rangeHigh ?? null)
    : (breakout?.rangeLow ?? consolidation?.rangeLow ?? null);

  let stop = null;
  let basis = 'none';
  if (structureLevel !== null && Number.isFinite(Number(structureLevel))) {
    stop = side === 'CE' ? Number(structureLevel) - b : Number(structureLevel) + b;
    basis = `structure ${side === 'CE' ? 'range high' : 'range low'} ${Number(structureLevel).toFixed(2)} ∓ ${b.toFixed(2)} (${buffer}×ATR ${optionAtr.toFixed(2)})`;
  }
  if (stop === null || !(side === 'CE' ? stop < premium : stop > premium)) {
    stop = side === 'CE' ? premium - b : premium + b;
    basis = `volatility stop: entry ∓ ${b.toFixed(2)} (${buffer}×ATR ${optionAtr.toFixed(2)})`;
  }

  const stopPerUnit = Math.abs(premium - stop);
  const out = { stop, stopPerUnit, basis };
  if (!(stopPerUnit > 0)) return { ...out, refusal: 'structural stop distance is zero' };
  if (stopPerUnit > premium * 0.5) return { ...out, refusal: `structural stop is ${((stopPerUnit / premium) * 100).toFixed(0)}% away — too wide to size honestly` };
  // A stop inside the noise band is a NOTE, not a refusal, exactly as ported.
  const insideNoiseBand = stopPerUnit < 0.25 * optionAtr;
  return { ...out, insideNoiseBand };
}

/**
 * Evaluate one candidate. Collects EVERY reason rather than short-circuiting,
 * so the journal records why something was refused — that is the behaviour that
 * makes the refusals themselves trainable.
 */
function evaluateEntry({ assessment, premium, optionAtr, lotSize, account, nowIstMinutes = null, policy = {} }) {
  const p = { ...POLICY, ...policy };
  const a = assessment ?? {};
  const refusals = [];
  const notes = [];
  const labels = {};

  // The source maps anything that is not BUY_PE to BUY_CE, which silently turns
  // a NO_TRADE assessment into a long call. That is the highest-risk line in
  // their entry path and it is fixed here: NO_TRADE never becomes a side.
  const signal = String(a.signal ?? 'NO_TRADE').toUpperCase();
  if (signal !== 'BUY_CE' && signal !== 'BUY_PE') {
    refusals.push(`layer-A signal is ${signal} — a NO_TRADE assessment is not a side`);
    return { qualified: false, side: 'NO_TRADE', refusals, notes, labels, stop: null };
  }
  // The source's side vocabulary is BUY_CE / BUY_PE. Keep it exactly: an
  // earlier version stripped the BUY prefix, which silently inverted the
  // direction gate (a long call was then checked against DOWN) and broke the
  // option-momentum rule. Vocabulary is load-bearing here.
  const side = signal;              // 'BUY_CE' | 'BUY_PE'
  const isCall = side === 'BUY_CE';
  const wantDirection = isCall ? 'UP' : 'DOWN';

  // ── 1. liquidity: hard data-integrity gate
  if (!a.liquidity?.ok) {
    refusals.push(`liquidity: ${(a.liquidity?.reasons ?? []).join('; ') || 'quote not acceptable'}`);
  } else {
    notes.push(`liquidity ok (spread ${((a.liquidity.spreadPct ?? 0) * 100).toFixed(2)}%, tick age ${Math.round((a.liquidity.tickAgeMs ?? 0) / 1000)}s)`);
  }
  if (!(premium > 0)) refusals.push('no traded premium on the candidate');

  // ── 2. confidence — SIZING INPUT, not a veto
  const conf = Number(a.confidence ?? 0);
  if (!Number.isFinite(conf)) refusals.push('no confidence measured');
  else if (conf < p.sourceMinConfidence) {
    const sizeMultiplier = Math.max(0.05, conf / p.sourceMinConfidence);
    notes.push(`confidence ${conf.toFixed(4)} < ${p.sourceMinConfidence} — SIZING reduced to ${(sizeMultiplier * 100).toFixed(0)}%, not vetoed`);
    labels.sizeMultiplier = sizeMultiplier;
  } else {
    labels.sizeMultiplier = 1;
    notes.push(`confidence ${conf.toFixed(4)} ≥ ${p.sourceMinConfidence}`);
  }

  // ── 3. reversal setup quality — kept as a structural quality signal
  const isReversalSetup = a.entryState === 'EARLY_REVERSAL';
  const reversalScore = Number(a.reversal?.score ?? 0);
  if (isReversalSetup && reversalScore < p.minReversalScoreForSetup) {
    notes.push(`reversal setup quality ${reversalScore.toFixed(4)} < ${p.minReversalScoreForSetup} — size reduced, not vetoed`);
    labels.sizeMultiplier = Math.min(labels.sizeMultiplier ?? 1, reversalScore / p.minReversalScoreForSetup);
  }

  // ── 4. no-chase: STRUCTURAL, kept as a veto
  if (a.entryState === 'EXTENDED' || a.entryState === 'OVEREXTENDED') {
    refusals.push(`entry state ${a.entryState} — not a fresh entry (${a.entryReason ?? ''})`);
  }
  const extAtr = Number(a.breakout?.atrMultiple);
  if (Number.isFinite(extAtr) && extAtr > p.maxExtensionAtr) {
    refusals.push(`price already ${extAtr.toFixed(2)} ATR past structure (> ${p.maxExtensionAtr}) — chasing`);
  }

  // ── 5. underlying direction must AGREE with the side — kept as a veto
  const u = a.underlying ?? {};
  if (!u.confirmed) refusals.push('underlying direction not confirmed');
  const dir = String(u.direction ?? '').toUpperCase();
  if (dir !== (isCall ? 'BULLISH' : 'BEARISH')) {
    refusals.push(`underlying is ${dir || 'UNKNOWN'} but a ${side} needs ${wantDirection}`);
  }
  const uScore = Number(u.score ?? 0);
  if (uScore < p.minUnderlyingScore) refusals.push(`underlying score ${uScore.toFixed(4)} < ${p.minUnderlyingScore}`);

  // ── 6. the option itself must be moving the right way — kept as a veto
  const ret = a.momentum?.recentReturnPct;
  if (ret === null || ret === undefined) refusals.push('no option momentum measured — direction unconfirmed');
  else if (isCall ? ret <= 0 : ret >= 0) {
    refusals.push(`option direction conflicts (recent return ${(ret * 100).toFixed(2)}% against a long ${side})`);
  }

  // ── 7. structure must exist — kept as a veto
  const structureConfirmed = Boolean(a.breakout?.detected) || reversalScore >= p.minReversalScoreForSetup;
  if (!structureConfirmed) {
    refusals.push(`no structure confirmation (breakout ${a.breakout?.classification ?? 'NONE'}, reversal ${reversalScore.toFixed(4)})`);
  }

  // ── 8. chain confirmation — a LABEL by default, a veto only when required
  const chainScore = Number(a.chain?.score ?? 0);
  labels.chainSupporting = Boolean(a.chain?.supporting);
  if (p.requireChainConfirmation && !(a.chain?.supporting && chainScore >= (p.minChainScore ?? 0.4))) {
    refusals.push(`chain not supporting (score ${chainScore.toFixed(4)})`);
  } else {
    notes.push(`chain ${chainScore.toFixed(4)}${a.chain?.supporting ? ' (supporting)' : ' (neutral)'} — label, not a veto`);
  }

  // ── 9. structural stop BEFORE entry — kept as a hard gate
  const stopSpec = deriveStructuralStop({
    side: isCall ? 'CE' : 'PE', premium, optionAtr,
    breakout: a.breakout, consolidation: a.consolidation,
    buffer: p.stopAtrBuffer,
  });
  if (stopSpec.refusal) refusals.push(stopSpec.refusal);
  if (stopSpec.basis !== 'none') notes.push(`stop: ${stopSpec.basis}`);
  if (stopSpec.insideNoiseBand) {
    notes.push(`stop is only ${stopSpec.stopPerUnit.toFixed(2)} (< 0.25×ATR) — inside the noise band, expect it to be touched`);
  }

  // ── 10. expectancy label ONLY. No fixed profit target, no R:R veto.
  let expectancy = null;
  if (premium > 0 && optionAtr !== null && stopSpec.stopPerUnit) {
    const move = p.sourceTargetAtrMultiple * optionAtr;
    const target = isCall ? premium + move : premium - move;
    const onRewardSide = isCall ? target > premium : target < premium;
    if (onRewardSide) {
      expectancy = Math.abs(target - premium) / stopSpec.stopPerUnit;
      labels.expectedMoveMultiple = p.sourceTargetAtrMultiple;
      notes.push(`expectancy label: ${expectancy.toFixed(2)}R at ${p.sourceTargetAtrMultiple}×ATR (a LABEL, not a target and not a veto)`);
      if (expectancy < p.sourceMinRewardRisk) {
        // Reduced size, not a refusal — a fixed R:R floor is a fixed threshold veto.
        labels.sizeMultiplier = Math.min(labels.sizeMultiplier ?? 1, Math.max(0.05, expectancy / p.sourceMinRewardRisk));
        notes.push(`expectancy ${expectancy.toFixed(2)} < ${p.sourceMinRewardRisk} — sizing reduced accordingly`);
      }
    } else {
      notes.push('expected move did not resolve into a reward direction — no expectancy label');
    }
  }

  // ── 11. affordability: the ONLY hard financial bound
  let lots = 0;
  let committedCapital = 0;
  if (premium > 0 && lotSize > 0 && stopSpec.stopPerUnit > 0) {
    const costPerLot = premium * lotSize;
    const affordable = Math.floor((account?.AVAILABLE_CAPITAL ?? 0) / costPerLot);
    if (affordable < 1) {
      refusals.push(`ONE_LOT_UNAFFORDABLE: one lot costs ₹${costPerLot.toFixed(0)} > AVAILABLE_CAPITAL ₹${(account?.AVAILABLE_CAPITAL ?? 0).toFixed(0)}`);
    } else {
      const mult = labels.sizeMultiplier ?? 1;
      lots = Math.max(1, Math.floor(affordable * Math.min(1, mult)));
      // Never let a size multiplier push the commitment past what is available.
      lots = Math.max(1, Math.min(lots, affordable));
      committedCapital = Number((lots * costPerLot).toFixed(2));
    }
  } else if (!(premium > 0)) {
    // already refused above
  } else {
    refusals.push('cannot size without a lot size and a structural stop');
  }

  // ── 12. session window: when the EXCHANGE is open, not a holding-time rule
  if (Number.isFinite(nowIstMinutes)) {
    if (nowIstMinutes < p.entryWindowStartMinutes) refusals.push(`before the entry window (${p.entryWindowStartMinutes} min)`);
    if (nowIstMinutes > p.entryWindowEndMinutes) refusals.push(`after the entry window (${p.entryWindowEndMinutes} min)`);
  }

  const qualified = refusals.length === 0 && lots >= 1;
  return {
    qualified,
    side: qualified ? side : 'NO_TRADE',
    lots,
    committedCapital,
    stop: qualified ? Number(stopSpec.stop.toFixed(2)) : null,
    stopPerUnit: stopSpec.stopPerUnit ?? null,
    stopBasis: stopSpec.basis,
    expectancyLabel: expectancy,
    sizeMultiplier: labels.sizeMultiplier ?? 1,
    refusals,
    notes,
    labels,
    policyVersion: p.version,
  };
}

module.exports = { POLICY, deriveStructuralStop, evaluateEntry };