/**
 * Event State Machine — Pure Transition Logic
 *
 * PURE: No clock, no I/O, no DB, no network, no randomness.
 * Deterministic: same inputs → same outputs, always.
 *
 * Every transition records: previousState, newState, trigger,
 * evidenceVersion, timestamp, reasonCode, featureHash.
 *
 * Pipeline steps (each is a pure function):
 *   FREEZE prediction → APPEND evidence → RECALCULATE state →
 *   RECALCULATE surprise/novelty → UPDATE transmission graph →
 *   UPDATE market state → RECALCULATE forecast → CONTRADICTION CHECK →
 *   RISK GATE → STORE revised prediction.
 */

import {
  EventStateMachineState,
  StateTransitionTrigger,
  StateTransitionResult,
  VALID_TRANSITIONS,
} from './event-types';

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Deterministic hash for feature fingerprinting.
 * FNV-1a style, no crypto dependency.
 */
function deterministicHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  let hash2 = 0x62b821d5;
  for (let i = 0; i < input.length; i++) {
    hash2 ^= input.charCodeAt(i);
    hash2 = Math.imul(hash2, 0x1b873593) >>> 0;
  }
  return ((hash << 16) | (hash2 & 0xffff)).toString(16).padStart(8, '0');
}

// ── Trigger → Destination Mapping ────────────────────────────────────────────

/**
 * Maps a (source state, trigger) pair to the expected destination state.
 * Returns null if this trigger doesn't apply from this state.
 */
function destinationForTrigger(
  from: EventStateMachineState,
  trigger: StateTransitionTrigger,
): EventStateMachineState | null {
  const map: Partial<Record<EventStateMachineState, Partial<Record<StateTransitionTrigger, EventStateMachineState>>>> = {
    S0_DETECTED: {
      EVIDENCE_RECEIVED: 'S1_INITIAL_SHOCK',
      CROSS_ASSET_CONFIRMED: 'S1_INITIAL_SHOCK',
      MARKET_CLOSED: 'S7_MARKET_CLOSED_PENDING_NEXT_SESSION',
      RETRACTION_RECEIVED: 'S6_RETRACTED_OR_INVALIDATED',
    },
    S0B_PRE_EVENT_POSITIONING: {
      EVIDENCE_RECEIVED: 'S1_INITIAL_SHOCK',
      MARKET_CLOSED: 'S7_MARKET_CLOSED_PENDING_NEXT_SESSION',
      RETRACTION_RECEIVED: 'S6_RETRACTED_OR_INVALIDATED',
    },
    S1_INITIAL_SHOCK: {
      EVIDENCE_RECEIVED: 'S1_INITIAL_SHOCK',   // stay with more evidence
      CROSS_ASSET_CONFIRMED: 'S2_CROSS_ASSET_CONFIRMED',
      CROSS_ASSET_FAILED: 'S3_CONTRADICTION',
      CONTRADICTION_DETECTED: 'S3_CONTRADICTION',
      MARKET_CLOSED: 'S7_MARKET_CLOSED_PENDING_NEXT_SESSION',
      RETRACTION_RECEIVED: 'S6_RETRACTED_OR_INVALIDATED',
    },
    S2_CROSS_ASSET_CONFIRMED: {
      EVIDENCE_RECEIVED: 'S4_ASSIMILATED',
      CROSS_ASSET_FAILED: 'S3_CONTRADICTION',
      CONTRADICTION_DETECTED: 'S3_CONTRADICTION',
      MARKET_CLOSED: 'S7_MARKET_CLOSED_PENDING_NEXT_SESSION',
      RETRACTION_RECEIVED: 'S6_RETRACTED_OR_INVALIDATED',
    },
    S3_CONTRADICTION: {
      CONTRADICTION_RESOLVED: 'S4_ASSIMILATED',
      CROSS_ASSET_CONFIRMED: 'S2_CROSS_ASSET_CONFIRMED',
      EVIDENCE_RECEIVED: 'S1_INITIAL_SHOCK',
      MARKET_CLOSED: 'S7_MARKET_CLOSED_PENDING_NEXT_SESSION',
      RETRACTION_RECEIVED: 'S6_RETRACTED_OR_INVALIDATED',
    },
    S4_ASSIMILATED: {
      EVIDENCE_RECEIVED: 'S5_FOLLOW_UP',
      MARKET_CLOSED: 'S7_MARKET_CLOSED_PENDING_NEXT_SESSION',
      RETRACTION_RECEIVED: 'S6_RETRACTED_OR_INVALIDATED',
    },
    S5_FOLLOW_UP: {
      MARKET_CLOSED: 'S7_MARKET_CLOSED_PENDING_NEXT_SESSION',
      RETRACTION_RECEIVED: 'S6_RETRACTED_OR_INVALIDATED',
    },
    S6_RETRACTED_OR_INVALIDATED: {
      // terminal — no transitions
    },
    S7_MARKET_CLOSED_PENDING_NEXT_SESSION: {
      MARKET_OPENED: 'S0_DETECTED',
      EVIDENCE_RECEIVED: 'S1_INITIAL_SHOCK',
      CROSS_ASSET_CONFIRMED: 'S2_CROSS_ASSET_CONFIRMED',
      CONTRADICTION_RESOLVED: 'S4_ASSIMILATED',
      RETRACTION_RECEIVED: 'S6_RETRACTED_OR_INVALIDATED',
    },
  };

  return map[from]?.[trigger] ?? null;
}

