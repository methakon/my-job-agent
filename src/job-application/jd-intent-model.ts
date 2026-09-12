/**
 * JA-012 — JD Intent Extraction
 *
 * doneWhen: "Same JD produces a stable representation traceable to source text
 * or labelled inference."
 *
 * Extracts a structured representation from a job description: role, seniority,
 * must-have/preferred skills, responsibilities, experience, location/remote
 * rules, employment type, compensation, authorization, notice/start
 * requirements, technology/domain, channel, employer and freshness.
 *
 * Preserves original JD evidence and separates explicit requirements from
 * inference. Every extracted field carries an `evidence` tag so callers can
 * see whether the value came straight from the JD text or is a labelled
 * inference.
 */

export type EvidenceKind = 'explicit' | 'inferred';

export interface FieldEvidence {
  /** Whether the value was stated in the JD text or inferred. */
  evidence: EvidenceKind;
  /** Source clause from the JD (lowercased snippet) supporting the value, or '' when inferred. */
  source: string;
}

export interface JdSeniority {
  level: 'junior' | 'mid' | 'senior' | 'lead' | 'principal' | 'director' | 'head' | 'unknown';
  evidence: FieldEvidence;
}

export interface JdExperience {
  /** Minimum years required, or null when not stated. */
  minYears: number | null;
  /** Maximum years required, or null when not stated. */
  maxYears: number | null;
  evidence: FieldEvidence;
}

export interface JdSkill {
  name: string;
  kind: 'must-have' | 'preferred' | 'nice-to-have';
  evidence: FieldEvidence;
}

export interface JdResponsibility {
  text: string;
  evidence: FieldEvidence;
}

export interface JdLocation {
  raw: string;
  remoteAllowed: boolean | null; // null = not stated; true/false = explicit
  evidence: FieldEvidence;
}

export interface JdEmploymentType {
  kind: 'full-time' | 'part-time' | 'contract' | 'internship' | 'temporary' | 'freelance' | 'unknown';
  evidence: FieldEvidence;
}

export interface JdCompensation {
  raw: string;
  minCtc: number | null;
  maxCtc: number | null;
  currencyHint: string | null;
  evidence: FieldEvidence;
}

export interface JdAuthorization {
  required: boolean;
  kind: 'citizen' | 'pr' | 'work permit' | 'sponsorship' | 'no sponsorship' | 'unknown';
  evidence: FieldEvidence;
}

export interface JdNotice {
  /** 'immediate' | 'notice' | null when not stated */
  kind: 'immediate' | 'notice' | null;
  /** Parsed notice in days, or null when not parseable. */
  days: number | null;
  evidence: FieldEvidence;
}

export interface JdTechDomain {
  technologies: string[];
  domain: string | null; // e.g. 'fintech', 'saas', 'healthcare'
  evidence: FieldEvidence;
}

export interface JdChannel {
  kind: 'email' | 'ats' | 'portal' | 'referral' | 'external-link' | 'unknown';
  target: string | null;
  evidence: FieldEvidence;
}

export interface JdEmployer {
  name: string | null;
  industry: string | null;
  sizeHint: string | null;
  evidence: FieldEvidence;
}

export interface JdFreshness {
  posted: string | null; // raw posted-on string
  /** Approximate age in days, or null when unparseable. */
  ageDays: number | null;
  evidence: FieldEvidence;
}

export interface JdIntent {
  // Identity
  roleTitle: string | null;
  seniority: JdSeniority;
  employer: JdEmployer;
  // Requirements
  mustHaveSkills: JdSkill[];
  preferredSkills: JdSkill[];
  experience: JdExperience;
  responsibilities: JdResponsibility[];
  // Logistics
  location: JdLocation;
  employmentType: JdEmploymentType;
  compensation: JdCompensation;
  authorization: JdAuthorization;
  notice: JdNotice;
  // Domain
  techDomain: JdTechDomain;
  channel: JdChannel;
  // Temporal
  freshness: JdFreshness;
  // Evidence preservation
  originalText: string;
  /** Deterministic fingerprint of the JD text (first 64 chars of sha256 lower-cased trimmed text, hex).
   *  Same JD → same fingerprint. Used to prove stability of the representation. */
  fingerprint: string;
}
