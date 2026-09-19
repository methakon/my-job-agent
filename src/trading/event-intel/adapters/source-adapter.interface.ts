/**
 * Source Adapter Interface — Provider-neutral contract for event data sources.
 *
 * Every data source (authoritative feeds, market data pipes, macro calendars,
 * news/social discovery) implements this interface so the event intelligence
 * orchestrator can treat them uniformly.
 *
 * SAFETY: This is the adapter-layer contract, distinct from the core
 * SourceAdapter/SourceHealth defined in event-types.ts. That core interface
 * is the internal event pipeline shape; this one adds result wrappers,
 * degradation semantics, and health tracking for the registry.
 *
 * PAPER TRADING ONLY: Adapters return raw records for paper-candidate
 * generation. No adapter places real orders.
 */

import { EventRawRecord, SourceTier } from '../event-types';

// ── Source Adapter Contract ──────────────────────────────────────────────────

/**
 * Provider-neutral interface for all event data source adapters.
 *
 * @remarks
 * - Implementations must NEVER throw; return structured errors instead.
 * - Implementations must be provider-neutral: no hardcoded API keys,
 *   credentials, or provider-specific configuration in the class body.
 * - All methods return results wrapped in {@link SourceAdapterResult},
 *   preserving the degraded/error semantics the registry expects.
 * - Health checks via {@link fetchSourceHealth} must not make network
 *   calls that block; prefer cached or lightweight probes.
 */
export interface SourceAdapter {
  /** Unique adapter identifier (e.g., "rbi-authoritative", "nse-market-data"). */
  readonly name: string;

  /** Source reliability tier. */
  readonly tier: SourceTier;

  /** Whether this adapter is currently connected and able to fetch data. */
  readonly isAvailable: boolean;

  /**
   * Fetch new events published since a given time.
   *
   * @param since - Only return events published after this timestamp.
   *                If omitted, returns all available events.
   * @returns Structured result containing events or error information.
   */
  fetchEvents(since?: Date): Promise<SourceAdapterResult>;

  /**
   * Fetch scheduled/future events (economic calendar, central bank
   * meeting dates, regulatory filing deadlines, etc.).
   *
   * @returns Structured result containing scheduled events or error info.
   */
  fetchScheduledEvents(): Promise<SourceAdapterResult>;

  /**
   * Fetch updates (revisions, corrections, status changes) for
   * previously observed events.
   *
   * @param eventIds - IDs of events to check for updates.
   * @returns Structured result containing updated raw records or error info.
   */
  fetchUpdates(eventIds: string[]): Promise<SourceAdapterResult>;

  /**
   * Return current health status of this adapter.
   *
   * @remarks
   * Must not perform expensive or blocking network calls.
   * Returns cached health state if available.
   */
  fetchSourceHealth(): Promise<SourceHealthStatus>;
}

// ── Result Types ────────────────────────────────────────────────────────────

/**
 * Structured result from any adapter fetch operation.
 *
 * @remarks
 * - Never null; callers always receive a result object.
 * - `success: false` does NOT mean the adapter is broken — it may mean
 *   the upstream feed is temporarily unreachable (degraded state).
 * - `latencyMs` measures the time spent in the adapter (network + parsing),
 *   excluding downstream processing.
 */
export interface SourceAdapterResult {
  /** Whether the fetch completed without errors. */
  success: boolean;
  /** Raw event records retrieved (empty array on failure or no data). */
  events: EventRawRecord[];
  /** Human-readable error description (only when success is false). */
  error?: string;
  /** Latency of this fetch operation in milliseconds. */
  latencyMs: number;
}

/**
 * Health status of a source adapter, used by the registry for
 * availability tracking and degradation decisions.
 *
 * @remarks
 * - `degraded: true` means the adapter is partially functional
 *   (e.g., returning cached data, limited scope, or stub responses).
 * - `failureCount` is a bounded counter (resets on success).
 * - `degradationReason` should be machine-parseable for alerting.
 */
export interface SourceHealthStatus {
  /** Whether the adapter is reachable and functional. */
  available: boolean;
  /** When the adapter last completed a successful fetch. */
  lastSuccessAt?: Date;
  /** When the adapter last failed a fetch. */
  lastFailureAt?: Date;
  /** Consecutive failure count (bounded, resets on success). */
  failureCount: number;
  /** Latency of the last health probe in milliseconds. */
  latencyMs?: number;
  /** Whether the adapter is operating in degraded mode. */
  degraded: boolean;
  /** Human-readable reason for degradation (machine-parseable preferred). */
  degradationReason?: string;
}
