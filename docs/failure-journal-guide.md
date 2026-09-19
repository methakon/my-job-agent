# Failure Journal Guide

> Items 199–224. Systematic recording and analysis of trade failures to build institutional memory.

## Schema Design (Item 199)

```typescript
interface FailureJournalEntry {
  id: string;                          // UUID
  tradeDate: string;                   // YYYY-MM-DD
  skillId: string;                     // SK-{category}-{name}
  regime: string;                      // active regime family at time of failure
  
  // Classification
  failureType: FailureType;            // categorization
  severity: FailureSeverity;           // impact magnitude
  rootCause: RootCause;               // primary cause
  
  // Metrics
  mae: number;                         // max adverse excursion (%)
  mfe: number;                         // max favorable excursion (%)
  expectedMae: number;                 // model-expected MAE
  maeDeviation: number;                // |actual - expected| / expected
  
  // Context
  thesis: string;                      // original trade thesis
  observation: string;                 // what actually happened
  lesson: string;                      // extracted learning
  
  // Tracking
  tags: string[];                      // searchable tags
  reviewed: boolean;                   // has been analyzed
  reviewDate?: string;                 // when reviewed
}
```

## Failure Types (Item 200)

```typescript
type FailureType = 
  | 'STOP_HIT'           // stop loss triggered
  | 'TIME_STOP'          // held too long, time exit
  | 'REVERSAL'           // price reversed against thesis
  | 'SLIPPAGE'           // execution slippage exceeded tolerance
  | 'FALSE_SIGNAL'       // signal was invalid
  | 'REGIME_MISMATCH'    // trade against current regime
  | 'DATA_QUALITY'       // bad data led to bad decision
  | 'OVERTRADING'        // too many positions
  | 'POSITION_SIZE'      // sizing error
  | 'EMOTIONAL';         // impulsive/breaking rules
```

## Severity Levels (Item 201)

```typescript
type FailureSeverity = 'MICRO' | 'MINOR' | 'MODERATE' | 'MAJOR' | 'CRITICAL';
```

| Level | MAE Threshold | Description |
|-------|---------------|-------------|
| MICRO | < 0.3% | Noise, expected variance |
| MINOR | 0.3%–0.5% | Within normal risk budget |
| MODERATE | 0.5%–1.0% | Exceeds expected, needs review |
| MAJOR | 1.0%–2.0% | Significant loss, root cause analysis required |
| CRITICAL | > 2.0% | Systemic failure, immediate action |

## Root Cause Analysis (Item 202)

```typescript
type RootCause =
  | 'MODEL_ERROR'        // model produced wrong signal
  | 'EXECUTION_ERROR'    // execution issue
  | 'RISK_BREACH'        // violated risk rules
  | 'DATA_ERROR'         // bad/stale data
  | 'EXTERNAL_EVENT'     // news/event not in model
  | 'REGIME_SHIFT'       // market regime changed
  | 'POSITION_MGMT'      // poor position management
  | 'UNKNOWN';           // undetermined
```

## Journal Accumulation (Item 210)

Failures accumulate in the `failure_journal` table:

```sql
CREATE TABLE failure_journal (
  id VARCHAR(36) PRIMARY KEY,
  trade_date DATE NOT NULL,
  skill_id VARCHAR(50) NOT NULL,
  regime VARCHAR(50),
  failure_type VARCHAR(30) NOT NULL,
  severity VARCHAR(20) NOT NULL,
  root_cause VARCHAR(30) NOT NULL,
  mae DECIMAL(10,4),
  mfe DECIMAL(10,4),
  expected_mae DECIMAL(10,4),
  mae_deviation DECIMAL(10,4),
  thesis TEXT,
  observation TEXT,
  lesson TEXT,
  tags JSON,
  reviewed BOOLEAN DEFAULT FALSE,
  review_date DATE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_trade_date (trade_date),
  INDEX idx_skill_id (skill_id),
  INDEX idx_failure_type (failure_type),
  INDEX idx_severity (severity)
);
```

## MAE/MFE Recording (Item 216)

Every trade (win or loss) records MAE/MFE:

```typescript
function recordTradeMetrics(trade: ClosedTrade): TradeMetrics {
  return {
    mae: computeMaxAdverseExtension(trade.bars, trade.entryPrice),
    mfe: computeMaxFavorableExtension(trade.bars, trade.entryPrice),
    expectedMae: getExpectedMae(trade.skillId, trade.regime),
    maeDeviation: computeMaeDeviation(actualMae, expectedMae),
  };
}
```

## Post-Trade Review (Item 220)

After each session, review process:

1. **Auto-classify**: system assigns failure_type, severity, root_cause
2. **Thesis check**: compare original thesis with outcome
3. **Lesson extraction**: one-line actionable learning
4. **Tag assignment**: searchable tags for retrieval

## Lesson Retrieval (Item 224)

```typescript
function retrieveRelevantLessons(
  skillId: string,
  regime: string,
  currentConditions: MarketConditions,
): FailureJournalEntry[] {
  return failureJournal
    .filter(e => 
      e.skillId === skillId &&
      e.regime === regime &&
      Math.abs(e.maeDeviation) > 0.5
    )
    .sort((a, b) => b.severity.localeCompare(a.severity))
    .slice(0, 5);
}
```

## Search and Retrieval (Item 216)

```sql
-- Find all MAJOR failures for a skill
SELECT * FROM failure_journal 
WHERE skill_id = 'SK-GAP-fadeWithReversal' 
AND severity = 'MAJOR'
ORDER BY trade_date DESC;

-- Find failures by regime
SELECT * FROM failure_journal 
WHERE regime = 'range'
AND failure_type = 'REGIME_MISMATCH';

-- Find unreviewed failures
SELECT * FROM failure_journal 
WHERE reviewed = FALSE
ORDER BY severity DESC, trade_date DESC;
```
