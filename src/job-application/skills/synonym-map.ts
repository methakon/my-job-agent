/**
 * JA-014 — Semantic skill matching
 *
 * doneWhen: "Recall improves without materially increasing false-positive skill
 * matches."
 *
 * Pure deterministic synonym/alias/relationship table + matcher. No embeddings,
 * no ML, no AI, no I/O, no randomness. Same inputs → same output, every time.
 *
 * Two-layer design:
 *  1. SYNONYM/ALIAS table — explicit equivalence groups. A token in any member
 *     of a group matches a token in any other member. Used to expand BOTH the
 *     profile-skill side and the JD-required-skill side before set intersection,
 *     so "react js"/"react"/"javascript" all intersect.
 *  2. RELATED-TECHNOLOGY table — secondary relationships (framework/library
 *     ecosystem). A relationship is NOT equivalence: it never turns a non-match
 *     into a direct match, but it surfaces as a "related" tag so the caller can
 *     weight it as a secondary signal. This is what keeps false positives down
 *     while still improving recall for genuine near-misses.
 *
 * FALSE-EQUIVALENCE DENY-LIST — explicit pairs that must NEVER be treated as
 * synonyms no matter what the allow-list says. This is the safety rail that
 * prevents "Java vs JavaScript" and similar traps. The deny-list is checked
 * BEFORE any synonym expansion; if both tokens appear together in a deny pair,
 * synonym expansion is suppressed for that pair.
 *
 * Explainability: every expansion records which synonym/alias/relationship
 * caused it, so the caller can trace a match back to the original token and
 * the rule that expanded it.
 *
 * Never modifies JA-012 (jd-intent), JA-013 (candidate-evidence),
 * qualification.service.ts logic, trading code, seed content, .env,
 * DB config, or submission paths (JA-002).
 */

// ---------------------------------------------------------------------------
// 1. Synonym / alias groups (explicit equivalence — deterministic lookup)
// ---------------------------------------------------------------------------

/** One equivalence group: every member is treated as interchangeable with the others. */
export interface SynonymGroup {
  /** Canonical label for the group (used in notes / explainability). */
  label: string;
  /** All members, including the canonical label. Order is stable. */
  members: string[];
}

/**
 * Explicit synonym/alias groups for common software-skill naming variation.
 *
 * These are HAND-CURATED, auditable, and deliberately narrow. Each group
 * captures genuine naming variation for the SAME underlying skill, not a
 * fuzzy similarity. "React" and "React.js" are the same skill; "Java" and
 * "JavaScript" are NOT — that is enforced by the deny-list, not by omission
 * from this table.
 *
 * Expandability: to add a new group, add one entry here. To remove, delete
 * one entry. No code change elsewhere is required.
 */
