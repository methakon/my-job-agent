/**
 * JA-013 — Candidate Evidence Matching
 *
 * doneWhen: "Material matches are explainable using candidate evidence."
 *
 * Pure deterministic evidence tracer. Given a CandidateProfile and a set of
 * material claims derived from the JD (skills, experience, seniority, education,
 * employment type, authorization, language, location, notice, compensation,
 * employer, technology, achievement), produces an explainable evidence record
 * where every material match is traceable to a specific candidate evidence
 * source and every missing/unverifiable claim is explicitly UNKNOWN.
 *
 * Never fabricates facts. Never modifies JA-012, qualification.service.ts,
 * trading code, seed content, .env, DB config, or submission paths (JA-002).
 */

import { Injectable } from '@nestjs/common';
import { CandidateProfile } from '../profile/candidate-profile.entity';

// ---- Types ----------------------------------------------------------------

/** One material claim to verify against candidate evidence. */
export interface MaterialClaim {
  /** Stable category for the claim. */
  category: MaterialClaimCategory;
  /** Human-readable description of the claim (e.g. "requires React"). */
  claim: string;
  /** Optional hint used by category-specific evidence lookups (e.g. a skill name). */
  hint?: string;
}

export type MaterialClaimCategory =
  | 'skill'
  | 'experience_years'
  | 'seniority'
  | 'education'
  | 'authorization'
  | 'employment_type'
  | 'language'
  | 'location'
  | 'notice_period'
  | 'compensation'
  | 'employer'
  | 'technology'
  | 'achievement';

/** Confidence of the evidence for this claim. */
export type EvidenceStatus = 'matched' | 'partial' | 'unknown' | 'mismatch';

/** One traceable source of candidate evidence. */
export interface EvidenceSource {
  /** Which candidate data store this came from. */
  kind: EvidenceSourceKind;
  /** The profile field / store name, e.g. "skills", "workHistoryJson", "projectsJson", "educationJson", "headline", "experienceYears", "noticePeriod", "salaryExpectation", "currentLocation". */
  field: string;
  /** Human-readable summary of what was found. */
  detail: string;
  /** The verbatim text snippet from the candidate data supporting this evidence (lowercased, trimmed). */
  snippet: string;
  /** Optional pointer to the specific entry index (0-based) in a JSON array field. */
  entryIndex?: number;
}

export type EvidenceSourceKind = 'profile_field' | 'work_history' | 'project' | 'education';

export interface ClaimEvidence {
  claim: string;
  category: MaterialClaimCategory;
  status: EvidenceStatus;
  sources: EvidenceSource[];
  note: string;
  /** Snapshot of which profile fields were actually used by this claim's extractor (for audit). */
  fieldsUsed: string[];
}

export interface CandidateEvidenceRecord {
  profileId: string;
  /** Every material claim, explained. Order matches the input claims. */
  claims: ClaimEvidence[];
  /** Snapshot of which profile fields were actually used (for audit). */
  fieldsUsed: string[];
  /** Deterministic fingerprint of the profile evidence snapshot used for this evaluation. */
  evidenceFingerprint: string;
}

// ---- Pure helpers -------------------------------------------------------

/** Word-boundary regex for a single token (escapes all regex specials EXCEPT `|`). */
function wordBoundaryRe(token: string): RegExp {
  const escaped = token.replace(/[.*+?^${}()\[\]\\]/g, '\\$&');
  return new RegExp('\\b(?:' + escaped + ')\\b', 'i');
}

function hasWord(text: string, word: string): boolean {
  if (!text || !word) return false;
  return wordBoundaryRe(word).test(text);
}

function fieldSnippet(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

function normalizeSep(v: string | null | undefined): string[] {
  if (!v) return [];
  return v.split(',').map((s) => s.trim()).filter(Boolean).map((s) => s.toLowerCase().trim());
}

function parseJsonArray(raw: string | null | undefined): Array<Record<string, unknown>> {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((e) => e && typeof e === 'object') : [];
  } catch {
    return [];
  }
}

