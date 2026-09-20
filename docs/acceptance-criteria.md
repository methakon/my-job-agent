# Acceptance Criteria — Research/Shadow Validation Gates

> Items 377, 380, 383, 386, 388, 394, 397, 400, 403, 407

## 377 — Every Decision and NO TRADE is Reproducible
Every trading decision (including NO TRADE) must be reproducible from:
- Input data snapshot (point-in-time)
- Regime tag state
- Feature values
- Risk engine state
- Configuration version

**Reproducibility check:** Given the same inputs, the same decision must be produced deterministically. This is verified by replaying decisions from archived data.

## 380 — Every Feature is Point-in-Time, Versioned, and Quality-Monitored
- Features must only use data available at decision time (no look-ahead)
- Feature versions are tracked in experiment records
- Quality scores are computed and stored with each feature vector

## 383 — FADE/FOLLOW/NO-TRADE Gap Logic Passes Current-NSE Tests
Gap engine labels (FADE, FOLLOW, midpoint, fullFill, maximumExtensionPoints, timeToTargetMs) must pass NSE-specific tests:
- Correct classification for gap-up, gap-down, flat open
- Acceptance/rejection logic verified
- Time-to-target computed correctly

**Test file:** scripts/gap-labels.test.js

## 386 — ORB, Pre-Open, OFI/Microprice, VWAP, Profile, and Option-Surface Skills Have Baseline Results
Each skill card must have baseline performance metrics recorded:
- ORB (Opening Range Breakout)
- Pre-open analysis
- OFI/Microprice
- VWAP deviation
- Volume profile
- Option surface (iv-surface.ts, iv-skew-term.ts, vanna-charm.ts)

Baseline results are stored in experiments table with category='skill'.

## 388 — Paper Execution Survivability Under Pessimistic Cost/Latency Tests
Paper execution module must be tested with pessimistic assumptions:
- 2x normal slippage
- 500ms additional latency
- 1.5x normal brokerage
- Worst-case fill rates

**Test verification:** Strategy remains profitable under pessimistic assumptions.

## 394 — Labels are Leakage-Controlled
Labels (trade outcomes) must not contain information unavailable at decision time:
- Entry price determined by decision, not future data
- Exit price determined by exit logic, not future data
- No post-decision feature information in label inputs

**Verification:** Timestamp/leakage test proves no post-decision information entered label computation.

## 397 — Champion/Challenger Evaluation is Walk-Forward and Selection-Aware
- Champion vs challenger comparison uses walk-forward validation
- Multiple-testing exposure is tracked (experiment.entity.ts multipleTestingExposure)
- Selection bias is accounted for in performance estimates

## 400 — Risk Can Veto Every AI Proposal
The independent risk engine must be able to veto any proposal from the AI agent:
- Per-trade limits enforced (independent-risk-engine.ts)
- Aggregate limits enforced
- Kill switch can halt all trading
- LIVE mode unreachable without all gates GREEN

**Test:** Every AI proposal can be blocked by the risk engine.

## 403 — Reflexion Produces Hypotheses, Not Silent Production Changes
Reflexion (self-reflection) module must:
- Generate explicit hypotheses
- Log hypotheses to experiment registry
- NOT modify production behavior silently
- Require human approval or automated gate checks before adoption

## 407 — Shadow Behavior Matches Paper Model Closely Enough to Justify Controlled Micro-Live
Before transitioning from SHADOW to MICRO_LIVE:
- Shadow fill rate must be within 10% of paper fill rate
- Shadow P&L distribution must be statistically similar to paper
- Latency must be comparable
- No critical discrepancies in risk veto counts

**Gate:** MICRO_LIVE transition blocked unless shadow-paper correlation > 0.9