export const SKILL_SYNONYM_GROUPS: SynonymGroup[] = [
  // --- JavaScript ecosystem ---
  {
    label: 'javascript',
    members: ['javascript', 'js', 'ecmascript', 'es6', 'es2015', 'es2016', 'es2017', 'es2018', 'es2019', 'es2020', 'es2021', 'es2022', 'es2023', 'es2024'],
  },
  {
    label: 'typescript',
    members: ['typescript', 'ts'],
  },
  {
    label: 'react',
    members: ['react', 'reactjs', 'react.js', 'react js', 'react javascript'],
  },
  {
    label: 'nodejs',
    members: ['nodejs', 'node.js', 'node js', 'node'],
  },
  {
    label: 'html',
    members: ['html', 'html5', 'html 5'],
  },
  {
    label: 'css',
    members: ['css', 'css3', 'css 3'],
  },
  {
    label: 'sql',
    members: ['sql', 'mysql', 'postgresql', 'postgres', 't-sql', 'tsql', 'plsql'],
  },
  {
    label: 'java',
    members: ['java', 'jdk', 'jvm'],
  },
  {
    label: 'python',
    members: ['python', 'py'],
  },
  {
    label: 'c#',
    members: ['c#', 'csharp', '.net', '.net framework', '.net core', 'dotnet', 'c #'],
  },
  {
    label: 'c++',
    members: ['c++', 'cpp', 'c plus plus'],
  },
  {
    label: 'objective-c',
    members: ['objective-c', 'objectivec', 'objc'],
  },
  {
    label: 'swift',
    members: ['swift', 'swiftui'],
  },
  {
    label: 'kotlin',
    members: ['kotlin', 'kotlin multiplatform', 'kotlin mp'],
  },
  {
    label: 'go',
    members: ['go', 'golang'],
  },
  {
    label: 'rust',
    members: ['rust', 'rustlang'],
  },
  {
    label: 'ruby',
    members: ['ruby', 'rb'],
  },
  {
    label: 'rails',
    members: ['rails', 'ruby on rails', 'ror'],
  },
  {
    label: 'php',
    members: ['php', 'php3', 'php4', 'php5', 'php7', 'php8'],
  },
  {
    label: 'scala',
    members: ['scala', 'scala native', 'scala js'],
  },
  {
    label: 'shell',
    members: ['shell', 'bash', 'sh', 'zsh', 'shell scripting', 'unix shell'],
  },
  {
    label: 'powershell',
    members: ['powershell', 'pwsh', 'powershell core'],
  },
  {
    label: 'docker',
    members: ['docker', 'dockerfile', 'containerization', 'containers'],
  },
  {
    label: 'kubernetes',
    members: ['kubernetes', 'k8s', 'k8'],
  },
  {
    label: 'aws',
    members: ['aws', 'amazon web services'],
  },
  {
    label: 'azure',
    members: ['azure', 'microsoft azure'],
  },
  {
    label: 'gcp',
    members: ['gcp', 'google cloud', 'google cloud platform'],
  },
  {
    label: 'terraform',
    members: ['terraform', 'infrastructure as code', 'iac'],
  },
  {
    label: 'git',
    members: ['git', 'git version control', 'version control'],
  },
  {
    label: 'linux',
    members: ['linux', 'unix', 'posix'],
  },
  {
    label: 'rest',
    members: ['rest', 'rest api', 'restful', 'restful api'],
  },
  {
    label: 'graphql',
    members: ['graphql', 'gql'],
  },
  {
    label: 'grpc',
    members: ['grpc', 'grpc protobuf', 'gRPC'],
  },
  {
    label: 'mongodb',
    members: ['mongodb', 'mongo'],
  },
  {
    label: 'redis',
    members: ['redis', 'key-value store', 'key value store'],
  },
  {
    label: 'elasticsearch',
    members: ['elasticsearch', 'elasticsearch engine', 'elastic search'],
  },
  {
    label: 'jenkins',
    members: ['jenkins', 'ci', 'continuous integration'],
  },
  {
    label: 'github actions',
    members: ['github actions', 'gh actions', 'github workflows'],
  },
  {
    label: 'agile',
    members: ['agile', 'scrum', 'kanban'],
  },
];

// ---------------------------------------------------------------------------
// 2. False-equivalence deny-list (checked BEFORE synonym expansion)
// ---------------------------------------------------------------------------

/**
 * Pairs of tokens that must NEVER be treated as synonyms.
 *
 * If a profile skill and a JD skill are both present as a deny-pair, synonym
 * expansion is suppressed for that pair — they are compared as raw literals
 * and do NOT match unless they are literally identical.
 *
 * This is the safety rail that prevents "Java vs JavaScript", "C vs C++",
 * "JS vs Java", etc. from becoming false matches through aggressive synonym
 * expansion.
 */
