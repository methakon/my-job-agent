/**
 * Unified error classifications for the trading system.
 *
 * Every logged error MUST carry one of these classifications so that
 * Monday's live-validation session can categorize failures systematically.
 *
 * Wire each classification to an ACTUAL error path. Do NOT use a
 * classification just to satisfy a checklist — only where the code
 * genuinely transitions into that state.
 */

export enum ErrorClassification {
  /** Expected business rule rejection (e.g., invalid tick, stale data). Handled, no action needed. */
  EXPECTED_HANDLED = 'EXPECTED_HANDLED',

  /** System recovered from a transient failure automatically. */
  RECOVERED = 'RECOVERED',

  /** Retry in progress (e.g., reconnection, API retry). */
  RETRYING = 'RETRYING',

  /** System operating at reduced capacity (e.g., degraded feed, missing data source). */
  DEGRADED = 'DEGRADED',

  /** Unsafe data/persistence condition — new entries blocked until resolved. */
  BLOCK_NEW_ENTRIES = 'BLOCK_NEW_ENTRIES',

  /** Unexpected exception caught — may indicate a code defect. */
  UNHANDLED_EXCEPTION = 'UNHANDLED_EXCEPTION',

  /** Fatal startup condition — system cannot operate safely. */
  FATAL_STARTUP = 'FATAL_STARTUP',
}

export type StructuredErrorContext = {
  classification: ErrorClassification;
  component: string;
  provider?: string;
  errorCode?: string;
  operation: string;
  message: string;
  correlationId?: string;
  instrument?: string;
  session?: string;
  recoveryAction?: string;
  recovered?: boolean;
  latencyMs?: number;
};
