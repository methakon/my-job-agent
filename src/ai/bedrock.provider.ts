/**
 * BedrockProvider — hardened AWS Bedrock (Converse API) provider for the
 * Hermes AI integration.
 *
 * Flow: AiTestController -> AiService -> AI_PROVIDER -> BedrockProvider ->
 * AWS Bedrock Converse -> configured Qwen model.
 *
 * Hardening guarantees:
 *  - Model is taken from request.modelId or HERMES_BEDROCK_MODEL_ID; when
 *    neither is available the provider FAILS with a configuration error
 *    instead of silently switching to an unrelated model.
 *  - Credentials are never configured here — the SDK resolves the default
 *    credential chain (AWS_PROFILE, AWS_ACCESS_KEY_ID, ...) at request time.
 *  - Bounded, env-configurable timeout via a hard-deadline race (abort
 *    signal passed best-effort so the real SDK cancels the request).
 *  - Bounded retries ONLY for transient/retryable failures (throttling, 5xx,
 *    model timeouts, network blips), with exponential backoff + jitter.
 *    Auth/validation/invalid-model/unknown errors are never retried.
 *  - Logs carry safe metadata only: no credentials, secrets, full prompts or
 *    full responses.
 */

import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ConverseCommandOutput,
} from '@aws-sdk/client-bedrock-runtime';
import { Logger, Optional } from '@nestjs/common';
import {
  AiError,
  AiErrorCategory,
  classifyBedrockError,
  errName,
  httpStatus,
} from './ai-errors';
import { estimateAiCost, AI_PRICING_REGISTRY } from './ai-pricing';
import type { AiProvider, AiRequest, AiResponse } from './ai-provider.interface';

/** Structural send-capable client (real BedrockRuntimeClient or a test fake). */
export interface BedrockClientLike {
  send(
    command: ConverseCommand,
    options?: { abortSignal?: AbortSignal },
  ): Promise<ConverseCommandOutput>;
}

/** Minimal logger surface (Nest Logger satisfies this; tests may substitute). */
export interface BedrockLoggerLike {
  log(message: string): void;
  warn(message: string): void;
}

export interface BedrockProviderOptions {
  /** Send-capable client; defaults to a real BedrockRuntimeClient. */
  client?: BedrockClientLike;
  /** Logger; defaults to Nest Logger('BedrockProvider'). */
  logger?: BedrockLoggerLike;
  /** Region; defaults to AWS_REGION env, then 'us-east-1'. */
  region?: string;
  /** Default model; defaults to HERMES_BEDROCK_MODEL_ID env. */
  modelId?: string;
  /** Per-request timeout ms; defaults to HERMES_BEDROCK_TIMEOUT_MS, then 60_000. */
  timeoutMs?: number;
  /** Extra attempts after the first (bounded 0..5); defaults to HERMES_BEDROCK_MAX_RETRIES, then 2. */
  maxRetries?: number;
  /** Backoff base delay ms for tests/tuning; defaults to 250. */
  baseRetryDelayMs?: number;
  /** Clock for latency measurement (tests). */
  now?: () => number;
  /** Sleep for retry backoff (tests). */
  sleep?: (ms: number) => Promise<void>;
}

const PROVIDER_NAME = 'bedrock';
const DEFAULT_REGION = 'us-east-1';
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_BASE_RETRY_DELAY_MS = 250;
const MAX_RETRY_DELAY_MS = 1_500;
const MAX_CLAMPED_RETRIES = 5;
const DEFAULT_MAX_TOKENS = 1024;
const DEFAULT_TEMPERATURE = 0;

function envString(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim().length > 0 ? value.trim() : undefined;
}

