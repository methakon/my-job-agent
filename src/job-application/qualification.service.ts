import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Not, IsNull } from 'typeorm';
import { JobLead as Lead } from '../leads/job-lead.entity';
import { CandidateProfile } from '../profile/candidate-profile.entity';
import { AstroLeadScore } from '../astro/astro-lead-scoring.service';
import { classifySkillGap, GapSeverity } from './skills/gap-severity';

// ---------------------------------------------------------------------------
// JA-010 Central Qualification Engine
//
// Deterministic. No AI. No randomness. Same inputs → same outputs, every time.
// Inputs:
//   profile, lead, astroScore, allowedLocations, excludedLocations,
//   experienceFloor, channelInfo
// Sub-evaluators:
//   1. eligibility  — location, experience, notice-period gate checks
//   2. evidence     — deterministic skill matching + title relevance from
//                     the existing text framework (set intersection, shared
//                     token ratio — no embeddings)
//   3. jobQuality   — score from ScoutService.scoreLead (reused as a pure
//                     deterministic function of title/skills/location); we
//                     depend on its numeric output, not its side effects
//   4. careerFit    — overlap / gap analysis between profile skills and job
//                     required skills — purely set arithmetic
//   5. channelReady — can the application actually go out? answer bank
//                     coverage, CV availability, source adapter present
// ---------------------------------------------------------------------------

export type QualificationDecision =
  | 'QUALIFIED'
  | 'CONDITIONAL'
  | 'NEAR_MISS'
  | 'REJECT'
  | 'INSUFFICIENT_DATA';

export type RequiredAction =
  | 'proceed'
  | 'needs_info'
  | 'do_not_apply'
  | 'partial'
  | 'revisit';

export interface EvaluatorResult {
  passed: boolean;
  score: number;          // 0-100 contribution weight (used for composite)
  reasons: string[];
  tags?: string[];        // evidence tags surfaced to callers
}

export interface EligibilityResult extends EvaluatorResult {
  locationOk: boolean;
  locationReason?: string;
  experienceOk: boolean;
  experienceReason?: string;
  noticeOk: boolean;
  noticeReason?: string;
}

export interface EvidenceResult extends EvaluatorResult {
  skillMatches: number;   // intersection size
  totalProfileSkills: number;
  requiredSkillCount: number;
  titleRelevance: number; // 0-1 shared-token ratio
  matchedTags: string[];
  // ---- JA-015: skill-gap severity (consumed by decide) --------------------
  gapSeverity?: import('./skills/gap-severity').GapSeverity;
  gapReasons?: string[];
  gapMissingMustHave?: string[];
  gapMissingPreferred?: string[];
  gapCovered?: string[];
  gapMitigatedMustHaves?: Array<{ skill: string; transferable: string[]; related: string[] }>;
  gapMitigatedPreferred?: Array<{ skill: string; transferable: string[]; related: string[] }>;
}

export interface JobQualityResult extends EvaluatorResult {
  label: string;          // 'high' | 'medium' | 'low' | 'unknown'
  source: string;
}

export interface CareerFitResult extends EvaluatorResult {
  overlapTags: string[];
  gapTags: string[];
  aligned: boolean;
}

export interface ChannelReadyResult extends EvaluatorResult {
  missing: string[];
  hasAnswerBank: boolean;
  hasCv: boolean;
  hasAdapter: boolean;
}

export interface QualificationEvidence {
  eligibility: EligibilityResult;
  evidence: EvidenceResult;
  jobQuality: JobQualityResult;
  careerFit: CareerFitResult;
  channelReady: ChannelReadyResult;
}

export interface QualificationResult {
  decision: QualificationDecision;
  requiredAction: RequiredAction;
  compositeScore: number;     // 0-100, deterministic composite
  evidence: QualificationEvidence;
  reasons: string[];          // human-readable, ordered
  evaluatedAt: string;        // ISO timestamp (informational, not part of decision)
  leadId: string;
  profileId: string;
}

// ---- Pure helper functions (deterministic, no I/O) ----------------------------

/** shared non-stop-word tokens between two normalised strings */
function sharedTokenRatio(a: string, b: string): number {
  if (!a || !b) return 0;
  const STOP = new Set(['the','a','an','and','or','for','with','in','on','at','to','of','is','it','we','our','you','your','that','this','as','by','from','not','no','be','are','was','has','have','will','would','can','could','should','may','all','also','more','new','based','using','use','working','work','who','what','which','how','when','where','why']);
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(t => t.length >= 2 && !STOP.has(t));
  const sa = new Set(norm(a));
  const sb = new Set(norm(b));
  if (sa.size === 0 && sb.size === 0) return 0;
  let shared = 0;
  for (const t of sa) { if (sb.has(t)) shared++; }
  return shared / Math.max(sa.size, sb.size);
}

function skillOverlap(profileSkills: string[], required: string[]): { matched: string[]; missing: string[] } {
  const ps = new Set((profileSkills || []).map(s => s.toLowerCase().trim()).filter(Boolean));
  const req = (required || []).map(s => s.toLowerCase().trim()).filter(Boolean);
  const matched: string[] = [];
  const missing: string[] = [];
  for (const r of req) {
    if (ps.has(r)) matched.push(r);
    else missing.push(r);
  }
  return { matched, missing };
}

