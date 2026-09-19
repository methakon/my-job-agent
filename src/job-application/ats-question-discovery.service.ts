/**
 * JA-041 — Generic ATS Question Discovery
 *
 * doneWhen: "Unknown questions cannot silently receive fabricated answers."
 *
 * Detects field types (unknown, conditional, dropdown, radio, multi-select,
 * free-text) and answers only from verified evidence; stops/asks/flags for
 * unknown or high-risk questions. Never guesses legal/demographic/authorization.
 */

import { Injectable } from '@nestjs/common';

export type FieldType = 'unknown' | 'conditional' | 'dropdown' | 'radio' | 'multi_select' | 'free_text' | 'hidden';
export type RiskLevel = 'safe' | 'medium' | 'high_risk';

export interface ATSField {
  id: string;
  label: string;
  name: string;
  type: FieldType;
  options?: string[];
  riskLevel: RiskLevel;
  requiresAnswer: boolean;
}

export interface ATSQuestionAnswer {
  fieldId: string;
  fieldLabel: string;
  answer: string | null;
  answerSource: 'evidence' | 'derived' | 'stopped' | 'flagged' | 'asked';
  answerStatus: 'answered' | 'stopped' | 'flagged' | 'needs_input';
  reason: string;
  confidence: number;
}

export interface ATSQuestionResult {
  answers: ATSQuestionAnswer[];
  hasStopped: boolean;
  hasFlagged: boolean;
  hasNeedsInput: boolean;
  summary: string;
}

@Injectable()
export class ATSQuestionDiscoveryService {
  detectFieldType(label: string, name: string, options?: string[]): FieldType {
    if (!label && !name) return 'unknown';
    const key = (label + ' ' + name).toLowerCase();

    if (key.includes('hidden') || key.includes('__')) return 'hidden';
    if (key.includes('conditional') || key.includes('if you') || key.includes('if applicable')) return 'conditional';
    if (options && options.length > 0 && options.length <= 10) {
      if (key.includes('select') || key.includes('choose') || key.includes('radio')) return 'radio';
      return 'dropdown';
    }
    if (options && options.length > 10) return 'multi_select';
    if (key.includes('text') || key.includes('comment') || key.includes('explain') || key.includes('describe')) return 'free_text';
    return 'unknown';
  }

  assessRisk(field: ATSField): RiskLevel {
    const key = (field.label + ' ' + field.name).toLowerCase();

    if (key.includes('ssn') || key.includes('social security') ||
        key.includes('credit') || key.includes('bank') ||
        key.includes('passport') || key.includes('drivers') || key.includes('license number')) {
      return 'high_risk';
    }
    if (key.includes('birth') || key.includes('age') || key.includes('marital') ||
        key.includes('religion') || key.includes('political') ||
        key.includes('gender') || key.includes('race') || key.includes('ethnicity') ||
        key.includes('photo') || key.includes('physical')) {
      return 'high_risk';
    }
    if (key.includes('citizen') || key.includes('visa') || key.includes('authorization') ||
        key.includes('legal') || key.includes('status')) {
      return 'high_risk';
    }
    if (field.type === 'conditional' || field.type === 'unknown') return 'medium';
    return 'safe';
  }

  canAnswerFromEvidence(
    field: ATSField,
    profile: { skills?: string; headline?: string; experienceYears?: number; currentLocation?: string; education?: string },
    evidence: Record<string, string>,
  ): { canAnswer: boolean; answer: string | null; source: 'evidence' | 'derived' | 'stopped' | 'flagged'; reason: string } {
    if (field.riskLevel === 'high_risk') {
      return { canAnswer: false, answer: null, source: 'stopped', reason: 'High-risk field — never fabricate legal/demographic/authorization information' };
    }

    if (field.type === 'unknown') {
      return { canAnswer: false, answer: null, source: 'flagged', reason: 'Unknown field type — flagged for review' };
    }

    if (field.options && field.options.length > 0) {
      for (const opt of field.options) {
        const optLower = opt.toLowerCase();
        if (profile.skills && profile.skills.toLowerCase().includes(optLower)) {
          return { canAnswer: true, answer: opt, source: 'evidence', reason: `Skill match: "${opt}" found in candidate skills` };
        }
      }
    }

    if (field.type === 'dropdown' && !field.options) {
      return { canAnswer: false, answer: null, source: 'flagged', reason: 'Dropdown without known options — flagged for review' };
    }

    if (field.type === 'free_text') {
      if (field.label.toLowerCase().includes('experience') && profile.experienceYears) {
        return { canAnswer: true, answer: `~${profile.experienceYears} years`, source: 'derived', reason: 'Derived from candidate experience years' };
      }
      if (field.label.toLowerCase().includes('location') && profile.currentLocation) {
        return { canAnswer: true, answer: profile.currentLocation, source: 'evidence', reason: 'From candidate current location' };
      }
    }

    if (evidence[field.name]) {
      return { canAnswer: true, answer: evidence[field.name], source: 'evidence', reason: `From evidence: ${field.name}` };
    }

    return { canAnswer: false, answer: null, source: 'stopped', reason: 'No evidence available — stopped to prevent fabrication' };
  }

  evaluateFields(
    fields: ATSField[],
    profile: { skills?: string; headline?: string; experienceYears?: number; currentLocation?: string },
    evidence: Record<string, string> = {},
  ): ATSQuestionResult {
    const answers: ATSQuestionAnswer[] = [];
    let hasStopped = false;
    let hasFlagged = false;
    let hasNeedsInput = false;

    for (const field of fields) {
      const result = this.canAnswerFromEvidence(field, profile, evidence);

      let answerStatus: ATSQuestionAnswer['answerStatus'];
      if (result.source === 'stopped') { answerStatus = 'stopped'; hasStopped = true; }
      else if (result.source === 'flagged') { answerStatus = 'flagged'; hasFlagged = true; }
      else { answerStatus = 'answered'; }

      answers.push({
        fieldId: field.id,
        fieldLabel: field.label,
        answer: result.answer,
        answerSource: result.source,
        answerStatus,
        reason: result.reason,
        confidence: result.source === 'evidence' ? 0.9 : result.source === 'derived' ? 0.7 : 0,
      });
    }

    const stopCount = answers.filter(a => a.answerStatus === 'stopped').length;
    const flagCount = answers.filter(a => a.answerStatus === 'flagged').length;
    const answeredCount = answers.filter(a => a.answerStatus === 'answered').length;

    let summary = `${answeredCount} answered, ${stopCount} stopped, ${flagCount} flagged`;
    if (hasStopped) summary += ' — high-risk or unsupported fields prevented fabrication';
    if (hasFlagged) summary += ' — unknown/conditional fields flagged for review';

    return { answers, hasStopped, hasFlagged, hasNeedsInput, summary };
  }
}
