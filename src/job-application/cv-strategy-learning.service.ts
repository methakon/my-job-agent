/**
 * JA-062 — CV Strategy Learning
 *
 * doneWhen: "Future strategy selection uses measured historical performance."
 */

import { Injectable } from '@nestjs/common';

export interface CVStrategyOutcome {
  id?: string;
  strategy: string;
  role?: string;
  industry?: string;
  seniority?: string;
  channel?: string;
  outcome?: 'applied' | 'interview' | 'offer' | 'rejected' | 'accepted';
  outcomeAt?: string;
  trackedAt: string;
}

export interface StrategyPerformance {
  strategy: string;
  totalUses: number;
  byOutcome: Record<string, number>;
  interviewRate: number;
  offerRate: number;
  acceptanceRate: number;
  byRole: Record<string, number>;
  byChannel: Record<string, number>;
  sampleSizeWarning: boolean;
}

@Injectable()
export class CVStrategyLearningService {
  private outcomes: Map<string, CVStrategyOutcome> = new Map();

  record(outcome: Partial<CVStrategyOutcome>): CVStrategyOutcome {
    const now = new Date().toISOString();
    const o: CVStrategyOutcome = {
      id: outcome.id || `strat-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      strategy: outcome.strategy || 'unknown',
      role: outcome.role,
      industry: outcome.industry,
      seniority: outcome.seniority,
      channel: outcome.channel,
      outcome: outcome.outcome,
      outcomeAt: outcome.outcomeAt,
      trackedAt: now,
    };
    this.outcomes.set(o.id || "x", o);
    return o;
  }

  getPerformance(strategy: string): StrategyPerformance {
    const list = Array.from(this.outcomes.values()).filter(o => o.strategy === strategy);
    const byOutcome: Record<string, number> = {};
    const byRole: Record<string, number> = {};
    const byChannel: Record<string, number> = {};

    for (const o of list) {
      byOutcome[o.outcome || 'applied'] = (byOutcome[o.outcome || 'applied'] || 0) + 1;
      if (o.role) byRole[o.role] = (byRole[o.role] || 0) + 1;
      if (o.channel) byChannel[o.channel] = (byChannel[o.channel] || 0) + 1;
    }

    const total = list.length;
    const interviews = (byOutcome['interview'] || 0);
    const offers = (byOutcome['offer'] || 0);
    const accepts = (byOutcome['accepted'] || 0);

    return {
      strategy,
      totalUses: total,
      byOutcome,
      interviewRate: total > 0 ? interviews / total : 0,
      offerRate: total > 0 ? offers / total : 0,
      acceptanceRate: offers > 0 ? accepts / offers : 0,
      byRole,
      byChannel,
      sampleSizeWarning: total < 5,
    };
  }

  getAllPerformances(): StrategyPerformance[] {
    const strategies = new Set(Array.from(this.outcomes.values()).map(o => o.strategy));
    return Array.from(strategies).map(s => this.getPerformance(s));
  }

  getCount(): number {
    return this.outcomes.size;
  }
}
