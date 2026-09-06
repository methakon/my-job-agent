/**
 * Deterministic AI cost estimation.
 *
 * This is an ESTIMATE only — never a billing statement. Pricing data lives
 * here, keyed by modelId, and stays separate from request-execution logic
 * in BedrockProvider. Unknown/unverified prices yield null — a fabricated
 * number is never produced.
 */

export interface AiPricingEntry {
  /** Identifies this pricing record; bump it whenever the prices below change. */
  pricingVersion: string;
  /** USD per 1,000 tokens; null = not verified/unknown. */
  inputUsdPer1k: number | null;
  /** USD per 1,000 tokens; null = not verified/unknown. */
  outputUsdPer1k: number | null;
  /** Provenance note (informational only, never rendered into API responses). */
  note?: string;
}

export type AiPricingRegistry = Readonly<Record<string, AiPricingEntry>>;

/**
 * Pricing registry for models this app calls through Bedrock.
 *
 * The currently configured model (preserved configuration) has an entry so
 * its pricing version is identifiable, but the AWS list price is NOT yet
 * verified here, so both prices stay null -> estimates return null instead
 * of inventing a cost. Update the two numbers from the AWS Bedrock price
 * list for qwen.qwen3-coder-30b-a3b-v1:0, then bump pricingVersion.
 */
export const AI_PRICING_REGISTRY: AiPricingRegistry = Object.freeze({
  'qwen.qwen3-coder-30b-a3b-v1:0': Object.freeze({
    pricingVersion: '2026-09-06-unverified',
    inputUsdPer1k: null,
    outputUsdPer1k: null,
    note: 'Unverified - update inputUsdPer1k/outputUsdPer1k from the AWS Bedrock price list, then bump pricingVersion.',
  }),
});

export interface AiCostEstimate {
  /** USD. */
  estimatedInputCost: number | null;
  /** USD. */
  estimatedOutputCost: number | null;
  /** USD (sum); null when either side is unknown. */
  estimatedTotalCost: number | null;
  /** Registry pricing version that produced this estimate; null when the model is not in the registry. */
  pricingVersion: string | null;
  currency: 'USD';
}

const round6 = (n: number): number => Math.round(n * 1_000_000) / 1_000_000;

/**
 * Pure, deterministic estimator. Identical inputs always yield identical
 * outputs (no randomness, no network). When the model has no registry entry,
 * or the entry's price is null, or token counts are absent, the estimate is
 * null — never a guessed number.
 */
export function estimateAiCost(input: {
  modelId: string;
  inputTokens?: number;
  outputTokens?: number;
  registry?: AiPricingRegistry;
}): AiCostEstimate {
  const registry = input.registry ?? AI_PRICING_REGISTRY;
  const entry = registry[input.modelId];

  if (!entry) {
    return {
      estimatedInputCost: null,
      estimatedOutputCost: null,
      estimatedTotalCost: null,
      pricingVersion: null,
      currency: 'USD',
    };
  }

  const { inputTokens, outputTokens } = input;
  const inputCost =
    entry.inputUsdPer1k === null || inputTokens === undefined
      ? null
      : round6((inputTokens * entry.inputUsdPer1k) / 1000);
  const outputCost =
    entry.outputUsdPer1k === null || outputTokens === undefined
      ? null
      : round6((outputTokens * entry.outputUsdPer1k) / 1000);
  const totalCost =
    inputCost === null || outputCost === null ? null : round6(inputCost + outputCost);

  return {
    estimatedInputCost: inputCost,
    estimatedOutputCost: outputCost,
    estimatedTotalCost: totalCost,
    pricingVersion: entry.pricingVersion,
    currency: 'USD',
  };
}