function yearsBetween(from: string | undefined, to: string | undefined): number | null {
  const parseYear = (s?: string): number | null => {
    if (!s) return null;
    const mm = s.trim().match(/^(\d{4})/);
    return mm ? parseInt(mm[1], 10) : null;
  };
  const fy = parseYear(from);
  const ty = parseYear(to);
  if (fy == null || ty == null || ty < fy) return null;
  return ty - fy;
}

// ---- Category evidence extractors -----------------------------------------

function skillEvidence(
  profile: CandidateProfile,
  claim: string,
  hint: string | undefined,
): ClaimEvidence {
  const wanted = (hint ?? claim).toLowerCase().trim();
  const sources: EvidenceSource[] = [];
  const fieldsUsed: string[] = [];
  const addSource = (kind: EvidenceSourceKind, field: string, detail: string, snippet: string, entryIndex?: number) => {
    sources.push({ kind: kind, field, detail, snippet, entryIndex });
    if (!fieldsUsed.includes(field)) fieldsUsed.push(field);
  };

  // Work history summaries (stronger than tag-only)
  const wh = parseJsonArray(profile.workHistoryJson);
  for (let i = 0; i < wh.length; i++) {
    const summary = fieldSnippet(String(wh[i].summary ?? ''));
    if (hasWord(summary, wanted) || summary.includes(wanted)) {
      addSource('work_history', 'workHistoryJson',
        'work history entry ' + i + ': ' + String(wh[i].company ?? '') +
        String(wh[i].role ? ' — ' + wh[i].role : ''),
        summary, i);
    }
  }

  const pj = parseJsonArray(profile.projectsJson);
  for (let i = 0; i < pj.length; i++) {
    const p = pj[i];
    const tech = Array.isArray(p.tech) ? p.tech.map(String).map((t) => t.toLowerCase().trim()).filter(Boolean) : [];
    if (tech.some((t) => hasWord(t, wanted) || t.includes(wanted))) {
      addSource('project', 'projectsJson', 'project ' + i + ': ' + String(p.name ?? '') + ' — tech includes ' + wanted,
        tech.join(' '), i);
    }
    const psummary = fieldSnippet(String(p.summary ?? ''));
    if (hasWord(psummary, wanted) || psummary.includes(wanted)) {
      addSource('project', 'projectsJson', 'project ' + i + ': ' + String(p.name ?? '') + ' — summary', psummary, i);
    }
    if (hasWord(String(p.name ?? ''), wanted)) {
      addSource('project', 'projectsJson', 'project ' + i + ': name', String(p.name ?? '').toLowerCase(), i);
    }
  }

  const ed = parseJsonArray(profile.educationJson);
  for (let i = 0; i < ed.length; i++) {
    const e = ed[i];
    const note = fieldSnippet(String(e.note ?? ''));
    if (hasWord(note, wanted) || note.includes(wanted)) {
      addSource('education', 'educationJson', 'education entry ' + i + ': ' + String(e.school ?? '') + ' — ' + String(e.degree ?? ''),
        note, i);
    }
  }

  const profileSkillTags = normalizeSep(profile.skills);
  if (profileSkillTags.some((t) => hasWord(t, wanted) || t.includes(wanted))) {
    addSource('profile_field', 'skills', 'skill tag: ' + wanted, profile.skills ?? '');
  }

  const headline = fieldSnippet(profile.headline);
  if (hasWord(headline, wanted) || headline.includes(wanted)) {
    addSource('profile_field', 'headline', 'headline mentions ' + wanted, headline);
  }

  if (sources.length === 0) {
    return {
      claim, category: 'skill', status: 'unknown', sources: [],
      note: 'no candidate evidence found for skill "' + wanted + '" in skills, work history, projects, education, or headline',
      fieldsUsed,
    };
  }

  const hasRicher = sources.some((s) => s.kind !== 'profile_field');
  return {
    claim, category: 'skill', status: hasRicher ? 'matched' : 'partial', sources,
    note: hasRicher
      ? 'skill "' + wanted + '" supported by candidate evidence'
      : 'skill "' + wanted + '" present in profile skill tags but not backed by work history / project / education entry',
    fieldsUsed,
  };
}

