
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AdaptationCandidate } from './adaptation-candidate.entity';
import { ValidationResult } from './validation-result.entity';
import { v4 as uuid } from 'uuid';

/**
 * Controlled adaptation engine — manages the lifecycle of adaptation candidates.
 *
 * Lifecycle: PROPOSED → VALIDATING → APPROVED → ACTIVE
 *                              ↓
 *                           REJECTED
 *
 * Every activation is:
 * - evidence-based (validation result required)
 * - bounded (parameter values clamped)
 * - journaled (audit trail preserved)
 * - rollback-capable (previous value stored)
 *
 * PROHIBITED:
 * - Risk parameter modification
 * - REAL_ORDER_ALLOWED modification
 * - Execution safety modification
 * - Provider safety modification
 */

// ── Types ─────────────────────────────────────────────────────────────

export interface AdaptationProposal {
  paramName: string;
  paramCategory: 'decay' | 'timing' | 'weight' | 'threshold' | 'scoring';
  oldValue: any;
  proposedValue: any;
  reason: string;
  evidenceIds: string[];
  researchResultId: string;
}

export interface ActivationRecord {
  candidateId: string;
  paramName: string;
  activatedAt: Date;
  previousActiveValue: any;
  newActiveValue: any;
  validationId: string;
}

export interface RollbackRecord {
  candidateId: string;
  paramName: string;
  rolledBackAt: Date;
  previousValue: any;
  restoredValue: any;
  reason: string;
}

/** Parameters that CANNOT be adapted. */
const PROHIBITED_PARAMS = [
  'maxRiskPerTrade',
  'maxOpenPositions',
  'maxDailyLoss',
  'realOrderAllowed',
  'stopLossPercent',
  'takeProfitPercent',
  'staleDataThreshold',
  'connectionTimeout',
  'retryAttempts',
  'providerPriority',
];

/** Bounded ranges for adaptive parameters. */
const PARAM_BOUNDS: Record<string, { min: number; max: number }> = {
  decayRate: { min: 0.01, max: 0.99 },
  timingWindowMinutes: { min: 10, max: 120 },
  confidenceThreshold: { min: 0.3, max: 0.95 },
  spreadThreshold: { min: 0.01, max: 5.0 },
  liquidityMinimum: { min: 10, max: 10000 },
};

@Injectable()
export class AdaptationEngineService {
  private readonly logger = new Logger(AdaptationEngineService.name);

  constructor(
    @InjectRepository(AdaptationCandidate)
    private readonly candidates: Repository<AdaptationCandidate>,
    @InjectRepository(ValidationResult)
    private readonly validationResults: Repository<ValidationResult>,
  ) {}

  // ── Safety checks ───────────────────────────────────────────────────

  /** Check if a parameter is allowed to be adapted. */
  isParamAdaptable(paramName: string): { allowed: boolean; reason?: string } {
    if (PROHIBITED_PARAMS.includes(paramName)) {
      return { allowed: false, reason: `Parameter ${paramName} is in the prohibited list — risk/safety boundary` };
    }
    return { allowed: true };
  }

  /** Check if a proposed value is within bounds. */
  isValueBounded(paramName: string, value: any): { valid: boolean; reason?: string } {
    const bounds = PARAM_BOUNDS[paramName];
    if (!bounds) return { valid: true }; // no bounds defined — accept any type
    if (typeof value !== 'number') return { valid: false, reason: `Expected number for ${paramName}` };
    if (value < bounds.min || value > bounds.max) {
      return { valid: false, reason: `Value ${value} outside bounds [${bounds.min}, ${bounds.max}] for ${paramName}` };
    }
    return { valid: true };
  }

  // ── Proposal lifecycle ──────────────────────────────────────────────

  /** Propose a new adaptation candidate. Returns saved candidate or throws. */
  async propose(proposal: AdaptationProposal): Promise<AdaptationCandidate> {
    // Safety checks
    const paramCheck = this.isParamAdaptable(proposal.paramName);
    if (!paramCheck.allowed) {
      throw new Error(`ADAPTATION_BLOCKED: ${paramCheck.reason}`);
    }

    const valueCheck = this.isValueBounded(proposal.paramName, proposal.proposedValue);
    if (!valueCheck.valid) {
      throw new Error(`ADAPTATION_BLOCKED: ${valueCheck.reason}`);
    }

    // Check no duplicate active candidate for same param
    const existing = await this.candidates.findOne({
      where: { paramName: proposal.paramName, status: 'ACTIVE' },
    });
    if (existing) {
      this.logger.warn(`Replacing active candidate ${existing.id} for ${proposal.paramName}`);
    }

    const candidate = this.candidates.create({
      paramName: proposal.paramName,
      paramCategory: proposal.paramCategory,
      oldValue: proposal.oldValue,
      proposedValue: proposal.proposedValue,
      reason: proposal.reason,
      evidenceIds: proposal.evidenceIds,
      baselineMetrics: null,
      candidateMetrics: null,
      status: 'PROPOSED',
      validationId: null,
      activatedAt: null,
      rollbackValue: proposal.oldValue,
      researchResultId: proposal.researchResultId,
    });

    const saved = await this.candidates.save(candidate);
    this.logger.log(`Candidate proposed: ${saved.id} — ${saved.paramName}: ${saved.oldValue} → ${saved.proposedValue}`);
    return saved;
  }

