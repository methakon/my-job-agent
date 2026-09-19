# Trading Agent — Historical Learning & Self-Improvement Architecture

## Overview

This document describes the Historical Learning & Self-Improvement framework
implemented for the Trading Agent. It covers the data planes, research layer,
learning loop, validation, adaptation, AI boundary, and safety gates.

---

## Data Planes

### Current Market Data Plane (IMPLEMENTED)

```
FYERS WebSocket → UnifiedMarketDataService → In-Memory Cache → Trading Engine
                                        ↓
                                unified_option_quotes (live table, ~2.5M rows)
                                unified_market_snapshots (live table, ~154K rows)
```

- **Ingestion**: Real-time during 09:15-15:30 IST
- **Cache**: In-memory Maps (latestQuote, latestSnapshot)
- **Reads**: generateSignals(), evaluateOpenPositions(), PatternEngine
- **Archive**: UnifiedArchiveService moves ticks to history tables after session

### Historical Data Plane (IMPLEMENTED — Phase L1)

```
unified_option_quotes_history  ← UnifiedArchiveService (write-only, 0 rows currently)
unified_market_snapshots_history ← UnifiedArchiveService (write-only, 0 rows currently)
                                        ↓
                        HistoricalResearchService (read, bounded queries)
                                        ↓
                        HistoricalAnalyticsService (deterministic analytics)
```

- **Write path**: Archive after each session (existing, unchanged)
- **Read path**: HistoricalResearchService — NEW, bounded indexed queries
- **Analytics**: HistoricalAnalyticsService — pure functions, no DB side effects
- **Status**: Infrastructure IMPLEMENTED, consumers empty (awaiting migration)

---

## Services

### HistoricalResearchService (Phase L1 — IMPLEMENTED)

Reads from unified_option_quotes_history and unified_market_snapshots_history
with bounded, indexed queries.

| Method | Purpose | Index Used |
|--------|---------|------------|
| `getQuoteWindow()` | Bounded quote query | receivedTimestamp |
| `getSnapshotWindow()` | Bounded snapshot query | receivedTimestamp |
| `getQuoteAggregates()` | Per-instrument stats | underlying+receivedTimestamp |
| `getSnapshotAggregates()` | Per-symbol stats | symbol+receivedTimestamp |
| `countQuotes()` / `countSnapshots()` | Data availability | receivedTimestamp |

**Safety**:
- Max window: 30 trading days
- Max rows per query: 5,000
- All queries use WHERE + LIMIT
- No full-table scans
- Never blocks live trading (async/off-hours only)

### HistoricalAnalyticsService (Phase L1 — IMPLEMENTED)

Deterministic analytics functions — pure computation over time series data.

| Function | Input | Output |
|----------|-------|--------|
| `computeVolatility()` | Price series | Annualized vol, daily vol |
| `computeTrend()` | Price series | Direction (UP/DOWN/FLAT), slope, R² |
| `computePremiumStats()` | Premium series | Avg, change, stddev |
| `computeSpreadStats()` | Bid/ask pairs | Avg/median/max spread |
| `computeVolumeStats()` | Volume series | Avg, trend |
| `computeATMStats()` | Spot + CE/PE premiums | ATM skew, avg premium |
| `computeSessionEffects()` | Prices + volumes | Hourly return/volume patterns |
| `classifyRegime()` | Vol + trend | Regime label |

**All results include**:
- sampleCount
- sufficientData flag
- timestamp/window boundaries
- No AI fabrication of missing data

### HistoricalContextBuilderService (Phase L3/L8 — IMPLEMENTED)

Combines current market state with precomputed historical context.

**Trading hours (hot path)**:
- `getResearchContext()` → returns CACHED context (no DB queries)
- `getCurrentMarketState()` → reads from in-memory cache (cheap)

**Off-hours (expensive)**:
- `computeHistoricalContext()` → reads history tables, runs analytics
- `assembleContext()` → full context assembly, updates cache

**Architecture**:
```
Off-Hours Compute → Cached Context → Trading Hot Path (read-only)
```

### ValidationEngineService (Phase L4 — IMPLEMENTED)