function experienceEvidence(
  profile: CandidateProfile,
  claim: string,
  _hint: string | undefined,
): ClaimEvidence {
  const fieldsUsed: string[] = [];
  const sources: EvidenceSource[] = [];
  const addSource = (kind: EvidenceSourceKind, field: string, detail: string, snippet: string, entryIndex?: number) => {
    sources.push({ kind: kind, field, detail, snippet, entryIndex });
    if (!fieldsUsed.includes(field)) fieldsUsed.push(field);
  };

  const exp = profile.experienceYears;
  if (exp != null && !isNaN(exp) && exp >= 0) {
    addSource('profile_field', 'experienceYears', 'stated experience: ' + exp + ' years', String(exp));
  }

  const wh = parseJsonArray(profile.workHistoryJson);
  const ranges: number[] = [];
  for (let i = 0; i < wh.length; i++) {
    const w = wh[i];
    const y = yearsBetween(String(w.from ?? ''), String(w.to ?? ''));
    if (y != null && y > 0) ranges.push(y);
  }
  if (ranges.length) {
    const total = ranges.reduce((a, b) => a + b, 0);
    addSource('work_history', 'workHistoryJson',
      'work history spans ~' + total + 'yr across ' + ranges.length + ' stint(s)', String(total));
  }

  if (exp != null && !isNaN(exp) && exp >= 0) {
    if (ranges.length) {
      const total = ranges.reduce((a, b) => a + b, 0);
      return {
        claim, category: 'experience_years', status: 'matched', sources,
        note: 'profile stated ' + exp + 'yr experience; work history spans ~' + total + 'yr across ' + ranges.length + ' stint(s)',
        fieldsUsed,
      };
    }
    return {
      claim, category: 'experience_years', status: 'matched', sources,
      note: 'profile states ' + exp + 'yr experience (no work-history date spans recorded to cross-check)',
      fieldsUsed,
    };
  }

  if (ranges.length) {
    const total = ranges.reduce((a, b) => a + b, 0);
    return {
      claim, category: 'experience_years', status: 'matched', sources,
      note: 'no explicit experienceYears; work history spans ~' + total + 'yr across ' + ranges.length + ' stint(s)',
      fieldsUsed,
    };
  }

  return {
    claim, category: 'experience_years', status: 'unknown', sources: [],
    note: 'profile.experienceYears not recorded and no work-history date spans available — cannot verify experience',
    fieldsUsed,
  };
}

function seniorityEvidence(
  profile: CandidateProfile,
  claim: string,
  _hint: string | undefined,
): ClaimEvidence {
  const fieldsUsed: string[] = [];
  const sources: EvidenceSource[] = [];
  const addSource = (kind: EvidenceSourceKind, field: string, detail: string, snippet: string, entryIndex?: number) => {
    sources.push({ kind: kind, field, detail, snippet, entryIndex });
    if (!fieldsUsed.includes(field)) fieldsUsed.push(field);
  };

  const headline = fieldSnippet(profile.headline);
  if (headline) {
    const TITLE_SIGNALS = [
      'principal', 'staff engineer', 'sr', 'senior', 'lead', 'architect', 'head', 'director', 'vp', 'vice president',
      'mid', 'intermediate', 'junior', 'jr', 'entry', 'associate', 'fresher',
    ];
    const hits = TITLE_SIGNALS.filter((s) => hasWord(headline, s) || headline.includes(s));
    if (hits.length) {
      addSource('profile_field', 'headline', 'headline seniority signals: ' + hits.join(', '), headline);
    }
  }

  const wh = parseJsonArray(profile.workHistoryJson);
  const roleHits: string[] = [];
  for (let i = 0; i < wh.length; i++) {
    const w = wh[i];
    const role = fieldSnippet(String(w.role ?? ''));
    if (role) {
      const TITLE_SIGNALS = ['principal', 'staff', 'senior', 'sr', 'lead', 'architect', 'head', 'director', 'vp', 'manager', 'junior', 'jr', 'entry', 'associate', 'fresher', 'intern'];
      const h = TITLE_SIGNALS.filter((s) => hasWord(role, s) || role.includes(s));
      if (h.length) roleHits.push('entry ' + i + ': ' + String(w.role ?? '') + ' (' + h.join(', ') + ')');
    }
  }
  if (roleHits.length) {
    addSource('work_history', 'workHistoryJson', 'role-title seniority signals across ' + roleHits.length + ' stint(s)', roleHits.join(' | '));
  }

  if (sources.length === 0) {
    return {
      claim, category: 'seniority', status: 'unknown', sources: [],
      note: 'no seniority signal found in headline, work history roles, or experienceYears',
      fieldsUsed,
    };
  }

  return {
    claim, category: 'seniority', status: 'matched', sources,
    note: 'seniority signals found in candidate evidence',
    fieldsUsed,
  };
}

