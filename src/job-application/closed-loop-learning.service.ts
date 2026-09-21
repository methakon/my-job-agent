/**
 * JA-090 — Closed-Loop Learning
 *
 * doneWhen: "Model updates from outcomes are traceable, reversible, and gated."
 */

import { Injectable } from '@nestjs/common';

export type LearningSource = 'outcome_feedback' | 'recruiter_feedback' | 'portal_status' | 'manual_override' | 'batch_update';
export type UpdateAction = 'adjust_weight' | 'add_feature' | 'remove_feature' | 'retrain' | 'calibrate' | 'rollback';

export interface LearningUpdate {
  id?: string;
  source: LearningSource;
  action: UpdateAction;
  target?: string;
  description: string;
  parameters?: Record<string, number>;
  previousValue?: number;
  newValue?: number;
  evidenceCount: number;
  confidence: number;
  appliedAt?: string;
  status: 'pending' | 'applied' | 'rejected' | 'rolled_back';
  rollbackOf?: string;
  approvedBy?: string;
}

export interface LearningHistoryEntry {
  updateId: string;
  action: UpdateAction;
  target: string;
  previousValue: number;
  newValue: number;
  appliedAt: string;
  revertedAt?: string;
  revertedBy?: string;
}

export interface ClosedLoopState {
  totalUpdates: number;
  appliedUpdates: number;
  pendingUpdates: number;
  rolledBackUpdates: number;
  bySource: Record<string, number>;
  byAction: Record<string, number>;
  lastUpdated: string;
}

@Injectable()
export class ClosedLoopLearningService {
  private updates: Map<string, LearningUpdate> = new Map();
  private history: LearningHistoryEntry[] = [];

  propose(update: Partial<LearningUpdate>): LearningUpdate {
    const now = new Date().toISOString();
    const u: LearningUpdate = {
      source: update.source || 'outcome_feedback',
      action: update.action || 'adjust_weight',
      target: update.target,
      description: update.description || '',
      parameters: update.parameters,
      previousValue: update.previousValue,
      newValue: update.newValue,
      evidenceCount: update.evidenceCount || 0,
      confidence: update.confidence || 0.5,
      appliedAt: undefined,
      status: 'pending' as const,
      rollbackOf: update.rollbackOf,
      approvedBy: update.approvedBy,
    };
    this.updates.set(u.id || 'x', u);
    return u;
  }

  apply(id: string, approvedBy?: string): LearningUpdate | undefined {
    const u = this.updates.get(id);
    if (!u || u.status !== 'pending') return undefined;

    u.status = 'applied';
    u.appliedAt = new Date().toISOString();
    u.approvedBy = approvedBy;

    this.history.push({
      updateId: u.id || "x",
      action: u.action,
      target: u.target || "general",
      previousValue: u.previousValue || 0,
      newValue: u.newValue || 0,
      appliedAt: u.appliedAt,
    });

    return u;
  }

  reject(id: string, reason?: string): LearningUpdate | undefined {
    const u = this.updates.get(id);
    if (!u || u.status !== 'pending') return undefined;
    u.status = 'rejected';
    return u;
  }

  rollback(updateId: string, revertedBy?: string): LearningUpdate | undefined {
    const u = this.updates.get(updateId);
    if (!u || u.status !== 'applied') return undefined;

    u.status = 'rolled_back';

    const histEntry = this.history.find(h => h.updateId === updateId);
    if (histEntry) {
      histEntry.revertedAt = new Date().toISOString();
      histEntry.revertedBy = revertedBy;
    }

    const rollbackUpdate: LearningUpdate = {
      id: `loop-rb-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      source: 'manual_override',
      action: 'rollback',
      target: u.target,
      description: `Rollback of ${u.action} on ${u.target || 'general'}`,
      previousValue: u.newValue,
      newValue: u.previousValue,
      evidenceCount: u.evidenceCount,
      confidence: 1.0,
      appliedAt: new Date().toISOString(),
      status: 'applied',
      rollbackOf: u.id,
      approvedBy: revertedBy,
    };

    this.updates.set(rollbackUpdate.id || "x", rollbackUpdate);
    return u;
  }

  getPending(): LearningUpdate[] {
    return Array.from(this.updates.values())
      .filter(u => u.status === 'pending')
      .sort((a, b) => (a.confidence || 0) - (b.confidence || 0));
  }

  getApplied(): LearningUpdate[] {
    return Array.from(this.updates.values())
      .filter(u => u.status === 'applied')
      .sort((a, b) => (b.appliedAt || '').localeCompare(a.appliedAt || ''));
  }

  getUpdate(id: string): LearningUpdate | undefined {
    return this.updates.get(id);
  }

  getHistory(): LearningHistoryEntry[] {
    return [...this.history].sort((a, b) => b.appliedAt.localeCompare(a.appliedAt));
  }

  getState(): ClosedLoopState {
    const bySource: Record<string, number> = {};
    const byAction: Record<string, number> = {};
    let applied = 0, pending = 0, rolledBack = 0;

    for (const u of this.updates.values()) {
      bySource[u.source] = (bySource[u.source] || 0) + 1;
      byAction[u.action || "adjust_weight"] = (byAction[u.action || "adjust_weight"] || 0) + 1;
      if (u.status === 'applied') applied++;
      else if (u.status === 'pending') pending++;
      else if (u.status === 'rolled_back') rolledBack++;
    }

    return {
      totalUpdates: this.updates.size,
      appliedUpdates: applied,
      pendingUpdates: pending,
      rolledBackUpdates: rolledBack,
      bySource,
      byAction,
      lastUpdated: this.history.length > 0 ? this.history[0].appliedAt : new Date().toISOString(),
    };
  }

  getCount(): number {
    return this.updates.size;
  }

  getHistoryCount(): number {
    return this.history.length;
  }
}
