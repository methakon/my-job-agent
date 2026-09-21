/**
 * JA-034 — ATS + Human Scoring
 *
 * doneWhen: "Separate ATS and human-relevance signals are available."
 *
 * Evaluates a tailored CV on two separate axes:
 *   1. ATS score — keyword coverage, semantic relevance, structure, readability
 *   2. Human score — evidence strength, readability, structure, keyword stuffing
 *
 * Returns separate scores with breakdowns. Does NOT insert irrelevant keywords
 * merely to increase ATS score.
 */

import { Injectable } from '@nestjs/common';
import { CandidateProfile } from '../profile/candidate-profile.entity';
import { CVCustomizationService, TailoredCV } from './cv-customization.service';

// ---- Types ----------------------------------------------------------------

export interface ATSScoreResult {
  score: number;        // 0-100
  label: 'low' | 'medium' | 'high';
  breakdown: {
    keywordCoverage: number;
    semanticRelevance: number;
    structureScore: number;
    readabilityScore: number;
    keywordStuffingPenalty: number;
  };
  details: string[];
}

export interface HumanScoreResult {
  score: number;        // 0-100
  label: 'low' | 'medium' | 'high';
  breakdown: {
    evidenceStrength: number;
    readabilityScore: number;
    structureScore: number;
    relevanceToRole: number;
    keywordStuffingPenalty: number;
  };
  details: string[];
}

export interface ATSAndHumanScore {
  ats: ATSScoreResult;
  human: HumanScoreResult;
  /** Combined score (weighted: 40% ATS + 60% human for human-facing roles). */
  combined: number;
  combinedLabel: 'low' | 'medium' | 'high';
  checkedAt: string;
}

// ---- Service ---------------------------------------------------------------

@Injectable()
export class ATSCustomizationService {
  constructor(
    private readonly cvCustomizationService: CVCustomizationService,
  ) {}

  /**
   * Score a tailored CV on ATS and human-relevance axes separately.
   */
  scoreCV(lead: any, profile: CandidateProfile, cv: TailoredCV): ATSAndHumanScore {
    const now = new Date().toISOString();

    const ats = this.computeATSScore(lead, profile, cv);
    const human = this.computeHumanScore(lead, profile, cv);

    // Combined: weighted average (human more important for most roles)
    const combined = Math.round(ats.score * 0.4 + human.score * 0.6);
    const combinedLabel = this.labelFromScore(combined);

    return {
      ats,
      human,
      combined,
      combinedLabel,
      checkedAt: now,
    };
  }

  // ---- ATS scoring -------------------------------------------------------

  private computeATSScore(lead: any, profile: CandidateProfile, cv: TailoredCV): ATSScoreResult {
    const cvText = cv.cvText.toLowerCase();
    const leadTitle = (lead.title || '').toLowerCase();
    const skills = (profile.skills || '').toLowerCase();

    // 1. Keyword coverage: how many skills from profile appear in CV
    const skillList = skills.split(',').map(s => s.trim()).filter(s => s.length > 0);
    let matchedSkills = 0;
    for (const skill of skillList) {
      if (cvText.includes(skill.toLowerCase())) matchedSkills++;
    }
    const keywordCoverage = skillList.length > 0
      ? Math.round((matchedSkills / skillList.length) * 40)
      : 30; // default when no skills

    // 2. Semantic relevance: how well CV matches lead title
    const titleWords = leadTitle.split(/\s+/).filter(w => w.length > 2);
    let titleMatches = 0;
    for (const word of titleWords) {
      if (cvText.includes(word.toLowerCase())) titleMatches++;
    }
    const semanticRelevance = titleWords.length > 0
      ? Math.round((titleMatches / titleWords.length) * 25)
      : 20;

    // 3. Structure score: CV has sections (Skills, Experience, Projects)
    let structureScore = 30;
    if (cvText.includes('skills:')) structureScore += 10;
    if (cvText.includes('experience') || cvText.includes('engineer') || cvText.includes('developer')) structureScore += 5;
    if (cvText.includes('project')) structureScore += 5;
    if (cvText.includes('linkedin') || cvText.includes('github')) structureScore += 5;
    structureScore = Math.min(structureScore, 50);

    // 4. Readability score: CV is concise and well-formed
    const lines = cvText.split('\n').filter(l => l.trim()).length;
    const readabilityScore = lines >= 5 ? 25 : lines >= 3 ? 15 : 5;

    // 5. Keyword stuffing penalty: repeated keywords unnaturally
    let stuffingPenalty = 0;
    for (const skill of skillList) {
      const regex = new RegExp(skill.toLowerCase(), 'g');
      const matches = cvText.match(regex);
      if (matches && matches.length > 3) {
        stuffingPenalty += 5;
      }
    }
    stuffingPenalty = Math.min(stuffingPenalty, 15);

    const total = Math.max(0, keywordCoverage + semanticRelevance + structureScore + readabilityScore - stuffingPenalty);
    const score = Math.min(100, total);

    return {
      score,
      label: this.labelFromScore(score),
      breakdown: {
        keywordCoverage,
        semanticRelevance,
        structureScore,
        readabilityScore,
        keywordStuffingPenalty: stuffingPenalty,
      },
      details: this.atsDetails(score, keywordCoverage, semanticRelevance, structureScore, readabilityScore, stuffingPenalty),
    };
  }

