# DecisionSnapshot Pipeline Repair Pattern

## Context

This reference captures the DecisionSnapshot pipeline repair pattern from the
my-job-agent trading service audit (2026-09-07). The fix addressed a critical
pipeline gap where the DecisionSnapshot was not being persisted to the journal
and was not being passed to the AI assessment.

## Problem Statement

Before the fix:
- `journalDecision()` accepted a `snapshot` parameter but did NOT persist it to `detailJson`
- AI orchestrator reconstructed input from `signal.reasons` parsing with fabricated defaults
- `decisionId` was generated but not propagated to journal or AI input
- No correlation between deterministic cycle → snapshot → journal → AI

## Solution Summary

### Files Changed

1. **fnf-trading.service.ts**
   - Exported `DecisionSnapshot` interface
   - Added `decisionId?: string` and `snapshot?: DecisionSnapshot` to `journalDecision()` signature
   - Added `sanitizeSnapshot()` helper method (removes circular refs for `JSON.stringify()`)
   - Updated `detailJson` to persist `decisionId` and `snapshot` via `JSON.stringify()`
   - Added `getDecisionSnapshot()` method for downstream retrieval

2. **fnf-decision-journal.entity.ts**
   - Added `decisionId?: string` to journal metadata block
   - `detailJson` column preserved as existing JSON field

3. **trading-ai-orchestrator.service.ts**
   - Complete rewrite: `buildAiTradingInput(snapshot)` now consumes snapshot directly
   - Removed all `signal.reasons` parsing
   - Removed fabricated defaults (spot: 0, sma20: 0, volume: 0, etc.)

## Pipeline Flow

```
deterministic calculation (generateSignals)
    ↓ creates both AlgoSignal[] AND DecisionSnapshot with same decisionId
DecisionSnapshot → journalDecision({ snapshot, decisionId })
    ↓ stored in journal.detailJson via JSON.stringify()
DecisionSnapshot → AI orchestrator (buildAiTradingInput(snapshot))
    ↓ AI uses snapshot directly, NO reconstruction
```

## Critical Rules

1. **NO synthetic values** — all values must originate from actual deterministic calculation
2. **NO reconstruction** — AI must receive snapshot directly, never reconstruct from signal.reasons
3. **Fail-closed** — if value unavailable (e.g., sessionId for astro match), default to `null`
4. **One deterministic cycle only** — snapshot derived once, never recalculated downstream
5. **Snapshot = authoritative source** — journal and AI both consume this exact copy

## Audit Checklist

Use this checklist to verify the pipeline:

1. ✅ `DecisionSnapshot` properly exported and imported
2. ✅ `journalDecision()` accepts and persists `snapshot` in `detailJson`
3. ✅ `detailJson` contains full snapshot JSON (not partial/omitted)
4. ✅ Orchestrator uses snapshot directly (no reconstruction from signal.reasons)
5. ✅ `decisionId` propagated: cycle → snapshot → journal → AI input

## Test Results

All 36 tests passing:
- trading: 4/4
- ai: 25/25  
- trading-ai: 7/7

## MySQL Schema Note

**⚠️ WARNING**: Storing full `DecisionSnapshot` in `detailJson` may exceed MySQL `TEXT` limit (64KB) for complex snapshots. Recommended action:

```sql
ALTER TABLE fnf_decision_journal MODIFY detailJson MEDIUMTEXT;
-- or use JSON type if MySQL version supports it
ALTER TABLE fnf_decision_journal MODIFY detailJson JSON;
```

## Related Files

- `/home/swarna-sekhar-dhar/projects/my-job-agent/src/trading/fnf-trading.service.ts`
- `/home/swarna-sekhar-dhar/projects/my-job-agent/src/trading/fnf-decision-journal.entity.ts`
- `/home/swarna-sekhar-dhar/projects/my-job-agent/src/trading/fnf-decision-snapshot.ts`
- `/home/swarna-sekhar-dhar/projects/my-job-agent/src/trading/trading-ai-orchestrator.service.ts`
- `/home/swarna-sekhar-dhar/projects/my-job-agent/DECISION_SNAPSHOT_FIX.md`
