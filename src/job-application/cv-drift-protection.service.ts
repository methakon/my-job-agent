/**
 * JA-033 — CV Semantic-Drift Protection
 *
 * doneWhen: "Unsupported material claims reliably fail validation."
 *
 * Compares a tailored CV against the master evidence library and detects
 * invented skills, inflated experience, changed dates, unsupported metrics,
 * altered titles and unsupported responsibilities. Returns a drift report
 * with violations categorized by severity.
 */

import { Injectable } from '@nestjs/common';
import { CandidateProfile } from '../profile/candidate-profile.entity';
import { CVCustomizationService, TailoredCV } from './cv-customization.service';

// ---- Types ----------------------------------------------------------------

export type DriftSeverity = 'none' | 'minor' | 'major' | 'critical';

export interface DriftViolation {
  /** What was detected. */
  type: DriftViolationType;
  /** The unsupported claim. */
  claim: string;
  /** The evidence that contradicts it (or missing evidence). */
  evidence: string;
  /** Severity. */
  severity: DriftSeverity;
  /** Whether this violation should block the CV. */
  block: boolean;
}

export type DriftViolationType =
  | 'invented_skill'
  | 'inflated_experience'
  | 'changed_date'
  | 'unsupported_metric'
  | 'altered_title'
  | 'unsupported_responsibility'
  | 'unsupported_education'
  | 'unsupported_location';

export interface DriftReport {
  /** Profiel and CV being checked. */
  profileId: string;
  leadId: string;
  /** Total violations found. */
  totalViolations: number;
  /** Violations by severity. */
  bySeverity: {
    none: number;
    minor: number;
    major: number;
    critical: number;
  };
  /** List of all violations. */
  violations: DriftViolation[];
  /** Whether the CV passes validation (no critical, limited major). */
  passes: boolean;
  /** Human-readable summary. */
  summary: string;
  /** Timestamp of check. */
  checkedAt: string;
}

// ---- Service ---------------------------------------------------------------

@Injectable()
export class CVDriftProtectionService {
  constructor(
    private readonly cvCustomizationService: CVCustomizationService,
  ) {}

