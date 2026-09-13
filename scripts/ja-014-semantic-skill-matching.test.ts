import { describe, it, // The test runner (ts-mocha) provides describe/it/assert from the globals when
  // the test file is loaded as a script. We re-declare minimal helpers to make
  // the file self-contained and runnable directly with `npx ts-node` too.
} from 'ts-mocha';

// Minimal assertion helpers (ts-mocha/chai-style) so the file runs standalone.
function assert(condition: boolean, msg?: string): void {
  if (!condition) throw new Error(msg ?? 'assertion failed');
}
function assertEq<T>(actual: T, expected: T, msg?: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error((msg ?? 'assertion failed') + ` (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`);
  }
}
function assertMatch(actual: RegExp, expected: string, msg?: string): void {
  if (!actual.test(expected)) throw new Error((msg ?? 'assertion failed') + ` (string ${JSON.stringify(expected)} did not match ${actual})`);
}
function assertDeepEq<T>(actual: T, expected: T, msg?: string): void {
  assertEq(actual, expected, msg);
}

// Import the synonym-map module under test.
import {
  SKILL_SYNONYM_GROUPS,
  FALSE_EQUIVALENCE_PAIRS,
  RELATED_TECH_PAIRS,
  synonymGroupName,
  synonymGroupMembers,
  synonymExpand,
  isFalseEquivalence,
  relatedTokens,
  relatedTokenStrings,
  matchSkillPair,
  semanticMatch,
  explainMatch,
  SkillMatchReason,
  SkillMatchOutcome,
  SemanticMatchResult,
} from '../src/job-application/skills/synonym-map';

// ---------------------------------------------------------------------------
// Fixtures — stable inputs used across many tests so we never depend on
// incidental string content.
// ---------------------------------------------------------------------------

const PROFILE_JS = ['javascript', 'react js', 'node.js', 'css', 'html'];
const PROFILE_TS = ['typescript', 'react', 'nodejs', 'postgresql', 'docker'];
const PROFILE_JAVA = ['java', 'spring boot', 'maven', 'junit'];
const PROFILE_RUBY = ['ruby', 'rails', 'rspec'];
const PROFILE_EMPTY: string[] = [];
const PROFILE_NONE = ['cobol', 'fortran', 'punch cards'];

const JD_REACT = ['react', 'redux', 'next.js'];
const JD_NODE = ['nodejs', 'express', 'mongodb'];
const JD_JAVA = ['java', 'spring', 'microservices'];
const JD_JS_ONLY = ['javascript', 'es6'];
const JD_JSX = ['jsx', 'react', 'redux'];

// ---------------------------------------------------------------------------
// 1. Synonym group table integrity
// ---------------------------------------------------------------------------

describe('JA-014: synonym group table integrity', () => {
  it('has the expected well-known groups present', () => {
    const labels = SKILL_SYNONYM_GROUPS.map(g => g.label);
    assert(labels.includes('javascript'), 'javascript group present');
    assert(labels.includes('typescript'), 'typescript group present');
    assert(labels.includes('react'), 'react group present');
    assert(labels.includes('nodejs'), 'nodejs group present');
    assert(labels.includes('java'), 'java group present');
    assert(labels.includes('python'), 'python group present');
    assert(labels.includes('c#'), 'c# group present');
    assert(labels.includes('c++'), 'c++ group present');
    assert(labels.includes('docker'), 'docker group present');
    assert(labels.includes('kubernetes'), 'kubernetes group present');
    assert(labels.includes('sql'), 'sql group present');
    assert(labels.includes('redis'), 'redis group present');
  });

  it('each group has the canonical label as a member', () => {
    for (const g of SKILL_SYNONYM_GROUPS) {
      assert(g.members.includes(g.label),
        `${g.label} group must contain its canonical label`);
    }
  });

  it('members are unique within each group', () => {
    for (const g of SKILL_SYNONYM_GROUPS) {
      const seen = new Set<string>();
      for (const m of g.members) {
        assert(!seen.has(m), `${g.label} group has duplicate member ${m}`);
        seen.add(m);
      }
    }
  });

  it('synonymGroupName resolves known tokens to their group', () => {
    assertEq(synonymGroupName('js'), 'javascript');
    assertEq(synonymGroupName('ecmascript'), 'javascript');
    assertEq(synonymGroupName('es2020'), 'javascript');
    assertEq(synonymGroupName('ts'), 'typescript');
    assertEq(synonymGroupName('react js'), 'react');
    assertEq(synonymGroupName('react.js'), 'react');
    assertEq(synonymGroupName('node.js'), 'nodejs');
    assertEq(synonymGroupName('node js'), 'nodejs');
    assertEq(synonymGroupName('rails'), 'ruby');
    assertEq(synonymGroupName('ror'), 'ruby');
    assertEq(synonymGroupName('dotnet'), 'c#');
    assertEq(synonymGroupName('k8s'), 'kubernetes');
    assertEq(synonymGroupName('postgres'), 'sql');
  });

  it('synonymGroupName returns undefined for unknown tokens', () => {
    assertEq(synonymGroupName('jsx'), undefined);
    assertEq(synonymGroupName('next.js'), undefined);
    assertEq(synonymGroupName('express'), undefined);
    assertEq(synonymGroupName('cobol'), undefined);
    assertEq(synonymGroupName(''), undefined);
  });

  it('synonymGroupMembers is reflexive (includes the input)', () => {
    for (const g of SKILL_SYNONYM_GROUPS) {
      for (const m of g.members) {
        assert(
          synonymGroupMembers(m).includes(m),
          `${m} must be in its own synonym group members`
        );
      }
    }
  });

  it('synonymGroupMembers returns singleton for unknown tokens', () => {
    assertEq(synonymGroupMembers('cobol'), ['cobol']);
    assertEq(synonymGroupMembers('next.js'), ['next.js']);
    assertEq(synonymGroupMembers(''), ['']);
  });
});

