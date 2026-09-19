/**
 * External Data Adapter Interfaces — shared types for all external-data adapters.
 *
 * Every adapter follows the same contract:
 *   - AdapterMode: 'mock' | 'live' | 'disabled'
 *   - Each adapter exports a `create*Adapter(mode?)` factory
 *   - Mock mode generates deterministic synthetic data (no API keys needed)
 *   - Live mode is stubbed until real credentials are wired
 *   - Disabled mode returns empty/null for all fields
 */

export type AdapterMode = 'mock' | 'live' | 'disabled';

export type AdapterHealth = {
  ok: boolean;
  lastFetchAt: number | null;
  errorCount: number;
  mode: AdapterMode;
};

export interface ExternalDataAdapter {
  readonly name: string;
  getMode(): AdapterMode;
  getHealth(): AdapterHealth;
  dispose(): void;
}

export type TimeWindow = {
  startMs: number;
  endMs: number;
};

export type OhlcvBar = {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};