export const FALSE_EQUIVALENCE_PAIRS: [string, string][] = [
  ['java', 'javascript'],
  ['java', 'js'],
  ['java', 'ecmascript'],
  ['javascript', 'java'],
  ['js', 'java'],
  ['ecmascript', 'java'],
  ['c++', 'c'],
  ['cpp', 'c'],
  ['c', 'c++'],
  ['c', 'cpp'],
  ['c#', 'c'],
  ['csharp', 'c'],
  ['c', 'c#'],
  ['c', 'csharp'],
  ['objective-c', 'c'],
  ['objectivec', 'c'],
  ['c', 'objective-c'],
  ['c', 'objectivec'],
  ['python', 'pythn'],
];

// ---------------------------------------------------------------------------
// 3. Related-technology relationships (secondary signal, NOT equivalence)
// ---------------------------------------------------------------------------

/** A directed relationship: `a` is related to `b` (e.g. a framework atop a language). */
export interface RelatedTech {
  /** The broader / base technology. */
  a: string;
  /** The narrower / framework / library that relates to `a`. */
  b: string;
  /** Human-readable relationship label for explainability. */
  relation: string;
}

/**
 * Explicit related-technology pairs. These are NOT equivalence groups:
 * a relationship never turns a non-match into a direct match. It is surfaced
 * as a "related" tag so the caller (qualification engine, evidence tracer)
 * can weight it as a secondary signal without inflating the primary match count.
 *
 * Direction matters: "next.js" relates to "react", but "react" does not imply
 * "next.js" — so the relationship is recorded in the direction that is true.
 * For symmetric lookup we store both directions with the SAME relation label.
 */
