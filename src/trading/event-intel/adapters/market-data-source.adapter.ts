/**
 * Market Data Source Adapter — Tier 2
 *
 * Covers: NSE, FYERS, licensed market data feeds, existing canonical
 * market-data pipeline (if available).
 *
 * PURPOSE:
 * Tier 2 sources provide real-time and historical market microstructure:
 * - NIFTY / BANKNIFTY spot, futures, options
 * - Implied volatility (IV), open interest (OI), volume
 * - Bid-ask spreads, order book depth
 * - Option chain surface data
 * - Futures basis, contango/backwardation
 *
 * This adapter can optionally read from an existing canonical
 * market-data pipeline (e.g., FYERS WebSocket or NSE API) if one is
 * available in the deployment. For now, it is a STUB returning DEGRADED.
 *
 * SAFETY: This adapter provides market observations, NOT trading signals.
 * It must never place orders. The DEGRADED stub means no market data
 * is flowing — the event intelligence system must treat all downstream
 * features as unavailable.
 *
 * INTEGRATION: Connect to FYERS WebSocket, NSE market data API, or
 * the existing canonical pipeline by implementing the fetch methods.
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
 * Tier 2 market data source adapter (stub).
 *
 * @remarks
 * Returns DEGRADED state. No market data feed is connected.
 * Once connected, this adapter will emit market microstructure events
 * (IV changes, OI shifts, volume spikes, spread widening) as
 * EventRawRecord instances with sourceType 'market_data'.
 */
export class MarketDataSourceAdapter implements SourceAdapter {
  readonly name = 'market-data-source';
  readonly tier: SourceTier = 'TIER2_MARKET_DATA';

  private _isAvailable = false;
  private _lastSuccessAt: Date | undefined;
  private _lastFailureAt: Date | undefined;
  private _failureCount = 0;

  get isAvailable(): boolean {
    return this._isAvailable;
  }

  /**
   * Fetch market microstructure events (IV changes, OI shifts,
   * volume spikes, spread widening).
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
        error: `MarketDataSourceAdapter.fetchEvents failed: ${err instanceof Error ? err.message : String(err)}`,
        latencyMs: Date.now() - start,
      };
    }
  }

  /**
   * Fetch scheduled market events (expiry dates, Muhurat trading,
   * NSE holiday calendar).
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
        error: `MarketDataSourceAdapter.fetchScheduledEvents failed: ${err instanceof Error ? err.message : String(err)}`,
        latencyMs: Date.now() - start,
      };
    }
  }

  /**
   * Fetch updates to previously observed market events (e.g., revised
   * OI data, corrected volume figures).
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
        error: `MarketDataSourceAdapter.fetchUpdates failed: ${err instanceof Error ? err.message : String(err)}`,
        latencyMs: Date.now() - start,
      };
    }
  }

  /**
   * Return health status.
   *
   * @returns Degraded state — no market data feed is connected.
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
