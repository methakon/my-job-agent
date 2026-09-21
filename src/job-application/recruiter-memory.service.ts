/**
 * JA-051 — Recruiter Memory
 *
 * doneWhen: "Future applications can recognize prior recruiter relationships."
 */

import { Injectable } from '@nestjs/common';

export interface RecruiterContact {
  id?: string;
  recruiterName: string;
  recruiterEmail?: string;
  employerName: string;
  employerDomain?: string;
  channels?: string[];
  firstContacted: string;
  lastContacted: string;
  contactCount: number;
  responseCount: number;
  lastResponse?: string;
  responseRate: number;
  notes?: string;
}

export interface OutreachRecommendation {
  recruiterName: string;
  employerName: string;
  shouldContact: boolean;
  reason: string;
  daysSinceContact: number;
  duplicateOutreach: boolean;
  recommendation: 'contact' | 'wait' | 'duplicate' | 'unknown';
}

@Injectable()
export class RecruiterMemoryService {
  private contacts: Map<string, RecruiterContact> = new Map();

  getKey(recruiterName: string, employerName: string): string {
    return `${recruiterName}::${employerName}`;
  }

  recordContact(contact: Partial<RecruiterContact>): RecruiterContact {
    const key = this.getKey(contact.recruiterName || 'Unknown', contact.employerName || 'Unknown');
    const now = new Date().toISOString();
    const existing = this.contacts.get(key);
    const c: RecruiterContact = {
      ...contact,
      id: contact.id || `rc-${Date.now()}`,
      recruiterName: contact.recruiterName || 'Unknown',
      employerName: contact.employerName || 'Unknown',
      firstContacted: existing?.firstContacted || now,
      lastContacted: contact.lastContacted || now,
      contactCount: Math.max(contact.contactCount || 0, (existing?.contactCount || 0)) + (contact.contactCount ? 0 : 1),
      responseCount: existing?.responseCount || 0,
      responseRate: 0,
    };
    this.contacts.set(key, c);
    return c;
  }

  recordResponse(contactId: string, response: string): RecruiterContact | undefined {
    for (const [key, c] of this.contacts) {
      if (c.id === contactId) {
        c.responseCount = (c.responseCount || 0) + 1;
        c.lastResponse = response;
        c.lastContacted = new Date().toISOString();
        c.responseRate = c.responseCount / c.contactCount;
        return c;
      }
    }
    return undefined;
  }

  getContact(recruiterName: string, employerName: string): RecruiterContact | undefined {
    return this.contacts.get(this.getKey(recruiterName, employerName));
  }

  recommendOutreach(recruiterName: string, employerName: string, maxDaysBeforeRepeat: number = 7): OutreachRecommendation {
    const contact = this.getContact(recruiterName, employerName);
    if (!contact) {
      return {
        recruiterName, employerName, shouldContact: true,
        reason: 'No prior contact with this recruiter',
        daysSinceContact: Infinity,
        duplicateOutreach: false,
        recommendation: 'contact',
      };
    }

    const lastContact = new Date(contact.lastContacted);
    const now = new Date();
    const daysSince = (now.getTime() - lastContact.getTime()) / (1000 * 60 * 60 * 24);

    if (daysSince < maxDaysBeforeRepeat) {
      return {
        recruiterName, employerName, shouldContact: false,
        reason: `Contacted ${daysSince.toFixed(1)} days ago — too soon for repeat outreach`,
        daysSinceContact: daysSince,
        duplicateOutreach: true,
        recommendation: 'wait',
      };
    }

    if (contact.responseRate > 0.5) {
      return {
        recruiterName, employerName, shouldContact: true,
        reason: `Prior response rate ${contact.responseRate.toFixed(2)} — good candidate for follow-up`,
        daysSinceContact: daysSince,
        duplicateOutreach: false,
        recommendation: 'contact',
      };
    }

    return {
      recruiterName, employerName, shouldContact: true,
      reason: `Last contact ${daysSince.toFixed(1)} days ago, response rate ${contact.responseRate.toFixed(2)}`,
      daysSinceContact: daysSince,
      duplicateOutreach: false,
      recommendation: 'contact',
    };
  }

  listContacts(): RecruiterContact[] {
    return Array.from(this.contacts.values());
  }

  getContactCount(): number {
    return this.contacts.size;
  }
}
// Backport: preserve contactCount from input if higher