export const RELATED_TECH_PAIRS: RelatedTech[] = [
  { a: 'react', b: 'next.js', relation: 'React-based framework' },
  { a: 'react', b: 'nextjs', relation: 'React-based framework' },
  { a: 'react', b: 'remix', relation: 'React-based framework' },
  { a: 'react', b: 'gatsby', relation: 'React-based framework' },
  { a: 'react', b: 'react native', relation: 'React-based mobile framework' },
  { a: 'react', b: 'reactnative', relation: 'React-based mobile framework' },
  { a: 'react', b: 'redux', relation: 'React state management library' },
  { a: 'react', b: 'mobx', relation: 'React state management library' },
  { a: 'react', b: 'react router', relation: 'React routing library' },
  { a: 'angular', b: 'angularjs', relation: 'Angular (AngularJS is the legacy 1.x version)' },
  { a: 'angular', b: 'ng', relation: 'Angular shorthand' },
  { a: 'vue', b: 'vue.js', relation: 'Vue.js' },
  { a: 'vue', b: 'nuxt', relation: 'Vue-based framework' },
  { a: 'vue', b: 'nuxt.js', relation: 'Vue-based framework' },
  { a: 'vue', b: 'vuex', relation: 'Vue state management library' },
  { a: 'vue', b: 'pinia', relation: 'Vue state management library' },
  { a: 'vue', b: 'vue router', relation: 'Vue routing library' },
  { a: 'svelte', b: 'sveltekit', relation: 'Svelte-based framework' },
  { a: 'svelte', b: 'svelte kit', relation: 'Svelte-based framework' },
  { a: 'nodejs', b: 'express', relation: 'Node.js web framework' },
  { a: 'nodejs', b: 'express.js', relation: 'Node.js web framework' },
  { a: 'nodejs', b: 'fastify', relation: 'Node.js web framework' },
  { a: 'nodejs', b: 'nestjs', relation: 'Node.js / TypeScript framework' },
  { a: 'nodejs', b: 'nest js', relation: 'Node.js / TypeScript framework' },
  { a: 'nodejs', b: 'koa', relation: 'Node.js web framework' },
  { a: 'python', b: 'django', relation: 'Python web framework' },
  { a: 'python', b: 'flask', relation: 'Python web framework' },
  { a: 'python', b: 'fastapi', relation: 'Python web framework' },
  { a: 'python', b: 'pytorch', relation: 'Python ML framework' },
  { a: 'python', b: 'tensorflow', relation: 'Python ML framework' },
  { a: 'python', b: 'pandas', relation: 'Python data library' },
  { a: 'python', b: 'numpy', relation: 'Python data library' },
  { a: 'java', b: 'spring', relation: 'Java framework' },
  { a: 'java', b: 'spring boot', relation: 'Java framework' },
  { a: 'java', b: 'jakarta ee', relation: 'Java enterprise edition' },
  { a: 'c#', b: 'asp.net', relation: '.NET web framework' },
  { a: 'c#', b: 'asp.net core', relation: '.NET web framework' },
  { a: 'c#', b: 'entity framework', relation: '.NET ORM' },
  { a: '.net', b: 'asp.net', relation: '.NET web framework' },
  { a: '.net', b: 'asp.net core', relation: '.NET web framework' },
  { a: '.net', b: 'entity framework', relation: '.NET ORM' },
  { a: 'ruby', b: 'rails', relation: 'Ruby web framework' },
  { a: 'ruby', b: 'ruby on rails', relation: 'Ruby web framework' },
  { a: 'php', b: 'laravel', relation: 'PHP web framework' },
  { a: 'php', b: 'symfony', relation: 'PHP web framework' },
  { a: 'php', b: 'codeigniter', relation: 'PHP web framework' },
  { a: 'go', b: 'gin', relation: 'Go web framework' },
  { a: 'go', b: 'echo', relation: 'Go web framework' },
  { a: 'go', b: 'fiber', relation: 'Go web framework' },
  { a: 'rust', b: 'actix', relation: 'Rust web framework' },
  { a: 'rust', b: 'axum', relation: 'Rust web framework' },
  { a: 'rust', b: 'rocket', relation: 'Rust web framework' },
  { a: 'docker', b: 'docker compose', relation: 'Docker orchestration tool' },
  { a: 'docker', b: 'docker-compose', relation: 'Docker orchestration tool' },
  { a: 'kubernetes', b: 'helm', relation: 'Kubernetes package manager' },
  { a: 'sql', b: 'mysql', relation: 'SQL dialect' },
  { a: 'sql', b: 'postgresql', relation: 'SQL dialect' },
  { a: 'sql', b: 'postgres', relation: 'SQL dialect' },
  { a: 'sql', b: 'sqlite', relation: 'SQL dialect' },
  { a: 'sql', b: 'oracle database', relation: 'SQL dialect' },
  { a: 'mongodb', b: 'mongo db', relation: 'MongoDB (alternate spelling)' },
  { a: 'elasticsearch', b: 'elastic', relation: 'Elasticsearch / Elastic stack' },
  { a: 'redis', b: 'redis cache', relation: 'Redis' },
  { a: 'graphql', b: 'apollo', relation: 'GraphQL client/server library' },
  { a: 'graphql', b: 'relay', relation: 'GraphQL client library' },
  { a: 'rest', b: 'http', relation: 'HTTP-based API' },
  { a: 'grpc', b: 'protobuf', relation: 'gRPC serialization format' },
  { a: 'git', b: 'github', relation: 'Git hosting platform' },
  { a: 'git', b: 'gitlab', relation: 'Git hosting platform' },
  { a: 'git', b: 'bitbucket', relation: 'Git hosting platform' },
  { a: 'linux', b: 'unix', relation: 'Unix-like operating system' },
  { a: 'linux', b: 'ubuntu', relation: 'Linux distribution' },
  { a: 'linux', b: 'debian', relation: 'Linux distribution' },
  { a: 'linux', b: 'centos', relation: 'Linux distribution' },
  { a: 'linux', b: 'red hat', relation: 'Linux distribution' },
  { a: 'linux', b: 'rhel', relation: 'Linux distribution' },
  { a: 'linux', b: 'fedora', relation: 'Linux distribution' },
  { a: 'linux', b: 'alpine', relation: 'Linux distribution' },
  { a: 'linux', b: 'arch linux', relation: 'Linux distribution' },
  { a: 'jenkins', b: 'ci/cd', relation: 'CI/CD' },
  { a: 'github actions', b: 'ci/cd', relation: 'CI/CD' },
];

