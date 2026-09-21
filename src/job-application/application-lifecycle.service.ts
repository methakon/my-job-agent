/**
 * JA-070 — Application Lifecycle
 *
 * doneWhen: "Application lifecycle tracking covers applied → viewed → screening → interview → offer → accepted/rejected."
 */

import { Injectable } from '@nestjs/common';

export type LifecycleStage = 'applied' | 'viewed' | 'screening' | 'interview' | 'offer' | 'accepted' | 'rejected' | 'withdrawn';

export interface LifecycleEvent {
  id?: string;
  applicationId: string;
  jobLeadId?: string;
  stage: LifecycleStage;
  timestamp: string;
  source?: string;
  notes?: string;
}

export interface ApplicationLifecycle {
  applicationId: string;
  currentStage: LifecycleStage;
  stageHistory: LifecycleEvent[];
  daysInStage: number;
  totalDays: number;
  stalled: boolean;
}

export interface LifecycleSummary {
  totalApplications: number;
  byCurrentStage: Record<string, number>;
  byChannel: Record<string, number>;
  stalledCount: number;
  avgDaysToInterview: number;
  avgDaysToOffer: number;
}

@Injectable()
export class ApplicationLifecycleService {
  private events: Map<string, LifecycleEvent[]> = new Map();

  record(event: Partial<LifecycleEvent>): LifecycleEvent {
    const appId = event.applicationId || `app-${Date.now()}`;
    const ts = event.timestamp || new Date().toISOString();
    const e: LifecycleEvent = {
      id: event.id || `${appId}-${ts}`,
      applicationId: appId,
      jobLeadId: event.jobLeadId,
      stage: event.stage || 'applied',
      timestamp: ts,
      source: event.source,
      notes: event.notes,
    };
    if (!this.events.has(appId)) this.events.set(appId, []);
    this.events.get(appId)!.push(e);
    this.events.get(appId)!.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    return e;
  }

  getLifecycle(applicationId: string): ApplicationLifecycle | undefined {
    const events = this.events.get(applicationId);
    if (!events || events.length === 0) return undefined;

    const currentStage = events[events.length - 1].stage;
    const now = new Date();
    const lastEvent = new Date(events[events.length - 1].timestamp);
    const firstEvent = new Date(events[0].timestamp);

    return {
      applicationId,
      currentStage,
      stageHistory: events,
      daysInStage: (now.getTime() - lastEvent.getTime()) / (1000 * 60 * 60 * 24),
      totalDays: (now.getTime() - firstEvent.getTime()) / (1000 * 60 * 60 * 24),
      stalled: (now.getTime() - lastEvent.getTime()) / (1000 * 60 * 60 * 24) > 14,
    };
  }

  getSummary(): LifecycleSummary {
    const appIds = Array.from(this.events.keys());
    const byStage: Record<string, number> = {};
    const byChannel: Record<string, number> = {};
    let stalled = 0;
    let daysToInterview = 0, daysToInterviewCount = 0;
    let daysToOffer = 0, daysToOfferCount = 0;

    for (const appId of appIds) {
      const lc = this.getLifecycle(appId);
      if (!lc) continue;
      byStage[lc.currentStage] = (byStage[lc.currentStage] || 0) + 1;
      const lastEvent = lc.stageHistory[lc.stageHistory.length - 1];
      if (lastEvent?.source) byChannel[lastEvent.source] = (byChannel[lastEvent.source] || 0) + 1;
      if (lc.stalled) stalled++;

      const interviewEvent = lc.stageHistory.find(e => e.stage === 'interview');
      if (interviewEvent) {
        daysToInterview += (new Date(interviewEvent.timestamp).getTime() - new Date(lc.stageHistory[0].timestamp).getTime()) / (1000 * 60 * 60 * 24);
        daysToInterviewCount++;
      }
      const offerEvent = lc.stageHistory.find(e => e.stage === 'offer');
      if (offerEvent) {
        daysToOffer += (new Date(offerEvent.timestamp).getTime() - new Date(lc.stageHistory[0].timestamp).getTime()) / (1000 * 60 * 60 * 24);
        daysToOfferCount++;
      }
    }

    return {
      totalApplications: appIds.length,
      byCurrentStage: byStage,
      byChannel,
      stalledCount: stalled,
      avgDaysToInterview: daysToInterviewCount > 0 ? daysToInterview / daysToInterviewCount : 0,
      avgDaysToOffer: daysToOfferCount > 0 ? daysToOffer / daysToOfferCount : 0,
    };
  }

  getCount(): number {
    return this.events.size;
  }

  getEvents(applicationId: string): LifecycleEvent[] {
    return this.events.get(applicationId) || [];
  }
}