// ── State Transition ─────────────────────────────────────────────────────────

/**
 * Attempt a state transition on an event.
 *
 * PURE: Yes. Deterministic: Yes.
 *
 * @param currentState - The current state machine state.
 * @param trigger - What caused this transition attempt.
 * @param evidenceVersion - The evidence version triggering the transition.
 * @param nowMs - Current timestamp in epoch milliseconds.
 * @param featureHash - Hash of the feature set (optional, computed if empty).
 * @returns StateTransitionResult with the new state, or current state if invalid.
 */
export function transitionEventState(
  currentState: EventStateMachineState,
  trigger: StateTransitionTrigger,
  evidenceVersion: number,
  nowMs: number,
  featureHash: string = '',
): StateTransitionResult {
  const allowedDestinations = VALID_TRANSITIONS.get(currentState);

  if (!allowedDestinations || allowedDestinations.size === 0) {
    // Terminal state — no transitions
    return {
      newState: currentState,
      previousState: currentState,
      timestamp: nowMs,
      reasonCode: `TERMINAL_STATE_${currentState}_NO_OUTGOING`,
      featureHash: featureHash || deterministicHash(`${currentState}::${trigger}::${evidenceVersion}`),
      trigger,
      evidenceVersion,
    };
  }

  const destination = destinationForTrigger(currentState, trigger);

  if (destination === null) {
    return {
      newState: currentState,
      previousState: currentState,
      timestamp: nowMs,
      reasonCode: `INVALID_TRIGGER_${trigger}_FROM_${currentState}`,
      featureHash: featureHash || deterministicHash(`${currentState}::${trigger}::${evidenceVersion}`),
      trigger,
      evidenceVersion,
    };
  }

  if (!allowedDestinations.has(destination)) {
    return {
      newState: currentState,
      previousState: currentState,
      timestamp: nowMs,
      reasonCode: `TRANSITION_NOT_ALLOWED_${currentState}_TO_${destination}_ON_${trigger}`,
      featureHash: featureHash || deterministicHash(`${currentState}::${destination}::${trigger}::${evidenceVersion}`),
      trigger,
      evidenceVersion,
    };
  }

  const computedHash = featureHash || deterministicHash(
    `${currentState}::${destination}::${trigger}::${evidenceVersion}`,
  );

  return {
    newState: destination,
    previousState: currentState,
    timestamp: nowMs,
    reasonCode: `${currentState}_TO_${destination}_ON_${trigger}`,
    featureHash: computedHash,
    trigger,
    evidenceVersion,
  };
}

/**
 * Run a sequence of transitions from an initial state.
 * Returns all results or stops on first failure.
 */
export function transitionSequence(
  initialState: EventStateMachineState,
  steps: Array<{ readonly trigger: StateTransitionTrigger; readonly evidenceVersion: number }>,
  startMs: number,
): { ok: true; results: StateTransitionResult[] } | { ok: false; atStep: number; reason: string; results: StateTransitionResult[] } {
  const results: StateTransitionResult[] = [];
  let state = initialState;
  let nowMs = startMs;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const res = transitionEventState(state, step.trigger, step.evidenceVersion, nowMs);

    // If state didn't change, the transition was rejected
    if (res.newState === res.previousState && res.reasonCode.includes('INVALID')) {
      return { ok: false, atStep: i, reason: res.reasonCode, results };
    }

    results.push(res);
    state = res.newState;
    nowMs += 1000; // advance 1s per step for determinism
  }

  return { ok: true, results };
}

