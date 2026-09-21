/**
 * JA-052 — Rejection Learning
 *
 * doneWhen: "Rejection outcomes update controlled learning features."
 */

import { Injectable } from '@nestjs/common';

export interface RejectionRecord {
  id?: string;
  candidateId?: string;
  jobLeadId?: string;
  employerName?: string;
  role?: string;
  channel?: string;
  rejectedAt: string;
  rejectionStage?: 'screening' | 'interview' | 'offer' | 'application';
  reason?: string;
  cvStrategy?: string;
  qualificationScore?: number;
  tagged?: boolean;
  recordedAt: string;
}

export interface RejectionAggregate {
  employerName?: string;
  totalRejections: number;
  byStage: Record<string, number>;
  byChannel: Record<string, number>;
  byRole: Record<string, number>;
  topReasons: string[];
  avgDaysToRejection: number;
}

@Injectable()
export class RejectionLearningService {
  private rejections: Map<string, RejectionRecord> = new Map();

  record(rejection: Partial<RejectionRecord>): RejectionRecord {
    const now = new Date().toISOString();
    const r: RejectionRecord = {
      ...rejection,
      id: rejection.id || `rej-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      rejectedAt: rejection.rejectedAt || now,
      recordedAt: now,
      rejectionStage: rejection.rejectionStage || 'application',
      tagged: false,
    };
    this.rejections.set(r.id || 'x', r);
    return r;
  }

  aggregate(filters?: { employerName?: string; channel?: string; role?: string }): RejectionAggregate {
    const list = Array.from(this.rejections.values());
    let filtered = list;
    if (filters?.employerName) filtered = filtered.filter(r => r.employerName === filters.employerName);
    if (filters?.channel) filtered = filtered.filter(r => r.channel === filters.channel);
    if (filters?.role) filtered = filtered.filter(r => r.role === filters.role);

    const byStage: Record<string, number> = {};
    const byChannel: Record<string, number> = {};
    const byRole: Record<string, number> = {};
    const reasons: string[] = [];

    for (const r of filtered) {
      const stage = r.rejectionStage || 'application';
      const channel = r.channel || 'unknown';
      const role = r.role || 'unknown';
      byStage[stage] = (byStage[stage] || 0) + 1;
      byChannel[channel] = (byChannel[channel] || 0) + 1;
      byRole[role] = (byRole[role] || 0) + 1;
      if (r.reason) reasons.push(r.reason);
    }

    let totalDays = 0;
    let daysCount = 0;
    const now = new Date();
    for (const r of filtered) {
      if (r.rejectedAt) {
        const d = new Date(r.rejectedAt);
        totalDays += (now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24);
        daysCount++;
      }
    }

    const freq = new Map<string, number>();
    for (const reason of reasons) freq.set(reason, (freq.get(reason) || 0) + 1);
    const topReasons = Array.from(freq.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([reason]) => reason);

    return {
      employerName: filters?.employerName,
      totalRejections: filtered.length,
      byStage,
      byChannel,
      byRole,
      topReasons,
      avgDaysToRejection: daysCount > 0 ? totalDays / daysCount : 0,
    };
  }

  getRejection(id: string): RejectionRecord | undefined {
    return this.rejections.get(id);
  }

  listRejections(): RejectionRecord[] {
    return Array.from(this.rejections.values());
  }

  getCount(): number {
    return this.rejections.size;
  }

  isTagged(id: string): boolean {
    return this.rejections.get(id)?.tagged === true;
  }
}