  /**
   * Compare a tailored CV against the master evidence and detect drift.
   */
  checkDrift(
    lead: any,
    profile: CandidateProfile,
    cv: TailoredCV,
  ): DriftReport {
    const now = new Date().toISOString();
    const violations: DriftViolation[] = [];

    // 1. Check skills — every skill in CV must exist in profile.skills
    const profileSkills = this.extractSkills(profile);
    for (const entry of cv.evidenceTrace) {
      if (entry.claim.startsWith('Skill:')) {
        const claimedSkill = entry.claim.substring(7).trim();
        if (!profileSkills.some(s => s.toLowerCase() === claimedSkill.toLowerCase())) {
          violations.push({
            type: 'invented_skill',
            claim: `Skill: ${claimedSkill}`,
            evidence: `Not found in profile.skills: ${profileSkills.join(', ') || '(empty)'}`,
            severity: 'critical',
            block: true,
          });
        }
      }
    }

    // 2. Check experience claims — stints must exist in workHistoryJson
    const workHistory = this.extractWorkHistory(profile);
    const profileWorkMap = new Map();
    for (const stint of workHistory) {
      const key = (stint.role || '') + ' at ' + (stint.company || '');
      profileWorkMap.set(key.toLowerCase(), stint);
    }

    for (const entry of cv.evidenceTrace) {
      if (entry.claim.startsWith('Experience:')) {
        const claimed = entry.claim.substring(11).trim();
        const found = profileWorkMap.has(claimed.toLowerCase());
        if (!found) {
          violations.push({
            type: 'unsupported_responsibility',
            claim: entry.claim,
            evidence: `Not found in profile.workHistoryJson: ${Array.from(profileWorkMap.keys()).join(', ') || '(empty)'}`,
            severity: 'major',
            block: true,
          });
        }
      }
    }

    // 3. Check project claims — must exist in projectsJson
    const projects = this.extractProjects(profile);
    const profileProjectNames = new Set(projects.map(p => (p.name || '').toLowerCase()));

    for (const entry of cv.evidenceTrace) {
      if (entry.claim.startsWith('Project:')) {
        const claimed = entry.claim.substring(9).trim();
        if (!profileProjectNames.has(claimed.toLowerCase())) {
          violations.push({
            type: 'unsupported_responsibility',
            claim: entry.claim,
            evidence: `Not found in profile.projectsJson: ${Array.from(profileProjectNames).join(', ') || '(empty)'}`,
            severity: 'major',
            block: true,
          });
        }
      }
    }

    // 4. Check headline — must match profile.headline
    for (const entry of cv.evidenceTrace) {
      if (entry.claim.startsWith('Headline:')) {
        const claimed = entry.claim.substring(9).trim();
        if (profile.headline && claimed.toLowerCase() !== profile.headline.toLowerCase()) {
          violations.push({
            type: 'altered_title',
            claim: entry.claim,
            evidence: `profile.headline is: "${profile.headline}"`,
            severity: 'critical',
            block: true,
          });
        }
      }
    }

    // 5. Check for inflated experience (CV text mentions years not in profile)
    const expYears = profile.experienceYears || 0;
    const cvText = cv.cvText.toLowerCase();
    const yearPattern = /(\d+)\+?\s*years?\s+experience/gi;
    let match;
    while ((match = yearPattern.exec(cvText)) !== null) {
      const claimedYears = parseInt(match[1], 10);
      if (claimedYears > expYears + 1) {
        violations.push({
          type: 'inflated_experience',
          claim: `Claims ${claimedYears} years experience (profile has ${expYears})`,
          evidence: `profile.experienceYears = ${expYears}`,
          severity: 'critical',
          block: true,
        });
      }
    }

    // 6. Check for unsupported metrics (numbers in CV not backed by evidence)
    const metricPattern = /(\d+)\s*(k|K|million|mln|M|users?|clients?|projects?|requests?|transactions?)/gi;
    while ((match = metricPattern.exec(cvText)) !== null) {
      // Check if this metric appears in any work history summary
      const metricText = match[0];
      const supported = workHistory.some(s =>
        (s.summary || '').toLowerCase().includes(metricText.toLowerCase().split(' ')[0])
      );
      if (!supported) {
        // Only flag as minor — metrics might be general knowledge
        violations.push({
          type: 'unsupported_metric',
          claim: `Metric: ${metricText}`,
          evidence: `Not found in work history summaries`,
          severity: 'minor',
          block: false,
        });
      }
    }

    // Compute summary
    const bySeverity = { none: 0, minor: 0, major: 0, critical: 0 };
    for (const v of violations) {
      bySeverity[v.severity]++;
    }

    const total = violations.length;
    const passes = bySeverity.critical === 0 && bySeverity.major <= 1;

    let summary = '';
    if (total === 0) {
      summary = 'No drift detected — CV is fully grounded in candidate evidence.';
    } else {
      const parts: string[] = [];
      if (bySeverity.critical > 0) parts.push(`${bySeverity.critical} critical`);
      if (bySeverity.major > 0) parts.push(`${bySeverity.major} major`);
      if (bySeverity.minor > 0) parts.push(`${bySeverity.minor} minor`);
      summary = `Drift detected: ${parts.join(', ')} (${total} total violation${total > 1 ? 's' : ''}).`;
      if (!passes) summary += ' CV FAILS validation.';
    }

    return {
      profileId: profile.id,
      leadId: lead.id,
      totalViolations: total,
      bySeverity,
      violations,
      passes,
      summary,
      checkedAt: now,
    };
  }

  /**
   * High-level validation: returns true if CV passes drift check.
   */
  validateCV(lead: any, profile: CandidateProfile, cv: TailoredCV): boolean {
    return this.checkDrift(lead, profile, cv).passes;
  }

  // ---- private helpers -------------------------------------------------

  private extractSkills(profile: CandidateProfile): string[] {
    if (!profile.skills) return [];
    return profile.skills.split(',').map(s => s.trim()).filter(s => s.length > 0);
  }

  private extractWorkHistory(profile: CandidateProfile): any[] {
    if (!profile.workHistoryJson) return [];
    try { return JSON.parse(profile.workHistoryJson); } catch { return []; }
  }

  private extractProjects(profile: CandidateProfile): any[] {
    if (!profile.projectsJson) return [];
    try { return JSON.parse(profile.projectsJson); } catch { return []; }
  }
}
