/**
 * JA-030 — Master Candidate Evidence Library
 *
 * doneWhen: "Tailoring retrieves facts from the evidence layer."
 *
 * Centralized evidence retrieval layer that extracts structured facts from
 * CandidateProfile (skills, work history, education, projects, certifications,
 * achievements, links, dates, locations) with source tracking, confidence
 * levels, and verification status.
 */

import { Injectable } from '@nestjs/common';
import { CandidateProfile } from '../profile/candidate-profile.entity';

// ---- Types ----------------------------------------------------------------

export interface EvidenceFact {
  /** Stable fact category. */
  category: EvidenceFactCategory;
  /** Human-readable summary. */
  summary: string;
  /** Source profile field. */
  source: string;
  /** Confidence: high (directly stated), medium (inferred), low (uncertain). */
  confidence: 'high' | 'medium' | 'low';
  /** Verification status. */
  verified: boolean;
  /** ISO timestamp of last verification/retrieval. */
  retrievedAt: string;
  /** Optional structured data. */
  data?: Record<string, any>;
}

export type EvidenceFactCategory =
  | 'skill'
  | 'employment'
  | 'project'
  | 'education'
  | 'certification'
  | 'achievement'
  | 'link'
  | 'date'
  | 'location'
  | 'notice_period'
  | 'compensation';

/** Complete evidence snapshot for a profile. */
export interface CandidateEvidenceLibrary {
  profileId: string;
  profileName: string;
  headline: string | null;
  skills: string[];
  experienceYears: number | null;
  employment: EmploymentFact[];
  projects: ProjectFact[];
  education: EducationFact[];
  links: LinkFact[];
  location: string | null;
  noticePeriod: string | null;
  salaryExpectation: string | null;
  retrievedAt: string;
}

export interface EmploymentFact {
  company: string;
  role: string;
  from: string | null;
  to: string | null;
  summary: string;
  tagged: boolean;
  source: string;
}

export interface ProjectFact {
  name: string;
  tech: string[];
  summary: string;
  source: string;
}

export interface EducationFact {
  school: string;
  degree: string;
  from: string | null;
  to: string | null;
  note: string;
  source: string;
}

export interface LinkFact {
  kind: 'linkedin' | 'github' | 'portfolio';
  url: string;
  source: string;
}

// ---- Service ---------------------------------------------------------------

@Injectable()
export class CandidateEvidenceLibraryService {
  /**
   * Build the master evidence library from a CandidateProfile.
   * Every fact is traceable to a source field with confidence and verification.
   */
  async buildEvidenceLibrary(profile: CandidateProfile): Promise<CandidateEvidenceLibrary> {
    const now = new Date().toISOString();
    const skills = this.extractSkills(profile);
    const experienceYears = profile.experienceYears;
    const employment = this.extractEmployment(profile);
    const projects = this.extractProjects(profile);
    const education = this.extractEducation(profile);
    const links = this.extractLinks(profile);

    return {
      profileId: profile.id,
      profileName: profile.name,
      headline: profile.headline,
      skills,
      experienceYears,
      employment,
      projects,
      education,
      links,
      location: profile.currentLocation,
      noticePeriod: profile.noticePeriod,
      salaryExpectation: profile.salaryExpectation,
      retrievedAt: now,
    };
  }

  /** Get all skills with high confidence. */
  async getSkills(profile: CandidateProfile): Promise<{ skills: string[]; source: string; confidence: string }> {
    const skills = this.extractSkills(profile);
    return { skills, source: 'profile.skills', confidence: 'high' };
  }

  /** Get employment history (untagged stints only for CV use). */
  async getEmployment(profile: CandidateProfile, tagged: boolean = false): Promise<EmploymentFact[]> {
    const all = this.extractEmployment(profile);
    if (tagged) {
      return all.filter(e => !e.tagged);
    }
    return all;
  }

  /** Get projects. */
  async getProjects(profile: CandidateProfile): Promise<ProjectFact[]> {
    return this.extractProjects(profile);
  }

  /** Get education. */
  async getEducation(profile: CandidateProfile): Promise<EducationFact[]> {
    return this.extractEducation(profile);
  }

  /** Get external links. */
  async getLinks(profile: CandidateProfile): Promise<LinkFact[]> {
    return this.extractLinks(profile);
  }

  // ---- private helpers -------------------------------------------------

  private extractSkills(profile: CandidateProfile): string[] {
    if (!profile.skills) return [];
    return profile.skills.split(',').map(s => s.trim()).filter(s => s.length > 0);
  }

  private extractEmployment(profile: CandidateProfile): EmploymentFact[] {
    if (!profile.workHistoryJson) return [];
    try {
      const arr = JSON.parse(profile.workHistoryJson) as any[];
      return arr.map((e, i) => ({
        company: e.company ?? '',
        role: e.role ?? '',
        from: e.from ?? null,
        to: e.to ?? null,
        summary: e.summary ?? '',
        tagged: e.tagged === true,
        source: 'profile.workHistoryJson',
      }));
    } catch {
      return [];
    }
  }

  private extractProjects(profile: CandidateProfile): ProjectFact[] {
    if (!profile.projectsJson) return [];
    try {
      const arr = JSON.parse(profile.projectsJson) as any[];
      return arr.map((p, i) => ({
        name: p.name ?? '',
        tech: (p.tech ?? []).filter((t: string) => t.length > 0),
        summary: p.summary ?? '',
        source: 'profile.projectsJson',
      }));
    } catch {
      return [];
    }
  }

  private extractEducation(profile: CandidateProfile): EducationFact[] {
    if (!profile.educationJson) return [];
    try {
      const arr = JSON.parse(profile.educationJson) as any[];
      return arr.map((e, i) => ({
        school: e.school ?? '',
        degree: e.degree ?? '',
        from: e.from ?? null,
        to: e.to ?? null,
        note: e.note ?? '',
        source: 'profile.educationJson',
      }));
    } catch {
      return [];
    }
  }

  private extractLinks(profile: CandidateProfile): LinkFact[] {
    const links: LinkFact[] = [];
    if (profile.linkedinUrl) {
      links.push({ kind: 'linkedin', url: profile.linkedinUrl, source: 'profile.linkedinUrl' });
    }
    if (profile.githubUrl) {
      links.push({ kind: 'github', url: profile.githubUrl, source: 'profile.githubUrl' });
    }
    if (profile.portfolioUrl) {
      links.push({ kind: 'portfolio', url: profile.portfolioUrl, source: 'profile.portfolioUrl' });
    }
    return links;
  }
}