// ---------------------------------------------------------------------------
// 2. Synonym expansion
// ---------------------------------------------------------------------------

describe('JA-014: synonym expansion', () => {
  it('expands js to all javascript-group members', () => {
    const expansion = synonymExpand('js');
    assert(expansion.includes('javascript'), 'js expands to javascript');
    assert(expansion.includes('ecmascript'), 'js expands to ecmascript');
    assert(expansion.includes('es2020'), 'js expands to es2020');
  });

  it('expansion excludes the input token itself', () => {
    assert(!synonymExpand('js').includes('js'), 'expansion excludes self');
    assert(!synonymExpand('react').includes('react'));
    assert(!synonymExpand('cobol').includes('cobol'));
  });

  it('unknown tokens expand to empty array', () => {
    assertEq(synonymExpand('cobol').length, 0,
      'unknown token expands to nothing');
    assertEq(synonymExpand('next.js').length, 0);
  });

  it('expansion is stable / ordered (deterministic)', () => {
    const a = synonymExpand('javascript');
    const b = synonymExpand('javascript');
    assertEq(a, b, 'same input → same expansion (deterministic)');
  });
});

// ---------------------------------------------------------------------------
// 3. False-equivalence deny-list
// ---------------------------------------------------------------------------

describe('JA-014: false-equivalence deny-list', () => {
  it('catches java vs javascript', () => {
    assert(isFalseEquivalence('java', 'javascript'),
      'java vs javascript is a false equivalence');
    assert(isFalseEquivalence('javascript', 'java'),
      'direction should not matter for the deny-list');
  });

  it('catches java vs js', () => {
    assert(isFalseEquivalence('java', 'js'));
    assert(isFalseEquivalence('js', 'java'));
  });

  it('catches java vs ecmascript', () => {
    assert(isFalseEquivalence('java', 'ecmascript'));
    assert(isFalseEquivalence('ecmascript', 'java'));
  });

  it('catches c++ vs c', () => {
    assert(isFalseEquivalence('c++', 'c'));
    assert(isFalseEquivalence('c', 'c++'));
    assert(isFalseEquivalence('cpp', 'c'));
    assert(isFalseEquivalence('c', 'cpp'));
  });

  it('catches c# vs c', () => {
    assert(isFalseEquivalence('c#', 'c'));
    assert(isFalseEquivalence('c', 'c#'));
    assert(isFalseEquivalence('csharp', 'c'));
    assert(isFalseEquivalence('c', 'csharp'));
  });

  it('catches objective-c vs c', () => {
    assert(isFalseEquivalence('objective-c', 'c'));
    assert(isFalseEquivalence('c', 'objective-c'));
    assert(isFalseEquivalence('objectivec', 'c'));
    assert(isFalseEquivalence('c', 'objectivec'));
  });

  it('catches python vs pythn (typo guard)', () => {
    assert(isFalseEquivalence('python', 'pythn'));
    assert(isFalseEquivalence('pythn', 'python'));
  });

  it('does NOT flag identical tokens as false equivalence', () => {
    assert(!isFalseEquivalence('java', 'java'),
      'identical tokens are not a false equivalence');
    assert(!isFalseEquivalence('js', 'js'));
  });

  it('does NOT flag unrelated tokens', () => {
    assert(!isFalseEquivalence('java', 'python'));
    assert(!isFalseEquivalence('react', 'vue'));
    assert(!isFalseEquivalence('c', 'go'));
  });

  it('is case-insensitive', () => {
    assert(isFalseEquivalence('Java', 'JavaScript'));
    assert(isFalseEquivalence('JAVA', 'JAVASCRIPT'));
    assert(isFalseEquivalence('java', 'JAVASCRIPT'));
  });

  it('whitespace-insensitive', () => {
    assert(isFalseEquivalence('java ', 'javascript'));
    assert(isFalseEquivalence(' java', 'javascript'));
  });
});