/** Positive integer env var (timeout). Invalid/absent -> fallback. */
function envPositiveInt(name: string, fallback: number): number {
  const value = envString(name);
  if (!value) return fallback;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** Non-negative integer env var (max retries). Invalid/absent -> fallback. */
function envNonNegativeInt(name: string, fallback: number): number {
  const value = envString(name);
  if (!value) return fallback;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

export class BedrockProvider implements AiProvider {
  private readonly client: BedrockClientLike;
  private readonly logger: BedrockLoggerLike;
  private readonly defaultModelId: string | undefined;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly baseRetryDelayMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  /**
   * `options` is optional: Nest DI resolves no token for it and injects
   * undefined (see @Optional), so production boot uses environment config.
   * Tests construct BedrockProvider with explicit fakes/overrides.
   */
  constructor(@Optional() options?: BedrockProviderOptions) {
    const opts = options ?? {};
    const region = opts.region ?? envString('AWS_REGION') ?? DEFAULT_REGION;

    this.logger = opts.logger ?? new Logger('BedrockProvider');
    // Credentials deliberately NOT handled here: the SDK's default credential
    // chain resolves AWS_PROFILE / AWS_ACCESS_KEY_ID at request time.
    // maxAttempts: 1 disables the SDK's internal retry loop so THIS class is
    // the single, bounded retry authority (see generate()).
    this.client =
      opts.client ?? new BedrockRuntimeClient({ region, maxAttempts: 1 });
    this.defaultModelId = opts.modelId ?? envString('HERMES_BEDROCK_MODEL_ID');
    this.timeoutMs =
      opts.timeoutMs !== undefined &&
      Number.isInteger(opts.timeoutMs) &&
      opts.timeoutMs > 0
        ? opts.timeoutMs
        : envPositiveInt('HERMES_BEDROCK_TIMEOUT_MS', DEFAULT_TIMEOUT_MS);
    this.maxRetries = Math.max(
      0,
      Math.min(MAX_CLAMPED_RETRIES, opts.maxRetries ?? envNonNegativeInt('HERMES_BEDROCK_MAX_RETRIES', DEFAULT_MAX_RETRIES)),
    );
    this.baseRetryDelayMs = opts.baseRetryDelayMs ?? DEFAULT_BASE_RETRY_DELAY_MS;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async generate(request: AiRequest): Promise<AiResponse> {
    const startedAt = this.now();
    const modelId = this.resolveModelId(request);
    this.validateRequest(request);
    const maxAttempts = this.maxRetries + 1;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      this.logger.log(
        `ai.provider=${PROVIDER_NAME} action=invoke model=${modelId} attempt=${attempt}/${maxAttempts}`,
      );
      try {
        const output = await this.converseOnce(modelId, request);
        const { text, inputTokens, outputTokens } = this.parseResponse(output);
        const latencyMs = Math.max(0, this.now() - startedAt);
        const estimate = estimateAiCost({ modelId, inputTokens, outputTokens });

        this.logger.log(
          `ai.provider=${PROVIDER_NAME} action=success model=${modelId} latencyMs=${latencyMs} inputTokens=${inputTokens ?? 0} outputTokens=${outputTokens ?? 0} attempt=${attempt}/${maxAttempts}`,
        );

        return {
          text,
          modelId,
          inputTokens,
          outputTokens,
          latencyMs,
          provider: PROVIDER_NAME,
          estimatedInputCost: estimate.estimatedInputCost,
          estimatedOutputCost: estimate.estimatedOutputCost,
          estimatedTotalCost: estimate.estimatedTotalCost,
          pricingVersion: estimate.pricingVersion,
        };
      } catch (err) {
        const classified =
          err instanceof AiError
            ? { category: err.category, retryable: err.retryable }
            : classifyBedrockError(err);
        const lastAttempt = attempt >= maxAttempts;

        if (!classified.retryable || lastAttempt) {
          const failure =
            err instanceof AiError
              ? err
              : new AiError(
                  classified.category,
                  this.failureMessage(err, classified.category),
                  classified.retryable,
                  err,
                );
          const status = httpStatus(err);
          this.logger.warn(
            `ai.provider=${PROVIDER_NAME} action=failure model=${modelId} category=${failure.category} attempt=${attempt}/${maxAttempts} error=${errName(err)}${status !== undefined ? ` http=${status}` : ''}`,
          );
          throw failure;
        }

        const delayMs = this.backoffDelayMs(attempt);
        this.logger.warn(
          `ai.provider=${PROVIDER_NAME} action=retry model=${modelId} category=${classified.category} attempt=${attempt}/${maxAttempts} nextDelayMs=${delayMs}`,
        );
        await this.sleep(delayMs);
      }
    }

    // Defensive: loop above always returns or throws.
    throw new AiError(
      AiErrorCategory.UNKNOWN,
      'Bedrock provider retry loop exited without a result',
    );
  }

  /** Resolve the model to use: explicit request override, else env default, else fail clearly. */
  private resolveModelId(request: AiRequest): string {
    const requested = request.modelId;
    if (requested !== undefined) {
      if (typeof requested !== 'string' || requested.trim().length === 0) {
        throw new AiError(
          AiErrorCategory.VALIDATION,
          'request.modelId must be a non-empty string when supplied',
        );
      }
      return requested.trim();
    }
    if (this.defaultModelId) {
      return this.defaultModelId;
    }
    // Deliberately NO silent fallback to an unrelated model (e.g. Nova).
    throw new AiError(
      AiErrorCategory.CONFIGURATION,
      'No Bedrock model configured: set HERMES_BEDROCK_MODEL_ID (or pass request.modelId). Refusing to fall back to an unrelated model.',
    );
  }

  /** Request validation. Prompt content is intentionally NOT restricted. */
  private validateRequest(request: AiRequest): void {
    if (typeof request.prompt !== 'string' || request.prompt.trim().length === 0) {
      throw new AiError(
        AiErrorCategory.VALIDATION,
        'prompt is required and must be a non-empty string',
      );
    }
    if (
      request.maxTokens !== undefined &&
      (!Number.isInteger(request.maxTokens) || request.maxTokens < 1)
    ) {
      throw new AiError(
        AiErrorCategory.VALIDATION,
        'maxTokens must be a positive integer when supplied',
      );
    }
    if (
      request.temperature !== undefined &&
      (typeof request.temperature !== 'number' ||
        Number.isNaN(request.temperature) ||
        request.temperature < 0 ||
        request.temperature > 1)
    ) {
      throw new AiError(
        AiErrorCategory.VALIDATION,
        'temperature must be a number between 0 and 1 when supplied',
      );
    }
  }

  /** Single Converse call guarded by the bounded request timeout. */
  private async converseOnce(
    modelId: string,
    request: AiRequest,
  ): Promise<ConverseCommandOutput> {
    const command = new ConverseCommand({
      modelId,
      ...(request.systemPrompt
        ? { system: [{ text: request.systemPrompt }] }
        : {}),
      messages: [{ role: 'user', content: [{ text: request.prompt }] }],
      inferenceConfig: {
        maxTokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
        temperature: request.temperature ?? DEFAULT_TEMPERATURE,
      },
    });

    // timeoutMs is always a positive integer (clamped at construction):
    // the send is ALWAYS raced against the hard deadline.
    const controller = new AbortController();
    const sendPromise = this.client.send(command, {
      abortSignal: controller.signal,
    });
    // The timeout MUST NOT depend on the client honoring abortSignal:
    // race the send against a hard deadline so the wait is always bounded.
    let timer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort(); // best-effort cancellation of the real request
        reject(
          new AiError(
            AiErrorCategory.TIMEOUT,
            `Bedrock request timed out after ${this.timeoutMs}ms`,
          ),
        );
      }, this.timeoutMs);
    });
    try {
      return await Promise.race([sendPromise, timeoutPromise]);
    } catch (err) {
      if (controller.signal.aborted && !(err instanceof AiError)) {
        // The SDK honored the abort and rejected (e.g. AbortError).
        throw new AiError(
          AiErrorCategory.TIMEOUT,
          `Bedrock request timed out after ${this.timeoutMs}ms`,
          false,
          err,
        );
      }
      throw err;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * Validate the provider response shape and extract usable text + token
   * usage. A valid response with zero text blocks yields text '' (a valid
   * empty completion, handled safely); a missing/unshaped payload is a
   * MALFORMED_RESPONSE error.
   */
  private parseResponse(output: ConverseCommandOutput): {
    text: string;
    inputTokens?: number;
    outputTokens?: number;
  } {
    if (!output || typeof output !== 'object') {
      throw new AiError(
        AiErrorCategory.MALFORMED_RESPONSE,
        'Bedrock returned no response object',
      );
    }
    const content = output.output?.message?.content;
    if (!Array.isArray(content)) {
      throw new AiError(
        AiErrorCategory.MALFORMED_RESPONSE,
        'Bedrock response is missing message content',
      );
    }
    const text = content
      .filter(
        (block): block is { text: string } =>
          typeof block === 'object' &&
          block !== null &&
          'text' in block &&
          typeof (block as { text?: unknown }).text === 'string',
      )
      .map((block) => (block as { text: string }).text)
      .join('');

    const usage = output.usage;
    const inputTokens =
      usage && typeof usage.inputTokens === 'number'
        ? usage.inputTokens
        : undefined;
    const outputTokens =
      usage && typeof usage.outputTokens === 'number'
        ? usage.outputTokens
        : undefined;

    return { text, inputTokens, outputTokens };
  }

  /**
   * Build a caller-safe failure message: static text + error name/status.
   * Raw provider error messages are never included (they could echo request
   * content); the original error stays on AiError.cause for logs/debugging.
   */
  private failureMessage(
    err: unknown,
    category: AiErrorCategory,
  ): string {
    if (err instanceof AiError) {
      return err.message;
    }
    const status = httpStatus(err);
    return `Bedrock provider ${category} failure (${errName(err)}${status !== undefined ? `, http ${status}` : ''})`;
  }

  /** Exponential backoff with jitter, bounded to [delay/2, delay] <= cap. */
  private backoffDelayMs(failedAttempt: number): number {
    const exponential = Math.min(
      MAX_RETRY_DELAY_MS,
      this.baseRetryDelayMs * 2 ** (failedAttempt - 1),
    );
    const half = exponential / 2;
    return Math.floor(half + Math.random() * half);
  }
}

// Referenced so the registry travels with the provider module (documented
// config location for price updates without touching provider logic).
export { AI_PRICING_REGISTRY };
