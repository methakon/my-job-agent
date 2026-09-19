/**
 * Event Replay — Deterministic replay of the event intelligence pipeline.
 *
 * Takes a sequence of events + market data snapshots and runs them through
 * the full pipeline: versioning → state machine → surprise → forecast → decision.
 *
 * All functions are PURE. No randomness, no I/O.
 *
 * SAFETY: Replay results are for PAPER trading analysis only.
 * Never use to validate real execution.
 */

import {
  Event,
  EventRawRecord,
  EventOntology,
  EventStateMachineState,
  ForecastDistribution,
  OptionChainFeatures,
  ReplayFixture,
  MarketDataSnapshot,
  PredictionRecord,
  ExpectedOutcome,
  TransmissionGraph,
  TransmissionNode,
  DataAvailability,
  StateTransitionTrigger,
} from './event-types';
import { createEvent, createVersion, computeCanonicalEventId } from './event-versioning';
import { transitionEventState } from './event-state-machine';
import { calculateSurprise, SurpriseResult, SurpriseInput } from './event-surprise';
import { generateForecast, decideFromForecast, ForecastInput } from './event-forecast';

// ── Types ───────────────────────────────────────────────────────────────────

export interface ReplayStep {
  readonly event: EventRawRecord;
  readonly marketSnapshot: MarketDataSnapshot;
  readonly expectedState: EventStateMachineState;
  readonly expectedDecision: 'PAPER_CANDIDATE' | 'ABSTAIN';
}

export interface ReplayResult {
  readonly eventId: string;
  readonly finalState: EventStateMachineState;
  readonly decision: 'PAPER_CANDIDATE' | 'ABSTAIN';
  readonly forecast: ForecastDistribution;
  readonly surprise: SurpriseResult;
  readonly stateHistory: readonly EventStateMachineState[];
  readonly stepsProcessed: number;
  readonly passed: boolean;
}

// ── Pure functions ──────────────────────────────────────────────────────────

/**
 * Default empty TransmissionGraph for replay contexts where
 * transmission data is not available.
 */
const EMPTY_TRANSMISSION_GRAPH: TransmissionGraph = {
  edges: [],
  nodeAvailability: new Map<TransmissionNode, DataAvailability>(),
  regime: 'UNKNOWN',
  calculatedAtMs: 0,
};

/**
 * Default empty SurpriseInput for initial detection (no prior consensus).
 */
function makeInitialSurpriseInput(): SurpriseInput {
  return {
    actual: 0,
    consensusAtDecisionTime: 0,
    previous: 0,
    revision: false,
    forecastDistribution: makeDefaultForecastDistribution(),
  };
}

/**
 * Default ForecastDistribution for inputs that need one.
 */
function makeDefaultForecastDistribution(): ForecastDistribution {
  return {
    pUp: 0.33,
    pDown: 0.33,
    pFlat: 0.34,
    moveQuantiles: [0, 0, 0, 0, 0],
    timeToPeakQuantiles: [0, 0, 0],
    persistenceProbability: 0.5,
    ivChangeQuantiles: [0, 0, 0, 0, 0],
    ivCrushProbability: 0,
    skewChange: 0,
    termStructureChange: 0,
    liquidityStressProbability: 0,
    abstainProbability: 0.5,
  };
}

/**
 * Process a single event through the full pipeline.
 * Returns the updated event, forecast, and decision.
 *
 * PURE: Yes. Deterministic: Yes.
 */
export function processEvent(
  record: EventRawRecord,
  ontology: EventOntology,
  optionFeatures: OptionChainFeatures,
  historicalMoveMean: number,
  historicalMoveStd: number,
  nowMs: number,
): {
  event: Event;
  forecast: ForecastDistribution;
  decision: 'PAPER_CANDIDATE' | 'ABSTAIN';
  surprise: SurpriseResult;
} {
  // 1. Create event from raw record
  const event = createEvent(record, ontology, nowMs);

  // 2. Compute surprise (for initial detection, consensus = 0)
  const surprise = calculateSurprise(makeInitialSurpriseInput());

  // 3. Generate forecast
  const forecast = generateForecast({
    event,
    surprise,
    optionFeatures,
    currentState: event.currentState,
    historicalMoveMean,
    historicalMoveStd,
  });

  // 4. Decide
  const decision = decideFromForecast(forecast);

  return { event, forecast, decision, surprise };
}

/**
 * Create a deterministic replay fixture.
 *
 * PURE: Yes. Deterministic: Yes.
 */
export function createReplayFixture(
  name: string,
  events: readonly EventRawRecord[],
  marketData: readonly MarketDataSnapshot[],
  expectedOutcomes?: readonly ExpectedOutcome[],
): ReplayFixture {
  return {
    name,
    events,
    marketData,
    expectedOutcomes: expectedOutcomes ?? [],
    seed: `replay-${name}-${events.length}`,
  };
}

/**
 * Run a full deterministic replay from a fixture.
 * Returns results for each step.
 *
 * PURE: Yes. Deterministic: Yes.
 */
