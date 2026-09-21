/**
 * JA-050 — Employer Intelligence
 *
 * doneWhen: "Employer information safely influences decisions."
 *
 * Tracks employer identity/domain, ATS, channel, response behavior, outcomes
 * and repost patterns. Uses evidence-backed signals.
 */

import { Injectable } from '@nestjs/common';

export interface EmployerSignal {
  id?: string;
  employerName?: string;
  employerDomain?: string;
  ats?: string;
  channel?: string;
  firstSeen: string;
  lastSeen: string;
  applicationCount: number;
  interviewCount: number;
  offerCount: number;
  rejectionCount: number;
  repostCount: number;
  responseRate: number;
  offerRate: number;
  riskLevel: 'low' | 'medium' | 'high' | 'unknown';
  notes?: string;
}

export interface EmployerDecision {
  employerName: string;
  riskLevel: string;
  signals: string[];
  recommendation: string;
  rational: string;
}

@Injectable()
export class EmployerIntelligenceService {
  recordApplication(employer: Partial<EmployerSignal>): EmployerSignal {
    const now = new Date().toISOString();
    return {
      ...employer,
      firstSeen: employer.firstSeen || now,
      lastSeen: now,
      applicationCount: (employer.applicationCount || 0) + 1,
      interviewCount: employer.interviewCount || 0,
      offerCount: employer.offerCount || 0,
      rejectionCount: employer.rejectionCount || 0,
      repostCount: employer.repostCount || 0,
      responseRate: 0,
      offerRate: 0,
      riskLevel: 'unknown',
    } as EmployerSignal;
  }

  recordOutcome(employer: EmployerSignal, outcome: 'interview' | 'offer' | 'rejection' | 'viewed'): EmployerSignal {
    const e = { ...employer };
    if (outcome === 'interview') e.interviewCount = (e.interviewCount || 0) + 1;
    if (outcome === 'offer') e.offerCount = (e.offerCount || 0) + 1;
    if (outcome === 'rejection') e.rejectionCount = (e.rejectionCount || 0) + 1;
    const total = e.applicationCount || 1;
    e.responseRate = (e.interviewCount + e.offerCount) / total;
    e.offerRate = e.offerCount / total;
    e.lastSeen = new Date().toISOString();
    e.riskLevel = this.computeRiskLevel(e);
    return e;
  }

  computeRiskLevel(employer: EmployerSignal): 'low' | 'medium' | 'high' | 'unknown' {
    if (!employer.applicationCount || employer.applicationCount < 3) return 'unknown';
    if (employer.offerCount > 0) return 'low';
    if (employer.interviewCount > 0 && employer.applicationCount >= 5) return 'low';
    if (employer.rejectionCount > employer.applicationCount * 0.8) return 'high';
    if (employer.repostCount > 2) return 'medium';
    if (employer.applicationCount >= 5 && employer.interviewCount === 0) return 'medium';
    return 'unknown';
  }

  assess(employer: EmployerSignal): EmployerDecision {
    const signals: string[] = [];
    if (employer.applicationCount >= 3) signals.push(`${employer.applicationCount} applications tracked`);
    if (employer.interviewCount > 0) signals.push(`${employer.interviewCount} interviews`);
    if (employer.offerCount > 0) signals.push(`${employer.offerCount} offers — positive signal`);
    if (employer.rejectionCount > employer.applicationCount * 0.7) signals.push('high rejection rate');
    if (employer.repostCount > 1) signals.push(`${employer.repostCount} reposts — may indicate churn`);

    let riskLevel = this.computeRiskLevel(employer);
    let recommendation: string;
    let rational: string;

    if (riskLevel === 'low') {
      recommendation = 'safe_to_apply';
      rational = 'Employer has positive outcomes (offers/interviews) — safe to apply';
    } else if (riskLevel === 'medium') {
      recommendation = 'apply_with_caution';
      rational = 'Limited data or mixed signals — apply with awareness';
    } else if (riskLevel === 'high') {
      recommendation = 'avoid_or_flag';
      rational = 'High rejection rate or suspicious patterns — flag for review';
    } else {
      recommendation = 'collect_more_data';
      rational = 'Insufficient data — continue tracking before making judgment';
    }

    return { employerName: employer.employerName || 'Unknown', riskLevel, signals, recommendation, rational };
  }
}
