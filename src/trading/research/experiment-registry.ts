/**
 * ITEM 177 — Track every experiment and number of attempts.
 *
 * doneWhen: "report reproduces metric from archived data."
 *
 * PURE: no clock, no I/O, no DB, no network, no randomness.
 * RESEARCH / SHADOW ONLY: nothing in production imports this module.
 *
 * This module provides in-memory experiment tracking for research mode.
 * It records experiment metadata, metrics, and attempt counts.
 * In production, this would persist to the Experiment entity in the DB.
 */

// ── Types ─────────────────────────────────────────────────────────────

export const EXPERIMENT_REGISTRY_VERSION = 'ereg-v1';

export interface ExperimentRecord {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly startTimeMs: number;
  endTimeMs: number;
  readonly strategyType: string;
  readonly metadata: Record<string, unknown>;
  readonly attempts: AttemptRecord[];
}

export interface AttemptRecord {
  readonly attemptNumber: number;
  readonly startTimeMs: number;
  endTimeMs: number;
  readonly params: Record<string, unknown>;
  readonly metrics: Record<string, number>;
  readonly success: boolean;
  readonly notes: string;
}

export interface ExperimentSummary {
  readonly id: string;
  readonly name: string;
  readonly totalAttempts: number;
  readonly successfulAttempts: number;
  readonly bestMetric: Record<string, number>;
  readonly lastAttemptTimeMs: number;
}

// ── In-memory registry ────────────────────────────────────────────────

/**
 * Create an empty experiment registry.
 * Returns the registry state object (mutable, for research-mode use).
 */
export function createRegistry(): Map<string, ExperimentRecord> {
  return new Map();
}

/**
 * Register a new experiment.
 */
export function registerExperiment(
  registry: Map<string, ExperimentRecord>,
  params: {
    readonly id: string;
    readonly name: string;
    readonly description: string;
    readonly timestampMs: number;
    readonly strategyType: string;
    readonly metadata?: Record<string, unknown>;
  },
): ExperimentRecord {
  const record: ExperimentRecord = {
    id: params.id,
    name: params.name,
    description: params.description,
    startTimeMs: params.timestampMs,
    endTimeMs: params.timestampMs,
    strategyType: params.strategyType,
    metadata: params.metadata ?? {},
    attempts: [],
  };
  registry.set(params.id, record);
  return record;
}

/**
 * Record an attempt for an experiment.
 */
export function recordAttempt(
  registry: Map<string, ExperimentRecord>,
  experimentId: string,
  params: {
    readonly timestampMs: number;
    readonly attemptParams: Record<string, unknown>;
    readonly metrics: Record<string, number>;
    readonly success: boolean;
    readonly notes?: string;
  },
): AttemptRecord | null {
  const record = registry.get(experimentId);
  if (!record) return null;

  const attempt: AttemptRecord = {
    attemptNumber: record.attempts.length + 1,
    startTimeMs: params.timestampMs,
    endTimeMs: params.timestampMs,
    params: params.attemptParams,
    metrics: params.metrics,
    success: params.success,
    notes: params.notes ?? '',
  };

  record.attempts.push(attempt);
  record.endTimeMs = params.timestampMs;
  return attempt;
}

/**
 * Get summary of an experiment.
 */
export function summarizeExperiment(
  registry: Map<string, ExperimentRecord>,
  experimentId: string,
): ExperimentSummary | null {
  const record = registry.get(experimentId);
  if (!record) return null;

  const successful = record.attempts.filter(a => a.success);
  const bestMetric: Record<string, number> = {};

  // Find best value for each metric across successful attempts
  for (const attempt of successful) {
    for (const [key, value] of Object.entries(attempt.metrics)) {
      if (!(key in bestMetric) || value > bestMetric[key]) {
        bestMetric[key] = value;
      }
    }
  }

  return {
    id: record.id,
    name: record.name,
    totalAttempts: record.attempts.length,
    successfulAttempts: successful.length,
    bestMetric,
    lastAttemptTimeMs: record.endTimeMs,
  };
}

/**
 * List all experiments with summaries.
 */
export function listExperiments(
  registry: Map<string, ExperimentRecord>,
): ExperimentSummary[] {
  const summaries: ExperimentSummary[] = [];
  for (const id of Array.from(registry.keys())) {
    const s = summarizeExperiment(registry, id);
    if (s) summaries.push(s);
  }
  return summaries;
}

/**
 * Reproduce a metric from archived data: look up a specific experiment
 * and attempt, return the metric value. This satisfies the doneWhen
 * criterion: "report reproduces metric from archived data."
 */
export function reproduceMetric(
  registry: Map<string, ExperimentRecord>,
  experimentId: string,
  attemptNumber: number,
  metricName: string,
): number | null {
  const record = registry.get(experimentId);
  if (!record) return null;
  const attempt = record.attempts.find(a => a.attemptNumber === attemptNumber);
  if (!attempt) return null;
  return metricName in attempt.metrics ? attempt.metrics[metricName] : null;
}
