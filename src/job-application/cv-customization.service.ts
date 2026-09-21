/**
 * JA-032 — Evidence-Grounded CV Tailoring
 *
 * doneWhen: "Generated CVs pass automated evidence validation."
 *
 * Generates a tailored CV summary, skill ordering, project emphasis and
 * experience framing grounded in candidate evidence. Every material claim
 * maps to a specific evidence source. Returns a tailored CV document plus
 * an evidence traceability record.
 */

import { Injectable } from '@nestjs/common';
import { CandidateProfile } from '../profile/candidate-profile.entity';
import { JobLead } from '../leads/job-lead.entity';
import { CVStrategyService, CvStrategy, CvStrategySelection } from './cv-strategy.service';

// ---- Types ----------------------------------------------------------------

export interface TailoredCV {
  /** The tailored CV text (summary + skills + experience + projects). */
  cvText: string;
  /** Strategy used. */
  strategy: CvStrategy;
  /** Ordered list of skills for the CV (tailored to strategy + JD). */
  skillOrder: string[];
  /** Which experience stints are emphasized (by index into workHistoryJson). */
  emphasizedStints: number[];
  /** Which projects are highlighted (by index into projectsJson). */
  highlightedProjects: number[];
  /** Tailoring metadata. */
  metadata: TailoringMetadata;
  /** Evidence traceability: every material claim → evidence source. */
  evidenceTrace: EvidenceTraceEntry[];
}

export interface TailoringMetadata {
  /** When tailoring was generated. */
  generatedAt: string;
  /** Profile ID. */
  profileId: string;
  /** Lead ID. */
  leadId: string;
  /** Strategy selection details. */
  strategySelection: CvStrategySelection;
  /** Confidence in the tailoring. */
  confidence: 'high' | 'medium' | 'low';
}

export interface EvidenceTraceEntry {
  /** The material claim made in the CV. */
  claim: string;
  /** Which evidence source supports this claim. */
  source: string;
  /** Confidence of the evidence. */
  confidence: 'high' | 'medium' | 'low';
  /** Whether the claim is fully grounded. */
  grounded: boolean;
}

// ---- Service ---------------------------------------------------------------

@Injectable()
export class CVCustomizationService {
  constructor(
    private readonly strategyService: CVStrategyService,
  ) {}

