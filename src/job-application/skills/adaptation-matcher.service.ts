import { Injectable } from '@nestjs/common';
import { CandidateProfile } from '../../profile/candidate-profile.entity';
import { JobLead } from '../../leads/job-lead.entity';
import {
  matchSkillPair,
  semanticMatch,
  synonymGroupMembers,
  SemanticMatchResult,
  SkillMatchOutcome,
} from '../skills/synonym-map';
import {
  classifySkillGap,
  GapSeverity,
  SkillRequirement,
} from '../skills/gap-severity';

// ── DecisionItem shape. Mirrors the shape adaptation-matcher.service.ts already
// documents. Built from real JobLead columns only (no non-existent portal/skills
// arrays on the entity).
export interface AdaptedDecisionItem {
  readonly id: string;
  readonly title: string;
  readonly company: string;
  readonly description: string | null;
  readonly skills: readonly string[];
  readonly channel: string | null;
  readonly portalSource: string | null;
  readonly location: string | null;
  readonly fetchedAt: string | null;
  readonly context?: Record<string, unknown> | null;
}

const SPLIT = /[,;|\/]\s*/;
const NORM = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
const GOOD = /^[a-z][\w.+#-]{1,40}$/;
const PREF_MARKER = /\b(?:preferred|nice.?to.?have|bonus|plustrary|advantage:|good.?to.?have)\b[:\s]*/i;

function normList(csv: string | null | undefined): string[] {
  if (!csv) return [];
  return csv.split(SPLIT).map(NORM).filter(s => s.length >= 2 && GOOD.test(s)).filter((s, i, a) => a.indexOf(s) === i);
}

function uniq(a: string[]): string[] { return a.filter((s, i) => a.indexOf(s) === i); }
function clamp(n: number, lo = 0, hi = 100): number { return Math.max(lo, Math.min(hi, n)); }

function flatMap<T, U>(arr: readonly T[], fn: (t: T) => readonly U[]): U[] {
  const out: U[] = [];
  for (const t of arr) for (const u of fn(t)) out.push(u);
  return out;
}

// ---- skill extraction from a real JobLead ----

function normJobSkills(lead: JobLead): string[] {
  // matchedSkills is the only structured skill list the entity carries.
  const fromList = (lead.matchedSkills ?? []).map(String).map(NORM).filter(Boolean);
  // description is the only free-text skill source on the entity.
  const fromDesc: string[] = [];
  if (lead.description) {
    // thin extraction: known-tech tokens visible in the description, reusing the
    // same KNOWN_TECH set the qualification evaluator uses for evidence scoring.
    const hay = lead.description.toLowerCase();
    const KNOWN_TECH = [
      'javascript','typescript','python','java','kotlin','scala','go','rust','c++','c#','dotnet',
      'react','angular','vue','node','nodejs','express','django','flask','fastapi','spring','rails','laravel',
      'sql','postgresql','mysql','mongodb','redis','kafka','docker','kubernetes','aws','azure','gcp',
      'machine learning','deep learning','nlp','data engineering','devops','sre',
    ].map(s => s.trim().toLowerCase()).filter(Boolean);
    for (const t of KNOWN_TECH) {
      if (hay.includes(t)) fromDesc.push(t);
    }
  }
  // split the title into tokens and treat obvious tech tokens as skills too
  const fromTitle: string[] = [];
  if (lead.title) {
    const titleTokens = lead.title.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    const TITLE_TECH = ['react','next.js','nextjs','vue','angular','node','nodejs','python','java','go','golang','rust','php','laravel','ruby','rails','swift','kotlin','android','ios','devops','sre','ml','postgres','mysql','mongodb','redis','docker','kubernetes','terraform','aws','azure','gcp'];
    for (const t of TITLE_TECH) {
      if (titleTokens.some(tt => tt.includes(t)) && !fromList.some(a => a === NORM(t)) && !fromDesc.some(a => a === NORM(t))) {
        fromTitle.push(t);
      }
    }
  }
  return uniq([...fromList, ...fromDesc, ...fromTitle]);
}

function splitJobSkills(raw: string[]): { must: string[]; preferred: string[] } {
  const must: string[] = [];
  const preferred: string[] = [];
  let mode = 'must';
  for (const s of raw) {
    if (PREF_MARKER.test(s)) { mode = 'preferred'; continue; }
    if (mode === 'must') must.push(s);
    else preferred.push(s);
  }
  return { must: uniq(must), preferred: uniq(preferred) };
}

// ---- verdict shape ----

export interface AdaptationVerdict {
  readonly profileSkillSet: string[];
  readonly enrichedProfileSkills: string[];
  readonly jobMustSkills: string[];
  readonly jobPreferredSkills: string[];
  readonly matchPairs: SkillMatchOutcome[];
  readonly transferable: string[];
  readonly mustMissing: string[];
  readonly preferredMissing: string[];
  readonly gapSeverity: GapSeverity;
  readonly reasons: string[];
  readonly applyReadiness: 'ready' | 'partial' | 'risky' | 'no-go';
  readonly confidence: number;
  readonly fitScore: number;
}

// ---- service ----

@Injectable()
export class AdaptationMatcherService {
  /**
   * Evaluate a candidate profile against a structured job item.
   *
   * profile          — CandidateProfile entity (skills is a comma-separated text
   *                    column, e.g. "react, nodejs, python").
   * item             — AdaptedDecisionItem built from the real lead columns.
   */
  evaluate(profile: CandidateProfile, item: AdaptedDecisionItem): AdaptationVerdict {
    const profileSkills = normList(profile.skills);
    // expandWithSynonyms is not exported; use synonymGroupMembers (includes self).
    const enriched = uniq([...profileSkills, ...flatMap(profileSkills, synonymGroupMembers)]);

    const { must: jobMust, preferred: jobPref } = splitJobSkills([...item.skills]);

    const matchResult: SemanticMatchResult = semanticMatch(jobMust, enriched);
    const matchPairs: SkillMatchOutcome[] = matchResult.pairs;

    const transferable = matchPairs
      .filter(p => p.matched && p.matchReason !== 'identical' && !jobMust.includes(p.jdToken))
      .map(p => p.profileToken);

    const reqs: SkillRequirement[] = [];
    for (const m of jobMust) reqs.push({ name: m, kind: 'must-have' as const });
    for (const p of jobPref) reqs.push({ name: p, kind: 'preferred' as const });

    const matchedSet = new Set<string>();
    for (const p of matchPairs) if (p.matched) matchedSet.add(NORM(p.jdToken));
    const transferableSet = new Set(transferable);
    // missing (synonym-expanded) tokens from the semantic match are also evidence
    // that the skill is at least conceptually touched.
    for (const r of matchResult.missing) if (r) transferableSet.add(NORM(r));

    const gap = classifySkillGap({
      profileSkills: new Set(profileSkills),
      requirements: reqs.map(r => ({
        ...r,
        // GapEvidence.related is a ReadonlySet<string> of profile-side tokens
        // that are related (synonym family) to the requirement. We only have a
        // flat `missing` list from semanticMatch; pass it as the related set so
        // the classifier can use it for mitigation scoring.
        related: new Set(matchResult.missing),
      })),
    });

    const confidence = clamp(
      (enriched.length > 0 ? 55 : 35)
      + matchPairs.filter(p => p.matched).length * 4
      + (gap.severity === 'NONE' ? 15 : gap.severity === 'MINOR' ? 8 : 0)
      - (gap.severity === 'BLOCKING' ? 25 : gap.severity === 'MAJOR' ? 12 : 0),
    );

    const readiness: AdaptationVerdict['applyReadiness'] =
      gap.severity === 'BLOCKING' ? 'no-go'
      : gap.severity === 'MAJOR' ? (transferable.length >= 2 && confidence >= 55 ? 'risky' : 'no-go')
      : gap.severity === 'MODERATE' ? (matchPairs.filter(p => p.matched).length >= 3 ? 'partial' : 'risky')
      : 'ready';

    const reasons: string[] = [];
    if (gap.severity !== 'NONE') {
      reasons.push(`skill gap severity ${gap.severity} — ${gap.missingMustHave.length} must-have + ${gap.missingPreferred.length} preferred missing`);
    }
    if (gap.missingMustHave.length) {
      reasons.push(`missing must-have: ${gap.missingMustHave.slice(0, 5).join(', ')}${gap.missingMustHave.length > 5 ? ` (+${gap.missingMustHave.length - 5} more)` : ''}`);
    }
    if (gap.missingPreferred.length && gap.severity !== 'BLOCKING') {
      reasons.push(`missing preferred: ${gap.missingPreferred.slice(0, 4).join(', ')}`);
    }
    if (transferable.length) {
      reasons.push(`transferable into role: ${transferable.slice(0, 5).join(', ')}${transferable.length > 5 ? ` (+${transferable.length - 5})` : ''}`);
    }
    if (matchPairs.some(p => p.matchReason === 'synonym_profile' || p.matchReason === 'synonym_jd' || p.matchReason === 'synonym_both')) {
      reasons.push('synonym-expanded matches applied (e.g. react↔reactjs, node↔nodejs)');
    }
    for (const r of gap.reasons || []) if (typeof r === 'string') reasons.push(r);

    const fitScore = this.fitScore({
      jobMustSkills: jobMust,
      jobPreferredSkills: jobPref,
      mustMissing: gap.missingMustHave,
      preferredMissing: gap.missingPreferred,
      transferable,
      matchPairs,
      gapSeverity: gap.severity,
      confidence,
    });

    return {
      profileSkillSet: profileSkills,
      enrichedProfileSkills: enriched,
      jobMustSkills: jobMust,
      jobPreferredSkills: jobPref,
      matchPairs,
      transferable,
      mustMissing: gap.missingMustHave,
      preferredMissing: gap.missingPreferred,
      gapSeverity: gap.severity,
      reasons: uniq(reasons),
      applyReadiness: readiness,
      confidence,
      fitScore,
    };
  }

  /**
   * Convenience: build an AdaptedDecisionItem from a real JobLead entity and
   * evaluate the profile against it.
   *
   * Uses ONLY real JobLead columns:
   *   id, externalId, title, company, description, matchedSkills, location
   *
   * Does NOT reference any of these non-existent columns that the previous
   * implementation tried to read: jobTitleRaw, title_raw, position_title,
   * description_raw, skills[], portal, company_raw, external_id, apply_channel,
   * apply_channel_raw.
   */
  evaluateLead(profile: CandidateProfile, lead: JobLead): AdaptationVerdict {
    const job: AdaptedDecisionItem = {
      id: lead.externalId || `lead:${lead.id}`,
      title: lead.title || 'Untitled role',
      company: lead.company || 'Unknown',
      description: lead.description ?? null,
      skills: normJobSkills(lead),
      channel: null,                // JobLead has no apply-channel column
      portalSource: lead.source ?? null,   // source column → portalSource
      location: lead.location ?? null,
      fetchedAt: lead.createdAt ? lead.createdAt.toISOString() : null,
      context: { source: lead.source },
    };
    return this.evaluate(profile, job);
  }

  /**
   * Composite fit score (0-100) for ranking/scoring.
   * Accepts only fields present in AdaptationVerdict.
   */
  fitScore(v: Pick<AdaptationVerdict,
    | 'jobMustSkills'
    | 'jobPreferredSkills'
    | 'mustMissing'
    | 'preferredMissing'
    | 'transferable'
    | 'matchPairs'
    | 'gapSeverity'
    | 'confidence'
  >): number {
    const must = v.jobMustSkills.length || 1;
    const coverage = (must - v.mustMissing.length) / must;
    const prefTotal = (v.jobPreferredSkills.length || 1);
    const prefCoverage = (prefTotal - v.preferredMissing.length) / prefTotal;
    const transferableBonus = Math.min(v.transferable.length, 6) * 3;
    const penalty = { NONE: 0, MINOR: 8, MODERATE: 20, MAJOR: 40, BLOCKING: 70, UNKNOWN: 30 }[v.gapSeverity] ?? 30;
    return clamp(
      Math.round(
        coverage * 55
        + prefCoverage * 15
        + transferableBonus
        + v.matchPairs.filter(p => p.matched).length * 2
        - penalty
        + v.confidence * 0.15,
      ),
    );
  }
}
