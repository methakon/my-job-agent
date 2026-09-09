# P0 DecisionId Pipeline Verification Reference

## Architecture Requirements

### DecisionId Flow
```
DecisionSnapshot.decisionId
  → AiTradingInput.decisionId
  → FnfTrade.decisionId
```

**Rules:**
- NO ID generation in `buildAiTradingInputFromSnapshot`
- NO reconstruction from `signal.reasons`
- NO database/journal lookup required
- SHADOW mode must NOT execute or alter deterministic decisions

### Verification Points

1. **signal.reasons Independence**
   - AI input derived from snapshot fields directly
   - NO dependency on `signal.reasons` for any decisionId-mapped field

2. **Direct Snapshot Field Mapping**
   - Verify all fields: decisionId, underlying, spot, features, candidates, quote, Greeks, scoring, direction, timestamps
   - Each field mapped explicitly: `field: snapshot.field`

3. **No Journal Construction**
   - DecisionSnapshot contains ALL required data
   - NO additional DB queries or journal lookups

4. **DecisionId Equality**
   - `snapshot.decisionId === input.decisionId`
   - No second ID generation, no hash, no random value

5. **SHADOW Safety**
   - SHADOW mode cannot execute or alter deterministic decisions
   - SHADOW-mode test verifies: deterministic path unchanged by AI failure

## P0 Regression Test Suite (7 tests)

```javascript
// Test A: signal.reasons independence
// Verify AI input NOT derived from signal.reasons

// Test B: Direct snapshot field mapping
// Verify all direct field mappings: decisionId, underlying, spot, features, candidates, quote, Greeks, scoring, direction, timestamps

// Test C: No journal construction
// Verify no journal/database query required — snapshot alone sufficient

// Test D: Decision ID equality
// Verify decisionId equality — no ID generation, direct mapping

// Test E: SHADOW safety
// Verify SHADOW safety — AI failure does not affect deterministic path

// Test F: Exact input field mapping
// Verify exact field mappings match snapshot

// Test G: Snapshot modification test
// Verify snapshot modification properly reflected in AI input
```

## Code Verification Checklist

### In `trading-ai-orchestrator.service.ts`

```typescript
// Correct implementation example:
buildAiTradingInputFromSnapshot(snapshot: DecisionSnapshot, ...): AiTradingInput {
  return {
    // decisionId from snapshot DIRECTLY
    decisionId: snapshot.decisionId, // Canonical decision ID from snapshot
    
    // All other fields similarly mapped
    underlying: snapshot.underlying,
    spot: snapshot.spot,
    features: snapshot.features,
    candidates: snapshot.candidates,
    quote: snapshot.quote,
    greeks: snapshot.greeks,
    scoring: snapshot.scoring,
    direction: snapshot.direction,
    timestamps: snapshot.timestamps,
    
    // NO reconstruction from signal.reasons
    // NO database/journal lookup
  };
}
```

### In `fnf-trading.service.ts`

```typescript
async createTrade(dto: CreateFnfTradeDto): Promise<FnfTrade> {
  const trade = new FnfTrade();
  trade.decisionId = dto.decisionId ?? null; // From DTO
  // ... other fields
  return this.repository.save(trade);
}
```

### In `fnf-trade.entity.ts`

```typescript
@Column({ name: 'decisionId', length: 64, nullable: true })
decisionId: string;
```

## Testing Workflow

1. Build the project: `npm run build`
2. Run P0 regression tests: `node scripts/p0-regression-tests.js`
3. Run trading tests: `npm run test:trading`
4. Run AI tests: `npm run test:ai`
5. Run trading-AI integration tests: `npm run test:trading-ai`

All tests must pass before P0 checkpoint is considered verified.

## P0 Checkpoint Commit Convention

When committing P0 verification:

```
checkpoint: P0 <feature> + regression tests _UNFINALISED

- Describe implementation changes
- List P0 regression test assertions
- Specify files committed (entity, dto, service, test script)
- Note excluded files (migrations, hermes scripts, docs)
```

### Example Commit Message

```
checkpoint: P0 decisionId pipeline + regression tests _UNFINALISED

- Add decisionId column to FnfTrade entity, DTO, and service
- DecisionSnapshot.decisionId flows through AiTradingInput.decisionId → FnfTrade.decisionId
- P0 regression tests verify:
  * signal.reasons independence (AI input NOT derived from signal.reasons)
  * Direct snapshot field mapping (decisionId, underlying, spot, features, candidates, quote, Greeks, scoring, direction, timestamps)
  * No database/journal lookup required (snapshot alone sufficient)
  * decisionId equality (snapshot.decisionId === input.decisionId, no second ID generation)
  * SHADOW safety (AI failure does not affect deterministic path)
  * Exact input field mappings validated

Files committed:
- scripts/p0-regression-tests.js (7 tests)
- src/trading/fnf-trade.entity.ts (+1 column)
- src/trading/fnf-trading.dto.ts (+1 field)
- src/trading/fnf-trading.service.ts (+decisionId field assignment)

Excluded (untracked):
- .hermes/ persistent memory layer (scripts/hermes-*.py, test-persistence.js)
- src/migration/ (fnf-trade decisionId column migration)
- Documentation files (DECISION_SNAPSHOT_FIX.md, EXIT_MANAGEMENT_ARCHITECTURE.md, UI_REQUIREMENTS.md)
- External scripts (check_fyers_events.py, inspect_images.py)
```