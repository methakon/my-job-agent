import {
  transitionEventState,
  transitionSequence,
  isTerminal,
  stepFreezePrediction,
  stepAppendEvidence,
  stepRecalculateState,
  stepContradictionCheck,
  stepRiskGate,
} from './event-state-machine';
import {
  EventStateMachineState,
  StateTransitionTrigger,
  StateTransitionResult,
} from './event-types';

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Event State Machine — Transitions', () => {
  const NOW_MS = 1700000000000;

  describe('valid transitions', () => {
    it('S0_DETECTED → S1_INITIAL_SHOCK on new evidence', () => {
      const result = transitionEventState('S0_DETECTED', 'EVIDENCE_RECEIVED', 1, NOW_MS);
      expect(result.newState).toBe('S1_INITIAL_SHOCK');
      expect(result.previousState).toBe('S0_DETECTED');
      expect(result.reasonCode).toContain('S0_DETECTED_TO_S1_INITIAL_SHOCK');
    });

    it('S1_INITIAL_SHOCK → S2_CROSS_ASSET_CONFIRMED on cross_asset_update', () => {
      const result = transitionEventState('S1_INITIAL_SHOCK', 'CROSS_ASSET_CONFIRMED', 2, NOW_MS);
      expect(result.newState).toBe('S2_CROSS_ASSET_CONFIRMED');
      expect(result.previousState).toBe('S1_INITIAL_SHOCK');
    });

    it('S1_INITIAL_SHOCK → S3_CONTRADICTION on contradiction trigger', () => {
      const result = transitionEventState('S1_INITIAL_SHOCK', 'CONTRADICTION_DETECTED', 2, NOW_MS);
      expect(result.newState).toBe('S3_CONTRADICTION');
      expect(result.previousState).toBe('S1_INITIAL_SHOCK');
    });

    it('S3_CONTRADICTION → S4_ASSIMILATED on resolution', () => {
      const result = transitionEventState('S3_CONTRADICTION', 'CONTRADICTION_RESOLVED', 3, NOW_MS);
      expect(result.newState).toBe('S4_ASSIMILATED');
      expect(result.previousState).toBe('S3_CONTRADICTION');
    });

    it('S7_MARKET_CLOSED → S0_DETECTED on market_open', () => {
      const result = transitionEventState('S7_MARKET_CLOSED_PENDING_NEXT_SESSION', 'MARKET_OPENED', 1, NOW_MS);
      expect(result.newState).toBe('S0_DETECTED');
      expect(result.previousState).toBe('S7_MARKET_CLOSED_PENDING_NEXT_SESSION');
    });

    it('S6_RETRACTED_OR_INVALIDATED is terminal (no outgoing transitions)', () => {
      expect(isTerminal('S6_RETRACTED_OR_INVALIDATED')).toBe(true);
    });

    it('S6 terminal → any trigger returns same state with TERMINAL reason', () => {
      const result = transitionEventState('S6_RETRACTED_OR_INVALIDATED', 'EVIDENCE_RECEIVED', 1, NOW_MS);
      expect(result.newState).toBe('S6_RETRACTED_OR_INVALIDATED');
      expect(result.previousState).toBe('S6_RETRACTED_OR_INVALIDATED');
      expect(result.reasonCode).toContain('TERMINAL_STATE');
    });
  });

  describe('invalid transitions', () => {
    it('S0_DETECTED → S4_ASSIMILATED is rejected', () => {
      const result = transitionEventState('S0_DETECTED', 'CONTRADICTION_RESOLVED', 1, NOW_MS);
      expect(result.newState).toBe('S0_DETECTED');
      expect(result.reasonCode).toContain('INVALID');
    });

    it('S4_ASSIMILATED → S0_DETECTED (backwards) is rejected', () => {
      const result = transitionEventState('S4_ASSIMILATED', 'MARKET_OPENED', 1, NOW_MS);
      expect(result.newState).toBe('S4_ASSIMILATED');
      expect(result.reasonCode).toContain('INVALID');
    });
  });

  describe('result structure', () => {
    it('every transition stores all required fields', () => {
      const result = transitionEventState('S0_DETECTED', 'EVIDENCE_RECEIVED', 1, NOW_MS);

      expect(result).toHaveProperty('previousState');
      expect(result).toHaveProperty('newState');
      expect(result).toHaveProperty('trigger');
      expect(result).toHaveProperty('evidenceVersion');
      expect(result).toHaveProperty('timestamp');
      expect(result).toHaveProperty('reasonCode');
      expect(result).toHaveProperty('featureHash');

      expect(result.previousState).toBe('S0_DETECTED');
      expect(result.newState).toBe('S1_INITIAL_SHOCK');
      expect(result.trigger).toBe('EVIDENCE_RECEIVED');
      expect(result.evidenceVersion).toBe(1);
      expect(result.timestamp).toBe(NOW_MS);
      expect(typeof result.featureHash).toBe('string');
      expect(result.featureHash.length).toBeGreaterThan(0);
    });
  });

  describe('transition sequence', () => {
    it('FREEZE → APPEND → RECALCULATE sequence', () => {
      // Step 1: FREEZE
      const frozen = stepFreezePrediction('S0_DETECTED');
      expect(frozen.frozen).toBe(true);
      expect(frozen.frozenState).toBe('S0_DETECTED');

      // Step 2: APPEND
      const appended = stepAppendEvidence(1);
      expect(appended.newVersion).toBe(2);
      expect(appended.appended).toBe(true);

      // Step 3: RECALCULATE
      const recalculated = stepRecalculateState({
        currentState: 'S0_DETECTED',
        evidenceVersion: 2,
        featureHash: 'test-hash',
        nowMs: NOW_MS,
        trigger: 'EVIDENCE_RECEIVED',
      });
      expect(recalculated.newState).toBe('S1_INITIAL_SHOCK');
    });

    it('multi-step transition sequence succeeds', () => {
      const result = transitionSequence(
        'S0_DETECTED',
        [
          { trigger: 'EVIDENCE_RECEIVED', evidenceVersion: 1 },
          { trigger: 'CROSS_ASSET_CONFIRMED', evidenceVersion: 2 },
          { trigger: 'EVIDENCE_RECEIVED', evidenceVersion: 3 },
        ],
        NOW_MS,
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.results.length).toBe(3);
        expect(result.results[0].newState).toBe('S1_INITIAL_SHOCK');
        expect(result.results[1].newState).toBe('S2_CROSS_ASSET_CONFIRMED');
        expect(result.results[2].newState).toBe('S4_ASSIMILATED');
      }
    });

    it('multi-step sequence fails on invalid transition', () => {
      const result = transitionSequence(
        'S0_DETECTED',
        [
          { trigger: 'EVIDENCE_RECEIVED', evidenceVersion: 1 },
          { trigger: 'CONTRADICTION_RESOLVED', evidenceVersion: 2 }, // invalid from S1
        ],
        NOW_MS,
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.atStep).toBe(1);
        expect(result.reason).toContain('INVALID');
      }
    });
  });

  describe('contradiction check', () => {
    it('detects contradiction from transition result', () => {
      const transition = transitionEventState('S1_INITIAL_SHOCK', 'CONTRADICTION_DETECTED', 2, NOW_MS);
      const check = stepContradictionCheck(transition, true);
      expect(check.contradictionDetected).toBe(true);
      expect(check.newState).toBe('S3_CONTRADICTION');
    });

    it('no contradiction when evidence is consistent', () => {
      const transition = transitionEventState('S1_INITIAL_SHOCK', 'CROSS_ASSET_CONFIRMED', 2, NOW_MS);
      const check = stepContradictionCheck(transition, false);
      expect(check.contradictionDetected).toBe(false);
      expect(check.newState).toBe('S2_CROSS_ASSET_CONFIRMED');
    });
  });

  describe('risk gate', () => {
    it('S6_RETRACTED → always ABSTAIN', () => {
      const gate = stepRiskGate('S6_RETRACTED_OR_INVALIDATED', 0.1);
      expect(gate.decision).toBe('ABSTAIN');
      expect(gate.reason).toContain('RETRACTED');
    });

    it('S7_MARKET_CLOSED → ABSTAIN', () => {
      const gate = stepRiskGate('S7_MARKET_CLOSED_PENDING_NEXT_SESSION', 0.1);
      expect(gate.decision).toBe('ABSTAIN');
      expect(gate.reason).toContain('MARKET_CLOSED');
    });

    it('S0_DETECTED → ABSTAIN (insufficient evidence)', () => {
      const gate = stepRiskGate('S0_DETECTED', 0.3);
      expect(gate.decision).toBe('ABSTAIN');
      expect(gate.reason).toContain('INSUFFICIENT');
    });

    it('high abstain probability → ABSTAIN', () => {
      const gate = stepRiskGate('S2_CROSS_ASSET_CONFIRMED', 0.85);
      expect(gate.decision).toBe('ABSTAIN');
      expect(gate.reason).toContain('ABSTAIN_PROBABILITY');
    });

    it('S4_ASSIMILATED with low abstain → PAPER_CANDIDATE', () => {
      const gate = stepRiskGate('S4_ASSIMILATED', 0.2);
      expect(gate.decision).toBe('PAPER_CANDIDATE');
      expect(gate.reason).toContain('RISK_GATE_PASSED');
    });
  });
});
