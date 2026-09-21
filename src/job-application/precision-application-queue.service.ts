/**
 * JA-080 — Precision Application Queue
 *
 * doneWhen: "Applications are ordered by real-time opportunity score."
 */

import { Injectable } from '@nestjs/common';

export interface QueuedApplication {
  id?: string;
  applicationId: string;
  jobLeadId?: string;
  jobTitle?: string;
  company?: string;
  channel?: string;
  appliedAt?: string;
  target?: 'speed' | 'quality' | 'balanced';
  opportunityScore: number;
  priority: 'high' | 'medium' | 'low';
  tags?: string[];
  notes?: string;
  queuedAt: string;
  lastReorderedAt?: string;
}

export interface QueueSummary {
  total: number;
  byPriority: Record<string, number>;
  byTarget: Record<string, number>;
  avgScore: number;
  highPriorityCount: number;
  needsReview: number;
}

@Injectable()
export class PrecisionApplicationQueueService {
  private queue: Map<string, QueuedApplication> = new Map();

  enqueue(app: Partial<QueuedApplication>): QueuedApplication {
    const now = new Date().toISOString();
    const q: QueuedApplication = {
      ...app,
      id: app.id || `queue-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      applicationId: app.applicationId || `app-${Date.now()}`,
      opportunityScore: app.opportunityScore || this.calculateScore(app),
      priority: app.priority || this.inferPriority(app.opportunityScore || 0),
      queuedAt: app.queuedAt || now,
      target: app.target || 'balanced',
      tags: app.tags || [],
    };
    this.queue.set(q.id || "x", q);
    this.reorder();
    return q;
  }

  private calculateScore(app: Partial<QueuedApplication>): number {
    const recency = app.appliedAt ? Math.min(1, (Date.now() - new Date(app.appliedAt).getTime()) / (7 * 24 * 60 * 60 * 1000)) : 0.5;
    const score = app.opportunityScore || 0;
    return Math.round((score * 0.7 + (1 - recency) * 30) * 10) / 10;
  }

  private inferPriority(score: number): 'high' | 'medium' | 'low' {
    if (score >= 70) return 'high';
    if (score >= 40) return 'medium';
    return 'low';
  }

  reorder(): void {
    const now = new Date().toISOString();
    for (const q of this.queue.values()) {
      q.opportunityScore = this.calculateScore(q);
      q.priority = this.inferPriority(q.opportunityScore);
      q.lastReorderedAt = now;
    }
  }

  getQueue(): QueuedApplication[] {
    return Array.from(this.queue.values())
      .sort((a, b) => b.opportunityScore - a.opportunityScore);
  }

  getByPriority(priority: string): QueuedApplication[] {
    return this.getQueue().filter(q => q.priority === priority);
  }

  getByTarget(target: string): QueuedApplication[] {
    return this.getQueue().filter(q => q.target === target);
  }

  getById(id: string): QueuedApplication | undefined {
    return this.queue.get(id);
  }

  updateScore(id: string, newScore: number): QueuedApplication | undefined {
    const q = this.queue.get(id);
    if (!q) return undefined;
    q.opportunityScore = newScore;
    q.priority = this.inferPriority(newScore);
    q.lastReorderedAt = new Date().toISOString();
    return q;
  }

  dequeue(id: string): QueuedApplication | undefined {
    const q = this.queue.get(id);
    if (q) this.queue.delete(id);
    return q;
  }

  getSummary(): QueueSummary {
    const list = this.getQueue();
    const byPriority: Record<string, number> = {};
    const byTarget: Record<string, number> = {};
    let totalScore = 0;

    for (const q of list) {
      byPriority[q.priority || 'medium'] = (byPriority[q.priority || 'medium'] || 0) + 1;
      byTarget[q.target || 'balanced'] = (byTarget[q.target || 'balanced'] || 0) + 1;
      totalScore += q.opportunityScore;
    }

    return {
      total: list.length,
      byPriority,
      byTarget,
      avgScore: list.length > 0 ? totalScore / list.length : 0,
      highPriorityCount: byPriority['high'] || 0,
      needsReview: list.filter(q => q.opportunityScore < 30).length,
    };
  }

  getCount(): number {
    return this.queue.size;
  }
}
