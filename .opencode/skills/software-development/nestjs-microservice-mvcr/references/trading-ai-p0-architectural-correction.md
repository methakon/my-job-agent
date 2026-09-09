# Trading AI Orchestrator P0 Architectural Correction

## The P0 Fix Goal

Remove ALL legacy AI input reconstruction and enforce that AI input is derived
SOLELY from in-memory DecisionSnapshot with deterministic calculation.

## Architecture Constraint

### Required Flow

```
One deterministic calculation cycle:
  deterministic calculation
         │
         ├── AlgoSignal[]
         │
         └── DecisionSnapshot
                  │
                  └── same in-memory object
                            ↓
                       AI orchestrator
```

### Separately

```
DecisionSnapshot → Journal persistence
```

The journal is AUDIT STORAGE ONLY.

AI must NEVER fetch its input back from journal.detailJson.

## What to Remove

Every occurrence of these patterns must be removed or made unreachable:

```
signal.reasons                    ← NO parsing
parseContractFromSymbol()         ← NO reconstruction
resolveContractFromJournal()      ← NO journal lookup
resolveQuoteFromJournal()         ← NO journal lookup
resolveDirection()                ← NO reconstruction
resolveGreeks()                   ← NO reconstruction
resolveScoring()                  ← NO reconstruction
portfolioId + ts + winnerSymbol   ← NO journal lookup
hardcoded spread                  ← NO fabrications
hardcoded volume                  ← NO fabrications
hardcoded openInterest            ← NO fabrications
spot: 0                           ← NO fabrications
sma20: 0                          ← NO fabrications
sma5: 0                           ← NO fabrications
```

## What to Use Instead

Only these DecisionSnapshot fields may be used:

```
snapshot.optionContract.*         ← contract details
snapshot.actualQuote.*            ← quote data (use oi not oI)
snapshot.direction.*              ← direction analysis
snapshot.localGreeks.*            ← greeks
snapshot.scoring.*                ← scoring
snapshot.decisionId               ← decision ID
snapshot.dte                      ← days to expiry
snapshot.confidence.*             ← decay/confidence
snapshot.features                 ← data quality
snapshot.algoSource, buildSha     ← metadata
snapshot.sessionPhase             ← session phase
```

## Field Naming Conventions

Snapshot uses consistent camelCase:

| Wrong          | Correct       |
|----------------|---------------|
| `oI`           | `oi`          |
| `oIChange`     | `oiChange`    |
| `quoteTs`      | `quoteTs`     |
| `quoteAgeMin`  | `quoteAgeMin` |

## Routing API

### AiRoutingRequest (CORRECT shape)
```typescript
export interface AiRoutingRequest {
  taskType: AiTaskType;
  complexity?: 'low' | 'medium' | 'high' | 'critical';
  requiresCoding?: boolean;
  requiresReasoning?: boolean;
  requiresQuantResearch?: boolean;
  allowPremium?: boolean;
  allowExperimental?: boolean;
  preferredModelKey?: string;
}
```

### AiRoutingRequest (WRONG - remove these)
```typescript
// ❌ algoSource: snapshot.algoSource
// ❌ instrument: snapshot.winnerSymbol
// ❌ underlying: snapshot.underlying
// ❌ expiry: snapshot.optionContract.expiry
```

### AiRoutingService Method

Use `resolveWithDecision()` — NOT `routeRequest()`:

```typescript
// ✅ CORRECT
const routingDecision = this.aiRouting.resolveWithDecision({
  taskType: 'trading_research',
});

// ❌ WRONG
const routingDecision = await this.aiRouting.routeRequest({...});
```

## AiRoutingMetadata (Required fields)

```typescript
export interface AiRoutingMetadata {
  routingPolicyVersion: string;
  HermesModelKey?: string;
  selectedModelKey: string;
  selectedProvider: string;
  selectedModelId: string;
  selectedModelTier: string;
  selectedModelExperimental: boolean;  // REQUIRED
}
```

Note: `selectedModelExperimental` is required (not optional).

## AiTradingAssessment (Parsing correctly)

