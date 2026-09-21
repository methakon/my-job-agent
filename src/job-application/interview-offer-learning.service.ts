/**
 * JA-053 — Interview and Offer Learning
 *
 * doneWhen: "Positive outcomes demonstrably feed future scoring."
 */

import { Injectable } from '@nestjs/common';

export interface InterviewRecord {
  id?: string;
  candidateId?: string;
  jobLeadId?: string;
  employerName?: string;
  role?: string;
  channel?: string;
  stages: string[];
  currentStage?: string;
  interviewedAt?: string;
  offerReceivedAt?: string;
  offerAcceptedAt?: string;
  offerRejectedAt?: string;
  salaryOffered?: number;
  notes?: string;
  recordedAt: string;
}

export interface InterviewOutcome {
  interviewCount: number;
  offerCount: number;
  acceptanceCount: number;
  rejectionCount: number;
  interviewToOfferRate: number;
  offerToAcceptRate: number;
  avgStagesReached: number;
}

@Injectable()
export class InterviewOfferLearningService {
  private interviews: Map<string, InterviewRecord> = new Map();

  record(record: Partial<InterviewRecord>): InterviewRecord {
    const now = new Date().toISOString();
    const r: InterviewRecord = {
      ...record,
      id: record.id || `int-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      stages: record.stages || [],
      recordedAt: now,
    };
    this.interviews.set(r.id || 'x', r);
    return r;
  }

  addStage(id: string, stage: string): InterviewRecord | undefined {
    const r = this.interviews.get(id);
    if (!r) return undefined;
    if (!r.stages.includes(stage)) r.stages.push(stage);
    r.currentStage = stage;
    return r;
  }

  recordOffer(id: string, salary?: number): InterviewRecord | undefined {
    const r = this.interviews.get(id);
    if (!r) return undefined;
    r.offerReceivedAt = new Date().toISOString();
    if (salary) r.salaryOffered = salary;
    return r;
  }

  recordAccept(id: string): InterviewRecord | undefined {
    const r = this.interviews.get(id);
    if (!r) return undefined;
    r.offerAcceptedAt = new Date().toISOString();
    return r;
  }

  recordReject(id: string, reason?: string): InterviewRecord | undefined {
    const r = this.interviews.get(id);
    if (!r) return undefined;
    r.offerRejectedAt = new Date().toISOString();
    if (reason) r.notes = reason;
    return r;
  }

  get(id: string): InterviewRecord | undefined {
    return this.interviews.get(id);
  }

  aggregate(): InterviewOutcome {
    const list = Array.from(this.interviews.values());
    let offerCount = 0, acceptCount = 0, rejectCount = 0;
    let totalStages = 0;

    for (const r of list) {
      if (r.stages.length > 0) totalStages += r.stages.length;
      if (r.offerReceivedAt) offerCount++;
      if (r.offerAcceptedAt) acceptCount++;
      if (r.offerRejectedAt) rejectCount++;
    }

    const interviewCount = list.length;
    return {
      interviewCount,
      offerCount,
      acceptanceCount: acceptCount,
      rejectionCount: rejectCount,
      interviewToOfferRate: interviewCount > 0 ? offerCount / interviewCount : 0,
      offerToAcceptRate: offerCount > 0 ? acceptCount / offerCount : 0,
      avgStagesReached: interviewCount > 0 ? totalStages / interviewCount : 0,
    };
  }

  getCount(): number {
    return this.interviews.size;
  }
}