  // ---- Human scoring -----------------------------------------------------

  private computeHumanScore(lead: any, profile: CandidateProfile, cv: TailoredCV): HumanScoreResult {
    const cvText = cv.cvText.toLowerCase();
    const leadTitle = (lead.title || '').toLowerCase();

    // 1. Evidence strength: how well-grounded the CV is (from evidence trace)
    const evidenceTrace = cv.evidenceTrace || [];
    const groundedCount = evidenceTrace.filter(e => e.grounded).length;
    const evidenceStrength = evidenceTrace.length > 0
      ? Math.round((groundedCount / evidenceTrace.length) * 35)
      : 20;

    // 2. Readability: clear, concise, well-structured
    const lines = cvText.split('\n').filter(l => l.trim()).length;
    const words = cvText.split(/\s+/).filter(w => w.length > 0).length;
    const avgLineLength = words / Math.max(lines, 1);
    let readabilityScore = 20;
    if (avgLineLength >= 5 && avgLineLength <= 20) readabilityScore += 15;
    else if (avgLineLength > 20) readabilityScore += 5; // too dense
    if (lines >= 5) readabilityScore += 10;
    readabilityScore = Math.min(readabilityScore, 40);

    // 3. Structure: has clear sections
    let structureScore = 15;
    if (cvText.includes('skills:')) structureScore += 5;
    if (cvText.includes('engineer') || cvText.includes('developer') || cvText.includes('role')) structureScore += 5;
    if (cvText.includes('project')) structureScore += 5;
    structureScore = Math.min(structureScore, 25);

    // 4. Relevance to role: CV matches the job title
    const titleWords = leadTitle.split(/\s+/).filter(w => w.length > 2);
    let titleMatchCount = 0;
    for (const word of titleWords) {
      if (cvText.includes(word.toLowerCase())) titleMatchCount++;
    }
    const relevanceToRole = titleWords.length > 0
      ? Math.round((titleMatchCount / titleWords.length) * 20)
      : 10;

    // 5. Keyword stuffing penalty (human perspective — looks spammy)
    let stuffingPenalty = 0;
    const skillList = (profile.skills || '').split(',').map(s => s.trim()).filter(s => s.length > 0);
    for (const skill of skillList) {
      const regex = new RegExp(skill.toLowerCase(), 'g');
      const matches = cvText.match(regex);
      if (matches && matches.length > 3) {
        stuffingPenalty += 8;
      }
    }
    stuffingPenalty = Math.min(stuffingPenalty, 20);

    const total = Math.max(0, evidenceStrength + readabilityScore + structureScore + relevanceToRole - stuffingPenalty);
    const score = Math.min(100, total);

    return {
      score,
      label: this.labelFromScore(score),
      breakdown: {
        evidenceStrength,
        readabilityScore,
        structureScore,
        relevanceToRole,
        keywordStuffingPenalty: stuffingPenalty,
      },
      details: this.humanDetails(score, evidenceStrength, readabilityScore, structureScore, relevanceToRole, stuffingPenalty),
    };
  }

  // ---- helpers -----------------------------------------------------------

  private labelFromScore(score: number): 'low' | 'medium' | 'high' {
    if (score >= 70) return 'high';
    if (score >= 40) return 'medium';
    return 'low';
  }

  private atsDetails(score: number, kc: number, sr: number, ss: number, rs: number, sp: number): string[] {
    const details: string[] = [];
    if (kc >= 30) details.push(`Good keyword coverage (${kc}/40)`);
    else details.push(`Keyword coverage needs improvement (${kc}/40)`);
    if (sr >= 15) details.push(`Decent semantic relevance to role (${sr}/25)`);
    if (ss >= 30) details.push(`Well-structured CV (${ss}/50)`);
    if (rs >= 15) details.push(`Readable (${rs}/25)`);
    if (sp > 0) details.push(`Keyword stuffing penalty (${sp})`);
    return details;
  }

  private humanDetails(score: number, es: number, rs: number, ss: number, rr: number, sp: number): string[] {
    const details: string[] = [];
    if (es >= 25) details.push(`Strong evidence grounding (${es}/35)`);
    else details.push(`Evidence grounding needs work (${es}/35)`);
    if (rs >= 25) details.push(`Readable for humans (${rs}/40)`);
    else details.push(`Readability could improve (${rs}/40)`);
    if (ss >= 15) details.push(`Good structure (${ss}/25)`);
    if (rr >= 10) details.push(`Relevant to role (${rr}/20)`);
    if (sp > 0) details.push(`Avoids keyword stuffing (${sp} penalty)`);
    return details;
  }
}
