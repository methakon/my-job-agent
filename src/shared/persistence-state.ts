/**
 * Persistence health state machine (Phase 2 — 2026-09-18 runtime reliability).
 *
 * Tracks DB/persistence health independently from market-data freshness.
 * The critical failure on 2026-09-18 proved that persistence failure must NOT
 * cause market-data feeds to be reported as DOWN — FYERS was LIVE with 146K+
 * canonical ticks while the unified write-behind was stuck, yet the health gate
 * reported "all feeds disconnected".
 *
 * State machine:
 *
 *   HEALTHY ──(N consecutive failures)──► DEGRADED
 *   DEGRADED ──(success)──► HEALTHY
 *   DEGRADED ──(M consecutive failures)──► DOWN
 *   DOWN ──(success)──► HEALTHY
 *
 * Thresholds are configurable via env and documented with defaults.
 */

export type PersistenceState = 'HEALTHY' | 'DEGRADED' | 'DOWN';

export type PersistenceHealthSnapshot = {
  state: PersistenceState;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  totalFailures: number;
  totalSuccesses: number;
  totalDropped: number;
  lastFailureAt: Date | null;
  lastSuccessAt: Date | null;
  /** Human-readable reason for the current state. */
  reason: string;
  asOf: Date;
};

/**
 * Environment-configurable thresholds for the persistence circuit breaker.
 * All values have safe defaults; env overrides are validated (positive ints).
 */
const envInt = (name: string, fallback: number): number => {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : fallback;
};

/** After this many consecutive failures, state transitions to DEGRADED. */
const DEGRADED_AFTER_FAILURES = envInt('PERSISTENCE_DEGRADED_AFTER', 3);

/** After this many consecutive failures beyond DEGRADED, state transitions to DOWN. */
const DOWN_AFTER_FAILURES = envInt('PERSISTENCE_DOWN_AFTER', 10);

/**
 * Pure, testable persistence health state machine.
 *
 * No side effects, no timers, no DB calls — callers feed it success/failure
 * signals and read back the current state.  Recovery is automatic by
 * construction: a single success resets consecutive failures and transitions
 * back toward HEALTHY.
 */
export class PersistenceHealthMachine {
  private state: PersistenceState = 'HEALTHY';
  private consecutiveFailures = 0;
  private consecutiveSuccesses = 0;
  private totalFailures = 0;
  private totalSuccesses = 0;
  private totalDropped = 0;
  private lastFailureAt: Date | null = null;
  private lastSuccessAt: Date | null = null;
  private reason = 'initial state';

  /** Record a successful persistence operation. */
  recordSuccess(count = 1): void {
    this.consecutiveFailures = 0;
    this.consecutiveSuccesses += count;
    this.totalSuccesses += count;
    this.lastSuccessAt = new Date();
    if (this.state !== 'HEALTHY') {
      this.state = 'HEALTHY';
      this.reason = `recovered after ${this.consecutiveFailures} failure(s)`;
    }
  }

  /** Record a failed persistence operation. */
  recordFailure(reason = 'unknown', dropped = 0): void {
    this.consecutiveFailures += 1;
    this.consecutiveSuccesses = 0;
    this.totalFailures += 1;
    this.totalDropped += dropped;
    this.lastFailureAt = new Date();

    if (this.consecutiveFailures >= DEGRADED_AFTER_FAILURES + DOWN_AFTER_FAILURES) {
      this.state = 'DOWN';
      this.reason = `${this.consecutiveFailures} consecutive failures: ${reason}`;
    } else if (this.consecutiveFailures >= DEGRADED_AFTER_FAILURES) {
      this.state = 'DEGRADED';
      this.reason = `${this.consecutiveFailures} consecutive failures: ${reason}`;
    } else {
      this.reason = `${this.consecutiveFailures} consecutive failure(s) — still HEALTHY threshold`;
    }
  }

  /** Record dropped rows (buffer overflow, not a failure per se). */
  recordDropped(count: number): void {
    this.totalDropped += count;
  }

  /** Current state snapshot (observability + health gate input). */
  snapshot(): PersistenceHealthSnapshot {
    return {
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      consecutiveSuccesses: this.consecutiveSuccesses,
      totalFailures: this.totalFailures,
      totalSuccesses: this.totalSuccesses,
      totalDropped: this.totalDropped,
      lastFailureAt: this.lastFailureAt,
      lastSuccessAt: this.lastSuccessAt,
      reason: this.reason,
      asOf: new Date(),
    };
  }

  /** Current state shorthand (for health gate conditions). */
  currentState(): PersistenceState {
    return this.state;
  }

  /** Reset to initial state (for tests). */
  reset(): void {
    this.state = 'HEALTHY';
    this.consecutiveFailures = 0;
    this.consecutiveSuccesses = 0;
    this.totalFailures = 0;
    this.totalSuccesses = 0;
    this.totalDropped = 0;
    this.lastFailureAt = null;
    this.lastSuccessAt = null;
    this.reason = 'initial state';
  }
}
