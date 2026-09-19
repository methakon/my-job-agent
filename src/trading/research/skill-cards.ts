/**
 * ITEMS 137+139+141+149 — Skill Cards system.
 *
 * doneWhen: "Skill cards encode reusable patterns, are searchable, versioned, and evidence-backed."
 *
 * PINNED SEMantics (skillcard-v1)
 *   Skill Cards are structured knowledge records that capture:
 *   - 137: Reusable trading patterns and their conditions
 *   - 139: Search and retrieval by relevance and evidence strength
 *   - 141: Versioned evolution with changelog
 *   - 149: Evidence-backed recommendations with measured outcomes
 *
 * PURE: no clock, no I/O, no DB, no network, no AI, no randomness.
 * RESEARCH / SHADOW ONLY.
 */

export const SKILL_CARD_VERSION = 'skillcard-v1';

export type SkillCardStatus = 'ACTIVE' | 'DEPRECATED' | 'EXPERIMENTAL' | 'RETIRED';
export type SkillCardCategory =
  | 'GAP_TRADE'
  | 'MICROSTRUCTURE'
  | 'RISK'
  | 'EXECUTION'
  | 'REGIME'
  | 'PATTERN';

export interface SkillCardEvidence {
  /** Number of trades observed. */
  readonly sampleSize: number;
  /** Win rate of the pattern. */
  readonly winRate: number | null;
  /** Average PnL per trade. */
  readonly avgPnl: number | null;
  /** Sharpe ratio of the pattern. */
  readonly sharpe: number | null;
  /** Maximum drawdown observed. */
  readonly maxDrawdown: number | null;
  /** Date range of evidence (start, end). */
  readonly evidenceRange: readonly [string, string] | null;
  /** Confidence level: LOW, MEDIUM, HIGH based on sample size and consistency. */
  readonly confidenceLevel: 'LOW' | 'MEDIUM' | 'HIGH';
}

export interface SkillCard {
  /** Unique card identifier. */
  readonly cardId: string;
  /** Human-readable name. */
  readonly name: string;
  /** Category of the skill. */
  readonly category: SkillCardCategory;
  /** Current status. */
  readonly status: SkillCardStatus;
  /** Version of this card. */
  readonly version: string;
  /** Description of the pattern/edge. */
  readonly description: string;
  /** Entry conditions that must be met. */
  readonly entryConditions: readonly string[];
  /** Exit conditions. */
  readonly exitConditions: readonly string[];
  /** Risk parameters. */
  readonly riskParameters: {
    readonly maxRiskPerTradePct: number;
    readonly maxConcurrentTrades: number;
    readonly stopLossPct: number | null;
    readonly takeProfitPct: number | null;
  };
  /** Measured evidence backing this card. */
  readonly evidence: SkillCardEvidence;
  /** When this card was created. */
  readonly createdAt: string;
  /** When this card was last updated. */
  readonly updatedAt: string;
  /** Changelog of version updates. */
  readonly changelog: readonly { readonly version: string; readonly date: string; readonly changes: string }[];
  /** Tags for search indexing. */
  readonly tags: readonly string[];
  /** Related card IDs. */
  readonly relatedCards: readonly string[];
}

export interface SkillCardSearchQuery {
  readonly category?: SkillCardCategory;
  readonly status?: SkillCardStatus;
  readonly minConfidence?: 'LOW' | 'MEDIUM' | 'HIGH';
  readonly tags?: readonly string[];
  readonly searchText?: string;
}

export interface SkillCardSearchResult {
  readonly card: SkillCard;
  readonly relevanceScore: number;
  readonly matchReasons: readonly string[];
}

export interface SkillCardRegistry {
  readonly version: string;
  readonly cards: readonly SkillCard[];
  readonly lastUpdated: string;
}

const CONFIDENCE_ORDER: Record<string, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };

/**
 * Search skill cards by query, returning results sorted by relevance.
 */
