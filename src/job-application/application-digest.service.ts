/**
 * JA-082 — Application Digest
 *
 * doneWhen: "Daily/weekly digests summarize application state, recent changes, and next actions."
 */

import { Injectable } from '@nestjs/common';

export type DigestFrequency = 'daily' | 'weekly' | 'custom';
export type DigestFormat = 'summary' | 'detailed' | 'action_items';

export interface ApplicationDigestEntry {
  id?: string;
  applicationId: string;
  jobTitle?: string;
  company?: string;
  currentStage: string;
  daysInStage: number;
  lastUpdate?: string;
  nextAction?: string;
  priority: 'high' | 'medium' | 'low';
  score: number;
}

export interface ApplicationDigest {
  id: string;
  applicationIds: string[];
  frequency: DigestFrequency;
  format: DigestFormat;
  generatedAt: string;
  periodStart?: string;
  periodEnd?: string;
  totalApplications: number;
  byStage: Record<string, number>;
  byPriority: Record<string, number>;
  highPriorityCount: number;
  needsActionCount: number;
  stalledCount: number;
  entries: ApplicationDigestEntry[];
  summary: string;
}

@Injectable()
export class ApplicationDigestService {
  private applications: Map<string, ApplicationDigestEntry> = new Map();
  private digests: Map<string, ApplicationDigest> = new Map();

  addApplication(entry: Partial<ApplicationDigestEntry>): ApplicationDigestEntry {
    const now = new Date().toISOString();
    const id = entry.id || `app-digest-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const e: ApplicationDigestEntry = {
      id,
      applicationId: entry.applicationId || `app-${Date.now()}`,
      jobTitle: entry.jobTitle,
      company: entry.company,
      currentStage: entry.currentStage || 'applied',
      daysInStage: entry.daysInStage || 0,
      lastUpdate: entry.lastUpdate || now,
      nextAction: entry.nextAction,
      priority: entry.priority || 'medium',
      score: entry.score || 50,
    };
    this.applications.set(e.id || 'x', e);
    return e;
  }

  generate(frequency: DigestFrequency, format: DigestFormat, applicationIds?: string[]): ApplicationDigest {
    const now = new Date();
    const periodEnd = now.toISOString();
    const periodStart = frequency === 'daily'
      ? new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()
      : frequency === 'weekly'
        ? new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString()
        : undefined;

    const ids = applicationIds || Array.from(this.applications.keys());
    const entries = ids.map(id => this.applications.get(id)).filter(Boolean) as ApplicationDigestEntry[];

    const byStage: Record<string, number> = {};
    const byPriority: Record<string, number> = {};
    let stalled = 0;
    let needsAction = 0;

    for (const e of entries) {
      byStage[e.currentStage] = (byStage[e.currentStage] || 0) + 1;
      byPriority[e.priority] = (byPriority[e.priority] || 0) + 1;
      if (e.daysInStage > 14) stalled++;
      if (e.nextAction) needsAction++;
    }

    const highPriority = byPriority['high'] || 0;
    const total = entries.length;

    let summary = '';
    if (format === 'summary') {
      summary = `Digest: ${total} applications tracked. ` +
        `High priority: ${highPriority}. ` +
        `Stages: ${Object.entries(byStage).map(([k, v]) => `${k}: ${v}`).join(', ') || 'none'}. ` +
        (stalled > 0 ? `${stalled} stalled (>14 days).` : 'No stalled applications.') +
        (needsAction > 0 ? `${needsAction} need action.` : '');
    } else if (format === 'detailed') {
      summary = `Detailed digest: ${total} applications across ${Object.keys(byStage).length} stages. ` +
        `Priority breakdown: High=${highPriority}, Medium=${byPriority['medium'] || 0}, Low=${byPriority['low'] || 0}.`;
    } else {
      summary = `Action items: ${needsAction} applications require follow-up. ` +
        `Stalled: ${stalled} — review recommended. ` +
        `Top priority: ${entries.filter(e => e.priority === 'high').map(e => e.company || e.jobTitle || 'Unknown').join(', ') || 'none'}.`;
    }

    const digest: ApplicationDigest = {
      id: `digest-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      applicationIds: ids,
      frequency,
      format,
      generatedAt: now.toISOString(),
      periodStart,
      periodEnd,
      totalApplications: total,
      byStage,
      byPriority,
      highPriorityCount: highPriority,
      needsActionCount: needsAction,
      stalledCount: stalled,
      entries,
      summary,
    };

    this.digests.set(digest.id, digest);
    return digest;
  }

  getDigest(id: string): ApplicationDigest | undefined {
    return this.digests.get(id);
  }

  getRecentDigests(limit: number = 10): ApplicationDigest[] {
    return Array.from(this.digests.values())
      .sort((a, b) => b.generatedAt.localeCompare(a.generatedAt))
      .slice(0, limit);
  }

  getApplications(): ApplicationDigestEntry[] {
    return Array.from(this.applications.values())
      .sort((a, b) => b.score - a.score);
  }

  getByStage(stage: string): ApplicationDigestEntry[] {
    return Array.from(this.applications.values())
      .filter(e => e.currentStage === stage);
  }

  getHighPriority(): ApplicationDigestEntry[] {
    return Array.from(this.applications.values())
      .filter(e => e.priority === 'high')
      .sort((a, b) => b.score - a.score);
  }

  getCount(): number {
    return this.applications.size;
  }

  getDigestCount(): number {
    return this.digests.size;
  }
}
