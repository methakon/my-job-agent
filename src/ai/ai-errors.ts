/**
 * AI provider error taxonomy for the Hermes Bedrock integration.
 *
 * Categories are intentionally coarse so callers can branch on a small,
 * stable set. The underlying provider error is preserved on AiError.cause
 * for logs/debugging and is NEVER rendered into API responses.
 */

export enum AiErrorCategory {
  /** Missing/invalid environment or provider configuration (e.g. no model configured). */
  CONFIGURATION = 'CONFIGURATION',
  /** Caller-supplied request failed validation. Never retried. */
  VALIDATION = 'VALIDATION',
  /** AWS authentication/authorization failure. Never retried. */
  AUTHENTICATION = 'AUTHENTICATION',
  /** Bedrock throttling (HTTP 429). Retried with bounded backoff. */
  THROTTLING = 'THROTTLING',
  /** Transient provider failure (5xx, model timeout/not-ready, network blips). Retried with bounded backoff. */
  TRANSIENT = 'TRANSIENT',
  /** Our own bounded request timeout fired. Not retried. */
  TIMEOUT = 'TIMEOUT',
  /** Provider answered with a shape we cannot parse. Not retried. */
  MALFORMED_RESPONSE = 'MALFORMED_RESPONSE',
  /** Anything we could not classify. Not retried (fail safe). */
  UNKNOWN = 'UNKNOWN',
}

export interface ClassifiedError {
  category: AiErrorCategory;
  retryable: boolean;
}

/**
 * Internal error thrown by the Bedrock provider.
 * `cause` carries the original provider error for logs/debugging;
 * it is never serialized into API responses.
 */
export class AiError extends Error {
  readonly category: AiErrorCategory;
  readonly retryable: boolean;
  readonly cause?: unknown;

  constructor(
    category: AiErrorCategory,
    message: string,
    retryable = false,
    cause?: unknown,
  ) {
    super(message);
    this.name = 'AiError';
    this.category = category;
    this.retryable = retryable;
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

/** Best-effort extract of an error's SDK/service name. */
export function errName(err: unknown): string {
  if (err && typeof err === 'object' && 'name' in err) {
    const name = (err as { name?: unknown }).name;
    if (typeof name === 'string' && name.length > 0) return name;
  }
  return 'Error';
}

/** Best-effort extract of an HTTP status from AWS SDK $metadata. */
export function httpStatus(err: unknown): number | undefined {
  if (err && typeof err === 'object') {
    const metadata = (err as { $metadata?: { httpStatusCode?: unknown } }).$metadata;
    if (metadata && typeof metadata.httpStatusCode === 'number') {
      return metadata.httpStatusCode;
    }
  }
  return undefined;
}

/** AWS Bedrock (Converse) exception names surfaced via err.name by the SDK. */
const AUTH_ERROR_NAMES = new Set(['AccessDeniedException', 'UnauthorizedException']);

const NON_RETRYABLE_REQUEST_ERROR_NAMES = new Set([
  'ValidationException',
  // ResourceNotFound covers an invalid/unknown modelId (non-retryable).
  'ResourceNotFoundException',
  'ModelNotFoundException',
]);

const THROTTLING_ERROR_NAMES = new Set([
  'ThrottlingException',
  'ProvisionedThroughputExceededException',
]);

const TRANSIENT_ERROR_NAMES = new Set([
  'InternalServerException',
  'ServiceUnavailableException',
  // Model-side timeouts / not-yet-ready can clear; retried, bounded.
  'ModelTimeoutException',
  'ModelNotReadyException',
]);

const TIMEOUT_ERROR_NAMES = new Set(['AbortError', 'RequestAbortedError']);

/** Low-level network error codes that are worth a bounded retry. */
const NETWORK_ERROR_CODES = new Set([
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENOTFOUND',
]);

/**
 * Classify an unknown thrown value from the AWS SDK into our internal
 * taxonomy. Only genuinely transient/retryable failures return
 * `retryable: true` — auth, validation, invalid-model and anything
 * unclassifiable fail safe with no retry (never a retry storm).
 */
export function classifyBedrockError(err: unknown): ClassifiedError {
  const name = errName(err);
  const status = httpStatus(err);

  if (AUTH_ERROR_NAMES.has(name) || status === 401 || status === 403) {
    return { category: AiErrorCategory.AUTHENTICATION, retryable: false };
  }
  if (NON_RETRYABLE_REQUEST_ERROR_NAMES.has(name) || status === 400 || status === 404) {
    return { category: AiErrorCategory.VALIDATION, retryable: false };
  }
  if (THROTTLING_ERROR_NAMES.has(name) || status === 429) {
    return { category: AiErrorCategory.THROTTLING, retryable: true };
  }
  if (TRANSIENT_ERROR_NAMES.has(name) || status === 500 || status === 502 || status === 503 || status === 504) {
    return { category: AiErrorCategory.TRANSIENT, retryable: true };
  }
  if (TIMEOUT_ERROR_NAMES.has(name)) {
    return { category: AiErrorCategory.TIMEOUT, retryable: false };
  }
  if (err && typeof err === 'object') {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string' && NETWORK_ERROR_CODES.has(code)) {
      return { category: AiErrorCategory.TRANSIENT, retryable: true };
    }
  }
  return { category: AiErrorCategory.UNKNOWN, retryable: false };
}
