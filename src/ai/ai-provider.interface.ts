/**
 * AI provider abstraction used by the Hermes integration.
 * AiTestController -> AiService -> AiRoutingService -> AI_PROVIDER -> BedrockProvider.
 */

export const AI_PROVIDER = Symbol('AI_PROVIDER');

export type AiTaskType =
  | 'general'
  | 'coding'
  | 'code_review'
  | 'quant_research'
  | 'trading_research'
  | 'reasoning'
  | 'reflexion';

export interface AiRequest {
  /** The user prompt. Must be a non-empty string. Content is not restricted. */
  prompt: string;

  /**
   * Optional Hermes task classification used by AiRoutingService.
   * Defaults to 'general' when not supplied by the caller.
   */
  taskType?: AiTaskType;

  /**
   * Optional Hermes model registry key for explicit model selection.
   * Example: hermes.qwen.coder.default
   */
  modelKey?: string;

  /**
   * Optional explicit provider model ID override.
   * Example: qwen.qwen3-coder-next
   */
  modelId?: string;

  /** Optional system prompt. */
  systemPrompt?: string;

  /** Optional positive-integer cap on output tokens. */
  maxTokens?: number;

  /** Optional sampling temperature in [0, 1]. */
  temperature?: number;
}

export interface AiResponse {
  /** Generated text (may be an empty string for a valid empty completion). */
  text: string;

  /** Model that actually served the request. */
  modelId: string;

  inputTokens?: number;
  outputTokens?: number;

  /** Round-trip latency in milliseconds. */
  latencyMs: number;

  /** Provider implementation name, e.g. 'bedrock'. */
  provider?: string;

  /**
   * Optional cost ESTIMATE (USD).
   * null = pricing unverified/unknown —
   * never a fabricated number.
   * Not a billing statement.
   */
  estimatedInputCost?: number | null;
  estimatedOutputCost?: number | null;
  estimatedTotalCost?: number | null;

  /**
   * Pricing config version that produced the estimate;
   * null when the model is not in the registry.
   */
  pricingVersion?: string | null;

  /**
   * Routing metadata for audit and transparency.
   * Contains the decision route selected by AiRoutingService.
   * LLM identity is derived from this metadata, NOT the LLM response.
   */
  routingMetadata?: {
    routingPolicyVersion: string;
    hermesModelKey: string;
    selectedModelKey: string;
    selectedProvider: string;
    selectedModelId: string;
    selectedModelTier: string;
    selectedModelExperimental: boolean;
  };
}

export interface AiProvider {
  generate(request: AiRequest): Promise<AiResponse>;
}