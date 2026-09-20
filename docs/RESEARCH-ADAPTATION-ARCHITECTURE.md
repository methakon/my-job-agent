# Research & Adaptation Pipeline Architecture

## Overview

The research and adaptation pipeline enables data-driven parameter optimization while maintaining strict safety boundaries. It operates off-hours (post-market) and feeds validated candidates into the live trading service.

## Pipeline Flow

```
Market Close (16:00+ IST)
        │
        ▼
┌─────────────────────────────────────────┐
│  Off-Hours Research Service             │
│  (triggered by SessionDriver)           │
├─────────────────────────────────────────┤
│  1. Load closed trades from fnf_trades  │
│  2. Compute trade summary metrics       │
│  3. Detect market regime                │
│  4. Analyze historical patterns         │
│  5. Evaluate decay calibration          │
│  6. Generate candidate improvements     │
│  7. Store ResearchResult                │
│  8. Propose AdaptationCandidates        │
│  9. Validate candidates                 │
│ 10. Assemble next-session context       │
└─────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────┐
│  Adaptation Engine                      │
│  (candidate lifecycle management)       │
├─────────────────────────────────────────┤
│  PROPOSED → VALIDATING → APPROVED       │
│                              ↓          │
│                           ACTIVE        │
│                              ↓          │
│                          ROLLED_BACK    │
└─────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────┐
│  Fnf Trading Service                    │
│  (applies active candidates)            │
├─────────────────────────────────────────┤
│  1. Load ACTIVE candidates at session   │
│  2. Map to calibration parameters       │
│  3. Apply to per-weekday calibrations   │
│  4. Continue with decayConfidence()     │
└─────────────────────────────────────────┘
```

## Safety Boundaries

### What CAN Be Adapted
- `decayRate` — How quickly confidence decays
- `confidenceThreshold` — Minimum confidence to trigger trades
- `rectifyDecay` — Rectification factor per trade outcome

### What CANNOT Be Adapted
- `REAL_ORDER_ALLOWED` — Always false in paper trading
- Risk limits — Permanent safety boundaries
- Provider selection — Deterministic, not adaptive
- Trade entry/exit logic — Fixed algorithm

### Hot Path Constraint
- **NO database queries inside**: `generateSignals()`, `evaluateOpenPositions()`, the 10-second session loop, per-tick processing
- All adaptation reads happen at session boundary (startup)

## Key Files

| File | Purpose |
|------|---------|
| `off-hours-research.service.ts` | Main research pipeline orchestration |
| `adaptation-engine.service.ts` | Candidate lifecycle management |
| `validation-engine.service.ts` | Holdout validation of candidates |
| `adaptation-candidate.entity.ts` | Candidate data model |
| `research-result.entity.ts` | Research output data model |
| `validation-result.entity.ts` | Validation outcome data model |
| `fnf-trading.service.ts` | Applies active candidates to calibrations |
| `session-driver.service.ts` | Triggers research pipeline |

## Data Flow

### Research Execution
1. `SessionDriver.runOffHoursResearch()` calls `OffHoursResearchService.runDailyResearch()`
2. Research service loads closed trades from `fnf_trades` table
3. Computes trade summary, market regime, decay calibration
4. Generates candidate improvements based on analysis
5. Stores `ResearchResult` with all metrics and candidate proposals

### Candidate Lifecycle
1. Research service proposes candidates via `AdaptationEngineService.propose()`
2. Candidate status = `PROPOSED`
3. Validation engine validates candidate against historical data
4. If passed: status → `APPROVED`
5. At next session boundary: status → `ACTIVE`
6. Trading service loads ACTIVE candidates and applies to calibrations

### Context Assembly
1. `HistoricalContextBuilderService.assembleContext()` loads:
   - Recent research results
   - Active adaptation candidates
   - Trade summary metrics
2. Context passed to `FnfTradingService` at session start
3. Trading service uses context for decay calibration

## Observability

### Research Status
```typescript
await offHoursResearchService.getResearchStatus()
// Returns: {
//   totalResults: number,
//   totalCandidates: number,
//   activeCandidates: number,
//   totalValidations: number,
//   lastResult: { id, createdAt, sampleCount } | null,
//   lastCandidate: { id, paramName, status, createdAt } | null,
// }
```

### Logging
- `=== OFF-HOURS RESEARCH COMPLETE: {date} | {duration}ms | regime={regime} | trades={N} | candidates={N} | proposed={N} | validated={N} | activated={N} | researchId={id} ===`
- `Candidate proposed: {param} (status: PROPOSED)`
- `Candidate validated: {param} — {passed ? 'APPROVED' : 'REJECTED'}`
- `Candidate activated: {param} = {value}`

## Validation Logic

### Holdout Validation
1. Split historical trades into in-sample (70%) and out-of-sample (30%)
2. Compute metrics for both baseline and candidate parameters
3. Check for:
   - Sample size (≥10 baseline, ≥5 candidate)
   - Win rate improvement (≥-0.5%)
   - Drawdown degradation (≤5%)
   - Stability ratio (≥60%)
4. If all checks pass → APPROVED
5. If any check fails → REJECTED with reasons

### Simulation Engine (Implemented)
The `SimulationEngineService` replays historical trades through candidate parameter changes:

1. **confidenceThreshold** — Filters baseline trades by `decayedConfidence >= threshold` (parsed from `decisionParams`). Trades below the proposed threshold are excluded from candidate results.

2. **decayRate** — Adjusts signal decay calculation using the proposed rate. Determines whether each trade would still trigger entry under the new decay curve.

**Input**: Baseline `TradeRecord[]` from `fnf_trades` + candidate `paramName`/`proposedValue`
**Output**: Filtered `TradeRecord[]` representing trades that would occur under proposed parameters

The simulation is:
- **Deterministic**: same inputs → same outputs
- **Auditable**: all candidate trades carry the source trade ID and simulation metadata
- **Bounded**: operates on existing `fnf_trades` data only
- **Safe**: no broker calls, no live state modification

When 0 candidate trades survive filtering, the candidate is immediately REJECTED (parameter too restrictive).

## Hot Path Safety

### Session Boundary (Safe)
- `applyActiveCandidates()` runs once at session start
- Loads ACTIVE candidates from database
- Applies to calibration parameters
- No mid-session database queries

### Mid-Session (Protected)
- `generateSignals()` — no DB queries
- `evaluateOpenPositions()` — no DB queries
- 10-second session loop — no DB queries
- Per-tick processing — no DB queries

## Future Enhancements

1. ~~**Simulation Engine**~~ — ✅ Built (`SimulationEngineService`). Currently supports confidenceThreshold and decayRate. Extend for additional parameter types as needed.
2. **A/B Testing** — Run multiple parameter sets simultaneously
3. **Rollback Automation** — Auto-rollback on performance degradation
4. **Pattern Engine Integration** — Apply pattern-based parameter adjustments (weights remain frozen)
5. **Observability Dashboard** — Real-time research pipeline metrics