function educationEvidence(
  profile: CandidateProfile,
  claim: string,
  hint: string | undefined,
): ClaimEvidence {
  const wanted = (hint ?? claim).toLowerCase().trim();
  const fieldsUsed: string[] = [];
  const sources: EvidenceSource[] = [];
  const addSource = (kind: EvidenceSourceKind, field: string, detail: string, snippet: string, entryIndex?: number) => {
    sources.push({ kind: kind, field, detail, snippet, entryIndex });
    if (!fieldsUsed.includes(field)) fieldsUsed.push(field);
  };

  const ed = parseJsonArray(profile.educationJson);
  for (let i = 0; i < ed.length; i++) {
    const e = ed[i];
    const blob = [String(e.school ?? ''), String(e.degree ?? ''), String(e.note ?? '')].join(' ').toLowerCase();
    if (hasWord(blob, wanted) || blob.includes(wanted)) {
      addSource('education', 'educationJson', 'education entry ' + i + ': ' + String(e.school ?? '') + ' — ' + String(e.degree ?? ''),
        blob, i);
    }
  }

  if (sources.length === 0) {
    return {
      claim, category: 'education', status: 'unknown', sources: [],
      note: 'no education/certification evidence found for "' + wanted + '" in educationJson',
      fieldsUsed,
    };
  }

  return {
    claim, category: 'education', status: 'matched', sources,
    note: 'education/certification evidence found for "' + wanted + '"',
    fieldsUsed,
  };
}

function authorizationEvidence(
  profile: CandidateProfile,
  claim: string,
  _hint: string | undefined,
): ClaimEvidence {
  const fieldsUsed: string[] = [];
  const sources: EvidenceSource[] = [];
  const addSource = (kind: EvidenceSourceKind, field: string, detail: string, snippet: string, entryIndex?: number) => {
    sources.push({ kind: kind, field, detail, snippet, entryIndex });
    if (!fieldsUsed.includes(field)) fieldsUsed.push(field);
  };

  const textParts: { label: string; text: string }[] = [
    { label: 'headline', text: fieldSnippet(profile.headline) },
    { label: 'skills', text: fieldSnippet(profile.skills) },
  ];
  const wh = parseJsonArray(profile.workHistoryJson);
  for (let i = 0; i < wh.length; i++) {
    textParts.push({ label: 'workHistoryJson[' + i + '].summary', text: fieldSnippet(String(wh[i].summary ?? '')) });
  }
  const ed = parseJsonArray(profile.educationJson);
  for (let i = 0; i < ed.length; i++) {
    textParts.push({ label: 'educationJson[' + i + '].note', text: fieldSnippet(String(ed[i].note ?? '')) });
  }

  const AUTH_SIGNALS = [
    'indian citizen', 'india citizen', 'citizen of india', 'pr', 'permanent resident', 'green card', 'gc',
    'uk citizen', 'europe citizen', 'eu citizen', 'european citizen',
    'us citizen', 'canadian citizen', 'australian citizen',
    'willing to relocate', 'open to relocation', 'visa sponsor', 'sponsorship available',
    'citizens only', 'no sponsorship', 'no visa sponsor', 'work permit', 'visa required',
  ];
  for (const part of textParts) {
    if (!part.text) continue;
    for (const sig of AUTH_SIGNALS) {
      if (hasWord(part.text, sig) || part.text.includes(sig)) {
        addSource('profile_field', part.label, 'authorization signal: "' + sig + '"', part.text);
      }
    }
  }

  if (sources.length === 0) {
    return {
      claim, category: 'authorization', status: 'unknown', sources: [],
      note: 'no work authorization evidence found in headline, work history, or education notes',
      fieldsUsed,
    };
  }

  return {
    claim, category: 'authorization', status: 'matched', sources,
    note: 'work authorization evidence found in candidate profile',
    fieldsUsed,
  };
}