/**
 * Check if a state is terminal (no further transitions possible).
 */
export function isTerminal(state: EventStateMachineState): boolean {
  const allowed = VALID_TRANSITIONS.get(state);
  return !allowed || allowed.size === 0;
}

// ── Pipeline Step Helpers ────────────────────────────────────────────────────

/**
 * The full event processing pipeline. Each step is a pure function
 * that transforms data without side effects. The orchestrator calls
 * these in sequence.
 */

export interface PipelineInput {
  readonly currentState: EventStateMachineState;
  readonly evidenceVersion: number;
  readonly featureHash: string;
  readonly nowMs: number;
  readonly trigger: StateTransitionTrigger;
}

export interface PipelineStepResult {
  readonly stepName: string;
  readonly passed: boolean;
  readonly newState: EventStateMachineState;
  readonly reason: string;
}

/**
 * Step 1: FREEZE previous prediction.
 * Captures the current prediction state before processing new evidence.
 */
export function stepFreezePrediction(
  currentState: EventStateMachineState,
): { readonly frozen: boolean; readonly frozenState: EventStateMachineState } {
  return {
    frozen: true,
    frozenState: currentState,
  };
}

/**
 * Step 2: APPEND new evidence.
 * Increments version counter. Actual evidence attachment is done by
 * event-versioning.versionEvent.
 */
export function stepAppendEvidence(
  evidenceVersion: number,
): { readonly newVersion: number; readonly appended: boolean } {
  return {
    newVersion: evidenceVersion + 1,
    appended: true,
  };
}

/**
 * Step 3: RECALCULATE event state.
 * Runs the state transition logic.
 */
export function stepRecalculateState(input: PipelineInput): StateTransitionResult {
  return transitionEventState(
    input.currentState,
    input.trigger,
    input.evidenceVersion,
    input.nowMs,
    input.featureHash,
  );
}

/**
 * Step 4: CONTRADICTION CHECK.
 * Checks if new evidence contradicts existing evidence.
 */
export function stepContradictionCheck(
  transitionResult: StateTransitionResult,
  hasContradictoryEvidence: boolean,
): { readonly contradictionDetected: boolean; readonly newState: EventStateMachineState } {
  if (hasContradictoryEvidence && transitionResult.newState !== 'S6_RETRACTED_OR_INVALIDATED') {
    return {
      contradictionDetected: true,
      newState: 'S3_CONTRADICTION',
    };
  }
  return {
    contradictionDetected: false,
    newState: transitionResult.newState,
  };
}

/**
 * Step 5: RISK GATE.
 * Determines whether the event should generate a paper candidate or abstain.
 * NEVER auto-generates BUY/SELL — only PAPER_CANDIDATE or ABSTAIN.
 */
export function stepRiskGate(
  eventState: EventStateMachineState,
  abstainProbability: number,
): { readonly decision: 'PAPER_CANDIDATE' | 'ABSTAIN'; readonly reason: string } {
  // Never trade on retracted events
  if (eventState === 'S6_RETRACTED_OR_INVALIDATED') {
    return { decision: 'ABSTAIN', reason: 'EVENT_RETRACTED' };
  }

  // Never trade on market-closed events without preparation
  if (eventState === 'S7_MARKET_CLOSED_PENDING_NEXT_SESSION') {
    return { decision: 'ABSTAIN', reason: 'MARKET_CLOSED_AWAITING_SESSION' };
  }

  // Abstain if model confidence is too low
  if (abstainProbability > 0.7) {
    return { decision: 'ABSTAIN', reason: `ABSTAIN_PROBABILITY_${abstainProbability.toFixed(2)}_EXCEEDS_THRESHOLD` };
  }

  // Initial detection — too early to trade
  if (eventState === 'S0_DETECTED') {
    return { decision: 'ABSTAIN', reason: 'INSUFFICIENT_EVIDENCE_INITIAL_DETECTION' };
  }

  // Pre-event positioning only if we have high conviction
  if (eventState === 'S0B_PRE_EVENT_POSITIONING' && abstainProbability > 0.4) {
    return { decision: 'ABSTAIN', reason: 'PRE_EVENT_LOW_CONFIDENCE' };
  }

  return { decision: 'PAPER_CANDIDATE', reason: 'RISK_GATE_PASSED' };
}