```typescript
export type AiAssessmentResult =
  | { success: true; assessment: AiTradingAssessment }
  | { success: false; error: string; details?: Record<string, unknown> };

export interface AiTradingAssessment {
  version: '1.0.0';
  modelIdentity: { /* ... */ };
  directionalAssessment: { /* ... */ };
  candidateAssessment: {
    attractivenessScore: number;
    riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
    keyRisks: string[];
    recommendation: 'APPROVE' | 'REJECT' | 'REVIEW';
    recommendationExplanation: string;
    confidenceIntervals: { low: number; mid: number; high: number };
  };
  comparedToDeterministicSignal: { /* ... */ };
  summary: {
    overallAssessment: string;
    keyInsights: string[];
    warnings?: string[];
    confidenceLevel: 'HIGH' | 'MEDIUM' | 'LOW';
    executionAdvisory: 'SHADOW_ONLY' | 'REVIEW_REQUIRED' | 'ENHANCEMENT_SUGGESTED';
  };
  generationMetadata?: { /* ... */ };
}
```

### AI Assessment Fields to Use

```typescript
// ✅ Exists
assessment.candidateAssessment.recommendation
assessment.summary.confidenceLevel
assessment.modelIdentity.*  // All routing metadata fields

// ❌ Does NOT exist (do NOT use)
assessment.recommendation           // Wrong path
assessment.confidenceLevel          // Wrong path
assessment.routingMetadata          // Does not exist
```

## decisionId Propagation

### Required Flow

```
Deterministic calculation creates decisionId:
  decisionId = `BUY_${winnerSymbol}_${timestamp}`

DecisionSnapshot stores decisionId:
  snapshot.decisionId === `BUY_${winnerSymbol}_${timestamp}`

AI input receives decisionId:
  input.decisionId === snapshot.decisionId

Journal stores decisionId:
  journal.decisionId === snapshot.decisionId

Assessment correlates with decisionId:
  assessment.modelIdentity.* links to routing decision
```

## Verification Checklist

When reviewing trading AI orchestrator code:

1. ✅ `buildAiTradingInputFromSnapshot()` uses ONLY snapshot fields
2. ✅ NO journal/database lookup to fetch snapshot
3. ✅ `getRoutingMetadata()` calls `resolveWithDecision()` with correct request
4. ✅ `decisionId` flows from snapshot through to AI input
5. ✅ Quote fields use `oi` and `oiChange` (not `oI`/`oIChange`)
6. ✅ Assessment result parsing matches `AiAssessmentResult` type
7. ✅ No reconstruction code references `signal.reasons`
8. ✅ No hardcoded values in place of actual snapshot data
9. ✅ No `portfolioId + ts + winnerSymbol` journal lookup pattern

## Search Strings to Find Legacy Code

Run this search to identify legacy reconstruction:

```bash
cd /home/swarna-sekhar-dhar/projects/my-job-agent

# Search for reconstruction patterns
grep -r "signal\.reasons" src/trading/ || echo "No signal.reasons found"
grep -r "resolveContractFromJournal" src/trading/ || echo "No resolveContractFromJournal found"
grep -r "resolveQuoteFromJournal" src/trading/ || echo "No resolveQuoteFromJournal found"
grep -r "resolveDirection" src/trading/ || echo "No resolveDirection found"
grep -r "resolveGreeks" src/trading/ || echo "No resolveGreeks found"
grep -r "resolveScoring" src/trading/ || echo "No resolveScoring found"

# Search for fabricated values
grep -r "spread.*:.*0" src/trading/ || echo "No hardcoded spread found"
grep -r "volume.*:.*0" src/trading/ || echo "No hardcoded volume found"
grep -r "oi.*:.*0" src/trading/ || echo "No hardcoded oi found"
grep -r "spot.*:.*0" src/trading/ || echo "No hardcoded spot found"

# Search for journal lookup patterns
grep -r "portfolioId.*ts.*winnerSymbol" src/trading/ || echo "No journal lookup pattern found"
grep -r "detailJson.*snapshot" src/trading/ || echo "No detailJson snapshot pattern found"
```

## Expected After Fix

- Zero legacy reconstruction methods
- Zero `signal.reasons` parsing
- Zero journal lookups for AI input
- Zero hardcoded fabricated values
- All values derived from in-memory DecisionSnapshot
