/**
 * JA-015 — Skill-gap severity classifier
 *
 * doneWhen: "Gap classification is deterministic, explainable and used by
 * qualification."
 *
 * Standalone pure deterministic classifier. NO I/O, NO randomness, NO AI, NO
 * database, NO imports of synonym-map / semantic matcher.
 *
 * SEMANTIC RULES (authoritative, from user directive):
 *   (1) matched/covered, missing, transferable/mitigation are kept SEPARATE.
 *   (2) A must-have not directly matched STAYS missing — transferable/related
 *       evidence is recorded separately and NEVER erases the missing must-have.
 *   (3) Severity from explicit combination of: must-have vs preferred,
 *       direct match, transferable evidence, related evidence, seniority.
 *   (4) Transferable may reduce severity where taxonomy supports mitigation, but
 *       NEVER hides a genuine mandatory requirement.
 *   (5) Deterministic + explainable: every decision has reasons.
 *
 * TAXONOMY (derived from existing qualification.service.ts semantics):
 *   BLOCKING → at least one must-have with NO direct AND NO transferable
 *              AND NO related mitigation. Must never be hidden.
 *   MAJOR    → (a) seniority clash: profile >=2 levels below lead, OR
 *              (b) 2+ must-have gaps (mitigated or not), OR
 *              (c) 2+ preferred gaps with no coverage at all, OR
 *              (d) 1 must-have gap (mitigated) + 1 preferred gap (no coverage).
 *   MODERATE → (a) exactly 1 must-have gap (mitigated: transferable/related
 *                  but no direct) + 0 preferred gaps, OR
 *              (b) exactly 1 preferred gap with no coverage (any mhDirect), OR
 *              (c) 3+ preferred gaps that ARE mitigated (transferable/related).
 *   MINOR    → 1-2 preferred gaps that ARE mitigated (have transferable/related
 *              coverage). No must-have gaps, no unmitigated preferred gaps.
 *   NONE     → all must-have AND all preferred/nice-to-have directly matched.
 *   UNKNOWN  → insufficient evidence (empty profile, empty requirements).
 *
 * NOTE: quota exhaustion is NOT a signal. Mitigated must-have gaps are NOT
 *       counted toward "profile competence buckets." They are tracked as
 *       missing-with-mitigation only. A mitigated must-have is still missing;
 *       transferable/related mitigation is recorded separately and may reduce
 *       severity only where the taxonomy supports it, but never hides the gap.
 */

export type GapSeverity = 'NONE' | 'MINOR' | 'MODERATE' | 'MAJOR' | 'BLOCKING' | 'UNKNOWN';

export interface SkillRequirement {
  name: string;
  kind: 'must-have' | 'preferred' | 'nice-to-have';
}

export interface SkillEvidence {
  matched: ReadonlySet<string>;
  transferable: ReadonlySet<string>;
  related: ReadonlySet<string>;
}

export interface GapEvidence {
  profileSkills: ReadonlySet<string>;
  requirements: ReadonlyArray<SkillRequirement & { evidence?: SkillEvidence }>;
  profileSeniority?: string | null;
  leadSeniority?: string | null;
}

export interface SkillGapResult {
  severity: GapSeverity;
  missingMustHave: string[];
  missingPreferred: string[];
  covered: string[];
  mitigatedMustHaves: Array<{ skill: string; transferable: string[]; related: string[] }>;
  mitigatedPreferred: Array<{ skill: string; transferable: string[]; related: string[] }>;
  reasons: string[];
  unknownBasis?: string;
}

const SENIORITY_RANK: Record<string, number> = {
  junior: 1, mid: 2, senior: 3, lead: 4, principal: 5, director: 6, head: 7,
};

function sr(lvl: string | undefined | null): number {
  if (!lvl) return 0;
  return SENIORITY_RANK[lvl.toLowerCase()] ?? 0;
}

function norm(s: string): string { return s.trim().toLowerCase(); }

