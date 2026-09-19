/**
 * General Discovery Source Adapter — Tier 4
 *
 * Covers: News aggregators, web search, social media (Twitter/X),
 * RSS feeds, blog monitoring, alternative data providers.
 *
 * PURPOSE:
 * Tier 4 sources provide early detection, discovery, and corroboration ONLY:
 * - Breaking news detection (first signal, not confirmation)
 * - Narrative volume and sentiment shifts
 * - Cross-source corroboration signals
 * - Social media buzz and trending topics
 *
 * SAFETY CRITICAL: A Tier 4 source must NEVER independently produce
 * a high-confidence trading state. Its role is to:
 * 1. Raise an early signal that triggers investigation
 * 2. Corroborate signals from Tier 1-3 sources
 * 3. Provide narrative context for established events
 *
 * The event state machine must require Tier 1 or Tier 2 confirmation
 * before moving any event to OFFICIAL or CONFIRMED lifecycle state.
 * Tier 4 data alone can only produce S0_DETECTED → S1_INITIAL_SHOCK
 * transitions at most, and only with appropriate uncertainty.
 *
 * SAFETY: This is a STUB adapter. It returns DEGRADED state.
 * No news/social feed is connected.
 *
 * INTEGRATION: Connect to news APIs (NewsAPI, GDELT), social media
 * APIs (X/Twitter API), or RSS aggregators by implementing the fetch
 * methods. Rate limiting and credential management must be handled
 * at the provider layer, not in this adapter.
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
 * Tier 4 general discovery source adapter (stub).
 *
 * @remarks
 * Returns DEGRADED state. No news or social feed is connected.
 * Once connected, this adapter will emit discovery events (breaking
 * news, social media signals, narrative volume changes) as
 * EventRawRecord instances with sourceType 'news', 'social_media',
 * or 'web_search'.
 *
 * IMPORTANT: Consumers of this adapter's output must enforce the
 * Tier 4 corroboration rule — no trading decisions on Tier 4 alone.
 */
export class GeneralDiscoverySourceAdapter implements SourceAdapter {
  readonly name = 'general-discovery-source';
  readonly tier: SourceTier = 'TIER4_GENERAL_DISCOVERY';

  private _isAvailable = false;
  private _lastSuccessAt: Date | undefined;
  private _lastFailureAt: Date | undefined;
  private _failureCount = 0;

  get isAvailable(): boolean {
    return this._isAvailable;
  }

  /**
   * Fetch discovery events (breaking news, social signals, narrative
   * volume changes).
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
        error: `GeneralDiscoverySourceAdapter.fetchEvents failed: ${err instanceof Error ? err.message : String(err)}`,
        latencyMs: Date.now() - start,
      };
    }
  }

  /**
   * Fetch scheduled discovery opportunities (known upcoming events
   * from news calendars, social media event tracking).
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
        error: `GeneralDiscoverySourceAdapter.fetchScheduledEvents failed: ${err instanceof Error ? err.message : String(err)}`,
        latencyMs: Date.now() - start,
      };
    }
  }

  /**
   * Fetch updates to previously observed discovery events (new
   * articles, follow-up social posts, corrections).
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
        error: `GeneralDiscoverySourceAdapter.fetchUpdates failed: ${err instanceof Error ? err.message : String(err)}`,
        latencyMs: Date.now() - start,
      };
    }
  }

  /**
   * Return health status.
   *
   * @returns Degraded state — no news/social feed is connected.
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
