/**
 * JA-081 — Decision and Explanation UI
 *
 * doneWhen: "Score breakdown and key drivers are visible for each decision."
 */

import { Injectable } from '@nestjs/common';

export interface DecisionExplanation {
  id: string;
  applicationId: string;
  jobLeadId?: string;
  decision: 'proceed' | 'hold' | 'reject' | 'escalate';
  overallScore: number;
  breakdown: ScoreBreakdown[];
  keyDrivers: string[];
  concerns: string[];
  recommendations: string[];
  explanation: string;
  generatedAt: string;
}

export interface ScoreBreakdown {
  category: string;
  weight: number;
  rawScore: number;
  weightedScore: number;
  details?: string[];
}

@Injectable()
export class DecisionExplanationUIService {
  private explanations: Map<string, DecisionExplanation> = new Map();

  generate(
    applicationId: string,
    scores: Record<string, number>,
    weights: Record<string, number>,
    jobLeadId?: string,
    notes?: string[],
  ): DecisionExplanation {
    const now = new Date().toISOString();
    const breakdown: ScoreBreakdown[] = [];
    let totalWeighted = 0;
    let totalWeight = 0;

    for (const [category, weight] of Object.entries(weights)) {
      const rawScore = scores[category] ?? 50;
      const weightedScore = rawScore * weight;
      totalWeighted += weightedScore;
      totalWeight += weight;
      breakdown.push({
        category,
        weight,
        rawScore,
        weightedScore: Math.round(weightedScore * 10) / 10,
        details: notes ? notes.filter((_, i) => i % 2 === 0) : undefined,
      });
    }

    const overallScore = totalWeight > 0 ? Math.round((totalWeighted / totalWeight) * 10) / 10 : 0;

    const keyDrivers: string[] = breakdown
      .filter(b => b.weightedScore > 10)
      .sort((a, b) => b.weightedScore - a.weightedScore)
      .slice(0, 3)
      .map(b => `${b.category}: ${b.rawScore}/100 (weight: ${b.weight})`);

    const concerns: string[] = breakdown
      .filter(b => b.rawScore < 40)
      .map(b => `${b.category} score is ${b.rawScore}/100 — below threshold`);

    const recommendations: string[] = [];
    if (overallScore >= 70) recommendations.push('Strong candidate — proceed to next stage');
    else if (overallScore >= 50) recommendations.push('Moderate fit — consider for hold or further review');
    else if (overallScore >= 30) recommendations.push('Weak fit — likely reject unless specific needs');
    else recommendations.push('Poor fit — recommend rejection');

    if (concerns.length) recommendations.push('Address concerns before proceeding');

    let decision: 'proceed' | 'hold' | 'reject' | 'escalate' = 'reject';
    if (overallScore >= 75) decision = 'proceed';
    else if (overallScore >= 55) decision = 'hold';
    else if (overallScore >= 40 && concerns.length <= 1) decision = 'escalate';

    const explanation = `Overall score: ${overallScore}/100. ${decision.toUpperCase()}. ${keyDrivers.length ? 'Key drivers: ' + keyDrivers.join(', ') : 'No strong drivers identified.'} ${concerns.length ? 'Concerns: ' + concerns.join('; ') : 'No major concerns.'}`;

    const id = `expl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const d: DecisionExplanation = {
      id,
      applicationId,
      jobLeadId: jobLeadId || undefined,
      decision,
      overallScore,
      breakdown,
      keyDrivers,
      concerns,
      recommendations,
      explanation,
      generatedAt: now,
    };

    this.explanations.set(id, d);
    return d;
  }

  getExplanation(id: string): DecisionExplanation | undefined {
    return this.explanations.get(id);
  }

  getByApplication(applicationId: string): DecisionExplanation | undefined {
    return Array.from(this.explanations.values())
      .find(e => e.applicationId === applicationId);
  }

  getDecisions(): Array<{
    id: string;
    applicationId: string;
    decision: string;
    overallScore: number;
    generatedAt: string;
  }> {
    return Array.from(this.explanations.values())
      .map(e => ({
        id: e.id,
        applicationId: e.applicationId,
        decision: e.decision,
        overallScore: e.overallScore,
        generatedAt: e.generatedAt,
      }))
      .sort((a, b) => b.generatedAt.localeCompare(a.generatedAt));
  }

  getCount(): number {
    return this.explanations.size;
  }

  getStats(): { total: number; byDecision: Record<string, number>; avgScore: number } {
    const byDecision: Record<string, number> = {};
    let totalScore = 0;
    for (const e of this.explanations.values()) {
      byDecision[e.decision] = (byDecision[e.decision] || 0) + 1;
      totalScore += e.overallScore;
    }
    return {
      total: this.explanations.size,
      byDecision,
      avgScore: this.explanations.size > 0 ? totalScore / this.explanations.size : 0,
    };
  }
}