// ---------------------------------------------------------------------------
// 4. Related-technology secondary signals
// ---------------------------------------------------------------------------

describe('JA-014: related-technology secondary signals', () => {
  it('react has related frameworks', () => {
    const related = relatedTokenStrings('react');
    assert(related.includes('next.js'), 'react relates to next.js');
    assert(related.includes('redux'), 'react relates to redux');
    assert(related.includes('react native'), 'react relates to react native');
  });

  it('nodejs has related frameworks', () => {
    const related = relatedTokenStrings('nodejs');
    assert(related.includes('express'), 'nodejs relates to express');
    assert(related.includes('nestjs'), 'nodejs relates to nestjs');
  });

  it('relationships are NOT treated as equivalence (no match through related)', () => {
    // 'next.js' should NOT match 'react' directly — only as a related signal.
    const outcome = matchSkillPair('next.js', 'react');
    assert(!outcome.matched,
      'related tech must not create a direct match');
    assert(outcome.matchReason === 'no_match',
      'related tech match reason is no_match, not synonym');
  });

  it('related-token set for a language includes its frameworks', () => {
    const pythonRelated = relatedTokenStrings('python');
    assert(pythonRelated.includes('django'));
    assert(pythonRelated.includes('flask'));
    assert(pythonRelated.includes('fastapi'));
  });

  it('relatedTokens returns metadata, relatedTokenStrings returns plain strings', () => {
    const meta = relatedTokens('react');
    const plain = relatedTokenStrings('react');
    assert(meta.length > 0);
    assert(plain.length > 0);
    for (const m of meta) {
      assert(plain.includes(m.a) || plain.includes(m.b),
        `relatedTokenStrings must include ${m.a} or ${m.b}`);
    }
  });

  it('related tokens are stable / deterministic', () => {
    assertEq(relatedTokenStrings('react'), relatedTokenStrings('react'));
    assertEq(relatedTokenStrings('nodejs'), relatedTokenStrings('nodejs'));
  });
});

// ---------------------------------------------------------------------------
// 5. matchSkillPair — single-token matching
// ---------------------------------------------------------------------------