function employmentTypeEvidence(
  profile: CandidateProfile,
  claim: string,
  _hint: string | undefined,
): ClaimEvidence {
  const fieldsUsed: string[] = [];
  const sources: EvidenceSource[] = [];
  const addSource = (kind: EvidenceSourceKind, field: string, detail: string, snippet: string, entryIndex?: number) => {
    sources.push({ kind: kind, field, detail, snippet, entryIndex });
    if (!fieldsUsed.includes(field)) fieldsUsed.push(field);
  };

  const text = [fieldSnippet(profile.headline), fieldSnippet(profile.skills)].join(' ');
  const EMP_SIGNALS = [
    'freelance', 'contract', 'part-time', 'part time', 'temporary', 'intern', 'internship',
    'full-time', 'full time', 'permanent', 'fulltime',
  ];
  for (const sig of EMP_SIGNALS) {
    if (hasWord(text, sig) || text.includes(sig)) {
      addSource('profile_field', text.includes(fieldSnippet(profile.headline)) ? 'headline' : 'skills',
        'employment-type signal: "' + sig + '"', text);
    }
  }

  if (sources.length === 0) {
    return {
      claim, category: 'employment_type', status: 'unknown', sources: [],
      note: 'no employment-type preference found in headline or skills',
      fieldsUsed,
    };
  }

  return {
    claim, category: 'employment_type', status: 'matched', sources,
    note: 'employment-type preference found in candidate profile',
    fieldsUsed,
  };
}

function languageEvidence(
  profile: CandidateProfile,
  claim: string,
  hint: string | undefined,
): ClaimEvidence {
  const wanted = (hint ?? claim).toLowerCase().trim();
  const fieldsUsed: string[] = [];
  const sources: EvidenceSource[] = [];
  const addSource = (kind: EvidenceSourceKind, field: string, detail: string, snippet: string, entryIndex?: number) => {
    sources.push({ kind: kind, field, detail, snippet, entryIndex });
    if (!fieldsUsed.includes(field)) fieldsUsed.push(field);
  };

  const LANG = ['english','hindi','bengali','tamil','telugu','marathi','gujarati','punjabi','french','german','spanish','mandarin','chinese','japanese','korean','portuguese','italian','dutch'];
  const textParts: { label: string; text: string; field: string }[] = [
    { label: 'headline', text: fieldSnippet(profile.headline), field: 'headline' },
    { label: 'skills', text: fieldSnippet(profile.skills), field: 'skills' },
  ];
  const ed = parseJsonArray(profile.educationJson);
  for (let i = 0; i < ed.length; i++) {
    textParts.push({ label: 'educationJson[' + i + '].note', text: fieldSnippet(String(ed[i].note ?? '')), field: 'educationJson' });
  }
  const wh = parseJsonArray(profile.workHistoryJson);
  for (let i = 0; i < wh.length; i++) {
    textParts.push({ label: 'workHistoryJson[' + i + '].summary', text: fieldSnippet(String(wh[i].summary ?? '')), field: 'workHistoryJson' });
  }

  for (const part of textParts) {
    if (!part.text) continue;
    for (const lang of LANG) {
      if (hasWord(part.text, lang) || part.text.includes(lang)) {
        addSource('profile_field', part.field, 'language evidence: "' + lang + '"', part.text);
      }
    }
  }

  if (sources.length === 0) {
    return {
      claim, category: 'language', status: 'unknown', sources: [],
      note: 'no language evidence found for "' + wanted + '" in profile fields',
      fieldsUsed,
    };
  }

  return {
    claim, category: 'language', status: 'matched', sources,
    note: 'language evidence found in candidate profile',
    fieldsUsed,
  };
}

