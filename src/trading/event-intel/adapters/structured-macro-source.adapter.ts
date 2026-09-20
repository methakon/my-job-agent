/**
 * Structured Macro Source Adapter — Tier 3
 *
 * Covers: Trading Economics, FRED (Federal Reserve Economic Data),
 * IMF, World Bank, GDELT (Global Database of Events, Language, and Tone).
 *
 * PURPOSE:
 * Tier 3 sources provide structured macro context and broad event
 * discovery:
 * - Economic calendar (GDP, CPI, PMI, trade balance, employment)
 * - Consensus estimates vs actuals
 * - Macro narrative volume and sentiment
 * - Cross-country macro comparisons
 * - Historical event patterns and correlations
 *
 * SAFETY: This is a STUB adapter. It returns DEGRADED state.
 * Tier 3 sources provide context, not confirmation. They should NEVER
 * independently trigger high-confidence trading states. Their role is
 * to enrich Tier 1/2 signals with macro background.
 *
 * INTEGRATION: Connect to Trading Economics API, FRED API, GDELT API,
 * or IMF data portal by implementing the fetch methods.
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
 * Tier 3 structured macro source adapter (stub).
 *
 * @remarks
 * Returns DEGRADED state. No macro data feed is connected.
 * Once connected, this adapter will emit macro calendar events
 * (GDP releases, CPI prints, PMI data, central bank minutes)
 * as EventRawRecord instances with sourceType 'data_release'
 * or 'macro_calendar'.
 */
export class StructuredMacroSourceAdapter implements SourceAdapter {
  readonly name = 'structured-macro-source';
  readonly tier: SourceTier = 'TIER3_STRUCTURED_MACRO';

  private _isAvailable = false;
  private _lastSuccessAt: Date | undefined;
  private _lastFailureAt: Date | undefined;
  private _failureCount = 0;

  get isAvailable(): boolean {
    return this._isAvailable;
  }

  /**
   * Fetch macro events (economic data releases, policy decisions,
   * narrative signals).
   *
   * @returns Empty array with success:true. The adapter is stubbed.
   */
  async fetchEvents(since?: Date): Promise<SourceAdapterResult> {
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
        error: `StructuredMacroSourceAdapter.fetchEvents failed: ${err instanceof Error ? err.message : String(err)}`,
        latencyMs: Date.now() - start,
      };
    }
  }

  /**
   * Fetch scheduled macro events (economic calendar — GDP releases,
   * CPI dates, central bank meeting schedules).
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
        error: `StructuredMacroSourceAdapter.fetchScheduledEvents failed: ${err instanceof Error ? err.message : String(err)}`,
        latencyMs: Date.now() - start,
      };
    }
  }

  /**
   * Fetch updates to previously observed macro events (revised GDP
   * figures, corrected CPI data, updated consensus estimates).
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
        error: `StructuredMacroSourceAdapter.fetchUpdates failed: ${err instanceof Error ? err.message : String(err)}`,
        latencyMs: Date.now() - start,
      };
    }
  }

  /**
   * Return health status.
   *
   * @returns Degraded state — no macro data feed is connected.
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