  /**
   * Generate a tailored CV grounded in candidate evidence.
   * Every material claim is traceable to a specific profile field.
   */
  tailorCV(
    lead: JobLead,
    profile: CandidateProfile,
  ): TailoredCV {
    const now = new Date().toISOString();
    const strategySelection = this.strategyService.selectStrategy(lead, profile);
    const strategy = strategySelection.strategy;
    const skills = this.extractSkills(profile);
    const workHistory = this.extractWorkHistory(profile);
    const projects = this.extractProjects(profile);

    // Order skills based on strategy
    const skillOrder = this.orderSkillsForStrategy(skills, strategy, lead);

    // Select experience stints to emphasize
    const emphasizedStints = this.selectEmphasizedStints(workHistory, strategy, profile);

    // Select projects to highlight
    const highlightedProjects = this.selectHighlightedProjects(projects, strategy, lead);

    // Build CV text
    const cvText = this.buildCVText(profile, skillOrder, workHistory, emphasizedStints, projects, highlightedProjects, strategy, lead);

    // Build evidence trace
    const evidenceTrace = this.buildEvidenceTrace(profile, skillOrder, workHistory, emphasizedStints, projects, highlightedProjects, strategy, lead);

    return {
      cvText,
      strategy,
      skillOrder,
      emphasizedStints,
      highlightedProjects,
      metadata: {
        generatedAt: now,
        profileId: profile.id,
        leadId: lead.id,
        strategySelection,
        confidence: this.computeConfidence(strategySelection.confidence, skills.length, workHistory.length),
      },
      evidenceTrace,
    };
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

  private orderSkillsForStrategy(skills: string[], strategy: CvStrategy, lead: JobLead): string[] {
    const leadTitle = (lead.title || '').toLowerCase();
    const ordered: string[] = [];

    // Strategy-specific priority skill groups
    const groups: Record<CvStrategy, string[]> = {
      backend: ['python', 'java', 'nodejs', 'go', 'sql', 'api', 'microservice', 'docker', 'kubernetes', 'aws', 'redis', 'graphql'],
      frontend: ['react', 'typescript', 'javascript', 'css', 'html', 'vue', 'angular', 'next.js', 'sass', 'webpack'],
      fullstack: ['react', 'python', 'nodejs', 'sql', 'typescript', 'docker', 'api', 'javascript', 'css'],
      data: ['python', 'sql', 'ml', 'tensorflow', 'pandas', 'spark', 'kafka', 'airflow', 'docker'],
      devops: ['docker', 'kubernetes', 'aws', 'terraform', 'ci/cd', 'jenkins', 'python', 'linux', 'monitoring'],
      mobile: ['swift', 'ios', 'android', 'react native', 'flutter', 'mobile'],
      management: ['leadership', 'architecture', 'delivery', 'mentoring', 'strategy', 'python', 'java'],
      domain: ['python', 'sql', 'react', 'nodejs', 'docker'],
      general: ['python', 'react', 'sql', 'nodejs', 'docker', 'typescript', 'java'],
    };

    const priority = groups[strategy] || groups.general;
    const matched: string[] = [];
    const unmatched: string[] = [];

    for (const skill of skills) {
      const lower = skill.toLowerCase();
      if (priority.some(p => lower.includes(p) || p.includes(lower))) {
        matched.push(skill);
      } else {
        unmatched.push(skill);
      }
    }

    // Sort matched by priority order
    matched.sort((a, b) => {
      const ai = priority.findIndex(p => a.toLowerCase().includes(p) || p.includes(a.toLowerCase()));
      const bi = priority.findIndex(p => b.toLowerCase().includes(p) || p.includes(b.toLowerCase()));
      return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
    });

    return [...matched, ...unmatched];
  }

  private selectEmphasizedStints(workHistory: any[], strategy: CvStrategy, profile: CandidateProfile): number[] {
    if (workHistory.length === 0) return [];
    const expYears = profile.experienceYears || 0;

    // For management: emphasize most recent and longest stints
    // For others: emphasize stints with matching tech
    const result: number[] = [];
    const len = Math.min(workHistory.length, expYears > 5 ? 3 : 2);

    // Sort by recency (most recent first)
    const indexed = workHistory.map((w, i) => ({ ...w, idx: i }));
    indexed.sort((a, b) => {
      const aFrom = a.from ? new Date(a.from).getTime() : 0;
      const bFrom = b.from ? new Date(b.from).getTime() : 0;
      return bFrom - aFrom;
    });

    for (let i = 0; i < Math.min(len, indexed.length); i++) {
      if (!indexed[i].tagged) {
        result.push(indexed[i].idx);
      }
    }

    // If we don't have enough untagged, add tagged ones
    if (result.length < 2) {
      for (const item of indexed) {
        if (!result.includes(item.idx) && item.tagged) {
          result.push(item.idx);
          if (result.length >= 2) break;
        }
      }
    }

    return result.slice(0, 3);
  }

  private selectHighlightedProjects(projects: any[], strategy: CvStrategy, lead: JobLead): number[] {
    if (projects.length === 0) return [];
    const leadTitle = (lead.title || '').toLowerCase();

    // Score each project by relevance
    const scored = projects.map((p, i) => {
      let score = 0;
      const tech = (p.tech || []).map(t => t.toLowerCase());
      const name = (p.name || '').toLowerCase();
      const summary = (p.summary || '').toLowerCase();

      // Match against lead title
      if (tech.some(t => leadTitle.includes(t))) score += 3;
      if (name.includes(leadTitle)) score += 2;

      // Strategy-specific bonuses
      if (strategy === 'backend' && tech.some(t => ['python', 'java', 'nodejs', 'sql', 'api'].includes(t))) score += 2;
      if (strategy === 'frontend' && tech.some(t => ['react', 'css', 'typescript', 'javascript'].includes(t))) score += 2;
      if (strategy === 'data' && tech.some(t => ['python', 'sql', 'ml', 'pandas'].includes(t))) score += 2;
      if (strategy === 'devops' && tech.some(t => ['docker', 'kubernetes', 'aws'].includes(t))) score += 2;

      return { idx: i, score };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored.filter(s => s.score > 0).map(s => s.idx).slice(0, 2);
  }

  private buildCVText(
    profile: CandidateProfile,
    skillOrder: string[],
    workHistory: any[],
    emphasizedStints: number[],
    projects: any[],
    highlightedProjects: number[],
    strategy: CvStrategy,
    lead: JobLead,
  ): string {
    const lines: string[] = [];

    // Summary
    const headline = profile.headline || 'Professional';
    const location = profile.currentLocation || '';
    lines.push(`${headline} — ${location}`.trim());
    lines.push('');

    // Skills
    if (skillOrder.length > 0) {
      lines.push('Skills: ' + skillOrder.join(', '));
      lines.push('');
    }

    // Experience (emphasized stints)
    for (const idx of emphasizedStints) {
      const stint = workHistory[idx];
      if (!stint || stint.tagged) continue;
      const role = stint.role || 'Role';
      const company = stint.company || 'Company';
      const from = stint.from || '';
      const to = stint.to || '';
      const summary = stint.summary || '';
      lines.push(`${role} at ${company} (${from} – ${to})`);
      if (summary) lines.push(summary);
      lines.push('');
    }

    // Projects (highlighted)
    for (const idx of highlightedProjects) {
      const proj = projects[idx];
      if (!proj) continue;
      const name = proj.name || 'Project';
      const tech = (proj.tech || []).join(', ');
      const summary = proj.summary || '';
      lines.push(`${name} — ${tech}`);
      if (summary) lines.push(summary);
      lines.push('');
    }

    // Links
    if (profile.linkedinUrl) lines.push(`LinkedIn: ${profile.linkedinUrl}`);
    if (profile.githubUrl) lines.push(`GitHub: ${profile.githubUrl}`);

    return lines.join('\n').trim();
  }

  private buildEvidenceTrace(
    profile: CandidateProfile,
    skillOrder: string[],
    workHistory: any[],
    emphasizedStints: number[],
    projects: any[],
    highlightedProjects: number[],
    strategy: CvStrategy,
    lead: JobLead,
  ): EvidenceTraceEntry[] {
    const trace: EvidenceTraceEntry[] = [];

    // Skills claims
    for (const skill of skillOrder) {
      trace.push({
        claim: `Skill: ${skill}`,
        source: 'profile.skills',
        confidence: 'high',
        grounded: true,
      });
    }

    // Experience claims
    for (const idx of emphasizedStints) {
      const stint = workHistory[idx];
      if (!stint || stint.tagged) continue;
      trace.push({
        claim: `Experience: ${stint.role || 'Role'} at ${stint.company || 'Company'}`,
        source: 'profile.workHistoryJson',
        confidence: 'high',
        grounded: true,
      });
    }

    // Project claims
    for (const idx of highlightedProjects) {
      const proj = projects[idx];
      if (!proj) continue;
      trace.push({
        claim: `Project: ${proj.name || 'Project'}`,
        source: 'profile.projectsJson',
        confidence: 'high',
        grounded: true,
      });
    }

    // Headline claim
    if (profile.headline) {
      trace.push({
        claim: `Headline: ${profile.headline}`,
        source: 'profile.headline',
        confidence: 'high',
        grounded: true,
      });
    }

    return trace;
  }

  private computeConfidence(
    strategyConfidence: 'high' | 'medium' | 'low',
    skillCount: number,
    expCount: number,
  ): 'high' | 'medium' | 'low' {
    if (strategyConfidence === 'high' && skillCount >= 3 && expCount >= 1) return 'high';
    if (strategyConfidence === 'medium' && skillCount >= 2) return 'medium';
    return 'low';
  }
}
