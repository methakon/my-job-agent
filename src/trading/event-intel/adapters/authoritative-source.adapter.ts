/**
 * Authoritative Source Adapter — Tier 1
 *
 * Covers: RBI, Federal Reserve, ECB, Bank of England, Bank of Japan,
 * People's Bank of China, Indian Government (GoI), NSE, BSE, SEBI.
 *
 * PURPOSE:
 * Tier 1 sources are the ground truth for event intelligence. They provide:
 * - Official event confirmation and definition
 * - Authoritative status (CONFIRMED, REVISED, DENIED, RESOLVED)
 * - Revisions and corrections to previously published data
 * - Resolution of contradictions between lower-tier sources
 *
 * SAFETY: This is a STUB adapter. It returns DEGRADED state with empty
 * event arrays. Do NOT use this adapter's output for trading decisions
 * until it is connected to a live authoritative feed. The stub exists
 * to establish the adapter boundary and enable integration testing.
 *
 * INTEGRATION: Connect to live feeds (e.g., RBI RSS/API, SEBI filings,
 * NSE corporate announcements) by replacing the fetch methods below.
 * Keep the DEGRADED fallback for network/auth failures.
 */

import {
  EventRawRecord,
  SourceTier,
} from '../event-types';
import {
  SourceAdapter,
  SourceAdapterResult,
  SourceHealthStatus,
} from './source-adapter.interface';

/**
 * Tier 1 authoritative source adapter (stub).
 *
 * @remarks
 * Returns DEGRADED state. No live feed is connected.
 * All fetch methods return success:true with empty arrays to indicate
 * "no data available" rather than "adapter broken."
 */
export class AuthoritativeSourceAdapter implements SourceAdapter {
  readonly name = 'authoritative-source';
  readonly tier: SourceTier = 'TIER1_AUTHORITATIVE';

  private _isAvailable = false;
  private _lastSuccessAt: Date | undefined;
  private _lastFailureAt: Date | undefined;
  private _failureCount = 0;

  get isAvailable(): boolean {
    return this._isAvailable;
  }

  /**
   * Fetch events from authoritative sources.
   *
   * @returns Empty array with success:true. The adapter is stubbed.
   */
  async fetchEvents(since?: Date): Promise<SourceAdapterResult> {
    const start = Date.now();
    try {
      // STUB: No live feed connected. Return empty with degraded indicator.
      this._lastSuccessAt = new Date();
      this._failureCount = 0;
      return {
        success: true,
        events: [],
        latencyMs: Date.now() - start,
      };
    } catch (err) {
      this._lastFailureAt = new Date();
      this._failureCount++;
      return {
        success: false,
        events: [],
        error: `AuthoritativeSourceAdapter.fetchEvents failed: ${err instanceof Error ? err.message : String(err)}`,
        latencyMs: Date.now() - start,
      };
    }
  }

  /**
   * Fetch scheduled events (RBI monetary policy dates, SEBI filing
   * deadlines, government budget sessions, etc.).
   *
   * @returns Empty array with success:true. The adapter is stubbed.
   */
  async fetchScheduledEvents(): Promise<SourceAdapterResult> {
    const start = Date.now();
    try {
      this._lastSuccessAt = new Date();
      this._failureCount = 0;
      return {
        success: true,
        events: [],
        latencyMs: Date.now() - start,
      };
    } catch (err) {
      this._lastFailureAt = new Date();
      this._failureCount++;
      return {
        success: false,
        events: [],
        error: `AuthoritativeSourceAdapter.fetchScheduledEvents failed: ${err instanceof Error ? err.message : String(err)}`,
        latencyMs: Date.now() - start,
      };
    }
  }

  /**
   * Fetch revisions/corrections to previously observed authoritative events.
   *
   * @returns Empty array with success:true. The adapter is stubbed.
   */
  async fetchUpdates(eventIds: string[]): Promise<SourceAdapterResult> {
    const start = Date.now();
    try {
      this._lastSuccessAt = new Date();
      this._failureCount = 0;
      return {
        success: true,
        events: [],
        latencyMs: Date.now() - start,
      };
    } catch (err) {
      this._lastFailureAt = new Date();
      this._failureCount++;
      return {
        success: false,
        events: [],
        error: `AuthoritativeSourceAdapter.fetchUpdates failed: ${err instanceof Error ? err.message : String(err)}`,
        latencyMs: Date.now() - start,
      };
    }
  }

  /**
   * Return health status.
   *
   * @returns Degraded state — adapter is not connected to any live feed.
   */
  async fetchSourceHealth(): Promise<SourceHealthStatus> {
    return {
      available: false,
      lastSuccessAt: this._lastSuccessAt,
      lastFailureAt: this._lastFailureAt,
      failureCount: this._failureCount,
      degraded: true,
      degradationReason: 'not connected',
    };
  }
}