function locationEvidence(
  profile: CandidateProfile,
  claim: string,
  _hint: string | undefined,
): ClaimEvidence {
  const fieldsUsed: string[] = [];
  const sources: EvidenceSource[] = [];
  const addSource = (kind: EvidenceSourceKind, field: string, detail: string, snippet: string, entryIndex?: number) => {
    sources.push({ kind: kind, field, detail, snippet, entryIndex });
    if (!fieldsUsed.includes(field)) fieldsUsed.push(field);
  };

  const loc = fieldSnippet(profile.currentLocation);
  if (loc) {
    addSource('profile_field', 'currentLocation', 'current location: ' + profile.currentLocation, loc);
  }

  if (!loc) {
    return {
      claim, category: 'location', status: 'unknown', sources: [],
      note: 'currentLocation not recorded on the profile',
      fieldsUsed,
    };
  }

  return {
    claim, category: 'location', status: 'matched', sources,
    note: 'candidate current location recorded',
    fieldsUsed,
  };
}

function noticeEvidence(
  profile: CandidateProfile,
  claim: string,
  _hint: string | undefined,
): ClaimEvidence {
  const fieldsUsed: string[] = [];
  const sources: EvidenceSource[] = [];
  const addSource = (kind: EvidenceSourceKind, field: string, detail: string, snippet: string, entryIndex?: number) => {
    sources.push({ kind: kind, field, detail, snippet, entryIndex });
    if (!fieldsUsed.includes(field)) fieldsUsed.push(field);
  };

  const np = fieldSnippet(profile.noticePeriod);
  if (np) {
    addSource('profile_field', 'noticePeriod', 'notice period: ' + profile.noticePeriod, np);
  }

  if (!np) {
    return {
      claim, category: 'notice_period', status: 'unknown', sources: [],
      note: 'noticePeriod not recorded on the profile',
      fieldsUsed,
    };
  }

  return {
    claim, category: 'notice_period', status: 'matched', sources,
    note: 'candidate notice period recorded',
    fieldsUsed,
  };
}

function compensationEvidence(
  profile: CandidateProfile,
  claim: string,
  _hint: string | undefined,
): ClaimEvidence {
  const fieldsUsed: string[] = [];
  const sources: EvidenceSource[] = [];
  const addSource = (kind: EvidenceSourceKind, field: string, detail: string, snippet: string, entryIndex?: number) => {
    sources.push({ kind: kind, field, detail, snippet, entryIndex });
    if (!fieldsUsed.includes(field)) fieldsUsed.push(field);
  };

  const sc = fieldSnippet(profile.salaryExpectation);
  if (sc) {
    addSource('profile_field', 'salaryExpectation', 'salary expectation: ' + profile.salaryExpectation, sc);
  }

  if (!sc) {
    return {
      claim, category: 'compensation', status: 'unknown', sources: [],
      note: 'salaryExpectation not recorded on the profile',
      fieldsUsed,
    };
  }

  return {
    claim, category: 'compensation', status: 'matched', sources,
    note: 'candidate salary expectation recorded',
    fieldsUsed,
  };
}

