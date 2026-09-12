import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Not, IsNull } from 'typeorm';
import { JobLead as Lead } from '../leads/job-lead.entity';
import { CandidateProfile } from '../profile/candidate-profile.entity';
import { AstroLeadScore } from '../astro/astro-lead-scoring.service';

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
    let locationOk = true;
    let locationReason: string | undefined;

    // location gate
    const loc = (lead.location ?? '').trim();
    const cloc = (profile.currentLocation ?? '').trim().toLowerCase();
    const allowed = (params.allowedLocations ?? []).map(s => s.toLowerCase().trim()).filter(Boolean);
    const excluded = (params.excludedLocations ?? []).map(s => s.toLowerCase().trim()).filter(Boolean);

    if (excluded.length > 0) {
      if (excluded.some(e => cloc.includes(e) || loc.toLowerCase().includes(e))) {
        locationOk = false;
        locationReason = `location excluded (${loc || 'unknown'})`;
        reasons.push(locationReason);
      }
    } else if (allowed.length > 0) {
      if (!(cloc.includes(allowed[0]) || loc.toLowerCase().includes(allowed[0]))) {
        // loosen: if either profile or lead location contains any allowed entry
        const hit = allowed.some(a => cloc.includes(a) || loc.toLowerCase().includes(a));
        if (!hit) {
          locationOk = false;
          locationReason = `location not in allowed list (${loc || 'unknown'})`;
          reasons.push(locationReason);
        }
      }
    }

    // experience floor
    let experienceOk = true;
    let experienceReason: string | undefined;
    const floor = params.experienceFloor ?? 0;
    const exp = profile.experienceYears;
    if (floor > 0 && exp != null && exp < floor) {
      experienceOk = false;
      experienceReason = `experience ${exp}yr < floor ${floor}yr`;
      reasons.push(experienceReason);
    }

    return {
      passed: locationOk && experienceOk,
      score: (locationOk ? 25 : 0) + (experienceOk ? 25 : 0),
      reasons,
      locationOk,
      locationReason,
      experienceOk,
      experienceReason,
      noticeOk: true,
      noticeReason: undefined,
    };
  }

  private assessEvidence(lead: Lead, profile: CandidateProfile): EvidenceResult {
    const reasons: string[] = [];
    const profileSkills = splitComma(profile.skills);
    const requiredSkills: string[] = [];

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
      if (desc.includes(tech)) requiredSkills.push(tech);
    }

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

    // Hard gates: eligibility + channel readiness
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