  /** Move a candidate to VALIDATING (validation in progress). */
  async moveToValidating(candidateId: string): Promise<AdaptationCandidate> {
    const candidate = await this.candidates.findOneBy({ id: candidateId });
    if (!candidate) throw new Error(`Candidate ${candidateId} not found`);
    if (candidate.status !== 'PROPOSED') {
      throw new Error(`Candidate ${candidateId} is ${candidate.status}, expected PROPOSED`);
    }

    candidate.status = 'VALIDATING';
    return this.candidates.save(candidate);
  }

  /** Mark a candidate as APPROVED (passed validation). */
  async approve(candidateId: string, validationId: string): Promise<AdaptationCandidate> {
    const candidate = await this.candidates.findOneBy({ id: candidateId });
    if (!candidate) throw new Error(`Candidate ${candidateId} not found`);

    const vr = await this.validationResults.findOneBy({ id: validationId });
    if (!vr) throw new Error(`Validation result ${validationId} not found`);
    if (!vr.passed) throw new Error(`Validation ${validationId} did not pass — cannot approve`);

    candidate.status = 'APPROVED';
    candidate.validationId = validationId;
    return this.candidates.save(candidate);
  }

  /** Mark a candidate as REJECTED (failed validation). */
  async reject(candidateId: string, validationId: string): Promise<AdaptationCandidate> {
    const candidate = await this.candidates.findOneBy({ id: candidateId });
    if (!candidate) throw new Error(`Candidate ${candidateId} not found`);

    candidate.status = 'REJECTED';
    candidate.validationId = validationId;
    return this.candidates.save(candidate);
  }

  // ── Activation ──────────────────────────────────────────────────────

  /**
   * Activate an APPROVED candidate.
   * Returns an ActivationRecord with the previous value for audit.
   * Must be called at session boundary (not mid-session).
   */
  async activate(candidateId: string): Promise<ActivationRecord> {
    const candidate = await this.candidates.findOneBy({ id: candidateId });
    if (!candidate) throw new Error(`Candidate ${candidateId} not found`);
    if (candidate.status !== 'APPROVED') {
      throw new Error(`Candidate ${candidateId} is ${candidate.status}, expected APPROVED`);
    }

    // Final safety check
    const paramCheck = this.isParamAdaptable(candidate.paramName);
    if (!paramCheck.allowed) {
      throw new Error(`ACTIVATION_BLOCKED: ${paramCheck.reason}`);
    }

    const now = new Date();
    candidate.status = 'ACTIVE';
    candidate.activatedAt = now;
    await this.candidates.save(candidate);

    const record: ActivationRecord = {
      candidateId,
      paramName: candidate.paramName,
      activatedAt: now,
      previousActiveValue: candidate.oldValue,
      newActiveValue: candidate.proposedValue,
      validationId: candidate.validationId!,
    };

    this.logger.log(
      `ACTIVATED: ${candidate.paramName}: ${JSON.stringify(candidate.oldValue)} → ${JSON.stringify(candidate.proposedValue)} [candidate ${candidateId}]`,
    );

    return record;
  }

  // ── Rollback ────────────────────────────────────────────────────────

  /**
   * Roll back an ACTIVE candidate to its previous value.
   * Creates a ROLLED_BACK record and returns the rollback details.
   */
  async rollback(candidateId: string, reason: string): Promise<RollbackRecord> {
    const candidate = await this.candidates.findOneBy({ id: candidateId });
    if (!candidate) throw new Error(`Candidate ${candidateId} not found`);
    if (candidate.status !== 'ACTIVE') {
      throw new Error(`Candidate ${candidateId} is ${candidate.status}, expected ACTIVE`);
    }

    const now = new Date();
    const record: RollbackRecord = {
      candidateId,
      paramName: candidate.paramName,
      rolledBackAt: now,
      previousValue: candidate.proposedValue,
      restoredValue: candidate.rollbackValue,
      reason,
    };

    candidate.status = 'ROLLED_BACK';
    await this.candidates.save(candidate);

    this.logger.warn(
      `ROLLED_BACK: ${candidate.paramName}: ${JSON.stringify(candidate.proposedValue)} → ${JSON.stringify(candidate.rollbackValue)} [reason: ${reason}]`,
    );

    return record;
  }

  // ── Queries ─────────────────────────────────────────────────────────

  /** Get the current ACTIVE candidate for a parameter. */
  async getActiveForParam(paramName: string): Promise<AdaptationCandidate | null> {
    return this.candidates.findOne({
      where: { paramName, status: 'ACTIVE' },
    });
  }

  /** Get all APPROVED candidates awaiting activation. */
  async getApprovedCandidates(): Promise<AdaptationCandidate[]> {
    return this.candidates.find({ where: { status: 'APPROVED' } });
  }

  /** Get candidates by status. */
  async getByStatus(status: string): Promise<AdaptationCandidate[]> {
    return this.candidates.find({ where: { status: status as any }, order: { createdAt: 'DESC' } });
  }

  /** Get full history for a parameter. */
  async getHistory(paramName: string): Promise<AdaptationCandidate[]> {
    return this.candidates.find({
      where: { paramName },
      order: { createdAt: 'DESC' },
    });
  }

  /** Get activation records (candidates that are ACTIVE or ROLLED_BACK). */
  async getActivationRecords(): Promise<AdaptationCandidate[]> {
    return this.candidates.find({
      where: [
        { status: 'ACTIVE' },
        { status: 'ROLLED_BACK' },
      ],
      order: { activatedAt: 'DESC' },
    });
  }
}