// ---------------------------------------------------------------------------
// 4. Canonical build-time lookup tables (deterministic, pure)
// ---------------------------------------------------------------------------

/** All members → group label, for fast synonym-group lookup. Built once at module load. */
const SYNONYM_MEMBER_TO_GROUP: ReadonlyMap<string, string> = (() => {
  const m = new Map<string, string>();
  for (const g of SKILL_SYNONYM_GROUPS) {
    for (const mem of g.members) {
      if (!m.has(mem)) m.set(mem, g.label);
    }
  }
  return m;
})();

/** Membership query: is `token` a member of any synonym group? */
export function synonymGroupName(token: string): string | undefined {
  return SYNONYM_MEMBER_TO_GROUP.get(token);
}

/** All members of the synonym group that `token` belongs to, including `token` itself.
 *  Returns `[token]` (singleton) when `token` is not in any group. */
export function synonymGroupMembers(token: string): readonly string[] {
  const label = synonymGroupName(token);
  if (label === undefined) return [token];
  const g = SKILL_SYNONYM_GROUPS.find((g) => g.label === label);
  if (!g) return [token];
  return g.members;
}

/** Set of every token reachable from `token` via synonym expansion (excluding `token` itself). */
export function synonymExpand(token: string): readonly string[] {
  const label = synonymGroupName(token);
  if (label === undefined) return [];
  const g = SKILL_SYNONYM_GROUPS.find((g) => g.label === label);
  if (!g) return [];
  return g.members.filter((m) => m !== token);
}

/** All tokens reachable from `token` via the related-tech graph (one hop).
 *  These are NOT equivalence members — they are secondary "related" signals. */
export function relatedTokens(token: string): readonly RelatedTech[] {
  const t = token.toLowerCase().trim();
  const out: RelatedTech[] = [];
  for (const r of RELATED_TECH_PAIRS) {
    const al = r.a.toLowerCase().trim();
    const bl = r.b.toLowerCase().trim();
    if (al === t) out.push({ a: r.a, b: r.b, relation: r.relation });
    else if (bl === t) out.push({ a: r.b, b: r.a, relation: r.relation });
  }
  return out;
}

/** All tokens reachable from `token` via related-tech edges (one hop, both directions),
 *  as a flat set of strings (no metadata). Used for "related tag" expansion. */
