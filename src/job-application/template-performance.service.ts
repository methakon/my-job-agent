/**
 * JA-061 — Template Performance
 *
 * doneWhen: "Template performance is measurable and responsibly interpreted."
 */

import { Injectable } from '@nestjs/common';

export interface TemplatePerformanceEntry {
  id?: string;
  templateId: string;
  templateVersion: string;
  applicationId?: string;
  outcome?: 'applied' | 'viewed' | 'screening' | 'interview' | 'offer' | 'rejected' | 'accepted' | 'withdrawn';
  outcomeAt?: string;
  channel?: string;
  trackedAt: string;
}

export interface TemplatePerformanceReport {
  templateId: string;
  templateVersion: string;
  totalUses: number;
  byOutcome: Record<string, number>;
  interviewRate: number;
  offerRate: number;
  acceptanceRate: number;
  avgTimeToOutcome: number;
  sampleSizeWarning: boolean;
}

@Injectable()
export class TemplatePerformanceService {
  private entries: Map<string, TemplatePerformanceEntry> = new Map();

  track(entry: Partial<TemplatePerformanceEntry>): TemplatePerformanceEntry {
    const now = new Date().toISOString();
    const id = entry.id || `tpl-perf-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const e: TemplatePerformanceEntry = {
      templateId: entry.templateId || 'unknown',
      templateVersion: entry.templateVersion || 'unknown',
      applicationId: entry.applicationId !== undefined ? entry.applicationId : undefined,
      outcome: entry.outcome,
      outcomeAt: entry.outcomeAt,
      channel: entry.channel,
      trackedAt: now,
      id,
    };
    this.entries.set(id, e);
    return e;
  }

  getReport(templateId: string): TemplatePerformanceReport {
    const list = Array.from(this.entries.values())
      .filter(e => e.templateId === templateId);

    const byOutcome: Record<string, number> = {};
    let totalDays = 0, daysCount = 0;
    const now = new Date();

    for (const e of list) {
      byOutcome[e.outcome || 'applied'] = (byOutcome[e.outcome || 'applied'] || 0) + 1;
      if (e.outcomeAt) {
        const d = new Date(e.outcomeAt);
        totalDays += (now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24);
        daysCount++;
      }
    }

    const total = list.length;
    const interviews = (byOutcome['interview'] || 0) + (byOutcome['screening'] || 0);
    const offers = byOutcome['offer'] || 0;
    const accepts = byOutcome['accepted'] || 0;

    return {
      templateId,
      templateVersion: 'unknown',
      totalUses: total,
      byOutcome,
      interviewRate: total > 0 ? interviews / total : 0,
      offerRate: total > 0 ? offers / total : 0,
      acceptanceRate: offers > 0 ? accepts / offers : 0,
      avgTimeToOutcome: daysCount > 0 ? totalDays / daysCount : 0,
      sampleSizeWarning: total < 5,
    };
  }

  getReportByVersion(templateId: string, version: string): TemplatePerformanceReport {
    const list = Array.from(this.entries.values())
      .filter(e => e.templateId === templateId);
    const base = this.getReport(templateId);
    base.templateVersion = version;
    base.totalUses = list.length;
    base.sampleSizeWarning = list.length < 5;
    return base;
  }

  getCount(): number {
    return this.entries.size;
  }

  getByTemplate(templateId: string): TemplatePerformanceEntry[] {
    return Array.from(this.entries.values())
      .filter(e => e.templateId === templateId)
      .sort((a, b) => b.trackedAt.localeCompare(a.trackedAt));
  }
}
