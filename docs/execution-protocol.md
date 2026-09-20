# Execution Protocol — Shadow-to-Micro-Live Transition

> Items 345, 351, 353, 356, 359, 362

## 351 — Complete Live-Data Shadow Decisions with Orders Disabled
Shadow mode runs the full decision pipeline using live market data but places no real orders. Every signal, risk check, and regime classification is executed end-to-end.

**Protocol:**
1. Consume live market feed (unified-market-data module)
2. Compute regime tags via regime-tags.ts
3. Run skill cards and pattern engine
4. Compute gap state and hypotheses
5. Evaluate independent-risk-engine safety checks
6. Record decision and outcome in shadow log
7. NO order placement — all fills are simulated

## 353 — Compare Intended Fills Against Subsequent Real Quotes
After shadow mode records an intended fill, the system compares the intended price against the actual market quote that follows.

**Comparison metrics:**
- Slippage: intended_price - actual_quote
- Fill probability: how often the intended price would have been hit
- Latency impact: quote movement between decision and simulated fill time

## 356 — Measure Data Age and End-to-End Latency
Every decision carries timestamps at each pipeline stage:
- `dataReceivedMs`: when the tick/quote was received
- `regimeComputedMs`: when regime tags were resolved
- `decisionMadeMs`: when the final decision was made
- `simulatedFillMs`: when the fill was simulated

**Metric:** end-to-end latency = simulatedFillMs - dataReceivedMs

**Archival:** latency records are stored with session ID and can be reproduced from archived data. Sample size and coverage are included in any report.

## 359 — Validate Paper-Fill Calibration Against Shadow Outcomes
Paper fills (simulated) are compared against shadow decisions to verify calibration.

**Calibration check:**
- Paper fill rate should approximate shadow decision rate
- P&L distribution should be similar
- Slippage model should be validated

## 362 — Require Stability Across Multiple Regimes
A strategy must show consistent performance across different regime states before promotion.

**Stability gate:**
- Strategy must have positive edge in at least 3 of 5 regime states
- No single regime state may have drawdown > 2x the overall drawdown
- Promotion is blocked until multi-regime stability is demonstrated

## State Machine
```
PAPER → SHADOW → MICRO_LIVE → LIVE
```
Each transition requires explicit gate checks (independent-risk-engine.ts canTransition).

## Regression Safety
- Old PAPER/SHADOW behavior must pass all existing regression tests
- Negative tests prove new code cannot bypass safety gates
- Every transition is logged with timestamp, from_mode, to_mode, and gate_status
