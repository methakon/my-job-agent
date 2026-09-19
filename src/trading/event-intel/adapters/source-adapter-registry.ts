/**
 * Source Adapter Registry — Manages all event data source adapters.
 *
 * PURPOSE:
 * Central registry that discovers, manages, and health-tracks all
 * registered source adapters. The orchestrator queries this registry
 * to determine which sources to poll, which are healthy, and which
 * are degraded.
 *
 * SAFETY:
 * - Registry never throws; all operations return structured results.
 * - Health history is bounded (max 100 entries per adapter) to prevent
 *   unbounded memory growth.
 * - Health checks are lightweight — no blocking network calls.
 *
 * PAPER TRADING ONLY: This registry manages adapters for paper-candidate
 * generation. No adapter registered here places real orders.
 */

import { SourceTier } from '../event-types';
import {
  SourceAdapter,
  SourceHealthStatus,
} from './source-adapter.interface';

// ── Health Report ────────────────────────────────────────────────────────────

/**
 * Per-tier health breakdown within a aggregate health report.
 */
export interface TierHealthBreakdown {
  readonly tier: SourceTier;
  readonly total: number;
  readonly healthy: number;
  readonly degraded: number;
  readonly unavailable: number;
}

/** Mutable version of TierHealthBreakdown used during report construction. */
interface MutableTierBreakdown {
  tier: SourceTier;
  total: number;
  healthy: number;
  degraded: number;
  unavailable: number;
}

/**
 * Aggregate health report across all registered adapters.
 */
export interface SourceHealthReport {
  /** Total number of registered adapters. */
  readonly total: number;
  /** Number of adapters that are available and not degraded. */
  readonly healthy: number;
  /** Number of adapters in degraded state. */
  readonly degraded: number;
  /** Number of adapters that are unavailable. */
  readonly unavailable: number;
  /** Per-tier health breakdown. */
  readonly perTier: readonly TierHealthBreakdown[];
  /** When this report was generated. */
  readonly generatedAtMs: number;
}

// ── Health History Entry ─────────────────────────────────────────────────────

/**
 * A single point-in-time health snapshot for an adapter.
 * Stored in bounded circular buffers per adapter.
 */
interface HealthHistoryEntry {
  readonly timestampMs: number;
  readonly health: SourceHealthStatus;
}

// ── Registry Implementation ──────────────────────────────────────────────────

/**
 * Maximum number of health history entries per adapter.
 * Oldest entries are evicted when this limit is reached.
 */
const MAX_HEALTH_HISTORY = 100;

/**
 * Central registry for all event data source adapters.
 *
 * @remarks
 * Thread-safe for single-process use. Not designed for distributed
 * multi-instance deployments.
 *
 * Usage:
 * ```typescript
 * const registry = new SourceAdapterRegistry();
 * registry.registerAdapter(new AuthoritativeSourceAdapter());
 * registry.registerAdapter(new MarketDataSourceAdapter());
 *
 * const healthy = registry.getHealthyAdapters();
 * const report = registry.aggregateHealth();
 * ```
 */
export class SourceAdapterRegistry {
  /** Registered adapters by name. */
  private readonly _adapters: Map<string, SourceAdapter> = new Map();

  /** Bounded health history per adapter name. */
  private readonly _healthHistory: Map<string, HealthHistoryEntry[]> = new Map();

  /**
   * Register a source adapter.
   *
   * @remarks
   * If an adapter with the same name is already registered, it is
   * replaced. The old adapter's health history is preserved.
   *
   * @param adapter - The adapter to register.
   */
  registerAdapter(adapter: SourceAdapter): void {
    this._adapters.set(adapter.name, adapter);
    if (!this._healthHistory.has(adapter.name)) {
      this._healthHistory.set(adapter.name, []);
    }
  }

  /**
   * Unregister an adapter by name.
   *
   * @param name - The adapter name to remove.
   * @returns true if the adapter was found and removed.
   */
  unregisterAdapter(name: string): boolean {
    const removed = this._adapters.delete(name);
    if (removed) {
      this._healthHistory.delete(name);
    }
    return removed;
  }

  /**
   * Get all registered adapters.
   *
   * @returns Array of all registered adapters (order is insertion order).
   */
  getAllAdapters(): SourceAdapter[] {
    return Array.from(this._adapters.values());
  }

  /**
   * Get adapters filtered by tier.
   *
   * @param tier - The source tier to filter by.
   * @returns Array of adapters matching the given tier.
   */
  getAdaptersByTier(tier: SourceTier): SourceAdapter[] {
    return this.getAllAdapters().filter((a) => a.tier === tier);
  }

