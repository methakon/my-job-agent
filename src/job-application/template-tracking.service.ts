/**
 * JA-060 — Template Tracking
 *
 * doneWhen: "Every application is traceable to its exact content version."
 */

import { Injectable } from '@nestjs/common';

export type TemplateType = 'cover_letter' | 'recruiter_email' | 'linkedin_message' | 'cv_strategy';

export interface TemplateVersion {
  id?: string;
  name: string;
  type: TemplateType;
  version: string;
  content: string;
  createdAt: string;
  createdBy: string;
  tags?: string[];
}

export interface ApplicationTemplateLink {
  id?: string;
  applicationId: string;
  templateId: string;
  templateVersion: string;
  appliedAt: string;
  channel: string;
}

@Injectable()
export class TemplateTrackingService {
  private templates: Map<string, TemplateVersion> = new Map();
  private links: Map<string, ApplicationTemplateLink> = new Map();
  private versionCounter: Map<string, number> = new Map();

  createTemplate(name: string, type: TemplateType, content: string, createdBy: string, tags?: string[]): TemplateVersion {
    const now = new Date().toISOString();
    const safeName = name || 'untitled';
    const key = `${safeName}::${type}`;
    const count = (this.versionCounter.get(key) || 0) + 1;
    this.versionCounter.set(key, count);
    const version = `v${count}.0.0`;
    const t: TemplateVersion = {
      id: `tmpl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: safeName, type, version, content,
      createdAt: now, createdBy: createdBy || 'system',
      tags: tags || [],
    };
    this.templates.set(t.id || 'x', t);
    return t;
  }

  linkApplication(applicationId: string, templateId: string, channel: string): ApplicationTemplateLink {
    const now = new Date().toISOString();
    const t = this.templates.get(templateId);
    const link: ApplicationTemplateLink = {
      id: `link-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      applicationId, templateId,
      templateVersion: t?.version || 'unknown',
      appliedAt: now, channel,
    };
    this.links.set(link.id || 'x', link);
    return link;
  }

  getTemplate(id: string): TemplateVersion | undefined {
    return this.templates.get(id);
  }

  getApplicationTemplate(applicationId: string): ApplicationTemplateLink | undefined {
    return Array.from(this.links.values()).find(l => l.applicationId === applicationId);
  }

  getTemplateHistory(name: string, type: TemplateType): TemplateVersion[] {
    return Array.from(this.templates.values())
      .filter(t => t.name === name && t.type === type)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  getApplicationCountByTemplate(templateId: string): number {
    return Array.from(this.links.values()).filter(l => l.templateId === templateId).length;
  }

  listTemplates(): TemplateVersion[] {
    return Array.from(this.templates.values())
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  listApplicationLinks(): ApplicationTemplateLink[] {
    return Array.from(this.links.values())
      .sort((a, b) => b.appliedAt.localeCompare(a.appliedAt));
  }
}