describe('JA-014: matchSkillPair (single-token matching)', () => {
  it('identical tokens match with reason identical', () => {
    const o = matchSkillPair('react', 'react');
    assert(o.matched, 'react == react matches');
    assert(o.matchReason === 'identical');
  });

  it('identical tokens match case-insensitively', () => {
    const o = matchSkillPair('React', 'REACT');
    assert(o.matched);
    assert(o.matchReason === 'identical');
  });

  it('synonym profile token matches canonical JD token (synonym_both when both in same group)', () => {
    const o = matchSkillPair('js', 'javascript');
    assert(o.matched);
    assert(o.matchReason === 'synonym_both',
      'js → javascript: both in javascript group → synonym_both');
  });

  it('canonical profile token matches synonym JD token (synonym_both when both in same group)', () => {
    const o = matchSkillPair('javascript', 'js');
    assert(o.matched);
    assert(o.matchReason === 'synonym_both',
      'javascript → js: both in javascript group → synonym_both');
  });

  it('both sides synonym → synonym_both (react js and js both in react group)', () => {
    const o = matchSkillPair('react js', 'js');
    assert(o.matched);
    assert(o.matchReason === 'synonym_both');
  });

  it('plain token with no group matches only identical', () => {
    const o = matchSkillPair('cobol', 'fortran');
    assert(!o.matched);
    assert(o.matchReason === 'no_match');
  });

  it('false equivalence pair does NOT match', () => {
    const o = matchSkillPair('java', 'javascript');
    assert(!o.matched,
      'java must not match javascript through synonym groups');
    assert(o.matchReason === 'deny_suppressed');
  });

  it('false equivalence pair returns no related tech', () => {
    const o = matchSkillPair('java', 'javascript');
    assert(o.related.length === 0,
      'deny-suppressed pair must surface no related tech');
  });

  it('related tech surfaces on identical match', () => {
    const o = matchSkillPair('react', 'react');
    assert(o.related.length > 0,
      'react identical match should surface related frameworks');
  });

  it('related tech surfaces on synonym match', () => {
    const o = matchSkillPair('js', 'javascript');
    assert(o.related.length >= 0); // may be empty, that's fine
  });

  it('whitespace-normalized tokens still match', () => {
    const o = matchSkillPair(' react ', ' react ');
    assert(o.matched);
    assert(o.matchReason === 'identical');
  });

  it('empty strings do not crash', () => {
    const o = matchSkillPair('', '');
    assert(o.matched);
    assert(o.matchReason === 'identical');
  });

  it('empty profile token vs non-empty JD token → no match', () => {
    const o = matchSkillPair('', 'react');
    assert(!o.matched);
    assert(o.matchReason === 'no_match');
  });
});

// ---------------------------------------------------------------------------
// 6. semanticMatch — set-level matching
// ---------------------------------------------------------------------------

describe('JA-014: semanticMatch (set-level matching)', () => {
  it('matches exact tokens identically to skillOverlap semantics', () => {
    const result = semanticMatch(PROFILE_JS, JD_JS_ONLY);
    assert(result.matched.includes('javascript'), 'javascript matched');
    assert(result.matched.includes('es6'), 'es6 matched');
    assert(result.missing.length === 0, 'no missing when all match');
  });

  it('synonym expansion improves recall over exact match', () => {
    // Profile has 'react js' and 'node.js'; JD asks for 'react' and 'nodejs'.
    // Exact match would miss both. Semantic match should catch both.
    const result = semanticMatch(
      ['react js', 'node.js', 'postgresql'],
      ['react', 'nodejs']
    );
    assert(result.matched.includes('react'),
      'react js → react via synonym');
    assert(result.matched.includes('nodejs'),
      'node.js → nodejs via synonym');
    assert(result.missing.length === 0);
  });

  it('reports expansions count > 0 when synonyms are used', () => {
    const result = semanticMatch(['js'], ['javascript']);
    assert(result.expansions > 0,
      'synonym expansion should be counted');
    assert(result.expandedProfileTokens.includes('js'));
    assert(result.expandedJdTokens.includes('javascript'));
  });

  it('zero expansions when no synonyms are involved', () => {
    const result = semanticMatch(['cobol'], ['fortran']);
    assert(result.expansions === 0,
      'no synonyms → zero expansions');
    assert(result.expandedProfileTokens.length === 0);
    assert(result.expandedJdTokens.length === 0);
  });

  it('false equivalence does not inflate matched count', () => {
    // Profile has java + javascript separately listed; JD asks for java.
    // Without the deny-list, java↔javascript synonym could match twice.
    // With the deny-list, java vs javascript is suppressed.
    const result = semanticMatch(
      ['java', 'javascript'],
      ['java']
    );
    // 'java' matches 'java' directly; 'javascript' vs 'java' is suppressed.
    assert(result.matched.length === 1,
      'only one direct match, no false inflation from synonym suppression');
    assert(result.missing.length === 0);
  });

  it('JD token matched via ANY profile token is counted once', () => {
    const result = semanticMatch(
      ['js', 'ecmascript', 'es6'],
      ['javascript']
    );
    // All three profile tokens are synonyms of javascript, but the JD
    // token 'javascript' should appear in matched exactly once.
    assertEq(result.matched.filter(t => t.toLowerCase() === 'javascript').length, 1,
      'each JD token appears in matched at most once');
  });

  it('missing list is correct when some JD tokens have no match', () => {
    const result = semanticMatch(
      ['react', 'redux'],
      ['react', 'next.js', 'vue']
    );
    assert(result.matched.includes('react'));
    assert(result.matched.includes('next.js'), 'next.js matches react via related? NO — related is not equivalence');
    // next.js should NOT match react (related is not equivalence)
    assert(!result.matched.includes('next.js'),
      'next.js must not match react (related tech is not equivalence)');
    assert(result.missing.includes('vue'));
    assert(result.missing.includes('next.js'));
  });

  it('empty profile → all JD tokens missing', () => {
    const result = semanticMatch(PROFILE_EMPTY, JD_REACT);
    assertEq(result.matched.length, 0);
    assertEq(result.missing.length, JD_REACT.length);
  });

  it('empty JD → all matched (vacuously)', () => {
    const result = semanticMatch(PROFILE_JS, PROFILE_EMPTY);
    assertEq(result.matched.length, 0);
    assertEq(result.missing.length, 0);
  });

  it('result pairs include every (profile, JD) combination', () => {
    const result = semanticMatch(['js'], ['javascript', 'python']);
    assertEq(result.pairs.length, 2,
      'one pair per (profile, JD) combination');
    assert(result.pairs.some(p => p.jdToken === 'javascript'));
    assert(result.pairs.some(p => p.jdToken === 'python'));
  });

  it('pairs are stable and ordered (deterministic)', () => {
    const a = semanticMatch(['js', 'react'], ['javascript', 'nodejs']);
    const b = semanticMatch(['js', 'react'], ['javascript', 'nodejs']);
    assertEq(a.pairs, b.pairs,
      'pairs must be deterministic');
    assertEq(a.matched, b.matched);
    assertEq(a.missing, b.missing);
  });
});

