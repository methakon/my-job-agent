/**
 * ITEM 131 — Store regime at decision and exit.
 *
 * doneWhen: "historical record contains value, timestamp, version."
 *
 * PURE: no clock, no I/O, no DB, no network, no randomness.
 * RESEARCH / SHADOW ONLY: nothing in production imports this module.
 *
 * Purpose: Capture a regime snapshot at a point in time (decision or exit)
 * and store it as a structured record. This enables regime-aware analysis
 * of historical trades: was the regime trending or ranging when we entered?
 * Did the regime shift while we were in the trade?
 */

// ── Types ─────────────────────────────────────────────────────────────

export const REGIME_SNAPSHOT_VERSION = 'regsnap-v1';

export interface RegimeSnapshot {
  /** Version of the regime snapshot schema. */
  readonly version: string;
  /** Epoch-ms when this snapshot was taken. */
  readonly timestampMs: number;
  /** The regime value (trend/range/volatility classification). */
  readonly regime: string;
  /** Confidence in the regime classification (0-1). */
  readonly confidence: number;
  /** Additional regime dimensions (volatility regime, liquidity regime, etc.). */
  readonly dimensions: Readonly<Record<string, string | number>>;
  /** Source: 'decision', 'exit', 'periodic', 'manual'. */
  readonly capturePoint: 'decision' | 'exit' | 'periodic' | 'manual';
  /** ID of the trade or decision this snapshot is associated with. */
  readonly tradeId: string | null;
}

export interface RegimeSnapshotResult {
  readonly snapshot: RegimeSnapshot;
  /** Whether this regime differs from the previous snapshot. */
  readonly regimeChanged: boolean;
  /** Duration in the current regime (ms) since the previous snapshot. */
  readonly regimeDurationMs: number | null;
}

// ── Snapshot capture ──────────────────────────────────────────────────

/**
 * Capture a regime snapshot at a point in time.
 *
 * Builds a structured record containing the regime value, timestamp,
 * version, and any additional dimensions. The record is suitable for
 * storage in a historical table for later analysis.
 *
 * Deterministic: same inputs → same snapshot, always.
 */
export function captureRegimeSnapshot(params: {
  readonly timestampMs: number;
  readonly regime: string;
  readonly confidence?: number;
  readonly dimensions?: Readonly<Record<string, string | number>>;
  readonly capturePoint: RegimeSnapshot['capturePoint'];
  readonly tradeId?: string;
  readonly previousSnapshot?: RegimeSnapshot;
}): RegimeSnapshotResult {
  const {
    timestampMs,
    regime,
    confidence = 1.0,
    dimensions = {},
    capturePoint,
    tradeId = null,
    previousSnapshot,
  } = params;

  const snapshot: RegimeSnapshot = {
    version: REGIME_SNAPSHOT_VERSION,
    timestampMs,
    regime,
    confidence,
    dimensions,
    capturePoint,
    tradeId,
  };

  const regimeChanged = previousSnapshot ? previousSnapshot.regime !== regime : false;
  const regimeDurationMs = previousSnapshot ? timestampMs - previousSnapshot.timestampMs : null;

  return { snapshot, regimeChanged, regimeDurationMs };
}

// ── Snapshot serialization (for DB storage) ───────────────────────────

/**
 * Serialize a RegimeSnapshot to a plain object suitable for JSON storage.
 * This is the format that goes into the database column.
 */
export function serializeRegimeSnapshot(snapshot: RegimeSnapshot): Record<string, unknown> {
  return {
    version: snapshot.version,
    timestampMs: snapshot.timestampMs,
    regime: snapshot.regime,
    confidence: snapshot.confidence,
    dimensions: { ...snapshot.dimensions },
    capturePoint: snapshot.capturePoint,
    tradeId: snapshot.tradeId,
  };
}

/**
 * Deserialize a stored regime snapshot back to the typed interface.
 * Returns null if the stored data is invalid.
 */
export function deserializeRegimeSnapshot(data: Record<string, unknown>): RegimeSnapshot | null {
  if (
    typeof data.version !== 'string' ||
    typeof data.timestampMs !== 'number' ||
    typeof data.regime !== 'string' ||
    typeof data.capturePoint !== 'string'
  ) {
    return null;
  }
  const cp = data.capturePoint;
  if (cp !== 'decision' && cp !== 'exit' && cp !== 'periodic' && cp !== 'manual') {
    return null;
  }
  return {
    version: data.version as string,
    timestampMs: data.timestampMs as number,
    regime: data.regime as string,
    confidence: typeof data.confidence === 'number' ? data.confidence : 1.0,
    dimensions: (data.dimensions as Record<string, string | number>) ?? {},
    capturePoint: cp,
    tradeId: typeof data.tradeId === 'string' ? data.tradeId : null,
  };
}
