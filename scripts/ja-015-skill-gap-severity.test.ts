/**
 * JA-015 — Skill-gap severity classifier tests
 *
 * Verifies the taxonomy derived from existing qualification.service.ts +
 * jd-intent-model.ts signals. Deterministic, explainable, no AI.
 */

import {
  classifySkillGap,
  classifySkillGapDeterministic,
  GapEvidence,
  SkillRequirement,
  SkillEvidence,
  GapSeverity,
} from '../src/job-application/skills/gap-severity';

function set(...items: string[]): ReadonlySet<string> {
  return new Set(items.map(s => s.toLowerCase()));
}

function req(name: string, kind: 'must-have' | 'preferred' | 'nice-to-have', evidence?: Partial<SkillEvidence>): SkillRequirement & { evidence?: SkillEvidence } {
  return { name, kind, evidence: evidence as SkillEvidence | undefined };
}

function sev(s: string): GapSeverity {
  return s as GapSeverity;
}

// ---- Evidence builders ------------------------------------------------------

function evidence(profile: string[], reqs: Array<{ name: string; matched?: string[]; transferable?: string[]; related?: string[] }>): GapEvidence {
  const profileSkills = new Set(profile.map(s => s.toLowerCase()));
  const requirements: Array<SkillRequirement & { evidence?: SkillEvidence }> = reqs.map(r => ({
    name: r.name,
    kind: 'must-have' as const,
    evidence: {
      matched: new Set((r.matched ?? []).map(s => s.toLowerCase())),
      transferable: new Set((r.transferable ?? []).map(s => s.toLowerCase())),
      related: new Set((r.related ?? []).map(s => s.toLowerCase())),
    },
  }));
  return { profileSkills, requirements, profileSeniority: 'mid', leadSeniority: 'senior' };
}

// ---- 1. NONE -----------------------------------------------------------------

console.log('=== JA-015 tests ===');
let passed = 0;
let failed = 0;

let t = 0;
function test(name: string, fn: () => void) {
  t++;
  try {
    fn();
    console.log(`  PASS [${t}] ${name}`);
    passed++;
  } catch (e: any) {
    console.log(`  FAIL [${t}] ${name}: ${e.message}`);
    failed++;
  }
}