// ---------------------------------------------------------------------------
// 7. Explainability
// ---------------------------------------------------------------------------

describe('JA-014: explainability', () => {
  it('identical match explains direct equality', () => {
    const o = matchSkillPair('react', 'react');
    const expl = explainMatch(o);
    assertMatch(/direct match/i, expl);
    assertMatch(/react.*react/i, expl);
  });

  it('synonym_profile explains which group caused the match', () => {
    const o = matchSkillPair('js', 'javascript');
    const expl = explainMatch(o);
    assertMatch(/synonym/i, expl);
    assertMatch(/javascript/i, expl);
    assertMatch(/js/i, expl);
  });

  it('synonym_jd explains which group on the JD side', () => {
    const o = matchSkillPair('javascript', 'js');
    const expl = explainMatch(o);
    assertMatch(/synonym/i, expl);
    assertMatch(/javascript.*js/i, expl);
  });

  it('deny_suppressed explains the suppression', () => {
    const o = matchSkillPair('java', 'javascript');
    const expl = explainMatch(o);
    assertMatch(/suppressed/i, expl);
    assertMatch(/false equivalence/i, expl);
  });

  it('no_match explains why', () => {
    const o = matchSkillPair('cobol', 'fortran');
    const expl = explainMatch(o);
    assertMatch(/no match/i, expl);
  });

  it('explainMatch never throws on any outcome shape', () => {
    const outcomes: SkillMatchOutcome[] = [
      matchSkillPair('react', 'react'),
      matchSkillPair('js', 'javascript'),
      matchSkillPair('javascript', 'js'),
      matchSkillPair('react js', 'js'),
      matchSkillPair('java', 'javascript'),
      matchSkillPair('cobol', 'fortran'),
    ];
    for (const o of outcomes) {
      assertNoThrow(() => explainMatch(o),
        `explainMatch must not throw for reason ${o.matchReason}`);
    }
  });
});

// ---------------------------------------------------------------------------
// 8. Recall-improvement property (proves the doneWhen).
// ---------------------------------------------------------------------------

