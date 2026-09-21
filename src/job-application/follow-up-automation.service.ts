/**
 * JA-072 — Follow-up Automation
 *
 * doneWhen: "Context-appropriate follow-up messages are suggested and tracked."
 */

import { Injectable } from '@nestjs/common';

export type FollowUpType = 'reminder' | 'check_in' | 'thank_you' | 'status_request' | 'rejection_followup' | 'offer_followup' | 'withdrawal';
export type FollowUpChannel = 'email' | 'linkedin' | 'phone' | 'portal_message';

export interface FollowUpTemplate {
  id?: string;
  type: FollowUpType;
  channel: FollowUpChannel;
  subject?: string;
  body: string;
  triggerConditions: string[];
  tone: 'formal' | 'friendly' | 'urgent' | 'casual';
}

export interface FollowUpAction {
  id?: string;
  applicationId: string;
  type: FollowUpType;
  channel: FollowUpChannel;
  scheduledAt?: string;
  sentAt?: string;
  templateId?: string;
  context?: string;
  status: 'pending' | 'sent' | 'failed' | 'cancelled';
  retryCount: number;
}

export interface FollowUpSuggestion {
  applicationId: string;
  recommendedType: FollowUpType;
  recommendedChannel: FollowUpChannel;
  reason: string;
  urgency: 'low' | 'medium' | 'high';
  suggestedBody?: string;
}

@Injectable()
export class FollowUpAutomationService {
  private templates: Map<string, FollowUpTemplate> = new Map();
  private actions: Map<string, FollowUpAction> = new Map();

  addTemplate(template: Partial<FollowUpTemplate>): FollowUpTemplate {
    const t: FollowUpTemplate = {
      id: template.id || `tpl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      type: template.type || 'reminder',
      channel: template.channel || 'email',
      subject: template.subject,
      body: template.body || '',
      triggerConditions: template.triggerConditions || [],
      tone: template.tone || 'friendly',
    };
    this.templates.set(t.id || "x", t);
    return t;
  }

  schedule(applicationId: string, type: FollowUpType, channel: FollowUpChannel, context?: string, scheduledAt?: string): FollowUpAction {
    const now = new Date().toISOString();
    const a: FollowUpAction = {
      id: `fa-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      applicationId,
      type,
      channel,
      scheduledAt: scheduledAt || new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      context,
      status: 'pending',
      retryCount: 0,
    };
    this.actions.set(a.id || `fa-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, a);
    return a;
  }

  suggest(applicationId: string, currentStage?: string, daysSinceLastContact?: number, lastStatus?: string): FollowUpSuggestion {
    const urgency: 'low' | 'medium' | 'high' = daysSinceLastContact && daysSinceLastContact > 14 ? 'high' :
      daysSinceLastContact && daysSinceLastContact > 7 ? 'medium' : 'low';

    let recommendedType: FollowUpType = 'check_in';
    let recommendedChannel: FollowUpChannel = 'email';
    let reason = '';

    if (currentStage === 'interview' || currentStage === 'offer') {
      recommendedType = 'status_request';
      recommendedChannel = 'email';
      reason = 'Active stage — status update appropriate';
    } else if (lastStatus === 'rejected') {
      recommendedType = 'rejection_followup';
      recommendedChannel = 'email';
      reason = 'Post-rejection feedback request';
    } else if (daysSinceLastContact && daysSinceLastContact > 14) {
      recommendedType = 'reminder';
      recommendedChannel = 'linkedin';
      reason = 'Long silence — gentle reminder via lighter channel';
    } else if (daysSinceLastContact && daysSinceLastContact > 7) {
      recommendedType = 'check_in';
      recommendedChannel = 'email';
      reason = 'Moderate gap — standard check-in';
    } else {
      recommendedType = 'check_in';
      recommendedChannel = 'email';
      reason = 'Routine follow-up';
    }

    return {
      applicationId,
      recommendedType,
      recommendedChannel,
      reason,
      urgency,
      suggestedBody: `Following up on your application. ${reason}`,
    };
  }

  markSent(actionId: string, success: boolean = true): FollowUpAction | undefined {
    const a = this.actions.get(actionId);
    if (!a) return undefined;
    a.sentAt = new Date().toISOString();
    a.status = success ? 'sent' : 'failed';
    if (!success) a.retryCount++;
    return a;
  }

  cancel(actionId: string): FollowUpAction | undefined {
    const a = this.actions.get(actionId);
    if (!a) return undefined;
    a.status = 'cancelled';
    return a;
  }

  getPending(): FollowUpAction[] {
    return Array.from(this.actions.values())
      .filter(a => a.status === 'pending')
      .sort((a, b) => (a.scheduledAt || '').localeCompare(b.scheduledAt || ''));
  }

  getByApplication(applicationId: string): FollowUpAction[] {
    return Array.from(this.actions.values())
      .filter(a => a.applicationId === applicationId)
      .sort((a, b) => (b.sentAt || b.scheduledAt || '').localeCompare(a.sentAt || a.scheduledAt || ''));
  }

  getTemplate(type: FollowUpType, channel: FollowUpChannel): FollowUpTemplate | undefined {
    return Array.from(this.templates.values())
      .find(t => t.type === type && t.channel === channel);
  }

  getCount(): number {
    return this.actions.size;
  }

  getStats(): { total: number; pending: number; sent: number; failed: number; byType: Record<string, number> } {
    const byType: Record<string, number> = {};
    let pending = 0, sent = 0, failed = 0;
    for (const a of this.actions.values()) {
      byType[a.type] = (byType[a.type] || 0) + 1;
      if (a.status === 'pending') pending++;
      else if (a.status === 'sent') sent++;
      else if (a.status === 'failed') failed++;
    }
    return { total: this.actions.size, pending, sent, failed, byType };
  }
}