Deterministic validation framework for adaptation candidates.

| Gate | Condition | Default |
|------|-----------|---------|
| Min baseline trades | >= 10 | Hard gate |
| Min candidate trades | >= 5 | Hard gate |
| Win rate degradation | < -0.5pp | Rejection |
| Drawdown degradation | > 5pp | Rejection |
| Stability score | >= 40% positive windows | Rejection |

**Validation types**: holdout (70/30 split), rolling, baseline comparison

### AdaptationEngineService (Phase L4 — IMPLEMENTED)

Controlled candidate adaptation lifecycle.

```
PROPOSED → VALIDATING → APPROVED → ACTIVE
                    ↓
                 REJECTED
                              ↓
                           ROLLED_BACK
```

**Safety**:
- 11 prohibited parameters (risk limits, execution safety, provider safety)
- Bounded value ranges for adaptive parameters
- Every activation journaled with rollback value
- No AI can directly activate — must go through validation gate

### OffHoursResearchService (Phase L2 — IMPLEMENTED)

Orchestrates post-market analysis pipeline.

**Workflow**:
1. Summarize today's trades
2. Fetch historical data (bounded queries)
3. Compute regime analytics
4. Evaluate decay calibration
5. Compute strategy metrics
6. Identify candidate improvements
7. Store research result (persisted, not just logged)
8. Propose adaptation candidates
9. Assemble next-session context

**Output**: Stored in `research_results` table with full evidence chain.

---

## Learning Loop

### Current State

```
Trade Closes → rectifyDecay() → Adjust decay rate → Next Session
         ↓
   writeReflection() → Store outcome + heuristic → Injected into next signal reasons
```

**Classification**: PARTIAL — real feedback loops exist but are limited
to trade-outcome adaptation only.

### New Architecture (Implemented)

```
Trading Session → Outcomes + Observations
        ↓
Off-Hours Research → Historical Analysis + Pattern Analysis
        ↓
Candidate Generation → Validation Engine → Approval Gate
        ↓
Next-Session Activation → Research Context
        ↓
Trading Session (uses precomputed context)
```

**Classification**: FRAMEWORK IMPLEMENTED — pipeline exists but
awaiting historical data migration for full functionality.

---

## AI Boundaries

| AI May Do | AI Must NOT Do |
|-----------|----------------|
| Summarize research results | Open/close trades |
| Generate candidate hypotheses | Modify risk limits |
| Describe anomalies | Activate unvalidated candidates |
| Interpret regime data | Change REAL_ORDER_ALLOWED |
| | Modify execution safety gates |
| | Alter provider arbitration |
| | Directly modify trading code |

**Proposed Change Flow**:
```
AI Proposal → Deterministic Validation → Approval Gate → Controlled Configuration
```

---

## Trading-Hours Behavior (09:15-15:30 IST)

### DO:
- Use current live market data (in-memory cache)
- Use precomputed validated historical context (cached)
- Use approved active adaptation parameters
- Record outcomes, observations, pattern labels

### DO NOT:
- Run expensive historical scans per tick
- Run full backtests per tick
- Dynamically rewrite parameters
- Activate unvalidated candidates
- Allow AI to modify hot-path logic

**Hot path**: SessionDriver → generateSignals() → evaluateOpenPositions() → closeTrade()

All reads from in-memory cache. No per-tick DB queries for historical data.

---

## Off-Trading-Hours Behavior (after 16:00 IST)

### DO:
1. Archive ticks (existing, unchanged)
2. Run off-hours research (NEW)
3. Analyze trade outcomes
4. Analyze historical market regimes
5. Analyze pattern outcomes
6. Evaluate decay calibration
7. Compute strategy metrics
8. Generate adaptation candidates
9. Validate candidates
10. Activate approved candidates (next session)
11. Assemble research context for next session

### DO NOT:
- Modify live trading parameters mid-analysis
- Allow unvalidated candidates to activate
- Run on the trading hot path

---

## Safety Gates

### HARD GATES (never crossed without explicit approval):
- REAL_ORDER_ALLOWED = false (hardcoded, not adaptable)
- Risk limits (maxRiskPerTrade, stopLossPercent, etc.)
- Provider safety
- Stale data gates
- Execution safety