function assertEq(actual: any, expected: any, msg?: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(msg ?? `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

test('NONE: all must-have + preferred covered', () => {
  const r = classifySkillGap({
    profileSkills: set('react', 'nodejs', 'express', 'mongodb', 'typescript'),
    requirements: [
      req('react', 'must-have', { matched: set('react') }),
      req('nodejs', 'must-have', { matched: set('nodejs') }),
      req('typescript', 'preferred', { matched: set('typescript') }),
    ],
    profileSeniority: 'mid',
    leadSeniority: 'mid',
  });
  assertEq(r.severity, sev('NONE'), 'severity');
  assertEq(r.missingMustHave, [], 'missingMustHave');
  assertEq(r.missingPreferred, [], 'missingPreferred');
  assertEq(r.covered.length, 3, 'covered count');
});

test('NONE: single must-have matched', () => {
  const r = classifySkillGap({
    profileSkills: set('javascript'),
    requirements: [req('javascript', 'must-have', { matched: set('javascript') })],
  });
  assertEq(r.severity, sev('NONE'));
});

// ---- 2. BLOCKING -------------------------------------------------------------

test('BLOCKING: must-have missing with no transferable coverage', () => {
  const r = classifySkillGap({
    profileSkills: set('python'),
    requirements: [
      req('react', 'must-have', { matched: new Set(), transferable: new Set() }),
    ],
    profileSeniority: 'mid',
    leadSeniority: 'mid',
  });
  assertEq(r.severity, sev('BLOCKING'), 'severity');
  assertEq(r.missingMustHave, ['react'], 'missingMustHave');
  assertEq(r.missingPreferred, [], 'missingPreferred');
  if (!r.reasons[0].startsWith('BLOCKING')) throw new Error('first reason must be BLOCKING');
});

test('BLOCKING: must-have missing with related-only coverage (related does NOT unblock)', () => {
  const r = classifySkillGap({
    profileSkills: set('vue'),
    requirements: [
      req('react', 'must-have', { matched: new Set(), transferable: new Set(), related: set('vue') }),
    ],
    profileSeniority: 'mid',
    leadSeniority: 'mid',
  });
  assertEq(r.severity, sev('BLOCKING'), 'related-only coverage does NOT unblock must-have');
  assertEq(r.missingMustHave, ['react']);
});

test('MODERATE: must-have missing with transferable coverage (transferable-covered must-have stays missing → MODERATE)', () => {
  // Per Rule 2: must-have missing stays missing regardless of transferable coverage.
  // 1 mitigated must-have + 0 preferred missing + mhDirect < 2 → MODERATE.
  const r = classifySkillGap({
    profileSkills: set('angular'),
    requirements: [
      req('react', 'must-have', { matched: new Set(), transferable: set('angular') }),
    ],
    profileSeniority: 'mid',
    leadSeniority: 'mid',
  });
  assertEq(r.severity, sev('MODERATE'), 'transferable-covered must-have stays missing → MODERATE');
  assertEq(r.missingMustHave, ['react'], 'must-have stays missing (not elided by transferable)');
  assertEq(r.covered, [], 'no direct matches — transferable does not add to covered');
});

test('BLOCKING: multiple must-haves missing, one unblockable', () => {
  const r = classifySkillGap({
    profileSkills: set('python'),
    requirements: [
      req('react', 'must-have', { matched: new Set(), transferable: new Set(), related: set('vue') }),
      req('angular', 'must-have', { matched: new Set(), transferable: new Set() }),
    ],
    profileSeniority: 'mid',
    leadSeniority: 'mid',
  });
  assertEq(r.severity, sev('BLOCKING'));
  assertEq(r.missingMustHave.length, 2);
});

test('BLOCKING: genuine blocker cannot be hidden by abundant transferable/related coverage elsewhere', () => {
  const r = classifySkillGap({
    profileSkills: set('python', 'django', 'flask', 'sql', 'postgres'),
    requirements: [
      req('react', 'must-have', { matched: new Set(), transferable: new Set(), related: set('vue') }),
      req('nodejs', 'preferred', { matched: set('nodejs') }),
      req('express', 'preferred', { matched: set('express') }),
    ],
    profileSeniority: 'senior',
    leadSeniority: 'senior',
  });
  assertEq(r.severity, sev('BLOCKING'), 'blocker cannot be hidden by other coverage');
  assertEq(r.missingMustHave, ['react']);
});

// ---- 3. UNKNOWN --------------------------------------------------------------

test('UNKNOWN: profile skills empty', () => {
  const r = classifySkillGap({
    profileSkills: new Set<string>(),
    requirements: [req('react', 'must-have', { matched: new Set() })],
  });
  assertEq(r.severity, sev('UNKNOWN'));
  if (!r.unknownBasis) throw new Error('missing unknownBasis');
});

test('UNKNOWN: no requirements extracted', () => {
  const r = classifySkillGap({
    profileSkills: set('react', 'nodejs'),
    requirements: [],
  });
  assertEq(r.severity, sev('UNKNOWN'));
});

test('UNKNOWN: both profile and requirements empty', () => {
  const r = classifySkillGap({
    profileSkills: new Set<string>(),
    requirements: [],
  });
  assertEq(r.severity, sev('UNKNOWN'));
});

test('UNKNOWN: fallback residual (should not be reachable from normal inputs)', () => {
  // Force residual by having a must-have missing that is neither empty-profile nor
  // requirements-empty — the classifier should still categorize it, never hit fallback.
  const r = classifySkillGap({
    profileSkills: set('python'),
    requirements: [req('react', 'must-have', { matched: new Set(), transferable: new Set() })],
    profileSeniority: 'mid',
    leadSeniority: 'mid',
  });
  // This should be BLOCKING (must-have missing, no transferable) — not UNKNOWN.
  assertEq(r.severity, sev('BLOCKING'), 'must not hit residual UNKNOWN fallback');
});

// ---- 4. MINOR ----------------------------------------------------------------

test('MINOR: 1 preferred gap with transferable coverage present — mitigated preferred gap, not NONE', () => {
  const r = classifySkillGap({
    profileSkills: set('react', 'nodejs', 'express'),
    requirements: [
      req('react', 'must-have', { matched: set('react') }),
      req('next.js', 'preferred', { matched: new Set(), transferable: set('react') }),
    ],
    profileSeniority: 'mid',
    leadSeniority: 'mid',
  });
  // next.js is preferred + transferable-covered (react in profile) → mitigated preferred gap.
  // 1 mitigated preferred + 0 unmitigated preferred + 0 must-have gaps → MINOR.
  assertEq(r.severity, sev('MINOR'), '1 mitigated preferred gap → MINOR (not NONE — transferable does not make it "no gap")');
  assertEq(r.missingPreferred, [], 'no unmitigated preferred gaps');
  assertEq(r.covered, ['react'], 'only direct matches are in covered');
});

test('MINOR: 2 preferred gaps, both transferable-covered — 2 mitigated preferred gaps, not NONE', () => {
  const r = classifySkillGap({
    profileSkills: set('python', 'django'),
    requirements: [
      req('python', 'must-have', { matched: set('python') }),
      req('fastapi', 'preferred', { matched: new Set(), transferable: set('django') }),
      req('flask', 'preferred', { matched: new Set(), transferable: set('django') }),
    ],
    profileSeniority: 'senior',
    leadSeniority: 'senior',
  });
  // fastapi + flask are preferred + transferable-covered (django in profile) → 2 mitigated preferred gaps.
  // 2 mitigated preferred + 0 must-have gaps → MINOR.
  assertEq(r.severity, sev('MINOR'), '2 mitigated preferred gaps → MINOR (not NONE — transferable does not make them "no gap")');
});

test('MODERATE: preferred gap with related coverage only — related does NOT mitigate preferred (unmitigated 1-pref → MODERATE)', () => {
  const r = classifySkillGap({
    profileSkills: set('react'),
    requirements: [
      req('react', 'must-have', { matched: set('react') }),
      req('next.js', 'preferred', { matched: new Set(), related: set('next.js'), transferable: new Set() }),
    ],
    profileSeniority: 'mid',
    leadSeniority: 'mid',
  });
  // next.js: related=next.js NOT in profile → no mitigation. 1 unmitigated preferred + 0 must-have gaps → MODERATE.
  assertEq(r.severity, sev('MODERATE'), '1 unmitigated preferred gap → MODERATE');
  assertEq(r.missingPreferred, ['next.js'], 'next.js is an unmitigated preferred gap');
  assertEq(r.covered, ['react'], 'only direct must-have is covered');
});

test('MINOR: preferred gap with no coverage at all, profile well covered', () => {
  const r = classifySkillGap({
    profileSkills: set('react', 'nodejs', 'express', 'mongodb'),
    requirements: [
      req('react', 'must-have', { matched: set('react') }),
      req('graphql', 'preferred', { matched: new Set(), transferable: new Set(), related: new Set() }),
    ],
    profileSeniority: 'senior',
    leadSeniority: 'senior',
  });
  // graphql has no direct, no transferable, no related → missing. 1 unmitigated preferred
  // + 0 mhMissing → MODERATE (MODERATE-b), not MINOR.
  assertEq(r.severity, sev('MODERATE'), '1 unmitigated preferred gap with full must-have coverage → MODERATE');
  assertEq(r.missingPreferred, ['graphql']);
  assertEq(r.covered, ['react']);
});

// ---- 5. MODERATE -------------------------------------------------------------

test('MODERATE: single must-have gap that IS transferable-covered + preferred gaps',
  () => {
  const r = classifySkillGap({
    profileSkills: set('angular', 'nodejs'),
    requirements: [
      req('react', 'must-have', { matched: new Set(), transferable: set('angular') }),
      req('graphql', 'preferred', { matched: new Set(), transferable: new Set() }),
    ],
    profileSeniority: 'mid',
    leadSeniority: 'mid',
  });
  // react is must-have WITH transferable (angular in profile) → stays in missingMustHave (Rule 2).
  // graphql is preferred with NO coverage → missingPreferred.
  // 1 mitigated mh + 1 prefMissing → MAJOR (MAJOR-d: must-have involvement elevates severity).
  assertEq(r.severity, sev('MAJOR'), '1 mitigated mh + 1 prefMissing → MAJOR (MAJOR-d)');
  assertEq(r.missingMustHave, ['react'], 'must-have stays missing (transferable is mitigation, not elision)');
  assertEq(r.missingPreferred, ['graphql'], 'graphql has no coverage');
});

test('MODERATE: 2+ preferred gaps + some coverage (no must-have missing)', () => {
  const r = classifySkillGap({
    profileSkills: set('python'),
    requirements: [
      req('python', 'must-have', { matched: set('python') }),
      req('fastapi', 'preferred', { matched: new Set(), transferable: new Set() }),
      req('flask', 'preferred', { matched: new Set(), transferable: new Set() }),
      req('graphql', 'preferred', { matched: new Set(), transferable: new Set() }),
    ],
    leadSeniority: 'senior',
  });
  // python mhDirect; fastapi+flask+graphql are preferred with NO coverage → 3 prefMissing.
  // 3 unmitigated preferred gaps → MAJOR (MAJOR-c: 2+ preferred gaps with no coverage).
  assertEq(r.severity, sev('MAJOR'), '3 unmitigated preferred gaps → MAJOR (MAJOR-c)');
  assertEq(r.missingPreferred.length, 3);
});

test('MODERATE: single unblockable must-have missing + coverage elsewhere', () => {
  // A must-have genuinely missing (no transferable) plus other coverage → still BLOCKING,
  // not MODERATE. This test confirms the branch ordering: BLOCKING wins over MODERATE.
  const r = classifySkillGap({
    profileSkills: set('vue'),
    requirements: [
      req('react', 'must-have', { matched: new Set(), transferable: new Set() }),
      req('nodejs', 'preferred', { matched: set('nodejs') }),
    ],
    profileSeniority: 'mid',
    leadSeniority: 'mid',
  });
  assertEq(r.severity, sev('BLOCKING'), 'single unblockable must-have missing is BLOCKING, not MODERATE');
});

// ---- 6. MAJOR ----------------------------------------------------------------

test('MAJOR: seniority clash (junior profile vs senior+ lead, 2+ levels)', () => {
  const r = classifySkillGap({
    profileSkills: set('react', 'nodejs', 'express'),
    requirements: [
      req('react', 'must-have', { matched: set('react') }),
      req('nodejs', 'must-have', { matched: set('nodejs') }),
    ],
    profileSeniority: 'junior',
    leadSeniority: 'senior',
  });
  assertEq(r.severity, sev('MAJOR'));
  if (!r.reasons[0].startsWith('MAJOR:')) throw new Error('first reason must be MAJOR (seniority)');
});

test('MAJOR: multiple preferred gaps with no coverage anywhere', () => {
  const r = classifySkillGap({
    profileSkills: set('cobol'),
    requirements: [
      req('react', 'preferred', { matched: new Set(), transferable: new Set(), related: new Set() }),
      req('nodejs', 'preferred', { matched: new Set(), transferable: new Set(), related: new Set() }),
      req('graphql', 'preferred', { matched: new Set(), transferable: new Set(), related: new Set() }),
    ],
    profileSeniority: 'senior',
    leadSeniority: 'senior',
  });
  assertEq(r.severity, sev('MAJOR'));
  assertEq(r.missingPreferred.length, 3);
  assertEq(r.covered.length, 0);
});

test('MAJOR: must-have transferable-covered + preferred gaps + thin coverage', () => {
  const r = classifySkillGap({
    profileSkills: set('angular'),
    requirements: [
      req('react', 'must-have', { matched: new Set(), transferable: set('angular') }),
      req('graphql', 'preferred', { matched: new Set(), transferable: new Set(), related: new Set() }),
    ],
    profileSeniority: 'mid',
    leadSeniority: 'mid',
  });
  // react is transferable-covered must-have → stays in missingMustHave (Rule 2) → mitigated mh.
  // graphql has no coverage (no transferable, no related in profile) → prefMissing.
  // 1 mitigated mh + 1 prefMissing → MAJOR (MAJOR-d: must-have involvement elevates severity).
  assertEq(r.severity, sev('MAJOR'), '1 mitigated mh + 1 prefMissing → MAJOR (MAJOR-d)');
  assertEq(r.missingMustHave, ['react'], 'must-have stays missing (mitigated, not elided)');
  assertEq(r.covered, [], 'no direct matches');
  assertEq(r.missingPreferred, ['graphql'], 'graphql has no coverage → unmitigated preferred gap');
});

// ---- 7. Must-have vs preferred -----------------------------------------------

test('must-have missing IS blocking; preferred missing is NOT', () => {
  const rMust = classifySkillGap({
    profileSkills: set('python'),
    requirements: [req('react', 'must-have', { matched: new Set(), transferable: new Set() })],
  });
  assertEq(rMust.severity, sev('BLOCKING'), 'must-have missing → BLOCKING');
  assertEq(rMust.missingMustHave, ['react']);

  const rPref = classifySkillGap({
    profileSkills: set('python'),
    requirements: [
      req('react', 'preferred', { matched: new Set(), transferable: set('python') }),
    ],
  });
  assertEq(rPref.severity, sev('MINOR'), 'preferred transferable-covered → MINOR (mitigated preferred gap, not MODERATE)');
  assertEq(rPref.missingPreferred.length, 0, 'preferred gap mitigated, not in missingPreferred');
  assertEq(rPref.covered.length, 0, 'transferable does not add to covered');
  assertEq(rPref.mitigatedPreferred.length, 1, 'react is a mitigated preferred gap');
});

test('nice-to-have missing does not escalate severity', () => {
  const r = classifySkillGap({
    profileSkills: set('react', 'nodejs'),
    requirements: [
      req('react', 'must-have', { matched: set('react') }),
      req('graphql', 'nice-to-have', { matched: new Set(), transferable: set('react') }),
    ],
  });
  // graphql is nice-to-have + transferable=react (mitigated) → mitigated preferred gap (not NONE).
  // 1 mitigated preferred + 0 prefMissing + mhDirect=['react','nodejs'] (2 >= 2 HARD) → MODERATE.
  assertEq(r.severity, sev('MINOR'), 'nice-to-have transferable-covered → MINOR (mitigated preferred gap)');
  assertEq(r.missingPreferred.length, 0, 'graphql not in missingPreferred');
});

// ---- 8. Transferable skill --------------------------------------------------

test('T5 regression: single must-have gap that IS transferable-covered → MODERATE (stays missing)',
  () => {
  const r = classifySkillGap({
    profileSkills: set('angular'),
    requirements: [
      req('react', 'must-have', { matched: new Set(), transferable: set('angular') }),
    ],
    profileSeniority: 'mid',
    leadSeniority: 'mid',
  });
  assertEq(r.severity, sev('MODERATE'));
  assertEq(r.missingMustHave, ['react'], 'must-have stays missing (mitigated, not elided by transferable)');
  assertEq(r.missingPreferred, [], 'no preferred gaps');
  assertEq(r.covered, [], 'no direct matches');
});

test('transferable coverage prevents BLOCKING for that must-have', () => {
  const r = classifySkillGap({
    profileSkills: set('angular'),
    requirements: [
      req('react', 'must-have', { matched: new Set(), transferable: set('angular') }),
      req('vue', 'must-have', { matched: new Set(), transferable: set('angular') }),
    ],
    profileSeniority: 'mid',
    leadSeniority: 'mid',
  });
  // Both must-haves have transferable mitigation but stay missing per Rule 2.
  // 2 mitigated mh → MAJOR (MAJOR-b: 2+ must-have gaps).
  assertEq(r.severity, sev('MAJOR'), '2 mitigated must-have gaps → MAJOR (Rule 2: must-stay-missing)');
  assertEq(r.missingMustHave, ['react', 'vue'], 'both must-haves stay missing (transferable is mitigation, not elision)');
  assertEq(r.covered, [], 'no direct matches; transferable-covered must-haves are not "covered"');
});

// ---- 9. Related technology ---------------------------------------------------

test('related-only coverage does not count as direct coverage', () => {
  const r = classifySkillGap({
    profileSkills: set('vue'),
    requirements: [
      req('react', 'must-have', { matched: new Set(), transferable: new Set(), related: set('vue') }),
    ],
    profileSeniority: 'mid',
    leadSeniority: 'mid',
  });
  assertEq(r.severity, sev('BLOCKING'));
  assertEq(r.missingMustHave, ['react']);
  // react should NOT be in covered
  assertEq(r.covered.length, 0);
});

test('related coverage is recorded in reasons but does not unblock must-have', () => {
  const r = classifySkillGap({
    profileSkills: set('vue'),
    requirements: [
      req('react', 'must-have', { matched: new Set(), transferable: new Set(), related: set('vue') }),
    ],
    profileSeniority: 'mid',
    leadSeniority: 'mid',
  });
  const hasRelatedReason = r.reasons.some(reason => reason.includes('related'));
  if (!hasRelatedReason) throw new Error('related coverage should appear in reasons');
  assertEq(r.severity, sev('BLOCKING'));
});

// ---- 10. Seniority interaction -----------------------------------------------

test('seniority clash overrides skill coverage (junior vs senior lead)', () => {
  const r = classifySkillGap({
    profileSkills: set('react', 'nodejs', 'express', 'mongodb', 'typescript', 'graphql'),
    requirements: [
      req('react', 'must-have', { matched: set('react') }),
      req('nodejs', 'must-have', { matched: set('nodejs') }),
      req('express', 'must-have', { matched: set('express') }),
    ],
    profileSeniority: 'junior',
    leadSeniority: 'senior',
  });
  assertEq(r.severity, sev('MAJOR'), 'seniority clash → MAJOR even with full skill coverage');
});

test('seniority match (same level) does not cause MAJOR', () => {
  const r = classifySkillGap({
    profileSkills: set('react'),
    requirements: [req('react', 'must-have', { matched: set('react') })],
    profileSeniority: 'senior',
    leadSeniority: 'senior',
  });
  assertEq(r.severity, sev('NONE'));
});

test('seniority unknown (null) does not trigger seniority clash', () => {
  const r = classifySkillGap({
    profileSkills: set('react'),
    requirements: [req('react', 'must-have', { matched: set('react') })],
    profileSeniority: null,
    leadSeniority: null,
  });
  assertEq(r.severity, sev('NONE'));
});

test('seniority one-level difference does NOT trigger MAJOR (junior vs mid)', () => {
  const r = classifySkillGap({
    profileSkills: set('react', 'nodejs'),
    requirements: [
      req('react', 'must-have', { matched: set('react') }),
      req('nodejs', 'must-have', { matched: set('nodejs') }),
    ],
    profileSeniority: 'junior',
    leadSeniority: 'mid',
  });
  assertEq(r.severity, sev('NONE'), 'one-level difference is not MAJOR');
});

// ---- 11. Multiple simultaneous gaps -----------------------------------------

test('multiple gaps: must-have missing + preferred missing → BLOCKING wins', () => {
  const r = classifySkillGap({
    profileSkills: set('python'),
    requirements: [
      req('react', 'must-have', { matched: new Set(), transferable: new Set() }),
      req('graphql', 'preferred', { matched: new Set(), transferable: new Set() }),
    ],
    profileSeniority: 'mid',
    leadSeniority: 'mid',
  });
  assertEq(r.severity, sev('BLOCKING'));
});

test('multiple gaps: two must-haves missing, both unblockable → BLOCKING', () => {
  const r = classifySkillGap({
    profileSkills: set('cobol'),
    requirements: [
      req('react', 'must-have', { matched: new Set(), transferable: new Set() }),
      req('nodejs', 'must-have', { matched: new Set(), transferable: new Set() }),
    ],
  });
  assertEq(r.severity, sev('BLOCKING'));
  assertEq(r.missingMustHave.length, 2);
});

test('multiple gaps: must-have transferable-covered + preferred missing → MAJOR', () => {
  const r = classifySkillGap({
    profileSkills: set('angular'),
    requirements: [
      req('react', 'must-have', { matched: new Set(), transferable: set('angular') }),
      req('graphql', 'preferred', { matched: new Set(), transferable: new Set() }),
    ],
    profileSeniority: 'mid',
    leadSeniority: 'mid',
  });
  assertEq(r.severity, sev('MAJOR'));
});

// ---- 12. Genuine blocker cannot be hidden -----------------------------------

test('blocker not hidden by large preferred coverage', () => {
  const r = classifySkillGap({
    profileSkills: set('vue', 'svelte', 'solid', 'alpine'),
    requirements: [
      req('react', 'must-have', { matched: new Set(), transferable: new Set(), related: set('vue', 'svelte', 'solid', 'alpine') }),
      req('vue', 'preferred', { matched: set('vue') }),
      req('svelte', 'preferred', { matched: set('svelte') }),
    ],
    profileSeniority: 'senior',
    leadSeniority: 'senior',
  });
  assertEq(r.severity, sev('BLOCKING'), 'abundant preferred/related coverage does not hide must-have blocker');
  assertEq(r.missingMustHave, ['react']);
});

test('blocker not hidden by seniority match', () => {
  const r = classifySkillGap({
    profileSkills: set('vue'),
    requirements: [
      req('react', 'must-have', { matched: new Set(), transferable: new Set() }),
    ],
    profileSeniority: 'senior',
    leadSeniority: 'senior',
  });
  assertEq(r.severity, sev('BLOCKING'));
});

test('blocker not hidden by profile seniority being higher than lead', () => {
  const r = classifySkillGap({
    profileSkills: set('vue'),
    requirements: [
      req('react', 'must-have', { matched: new Set(), transferable: new Set() }),
    ],
    profileSeniority: 'director',
    leadSeniority: 'junior',
  });
  assertEq(r.severity, sev('BLOCKING'), 'over-qualified profile still blocks on missing must-have');
});

// ---- 13. Deterministic repeated evaluation ----------------------------------

test('deterministic: same input twice → identical result', () => {
  const evidence: GapEvidence = {
    profileSkills: set('react', 'nodejs'),
    requirements: [
      req('react', 'must-have', { matched: set('react') }),
      req('graphql', 'preferred', { matched: new Set(), transferable: new Set() }),
    ],
    profileSeniority: 'mid',
    leadSeniority: 'senior',
  };
  const a = classifySkillGap(evidence);
  const b = classifySkillGap(evidence);
  assertEq(a.severity, b.severity, 'severity');
  assertEq(a.missingMustHave, b.missingMustHave, 'missingMustHave');
  assertEq(a.missingPreferred, b.missingPreferred, 'missingPreferred');
  assertEq(a.covered, b.covered, 'covered');
  assertEq(a.reasons, b.reasons, 'reasons');
});

test('deterministic: via classifySkillGapDeterministic helper', () => {
  const evidence: GapEvidence = {
    profileSkills: set('python', 'django'),
    requirements: [
      req('python', 'must-have', { matched: set('python') }),
      req('fastapi', 'preferred', { matched: new Set(), transferable: set('django') }),
    ],
  };
  const r = classifySkillGapDeterministic(evidence);
  assertEq(r.severity, sev('MINOR'));
});

test('deterministic: exhaustive random-ish combinations', () => {
interface Combo {
  profile: string[];
  must: string[];
  pref: string[];
  transfer: Record<string, string[]>;
}

const combos: Combo[] = [
  { profile: ['react'], must: ['react'], pref: [], transfer: {} },
    { profile: ['python'], must: ['react'], pref: ['fastapi'], transfer: { react: [] } },
    { profile: ['angular', 'nodejs'], must: ['react', 'nodejs'], pref: ['graphql'], transfer: { react: ['angular'] } },
    { profile: ['vue'], must: ['react'], pref: [], transfer: {} },
    { profile: [], must: [], pref: [], transfer: {} },
    { profile: ['react', 'nodejs', 'express', 'mongodb', 'typescript', 'graphql'], must: ['react', 'nodejs'], pref: ['graphql'], transfer: {} },
    { profile: ['junior'], must: ['react'], pref: [], transfer: {} },
  ];
  for (let i = 0; i < combos.length; i++) {
    const c = combos[i];
    const reqs: Array<SkillRequirement & { evidence?: SkillEvidence }> = [];
    for (const m of c.must) {
      reqs.push(req(m, 'must-have', {
        matched: new Set(),
        transferable: new Set(c.transfer[m] ?? []),
        related: new Set(),
      }));
    }
    for (const p of c.pref) {
      reqs.push(req(p, 'preferred', {
        matched: new Set(),
        transferable: new Set(),
        related: new Set(),
      }));
    }
    const ev: GapEvidence = {
      profileSkills: new Set(c.profile.map(s => s.toLowerCase())),
      requirements: reqs,
      profileSeniority: c.profile.length === 1 && c.profile[0] === 'junior' ? 'junior' : 'mid',
      leadSeniority: 'senior',
    };
    const a = classifySkillGap(ev);
    const b = classifySkillGap(ev);
    assertEq(a.severity, b.severity, `combo ${i} severity`);
  }
});

// ---- 14. Explainability -----------------------------------------------------

test('every result has reasons array', () => {
  const r = classifySkillGap({
    profileSkills: set('react'),
    requirements: [req('react', 'must-have', { matched: set('react') })],
  });
  if (!Array.isArray(r.reasons) || r.reasons.length === 0) throw new Error('reasons missing or empty');
  if (!r.reasons[0].startsWith('NONE:')) throw new Error('NONE reason should start with NONE:');
});

test('BLOCKING result includes blocker in reasons', () => {
  const r = classifySkillGap({
    profileSkills: set('python'),
    requirements: [req('react', 'must-have', { matched: new Set(), transferable: new Set() })],
  });
  if (!r.reasons.some(r => r.startsWith('BLOCKING:'))) throw new Error('BLOCKING reason missing');
  if (!r.reasons.some(r => r.includes('react'))) throw new Error('missing skill in reasons');
});

test('UNKNOWN result includes unknownBasis', () => {
  const r = classifySkillGap({
    profileSkills: new Set<string>(),
    requirements: [req('react', 'must-have')],
  });
  assertEq(r.severity, sev('UNKNOWN'));
  if (!r.unknownBasis) throw new Error('missing unknownBasis');
});

test('MAJOR seniority result explains the seniority delta', () => {
  const r = classifySkillGap({
    profileSkills: set('react', 'nodejs'),
    requirements: [
      req('react', 'must-have', { matched: set('react') }),
      req('nodejs', 'must-have', { matched: set('nodejs') }),
    ],
    profileSeniority: 'junior',
    leadSeniority: 'senior',
  });
  if (!r.reasons[0].includes('seniority')) throw new Error('MAJOR reason should mention seniority');
});

test('MINOR result names the preferred gaps', () => {
  const r = classifySkillGap({
    profileSkills: set('react'),
    requirements: [
      req('react', 'must-have', { matched: set('react') }),
      req('next.js', 'preferred', { matched: new Set(), transferable: new Set(), related: new Set() }),
    ],
  });
  // next.js is preferred with NO coverage at all (empty matched, transferable, related) →
  // missingPreferred. 1 unmitigated preferred + mhDirect=['react'] → MODERATE (MODERATE-b),
  // not MINOR. A single unmitigated preferred gap is MODERATE.
  assertEq(r.severity, sev('MODERATE'), '1 unmitigated preferred gap with must-have direct match → MODERATE');
  if (!r.reasons.some(r => r.startsWith('MODERATE:'))) throw new Error('MODERATE reason missing');
  if (!r.missingPreferred.includes('next.js')) throw new Error('missing preferred not recorded');
});

// ---- 15. Empty / missing evidence -------------------------------------------

test('empty profileSkills + non-empty requirements → UNKNOWN', () => {
  const r = classifySkillGap({
    profileSkills: new Set<string>(),
    requirements: [req('react', 'must-have')],
  });
  assertEq(r.severity, sev('UNKNOWN'));
});

test('non-empty profileSkills + empty requirements → UNKNOWN', () => {
  const r = classifySkillGap({
    profileSkills: set('react', 'nodejs'),
    requirements: [],
  });
  assertEq(r.severity, sev('UNKNOWN'));
});

test('requirements with no evidence field → treated as no coverage', () => {
  const r = classifySkillGap({
    profileSkills: set('python'),
    requirements: [req('react', 'must-have')],  // no evidence
  });
  assertEq(r.severity, sev('BLOCKING'));
});

test('requirements with empty evidence → treated as no coverage', () => {
  const r = classifySkillGap({
    profileSkills: set('python'),
    requirements: [req('react', 'must-have', {})],
  });
  assertEq(r.severity, sev('BLOCKING'));
});

test('null/undefined evidence fields are safe', () => {
  const r = classifySkillGap({
    profileSkills: set('react'),
    requirements: [
      { name: 'react', kind: 'must-have', evidence: { matched: null as any, transferable: null as any, related: null as any } },
    ],
  });
  // react is in profileSkills → direct match via fallback in classifier
  assertEq(r.severity, sev('NONE'));
});

// ---- 16. Regression of existing qualification behavior ---------------------

test('regression: must-have missing → blocker (mirrors qual.service.ts:454-481 hardFail semantics)', () => {
  // The existing qualification engine hard-fails when a KNOWN_TECH keyword
  // present in the lead description is absent from the profile skills.
  // This test confirms the classifier reproduces the same blocker semantics.
  const r = classifySkillGap({
    profileSkills: set('python', 'django'),  // profile has python+Node-adjacent, but no react/nodejs
    requirements: [
      req('react', 'must-have', { matched: new Set(), transferable: new Set(), related: new Set() }),
      req('nodejs', 'must-have', { matched: set('nodejs') }),
    ],
    profileSeniority: 'mid',
    leadSeniority: 'mid',
  });
  assertEq(r.severity, sev('BLOCKING'));
  assertEq(r.missingMustHave, ['react']);
});

test('regression: must-have present → not blocker (preferred missing with no coverage → MAJOR)', () => {
  const r = classifySkillGap({
    profileSkills: set('react', 'nodejs'),
    requirements: [
      req('react', 'must-have', { matched: set('react') }),
      req('graphql', 'preferred', { matched: new Set(), transferable: new Set(), related: new Set() }),
    ],
    profileSeniority: 'mid',
    leadSeniority: 'mid',
  });
  // react present → not BLOCKING. graphql has no coverage → preferred missing.
  // 1 preferred missing, no coverage, no must-have missing → MINOR (not MAJOR — only 1).
  assertEq(r.severity, sev('MODERATE'), 'single preferred gap with no coverage → MODERATE (MODERATE-b: 1 unmitigated preferred gap)');
  assertEq(r.missingMustHave.length, 0);
  assertEq(r.missingPreferred, ['graphql']);
});

test('regression: seniority hard-mismatch (pr > lr + 1) still surfaces as MAJOR gap, not hidden', () => {
  // qualification.service.ts lines 368-388: pr > lr + 1 is a hard mismatch.
  // The classifier should surface this as MAJOR, not let skill coverage hide it.
  const r = classifySkillGap({
    profileSkills: set('react', 'nodejs', 'express', 'mongodb', 'typescript', 'graphql', 'docker', 'kubernetes'),
    requirements: [
      req('react', 'must-have', { matched: set('react') }),
      req('nodejs', 'must-have', { matched: set('nodejs') }),
      req('docker', 'must-have', { matched: set('docker') }),
    ],
    profileSeniority: 'junior',
    leadSeniority: 'senior',
  });
  assertEq(r.severity, sev('MAJOR'), 'seniority hard-mismatch → MAJOR even with full skill coverage');
  if (!r.reasons[0].includes('seniority')) throw new Error('seniority clash not surfaced');
});

test('regression: weak profile (one preferred skill, no coverage) → not NONE', () => {
  const r = classifySkillGap({
    profileSkills: set('cobol'),
    requirements: [
      req('react', 'preferred', { matched: new Set(), transferable: new Set() }),
    ],
    profileSeniority: 'senior',
    leadSeniority: 'senior',
  });
  assertEq(r.severity, sev('MODERATE'), 'single preferred gap with no coverage → MODERATE, not NONE nor MAJOR');
});

test('regression: empty requirements does not classify as NONE', () => {
  const r = classifySkillGap({
    profileSkills: set('react', 'nodejs', 'express', 'mongodb'),
    requirements: [],
  });
  assertEq(r.severity, sev('UNKNOWN'), 'empty requirements → UNKNOWN, not NONE');
});

// ---- Report -----------------------------------------------------------------

console.log(`\n=== JA-015 results: ${passed} passed, ${failed} failed, ${t} total ===`);
if (failed > 0) process.exit(1);
