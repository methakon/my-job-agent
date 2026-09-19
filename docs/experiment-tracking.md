# Experiment Tracking

> Items 227–250. Registry design, trial tracking, cost awareness, and acceptance criteria.

## Registry Design (Item 227)

```typescript
interface Experiment {
  id: string;                          // EXP-{number}
  name: string;                        // descriptive name
  hypothesis: string;                  // what we're testing
  status: ExperimentStatus;
  createdAt: string;
  updatedAt: string;
  
  // Design
  type: ExperimentType;
  variants: ExperimentVariant[];
  successMetric: string;               // primary metric
  minimumSampleSize: number;
  
  // Tracking
  startDate?: string;
  endDate?: string;
  currentSample: number;
  results?: ExperimentResults;
}

type ExperimentStatus = 
  | 'DESIGN'      // being designed
  | 'RUNNING'     // actively collecting data
  | 'PAUSED'      // temporarily stopped
  | 'COMPLETED'   // finished, results available
  | 'FAILED'      // did not meet criteria
  | 'ARCHIVED';   // historical reference

type ExperimentType = 
  | 'A_B'          // two variants
  | 'MULTIVARIATE' // multiple variants
  | 'SEQUENTIAL'   // one variant at a time
  | 'FACTORS';     // factorial design
```

## Trial Tracking (Item 230)

```typescript
interface ExperimentTrial {
  id: string;
  experimentId: string;
  variantId: string;
  tradeDate: string;
  skillId: string;
  regime: string;
  
  // Outcome
  pnl: number;
  pnlPct: number;
  mae: number;
  mfe: number;
  rMultiple: number;
  
  // Context
  conditions: Record<string, any>;    // market conditions at trial
  notes?: string;
}
```

## Cost Awareness (Item 233)

```typescript
interface ExperimentCost {
  researchHours: number;
  computeCostUsd: number;
  dataCostUsd: number;
  opportunityCost: number;            // trades missed during experiment
  
  totalCostUsd: number;
  costPerSample: number;
  breakEvenSampleSize: number;        // when benefits exceed costs
}

function computeExperimentCost(exp: Experiment): ExperimentCost {
  const fixedCost = exp.researchHours * 50; // $50/hour estimate
  const variableCost = exp.currentSample * exp.costPerSample;
  
  return {
    ...exp.cost,
    totalCostUsd: fixedCost + variableCost,
    costPerSample: fixedCost / Math.max(exp.currentSample, 1),
    breakEvenSampleSize: computeBreakEven(exp),
  };
}
```

## Acceptance Criteria (Item 236)

```typescript
interface AcceptanceCriteria {
  // Statistical
  minimumSampleSize: number;
  significanceLevel: number;          // p-value threshold
  minimumEffectSize: number;          // minimum detectable effect
  
  // Practical
  minimumWinRate: number;
  minimumSharpe: number;
  maximumDrawdown: number;
  
  // Robustness
  walkForwardPass: boolean;
  outOfSamplePass: boolean;
  regimeConsistency: boolean;         // works across regimes
}

function evaluateAcceptance(
  results: ExperimentResults,
  criteria: AcceptanceCriteria,
): AcceptanceVerdict {
  const checks = {
    sampleSize: results.sampleSize >= criteria.minimumSampleSize,
    significance: results.pValue < criteria.significanceLevel,
    effectSize: Math.abs(results.effectSize) >= criteria.minimumEffectSize,
    winRate: results.winRate >= criteria.minimumWinRate,
    sharpe: results.sharpe >= criteria.minimumSharpe,
    drawdown: results.maxDrawdown <= criteria.maximumDrawdown,
    walkForward: results.walkForwardPass,
    outOfSample: results.outOfSamplePass,
    regimeConsistency: results.regimeConsistency,
  };
  
  const passed = Object.values(checks).filter(Boolean).length;
  const total = Object.keys(checks).length;
  
  return {
    passed: passed === total,
    checks,
    score: passed / total,
    verdict: passed >= total * 0.8 ? 'PASS' : 
             passed >= total * 0.6 ? 'CONDITIONAL' : 'FAIL',
  };
}
```

## Experiment Results (Item 239)

```typescript
interface ExperimentResults {
  sampleSize: number;
  
  // Performance
  winRate: number;
  avgPnlPct: number;
  avgRMultiple: number;
  sharpe: number;
  sortino: number;
  maxDrawdown: number;
  
  // Statistical
  pValue: number;
  confidenceInterval: [number, number];
  effectSize: number;
  power: number;
  
  // Robustness
  walkForwardPass: boolean;
  outOfSamplePass: boolean;
  regimeConsistency: boolean;
  
  // By regime
  regimeBreakdown: Record<string, {
    sampleSize: number;
    winRate: number;
    sharpe: number;
  }>;
}
```

## Decision Logging (Items 273–313)

Every experiment decision must be logged:

```typescript
interface ExperimentDecision {
  id: string;
  experimentId: string;
  decision: string;                   // what was decided
  rationale: string;                  // why
  alternatives: string[];             // what was considered
  data: any;                          // supporting data
  madeBy: string;                     // who/what made decision
  madeAt: string;                     // timestamp
  
  // Reversibility
  reversible: boolean;
  reversalTrigger?: string;           // what would trigger reversal
  
  // Impact
  expectedImpact: string;
  actualImpact?: string;              // filled in later
}
```

## Agent Buffers (Items 315–343)

Agent execution buffers for experiment runs:

```typescript
interface AgentBuffer {
  sessionId: string;
  experimentId: string;
  decisions: ExperimentDecision[];
  trades: ClosedTrade[];
  performance: PerformanceMetrics;
  
  // Buffers
  capitalBuffer: number;              // reserved capital
  timeBuffer: number;                 // reserved time
  riskBuffer: number;                 // reserved risk budget
  
  // State
  status: 'ACTIVE' | 'PAUSED' | 'COMPLETED';
  startedAt: string;
  completedAt?: string;
}
```

## Execution Protocol (Items 345–363)

```typescript
interface ExperimentProtocol {
  // Pre-execution
  codeVersion: string;                // git SHA
  backwardCompatible: boolean;        // safe to run alongside
  testCoverage: number;               // % of code covered by tests
  observability: boolean;             // logging enabled
  
  // During execution
  checkpointInterval: number;         // save state every N trades
  abortConditions: AbortCondition[];
  
  // Post-execution
  cleanupActions: string[];           // what to do with results
  archivalPolicy: string;             // how long to keep data
}

interface AbortCondition {
  type: 'DRAWDOWN' | 'LOSSES' | 'TIME' | 'DATA_QUALITY';
  threshold: number;
  action: 'PAUSE' | 'ABORT' | 'ALERT';
}
```