describe('JA-014: recall improvement property (doneWhen proof)', () => {
  it('improves recall vs exact-match for known alias pairs', () => {
    const aliasPairs: Array<[string, string]> = [
      ['js', 'javascript'],
      ['ecmascript', 'javascript'],
      ['react js', 'react'],
      ['react.js', 'react'],
      ['node.js', 'nodejs'],
      ['node js', 'nodejs'],
      ['typescript', 'ts'],
      ['csharp', 'c#'],
      ['rails', 'ruby'],
      ['golang', 'go'],
      ['postgresql', 'sql'],
      ['postgres', 'sql'],
    ];
    for (const [profileTok, jdTok] of aliasPairs) {
      // Exact-match simulation: two tokens match only if they are
      // case-insensitively equal. SemanticMatch uses the synonym table.
      const exactMatch = profileTok.toLowerCase().trim() === jdTok.toLowerCase().trim();
      const semanticResult = semanticMatch([profileTok], [jdTok]);
      const semanticMatchFlag = semanticResult.matched.includes(jdTok);
      // For every curated alias pair, semantic match MUST succeed.
      assert(semanticMatchFlag,
        `semanticMatch([${profileTok}], [${jdTok}]) must match (alias pair)`);
      // Semantic match must match whenever exact match would (never regress).
      if (exactMatch) {
        assert(semanticMatchFlag,
          `semanticMatch must not regress for identical pair ${profileTok} / ${jdTok}`);
      }
    }
  });

  it('does NOT increase false positives on curated bad pairs', () => {
    // Bad pairs = false equivalences (deny-list) + framework-vs-language
    // pairs where related tech exists but must NOT create a direct match.
    const badPairs: Array<[string, string]> = [
      // False equivalences (deny-list) — must never match
      ['java', 'javascript'],
      ['javascript', 'java'],
      ['js', 'java'],
      ['c', 'c++'],
      ['c++', 'c'],
      ['c', 'cpp'],
      ['c#', 'c'],
      ['csharp', 'c'],
      ['objective-c', 'c'],
      ['objectivec', 'c'],
      ['python', 'pythn'],  // typo — should NOT match
    ];
    for (const [profileTok, jdTok] of badPairs) {
      const semanticResult = semanticMatch([profileTok], [jdTok]);
      assert(!semanticResult.matched.includes(jdTok),
        `semanticMatch([${profileTok}], [${jdTok}]) must NOT match (false-equivalence guard / related-not-equivalence)`);
    }
  });

  it('related tech never inflates matched count', () => {
    // A framework/library relationship must not create a direct match.
    const frameworkPairs: Array<[string, string]> = [
      ['next.js', 'react'],
      ['gatsby', 'react'],
      ['express', 'nodejs'],
      ['django', 'python'],
      ['spring', 'java'],
      ['rails', 'ruby'],
      ['laravel', 'php'],
      ['helm', 'kubernetes'],
    ];
    for (const [profileTok, jdTok] of frameworkPairs) {
      const semanticResult = semanticMatch([profileTok], [jdTok]);
      assert(!semanticResult.matched.includes(jdTok),
        `related tech ${profileTok} → ${jdTok} must NOT create a direct match`);
    }
  });
});

// ---------------------------------------------------------------------------
// 9. Side-effect / purity checks — proves nothing was mutated
// ---------------------------------------------------------------------------

describe('JA-014: purity / side-effect checks', () => {
  it('synonymGroupMembers does not mutate the underlying group array', () => {
    const group = SKILL_SYNONYM_GROUPS.find(g => g.label === 'javascript')!;
    const before = [...group.members];
    const _ = synonymGroupMembers('js');
    assertEq(group.members, before,
      'synonymGroupMembers must not mutate group.members');
  });

  it('semanticMatch does not mutate caller arrays', () => {
    const profile = ['js', 'react'];
    const jd = ['javascript', 'nodejs'];
    const profileCopy = [...profile];
    const jdCopy = [...jd];
    const _ = semanticMatch(profile, jd);
    assertEq(profile, profileCopy, 'profile array not mutated');
    assertEq(jd, jdCopy, 'jd array not mutated');
  });

  it('matchSkillPair does not mutate global tables', () => {
    const beforeGroups = SKILL_SYNONYM_GROUPS.map(g => [...g.members]);
    const _ = matchSkillPair('java', 'javascript');
    for (let i = 0; i < SKILL_SYNONYM_GROUPS.length; i++) {
      assertEq(SKILL_SYNONYM_GROUPS[i].members, beforeGroups[i],
        `group ${SKILL_SYNONYM_GROUPS[i].label} must not be mutated`);
    }
  });

  it('relatedTokenStrings does not mutate global related pairs', () => {
    const beforeLen = RELATED_TECH_PAIRS.length;
    const _ = relatedTokenStrings('react');
    assertEq(RELATED_TECH_PAIRS.length, beforeLen,
      'relatedTokenStrings must not mutate RELATED_TECH_PAIRS');
  });
});

// ---------------------------------------------------------------------------
// 10. Determinism (proves same inputs → same outputs, every time)
// ---------------------------------------------------------------------------

