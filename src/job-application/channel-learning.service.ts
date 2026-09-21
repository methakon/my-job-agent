/**
 * JA-040 — Channel Learning
 *
 * doneWhen: "Historical channel performance affects future channel selection."
 *
 * Tracks ATS, direct HR email, recruiter, easy apply and portal outcomes.
 * Computes channel effectiveness scores for informed channel selection.
 */

import { Injectable } from '@nestjs/common';
import { CandidateProfile } from '../profile/candidate-profile.entity';

export interface ChannelOutcome {
  id?: string;
  candidateId?: string;
  jobLeadId?: string;
  channel: 'ats' | 'direct_email' | 'recruiter' | 'easy_apply' | 'portal' | 'referral' | 'other';
  status: 'applied' | 'viewed' | 'screening' | 'interview' | 'offer' | 'rejected' | 'withdrawn';
  rejectedAt?: string;
  rejectedReason?: string;
  interviewedAt?: string;
  offeredAt?: string;
  acceptedAt?: string;
  appliedAt: string;
  recordedAt: string;
}

export interface ChannelStat {
  channel: string;
  appliedCount: number;
  interviewCount: number;
  offerCount: number;
  rejectionCount: number;
  interviewRate: number;
  offerRate: number;
  effectivenessScore: number;
}

export interface ChannelSelection {
  recommendedChannel: string;
  scores: Record<string, number>;
  rational: string;
}

@Injectable()
export class ChannelLearningService {
  async recordOutcome(outcome: ChannelOutcome): Promise<ChannelOutcome> {
    outcome.recordedAt = new Date().toISOString();
    if (!outcome.appliedAt) outcome.appliedAt = outcome.recordedAt;
    return outcome;
  }

  selectChannel(
    channelStats: ChannelStat[],
    context: { role?: string; seniority?: string; skills?: string },
  ): ChannelSelection {
    if (!channelStats || channelStats.length === 0) {
      return {
        recommendedChannel: 'ats',
        scores: { ats: 0.5, direct_email: 0.3, recruiter: 0.4, easy_apply: 0.2, portal: 0.2, referral: 0.3, other: 0.1 },
        rational: 'No historical data — default to ATS as baseline',
      };
    }

    const scores: Record<string, number> = {};
    let bestChannel = channelStats[0].channel;
    let bestScore = 0;

    for (const stat of channelStats) {
      const score = stat.effectivenessScore;
      scores[stat.channel] = score;
      if (score > bestScore) { bestScore = score; bestChannel = stat.channel; }
    }

    return {
      recommendedChannel: bestChannel,
      scores,
      rational: `Channel "${bestChannel}" has highest effectiveness score (${bestScore.toFixed(3)}) based on ${channelStats.length} channel(s) tracked`,
    };
  }

  computeStats(outcomes: ChannelOutcome[]): ChannelStat[] {
    const grouped = new Map<string, ChannelOutcome[]>();
    for (const o of outcomes) {
      if (!grouped.has(o.channel)) grouped.set(o.channel, []);
      grouped.get(o.channel)!.push(o);
    }

    const stats: ChannelStat[] = [];
    for (const [channel, outcomes] of grouped) {
      const appliedCount = outcomes.filter(o => o.status === 'applied').length;
      const interviewCount = outcomes.filter(o => o.status === 'interview').length;
      const offerCount = outcomes.filter(o => o.status === 'offer').length;
      const rejectionCount = outcomes.filter(o => o.status === 'rejected').length;
      const total = outcomes.length || 1;

      stats.push({
        channel,
        appliedCount,
        interviewCount,
        offerCount,
        rejectionCount,
        interviewRate: interviewCount / total,
        offerRate: offerCount / total,
        effectivenessScore: (interviewCount + offerCount * 2) / (total + 1),
      });
    }

    return stats.sort((a, b) => b.effectivenessScore - a.effectivenessScore);
  }
}