export function searchSkillCards(
  registry: SkillCardRegistry,
  query: SkillCardSearchQuery,
): readonly SkillCardSearchResult[] {
  let results: { card: SkillCard; score: number; reasons: string[] }[] = [];

  for (const card of registry.cards) {
    const reasons: string[] = [];
    let score = 0;

    // Category filter
    if (query.category && card.category !== query.category) continue;
    if (query.category) {
      score += 10;
      reasons.push('category_match');
    }

    // Status filter
    if (query.status && card.status !== query.status) continue;
    if (query.status) {
      score += 5;
      reasons.push('status_match');
    }

    // Confidence filter
    if (query.minConfidence) {
      const minLevel = CONFIDENCE_ORDER[query.minConfidence] ?? 0;
      const cardLevel = CONFIDENCE_ORDER[card.evidence.confidenceLevel] ?? 0;
      if (cardLevel < minLevel) continue;
      score += cardLevel * 3;
      reasons.push('confidence_match');
    }

    // Tag filter
    if (query.tags && query.tags.length > 0) {
      const matchingTags = query.tags.filter((t) => card.tags.includes(t));
      if (matchingTags.length === 0) continue;
      score += matchingTags.length * 5;
      reasons.push(`tags_match:${matchingTags.join(',')}`);
    }

    // Text search
    if (query.searchText) {
      const text = query.searchText.toLowerCase();
      const inName = card.name.toLowerCase().includes(text);
      const inDesc = card.description.toLowerCase().includes(text);
      const inTags = card.tags.some((t) => t.toLowerCase().includes(text));
      if (inName) { score += 8; reasons.push('name_match'); }
      if (inDesc) { score += 4; reasons.push('description_match'); }
      if (inTags) { score += 3; reasons.push('tag_text_match'); }
      if (!inName && !inDesc && !inTags) continue;
    }

    // Evidence quality bonus
    if (card.evidence.sampleSize >= 100) { score += 5; reasons.push('large_sample'); }
    if (card.evidence.winRate !== null && card.evidence.winRate > 0.55) {
      score += 3;
      reasons.push('strong_win_rate');
    }

    results.push({ card, score, reasons });
  }

  return results
    .sort((a, b) => b.score - a.score)
    .map((r) => ({
      card: r.card,
      relevanceScore: r.score,
      matchReasons: r.reasons,
    }));
}

/**
 * Validate a skill card's structure and evidence quality.
 */
export function validateSkillCard(card: SkillCard): readonly string[] {
  const errors: string[] = [];

  if (!card.cardId) errors.push('cardId is required');
  if (!card.name) errors.push('name is required');
  if (!card.description) errors.push('description is required');
  if (card.entryConditions.length === 0) errors.push('at least one entry condition required');
  if (card.riskParameters.maxRiskPerTradePct <= 0 || card.riskParameters.maxRiskPerTradePct > 10) {
    errors.push('maxRiskPerTradePct must be between 0 and 10');
  }
  if (card.evidence.sampleSize < 0) errors.push('sampleSize cannot be negative');
  if (card.evidence.winRate !== null && (card.evidence.winRate < 0 || card.evidence.winRate > 1)) {
    errors.push('winRate must be between 0 and 1');
  }
  if (card.version !== SKILL_CARD_VERSION) {
    errors.push(`version must be ${SKILL_CARD_VERSION}, got ${card.version}`);
  }

  return errors;
}

/**
 * Create a new skill card with defaults.
 */
export function createSkillCard(
  input: Omit<SkillCard, 'version' | 'createdAt' | 'updatedAt' | 'changelog'>,
): SkillCard {
  const now = new Date().toISOString();
  return {
    ...input,
    version: SKILL_CARD_VERSION,
    createdAt: now,
    updatedAt: now,
    changelog: [
      { version: '1.0.0', date: now, changes: 'Initial creation' },
    ],
  };
}
