# Agent Buffers — Observation State Documentation

> Items 330, 333, 336, 339, 345

## Overview
Agent buffers maintain live observation state that the trading agent reads before every decision. They expose current gap state, regime, feature health, option-surface state, Greek discrepancies, simulated fills, champion/challenger versions, and risk-veto counts.

## Buffer Contents

### 330 — Gap State, Regime, and Feature Health
- **Gap state**: Current gap classification (FADE/FOLLOW), acceptance status, time-to-target
- **Regime tags**: trend, range, volatility, liquidity, openingState, eventCatalyst, gapAcceptance, volatilityTransition (from regime-tags.ts)
- **Feature health**: last-updated timestamps, staleness flags, quality scores

### 333 — Option-Surface State and Greek Discrepancies
- **IV surface**: Current implied volatility across strikes and expiries (iv-surface.ts)
- **Greek discrepancies**: Differences between model Greeks and market Greeks
- **Skew/term structure**: Current skew and term structure state (iv-skew-term.ts)

### 336 — Simulated Fills, MAE/MFE, and Execution Quality
- **Simulated fills**: Paper execution fill records
- **MAE/MFE**: Maximum adverse/favorable excursion per position
- **Execution quality**: Slippage, fill rate, latency metrics

### 339 — Champion/Challenger Versions and Experiment Status
- **Champion**: Current production strategy version
- **Challenger**: Candidate strategy being evaluated
- **Experiment status**: Active experiments, last attempt results, pass/fail counts

### 345 — Risk-Veto Counts and Shutdown State
- **Risk vetoes**: Count of trades vetoed by risk engine per session
- **Shutdown state**: Kill switch active/inactive, volatility shutdown status
- **Mode state**: Current PAPER/SHADOW/MICRO_LIVE/LIVE mode

## Buffer Interface

```typescript
interface AgentBuffer {
  gapState: GapStateBuffer;
  regimeTags: RegimeTagSet;        // from regime-tags.ts
  featureHealth: FeatureHealthStatus[];
  optionSurface: OptionSurfaceBuffer;
  greekDiscrepancies: GreekDiscrepancy[];
  simulatedFills: SimulatedFillRecord[];
  executionQuality: ExecutionQualityMetrics;
  championVersion: StrategyVersion;
  challengerVersion: StrategyVersion | null;
  experimentStatus: ExperimentStatusSummary;
  riskVetoCount: number;
  shutdownState: ShutdownState;
  executionMode: ExecutionMode;     // from independent-risk-engine.ts
}
```

## Read Pattern
Buffers are refreshed each tick/decision cycle. Agents read the buffer snapshot, never query the database directly during trading hours. All buffer values carry a `lastUpdatedMs` timestamp; staleness beyond configured thresholds triggers a warning.

## Safety Rule
Buffer writes are append-only during trading hours. Only the designated writer process (paper-execution or research-off-hours) may mutate buffer contents. Agents are read-only consumers.