function employerEvidence(
  profile: CandidateProfile,
  claim: string,
  hint: string | undefined,
): ClaimEvidence {
  const wanted = (hint ?? claim).toLowerCase().trim();
  const fieldsUsed: string[] = [];
  const sources: EvidenceSource[] = [];
  const addSource = (kind: EvidenceSourceKind, field: string, detail: string, snippet: string, entryIndex?: number) => {
    sources.push({ kind: kind, field, detail, snippet, entryIndex });
    if (!fieldsUsed.includes(field)) fieldsUsed.push(field);
  };

  const wh = parseJsonArray(profile.workHistoryJson);
  if (wh.length === 0) {
    return {
      claim, category: 'employer', status: 'unknown', sources: [],
      note: 'no workHistoryJson entries — cannot verify employer "' + wanted + '"',
      fieldsUsed,
    };
  }

  for (let i = 0; i < wh.length; i++) {
    const company = fieldSnippet(String(wh[i].company ?? ''));
    if (hasWord(company, wanted) || company.includes(wanted)) {
      addSource('work_history', 'workHistoryJson',
        'work history entry ' + i + ': employer "' + wh[i].company + '"', company, i);
    }
  }

  if (sources.length === 0) {
    return {
      claim, category: 'employer', status: 'mismatch', sources: [],
      note: 'employer "' + wanted + '" not found in workHistoryJson company names',
      fieldsUsed,
    };
  }

  return {
    claim, category: 'employer', status: 'matched', sources,
    note: 'employer "' + wanted + '" found in work history',
    fieldsUsed,
  };
}

function technologyEvidence(
  profile: CandidateProfile,
  claim: string,
  hint: string | undefined,
): ClaimEvidence {
  const wanted = (hint ?? claim).toLowerCase().trim();
  const fieldsUsed: string[] = [];
  const sources: EvidenceSource[] = [];
  const addSource = (kind: EvidenceSourceKind, field: string, detail: string, snippet: string, entryIndex?: number) => {
    sources.push({ kind: kind, field, detail, snippet, entryIndex });
    if (!fieldsUsed.includes(field)) fieldsUsed.push(field);
  };

  const pj = parseJsonArray(profile.projectsJson);
  for (let i = 0; i < pj.length; i++) {
    const p = pj[i];
    const tech = Array.isArray(p.tech) ? p.tech.map(String).map((t) => t.toLowerCase().trim()).filter(Boolean) : [];
    if (tech.some((t) => hasWord(t, wanted) || t.includes(wanted))) {
      addSource('project', 'projectsJson',
        'project ' + i + ': ' + String(p.name ?? '') + ' — tech includes ' + wanted,
        tech.join(' '), i);
    }
  }

  const wh = parseJsonArray(profile.workHistoryJson);
  for (let i = 0; i < wh.length; i++) {
    const summary = fieldSnippet(String(wh[i].summary ?? ''));
    if (hasWord(summary, wanted) || summary.includes(wanted)) {
      addSource('work_history', 'workHistoryJson',
        'work history entry ' + i + ' summary mentions ' + wanted, summary, i);
    }
  }

  const profileSkillTags = normalizeSep(profile.skills);
  if (profileSkillTags.some((t) => hasWord(t, wanted) || t.includes(wanted))) {
    addSource('profile_field', 'skills', 'skill tag: ' + wanted, profile.skills ?? '');
  }

  if (sources.length === 0) {
    return {
      claim, category: 'technology', status: 'unknown', sources: [],
      note: 'no technology evidence found for "' + wanted + '" in projects, work history, or skills',
      fieldsUsed,
    };
  }

  const hasProjectTech = sources.some((s) => s.kind === 'project');
  return {
    claim, category: 'technology', status: hasProjectTech ? 'matched' : 'partial', sources,
    note: hasProjectTech
      ? wanted + ' recorded as a project technology'
      : wanted + ' present in skills/summary but not recorded as a project technology',
    fieldsUsed,
  };
}