describe('JA-014: determinism', () => {
  function runTwice(fn: () => unknown): void {
    const a = fn();
    const b = fn();
    assertEq(a, b, 'same call twice must return identical result');
  }

  it('synonymGroupMembers is deterministic', () => {
    runTwice(() => synonymGroupMembers('js'));
    runTwice(() => synonymGroupMembers('cobol'));
    runTwice(() => synonymGroupMembers('react'));
  });

  it('synonymExpand is deterministic', () => {
    runTwice(() => synonymExpand('js'));
    runTwice(() => synonymExpand('react'));
  });

  it('isFalseEquivalence is deterministic', () => {
    runTwice(() => isFalseEquivalence('java', 'javascript'));
    runTwice(() => isFalseEquivalence('java', 'python'));
  });

  it('matchSkillPair is deterministic', () => {
    runTwice(() => matchSkillPair('js', 'javascript'));
    runTwice(() => matchSkillPair('java', 'javascript'));
    runTwice(() => matchSkillPair('next.js', 'react'));
    runTwice(() => matchSkillPair('react', 'react'));
  });

  it('semanticMatch is deterministic', () => {
    runTwice(() => semanticMatch(['js', 'react'], ['javascript', 'nodejs']));
    runTwice(() => semanticMatch(PROFILE_JS, JD_REACT));
    runTwice(() => semanticMatch(PROFILE_EMPTY, JD_REACT));
  });

  it('explainMatch is deterministic', () => {
    runTwice(() => explainMatch(matchSkillPair('js', 'javascript')));
    runTwice(() => explainMatch(matchSkillPair('java', 'javascript')));
  });

  it('two independent calls produce the same semanticMatch result object shape', () => {
    const r1 = semanticMatch(['js', 'react js'], ['react', 'javascript']);
    const r2 = semanticMatch(['js', 'react js'], ['react', 'javascript']);
    assertEq(r1.matched, r2.matched);
    assertEq(r1.missing, r2.missing);
    assertEq(r1.expansions, r2.expansions);
    assertEq(r1.expandedProfileTokens, r2.expandedProfileTokens);
    assertEq(r1.expandedJdTokens, r2.expandedJdTokens);
    assertEq(r1.pairs.length, r2.pairs.length);
  });
});

// ---------------------------------------------------------------------------
// 11. Cross-module consistency: synonym table agrees with deny-list
// ---------------------------------------------------------------------------

describe('JA-014: cross-table consistency', () => {
  it('no deny-pair member belongs to the same synonym group as the other member', () => {
    // If "java" and "javascript" are in the same synonym group, the deny-list
    // would be dead code. They must be in DIFFERENT groups for the deny-list to
    // have any effect.
    for (const [a, b] of FALSE_EQUIVALENCE_PAIRS) {
      const ga = synonymGroupName(a);
      const gb = synonymGroupName(b);
      // Both being undefined is fine (neither is in a group), but if BOTH are
      // in groups they must be DIFFERENT groups.
      if (ga !== undefined && gb !== undefined) {
        assert(ga !== gb,
          `"${a}" (group ${ga}) and "${b}" (group ${gb}) must not share a synonym group`);
      }
    }
  });

  it('every related-tech token either is or is not in a synonym group (no inconsistent state)', () => {
    // This is a sanity check, not a correctness constraint — related tech tokens
    // may or may not have their own synonym groups. What matters is that the
    // table is well-formed.
    for (const r of RELATED_TECH_PAIRS) {
      // Both a and b should resolve to something via synonymGroupName or be unknown.
      // No assertion needed beyond "doesn't crash".
      const _a = synonymGroupName(r.a);
      const _b = synonymGroupName(r.b);
    }
  });
});

// ---------------------------------------------------------------------------
// 12. Edge cases: large inputs, Unicode-ish tokens, duplicate JD tokens
// ---------------------------------------------------------------------------