export function runReplay(fixture: ReplayFixture): ReplayResult[] {
  const results: ReplayResult[] = [];
  const events = new Map<string, Event>();
  const stateHistory = new Map<string, EventStateMachineState[]>();

  for (let i = 0; i < fixture.events.length; i++) {
    const record = fixture.events[i];
    const marketData = fixture.marketData[Math.min(i, fixture.marketData.length - 1)];
    const expected = fixture.expectedOutcomes[i];

    // Check if this is a duplicate
    const canonicalId = computeCanonicalEventId(record, 'MACRO');
    const existingEvent = events.get(canonicalId);

    if (existingEvent) {
      // Duplicate: update version, don't create new event
      const evidence = {
        rawRecord: record,
        addedAtMs: record.processedAt,
        sourceTier: record.sourceTier,
      };
      const updatedEvent = createVersion(
        existingEvent,
        [evidence],
        existingEvent.lifecycle,
        'DUPLICATE_EVIDENCE',
        record.processedAt,
      );
      events.set(canonicalId, updatedEvent);

      // Re-run forecast with updated event
      const surprise = calculateSurprise(makeInitialSurpriseInput());

      const forecast = generateForecast({
        event: updatedEvent,
        surprise,
        optionFeatures: marketData.optionFeatures,
        currentState: updatedEvent.currentState,
        historicalMoveMean: 0,
        historicalMoveStd: 1,
      });

      const decision = decideFromForecast(forecast);
      const hist = stateHistory.get(canonicalId) ?? [];

      results.push({
        eventId: canonicalId,
        finalState: updatedEvent.currentState,
        decision,
        forecast,
        surprise,
        stateHistory: hist as readonly EventStateMachineState[],
        stepsProcessed: i + 1,
        passed: !expected || decision === expected.expectedDecision,
      });
      continue;
    }

    // New event: full pipeline
    const processed = processEvent(
      record,
      'MACRO',
      marketData.optionFeatures,
      0,
      1,
      record.processedAt,
    );

    events.set(canonicalId, processed.event);
    stateHistory.set(canonicalId, [processed.event.currentState]);

    results.push({
      eventId: canonicalId,
      finalState: processed.event.currentState,
      decision: processed.decision,
      forecast: processed.forecast,
      surprise: processed.surprise,
      stateHistory: [processed.event.currentState],
      stepsProcessed: i + 1,
      passed: !expected || processed.decision === expected.expectedDecision,
    });
  }

  return results;
}

/**
 * Simulate a state machine transition for an event in the replay.
 * Used for testing overnight → market open reconciliation.
 *
 * PURE: Yes. Deterministic: Yes.
 */
export function simulateStateTransition(
  event: Event,
  trigger: StateTransitionTrigger,
  evidenceVersion: number,
  nowMs: number,
): Event | null {
  const result = transitionEventState(event.currentState, trigger, evidenceVersion, nowMs);

  // Invalid transition — no state change, return null
  if (result.newState === result.previousState && result.reasonCode.includes('INVALID')) {
    return null;
  }

  return {
    ...event,
    currentState: result.newState,
    lifecycle: event.lifecycle,
    lastUpdatedAtMs: nowMs,
    versions: [
      ...event.versions,
      {
        version: event.versions.length + 1,
        evidence: [],
        createdAtMs: nowMs,
        lifecycle: event.lifecycle,
        reasonCode: result.reasonCode,
      },
    ],
  };
}

/**
 * Verify that a replay result matches expected outcome.
 * Returns deterministic pass/fail with details.
 *
 * PURE: Yes. Deterministic: Yes.
 */
export function verifyOutcome(
  fixture: ReplayFixture,
  expectedOutcome: {
    expectedDecision: 'PAPER_CANDIDATE' | 'ABSTAIN';
    expectedState?: EventStateMachineState;
  },
): { passed: boolean; details: string } {
  const results = runReplay(fixture);
  if (results.length === 0) {
    return { passed: false, details: 'No results from replay' };
  }

  const lastResult = results[results.length - 1];
  const decisionMatch = lastResult.decision === expectedOutcome.expectedDecision;
  const stateMatch = !expectedOutcome.expectedState ||
    lastResult.finalState === expectedOutcome.expectedState;

  return {
    passed: decisionMatch && stateMatch,
    details: [
      `decision=${lastResult.decision} (expected=${expectedOutcome.expectedDecision})`,
      `state=${lastResult.finalState}`,
      `steps=${lastResult.stepsProcessed}`,
      decisionMatch ? 'DECISION_MATCH' : 'DECISION_MISMATCH',
      stateMatch ? 'STATE_MATCH' : 'STATE_MISMATCH',
    ].join(' | '),
  };
}

/**
 * Convenience: replayTestFixture — runs replay and returns all results.
 * Alias for runReplay for clarity in test code.
 *
 * PURE: Yes. Deterministic: Yes.
 */
export function replayTestFixture(fixture: ReplayFixture): ReplayResult[] {
  return runReplay(fixture);
}
