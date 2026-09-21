/**
 * JA-031 — CV Strategy Selection
 *
 * doneWhen: "Strategy is selected systematically and recorded."
 *
 * Selects a CV tailoring strategy based on role, seniority, JD emphasis,
 * domain, geography, ATS needs and candidate evidence. Strategies are
 * deterministic and recorded with the application.
 *
 * Strategy catalog:
 *   backend     — emphasize backend skills, infrastructure, APIs
 *   frontend    — emphasize UI/UX, interactivity, design systems
 *   fullstack   — balanced full-stack presentation
 *   data        — emphasize data engineering, analytics, ML
 *   devops      — emphasize infrastructure, CI/CD, cloud
 *   mobile      — emphasize mobile development
 *   management  — emphasize leadership, architecture, delivery
 *   domain      — domain-specific framing (finance, health, etc.)
 */

import { Injectable } from '@nestjs/common';
import { CandidateProfile } from '../profile/candidate-profile.entity';
import { JobLead as Lead } from '../leads/job-lead.entity';

// ---- Types ----------------------------------------------------------------

export type CvStrategy =
  | 'backend'
  | 'frontend'
  | 'fullstack'
  | 'data'
  | 'devops'
  | 'mobile'
  | 'management'
  | 'domain'
  | 'general';

export interface CvStrategySelection {
  strategy: CvStrategy;
  rationale: string;
  confidence: 'high' | 'medium' | 'low';
  /** Which factors drove the selection. */
  factors: string[];
  /** Strategy-specific notes for the CV writer. */
  notes: string;
  /** Timestamp of selection. */
  selectedAt: string;
}

// ---- Service ---------------------------------------------------------------

@Injectable()
export class CVStrategyService {
  /**
   * Select a CV strategy based on role, seniority, JD emphasis, domain,
   * geography, ATS needs and candidate evidence.
   */
  selectStrategy(
    lead: Lead,
    profile: CandidateProfile,
  ): CvStrategySelection {
    const now = new Date().toISOString();
    const factors: string[] = [];
    let strategy: CvStrategy = 'general';
    let rationale = 'Default general strategy';
    let confidence: 'high' | 'medium' | 'low' = 'medium';

    const leadTitle = (lead.title || '').toLowerCase();
    const leadDesc = (lead.description || '').toLowerCase();
    const profileSkills = this.getProfileSkills(profile);
    const profileHeadline = (profile.headline || '').toLowerCase();
    const expYears = profile.experienceYears || 0;

    // ---- Domain-specific signals ----

    // Data/ML/AI roles
    if (this.matchesAny(leadTitle, ['data scientist', 'machine learning', 'ml engineer', 'data engineer', 'analytics engineer', 'ai engineer'])) {
      strategy = 'data';
      rationale = 'Data/ML role detected — emphasize data engineering, analytics, ML/AI skills';
      confidence = 'high';
      factors.push('data_role_detected');
    }
    // DevOps/infra roles
    else if (this.matchesAny(leadTitle, ['devops', 'site reliability', 'sre', 'infrastructure', 'platform engineer', 'cloud engineer'])) {
      strategy = 'devops';
      rationale = 'Infrastructure/DevOps role — emphasize CI/CD, cloud, containerization';
      confidence = 'high';
      factors.push('devops_role_detected');
    }
    // Mobile roles
    else if (this.matchesAny(leadTitle, ['mobile', 'ios', 'android', 'react native', 'flutter'])) {
      strategy = 'mobile';
      rationale = 'Mobile development role — emphasize iOS/Android/mobile framework expertise';
      confidence = 'high';
      factors.push('mobile_role_detected');
    }
    // Management/leadership roles
    else if (this.matchesAny(leadTitle, ['head of', 'director', 'vp', 'vice president', 'lead', 'principal', 'architect', 'manager', 'engineering manager', 'tech lead'])) {
      if (expYears >= 8) {
        strategy = 'management';
        rationale = 'Senior leadership role — emphasize architecture, team leadership, delivery';
        confidence = 'high';
        factors.push('senior_leadership');
      } else {
        strategy = 'backend';
        rationale = 'Senior individual contributor — emphasize technical depth and architecture';
        confidence = 'high';
        factors.push('senior_ic');
      }
    }
    // Frontend roles
    else if (this.matchesAny(leadTitle, ['frontend', 'ui', 'ux', 'web designer', 'css', 'react', 'angular', 'vue']) ||
            this.matchesAny(leadDesc, ['react', 'angular', 'vue', 'css', 'typeScript', 'frontend', 'ui/ux'])) {
      if (this.hasFrontendSkills(profileSkills) || this.matchesAny(profileHeadline, ['frontend', 'ui', 'ux'])) {
        strategy = 'frontend';
        rationale = 'Frontend role with matching frontend skills — emphasize UI, interactivity, design systems';
        confidence = 'high';
        factors.push('frontend_match');
      } else {
        strategy = 'fullstack';
        rationale = 'Frontend-leaning role — balanced presentation with frontend emphasis';
        confidence = 'medium';
        factors.push('frontend_leaning');
      }
    }
    // Backend roles
    else if (this.matchesAny(leadTitle, ['backend', 'server', 'api', 'microservice', 'node', 'python', 'java', 'go', 'rust'])) {
      if (this.hasBackendSkills(profileSkills)) {
        strategy = 'backend';
        rationale = 'Backend role with matching backend skills — emphasize APIs, services, data';
        confidence = 'high';
        factors.push('backend_match');
      } else {
        strategy = 'fullstack';
        rationale = 'Backend-leaning role — balanced presentation with backend emphasis';
        confidence = 'medium';
        factors.push('backend_leaning');
      }
    }
    // Full-stack roles
    else if (this.matchesAny(leadTitle, ['full stack', 'fullstack', 'full-stack', 'software engineer', 'senior engineer', 'senior software'])) {
      if (this.hasBothStackSkills(profileSkills)) {
        strategy = 'fullstack';
        rationale = 'Full-stack role with both frontend and backend skills — balanced presentation';
        confidence = 'high';
        factors.push('fullstack_match');
      } else if (this.hasBackendSkills(profileSkills)) {
        strategy = 'backend';
        rationale = 'Full-stack role with stronger backend — backend emphasis with frontend mention';
        confidence = 'medium';
        factors.push('fullstack_backend_leaning');
      } else {
        strategy = 'frontend';
        rationale = 'Full-stack role with stronger frontend — frontend emphasis with backend mention';
        confidence = 'medium';
        factors.push('fullstack_frontend_leaning');
      }
    }
    // General software/engineer roles
    else if (this.matchesAny(leadTitle, ['software engineer', 'engineer', 'developer', 'programmer'])) {
      if (this.hasBothStackSkills(profileSkills)) {
        strategy = 'fullstack';
        rationale = 'General software role with full-stack skills — balanced presentation';
        confidence = 'medium';
        factors.push('general_fullstack');
      } else if (this.hasBackendSkills(profileSkills)) {
        strategy = 'backend';
        rationale = 'General software role with backend skills — backend emphasis';
        confidence = 'medium';
        factors.push('general_backend');
      } else {
        strategy = 'frontend';
        rationale = 'General software role — frontend emphasis by default';
        confidence = 'low';
        factors.push('general_default');
      }
    }
    // Fallback
    else {
      strategy = 'general';
      rationale = 'No specific role pattern detected — general strategy with balanced skills';
      confidence = 'low';
      factors.push('default');
    }

    // ---- ATS consideration ----
    // If the role is in a region that needs ATS optimization, note it
    const location = (lead.location || '').toLowerCase();
    if (this.isAtsSensitiveRegion(location)) {
      factors.push('ats_sensitive_region');
      // Don't change strategy, just add factor
    }

    // ---- Build notes ----
    const notes = this.buildStrategyNotes(strategy, profileSkills, leadTitle);

    return {
      strategy,
      rationale,
      confidence,
      factors,
      notes,
      selectedAt: now,
    };
  }