  /**
   * Get only adapters that are currently available and not degraded.
   *
   * @remarks
   * Uses the adapter's `isAvailable` property. For a full health
   * assessment including degradation status, use {@link aggregateHealth}.
   *
   * @returns Array of healthy adapters.
   */
  getHealthyAdapters(): SourceAdapter[] {
    return this.getAllAdapters().filter((a) => a.isAvailable);
  }

  /**
   * Get a single adapter by name.
   *
   * @param name - The adapter name.
   * @returns The adapter, or undefined if not found.
   */
  getAdapter(name: string): SourceAdapter | undefined {
    return this._adapters.get(name);
  }

  /**
   * Fetch health for a single adapter and record it in history.
   *
   * @param name - The adapter name.
   * @returns The health status, or undefined if adapter not found.
   */
  async fetchAndRecordHealth(name: string): Promise<SourceHealthStatus | undefined> {
    const adapter = this._adapters.get(name);
    if (!adapter) return undefined;

    const health = await adapter.fetchSourceHealth();
    this._recordHealth(name, health);
    return health;
  }

  /**
   * Fetch and record health for all registered adapters.
   *
   * @returns Map of adapter name → health status.
   */
  async fetchAllHealth(): Promise<Map<string, SourceHealthStatus>> {
    const results = new Map<string, SourceHealthStatus>();
    for (const [name] of this._adapters) {
      const health = await this.fetchAndRecordHealth(name);
      if (health) {
        results.set(name, health);
      }
    }
    return results;
  }

  /**
   * Generate an aggregate health report across all registered adapters.
   *
   * @remarks
   * This is a lightweight operation — it reads cached health state
   * from the last {@link fetchAllHealth} or {@link fetchAndRecordHealth}
   * call. It does NOT make network calls.
   *
   * Adapters that have never had their health fetched are counted
   * as "unavailable" in the report.
   *
   * @returns Aggregate health report.
   */
  aggregateHealth(): SourceHealthReport {
    const adapters = this.getAllAdapters();
    const tierMap = new Map<SourceTier, MutableTierBreakdown>();

    // Initialize tier breakdowns (mutable for accumulation)
    for (const tier of [
      'TIER1_AUTHORITATIVE',
      'TIER2_MARKET_DATA',
      'TIER3_STRUCTURED_MACRO',
      'TIER4_GENERAL_DISCOVERY',
    ] as SourceTier[]) {
      tierMap.set(tier, {
        tier,
        total: 0,
        healthy: 0,
        degraded: 0,
        unavailable: 0,
      });
    }

    let healthy = 0;
    let degraded = 0;
    let unavailable = 0;

    for (const adapter of adapters) {
      const breakdown = tierMap.get(adapter.tier);
      if (!breakdown) continue;

      const history = this._healthHistory.get(adapter.name) ?? [];
      const lastEntry = history[history.length - 1];

      if (!lastEntry) {
        // Never had a health check — count as unavailable
        unavailable++;
        breakdown.unavailable++;
      } else if (lastEntry.health.available && !lastEntry.health.degraded) {
        healthy++;
        breakdown.healthy++;
      } else if (lastEntry.health.degraded) {
        degraded++;
        breakdown.degraded++;
      } else {
        unavailable++;
        breakdown.unavailable++;
      }
    }

    return {
      total: adapters.length,
      healthy,
      degraded,
      unavailable,
      perTier: Array.from(tierMap.values()) as readonly TierHealthBreakdown[],
      generatedAtMs: Date.now(),
    };
  }

  /**
   * Get bounded health history for an adapter.
   *
   * @param name - The adapter name.
   * @param maxEntries - Maximum entries to return (default: all available).
   * @returns Array of historical health snapshots, newest first.
   */
  getHealthHistory(name: string, maxEntries?: number): readonly HealthHistoryEntry[] {
    const history = this._healthHistory.get(name) ?? [];
    if (maxEntries !== undefined) {
      return history.slice(-maxEntries).reverse();
    }
    return [...history].reverse();
  }

  /**
   * Record a health status entry in the bounded history buffer.
   *
   * @param name - The adapter name.
   * @param health - The health status to record.
   */
  private _recordHealth(name: string, health: SourceHealthStatus): void {
    let history = this._healthHistory.get(name);
    if (!history) {
      history = [];
      this._healthHistory.set(name, history);
    }

    history.push({
      timestampMs: Date.now(),
      health,
    });

    // Evict oldest entries if buffer is full
    if (history.length > MAX_HEALTH_HISTORY) {
      const excess = history.length - MAX_HEALTH_HISTORY;
      history.splice(0, excess);
    }
  }
}