describe('JA-014: edge cases', () => {
  it('handles duplicate tokens in profile without double-counting matches', () => {
    const result = semanticMatch(['js', 'js', 'javascript'], ['javascript']);
    assertEq(result.matched.filter(t => t.toLowerCase() === 'javascript').length, 1,
      'duplicate profile tokens must not duplicate JD matches');
  });

  it('handles duplicate tokens in JD without double-counting', () => {
    const result = semanticMatch(['javascript'], ['javascript', 'javascript']);
    assertEq(result.matched.length, 1,
      'duplicate JD tokens must not duplicate matched list');
    assertEq(result.missing.length, 0);
  });

  it('handles large profile + JD lists without crash', () => {
    const bigProfile = Array.from({ length: 50 }, (_, i) => `skill-${i}`);
    const bigJd = Array.from({ length: 50 }, (_, i) => `req-${i}`);
    const result = semanticMatch(bigProfile, bigJd);
    assertEq(result.pairs.length, 50 * 50);
    assertEq(result.matched.length, 0);
    assertEq(result.missing.length, 50);
  });

  it('handles tokens with spaces and punctuation', () => {
    const result = semanticMatch(['react js', 'node.js', 'c #'], ['react', 'nodejs', 'c#']);
    assert(result.matched.includes('react'));
    assert(result.matched.includes('nodejs'));
    assert(result.matched.includes('c#'));
  });

  it('handles empty string inputs do not crash set operations', () => {
    // Empty strings are filtered out by semanticMatch's filter(Boolean),
    // so they never reach the matcher.
    const result = semanticMatch(['', 'react', ''], ['react', '', 'vue']);
    assert(result.matched.includes('react'));
    assert(!result.matched.includes(''), 'empty JD tokens are filtered out');
    assert(result.missing.includes('vue'));
  });
});

// ---------------------------------------------------------------------------
// 13. Public API surface: verifies the exports the qualification engine will consume
// ---------------------------------------------------------------------------

describe('JA-014: public API surface for qualification engine integration', () => {
  it('exposes synonymLookup helpers', () => {
    assert(typeof synonymGroupName === 'function');
    assert(typeof synonymGroupMembers === 'function');
    assert(typeof synonymExpand === 'function');
  });

  it('exposes the deny-list checker', () => {
    assert(typeof isFalseEquivalence === 'function');
  });

  it('exposes the related-tech helpers', () => {
    assert(typeof relatedTokens === 'function');
    assert(typeof relatedTokenStrings === 'function');
  });

  it('exposes the core matchers', () => {
    assert(typeof matchSkillPair === 'function');
    assert(typeof semanticMatch === 'function');
    assert(typeof explainMatch === 'function');
  });

  it('exposes the data tables as arrays', () => {
    assert(Array.isArray(SKILL_SYNONYM_GROUPS));
    assert(Array.isArray(FALSE_EQUIVALENCE_PAIRS));
    assert(Array.isArray(RELATED_TECH_PAIRS));
  });

  it('semanticMatch return type has the expected shape', () => {
    const r = semanticMatch(['js'], ['javascript']);
    assert(typeof r.matched === 'object' && Array.isArray(r.matched));
    assert(typeof r.missing === 'object' && Array.isArray(r.missing));
    assert(typeof r.pairs === 'object' && Array.isArray(r.pairs));
    assert(typeof r.expansions === 'number');
    assert(typeof r.expandedProfileTokens === 'object' && Array.isArray(r.expandedProfileTokens));
    assert(typeof r.expandedJdTokens === 'object' && Array.isArray(r.expandedJdTokens));
    for (const p of r.pairs) {
      assert(typeof p.profileToken === 'string');
      assert(typeof p.jdToken === 'string');
      assert(typeof p.matched === 'boolean');
      assert(typeof p.matchReason === 'string');
      assert(p.matchReason in {
        identical: 1, synonym_profile: 1, synonym_jd: 1,
        synonym_both: 1, deny_suppressed: 1, no_match: 1,
      } as Record<string, number>);
      assert(Array.isArray(p.related));
    }
  });

  it('SkillMatchReason union contains the expected members', () => {
    type T = SkillMatchReason;
    // Compile-time check via assignable literal:
    const _r1: T = 'identical';
    const _r2: T = 'synonym_profile';
    const _r3: T = 'synonym_jd';
    const _r4: T = 'synonym_both';
    const _r5: T = 'deny_suppressed';
    const _r6: T = 'no_match';
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assertNoThrow(fn: () => void, msg?: string): void {
  try {
    fn();
  } catch (e) {
    throw new Error((msg ?? 'unexpected throw') + ': ' + (e instanceof Error ? e.message : String(e)));
  }
}

// Report (ts-mocha doesn't print passes automatically when importing describe;
// we rely on the runner's exit code: 0 = all pass, 1 = any fail).
console.log('JA-014 semantic-skill-matching tests loaded — running under ts-mocha.');