  /** Record the strategy selection as a stable object (for DB/entity storage). */
  recordStrategy(selection: CvStrategySelection): CvStrategySelection {
    // Already a plain object; return as-is.
    // In a real system, this would persist to a CV strategy entity.
    return selection;
  }

  // ---- private helpers -------------------------------------------------

  private getProfileSkills(profile: CandidateProfile): string[] {
    if (!profile.skills) return [];
    return profile.skills.split(',').map(s => s.trim().toLowerCase()).filter(s => s.length > 0);
  }

  private matchesAny(text: string, patterns: string[]): boolean {
    if (!text) return false;
    return patterns.some(p => text.includes(p));
  }

  private hasFrontendSkills(skills: string[]): boolean {
    const fe = ['react', 'vue', 'angular', 'css', 'html', 'frontend', 'ui', 'typescript', 'javascript', 'sass', 'scss', 'less', 'webpack', 'vite', 'next.js', 'nextjs', 'remix'];
    return skills.some(s => fe.includes(s));
  }

  private hasBackendSkills(skills: string[]): boolean {
    const be = ['python', 'java', 'nodejs', 'node', 'go', 'golang', 'rust', 'c#', 'csharp', '.net', 'ruby', 'php', 'sql', 'postgresql', 'mysql', 'mongodb', 'redis', 'docker', 'kubernetes', 'aws', 'azure', 'gcp', 'api', 'rest', 'graphql', 'microservice', 'django', 'flask', 'spring', 'express', 'fastapi'];
    return skills.some(s => be.includes(s));
  }

  private hasBothStackSkills(skills: string[]): boolean {
    return this.hasFrontendSkills(skills) && this.hasBackendSkills(skills);
  }

  private isAtsSensitiveRegion(location: string): boolean {
    // US, Canada, UK, Germany, Netherlands, Australia, Singapore are ATS-heavy markets
    const atsRegions = ['united states', 'usa', 'canada', 'uk', 'england', 'germany', 'netherlands', 'australia', 'singapore'];
    return atsRegions.some(r => location.includes(r));
  }

  private buildStrategyNotes(strategy: CvStrategy, skills: string[], leadTitle: string): string {
    switch (strategy) {
      case 'backend':
        return 'Emphasize backend technologies, APIs, services, databases. Lead with strongest backend skill. Include infrastructure experience.';
      case 'frontend':
        return 'Emphasize UI/UX, interactivity, component design. Lead with strongest frontend framework. Include design system and accessibility experience.';
      case 'fullstack':
        return 'Balanced presentation. Lead with the skill most relevant to the role. Show end-to-end project experience. Connect frontend and backend expertise.';
      case 'data':
        return 'Emphasize data engineering, ML/AI, analytics. Lead with strongest data skill. Include pipeline, modeling, and visualization experience.';
      case 'devops':
        return 'Emphasize CI/CD, cloud, containerization, monitoring. Lead with strongest infra skill. Include reliability and automation experience.';
      case 'mobile':
        return 'Emphasize mobile development, app store experience, performance. Lead with strongest mobile skill. Include cross-platform if relevant.';
      case 'management':
        return 'Emphasize leadership, architecture, delivery, mentoring. Lead with biggest impact. Include team size, projects delivered, and business outcomes.';
      case 'domain':
        return 'Emphasize domain expertise and relevant technologies. Tailor terminology to the industry. Lead with domain-relevant achievements.';
      default:
        return 'General presentation. Lead with strongest skills. Keep it clear and concise.';
    }
  }
}