function parseNoticePeriod(value: string | null | undefined): number | null {
  if (!value) return null;
  const v = value.toLowerCase().trim();
  const m = v.match(/^(\d+)\s*(day|days|week|weeks|month|months)$/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const unit = m[2].startsWith('week') ? 7 : m[2].startsWith('month') ? 30 : 1;
  return n * unit;
}

/** Split a comma-separated string (as stored in CandidateProfile.skills) into an array. */

function splitComma(v: string | null | undefined): string[] {
  if (!v) return [];
  return v.split(',').map(s => s.trim()).filter(Boolean);
}

// ---- Main service -----------------------------------------------------------

@Injectable()
export class QualificationService {
  constructor(
    @InjectRepository(Lead) private readonly leadRepo: Repository<Lead>,
    @InjectRepository(CandidateProfile) private readonly profileRepo: Repository<CandidateProfile>,
  ) {}

  // ---- public API ----------------------------------------------------------

  /**
   * Evaluate one profile+lead pair deterministically.
   *
   * `scoreLead` is called inside `jobQuality` so we reuse the existing
   * deterministic title+skills relevance scorer as one input to the composite.
   * It is pure with respect to its arguments and has no side effects beyond
   * the returned number; the qualification decision does not depend on any
   * mutable state elsewhere.
   */
  async evaluate(params: {
    leadId: string;
    profileId: string;
    allowedLocations?: string[];
    excludedLocations?: string[];
    experienceFloor?: number;
    channelInfo?: {
      hasAnswerBank: boolean;
      hasCv: boolean;
      source: string;
    };
  }): Promise<QualificationResult> {
    const lead = await this.leadRepo.findOne({ where: { id: params.leadId } });
    if (!lead) throw new NotFoundException(`lead ${params.leadId} not found`);

    const profile = await this.profileRepo.findOne({ where: { id: params.profileId } });
    if (!profile) throw new NotFoundException(`profile ${params.profileId} not found`);

    const astro: AstroLeadScore | null = null;  // AstroLeadScore is an interface (not a DB entity); scoring is used as a separate signal

    const ev = this.evaluateInternal(lead, profile, astro, params);
    return ev;
  }

  // ---- internal deterministic evaluator -----------------------------------

  private evaluateInternal(
    lead: Lead,
    profile: CandidateProfile,
    astro: AstroLeadScore | null,
    params: {
      allowedLocations?: string[];
      excludedLocations?: string[];
      experienceFloor?: number;
      channelInfo?: { hasAnswerBank: boolean; hasCv: boolean; source: string };
    },
  ): QualificationResult {
    const eligibility = this.assessEligibility(lead, profile, params);
    const evidence = this.assessEvidence(lead, profile);
    const jobQuality = this.assessJobQuality(lead, params.channelInfo?.source ?? 'scout');
    const careerFit = this.assessCareerFit(profile, lead);
    const channelReady = this.assessChannelReady(lead, params.channelInfo);

    const evidenceRecord: QualificationEvidence = {
      eligibility,
      evidence,
      jobQuality,
      careerFit,
      channelReady,
    };

    const compositeScore = this.computeComposite(evidenceRecord);
    const { decision, requiredAction, reasons } = this.decide(compositeScore, evidenceRecord);

    return {
      decision,
      requiredAction,
      compositeScore,
      evidence: evidenceRecord,
      reasons,
      evaluatedAt: new Date().toISOString(),  // informational only; not part of decision
      leadId: lead.id,
      profileId: profile.id,
    };
  }

  // ---- sub-evaluators ------------------------------------------------------

  private assessEligibility(
    lead: Lead,
    profile: CandidateProfile,
    params: { allowedLocations?: string[]; excludedLocations?: string[]; experienceFloor?: number },
  ): EligibilityResult {
    const reasons: string[] = [];
    const hardFail: string[] = [];
    const unknown: string[] = [];
    let locationOk = true;
    let locationReason: string | undefined;

    // ---- location gate (existing logic, expanded) ----
    const loc = (lead.location ?? '').trim();
    const cloc = (profile.currentLocation ?? '').trim().toLowerCase();
    const allowed = (params.allowedLocations ?? []).map(s => s.toLowerCase().trim()).filter(Boolean);
    const excluded = (params.excludedLocations ?? []).map(s => s.toLowerCase().trim()).filter(Boolean);

    if (excluded.length > 0) {
      if (excluded.some(e => cloc.includes(e) || loc.toLowerCase().includes(e))) {
        locationOk = false;
        locationReason = `location excluded (${loc || 'unknown'})`;
        hardFail.push(locationReason);
        reasons.push(locationReason);
      }
    } else if (allowed.length > 0) {
      const hit = allowed.some(a => cloc.includes(a) || loc.toLowerCase().includes(a));
      if (!hit) {
        locationOk = false;
        locationReason = `location not in allowed list (${loc || 'unknown'})`;
        hardFail.push(locationReason);
        reasons.push(locationReason);
      }
    } else {
      // no location filter set — no fact to check; UNKNOWN if lead has no location
      if (!loc) {
        unknown.push('lead location not specified; no location filter configured');
      }
    }

    // ---- experience floor ----
    let experienceOk = true;
    let experienceReason: string | undefined;
    const floor = params.experienceFloor ?? 0;
    const exp = profile.experienceYears;
    if (floor > 0) {
      if (exp != null && exp >= floor) {
        // satisfied
        reasons.push(`experience ${exp}yr >= floor ${floor}yr`);
      } else if (exp != null && exp < floor) {
        experienceOk = false;
        experienceReason = `experience ${exp}yr < floor ${floor}yr`;
        hardFail.push(experienceReason);
        reasons.push(experienceReason);
      } else {
        // exp is null/unknown — cannot confirm; not a hard fail, mark UNKNOWN
        unknown.push(`profile experience years not recorded; cannot verify ${floor}yr floor`);
      }
    }

    // ---- notice period ----
    const noticeRaw = (profile.noticePeriod ?? '').trim().toLowerCase();
    const noticeDays = parseNoticePeriod(profile.noticePeriod);
    const leadDesc = (lead.description ?? '').toLowerCase();
    // Look for notice hints in lead description: "immediate", "X days notice", "X weeks notice", "start immediately"
    const noticeMentionedInLead = /(immediate|start\s+immediately|join\s+(us|the)\s+(team|company)?\s+(immediately)?|\d+\s*(day|days|week|weeks)\s*notice)/i.test(leadDesc);
    let noticeOk = true;
    let noticeReason: string | undefined;
    if (noticeDays != null && noticeMentionedInLead) {
      // profile has explicit notice; lead mentions notice/immediate — check if lead requires immediate
      const leadRequiresImmediate = /\b(immediate|start\s+immediately|join\s+(us|the)\s+(team|company)?\s+immediately)\b/i.test(leadDesc);
      if (leadRequiresImmediate && noticeDays > 0) {
        noticeOk = false;
        noticeReason = `profile notice ${noticeDays}d; lead requires immediate start`;
        hardFail.push(noticeReason);
        reasons.push(noticeReason);
      } else {
        reasons.push(`notice period ${noticeDays}d; lead mentions notice/immediate`);
      }
    } else if (noticeDays != null) {
      reasons.push(`notice period ${noticeDays}d (lead does not specify)`);
    } else {
      unknown.push('profile notice period not recorded; cannot verify against lead');
    }

    // ---- salary ----
    const salaryRaw = (profile.salaryExpectation ?? '').trim().toLowerCase();
    const salaryMentionedInLead = /\b(salary|pay|compensation|ctc|package|remuneration|pay\s*range|salary\s*range)\b/i.test(leadDesc);
    let salaryOk = true;
    let salaryReason: string | undefined;
    if (salaryRaw && salaryMentionedInLead) {
      reasons.push(`candidate states salary expectation; lead mentions salary`);
      // We cannot parse numbers reliably from free text without guessing;
      // defer to UNKNOWN rather than hard-fail on unparseable values
      unknown.push('salary comparison deferred — numeric parsing not attempted (avoids guessing)');
    } else if (salaryRaw) {
      reasons.push('candidate states salary expectation; lead does not mention salary');
    } else if (salaryMentionedInLead) {
      unknown.push('lead mentions salary; candidate has not stated expectation');
    }

    // ---- employment type ----
    const profileEmpTypePref = this.extractEmploymentTypePref(profile);
    const leadEmpType = this.extractEmploymentType(leadDesc);
    let empTypeOk = true;
    let empTypeReason: string | undefined;
    if (profileEmpTypePref && leadEmpType) {
      if (profileEmpTypePref === 'fulltime' && leadEmpType === 'parttime') {
        empTypeOk = false;
        empTypeReason = 'profile prefers full-time; lead is part-time';
        hardFail.push(empTypeReason);
        reasons.push(empTypeReason);
      } else if (profileEmpTypePref === 'parttime' && leadEmpType === 'fulltime') {
        empTypeOk = false;
        empTypeReason = 'profile prefers part-time; lead is full-time';
        hardFail.push(empTypeReason);
        reasons.push(empTypeReason);
      } else {
        reasons.push(`employment type alignment: candidate ${profileEmpTypePref}, lead ${leadEmpType}`);
      }
    } else if (profileEmpTypePref) {
      reasons.push(`candidate prefers ${profileEmpTypePref}; lead type not specified in description`);
    } else if (leadEmpType) {
      reasons.push(`lead is ${leadEmpType}; candidate employment preference not recorded`);
    } else {
      unknown.push('employment type not specified by either side');
    }

    // ---- seniority ----
    const profileSeniority = this.extractSeniority(profile.headline ?? '', profile.experienceYears);
    const leadSeniority = this.extractSeniority((lead.title ?? '') + ' ' + (lead.description ?? ''), profile.experienceYears);
    let seniorityOk = true;
    let seniorityReason: string | undefined;
    if (profileSeniority && leadSeniority && profileSeniority !== leadSeniority) {
      // Mismatch is not always a hard fail — junior candidate can apply for mid-level roles
      // but senior candidate for junior role is usually a mismatch
      const rank = { 'junior': 1, 'mid': 2, 'senior': 3, 'lead': 4, 'principal': 5, 'head': 6, 'director': 7 };
      const pr = rank[profileSeniority] ?? 0;
      const lr = rank[leadSeniority] ?? 0;
      if (pr > 0 && lr > 0 && pr > lr + 1) {
        seniorityOk = false;
        seniorityReason = `candidate seniority ${profileSeniority} well above lead ${leadSeniority}`;
        hardFail.push(seniorityReason);
        reasons.push(seniorityReason);
      } else {
        reasons.push(`seniority: candidate ${profileSeniority ?? 'unspecified'}, lead ${leadSeniority ?? 'unspecified'}`);
      }
    } else {
      if (!profileSeniority && !leadSeniority) {
        unknown.push('seniority not evident from either profile or lead title');
      } else {
        reasons.push(`seniority: candidate ${profileSeniority ?? '?'}, lead ${leadSeniority ?? '?'}`);
      }
    }

    // ---- language ----
    const profileLangs = this.extractLanguages(profile);
    const leadLangReq = this.extractLanguageReq(leadDesc);
    let languageOk = true;
    let languageReason: string | undefined;
    if (leadLangReq && profileLangs.length === 0) {
      unknown.push(`lead requires ${leadLangReq}; candidate languages not recorded`);
    } else if (leadLangReq && profileLangs.length > 0) {
      const hit = profileLangs.some(l => leadLangReq.includes(l.toLowerCase()));
      if (hit) {
        reasons.push(`language: candidate has ${profileLangs.join(', ')}; lead requires ${leadLangReq.join(', ')}`);
      } else {
        languageOk = false;
        languageReason = `lead requires ${leadLangReq.join(', ')}; candidate languages (${profileLangs.join(', ') || 'none recorded'}) do not match`;
        hardFail.push(languageReason);
        reasons.push(languageReason);
      }
    } else if (profileLangs.length > 0) {
      reasons.push(`candidate languages: ${profileLangs.join(', ')} (lead does not specify)`);
    }

    // ---- employment authorization (work authorization) ----
    // Extract from profile text fields (headline, workHistory note, education note) — never guess
    const profileAuth = this.extractWorkAuth(profile);
    const leadAuthReq = this.extractWorkAuthReq(leadDesc);
    let authOk = true;
    let authReason: string | undefined;
    if (leadAuthReq && profileAuth === null) {
      unknown.push(`lead requires authorization: ${leadAuthReq}; candidate work auth not recorded`);
    } else if (leadAuthReq && profileAuth) {
      if (this.authCompatible(profileAuth, leadAuthReq)) {
        reasons.push(`work authorization compatible: candidate ${profileAuth}, lead requires ${leadAuthReq}`);
      } else {
        authOk = false;
        authReason = `work authorization mismatch: candidate ${profileAuth}, lead requires ${leadAuthReq}`;
        hardFail.push(authReason);
        reasons.push(authReason);
      }
    } else if (profileAuth) {
      reasons.push(`candidate work auth: ${profileAuth} (lead does not specify)`);
    }

    // ---- education / certification (only when genuinely required by lead) ----
    const leadEduReq = this.extractEducationReq(leadDesc);
    const profileEducation = this.parseEducation(profile.educationJson);
    let eduOk = true;
    let eduReason: string | undefined;
    if (leadEduReq && leadEduReq !== 'not specified') {
      if (profileEducation.length === 0) {
        unknown.push(`lead requires ${leadEduReq}; candidate education not recorded`);
      } else {
        const match = this.educationMatches(profileEducation, leadEduReq);
        if (match) {
          reasons.push(`education match: candidate has ${match}; lead requires ${leadEduReq}`);
        } else {
          eduOk = false;
          eduReason = `lead requires ${leadEduReq}; candidate education (${profileEducation.join(', ') || 'none'}) does not match`;
          hardFail.push(eduReason);
          reasons.push(eduReason);
        }
      }
    }

    // ---- mandatory experience/skills (hard requirement from description) ----
    // Derived from KNOWN_TECH already extracted in assessEvidence; here we treat
    // them as HARD requirements: a candidate who is missing a known-tech keyword
    // that appears in the description gets a HARD_FAIL on that skill.
    const profileSkills = splitComma(profile.skills);
    const desc = (lead.description ?? '').toLowerCase();
    const KNOWN_TECH = [
      'javascript','typescript','python','java','kotlin','scala','go','rust','c++','c#','dotnet',
      'react','angular','vue','node','nodejs','express','django','flask','fastapi','spring','rails','laravel',
      'sql','postgresql','mysql','mongodb','redis','kafka','docker','kubernetes','aws','azure','gcp',
      'machine learning','deep learning','nlp','data engineering','devops','sre',
    ].map(s => s.trim().toLowerCase()).filter(Boolean);
    const requiredTechInDesc: string[] = [];
    for (const tech of KNOWN_TECH) {
      if (desc.includes(tech)) requiredTechInDesc.push(tech);
    }
    let skillsOk = true;
    let skillsReason: string | undefined;
    if (requiredTechInDesc.length > 0) {
      const ps = new Set(profileSkills.map(s => s.toLowerCase().trim()).filter(Boolean));
      const missingMandatory = requiredTechInDesc.filter(t => !ps.has(t));
      if (missingMandatory.length > 0) {
        skillsOk = false;
        skillsReason = `missing mandatory skill(s) from description: ${missingMandatory.slice(0, 5).join(', ')}${missingMandatory.length > 5 ? ` (+${missingMandatory.length - 5} more)` : ''}`;
        hardFail.push(skillsReason);
        reasons.push(skillsReason);
      } else {
        reasons.push(`all ${requiredTechInDesc.length} mandatory tech(s) from description present in profile`);
      }
    }

    // ---- overall ----
    const allHardFail = [...hardFail];
    const allUnknown = [...unknown];
    const passed = locationOk && experienceOk && noticeOk && empTypeOk && seniorityOk &&
      languageOk && authOk && eduOk && skillsOk;

    // Build reasons: hard fails first, then info, then unknowns (unknowns are not failures)
    const orderedReasons: string[] = [];
    for (const f of allHardFail) orderedReasons.push(`HARD_FAIL: ${f}`);
    for (const r of reasons) {
      if (!allHardFail.includes(r) && !orderedReasons.includes(r)) orderedReasons.push(r);
    }
    for (const u of allUnknown) orderedReasons.push(`UNKNOWN: ${u}`);

    const score = this.eligibilityScore(locationOk, experienceOk, noticeOk, empTypeOk, seniorityOk,
      languageOk, authOk, eduOk, skillsOk, allUnknown.length);

    return {
      passed,
      score,
      reasons: orderedReasons,
      locationOk,
      locationReason,
      experienceOk,
      experienceReason,
      noticeOk,
      noticeReason,
    };
  }

  // ---- hard eligibility helper extractors (deterministic, no guessing) ---------

  private extractEmploymentTypePref(profile: CandidateProfile): string | null {
    // Check headline and skills text for explicit preference markers
    const text = [(profile.headline ?? ''), (profile.skills ?? '')].join(' ').toLowerCase();
    if (/\b(freelance|contract|part.time|part time|temporary|intern|internship)\b/.test(text)) return 'parttime';
    if (/\b(full.time|full time|permanent|ft|eigh?\s*week|fulltime)\b/.test(text)) return 'fulltime';
    return null; // UNKNOWN
  }

  private extractEmploymentType(desc: string): string | null {
    const d = desc.toLowerCase();
    if (/\b(part.time|part time|part-time|contract|temporary|freelance|intern|internship|seasonal)\b/.test(d)) return 'parttime';
    if (/\b(full.time|full time|full-time|permanent|ft|fulltime)\b/.test(d)) return 'fulltime';
    return null; // UNKNOWN
  }

  private extractSeniority(text: string, experienceYears?: number | null): string | null {
    const t = text.toLowerCase();
    if (/\b(principal|staff\s*(engineer|)?|sr\.?|senior|lead|architect|head|director|vp|vice\s*president)\b/.test(t)) {
      if (/\b(principal|director|head of|vp|vice president)\b/.test(t)) return 'director';
      if (/\b(lead|architect)\b/.test(t)) return 'lead';
      return 'senior';
    }
    if (/\b(mid|intermediate|2\.?-\s*years|3\.?-\s*years|4\.?-\s*years|3-5|5-7)\b/.test(t)) return 'mid';
    if (experienceYears != null && experienceYears >= 5) return 'senior';
    if (experienceYears != null && experienceYears >= 2) return 'mid';
    if (/\b(junior|jr\.?|entry|associate|fresher|0-1|1-2)\b/.test(t)) return 'junior';
    if (experienceYears != null && experienceYears < 2) return 'junior';
    return null; // UNKNOWN
  }

  private extractLanguages(profile: CandidateProfile): string[] {
    // Languages may appear in headline, skills, education note, work history summary
    const texts = [
      profile.headline ?? '',
      profile.skills ?? '',
      ...((() => {
        try { return JSON.parse(profile.educationJson ?? '[]').map((e: any) => (e.note ?? '')); } catch { return []; }
      })()),
      ...((() => {
        try { return JSON.parse(profile.workHistoryJson ?? '[]').map((w: any) => (w.summary ?? '')); } catch { return []; }
      })()),
    ];
    const all = texts.join(' ').toLowerCase();
    // Common language names (very limited — only flag what's explicit)
    const LANG = ['english','hindi','bengali','bengali','tamil','telugu','marathi','gujarati','punjabi',
      'french','german','spanish','mandarin','chinese','japanese','korean','portuguese','italian','dutch'];
    const found: string[] = [];
    for (const lang of LANG) {
      // word-boundary match to avoid substrings
      if (new RegExp('\\b' + lang.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i').test(all)) {
        found.push(lang);
      }
    }
    return found.length > 0 ? found : [];
  }

  private extractLanguageReq(desc: string): string[] {
    const d = desc.toLowerCase();
    const LANG = ['english','hindi','bengali','tamil','telugu','marathi','gujarati','punjabi',
      'french','german','spanish','mandarin','chinese','japanese','korean','portuguese','italian','dutch'];
    const found: string[] = [];
    for (const lang of LANG) {
      if (new RegExp('\\b' + lang.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i').test(d)) {
        found.push(lang);
      }
    }
    return found;
  }

  private extractWorkAuth(profile: CandidateProfile): string | null {
    // Look for explicit work authorization mentions in profile text fields.
    // Common patterns: "citizen", "PR", "green card", "work permit", "EU citizen", "willing to relocate/sponsor"
    const texts = [
      profile.headline ?? '',
      ...((() => {
        try { return JSON.parse(profile.workHistoryJson ?? '[]').map((w: any) => (w.summary ?? '')); } catch { return []; }
      })()),
      ...((() => {
        try { return JSON.parse(profile.educationJson ?? '[]').map((e: any) => (e.note ?? '')); } catch { return []; }
      })()),
    ];
    const all = texts.join(' ').toLowerCase();
    if (/\b(indian\s*(citizen|p國家)?|india\s*citizen|citizen\s*of\s*india)\b/.test(all)) return 'Indian citizen';
    if (/\b(pr|permanent\s*resident|green\s*card|gc)\b/.test(all)) return 'US PR / Green Card';
    if (/\b(uk\s*citizen|europe\s*citizen|eu\s*citizen|european\s*citizen)\b/.test(all)) return 'EU citizen';
    if (/\b(willing\s*to\s*relocate|open\s*to\s*relocation|rizhi|visa\s*sponsor|sponsorship\s*available)\b/.test(all)) return 'open to relocation / visa sponsorship';
    if (/\b(us\s*citizen|canadian\s*citizen|australian\s*citizen)\b/.test(all)) return 'US/CA/AU citizen';
    return null; // UNKNOWN
  }

  private extractWorkAuthReq(desc: string): string | null {
    const d = desc.toLowerCase();
    if (/\b(citizen|permanent\s*resident|green\s*card|pr|work\s*permit|visa\s*required|authorization\s*to\s*work)\b/.test(d)) {
      if (/\b(us|united\s*states|america)\b/.test(d)) return 'US work authorization';
      if (/\b(uk|britain|england)\b/.test(d)) return 'UK work authorization';
      if (/\b(eu|europe|european)\b/.test(d)) return 'EU work authorization';
      if (/\b(india|indian)\b/.test(d)) return 'Indian work authorization';
      return 'work authorization required (jurisdiction not specified)';
    }
    if (/\b(only\s*for\s*citizens|citizens\s*only|citizen\s*only|no\s*sponsorship|no\s*visa\s*sponsor)\b/.test(d)) {
      return 'citizenship required — no sponsorship';
    }
    return null; // UNKNOWN
  }

  private extractEducationReq(desc: string): string | null {
    const d = desc.toLowerCase();
    if (/\b(mba|master(?:'s)?|ms|ma|msc|m\.?tech)\b/.test(d)) return 'postgraduate degree';
    if (/\b(b\.?tech|b\.?e\.?|be|b\.?sc|ba|b\.?com|b\.?pharm|b arch)\b/.test(d)) return 'undergraduate degree';
    if (/\b(phd|doctorate|doctor|ph\.?d)\b/.test(d)) return 'doctorate';
    if (/\b(degre|diploma|graduate|postgrad|alma\s*mater|from\s+[\w\s]+university|from\s+[\w\s]+college)\b/.test(d)) return 'degree/diploma required';
    if (/\b(certification|certified|cert|aws\s*certified|azure\s*certified|google\s*certified|ckad|cka|kubernetes\s*certified)\b/.test(d)) return 'certification required';
    return null; // not specified
  }

  private parseEducation(educationJson: string | null | undefined): string[] {
    if (!educationJson) return [];
    try {
      const arr = JSON.parse(educationJson) as { degree?: string; school?: string; note?: string }[];
      return arr.filter(Boolean).map(e => [
        (e.degree ?? '').trim(),
        (e.school ?? '').trim(),
        (e.note ?? '').trim(),
      ].filter(Boolean).join(' / ')).filter(Boolean);
    } catch { return []; }
  }

  private educationMatches(education: string[], req: string): string | null {
    const lowerEdu = education.map(e => e.toLowerCase());
    const lowerReq = req.toLowerCase();
    if (lowerReq.includes('postgraduate') || lowerReq.includes('master') || lowerReq.includes('mba')) {
      if (lowerEdu.some(e => /\b(master|m\.?tech|m\.?e\.?|mba|pgdm|postgrad)\b/.test(e))) return education.find(e => /\b(master|m\.?tech|m\.?e\.?|mba|pgdm|postgrad)\b/i.test(e)) || null;
    }
    if (lowerReq.includes('undergraduate') || lowerReq.includes('b\.?tech') || lowerReq.includes('b\.?e') || lowerReq.includes('b\.?sc') || lowerReq.includes('ba') || lowerReq.includes('b\.?com')) {
      if (lowerEdu.some(e => /\b(b\.?tech|b\.?e\.?|b\.?sc|ba|b\.?com|b\.?arch|engineering|science|arts|commerce)\b/.test(e))) return education.find(e => /\b(b\.?tech|b\.?e\.?|b\.?sc|ba|b\.?com|b\.?arch|engineering|science|arts|commerce)\b/i.test(e)) || null;
    }
    if (lowerReq.includes('doctorate') || lowerReq.includes('phd') || lowerReq.includes('doctor')) {
      if (lowerEdu.some(e => /\b(phd|doctorate|doctor|ph\.?d)\b/.test(e))) return education.find(e => /\b(phd|doctorate|doctor|ph\.?d)\b/i.test(e)) || null;
    }
    if (lowerReq.includes('certification')) {
      if (lowerEdu.some(e => /\b(certif|certified|aws|azure|google|cka|ckad)\b/.test(e))) return education.find(e => /\b(certif|certified|aws|azure|google|cka|ckad)\b/i.test(e)) || null;
    }
    if (lowerReq.includes('degree') || lowerReq.includes('diploma') || lowerReq.includes('graduate')) {
      if (lowerEdu.some(e => /\b(degree|diploma|graduate|university|college|b\.?|m\.?)\b/.test(e))) return education.find(e => /\b(degree|diploma|graduate|university|college|b\.?|m\.?)\b/i.test(e)) || null;
    }
    return null;
  }

  private authCompatible(profileAuth: string, leadAuthReq: string): boolean {
    const pa = profileAuth.toLowerCase();
    const la = leadAuthReq.toLowerCase();
    if (la.includes('india') && pa.includes('indian citizen')) return true;
    if (la.includes('us') || la.includes('united states') || la.includes('america')) {
      if (pa.includes('us citizen') || pa.includes('green card') || pa.includes('pr') || pa.includes('united states')) return true;
    }
    if (la.includes('uk')) {
      if (pa.includes('uk citizen') || pa.includes('british')) return true;
    }
    if (la.includes('eu') || la.includes('europe')) {
      if (pa.includes('eu citizen') || pa.includes('european')) return true;
    }
    if (la.includes('no sponsorship') || la.includes('citizens only')) {
      // Only citizens/PRs compatible
      if (pa.includes('citizen') || pa.includes('pr') || pa.includes('green card')) return true;
      return false;
    }
    if (pa.includes('open to relocation') || pa.includes('visa sponsorship')) return true;
    // If we can't determine compatibility, don't falsely reject — mark UNKNOWN upstream
    return false;
  }

  private eligibilityScore(
    locationOk: boolean, experienceOk: boolean, noticeOk: boolean,
    empTypeOk: boolean, seniorityOk: boolean, languageOk: boolean,
    authOk: boolean, eduOk: boolean, skillsOk: boolean,
    unknownCount: number,
  ): number {
    // Each hard-check passes → 10 points; all 9 checks → 90 max.
    // Unknowns reduce score (information gap) but don't zero it.
    let passed = 0;
    if (locationOk) passed++;
    if (experienceOk) passed++;
    if (noticeOk) passed++;
    if (empTypeOk) passed++;
    if (seniorityOk) passed++;
    if (languageOk) passed++;
    if (authOk) passed++;
    if (eduOk) passed++;
    if (skillsOk) passed++;
    const base = (passed / 9) * 90;
    const unknownPenalty = Math.min(30, unknownCount * 10);
    return Math.round(base - unknownPenalty);
  }

  private assessEvidence(lead: Lead, profile: CandidateProfile): EvidenceResult {
    const reasons: string[] = [];
    const profileSkills = splitComma(profile.skills);
    const requiredSkills: string[] = [];
    const requirements: Array<{ name: string; kind: 'must-have' | 'preferred' | 'nice-to-have' }> = [];

    // Pull required skills from lead description via deterministic extraction
    // (keyword-based, not AI). We keep it simple: known tech tags present in
    // the description are treated as required skills.
    const desc = (lead.description ?? '').toLowerCase();
    const KNOWN_TECH = [
      'javascript','typescript','python','java','kotlin','scala','go','rust','c++','c#','dotnet',
      'react','angular','vue','node','nodejs','express','django','flask','fastapi','spring','rails','laravel',
      'sql','postgresql','mysql','mongodb','redis','kafka','docker','kubernetes','aws','azure','gcp',
      'machine learning','deep learning','nlp','data engineering','devops','sre',' Mycrocsvr ',
    ].map(s => s.trim().toLowerCase()).filter(Boolean);

    for (const tech of KNOWN_TECH) {
      if (desc.includes(tech)) {
        requiredSkills.push(tech);
        requirements.push({ name: tech, kind: 'must-have' });
      }
    }

    // ---- JA-015: compute skill-gap severity --------------------------------
    // Build the classifier input from data already available in this evaluator.
    // The classifier is standalone, pure, deterministic — no side effects.
    let gapSeverity: GapSeverity | undefined;
    let gapReasons: string[] | undefined;
    let gapMissingMustHave: string[] | undefined;
    let gapMissingPreferred: string[] | undefined;
    let gapCovered: string[] | undefined;
    let gapMitigatedMustHaves: Array<{ skill: string; transferable: string[]; related: string[] }> | undefined;
    let gapMitigatedPreferred: Array<{ skill: string; transferable: string[]; related: string[] }> | undefined;
    try {
      const profileSkillSet = new Set(profileSkills.map(s => s.toLowerCase().trim()).filter(Boolean));
      const profileSeniority = this.extractSeniority(profile.headline ?? '', profile.experienceYears);
      const leadSeniority = this.extractSeniority((lead.title ?? '') + ' ' + (lead.description ?? ''), profile.experienceYears);
      const gapResult = classifySkillGap({
        profileSkills: profileSkillSet,
        requirements,
        profileSeniority,
        leadSeniority,
      });
      gapSeverity = gapResult.severity;
      gapReasons = gapResult.reasons;
      gapMissingMustHave = gapResult.missingMustHave;
      gapMissingPreferred = gapResult.missingPreferred;
      gapCovered = gapResult.covered;
      gapMitigatedMustHaves = gapResult.mitigatedMustHaves;
      gapMitigatedPreferred = gapResult.mitigatedPreferred;
    } catch (e) {
      // Classifier unavailable — degrade gracefully, do not break qualification
      reasons.push(`gap-severity classification unavailable: ${e instanceof Error ? e.message : String(e)}`);
    }
    // -------------------------------------------------------------------------

    const { matched, missing } = skillOverlap(profileSkills, requiredSkills);
    const skillMatches = matched.length;
    const totalProfileSkills = profileSkills.length;
    const requiredSkillCount = requiredSkills.length;

    // title relevance: shared tokens between profile headline and job title
    const headline = profile.headline ?? '';
    const titleRelevance = sharedTokenRatio(headline, lead.title ?? '');

    if (skillMatches > 0) {
      reasons.push(`${skillMatches} skill match(es): ${matched.slice(0, 5).join(', ')}`);
    }
    if (titleRelevance > 0.3) {
      reasons.push(`title relevance ${titleRelevance.toFixed(2)}`);
    }

    const matchedTags = matched.slice(0, 10);
    return {
      passed: skillMatches > 0 || titleRelevance > 0.2,
      score: Math.min(100, (skillMatches / Math.max(1, requiredSkillCount)) * 50 + titleRelevance * 50),
      reasons,
      skillMatches,
      totalProfileSkills,
      requiredSkillCount,
      titleRelevance,
      matchedTags,
      // ---- JA-015: expose gap severity to callers / decide() --------------
      gapSeverity,
      gapReasons,
      gapMissingMustHave,
      gapMissingPreferred,
      gapCovered,
      gapMitigatedMustHaves,
      gapMitigatedPreferred,
      // ---------------------------------------------------------------------
    };
  }

  private assessJobQuality(lead: Lead, source: string): JobQualityResult {
    // Reuse the existing deterministic ScoutService.scoreLead as one quality
    // signal. We import it lazily to avoid boot-time coupling to the scout
    // module (which may depend on external adapters). The score is deterministic.
    try {
      const { ScoutService } = require('../scout/scout.service');
      const scout = new ScoutService();
      // scoreLead is synchronous and deterministic given the lead fields
      const rawScore = scout.scoreLead(lead);
      const score = Math.max(0, Math.min(100, rawScore));
      const label = score >= 70 ? 'high' : score >= 40 ? 'medium' : 'low';
      return {
        passed: score >= 30,
        score,
        reasons: [`job relevance score ${score.toFixed(1)} (${label})`],
        label,
        source: 'scout',
      };
    } catch (e) {
      return {
        passed: false,
        score: 0,
        reasons: ['job quality scoring unavailable'],
        label: 'unknown',
        source: 'unavailable',
      };
    }
  }

  private assessCareerFit(profile: CandidateProfile, lead: Lead): CareerFitResult {
    const profileSkills = splitComma(profile.skills);
    // Derive "required" skills from lead description (same deterministic extraction
    // as evidence evaluator)
    const desc = (lead.description ?? '').toLowerCase();
    const KNOWN_TECH = [
      'javascript','typescript','python','java','kotlin','scala','go','rust','c++','c#','dotnet',
      'react','angular','vue','node','nodejs','express','django','flask','fastapi','spring','rails','laravel',
      'sql','postgresql','mysql','mongodb','redis','kafka','docker','kubernetes','aws','azure','gcp',
      'machine learning','deep learning','nlp','data engineering','devops','sre',
    ].map(s => s.trim().toLowerCase()).filter(Boolean);

    const jobSkills: string[] = [];
    for (const tech of KNOWN_TECH) {
      if (desc.includes(tech)) jobSkills.push(tech);
    }

    const ps = new Set(profileSkills.map(s => s.toLowerCase().trim()).filter(Boolean));
    const overlapTags: string[] = [];
    const gapTags: string[] = [];
    for (const js of jobSkills) {
      if (ps.has(js)) overlapTags.push(js);
      else gapTags.push(js);
    }

    const aligned = overlapTags.length >= Math.min(2, jobSkills.length);
    const reasons: string[] = [];
    if (overlapTags.length > 0) reasons.push(`${overlapTags.length} overlapping skill(s)`);
    if (gapTags.length > 0) reasons.push(`${gapTags.length} gap skill(s) — may need upskilling`);

    return {
      passed: aligned,
      score: Math.min(100, (overlapTags.length / Math.max(1, jobSkills.length)) * 100),
      reasons,
      overlapTags,
      gapTags,
      aligned,
    };
  }

  private assessChannelReady(lead: Lead, channelInfo?: { hasAnswerBank: boolean; hasCv: boolean; source: string }): ChannelReadyResult {
    const reasons: string[] = [];
    const missing: string[] = [];
    const hasAnswerBank = !!(channelInfo?.hasAnswerBank);
    const hasCv = !!(channelInfo?.hasCv);
    const hasAdapter = !!(channelInfo?.source);

    if (!hasAnswerBank) missing.push('answer bank unavailable for source');
    if (!hasCv) missing.push('no CV available');
    if (!hasAdapter) missing.push('no portal adapter registered');

    if (hasAdapter) reasons.push(`adapter present: ${channelInfo.source}`);
    if (hasAnswerBank) reasons.push('answer bank available');
    if (hasCv) reasons.push('CV available');

    return {
      passed: missing.length === 0,
      score: missing.length === 0 ? 100 : Math.max(0, 100 - missing.length * 34),
      reasons,
      missing,
      hasAnswerBank,
      hasCv,
      hasAdapter,
    };
  }

  // ---- composite + decision -----------------------------------------------

  private computeComposite(ev: QualificationEvidence): number {
    // Weighted composite (deterministic):
    //   eligibility  25%   (must-pass gate)
    //   evidence     25%   (skill/title match)
    //   jobQuality   20%   (relevance score from scout)
    //   careerFit    20%   (overlap/gap)
    //   channelReady 10%   (can we actually send)
    const w = { eligibility: 0.25, evidence: 0.25, jobQuality: 0.20, careerFit: 0.20, channelReady: 0.10 };
    return Math.round(
      ev.eligibility.score * w.eligibility +
      ev.evidence.score * w.evidence +
      ev.jobQuality.score * w.jobQuality +
      ev.careerFit.score * w.careerFit +
      ev.channelReady.score * w.channelReady,
    );
  }

  private decide(
    composite: number,
    ev: QualificationEvidence,
  ): { decision: QualificationDecision; requiredAction: RequiredAction; reasons: string[] } {
    const reasons: string[] = [];

    // ---- JA-015: skill-gap severity consumed by decide() --------------------
    // A BLOCKING gap (unmitigated must-have) is a hard rejection even if
    // eligibility passed — the candidate cannot meet mandatory requirements.
    // A MAJOR gap downgrades the qualification to NEAR_MISS / CONDITIONAL
    // depending on composite score, with the gap reasons surfaced.
    if (ev.evidence.gapSeverity === 'BLOCKING') {
      reasons.push(`REJECT: skill-gap severity BLOCKING — ${ev.evidence.gapReasons?.join('; ') ?? 'unmitigated must-have gap'}`);
      return {
        decision: 'REJECT',
        requiredAction: 'do_not_apply',
        reasons,
      };
    }
    // -------------------------------------------------------------------------
    // ---- JA-015: MAJOR gap downgrades QUALIFIED → NEAR_MISS / CONDITIONAL --
    // A MAJOR gap means the candidate has significant skill deficits —
    // downgrade the decision and surface the gap reasons.
    if (ev.evidence.gapSeverity === 'MAJOR') {
      const mh = ev.evidence.gapMissingMustHave?.length ?? 0;
      const pref = ev.evidence.gapMissingPreferred?.length ?? 0;
      if (ev.evidence.gapReasons) reasons.push(...ev.evidence.gapReasons);
      if (composite >= 80) {
        // Downgrade from QUALIFIED to CONDITIONAL
        return {
          decision: 'CONDITIONAL',
          requiredAction: 'partial',
          reasons: [...reasons, `CONDITIONAL: skill-gap severity MAJOR (${mh} must-have, ${pref} preferred gap(s)) — verify before applying`],
        };
      }
      return {
        decision: 'NEAR_MISS',
        requiredAction: 'revisit',
        reasons: [...reasons, `NEAR_MISS: skill-gap severity MAJOR (${mh} must-have, ${pref} preferred gap(s))`],
      };
    }
    if (ev.evidence.gapSeverity === 'MODERATE' && ev.evidence.gapReasons) {
      reasons.push(...ev.evidence.gapReasons);
    }
    // -------------------------------------------------------------------------
    if (!ev.eligibility.passed) {
      reasons.push('FAILED: eligibility gate (location/experience)');
      return {
        decision: 'REJECT',
        requiredAction: 'do_not_apply',
        reasons,
      };
    }
    if (!ev.channelReady.passed) {
      reasons.push(`FAILED: channel not ready — ${ev.channelReady.missing.join(', ')}`);
      return {
        decision: ev.channelReady.missing.some(m => m.includes('answer bank')) ? 'INSUFFICIENT_DATA' : 'CONDITIONAL',
        requiredAction: 'needs_info',
        reasons,
      };
    }

    // ---- JA-020: career fit explicitly contributes to the decision ----
    // If career fit is misaligned (careerFit.aligned === false) and the
    // composite score is high enough (>= 65), downgrade the decision.
    // This makes career fit an explicit decision input, not just a 20% weight.
    if (!ev.careerFit.aligned && composite >= 65) {
      if (composite >= 80) {
        // Downgrade from QUALIFIED to CONDITIONAL
        return {
          decision: 'CONDITIONAL',
          requiredAction: 'partial',
          reasons: [...reasons, 'CAREER_FIT_MISMATCH: CONDITIONAL: strong technical match but career-fit misaligned'],
        };
      }
      // Downgrade from CONDITIONAL to NEAR_MISS
      return {
        decision: 'NEAR_MISS',
        requiredAction: 'revisit',
        reasons: [...reasons, 'CAREER_FIT_MISMATCH: NEAR_MISS: composite borderline and career-fit misaligned'],
      };
    }

    // Insufficient data: very low evidence + low job quality + no astro
    if (composite < 20 && ev.evidence.skillMatches === 0 && ev.jobQuality.label === 'unknown') {
      reasons.push('INSUFFICIENT: too little signal to qualify');
      return {
        decision: 'INSUFFICIENT_DATA',
        requiredAction: 'revisit',
        reasons,
      };
    }

    // Near miss: decent but not enough
    if (composite >= 40 && composite < 65) {
      const gaps = ev.careerFit.gapTags;
      if (gaps.length > 0) {
        reasons.push(`NEAR_MISS: ${gaps.length} skill gap(s) — upskill candidate`);
      } else {
        reasons.push('NEAR_MISS: composite below threshold');
      }
      return {
        decision: 'NEAR_MISS',
        requiredAction: 'revisit',
        reasons,
      };
    }

    // Conditional: passable but needs info
    if (composite >= 65 && composite < 80) {
      reasons.push('CONDITIONAL: acceptable but verify before applying');
      return {
        decision: 'CONDITIONAL',
        requiredAction: 'partial',
        reasons,
      };
    }

    // Qualified
    if (composite >= 80) {
      reasons.push('QUALIFIED: strong match across eligibility, evidence, job quality, career fit');
      return {
        decision: 'QUALIFIED',
        requiredAction: 'proceed',
        reasons,
      };
    }

    // fallback: below 40 with some signal → near miss
    reasons.push('REJECT: composite score too low');
    return {
      decision: 'REJECT',
      requiredAction: 'do_not_apply',
      reasons,
    };
  }
}
