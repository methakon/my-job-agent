/**
 * JA-071 — Portal Status Polling
 *
 * doneWhen: "Portal status changes are detected and recorded without spamming portals."
 */

import { Injectable } from '@nestjs/common';

export type PortalType = 'linkedin' | 'indeed' | 'glassdoor' | 'company_portal' | 'recruiter_email' | 'other';
export type PortalStatus = 'applied' | 'viewed' | 'screening' | 'interview' | 'offer' | 'rejected' | 'accepted' | 'withdrawn' | 'pending' | 'unknown';

export interface PortalApplication {
  id?: string;
  applicationId: string;
  portal: PortalType;
  jobTitle?: string;
  company?: string;
  appliedAt?: string;
  lastStatus?: PortalStatus;
  lastChecked?: string;
  statusHistory: { status: PortalStatus; at: string }[];
  externalId?: string;
}

export interface PollResult {
  applicationId: string;
  portal: PortalType;
  status: PortalStatus;
  changed: boolean;
  previousStatus?: PortalStatus;
  checkedAt: string;
  errorCode?: string;
  rateLimited: boolean;
  nextPollDelay: number;
}

@Injectable()
export class PortalStatusPollingService {
  private applications: Map<string, PortalApplication> = new Map();
  private pollHistory: Map<string, PollResult[]> = new Map();
  private rateLimits: Map<string, number> = new Map();
  private minPollInterval = 300_000; // 5 minutes

  register(app: Partial<PortalApplication>): PortalApplication {
    const now = new Date().toISOString();
    const a: PortalApplication = {
      id: app.id || `portal-app-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      applicationId: app.applicationId || `app-${Date.now()}`,
      portal: app.portal || 'other',
      jobTitle: app.jobTitle,
      company: app.company,
      appliedAt: app.appliedAt || now,
      lastStatus: app.lastStatus || 'pending',
      lastChecked: now,
      statusHistory: app.statusHistory || [],
      externalId: app.externalId,
    };
    if (!a.statusHistory.some(h => h.status === a.lastStatus)) {
      a.statusHistory.push({ status: a.lastStatus || "unknown", at: now });
    }
    this.applications.set(a.id || "x", a);
    return a;
  }

  poll(applicationId: string, portal: PortalType, simulateStatus?: PortalStatus): PollResult {
    const now = new Date().toISOString();
    const app = this.applications.get(applicationId);
    const key = `${applicationId}::${portal}`;
    const lastPoll = this.pollHistory.get(key) || [];
    const lastResult = lastPoll[lastPoll.length - 1];
    const nextPoll = lastResult ? lastResult.nextPollDelay : this.minPollInterval;

    const timeSinceLast = lastResult ? (Date.now() - new Date(lastResult.checkedAt).getTime()) : Infinity;
    const rateLimited = timeSinceLast < nextPoll;

    let status = lastResult?.status || 'unknown';
    let changed = false;
    let previousStatus = lastResult?.status;

    if (rateLimited) {
      return {
        applicationId, portal,
        status: lastResult?.status || 'unknown',
        changed: false,
        checkedAt: now,
        rateLimited: true,
        nextPollDelay: nextPoll - timeSinceLast,
      };
    }

    if (simulateStatus) {
      status = simulateStatus;
    }

    if (app) {
      app.lastStatus = status;
      app.lastChecked = now;
    }

    if (status !== previousStatus) {
      changed = true;
      if (app) {
        app.statusHistory.push({ status, at: now });
      }
    }

    const result: PollResult = {
      applicationId, portal,
      status,
      changed,
      previousStatus: previousStatus !== status ? previousStatus : undefined,
      checkedAt: now,
      rateLimited: false,
      nextPollDelay: this.calculateBackoff(lastPoll.length, changed),
    };

    if (!this.pollHistory.has(key)) this.pollHistory.set(key, []);
    this.pollHistory.get(key)!.push(result);

    return result;
  }

  private calculateBackoff(pollCount: number, changed: boolean): number {
    const base = changed ? 60_000 : this.minPollInterval;
    const cap = 24 * 60 * 60 * 1000; // 24 hours
    const backoff = Math.min(base * Math.pow(1.5, pollCount), cap);
    return Math.floor(backoff);
  }

  getApplication(id: string): PortalApplication | undefined {
    return this.applications.get(id);
  }

  getApplicationsByPortal(portal: PortalType): PortalApplication[] {
    return Array.from(this.applications.values())
      .filter(a => a.portal === portal)
      .sort((a, b) => (b.lastChecked || '').localeCompare(a.lastChecked || ''));
  }

  getPollHistory(applicationId: string, portal: PortalType): PollResult[] {
    return this.pollHistory.get(`${applicationId}::${portal}`) || [];
  }

  getPendingPolls(): { applicationId: string; portal: PortalType; nextPollAt: string }[] {
    const now = Date.now();
    const results: { applicationId: string; portal: PortalType; nextPollAt: string }[] = [];
    for (const [key, history] of this.pollHistory.entries()) {
      const last = history[history.length - 1];
      if (!last) continue;
      const [applicationId, portal] = key.split('::');
      const nextPollAt = new Date(last.checkedAt).getTime() + last.nextPollDelay;
      if (now >= nextPollAt) {
        results.push({ applicationId, portal: portal as PortalType, nextPollAt: new Date(nextPollAt).toISOString() });
      }
    }
    return results;
  }

  getCount(): number {
    return this.applications.size;
  }

  setMinPollInterval(ms: number): void {
    this.minPollInterval = Math.max(60_000, ms);
  }
}