export function relatedTokenStrings(token: string): readonly string[] {
  const out: string[] = [];
  for (const r of relatedTokens(token)) {
    if (!out.includes(r.a)) out.push(r.a);
    if (!out.includes(r.b)) out.push(r.b);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 4b. False-equivalence denials (checked BEFORE synonym expansion in the matcher)
// ---------------------------------------------------------------------------

/**
 * Returns true when `a` and `b` form a known false-equivalence pair and synonym
 * expansion must be suppressed for this pair.
 *
 * Checked BEFORE any synonym expansion in matchSkillPair, so that e.g.
 * "java" vs "javascript" never match through the "javascript"/"java" groups.
 */
export function isFalseEquivalence(a: string, b: string): boolean {
  const al = a.toLowerCase().trim();
  const bl = b.toLowerCase().trim();
  if (al === bl) return false; // identical tokens are not a "false equivalence" — handled earlier
  for (const [x, y] of FALSE_EQUIVALENCE_PAIRS) {
    const xl = x.toLowerCase().trim();
    const yl = y.toLowerCase().trim();
    if ((al === xl && bl === yl) || (al === yl && bl === xl)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// 5. Semantic skill matcher (pure, deterministic)
// ---------------------------------------------------------------------------

/** One match outcome between a profile-skill token and a JD-required-skill token. */
export interface SkillMatchOutcome {
  /** Profile-skill token (original, from the candidate profile). */
  profileToken: string;
  /** JD-required-skill token (original, from the job description). */
  jdToken: string;
  /** Whether the two tokens matched (directly or via synonym expansion). */
  matched: boolean;
  /** Why they matched — for explainability. */
  matchReason: SkillMatchReason;
  /** Related technologies surfaced for this pair (secondary signal, not a match). */
  related: readonly string[];
}

export type SkillMatchReason =
  | 'identical'                 // profileToken === jdToken (case-insensitive)
  | 'synonym_profile'          // profileToken expanded to include jdToken
  | 'synonym_jd'               // jdToken expanded to include profileToken
  | 'synonym_both'             // both expanded and intersected
  | 'deny_suppressed'          // a false-equivalence deny rule suppressed expansion
  | 'no_match';                // no expansion, no intersection

/**
 * Match a single profile-skill token against a single JD-required-skill token,
 * with synonym expansion, false-equivalence suppression, and related-tech
 * secondary signals. Pure and deterministic.
 */
export function matchSkillPair(profileToken: string, jdToken: string): SkillMatchOutcome {
  const p = profileToken.toLowerCase().trim();
  const j = jdToken.toLowerCase().trim();

  // Identical? done.
  if (p === j) {
    return {
      profileToken,
      jdToken,
      matched: true,
      matchReason: 'identical',
      related: relatedTokenStrings(p),
    };
  }

  // False-equivalence check: if these two tokens form a known bad pair,
  // suppress synonym expansion so they do NOT match through the synonym table.
  if (isFalseEquivalence(p, j)) {
    return {
      profileToken,
      jdToken,
      matched: false,
      matchReason: 'deny_suppressed',
      related: [],
    };
  }

  // Synonym expansion: expand profile side, JD side.
  const profileSyns = synonymGroupMembers(p);   // includes p itself
  const jdSyns = synonymGroupMembers(j);        // includes j itself

  // Does the profile's synonym set contain the JD token (or vice versa)?
  const profileCoversJd = profileSyns.some((s) => s.toLowerCase().trim() === j);
  const jdCoversProfile = jdSyns.some((s) => s.toLowerCase().trim() === p);

  // Related-tech secondary signals (do NOT count as a match).
  const related = [
    ...relatedTokenStrings(p),
    ...relatedTokenStrings(j),
  ].filter((s) => s.toLowerCase().trim() !== p && s.toLowerCase().trim() !== j);

  if (profileCoversJd && jdCoversProfile) {
    return {
      profileToken,
      jdToken,
      matched: true,
      matchReason: 'synonym_both',
      related,
    };
  }
  if (profileCoversJd) {
    return {
      profileToken,
      jdToken,
      matched: true,
      matchReason: 'synonym_profile',
      related,
    };
  }
  if (jdCoversProfile) {
    return {
      profileToken,
      jdToken,
      matched: true,
      matchReason: 'synonym_jd',
      related,
    };
  }

  return {
    profileToken,
    jdToken,
    matched: false,
    matchReason: 'no_match',
    related,
  };
}

/** Match a set of profile skills against a set of JD-required skills,
 *  returning matched JD tokens, missing JD tokens, and full per-pair outcomes
 *  for explainability. Pure and deterministic.
 *
 *  Duplicate JD tokens in the input produce a DEDUPLICATED matched list — each
 *  unique JD token appears at most once in `matched`, while `missing` preserves
 *  the original `jdRaw` order (including duplicates).
 */
export interface SemanticMatchResult {
  /** JD tokens that matched at least one profile token (deduplicated, original casing preserved). */
  matched: string[];
  /** JD tokens that did NOT match any profile token.
   *  Preserves the original `jdRaw` order; duplicates of missing tokens appear as duplicates. */
  missing: string[];
  /** Full per-pair outcome matrix for explainability. */
  pairs: SkillMatchOutcome[];
  /** Total number of profile-synonym expansions performed (for metrics/recall tracking). */
  expansions: number;
  /** Profile tokens that were expanded via synonym groups (distinct). */
  expandedProfileTokens: string[];
  /** JD tokens that were expanded via synonym groups (distinct). */
  expandedJdTokens: string[];
}

export function semanticMatch(
  profileSkills: string[],
  jdRequired: string[],
): SemanticMatchResult {
  const profileRaw = (profileSkills || []).map((s) => s.trim()).filter(Boolean);
  const jdRaw = (jdRequired || []).map((s) => s.trim()).filter(Boolean);

  const pairs: SkillMatchOutcome[] = [];
  const matchedSet = new Set<string>();
  const expandedProfileTokens: string[] = [];
  const expandedJdTokens: string[] = [];
  let expansions = 0;

  for (const p of profileRaw) {
    const pSyns = synonymGroupMembers(p);
    if (pSyns.length > 1) expandedProfileTokens.push(p);
    for (const j of jdRaw) {
      const jSyns = synonymGroupMembers(j);
      if (jSyns.length > 1) expandedJdTokens.push(j);
      const outcome = matchSkillPair(p, j);
      pairs.push(outcome);
      if (outcome.matched) {
        matchedSet.add(j.toLowerCase().trim());
      }
      // Count only actual synonym expansions (not identical matches, not deny_suppressed)
      if (outcome.matchReason === 'synonym_profile' || outcome.matchReason === 'synonym_jd' || outcome.matchReason === 'synonym_both') {
        expansions++;
      }
    }
  }

  // Build matched list: deduplicates by lowercase key, preserves first-seen original casing.
  // Build missing list: preserves original jdRaw order, includes duplicates of missing tokens.
  const matched: string[] = [];
  const missing: string[] = [];
  const seenInMatched = new Set<string>();
  for (const j of jdRaw) {
    const jKey = j.toLowerCase().trim();
    if (matchedSet.has(jKey)) {
      if (!seenInMatched.has(jKey)) {
        matched.push(j);
        seenInMatched.add(jKey);
      }
    } else {
      missing.push(j);
    }
  }

  return {
    matched,
    missing,
    pairs,
    expansions,
    expandedProfileTokens: [...new Set(expandedProfileTokens)],
    expandedJdTokens: [...new Set(expandedJdTokens)],
  };
}

// ---------------------------------------------------------------------------
// 6. Explainability helper — human-readable expansion trace for a matched pair
// ---------------------------------------------------------------------------

/** Explain why a matched pair matched, in plain language. */
export function explainMatch(outcome: SkillMatchOutcome): string {
  switch (outcome.matchReason) {
    case 'identical':
      return 'direct match: "' + outcome.profileToken + '" == "' + outcome.jdToken + '"';
    case 'synonym_profile':
      const pSyns = synonymGroupMembers(outcome.profileToken);
      return 'synonym: "' + outcome.profileToken + '" (member of "' + synonymGroupName(outcome.profileToken) + '" group: ' + pSyns.join(', ') + ') covers "' + outcome.jdToken + '"';
    case 'synonym_jd':
      const jSyns = synonymGroupMembers(outcome.jdToken);
      return 'synonym: "' + outcome.jdToken + '" (member of "' + synonymGroupName(outcome.jdToken) + '" group: ' + jSyns.join(', ') + ') covers "' + outcome.profileToken + '"';
    case 'synonym_both':
      const pSyns2 = synonymGroupMembers(outcome.profileToken);
      const jSyns2 = synonymGroupMembers(outcome.jdToken);
      return 'synonym both ways: "' + outcome.profileToken + '" (group: ' + synonymGroupName(outcome.profileToken) + ': ' + pSyns2.join(', ') + ') ↔ "' + outcome.jdToken + '" (group: ' + synonymGroupName(outcome.jdToken) + ': ' + jSyns2.join(', ') + ')';
    case 'deny_suppressed':
      return 'suppressed: "' + outcome.profileToken + '" and "' + outcome.jdToken + '" are a known false equivalence (synonym expansion disabled for this pair)';
    case 'no_match':
      return 'no match: "' + outcome.profileToken + '" and "' + outcome.jdToken + '" have no synonym/alias relationship and are not identical';
  }
}