### SOFT GATES (deterministic, auditable):
- Minimum sample count for validation
- Win rate improvement threshold
- Drawdown degradation limit
- Stability score minimum
- Value bounds for adaptive parameters

### Audit Trail:
- Every adaptation candidate has: paramName, oldValue, proposedValue,
  reason, evidence, validationId, activatedAt, rollbackValue
- Every validation has: baseline vs candidate metrics, rejection reasons
- Every research result has: session date, metrics, regime, candidates

---

## File Structure

```
src/trading/
  unified-market-data/
    unified-option-quote-history.entity.ts          # History table entity
    unified-market-snapshot-history.entity.ts       # History table entity
    unified-archive.service.ts                      # Write to history (existing)
    historical-research.service.ts                  # NEW: Read from history
    historical-analytics.service.ts                 # NEW: Deterministic analytics
    historical-context-builder.service.ts           # NEW: Current + historical combo
    unified-market-data.module.ts                   # MODIFIED: register new services

  research/
    research-result.entity.ts                       # NEW: Research output persistence
    adaptation-candidate.entity.ts                  # NEW: Adaptation lifecycle
    validation-result.entity.ts                     # NEW: Validation evidence
    research.module.ts                              # NEW: Research DI module
    off-hours-research.service.ts                   # NEW: Post-market orchestrator
    validation-engine.service.ts                    # NEW: Validation framework
    adaptation-engine.service.ts                    # NEW: Controlled adaptation

scripts/
    unified-archive.test.js                         # Existing (24/24 passing)
    unified-market-data.test.js                     # Existing (passing)
    historical-analytics.test.js                    # NEW (18/18 passing)
    validation-adaptation.test.js                   # NEW (31/31 passing)

docs/
    trading-agent-architecture.md                   # This document
```

---

## Implementation Status

| Phase | Component | Status |
|-------|-----------|--------|
| L1 | Historical Research Service | IMPLEMENTED |
| L1 | Historical Analytics Service | IMPLEMENTED |
| L1 | History Table Entities | IMPLEMENTED |
| L2 | Off-Hours Research Worker | IMPLEMENTED |
| L2 | Research Result Persistence | IMPLEMENTED |
| L2 | Research Module DI | IMPLEMENTED |
| L3 | Historical Context Builder | IMPLEMENTED |
| L3 | Pattern Engine Integration | PLANNED |
| L3 | Current+Historical Context | IMPLEMENTED |
| L4 | Validation Engine | IMPLEMENTED |
| L4 | Adaptation Engine | IMPLEMENTED |
| L4 | Approval/Activation Gate | IMPLEMENTED |
| L5 | DDL for new tables | PENDING |
| L6 | Historical data migration | MIGRATION_PENDING |
| L7 | Session driver integration | PLANNED |
| L8 | Pattern engine integration | PLANNED |

---

## Migration Status

- **unified_option_quotes_history**: EXISTS, 0 rows (DDL executed)
- **unified_market_snapshots_history**: EXISTS, 0 rows (DDL executed)
- **research_results**: PENDING (DDL not yet created)
- **adaptation_candidates**: PENDING (DDL not yet created)
- **validation_results**: PENDING (DDL not yet created)
- **Historical data migration**: 2.49M rows prepared, NOT executed (HARD GATE)

---

## Key Design Decisions

1. **Separation of read and write paths**: Research reads never interfere with
   live ingestion. History tables are write-only during trading hours.

2. **Precomputed context**: The hot path never queries history. All historical
   analysis is precomputed off-hours and cached.

3. **Deterministic validation**: No AI judgment in activation gates. All gates
   are metric-based and auditable.

4. **Bounded adaptation**: Only non-safety parameters can be adapted. Value
   ranges are clamped. Previous values are preserved for rollback.

5. **Evidence chain**: Every adaptation links to its research result, validation
   result, and activation record.

6. **Legacy decay calibration**: Existing rectifyDecay() continues to function
   as IMMEDIATE adaptation. New framework operates in parallel with controlled
   activation.
