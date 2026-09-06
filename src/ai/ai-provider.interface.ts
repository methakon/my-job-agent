/**
 * AI provider abstraction used by the Hermes integration.
 * AiTestController -> AiService -> AI_PROVIDER -> BedrockProvider.
 */

export const AI_PROVIDER = Symbol('AI_PROVIDER');

export interface AiRequest {
  /** The user prompt. Must be a non-empty string. Content is not restricted. */
  prompt: string;
  /** Optional explicit model override; falls back to HERMES_BEDROCK_MODEL_ID. */
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
   * Optional cost ESTIMATE (USD). null = pricing unverified/unknown —
   * never a fabricated number. Not a billing statement.
   */
  estimatedInputCost?: number | null;
  estimatedOutputCost?: number | null;
  estimatedTotalCost?: number | null;
  /** Pricing config version that produced the estimate; null when the model is not in the registry. */
  pricingVersion?: string | null;
}

export interface AiProvider {
  generate(request: AiRequest): Promise<AiResponse>;
}