export function classifySkillGap(evidence: GapEvidence): SkillGapResult {
  const profile = evidence.profileSkills;
  const reqs = evidence.requirements;

  // ---- UNKNOWN: insufficient evidence ------------------------------------
  if (profile.size === 0 || reqs.length === 0) {
    const basis = profile.size === 0 && reqs.length > 0
      ? 'profile skills not recorded; cannot classify gap against requirements'
      : profile.size > 0 && reqs.length === 0
        ? 'no skill requirements extracted; nothing to classify against'
        : 'profile skills and requirements both absent; cannot classify';
    return { severity: 'UNKNOWN', missingMustHave: [], missingPreferred: [],
      covered: [], mitigatedMustHaves: [], mitigatedPreferred: [],
      reasons: [`UNKNOWN: ${basis}`], unknownBasis: basis };
  }

  // ---- Walk requirements: classify each into direct / missing / mitigated ----
  const mhDirect: string[] = [];
  const mhMissing: string[] = [];
  const mhTransferable: string[] = [];
  const prefDirect: string[] = [];
  const prefTransfer: string[] = [];
  const prefRelated: string[] = [];
  const prefMissing: string[] = [];
  const covered: string[] = [];
  const mitigatedMustHaves: Array<{ skill: string; transferable: string[]; related: string[] }> = [];
  const mitigatedPreferred: Array<{ skill: string; transferable: string[]; related: string[] }> = [];
  const reasons: string[] = [];

  for (const r of reqs) {
    const name = norm(r.name);
    const ev = r.evidence ?? { matched: new Set<string>(), transferable: new Set<string>(), related: new Set<string>() };
    const mSet = ev.matched instanceof Set ? ev.matched : new Set<string>(ev.matched ?? []);
    const tSet = ev.transferable instanceof Set ? ev.transferable : new Set<string>(ev.transferable ?? []);
    const rSet = ev.related instanceof Set ? ev.related : new Set<string>(ev.related ?? []);
    const hasDirect = mSet.has(name) || profile.has(name);
    const tSkills = [...tSet].filter(s => profile.has(s));
    const rSkills = [...rSet].filter(s => profile.has(s));
    const hasTransfer = tSkills.length > 0;
    const hasRelated = rSkills.length > 0;

    if (r.kind === 'must-have') {
      if (hasDirect) {
        mhDirect.push(name);
        covered.push(name);
        reasons.push(`COVERED(must-have,direct): ${name}`);
      } else {
        mhMissing.push(name);
        if (hasTransfer) {
          mitigatedMustHaves.push({ skill: name, transferable: tSkills, related: rSkills });
          mhTransferable.push(name);
          reasons.push(`MISSING(must-have,mitigated-transferable): ${name} [transferable:${tSkills.slice(0,3).join(',')}]` +
            (rSkills.length > 0 ? `; related:${rSkills.slice(0,3).join(',')}` : ''));
        } else if (hasRelated) {
          reasons.push(`MISSING(must-have,unmitigated,related-only): ${name} [related:${rSkills.slice(0,3).join(',')}]`);
        } else {
          reasons.push(`MISSING(must-have,unmitigated): ${name}`);
        }
      }
    } else {
      if (hasDirect) {
        prefDirect.push(name);
        covered.push(name);
        reasons.push(`COVERED(${r.kind},direct): ${name}`);
      } else if (hasTransfer) {
        prefTransfer.push(name);
        mitigatedPreferred.push({ skill: name, transferable: tSkills, related: rSkills });
        reasons.push(`MITIGATED(${r.kind},transferable): ${name} [transferable:${tSkills.slice(0,3).join(',')}]`
          + (rSkills.length > 0 ? `; related:${rSkills.slice(0,3).join(',')}` : ''));
      } else if (hasRelated) {
        prefRelated.push(name);
        mitigatedPreferred.push({ skill: name, transferable: [], related: rSkills });
        reasons.push(`MISSING(${r.kind},mitigated-related): ${name} [related:${rSkills.slice(0,3).join(',')}]`);
      } else {
        prefMissing.push(name);
        reasons.push(`MISSING(${r.kind},unmitigated): ${name}`);
      }
    }
  }

  const mitigatedPreferredCount = prefTransfer.length + prefRelated.length;

  // ---- BLOCKING: at least one must-have with no mitigation ---------------
  if (mhMissing.length > 0 &&
      mhMissing.every(m => {
        const mit = mitigatedMustHaves.find(x => x.skill === m);
        return !mit || (mit.transferable.length === 0 && mit.related.length === 0);
      })) {
    // At least one unmitigated must-have → BLOCKING
    const unmitigatedMh = mhMissing.filter(m => {
      const mit = mitigatedMustHaves.find(x => x.skill === m);
      return !mit || (mit.transferable.length === 0 && mit.related.length === 0);
    });
    return {
      severity: 'BLOCKING',
      missingMustHave: unmitigatedMh,
      missingPreferred: prefMissing,
      covered,
      mitigatedMustHaves: mitigatedMustHaves.filter(m => unmitigatedMh.includes(m.skill)),
      mitigatedPreferred,
      reasons: [
        `BLOCKING: ${unmitigatedMh.length} must-have skill(s) missing with no transferable/related mitigation: ${unmitigatedMh.join(', ')}`,
        ...reasons.filter(r => r.startsWith('MISSING(must-have,unmitigated')),
      ],
    };
  }

  // ---- MAJOR: seniority clash (2+ levels) ---------------------------------
  const pr = sr(evidence.profileSeniority);
  const lr = sr(evidence.leadSeniority);
  if (pr > 0 && lr > 0 && pr < lr && lr - pr >= 2) {
    return {
      severity: 'MAJOR',
      missingMustHave: mhMissing,
      missingPreferred: prefMissing,
      covered,
      mitigatedMustHaves,
      mitigatedPreferred,
      reasons: [
        `MAJOR: seniority clash — profile ${evidence.profileSeniority ?? 'unknown'} vs lead ${evidence.leadSeniority ?? 'unknown'} (${lr-pr} level gap)`,
        ...reasons,
      ],
    };
  }

  // ---- MAJOR: 2+ must-have gaps (mitigated or not) -----------------------
  if (mhMissing.length >= 2) {
    return {
      severity: 'MAJOR',
      missingMustHave: mhMissing,
      missingPreferred: prefMissing,
      covered,
      mitigatedMustHaves,
      mitigatedPreferred,
      reasons: [
        `MAJOR: ${mhMissing.length} must-have gap(s) — ${mhMissing.join(', ')} (each mitigated by transferable/related but no direct match)`,
        ...reasons.filter(r => r.startsWith('MISSING(must-have')),
      ],
    };
  }

  // ---- MAJOR: 2+ unmitigated preferred gaps ------------------------------
  if (mhMissing.length === 0 && prefMissing.length >= 2) {
    return {
      severity: 'MAJOR',
      missingMustHave: [],
      missingPreferred: prefMissing,
      covered,
      mitigatedMustHaves: [],
      mitigatedPreferred: mitigatedPreferred.filter(m => prefMissing.includes(m.skill)),
      reasons: [
        `MAJOR: ${prefMissing.length} preferred/nice-to-have gap(s) with no coverage — ${prefMissing.join(', ')}`,
        ...reasons.filter(r => r.startsWith('MISSING(preferred') || r.startsWith('MISSING(nice-to-have')),
      ],
    };
  }

  // ---- MAJOR: 1 mitigated must-have + 1 unmitigated preferred ------------
  // Must-have involvement elevates above a standalone unmitigated preferred gap
  // (which is MODERATE-b). Resolves taxonomy ambiguity: MAJOR-d wins.
  if (mhMissing.length === 1 && prefMissing.length === 1) {
    return {
      severity: 'MAJOR',
      missingMustHave: mhMissing,
      missingPreferred: prefMissing,
      covered,
      mitigatedMustHaves,
      mitigatedPreferred: mitigatedPreferred.filter(m => prefMissing.includes(m.skill)),
      reasons: [
        `MAJOR: 1 mitigated must-have gap (${mhMissing[0]}) + 1 unmitigated preferred gap (${prefMissing[0]}) — must-have involvement elevates above standalone unmitigated preferred gap`,
        ...reasons.filter(r => r.startsWith('MISSING(must-have') || r.startsWith('MISSING(preferred') || r.startsWith('MISSING(nice-to-have')),
      ],
    };
  }

  // ---- MODERATE: 1 mitigated must-have, 0 preferred gaps -----------------
  if (mhMissing.length === 1 && prefMissing.length === 0) {
    return {
      severity: 'MODERATE',
      missingMustHave: mhMissing,
      missingPreferred: [],
      covered,
      mitigatedMustHaves,
      mitigatedPreferred: [],
      reasons: [
        `MODERATE: 1 mitigated must-have gap — ${mhMissing[0]} (no direct match; has transferable/related mitigation)`,
        ...reasons.filter(r => r.startsWith('MISSING(must-have')),
      ],
    };
  }

  // ---- MODERATE: 1 unmitigated preferred gap (any mhDirect) -------------
  if (mhMissing.length === 0 && prefMissing.length === 1) {
    return {
      severity: 'MODERATE',
      missingMustHave: [],
      missingPreferred: prefMissing,
      covered,
      mitigatedMustHaves: [],
      mitigatedPreferred: mitigatedPreferred.filter(m => prefMissing.includes(m.skill)),
      reasons: [
        `MODERATE: 1 preferred/nice-to-have gap with no coverage — ${prefMissing[0]}; profile has ${mhDirect.length} direct must-have match(es)`,
        ...reasons.filter(r => r.startsWith('MISSING(preferred') || r.startsWith('MISSING(nice-to-have')),
      ],
    };
  }

  // ---- MODERATE: 3+ mitigated preferred gaps ----------------------------
  if (mhMissing.length === 0 && prefMissing.length === 0 && mitigatedPreferredCount >= 3) {
    return {
      severity: 'MODERATE',
      missingMustHave: [],
      missingPreferred: [],
      covered,
      mitigatedMustHaves: [],
      mitigatedPreferred,
      reasons: [
        `MODERATE: ${mitigatedPreferredCount} mitigated preferred/nice-to-have gap(s) (transferable/related coverage); profile has ${mhDirect.length} direct must-have match(es)`,
        ...reasons.filter(r => r.startsWith('COVERED(preferred') || r.startsWith('COVERED(nice-to-have') || r.startsWith('MISSING(preferred') || r.startsWith('MISSING(nice-to-have')),
      ],
    };
  }

  // ---- MINOR: 1-2 mitigated preferred gaps -------------------------------
  if (mhMissing.length === 0 && prefMissing.length === 0 && mitigatedPreferredCount >= 1 && mitigatedPreferredCount <= 2) {
    return {
      severity: 'MINOR',
      missingMustHave: [],
      missingPreferred: [],
      covered,
      mitigatedMustHaves: [],
      mitigatedPreferred,
      reasons: [
        `MINOR: ${mitigatedPreferredCount} mitigated preferred/nice-to-have gap(s) (transferable/related coverage); profile has ${mhDirect.length} direct must-have match(es)`,
        ...reasons.filter(r => r.startsWith('COVERED(preferred') || r.startsWith('COVERED(nice-to-have') || r.startsWith('MISSING(preferred') || r.startsWith('MISSING(nice-to-have')),
      ],
    };
  }

  // ---- NONE: every must-have AND every preferred directly matched ---------
  if (mhMissing.length === 0 && prefMissing.length === 0 && prefTransfer.length === 0 && prefRelated.length === 0 &&
      (mhDirect.length + prefDirect.length) > 0) {
    return {
      severity: 'NONE',
      missingMustHave: [],
      missingPreferred: [],
      covered: [...mhDirect, ...prefDirect],
      mitigatedMustHaves: [],
      mitigatedPreferred: [],
      reasons: ['NONE: every required and preferred skill has direct coverage'],
    };
  }

  // Fallback
  return {
    severity: 'UNKNOWN',
    missingMustHave: mhMissing,
    missingPreferred: prefMissing,
    covered,
    mitigatedMustHaves,
    mitigatedPreferred,
    reasons: [`UNKNOWN: residual unclassified gap — mhMissing:${mhMissing.length} mhTransferable:${mhTransferable.length} prefMissing:${prefMissing.length} prefTransfer:${prefTransfer.length} prefRelated:${prefRelated.length} mhDirect:${mhDirect.length}`],
    unknownBasis: 'residual gap could not be categorized by the deterministic rules',
  };
}

export function classifySkillGapDeterministic(evidence: GapEvidence): SkillGapResult {
  const a = classifySkillGap(evidence);
  const b = classifySkillGap(evidence);
  if (a.severity !== b.severity || a.missingMustHave.join(',') !== b.missingMustHave.join(',') ||
      a.missingPreferred.join(',') !== b.missingPreferred.join(',') ||
      a.covered.join(',') !== b.covered.join(',') ||
      a.reasons.join('|') !== b.reasons.join('|')) {
    throw new Error('classifySkillGap is NOT deterministic');
  }
  return a;
}
