# DecisionSnapshot Pipeline Repair - Completed

## Summary
Permanent DecisionSnapshot pipeline repair has been implemented to eliminate 
all fabricated/default/guessed trading values and ensure deterministic 
snapshot flow from generation → journal → AI assessment.

## Key Changes

### 1. fnf-trading.service.ts
- Exported `DecisionSnapshot` interface for use by other services
- Updated `journalDecision()` method to accept `snapshot?: DecisionSnapshot`
- Updated `detailJson` to persist `decisionId` and `snapshot` (as JSON string)
- Snapshot flow: `generateSignals()` creates snapshot → passes to `journalDecision()` → stored in DB

### 2. fnf-decision-journal.entity.ts  
- `detailJson` column now contains:
  - `decisionId`: Stable identifier for the decision
  - `snapshot`: Complete DecisionSnapshot as JSON string
  - All previous metadata fields preserved

### 3. trading-ai-orchestrator.service.ts
- `buildAiTradingInput()` now accepts `snapshot: DecisionSnapshot` parameter
- Removed all reconstruction logic from `signal.reasons` text parsing
- Removed all fabricated defaults (spot: 0, sma20: 0, etc.)
- All AI input data derived directly from snapshot properties
- `astroMatch = null` (fail-closed for missing data)

## Pipeline Flow

```
generateSignals() creates DecisionSnapshot
    ↓
snapshot stored in journal.detailJson as JSON
    ↓
trading-ai-orchestrator receives snapshot directly
    ↓
buildAiTradingInput(snapshot) extracts data from snapshot
    ↓
AI assessment using actual market data (no reconstruction)
```

## Files Modified
- src/trading/fnf-trading.service.ts
- src/trading/fnf-decision-journal.entity.ts  
- src/trading/trading-ai-orchestrator.service.ts

## Tests Status
✓ npm run build: 0 errors/warnings
✓ npm run test:trading: 16/16 passed
✓ npm run test:ai: 16/16 passed  
✓ npm run test:trading-ai: 7/7 passed

## Remaining Work for Future Exit Engine
1. Add `sessionId` to snapshot for astroMatch calculation
2. Implement deterministic exit policies based on:
   - MAE/MFE analysis
   - Expected value of HOLD vs EXIT
   - Risk constraints
3. Backtest methodology for policy evaluation
4. Position management data model