function achievementEvidence(
  profile: CandidateProfile,
  claim: string,
  hint: string | undefined,
): ClaimEvidence {
  const wanted = (hint ?? claim).toLowerCase().trim();
  const fieldsUsed: string[] = [];
  const sources: EvidenceSource[] = [];
  const addSource = (kind: EvidenceSourceKind, field: string, detail: string, snippet: string, entryIndex?: number) => {
    sources.push({ kind: kind, field, detail, snippet, entryIndex });
    if (!fieldsUsed.includes(field)) fieldsUsed.push(field);
  };

  const wh = parseJsonArray(profile.workHistoryJson);
  for (let i = 0; i < wh.length; i++) {
    const summary = fieldSnippet(String(wh[i].summary ?? ''));
    if (summary && (hasWord(summary, wanted) || summary.includes(wanted))) {
      addSource('work_history', 'workHistoryJson', 'work history entry ' + i + ' summary', summary, i);
    }
  }

  const pj = parseJsonArray(profile.projectsJson);
  for (let i = 0; i < pj.length; i++) {
    const summary = fieldSnippet(String(pj[i].summary ?? ''));
    if (summary && (hasWord(summary, wanted) || summary.includes(wanted))) {
      addSource('project', 'projectsJson', 'project ' + i + ' summary', summary, i);
    }
  }

  if (sources.length === 0) {
    return {
      claim, category: 'achievement', status: 'unknown', sources: [],
      note: 'no achievement/metric evidence found for "' + wanted + '" in work history or project summaries',
      fieldsUsed,
    };
  }

  return {
    claim, category: 'achievement', status: 'matched', sources,
    note: 'achievement/metric evidence found in candidate summaries',
    fieldsUsed,
  };
}

// ---- Dispatcher -----------------------------------------------------------

const EXTRACTORS: Record<MaterialClaimCategory, (profile: CandidateProfile, claim: string, hint?: string) => ClaimEvidence> = {
  skill: skillEvidence,
  experience_years: experienceEvidence,
  seniority: seniorityEvidence,
  education: educationEvidence,
  authorization: authorizationEvidence,
  employment_type: employmentTypeEvidence,
  language: languageEvidence,
  location: locationEvidence,
  notice_period: noticeEvidence,
  compensation: compensationEvidence,
  employer: employerEvidence,
  technology: technologyEvidence,
  achievement: achievementEvidence,
};

// ---- Service --------------------------------------------------------------

/** Deterministic fingerprint of the profile evidence snapshot used for one evaluation. */
function evidenceFingerprint(profile: CandidateProfile): string {
  const parts = [
    profile.id ?? '',
    profile.skills ?? '',
    profile.headline ?? '',
    String(profile.experienceYears ?? ''),
    profile.noticePeriod ?? '',
    profile.salaryExpectation ?? '',
    profile.currentLocation ?? '',
    profile.workHistoryJson ?? '',
    profile.educationJson ?? '',
    profile.projectsJson ?? '',
    profile.linkedinUrl ?? '',
    profile.githubUrl ?? '',
    profile.portfolioUrl ?? '',
  ];
  const body = parts.join('|');
  let hash = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body.charCodeAt(i);
    hash = ((hash << 5) - hash) + c;
    hash = hash & hash;
  }
  return String(Math.abs(hash));
}

/**
 * Evaluate a set of material claims against one candidate profile.
 *
 * Pure function: same (profile, claims) → same record every time.
 * No I/O, no DB, no randomness, no AI.
 */
export function evaluateEvidence(profile: CandidateProfile, claims: MaterialClaim[]): CandidateEvidenceRecord {
  const claimsResult: ClaimEvidence[] = [];
  const fieldsUsedSet = new Set<string>();

  for (const c of claims) {
    const extractor = EXTRACTORS[c.category];
    if (!extractor) {
      claimsResult.push({
        claim: c.claim, category: c.category, status: 'unknown', sources: [],
        note: 'unknown claim category "' + c.category + '" — no evidence extractor registered',
        fieldsUsed: [],
      });
      continue;
    }
    const result = extractor(profile, c.claim, c.hint);
    for (const f of result.fieldsUsed) fieldsUsedSet.add(f);
    claimsResult.push(result);
  }

  return {
    profileId: profile.id,
    claims: claimsResult,
    fieldsUsed: [...fieldsUsedSet].sort(),
    evidenceFingerprint: evidenceFingerprint(profile),
  };
}

// ---- NestJS injectable ---------------------------------------------------

@Injectable()
export class CandidateEvidenceService {
  /**
   * Public API — delegates to the pure evaluateEvidence() so the qualification
   * engine and downstream CV tailoring can consume explainable candidate evidence.
   */
  evaluate(profile: CandidateProfile, claims: MaterialClaim[]): CandidateEvidenceRecord {
    return evaluateEvidence(profile, claims);
  }
}
