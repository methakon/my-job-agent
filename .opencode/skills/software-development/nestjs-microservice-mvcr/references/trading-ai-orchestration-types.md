# Trading AI Orchestrator Type Fix Reference

## Type Mismatches Identified

### 1. AiRoutingRequest
```typescript
// Actual (ai-routing.types.ts)
export interface AiRoutingRequest {
  taskType: AiTaskType;
  preferredModelKey?: string;
  allowExperimental?: boolean;
  allowPremium?: boolean;
}
```

The orchestrator incorrectly passed:
- `algoSource`, `instrument`, `underlying`, `expiry` — these are NOT part of `AiRoutingRequest`

### 2. AiRoutingService API
```typescript
// Correct method
resolveWithDecision(request: AiRoutingRequest): AiRoutingDecision
```
NOT `routeRequest`. The orchestrator used wrong method name.

### 3. AiRoutingDecision Structure
```typescript
export interface AiRoutingDecision {
  routingPolicyVersion: string;
  taskType: AiTaskType;
  requestedModelKey?: string;
  selectedModelKey: string;
  selectedProvider: string;
  selectedModelId: string;
  selectedModelTier: string;
  selectedModelExperimental?: boolean;
  HermesModelKey?: string;
}
```
Note: `HermesModelKey` is optional and named differently than `selectedModelKey`.

### 4. AiRoutingMetadata
```typescript
// The orchestrator's AiRoutingMetadata has different fields
// vs what AiRoutingDecision provides

// Required for AiTradingInput metadata
// selectedModelExperimental is REQUIRED (not optional)
```

### 5. AiTradingAssessment
The orchestrator assumed:
```typescript
// WRONG assumptions from orchestrator code
assessment.recommendation        // Does NOT exist
assessment.confidenceLevel       // Does NOT exist  
assessment.routingMetadata       // Does NOT exist
```

Actual assessment structure:
```typescript
export interface AiTradingAssessment {
  deterministicAction: DeterministicAction;
  recommendation: Recommendation; // This DOES exist
  riskLevel: RiskLevel;
  confidence:number; // NOT confidenceLevel
  // ... many other fields
}
```

### 6. Quote Field Names in DecisionSnapshot
The snapshot uses camelCase consistently:
- `oi` NOT `oI`
- `oiChange` NOT `oIChange`
- `iv` (already correct)

## Corrected Orchestrator Flow

```typescript
// 1. Get routing metadata correctly
const routingDecision = this.aiRouting.resolveWithDecision({
  taskType: 'trading_research',
  // NO algoSource, instrument, underlying, expiry here
});
const routingMetadata: AiRoutingMetadata = {
  routingPolicyVersion: routingDecision.routingPolicyVersion,
  selectedModelKey: routingDecision.selectedModelKey,
  selectedProvider: routingDecision.selectedProvider,
  selectedModelId: routingDecision.selectedModelId,
  selectedModelTier: routingDecision.selectedModelTier,
  selectedModelExperimental: routingDecision.selectedModelExperimental ?? false,
  HermesModelKey: routingDecision.HermesModelKey ?? routingDecision.selectedModelKey,
};

// 2. Build input with decisionId
const input: AiTradingInput = {
  // ... other fields
  decisionId: snapshot.decisionId, // REQUIRED field
  // ...
};

// 3. Call assessment with correct args
const result = await this.aiAssessment.assessTradingDecision(input, routingMetadata);

// 4. Handle result correctly
if (!result.success) {
  // Handle error
}
const assessment = result.assessment;
// assessment.recommendation exists
// assessment.confidence exists (NOT confidenceLevel)
```

## Key Learnings

1. **Never pass broker-specific fields to routing** — routing only needs taskType
2. **decisionId is REQUIRED** in AiTradingInput, not optional
3. **quote.oi not quote.oI** — snapshot uses consistent camelCase
4. **Routing decision provides metadata** — don't build it from scratch
5. **Assessment result has `confidence` (number)** — not `confidenceLevel`
